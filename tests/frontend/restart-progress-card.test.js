import { beforeEach, describe, expect, it, vi } from "vitest";

// Collect-only hook harness (see gateway-card.test.js). State persists across
// simulated renders so disclosure clicks can be re-rendered.
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

import * as preactHooks from "preact/hooks";
import {
  RestartProgressCard,
  buildRestartStepModels,
  getCurrentStepName,
} from "../../lib/public/js/components/restart-progress-card.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

const harness = preactHooks.__harness;

const kNow = Date.parse("2026-08-27T12:00:00.000Z");

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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

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

const treeText = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");

const findButtonByText = (tree, text) =>
  findAllByType(tree, "button").find((vnode) =>
    collectText(vnode).join(" ").includes(text),
  );

const renderCard = (props = {}) => {
  harness.beginRender();
  return expandTree(RestartProgressCard({ nowMs: kNow, ...props }));
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const kRunningOperation = {
  operationId: "op-1",
  startedAt: kNow - 12000,
  phase: "running",
  steps: [
    { name: "preparing_plugins", label: "Checking plugins", status: "running" },
    { name: "preparing_plugins", label: "Checking plugins", status: "done" },
    { name: "stopping", label: "Stopping gateway", status: "running" },
    { name: "stopping", label: "Stopping gateway", status: "done" },
    { name: "launching", label: "Starting gateway", status: "running" },
  ],
  error: null,
};

describe("frontend/restart-progress-card", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("collapses the raw step event stream to one row per step", () => {
    const models = buildRestartStepModels(kRunningOperation.steps);
    expect(models.map((step) => [step.name, step.status])).toEqual([
      ["preparing_plugins", "done"],
      ["stopping", "done"],
      ["launching", "running"],
    ]);
    expect(getCurrentStepName(models)).toBe("launching");
  });

  it("renders the step sequence as an ordered list with aria-current on the running step", () => {
    const tree = renderCard({ operation: kRunningOperation });
    const text = treeText(tree);
    expect(text).toContain("Restarting gateway");
    expect(text).toContain("Checking plugins");
    expect(text).toContain("Stopping gateway");
    expect(text).toContain("Starting gateway");
    expect(text).toContain("elapsed");

    const orderedLists = findAllByType(tree, "ol");
    expect(orderedLists.length).toBe(1);
    const rows = findAllByType(tree, "li");
    expect(rows.length).toBe(3);
    const currentRows = rows.filter(
      (row) => row.props["aria-current"] === "step",
    );
    expect(currentRows.length).toBe(1);
    expect(collectText(currentRows[0]).join(" ")).toContain("Starting gateway");
    // Completed rows are green, the running row pulses.
    const dotClasses = rows.map((row) =>
      String(
        findAllByType(row, "span").find((s) =>
          String(s.props.class || "").includes("rounded-full"),
        )?.props.class || "",
      ),
    );
    expect(dotClasses[0]).toContain("bg-green-500/90");
    expect(dotClasses[1]).toContain("bg-green-500/90");
    expect(dotClasses[2]).toContain("bg-cyan-400/90");
  });

  it("renders the success line with measured downtime and marks all steps done", () => {
    const tree = renderCard({
      operation: {
        ...kRunningOperation,
        phase: "succeeded",
        durationMs: 20000,
        downtimeMs: 4200,
      },
      onDismiss: vi.fn(),
    });
    const text = treeText(tree);
    expect(text).toContain("Gateway is running — ready in 4s");
    const statusRegion = collectNodes(tree).find(
      (vnode) => vnode.props?.role === "status",
    );
    expect(statusRegion).toBeTruthy();
    // All steps display as completed.
    const rows = findAllByType(tree, "li");
    for (const row of rows) {
      const dot = findAllByType(row, "span").find((s) =>
        String(s.props.class || "").includes("rounded-full"),
      );
      expect(String(dot.props.class || "")).toContain("bg-green-500/90");
      expect(row.props["aria-current"]).toBeFalsy();
    }
    const dismiss = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Dismiss",
    );
    expect(dismiss).toBeTruthy();
  });

  it("falls back to durationMs for the success line when downtime is absent", () => {
    const tree = renderCard({
      operation: {
        ...kRunningOperation,
        phase: "succeeded",
        durationMs: 20000,
        downtimeMs: null,
      },
    });
    expect(treeText(tree)).toContain("Gateway is running — ready in 20s");
  });

  it("renders the failure block with role=alert, hint, and the server's primary action", () => {
    const onPrimaryAction = vi.fn();
    const primaryAction = {
      id: "retry",
      label: "Retry",
      kind: "primary",
      description: "Try starting the gateway again.",
    };
    const tree = renderCard({
      operation: {
        ...kRunningOperation,
        phase: "failed",
        error: {
          message: "gateway did not become ready within 120s",
          hint: "Retry, run Repair, or check the gateway logs.",
          code: "restart_failed",
        },
      },
      primaryAction,
      onPrimaryAction,
      onDismiss: vi.fn(),
    });
    const text = treeText(tree);
    expect(text).toContain("Gateway restart failed");
    expect(text).toContain("gateway did not become ready within 120s");
    expect(text).toContain("Retry, run Repair, or check the gateway logs.");

    const alertRegion = collectNodes(tree).find(
      (vnode) => vnode.props?.role === "alert",
    );
    expect(alertRegion).toBeTruthy();

    const retryButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Retry",
    );
    expect(retryButton).toBeTruthy();
    retryButton.props.onClick();
    expect(onPrimaryAction).toHaveBeenCalledWith(primaryAction);
  });

  it("a terminal failure stops in-flight steps: current step renders failed, other in-flight steps interrupted, nothing keeps pulsing", () => {
    // The server never emits terminal step statuses on failure, and
    // "launching" never receives one at all — a waiting_ready timeout leaves
    // BOTH "Starting gateway" and "Waiting for health check" latched as
    // "running". The failed card must not keep them pulsing as if in
    // progress.
    const tree = renderCard({
      operation: {
        ...kRunningOperation,
        steps: [
          ...kRunningOperation.steps,
          {
            name: "waiting_ready",
            label: "Waiting for health check",
            status: "running",
          },
        ],
        phase: "failed",
        error: {
          message: "gateway did not become ready within 120s",
          hint: null,
          code: "restart_failed",
        },
      },
    });
    const rows = findAllByType(tree, "li");
    expect(rows.length).toBe(4);
    const dotClassFor = (row) =>
      String(
        findAllByType(row, "span").find((s) =>
          String(s.props.class || "").includes("rounded-full"),
        )?.props.class || "",
      );
    for (const row of rows) {
      expect(dotClassFor(row)).not.toContain("animate-pulse");
      expect(row.props["aria-current"]).toBeFalsy();
    }
    // Completed steps stay green; the step that was current is failed (red);
    // the other in-flight step renders as interrupted (gray, no motion).
    expect(dotClassFor(rows[0])).toContain("bg-green-500/90");
    expect(dotClassFor(rows[1])).toContain("bg-green-500/90");
    expect(dotClassFor(rows[2])).toContain("bg-gray-500/60");
    expect(dotClassFor(rows[3])).toContain("bg-red-500/90");
  });

  it("evidence disclosure: loading → collapsed 2-line summary → show more → full tail", async () => {
    const evidenceLines = Array.from(
      { length: 20 },
      (_, i) => `stderr line ${i + 1}`,
    );
    let resolveEvidence;
    const onLoadEvidence = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveEvidence = resolve;
        }),
    );
    const failedOperation = {
      ...kRunningOperation,
      phase: "failed",
      error: { message: "boom", hint: null, code: null },
    };

    let tree = renderCard({ operation: failedOperation, onLoadEvidence });
    const toggle = findButtonByText(tree, "Show evidence");
    expect(toggle).toBeTruthy();
    expect(toggle.props["aria-expanded"]).toBe("false");

    toggle.props.onclick();
    tree = renderCard({ operation: failedOperation, onLoadEvidence });
    expect(onLoadEvidence).toHaveBeenCalledWith("op-1");
    expect(treeText(tree)).toContain("Loading evidence…");
    expect(findButtonByText(tree, "Hide evidence").props["aria-expanded"]).toBe(
      "true",
    );

    resolveEvidence(evidenceLines.join("\n"));
    await flushMicrotasks();
    tree = renderCard({ operation: failedOperation, onLoadEvidence });
    const text = treeText(tree);
    // Collapsed: last two lines only.
    expect(text).toContain("stderr line 19");
    expect(text).toContain("stderr line 20");
    expect(text).not.toContain("stderr line 5");

    const showMore = findButtonByText(tree, "Show more");
    expect(showMore).toBeTruthy();
    showMore.props.onclick();
    tree = renderCard({ operation: failedOperation, onLoadEvidence });
    const fullText = treeText(tree);
    expect(fullText).toContain("stderr line 5");
    expect(fullText).toContain("stderr line 20");
    expect(findButtonByText(tree, "Show less")).toBeTruthy();
  });

  it("evidence disclosure renders 'Evidence expired' when the server no longer has it", async () => {
    const onLoadEvidence = vi.fn(async () => null);
    const failedOperation = {
      ...kRunningOperation,
      phase: "failed",
      error: { message: "boom", hint: null, code: null },
    };
    let tree = renderCard({ operation: failedOperation, onLoadEvidence });
    findButtonByText(tree, "Show evidence").props.onclick();
    await flushMicrotasks();
    tree = renderCard({ operation: failedOperation, onLoadEvidence });
    expect(treeText(tree)).toContain("Evidence expired");
  });

  it("evidence disclosure renders a distinct error line when the fetch fails — never 'Evidence expired'", async () => {
    const onLoadEvidence = vi.fn(async () => {
      throw new Error("network down");
    });
    const failedOperation = {
      ...kRunningOperation,
      phase: "failed",
      error: { message: "boom", hint: null, code: null },
    };
    let tree = renderCard({ operation: failedOperation, onLoadEvidence });
    findButtonByText(tree, "Show evidence").props.onclick();
    await flushMicrotasks();
    tree = renderCard({ operation: failedOperation, onLoadEvidence });
    const text = treeText(tree);
    expect(text).toContain("Couldn't load evidence — network down");
    expect(text).not.toContain("Evidence expired");
  });

  it("renders nothing without an operation", () => {
    harness.beginRender();
    expect(RestartProgressCard({ operation: null })).toBeNull();
  });

  // The former formatSecondsAgo helper is gone — freeze stamps now render
  // through the shared formatRelativeTime core (covered in format.test.js;
  // the gateway card's "as of Xs ago" rendering is covered in
  // gateway-card.test.js).
});
