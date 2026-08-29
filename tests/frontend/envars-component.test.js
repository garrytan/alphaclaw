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

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchEnvVars: vi.fn(),
  saveEnvVars: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: vi.fn(),
}));

vi.mock("../../lib/public/js/hooks/use-openclaw-features.js", () => ({
  useOpenclawFeatures: vi.fn(() => ({ features: null })),
}));

import * as preactHooks from "preact/hooks";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { Envars } from "../../lib/public/js/components/envars.js";

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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const renderEnvars = () => {
  harness.beginRender();
  return expandTree(Envars({}));
};

describe("frontend/envars component", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders an inline error card with Retry when the page load fails with nothing to show", async () => {
    const error = new Error("env fetch failed");
    const refresh = vi.fn(async () => {
      throw error;
    });
    useCachedFetch.mockReturnValue({ data: null, error, loading: false, refresh });

    const tree = renderEnvars();
    // PaneShell body vnodes are reachable via both props.children and the
    // rendered output, so assert presence rather than an exact count.
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].props.headline).toBe("Couldn't load environment variables.");
    expect(chips[0].props.error).toBe(error);

    await chips[0].props.onRetry();
    expect(refresh).toHaveBeenCalledWith({ force: true });
  });

  it("keeps the loading state (not the error card) while the first load is in flight", () => {
    useCachedFetch.mockReturnValue({
      data: null,
      error: null,
      loading: true,
      refresh: vi.fn(),
    });
    const tree = renderEnvars();
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
  });

  it("surfaces a Cancel/reload failure inline near the actions and clears it on the next attempt", async () => {
    const error = new Error("reload failed");
    const refresh = vi.fn(async () => {
      throw error;
    });
    useCachedFetch.mockReturnValue({
      data: { vars: [], reservedKeys: [] },
      error: null,
      loading: false,
      refresh,
    });

    let tree = renderEnvars();
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
    const cancel = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Cancel",
    );
    expect(cancel).toBeTruthy();

    await cancel.props.onClick();
    tree = renderEnvars();
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].props.headline).toContain(
      "Couldn't reload environment variables",
    );
    expect(chips[0].props.error).toBe(error);

    refresh.mockImplementation(async () => ({ vars: [], reservedKeys: [] }));
    await cancel.props.onClick();
    tree = renderEnvars();
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
  });
});
