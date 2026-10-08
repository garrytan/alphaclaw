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
  describeRestartFailure,
  describeRestartPhase,
  describeRestartSuccess,
  humanDuration,
  kOptimisticStepName,
  restartStartedAtMs,
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

const findButton = (tree, label) =>
  findAllByType(tree, ActionButton).find((vnode) => vnode.props.idleLabel === label);

const renderCard = (props = {}) => {
  harness.beginRender();
  return expandTree(RestartProgressCard({ nowMs: kNow, ...props }));
};

const runEffects = () => {
  for (const effect of harness.effects) effect();
};

const step = (name, status, extra = {}) => ({ name, label: name, status, ...extra });

const kRunningOperation = {
  operationId: "op-1",
  startedAt: kNow - 12000,
  phase: "running",
  steps: [
    step("preparing_plugins", "running", { at: kNow - 12000 }),
    step("preparing_plugins", "done", { at: kNow - 11000 }),
    step("stopping", "running", { at: kNow - 11000, detail: { phase: "asking", activeWork: 2 } }),
    step("stopping", "done", { at: kNow - 8000, detail: { how: "graceful" } }),
    step("launching", "running", { at: kNow - 8000 }),
  ],
  error: null,
};

describe("frontend/restart-progress-card", () => {
  beforeEach(() => {
    harness.reset();
  });

  // Every phase line in the server ↔ UI contract, in emission order.
  it.each([
    [[step(kOptimisticStepName, "running")], "contacting AlphaClaw…"],
    [[step("preparing_plugins", "running")], "checking plugins (gateway still running)"],
    [[step("preparing_plugins", "skipped")], null],
    [[step("preparing_plugins", "warning")], "checking plugins (plugin check had warnings)"],
    [[step("stopping", "running", { detail: { phase: "asking" } })], "asking OpenClaw to finish its current work"],
    [[step("stopping", "running", { detail: { phase: "asking", activeWork: 3 } })], "asking OpenClaw to finish its current work (3 tasks)"],
    [[step("stopping", "running", { detail: { phase: "asking", activeWork: 1 } })], "asking OpenClaw to finish its current work (1 task)"],
    [[step("stopping", "running", { detail: { phase: "terminating" } })], "stopping OpenClaw"],
    [[step("stopping", "running")], "stopping OpenClaw"],
    [[step("stopping", "running", { detail: { phase: "forcing", graceSeconds: 10 } })], "OpenClaw didn't stop in 10s, forcing it (active work may be interrupted)"],
    [[step("stopping", "running", { detail: { phase: "terminating" } }), step("stopping", "done", { detail: { how: "sigterm" } })], "stopping OpenClaw"],
    [[step("launching", "running")], "starting OpenClaw"],
    [[step("waiting_ready", "running")], "checking readiness"],
    [[step("waiting_ready", "running", { detail: { phase: "lock_wait" } })], "waiting for OpenClaw's state lock (another OpenClaw process is finishing)"],
    [[step("waiting_for_lock", "running")], "waiting for the current operation to finish"],
    [[step("ready", "done")], "OpenClaw is ready"],
    [[{ name: "custom_step", label: "Doing a thing", status: "running" }], "doing a thing"],
  ])("describeRestartPhase(%j) → %j", (steps, expected) => {
    expect(describeRestartPhase(steps)).toBe(expected);
  });

  it("the latest step with copy wins; terminal statuses keep the previous line", () => {
    expect(describeRestartPhase(kRunningOperation.steps)).toBe("starting OpenClaw");
    expect(describeRestartPhase(kRunningOperation.steps.slice(0, 4))).toBe(
      "asking OpenClaw to finish its current work (2 tasks)",
    );
    expect(describeRestartPhase([])).toBeNull();
    expect(describeRestartPhase(null)).toBeNull();
  });

  it("elapsed time anchors to the earliest server step stamp, falling back to startedAt", () => {
    expect(restartStartedAtMs(kRunningOperation)).toBe(kNow - 12000);
    expect(restartStartedAtMs({ startedAt: kNow - 3000, steps: [step("stopping", "running")] })).toBe(kNow - 3000);
    expect(restartStartedAtMs(null)).toBe(0);
  });

  it("renders ONE running line: pulsing dot, phase copy, elapsed, aria-live=polite, no step list", () => {
    const tree = renderCard({ operation: kRunningOperation });
    const text = treeText(tree);
    expect(text).toContain("Restarting: starting OpenClaw · 12s");
    expect(text).not.toContain("Checking plugins");
    expect(text).not.toContain("elapsed");
    expect(findAllByType(tree, "ol")).toEqual([]);
    expect(findAllByType(tree, "li")).toEqual([]);
    expect(findAllByType(tree, ActionButton)).toEqual([]);
    const line = findAllByType(tree, "p")[0];
    expect(line.props["aria-live"]).toBe("polite");
    expect(line.props.tabindex).toBe("-1");
    const dot = findAllByType(tree, "span").find((s) => String(s.props.class || "").includes("ac-gateway-dot"));
    expect(String(dot.props.class)).toContain("ac-gateway-dot--pulse");
    expect(String(dot.props.class)).toContain("ac-gateway-dot--cyan");
  });

  it("forcing and lock_wait phases render their full sentences with the live elapsed timer", () => {
    const forcing = renderCard({
      nowMs: kNow + 30000,
      operation: {
        ...kRunningOperation,
        steps: [
          step("stopping", "running", { at: kNow - 12000, detail: { phase: "asking" } }),
          step("stopping", "running", { at: kNow, detail: { phase: "forcing", graceSeconds: 12 } }),
        ],
      },
    });
    expect(treeText(forcing)).toContain(
      "Restarting: OpenClaw didn't stop in 12s, forcing it (active work may be interrupted) · 42s",
    );
    const lockWait = renderCard({
      nowMs: kNow + 70000,
      operation: {
        ...kRunningOperation,
        steps: [
          ...kRunningOperation.steps,
          step("waiting_ready", "running", { at: kNow, detail: { phase: "lock_wait" } }),
        ],
      },
    });
    expect(treeText(lockWait)).toContain(
      "Restarting: waiting for OpenClaw's state lock (another OpenClaw process is finishing) · 1m 22s",
    );
  });

  it("the optimistic placeholder renders as contacting AlphaClaw; no steps at all renders a generic line", () => {
    expect(
      treeText(
        renderCard({
          operation: { operationId: null, startedAt: kNow - 1000, phase: "running", steps: [step(kOptimisticStepName, "running")] },
        }),
      ),
    ).toContain("Restarting: contacting AlphaClaw… · 1s");
    expect(
      treeText(renderCard({ operation: { operationId: "op-x", startedAt: kNow, phase: "running", steps: [] } })),
    ).toContain("Restarting: preparing · 0s");
  });

  it("focus moves to the line when a restart starts (effect targets the line ref)", () => {
    const focus = vi.fn();
    renderCard({ operation: kRunningOperation });
    // The ref slot is the first hook; emulate the mounted element.
    harness.slots[0].current = { focus };
    runEffects();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("success: 'Running: restarted in Ns (down for Ms)' as a status line with no buttons", () => {
    const tree = renderCard({
      operation: { ...kRunningOperation, phase: "succeeded", durationMs: 20000, downtimeMs: 4200 },
    });
    expect(treeText(tree)).toContain("Running: restarted in 20s (down for 4s)");
    const status = collectNodes(tree).find((vnode) => vnode.props?.role === "status");
    expect(status).toBeTruthy();
    expect(findAllByType(tree, ActionButton)).toEqual([]);
    expect(treeText(tree)).not.toContain("Dismiss");
    expect(describeRestartSuccess({ durationMs: 20000, downtimeMs: null })).toBe("Running: restarted in 20s");
    expect(describeRestartSuccess({})).toBe("Running: gateway restarted");
  });

  it("humanDuration renders whole minutes as 'N min' and everything else in seconds", () => {
    expect(humanDuration(300000)).toBe("5 min");
    expect(humanDuration(90000)).toBe("90 s");
    expect(humanDuration(60000)).toBe("1 min");
    expect(humanDuration(400)).toBe("1 s");
  });

  // One sentence per failure code.
  it.each([
    [{ code: "stop_refused", message: "x" }, "Couldn't safely identify the running gateway. Restart the container, or open View logs.", false],
    [{ code: "stop_failed", message: "x" }, "Couldn't stop the old gateway, so your changes are not live yet.", true],
    [{ code: "launch_failed", message: "spawn ENOENT." }, "The old gateway stopped, but OpenClaw didn't start: spawn ENOENT.", true],
    [{ code: "ready_timeout", budgetMs: 300000 }, "OpenClaw started but wasn't ready within 5 min.", true],
    [{ code: "ready_timeout", budgetMs: 90000 }, "OpenClaw started but wasn't ready within 90 s.", true],
    [{ code: "ready_timeout" }, "OpenClaw started but wasn't ready in time.", true],
    [{ code: "aborted" }, "Restart was cancelled (AlphaClaw is shutting down or another operation took over).", true],
    [{ code: "response_lost", message: "fetch failed" }, "Couldn't confirm whether the restart started — the connection dropped. Checking with AlphaClaw…", false],
    [{ code: "weird", message: "gateway exited with code 1" }, "Restart failed: gateway exited with code 1.", true],
    [{ message: "gateway exited with code 1" }, "Restart failed: gateway exited with code 1.", true],
    [{}, "Restart failed.", true],
  ])("describeRestartFailure(%j)", (error, message, canRetry) => {
    expect(describeRestartFailure(error)).toEqual({ message, canRetry });
  });

  it("failure: role=alert line with ✕, the sentence, Try again (→ onRetry) and View logs (→ onViewLogs)", () => {
    const onRetry = vi.fn();
    const onViewLogs = vi.fn();
    const tree = renderCard({
      operation: {
        ...kRunningOperation,
        phase: "failed",
        error: { message: "gateway did not become ready within 120s", hint: "Retry", code: "ready_timeout", budgetMs: 120000 },
      },
      onRetry,
      onViewLogs,
    });
    const text = treeText(tree);
    expect(text).toContain("✕");
    expect(text).toContain("OpenClaw started but wasn't ready within 2 min.");
    expect(text).not.toContain("Gateway restart failed");
    expect(text).not.toContain("Show evidence");
    expect(text).not.toContain("Dismiss");
    const alert = collectNodes(tree).find((vnode) => vnode.props?.role === "alert");
    expect(alert).toBeTruthy();
    expect(alert.props.tabindex).toBe("-1");
    findButton(tree, "Try again").props.onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
    findButton(tree, "View logs").props.onClick();
    expect(onViewLogs).toHaveBeenCalledTimes(1);
    expect(findButton(tree, "Try again").props.tone).toBe("primary");
    expect(findButton(tree, "View logs").props.tone).toBe("secondary");
  });

  it("stop_refused and an unknown (lost-response) outcome offer View logs only — never Try again", () => {
    for (const code of ["stop_refused", "response_lost"]) {
      harness.reset();
      const tree = renderCard({
        operation: { ...kRunningOperation, phase: "failed", error: { message: "x", code } },
        onRetry: vi.fn(),
        onViewLogs: vi.fn(),
      });
      expect(findButton(tree, "Try again"), code).toBeUndefined();
      expect(findButton(tree, "View logs"), code).toBeTruthy();
    }
  });

  it("renders nothing without an operation", () => {
    harness.beginRender();
    expect(RestartProgressCard({ operation: null })).toBeNull();
  });
});
