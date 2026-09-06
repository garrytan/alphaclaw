import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness with dep tracking (watchdog-terminal-init-error.test.js pattern).
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, pendingEffects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.pendingEffects = [];
  };
  const depsChanged = (previousDeps, nextDeps) =>
    !previousDeps ||
    !nextDeps ||
    previousDeps.length !== nextDeps.length ||
    nextDeps.some((dep, index) => !Object.is(dep, previousDeps[index]));
  harness.flushEffects = () => {
    const pending = harness.pendingEffects.splice(0);
    for (const { slot, effect } of pending) {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = effect() || null;
    }
    return pending.length;
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = {
        value: typeof initialValue === "function" ? initialValue() : initialValue,
      };
    }
    const slot = harness.slots[index];
    const setState = (next) => {
      slot.value = typeof next === "function" ? next(slot.value) : next;
    };
    return [slot.value, setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { ref: { current: initialValue } };
    }
    return harness.slots[index].ref;
  };
  const useMemo = (factory, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { computed: false };
    const slot = harness.slots[index];
    if (!slot.computed || depsChanged(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps;
      slot.computed = true;
    }
    return slot.value;
  };
  const useCallback = (fn) => fn;
  const useEffect = (effect, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { ran: false, cleanup: null };
    }
    const slot = harness.slots[index];
    const changed = !slot.ran || depsChanged(slot.deps, deps);
    slot.deps = deps;
    slot.ran = true;
    if (changed) harness.pendingEffects.push({ slot, effect });
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/components/watchdog-tab/helpers.js", () => ({
  ensureXtermStylesheet: vi.fn(),
  fitTerminalWhenVisible: vi.fn(),
  kWatchdogTerminalWsPath: "/api/watchdog/terminal",
  loadXtermModules: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, closeWatchdogTerminalSession: vi.fn(async () => ({ ok: true })) };
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import { loadXtermModules } from "../../lib/public/js/components/watchdog-tab/helpers.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useWatchdogTerminal } from "../../lib/public/js/components/watchdog-tab/terminal/use-terminal.js";

const harness = preactHooks.__harness;

class FakeTerminal {
  constructor() {
    this.cols = 80;
    this.rows = 24;
    this.write = vi.fn();
    this.clear = vi.fn();
    this.dispose = vi.fn();
    this.focus = vi.fn();
  }
  loadAddon() {}
  open() {}
  attachCustomKeyEventHandler() {}
  onData() {}
}
class FakeFitAddon {}

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.send = vi.fn();
    this.close = vi.fn(() => {
      this.readyState = 3; // CLOSED
    });
    FakeWebSocket.instances.push(this);
  }
}

const flushAsync = async () => {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  }
};

const refs = { panelRef: { current: {} }, hostRef: { current: {} } };
const renderHook = (active) => {
  harness.beginRender();
  return useWatchdogTerminal({ active, ...refs });
};

const message = (payload) => ({ data: JSON.stringify(payload) });

describe("frontend/watchdog terminal socket-identity handlers (fix wave F156/F201)", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    loadXtermModules.mockResolvedValue({ Terminal: FakeTerminal, FitAddon: FakeFitAddon });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3000" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      requestAnimationFrame: vi.fn(),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const connectFirstSocket = async () => {
    renderHook(true);
    harness.flushEffects();
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("ws://localhost:3000/api/watchdog/terminal?cols=80&rows=24");
    socket.readyState = 1; // OPEN
    socket.onopen();
    const hook = renderHook(true);
    expect(hook.terminalConnected).toBe(true);
    expect(hook.connectingTerminal).toBe(false);
    expect(hook.terminalStatusText).toBe("Connected");
    return socket;
  };

  it("after a Logs→Terminal round-trip the retained socket is REBOUND, so a raw close still reaches the UI", async () => {
    const socket = await connectFirstSocket();

    // Logs: the setup effect is cancelled; the open socket outlives it.
    renderHook(false);
    harness.flushEffects();
    expect(socket.close).not.toHaveBeenCalled();

    // Back to Terminal: reuse, no second socket, connected state restored.
    renderHook(true);
    harness.flushEffects();
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    let hook = renderHook(true);
    expect(hook.terminalConnected).toBe(true);
    expect(hook.connectingTerminal).toBe(false);

    // The regression: handlers bound to the cancelled closure swallowed this,
    // leaving "Connected" on screen with keystrokes silently dropped.
    socket.onclose();
    hook = renderHook(true);
    expect(hook.terminalConnected).toBe(false);
    expect(hook.terminalStatusText).toBe("Disconnected");

    // New session (the button the Disconnected state now shows) dials a
    // fresh socket instead of reusing the dead one.
    hook.restartSession();
    renderHook(true);
    harness.flushEffects();
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(renderHook(true).connectingTerminal).toBe(true);
  });

  it("a superseded socket's late open/message/error/close never touches the live terminal's state", async () => {
    const stale = await connectFirstSocket();
    const terminal = harness.slots.map((slot) => slot?.ref?.current).find((value) => value instanceof FakeTerminal);
    expect(terminal).toBeTruthy();

    let hook = renderHook(true);
    hook.restartSession();
    expect(stale.close).toHaveBeenCalledTimes(1);
    renderHook(true);
    harness.flushEffects();
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const live = FakeWebSocket.instances[1];
    hook = renderHook(true);
    expect(hook.connectingTerminal).toBe(true);
    expect(hook.terminalStatusText).toBe("Connecting...");

    // Late events from the socket we abandoned.
    stale.onopen();
    stale.onmessage(message({ type: "output", data: "STALE" }));
    stale.onmessage(message({ type: "exit" }));
    stale.onerror();
    stale.onclose();
    hook = renderHook(true);
    expect(hook.connectingTerminal).toBe(true);
    expect(hook.terminalConnected).toBe(false);
    expect(hook.terminalEnded).toBe(false);
    expect(hook.terminalStatusText).toBe("Connecting...");
    expect(terminal.write).not.toHaveBeenCalledWith("STALE");
    expect(showToast).not.toHaveBeenCalledWith("Watchdog terminal connection failed", "error");

    // The live socket drives everything.
    live.readyState = 1;
    live.onopen();
    live.onmessage(message({ type: "output", data: "LIVE" }));
    hook = renderHook(true);
    expect(hook.terminalConnected).toBe(true);
    expect(hook.terminalStatusText).toBe("Connected");
    expect(terminal.write).toHaveBeenCalledWith("LIVE");
  });
});
