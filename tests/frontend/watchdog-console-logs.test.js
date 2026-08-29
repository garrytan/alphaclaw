import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness (use-saved-setting.test.js pattern): state in per-call-index
// slots; effects collected, not run — tests invoke them to model mount and
// capture cleanups to stop the log poll timer.
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

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchWatchdogLogs: vi.fn(),
  fetchWatchdogLogsDelta: vi.fn(),
  closeWatchdogTerminalSession: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useWatchdogConsole } from "../../lib/public/js/components/watchdog-tab/console/use-console.js";
import { WatchdogConsoleCard } from "../../lib/public/js/components/watchdog-tab/console/index.js";
import { localizeLogTimestamps } from "../../lib/public/js/components/watchdog-tab/helpers.js";
import { getBrowserTimeZone } from "../../lib/public/js/lib/format.js";
import { useWatchdogTerminal } from "../../lib/public/js/components/watchdog-tab/terminal/use-terminal.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";

const harness = preactHooks.__harness;

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  if (node.rendered) collectNodes(node.rendered, out);
  return out;
};

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (node.props) collectText(node.props.children, out);
    if (node.rendered) collectText(node.rendered, out);
  }
  return out;
};

const treeText = (tree) => collectText(tree).join(" ");

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("frontend/watchdog console logs poll", () => {
  const renderHook = () => {
    harness.beginRender();
    return useWatchdogConsole();
  };

  // Mount = run every collected effect (the terminal setup effect no-ops
  // while the logs tab is active); returns cleanups to stop the poll timer.
  const mount = () => {
    const cleanups = harness.effects.map((effect) => effect());
    return () => {
      for (const cleanup of cleanups) {
        if (typeof cleanup === "function") cleanup();
      }
    };
  };

  it("surfaces a first-load failure as logsError instead of an empty pane", async () => {
    vi.useFakeTimers();
    const error = new Error("logs endpoint down");
    api.fetchWatchdogLogs.mockRejectedValue(error); // initial tail fails
    renderHook();
    const unmount = mount();
    await vi.advanceTimersByTimeAsync(0);

    let state = renderHook();
    expect(state.loadingLogs).toBe(false);
    expect(state.logs).toBe("");
    expect(state.logsError).toBe(error);

    // The 3s delta poll keeps retrying; the next success clears the error.
    api.fetchWatchdogLogsDelta.mockResolvedValue({
      reset: true,
      data: "recovered output",
      gen: 1,
      offset: 16,
    });
    await vi.advanceTimersByTimeAsync(3000);
    state = renderHook();
    expect(state.logsError).toBe(null);
    expect(state.logs).toBe("recovered output");
    unmount();
  });

  it("keeps the last loaded logs when a later delta poll fails (stale, flagged)", async () => {
    vi.useFakeTimers();
    api.fetchWatchdogLogs.mockResolvedValue("line one"); // initial tail
    renderHook();
    const unmount = mount();
    await vi.advanceTimersByTimeAsync(0);

    let state = renderHook();
    expect(state.logs).toBe("line one");
    expect(state.logsError).toBe(null);

    api.fetchWatchdogLogsDelta.mockRejectedValue(new Error("flaky"));
    await vi.advanceTimersByTimeAsync(3000);
    state = renderHook();
    expect(state.logs).toBe("line one"); // last-known-good stays on screen
    expect(state.logsError).toBeInstanceOf(Error);
    unmount();
  });
});

describe("frontend/watchdog console card logs pane", () => {
  const renderCard = (props = {}) => expandTree(WatchdogConsoleCard(props));

  it("never renders a failed load as a confident 'No logs yet.'", () => {
    const tree = renderCard({
      loadingLogs: false,
      logs: "",
      logsError: new Error("boom"),
    });
    const text = treeText(tree);
    expect(text).not.toContain("No logs yet.");
    expect(text).toContain("Couldn't load logs — retrying automatically.");
    expect(findAllByType(tree, InlineErrorChip).length).toBe(1);
  });

  it("flags stale logs when a refresh failed but old output is shown", () => {
    const tree = renderCard({
      loadingLogs: false,
      logs: "old output",
      logsError: new Error("flaky"),
    });
    const text = treeText(tree);
    expect(text).toContain("old output");
    expect(text).toContain(
      "Couldn't refresh logs — showing the last loaded output; retrying automatically.",
    );
  });

  it("keeps the genuine empty and loading states without a chip", () => {
    const empty = renderCard({ loadingLogs: false, logs: "", logsError: null });
    expect(treeText(empty)).toContain("No logs yet.");
    expect(findAllByType(empty, InlineErrorChip).length).toBe(0);

    const loading = renderCard({ loadingLogs: true, logs: "", logsError: null });
    expect(treeText(loading)).toContain("Loading logs...");
    expect(findAllByType(loading, InlineErrorChip).length).toBe(0);
  });

  it("localizes leading log-line stamps and labels the copy action as UTC diagnostics", () => {
    const logs = "2026-08-28T10:00:02.114Z gateway started\nplain line\n";
    const tree = renderCard({ loadingLogs: false, logs, logsError: null });
    const text = treeText(tree);
    // The pane shows the localized rewrite, never the raw leading ISO stamp.
    expect(text).toContain(localizeLogTimestamps(logs));
    expect(text).not.toContain("2026-08-28T10:00:02.114Z");
    // Copied diagnostics stay UTC ISO — the label discloses the divergence.
    expect(text).toContain("Copy diagnostics (UTC)");
    expect(text).not.toContain("Copy all");
  });

  it("always shows the Logs-tab timezone hint, including loading and empty states", () => {
    // Whitespace-normalize: htm splits "text ${expr}" into separate children.
    const normalizedText = (tree) => treeText(tree).replace(/\s+/g, " ");
    const hint = `Line timestamps shown in ${getBrowserTimeZone()}`;
    expect(
      normalizedText(renderCard({ loadingLogs: true, logs: "", logsError: null })),
    ).toContain(hint);
    expect(
      normalizedText(renderCard({ loadingLogs: false, logs: "", logsError: null })),
    ).toContain(hint);
    expect(
      normalizedText(
        renderCard({ loadingLogs: false, logs: "some output", logsError: null }),
      ),
    ).toContain(hint);
  });
});

describe("frontend/watchdog terminal session close", () => {
  // Slot layout of useWatchdogTerminal (useState calls in declaration
  // order) — terminalSessionId is the 6th state slot.
  const kSessionIdSlot = 5;

  const renderHook = () => {
    harness.beginRender();
    return useWatchdogTerminal({ active: false });
  };

  const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("warns and toasts when the user-initiated restart can't close the old session", async () => {
    api.closeWatchdogTerminalSession.mockRejectedValue(new Error("gone"));
    renderHook();
    harness.slots[kSessionIdSlot] = "sess-42";
    const state = renderHook();

    state.restartSession();
    await flushAsync();
    expect(api.closeWatchdogTerminalSession).toHaveBeenCalledWith("sess-42");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("session close failed"),
      expect.any(Error),
    );
    expect(showToast).toHaveBeenCalledWith(
      "Could not close the previous terminal session",
      "error",
    );
  });

  it("logs (no toast) when the unmount cleanup close fails — fire-and-forget", async () => {
    api.closeWatchdogTerminalSession.mockRejectedValue(new Error("gone"));
    renderHook();
    harness.slots[kSessionIdSlot] = "sess-7";
    renderHook();
    harness.effects[0](); // sync terminalSessionId into its ref
    const cleanup = harness.effects[2](); // the unmount-close effect
    cleanup();
    await flushAsync();

    expect(api.closeWatchdogTerminalSession).toHaveBeenCalledWith("sess-7");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("session close failed"),
      expect.any(Error),
    );
    expect(showToast).not.toHaveBeenCalled();
  });
});
