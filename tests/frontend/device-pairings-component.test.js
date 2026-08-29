import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component.test.js): hook
// state lives in per-call-index slots so component functions can be invoked
// directly without a DOM renderer. Effects are collected, not run.
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
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { DevicePairings } from "../../lib/public/js/components/device-pairings.js";

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

const findAction = (tree, idleLabel) =>
  findAllByType(tree, ActionButton).find(
    (vnode) => vnode.props.idleLabel === idleLabel,
  );

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const kDevice = { id: "dev-1", clientMode: "webchat", platform: "macos", role: "operator" };

const renderPairings = (props) => {
  harness.beginRender();
  return expandTree(DevicePairings(props));
};

describe("frontend/device pairings row", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  it("clears busy and renders a persistent inline error when approve fails", async () => {
    const error = new Error("gateway offline");
    const onApprove = vi.fn(() => Promise.reject(error));
    const onReject = vi.fn();
    let tree = renderPairings({ pending: [kDevice], onApprove, onReject });

    findAction(tree, "Approve").props.onClick();
    await flushAsync();
    tree = renderPairings({ pending: [kDevice], onApprove, onReject });

    // Not stuck on the optimistic "Approved" terminal state — both actions
    // are available again with a persistent error adjacent to them.
    expect(findAction(tree, "Approve")).toBeTruthy();
    expect(findAction(tree, "Reject")).toBeTruthy();
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe("Couldn't approve this device.");
    expect(chips[0].props.error).toBe(error);
    expect(collectText(tree).join(" ")).toContain("gateway offline");
  });

  it("clears busy and renders a persistent inline error when reject fails", async () => {
    const error = new Error("nope");
    const onApprove = vi.fn();
    const onReject = vi.fn(() => Promise.reject(error));
    let tree = renderPairings({ pending: [kDevice], onApprove, onReject });

    findAction(tree, "Reject").props.onClick();
    await flushAsync();
    tree = renderPairings({ pending: [kDevice], onApprove, onReject });

    expect(findAction(tree, "Approve")).toBeTruthy();
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.headline).toBe("Couldn't reject this device.");
  });

  it("clears the error on the next attempt", async () => {
    const onApprove = vi
      .fn()
      .mockRejectedValueOnce(new Error("first try failed"))
      .mockResolvedValueOnce({});
    const onReject = vi.fn();
    let tree = renderPairings({ pending: [kDevice], onApprove, onReject });

    findAction(tree, "Approve").props.onClick();
    await flushAsync();
    tree = renderPairings({ pending: [kDevice], onApprove, onReject });
    expect(findAllByType(tree, InlineErrorChip).length).toBe(1);

    findAction(tree, "Approve").props.onClick();
    await flushAsync();
    tree = renderPairings({ pending: [kDevice], onApprove, onReject });
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
    expect(collectText(tree).join(" ")).toContain("Approved");
  });
});
