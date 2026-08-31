import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  createClaudeCodeLocalSession: vi.fn(),
  fetchClaudeCodeStatusDirect: vi.fn(),
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
import {
  createClaudeCodeSession,
  createClaudeCodeLocalSession,
  fetchClaudeCodeStatusDirect,
} from "../../lib/public/js/lib/api.js";
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

// ---------------------------------------------------------------- local ----

const kLocalSessionUrl = "https://claude.ai/code/rescue_01XYZ";

const localReadyStatus = (overrides = {}) => ({
  ok: true,
  availability: { available: true },
  local: {
    enabled: true,
    state: "ready",
    permissionMode: "acceptEdits",
    ...overrides,
  },
});

const localError = (code, message = code) =>
  Object.assign(new Error(message), { code });

describe("useClaudeCodeLauncher local-first branch", () => {
  it("navigates the placeholder straight to a 200-running local session", async () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    createClaudeCodeLocalSession.mockResolvedValue({
      ok: true,
      status: "running",
      sessionId: "rescue_01XYZ",
      sessionUrl: kLocalSessionUrl,
    });
    renderHook().openClaudeCode(plainClick());
    await flush();

    const win = global.window.open.mock.results[0].value;
    expect(win.location.href).toBe(kLocalSessionUrl);
    expect(createClaudeCodeSession).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("Claude Code session started", "success");
  });

  it("sends confirmed:true only when the stored consent mode matches the configured one", async () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    readUiSettings.mockReturnValue({ claudeCodeLocalConfirmedMode: "acceptEdits" });
    createClaudeCodeLocalSession.mockResolvedValue({
      ok: true,
      status: "running",
      sessionUrl: kLocalSessionUrl,
    });
    renderHook().openClaudeCode(plainClick());
    await flush();
    expect(createClaudeCodeLocalSession).toHaveBeenCalledWith({ confirmed: true });
  });

  it("a permission-mode change (bypassPermissions) invalidates consent and forces the re-confirm modal", async () => {
    // CRITICAL (codex 13): stored consent was for acceptEdits, config moved
    // to bypassPermissions — the click must NOT assert consent, and the modal
    // must carry the mode so the copy can name it.
    useCachedFetch.mockReturnValue({
      data: localReadyStatus({ permissionMode: "bypassPermissions" }),
    });
    readUiSettings.mockReturnValue({ claudeCodeLocalConfirmedMode: "acceptEdits" });
    createClaudeCodeLocalSession
      .mockRejectedValueOnce(localError("confirm_required"))
      .mockResolvedValueOnce({ ok: true, status: "running", sessionUrl: kLocalSessionUrl });
    renderHook().openClaudeCode(plainClick());
    await flush();

    expect(createClaudeCodeLocalSession).toHaveBeenCalledWith({ confirmed: false });
    const rerendered = renderHook();
    expect(rerendered.confirmOpen).toBe(true);
    expect(rerendered.confirmMode).toBe("local");
    expect(rerendered.confirmPermissionMode).toBe("bypassPermissions");

    rerendered.confirmStart();
    await flush();
    // Consent stored FOR THE MODE, and the re-fire asserts it.
    const storedSettings = updateUiSettings.mock.calls[0][0]({});
    expect(storedSettings.claudeCodeLocalConfirmedMode).toBe("bypassPermissions");
    expect(createClaudeCodeLocalSession).toHaveBeenLastCalledWith({ confirmed: true });
    const win = global.window.open.mock.results[0].value;
    expect(win.location.href).toBe(kLocalSessionUrl);
  });

  it("skips the local POST entirely when the cached status has no local block", async () => {
    // CRITICAL regression: unknown/absent status.local → routine path
    // exactly as today, zero local calls.
    useCachedFetch.mockReturnValue({ data: { availability: { available: true } } });
    createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    await flush();
    expect(createClaudeCodeLocalSession).not.toHaveBeenCalled();
    expect(createClaudeCodeSession).toHaveBeenCalledWith({ confirmed: false });
    const win = global.window.open.mock.results[0].value;
    expect(win.location.href).toBe(kSessionUrl);
  });

  it("skips the local POST when the cached local state is disabled or not_installed", async () => {
    for (const state of ["disabled", "not_installed"]) {
      harness.reset();
      vi.clearAllMocks();
      global.window = {
        open: vi.fn(() => makeWin()),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      readUiSettings.mockReturnValue({});
      useCachedFetch.mockReturnValue({ data: localReadyStatus({ state }) });
      createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
      renderHook().openClaudeCode(plainClick());
      await flush();
      expect(createClaudeCodeLocalSession).not.toHaveBeenCalled();
      expect(createClaudeCodeSession).toHaveBeenCalledWith({ confirmed: false });
    }
  });

  it("modifier clicks stay native even with a local session available (no fetch at all)", () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus({ state: "running" }) });
    const launcher = renderHook();
    const event = { ...plainClick(), ctrlKey: true };
    launcher.openClaudeCode(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(global.window.open).not.toHaveBeenCalled();
    expect(createClaudeCodeLocalSession).not.toHaveBeenCalled();
    expect(createClaudeCodeSession).not.toHaveBeenCalled();
    expect(fetchClaudeCodeStatusDirect).not.toHaveBeenCalled();
  });
});

describe("useClaudeCodeLauncher local 202 poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls status after a 202 and navigates once local.state is running", async () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    createClaudeCodeLocalSession.mockResolvedValue({ ok: true, status: "starting" });
    fetchClaudeCodeStatusDirect
      .mockResolvedValueOnce(localReadyStatus({ state: "starting" }))
      .mockResolvedValueOnce(
        localReadyStatus({ state: "running", sessionUrl: kLocalSessionUrl }),
      );
    renderHook().openClaudeCode(plainClick());
    await vi.advanceTimersByTimeAsync(0);

    const win = global.window.open.mock.results[0].value;
    expect(win.document.write).toHaveBeenCalledWith(
      expect.stringContaining("Starting rescue Claude Code on this box"),
    );
    expect(win.location.href).toBe("");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(2);
    expect(win.location.href).toBe(kLocalSessionUrl);
    expect(showToast).toHaveBeenCalledWith("Claude Code session started", "success");
    expect(createClaudeCodeSession).not.toHaveBeenCalled();
  });

  it("switches the interstitial to the URL-wait text after ~15s", async () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    createClaudeCodeLocalSession.mockResolvedValue({ ok: true, status: "starting" });
    fetchClaudeCodeStatusDirect.mockResolvedValue(localReadyStatus({ state: "starting" }));
    renderHook().openClaudeCode(plainClick());
    await vi.advanceTimersByTimeAsync(0);
    const win = global.window.open.mock.results[0].value;

    await vi.advanceTimersByTimeAsync(16_000);
    expect(win.document.write).toHaveBeenCalledWith(
      expect.stringContaining("Waiting for the Remote Control URL"),
    );
  });

  it("closes the popup and toasts on a poll-reported error — NO routine fallback", async () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    createClaudeCodeLocalSession.mockResolvedValue({ ok: true, status: "starting" });
    fetchClaudeCodeStatusDirect.mockResolvedValue(
      localReadyStatus({
        state: "error",
        error: { code: "url_extract_timeout", message: "URL never appeared" },
      }),
    );
    renderHook().openClaudeCode(plainClick());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);

    const win = global.window.open.mock.results[0].value;
    expect(win.close).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("URL never appeared", "error", {
      durationMs: 10_000,
    });
    expect(createClaudeCodeSession).not.toHaveBeenCalled();
  });

  it("gives up at the 90s cap with a toast — NO routine fallback", async () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    createClaudeCodeLocalSession.mockResolvedValue({ ok: true, status: "starting" });
    fetchClaudeCodeStatusDirect.mockResolvedValue(localReadyStatus({ state: "starting" }));
    renderHook().openClaudeCode(plainClick());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(91_000);
    const win = global.window.open.mock.results[0].value;
    expect(win.close).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("Timed out waiting for the rescue session URL"),
      "error",
      { durationMs: 10_000 },
    );
    expect(createClaudeCodeSession).not.toHaveBeenCalled();
  });
});

describe("useClaudeCodeLauncher local → routine fallback matrix", () => {
  // CRITICAL regression class: each fallback code re-fires today's routine
  // byte-for-byte on the SAME window (routine interstitial text, routine
  // consent flag, routine settle semantics).
  for (const code of ["disabled", "not_installed", "needs_login"]) {
    it(`falls back to the routine fire on ${code}`, async () => {
      useCachedFetch.mockReturnValue({ data: localReadyStatus() });
      createClaudeCodeLocalSession.mockRejectedValue(localError(code));
      createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
      renderHook().openClaudeCode(plainClick());
      await flush();

      expect(global.window.open).toHaveBeenCalledTimes(1);
      const win = global.window.open.mock.results[0].value;
      expect(win.document.write).toHaveBeenCalledWith(
        expect.stringContaining("Starting Claude Code session"),
      );
      expect(createClaudeCodeSession).toHaveBeenCalledWith({ confirmed: false });
      expect(win.location.href).toBe(kSessionUrl);
      expect(win.close).not.toHaveBeenCalled();
    });
  }

  it("the fallback carries the ROUTINE consent flag, not the local one", async () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    readUiSettings.mockReturnValue({ claudeCodeFireConfirmed: true });
    createClaudeCodeLocalSession.mockRejectedValue(localError("disabled"));
    createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    await flush();
    expect(createClaudeCodeSession).toHaveBeenCalledWith({ confirmed: true });
  });

  it("needs_login shows the one-time setup toast, then never again", async () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus({ state: "needs_login" }) });
    createClaudeCodeLocalSession.mockRejectedValue(localError("needs_login"));
    createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
    renderHook().openClaudeCode(plainClick());
    await flush();
    expect(showToast).toHaveBeenCalledWith(
      "Set up local rescue sessions from the Watchdog page",
      "info",
      { durationMs: 10_000 },
    );
    const storedSettings = updateUiSettings.mock.calls[0][0]({});
    expect(storedSettings.claudeCodeLocalSetupToastShown).toBe(true);

    // Second click with the flag persisted: no repeat toast.
    vi.clearAllMocks();
    readUiSettings.mockReturnValue({ claudeCodeLocalSetupToastShown: true });
    useCachedFetch.mockReturnValue({ data: localReadyStatus({ state: "needs_login" }) });
    createClaudeCodeLocalSession.mockRejectedValue(localError("needs_login"));
    createClaudeCodeSession.mockResolvedValue({ ok: true, sessionUrl: kSessionUrl });
    global.window.open = vi.fn(() => makeWin());
    renderHook().openClaudeCode(plainClick());
    await flush();
    expect(showToast).not.toHaveBeenCalledWith(
      "Set up local rescue sessions from the Watchdog page",
      "info",
      { durationMs: 10_000 },
    );
  });

  it("local attempted + routine unconfigured still lands the popup on plain claude.ai", async () => {
    // CRITICAL regression: the not_configured graceful fallback survives the
    // local-first branch (local refusal → routine → not_configured → link).
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    createClaudeCodeLocalSession.mockRejectedValue(localError("disabled"));
    createClaudeCodeSession.mockRejectedValue(
      Object.assign(new Error("not configured"), { code: "not_configured" }),
    );
    renderHook().openClaudeCode(plainClick());
    await flush();
    const win = global.window.open.mock.results[0].value;
    expect(win.location.href).toBe("https://claude.ai/code");
    expect(win.close).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("closes the popup and toasts on a 502-class local failure — NO routine fallback", async () => {
    // CRITICAL (consent rule): an unexpected local failure must never
    // silently become a billable cloud routine run.
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    createClaudeCodeLocalSession.mockRejectedValue(
      localError("spawn_failed", "tmux could not start the session"),
    );
    renderHook().openClaudeCode(plainClick());
    await flush();
    const win = global.window.open.mock.results[0].value;
    expect(win.close).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "tmux could not start the session",
      "error",
      { durationMs: 10_000 },
    );
    expect(createClaudeCodeSession).not.toHaveBeenCalled();
  });
});

describe("useClaudeCodeLauncher local tooltip + live-dot", () => {
  it("running local session drives tooltip and live-dot", () => {
    useCachedFetch.mockReturnValue({
      data: {
        availability: { available: false },
        local: { enabled: true, state: "running", permissionMode: "acceptEdits" },
      },
    });
    const launcher = renderHook();
    expect(launcher.tooltip).toBe("Opens this box's rescue Claude Code session");
    expect(launcher.liveDot).toBe(true);
    expect(launcher.liveDotTitle).toMatch(/rescue session running/i);
  });

  it("ready local session gets the local-ready tooltip; dot follows the routine clause", () => {
    useCachedFetch.mockReturnValue({ data: localReadyStatus() });
    const launcher = renderHook();
    expect(launcher.tooltip).toMatch(/rescue claude code session on this box/i);
    // availability.available is true in the fixture → routine clause lights it.
    expect(launcher.liveDot).toBe(true);
  });

  it("non-running local states never light the dot on their own, and never suppress the routine clause", () => {
    useCachedFetch.mockReturnValue({
      data: {
        availability: { available: false },
        local: { enabled: true, state: "needs_login", permissionMode: "acceptEdits" },
      },
    });
    expect(renderHook().liveDot).toBe(false);

    harness.reset();
    useCachedFetch.mockReturnValue({
      data: {
        availability: { available: true },
        local: { enabled: true, state: "error", permissionMode: "acceptEdits" },
      },
    });
    expect(renderHook().liveDot).toBe(true);
  });
});
