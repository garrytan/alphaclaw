import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (team-tab-component pattern): components are invoked
// directly and the vnode tree is walked — no DOM renderer.
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

vi.mock("../../lib/public/js/components/models-tab/use-models.js", () => ({
  useModels: vi.fn(),
  kCodexStatusCacheKey: "/api/codex/status",
}));

import * as preactHooks from "preact/hooks";
import { useModels } from "../../lib/public/js/components/models-tab/use-models.js";
import { SearchableModelPicker } from "../../lib/public/js/components/models-tab/model-picker.js";
import { ProviderAuthCard } from "../../lib/public/js/components/models-tab/provider-auth-card.js";
import { Models } from "../../lib/public/js/components/models-tab/index.js";

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

const kModelsBase = {
  catalog: [],
  primary: "",
  configuredModels: {},
  authProfiles: [],
  authOrder: {},
  codexStatus: { connected: false },
  codexStatusError: "",
  codexStatusKnown: false,
  loading: true,
  saving: false,
  ready: false,
  error: "",
  isDirty: false,
  refresh: vi.fn(),
  addModel: vi.fn(),
  removeModel: vi.fn(),
  setPrimaryModel: vi.fn(),
  editProfile: vi.fn(),
  editAuthOrder: vi.fn(),
  getProfileValue: () => null,
  getEffectiveOrder: () => null,
  cancelChanges: vi.fn(),
  saveAll: vi.fn(),
  refreshCodexStatus: vi.fn(),
};

const renderModels = (props = {}) => {
  harness.beginRender();
  return expandTree(Models(props));
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
});

describe("frontend/models-tab pane shell states", () => {
  it("cold-load renders the card structure with a scoped loading line and a disabled picker (no confident empty state)", () => {
    useModels.mockReturnValue({ ...kModelsBase, loading: true, ready: false });
    const tree = renderModels({});

    const text = collectText(tree).join(" ");
    expect(text).toContain("Available Models");
    expect(text).toContain("Loading model settings...");
    expect(text).not.toContain("No models configured");

    const picker = findAllByType(tree, SearchableModelPicker)[0];
    expect(picker).toBeTruthy();
    expect(picker.props.disabled).toBe(true);
  });

  it("shows the genuine empty state and an enabled picker once ready", () => {
    useModels.mockReturnValue({ ...kModelsBase, loading: false, ready: true });
    const tree = renderModels({});

    const text = collectText(tree).join(" ");
    expect(text).toContain("No models configured");
    expect(text).not.toContain("Loading model settings...");
    expect(findAllByType(tree, SearchableModelPicker)[0].props.disabled).toBe(
      false,
    );
  });

  it("threads codexStatusError and codexStatusKnown through to the provider auth cards", () => {
    useModels.mockReturnValue({
      ...kModelsBase,
      loading: false,
      ready: true,
      configuredModels: { "openai-codex/gpt-5.6-sol": {} },
      codexStatus: { connected: true },
      codexStatusError: "status endpoint down",
      codexStatusKnown: true,
    });
    const tree = renderModels({});

    const cards = findAllByType(tree, ProviderAuthCard);
    expect(cards.length).toBeGreaterThan(0);
    expect(
      cards.every(
        (card) => card.props.codexStatusError === "status endpoint down",
      ),
    ).toBe(true);
    expect(cards.every((card) => card.props.codexStatusKnown === true)).toBe(
      true,
    );
  });
});
