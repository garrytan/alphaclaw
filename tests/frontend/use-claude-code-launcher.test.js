import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as agents-tab-use-agents): hook state
// lives in per-call-index slots so the hook can be invoked directly without a
// DOM renderer. Effects are collected, not run.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.effects = [];
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] =
        typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      harness.slots[index] =
        typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { current: initialValue };
    }
    return harness.slots[index];
  };
  const useMemo = (factory) => factory();
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: vi.fn(() => ({ data: null })),
}));

vi.mock("../../lib/public/js/lib/api.js", () => ({
  createClaudeCodeSession: vi.fn(),
  fetchClaudeCodeStatus: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/ui-settings.js", () => ({
  readUiSettings: vi.fn(() => ({})),
  updateUiSettings: vi.fn((updater) => updater({})),
}));

import * as preactHooks from "preact/hooks";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { createClaudeCodeSession } from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import {
  readUiSettings,
  updateUiSettings,
} from "../../lib/public/js/lib/ui-settings.js";
import { useClaudeCodeLauncher } from "../../lib/public/js/hooks/use-claude-code-launcher.js";

const harness = preactHooks.__harness;

const kSessionUrl = "https://claude.ai/code/session_01ABC";

const makeWin = () => ({
  closed: false,
  close: vi.fn(),
  location: { href: "" },
  document: {
    title: "",
    body: { innerHTML: "" },
    write: vi.fn(),
    close: vi.fn(),
  },
});

const plainClick = () => ({
  preventDefault: vi.fn(),
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  button: 0,
});

const renderHook = (props = {}) => {
  harness.beginRender();
  return useClaudeCodeLauncher({ enabled: true, ...props });
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  useCachedFetch.mockReturnValue({ data: null });
  readUiSettings.mockReturnValue({});
  global.window = {
    open: vi.fn(() => makeWin()),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
});

describe("useClaudeCodeLauncher status → tooltip", () => {
  it("is three-way: configured, unconfigured, and unknown", () => {
    useCachedFetch.mockReturnValue({ data: { availability: { available: true } } });
    expect(renderHook().configured).toBe(true);
    expect(renderHook().tooltip).toMatch(/fires your claude code routine/i);

    harness.reset();
    useCachedFetch.mockReturnValue({
      data: { availability: { available: false, reason: "not_configured" } },
    });
    expect(renderHook().configured).toBe(false);
    expect(renderHook().tooltip).toContain("CLAUDE_CODE_ROUTINE_URL");

    harness.reset();
    useCachedFetch.mockReturnValue({ data: null });
    expect(renderHook().configured).toBe(null);
    // A transient status failure must not assert setup guidance as fact.
    expect(renderHook().tooltip).toBe("Opens claude.ai/code.");
  });
});

describe("useClaudeCodeLauncher click flow", () => {
  it("lets modifier clicks fall through to the native anchor", () => {
    const launcher = renderHook();
    const event = { ...plainClick(), metaKey: true };
    launcher.openClaudeCode(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(global.window.open).not.toHaveBeenCalled();
    expect(createClaudeCodeSession).not.toHaveBeenCalled();
  });

  it("opens the interstitial placeholder synchronously, before the POST resolves", async () => {
    let resolveFire;
    createClaudeCodeSession.mockReturnValue(
      new Promise((resolve) => {
        resolveFire = resolve;
      }),
    );
    const onBeforeOpen = vi.fn();
    const launcher = renderHook({ onBeforeOpen });
    launcher.openClaudeCode(plainClick());

    expect(global.window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(onBeforeOpen).toHaveBeenCalled();
    const win = global.window.open.mock.results[0].value;
    expect(win.document.write).toHaveBeenCalledWith(
      expect.stringContaining("Starting Claude Code session"),
    );
    expect(createClaudeCodeSession).toHaveBeenCalledWith({ confirmed: false });

    resolveFire({ ok: true, sessionUrl: kSessionUrl });
    await flush();
    expect(win.location.href).toBe(kSessionUrl);
  });

  it("sends confirmed:true once the ui-settings flag is set", async () => {
    readUiSettings.mockReturnValue({ claudeCodeFireConfirmed: true });
    createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    await flush();
    expect(createClaudeCodeSession).toHaveBeenCalledWith({ confirmed: true });
  });

  it("confirms success with a toast, and releases the lock", async () => {
    createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    await flush();
    expect(showToast).toHaveBeenCalledWith("Claude Code session started", "success");

    renderHook().openClaudeCode(plainClick());
    expect(global.window.open).toHaveBeenCalledTimes(2);
  });

  it("shows a 10s warning toast when the fire succeeds but the placeholder is gone", async () => {
    global.window.open = vi.fn(() => null);
    createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    await flush();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("open claude.ai/code to find it"),
      "warning",
      { durationMs: 10_000 },
    );
  });

  it("falls back to claude.ai/code silently when not configured", async () => {
    const error = Object.assign(new Error("not configured"), {
      code: "not_configured",
    });
    createClaudeCodeSession.mockRejectedValue(error);
    renderHook().openClaudeCode(plainClick());
    await flush();
    const win = global.window.open.mock.results[0].value;
    expect(win.location.href).toBe("https://claude.ai/code");
    expect(win.close).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("closes the placeholder and toasts for real errors (one tab carries cause + recovery)", async () => {
    const error = Object.assign(new Error("The routine refused to fire (it may be paused)."), {
      code: "upstream_400",
    });
    createClaudeCodeSession.mockRejectedValue(error);
    renderHook().openClaudeCode(plainClick());
    await flush();
    const win = global.window.open.mock.results[0].value;
    expect(win.close).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(error.message, "error", {
      durationMs: 10_000,
    });
  });

  it("debounces re-clicks while a launch is in flight", async () => {
    createClaudeCodeSession.mockReturnValue(new Promise(() => {}));
    const launcher = renderHook();
    launcher.openClaudeCode(plainClick());
    launcher.openClaudeCode(plainClick());
    expect(global.window.open).toHaveBeenCalledTimes(1);
    expect(createClaudeCodeSession).toHaveBeenCalledTimes(1);
  });
});

describe("useClaudeCodeLauncher confirm handshake", () => {
  const confirmRequired = () =>
    Object.assign(new Error("Confirmation required before the first fire."), {
      code: "confirm_required",
    });

  it("opens the modal, keeps the placeholder waiting, and keeps the lock held", async () => {
    createClaudeCodeSession.mockRejectedValueOnce(confirmRequired());
    renderHook().openClaudeCode(plainClick());
    await flush();

    const rerendered = renderHook();
    expect(rerendered.confirmOpen).toBe(true);
    const win = global.window.open.mock.results[0].value;
    expect(win.close).not.toHaveBeenCalled();
    expect(win.document.write).toHaveBeenCalledWith(
      expect.stringContaining("Waiting for your confirmation"),
    );

    // Re-click while the modal is pending: NO second placeholder, no POST.
    rerendered.openClaudeCode(plainClick());
    expect(global.window.open).toHaveBeenCalledTimes(1);
    expect(createClaudeCodeSession).toHaveBeenCalledTimes(1);
  });

  it("Start persists the flag, re-fires confirmed on the SAME placeholder", async () => {
    createClaudeCodeSession
      .mockRejectedValueOnce(confirmRequired())
      .mockResolvedValueOnce({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    await flush();

    renderHook().confirmStart();
    await flush();

    expect(updateUiSettings).toHaveBeenCalled();
    const nextSettings = updateUiSettings.mock.calls[0][0]({});
    expect(nextSettings.claudeCodeFireConfirmed).toBe(true);
    expect(createClaudeCodeSession).toHaveBeenLastCalledWith({ confirmed: true });
    expect(global.window.open).toHaveBeenCalledTimes(1);
    const win = global.window.open.mock.results[0].value;
    expect(win.location.href).toBe(kSessionUrl);
  });

  it("Cancel closes the placeholder and releases the lock", async () => {
    createClaudeCodeSession.mockRejectedValueOnce(confirmRequired());
    renderHook().openClaudeCode(plainClick());
    await flush();

    renderHook().confirmCancel();
    const win = global.window.open.mock.results[0].value;
    expect(win.close).toHaveBeenCalled();
    expect(renderHook().confirmOpen).toBe(false);

    // Lock released: a fresh click opens a fresh placeholder.
    createClaudeCodeSession.mockResolvedValueOnce({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    expect(global.window.open).toHaveBeenCalledTimes(2);
  });
});

describe("useClaudeCodeLauncher confirm one-shot + unmount cleanup", () => {
  const confirmRequired = () =>
    Object.assign(new Error("Confirmation required before the first fire."), {
      code: "confirm_required",
    });

  it("ignores a modal double-click on Start (one probe + one confirmed fire, never a third)", async () => {
    createClaudeCodeSession
      .mockRejectedValueOnce(confirmRequired())
      .mockReturnValue(new Promise(() => {}));
    renderHook().openClaudeCode(plainClick());
    await flush();

    const rerendered = renderHook();
    rerendered.confirmStart();
    rerendered.confirmStart();
    await flush();
    expect(createClaudeCodeSession).toHaveBeenCalledTimes(2);
    // The second click must not run the error path that would close the
    // placeholder the first (billed) fire is about to navigate.
    const win = global.window.open.mock.results[0].value;
    expect(win.close).not.toHaveBeenCalled();
  });

  it("unmount with a pending modal closes the orphan placeholder and releases the lock", async () => {
    createClaudeCodeSession.mockRejectedValueOnce(confirmRequired());
    renderHook().openClaudeCode(plainClick());
    await flush();
    renderHook(); // re-render collects the mount effect with current refs

    // Run the collected effects and their teardowns (the harness collects
    // without running; the unmount cleanup is the effect's return value).
    for (const effect of harness.effects) {
      const cleanup = effect();
      if (typeof cleanup === "function") cleanup();
    }
    const win = global.window.open.mock.results[0].value;
    expect(win.close).toHaveBeenCalled();

    // Lock released: a fresh click opens a fresh placeholder.
    createClaudeCodeSession.mockResolvedValueOnce({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    expect(global.window.open).toHaveBeenCalledTimes(2);
  });
});
