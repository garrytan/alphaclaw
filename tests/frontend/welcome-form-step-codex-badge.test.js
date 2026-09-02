import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (team-tab-component pattern): hook state lives in
// per-call-index slots so the component can be invoked directly without a
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

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import { Badge } from "../../lib/public/js/components/badge.js";
import { WelcomeFormStep } from "../../lib/public/js/components/onboarding/welcome-form-step.js";

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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const findBadgeByText = (tree, text) =>
  findAllByType(tree, Badge).find((vnode) =>
    collectText(vnode).join(" ").includes(text),
  );

const kBaseProps = {
  activeGroup: {
    id: "ai",
    title: "Primary Agent Model",
    description: "",
    fields: [],
    validate: () => true,
  },
  vals: {},
  hasAi: true,
  setValue: vi.fn(),
  modelOptions: [],
  modelsLoading: false,
  modelsError: "",
  canToggleFullCatalog: false,
  showAllModels: false,
  setShowAllModels: vi.fn(),
  selectedProvider: "openai-codex",
  codexLoading: false,
  codexStatus: { connected: false },
  codexStatusUnknown: false,
  startCodexAuth: vi.fn(),
  handleCodexDisconnect: vi.fn(),
  codexDisconnecting: false,
  codexAuthStarted: false,
  codexAuthWaiting: false,
  codexManualInput: "",
  setCodexManualInput: vi.fn(),
  completeCodexAuth: vi.fn(),
  codexExchanging: false,
  visibleAiFieldKeys: new Set(),
  error: null,
  step: 0,
  totalGroups: 8,
  goBack: vi.fn(),
  goNext: vi.fn(),
  loading: false,
  githubStepLoading: false,
  handleSubmit: vi.fn(),
};

const renderStep = (props = {}) => {
  harness.beginRender();
  return expandTree(WelcomeFormStep({ ...kBaseProps, ...props }));
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
});

describe("frontend/welcome-form-step codex status badge", () => {
  it("a failed FIRST check renders a neutral 'Status unknown', never 'Not connected' as fact", () => {
    const tree = renderStep({ codexStatusUnknown: true });
    const badge = findBadgeByText(tree, "Status unknown");
    expect(badge).toBeTruthy();
    expect(badge.props.tone).toBe("neutral");
    expect(collectText(tree).join(" ")).not.toContain("Not connected");
  });

  it("a genuinely-checked disconnected status still renders the warning 'Not connected'", () => {
    const tree = renderStep({ codexStatusUnknown: false });
    const badge = findBadgeByText(tree, "Not connected");
    expect(badge).toBeTruthy();
    expect(badge.props.tone).toBe("warning");
  });

  it("a quiet-period status renders 'Unavailable during backup' with the honest line, never 'Not connected'", () => {
    const tree = renderStep({
      codexStatus: { connected: false, unavailable: true, reason: "backup_in_progress" },
      codexStatusUnknown: false,
      codexStatusKnown: false,
    });
    const badge = findBadgeByText(tree, "Unavailable during backup");
    expect(badge).toBeTruthy();
    expect(badge.props.tone).toBe("warning");
    const text = collectText(tree).join(" ");
    expect(text).toContain("Codex status unknown until it finishes");
    expect(text).not.toContain("Not connected");

    const lastKnown = collectText(
      renderStep({
        codexStatus: { connected: true, unavailable: true, reason: "backup_in_progress" },
        codexStatusUnknown: false,
        codexStatusKnown: true,
      }),
    ).join(" ");
    expect(lastKnown).toContain("showing the last known Codex status (connected)");
  });

  it("a deferred save renders 'Connected — saved after the backup finishes' until the store confirms", () => {
    const tree = renderStep({
      codexStatus: { connected: false, unavailable: true, reason: "backup_in_progress" },
      codexDeferredSavePending: true,
    });
    const badge = findBadgeByText(tree, "Connected — saved after the backup finishes");
    expect(badge).toBeTruthy();
    expect(badge.props.tone).toBe("info");

    const confirmed = renderStep({
      codexStatus: { connected: true },
      codexDeferredSavePending: true,
    });
    expect(findBadgeByText(confirmed, "saved after")).toBeUndefined();
    expect(findBadgeByText(confirmed, "Connected")).toBeTruthy();
  });

  it("a kept last-known connected status renders 'Connected' even while checks fail", () => {
    const tree = renderStep({
      codexStatus: { connected: true },
      codexStatusUnknown: false,
    });
    const badge = findBadgeByText(tree, "Connected");
    expect(badge).toBeTruthy();
    expect(badge.props.tone).toBe("success");
  });
});
