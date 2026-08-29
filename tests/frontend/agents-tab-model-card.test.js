import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component): hook state lives
// in per-call-index slots so hooks/components can be invoked directly without
// a DOM renderer. Effects are collected, not run.
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
  fetchThinkingOptions: vi.fn(),
}));

vi.mock("../../lib/public/js/components/models-tab/use-models.js", () => ({
  useModels: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { fetchThinkingOptions } from "../../lib/public/js/lib/api.js";
import { useModels } from "../../lib/public/js/components/models-tab/use-models.js";
import { useModelCard } from "../../lib/public/js/components/agents-tab/agent-overview/use-model-card.js";
import { AgentModelCard } from "../../lib/public/js/components/agents-tab/agent-overview/model-card.js";
import { OverflowMenu } from "../../lib/public/js/components/overflow-menu.js";

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

const findButtonByText = (tree, text) =>
  findAllByType(tree, "button").find((vnode) =>
    collectText(vnode).join(" ").includes(text),
  );

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const makeDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const kModelsReady = {
  catalog: [],
  primary: "anthropic/claude-sonnet-4-5",
  configuredModels: {},
  authProfiles: [],
  codexStatus: { connected: false },
  loading: false,
  ready: true,
};

const renderHook = (props) => {
  harness.beginRender();
  return useModelCard(props);
};

describe("frontend/agents-tab model card", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    useModels.mockReturnValue(kModelsReady);
    fetchThinkingOptions.mockResolvedValue({ ok: true, levels: [] });
  });

  describe("thinking level select (optimistic commit)", () => {
    it("renders the pending value while saving, then reverts with an inline error on failure", async () => {
      const deferred = makeDeferred();
      const onUpdateAgent = vi.fn(() => deferred.promise);
      const agent = { id: "a1" };

      let card = renderHook({ agent, onUpdateAgent });
      expect(card.thinkingSelectValue).toBe("");

      const commit = card.handleSelectThinkingDefault("high");

      card = renderHook({ agent, onUpdateAgent });
      // Optimistic: the select reflects the choice while the save is in flight.
      expect(card.thinkingSelectValue).toBe("high");
      expect(card.updatingThinking).toBe(true);
      expect(
        card.thinkingSelectOptions.some((option) => option.value === "high"),
      ).toBe(true);
      expect(onUpdateAgent).toHaveBeenCalledWith(
        "a1",
        { thinkingDefault: "high" },
        "Agent thinking level updated",
        { toastOnError: false },
      );

      deferred.reject(new Error("save failed"));
      await commit;

      card = renderHook({ agent, onUpdateAgent });
      // Loud revert: back to the server's value plus a retryable inline error.
      expect(card.thinkingSelectValue).toBe("");
      expect(card.updatingThinking).toBe(false);
      expect(card.thinkingSaveError).toMatchObject({ attempted: "high" });
      expect(card.thinkingSaveError.error.message).toBe("save failed");
    });

    it("clears the pending value and error on success", async () => {
      const onUpdateAgent = vi.fn(async () => ({ id: "a1", thinkingDefault: "low" }));
      let card = renderHook({ agent: { id: "a1" }, onUpdateAgent });

      await card.handleSelectThinkingDefault("low");

      // Parent adopts the saved agent; the select now derives from the prop.
      card = renderHook({
        agent: { id: "a1", thinkingDefault: "low" },
        onUpdateAgent,
      });
      expect(card.thinkingSelectValue).toBe("low");
      expect(card.thinkingSaveError).toBe(null);
      expect(card.updatingThinking).toBe(false);
    });

    it("retries the attempted value from the inline error", async () => {
      const onUpdateAgent = vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ id: "a1", thinkingDefault: "high" });
      let card = renderHook({ agent: { id: "a1" }, onUpdateAgent });

      await card.handleSelectThinkingDefault("high");
      card = renderHook({ agent: { id: "a1" }, onUpdateAgent });
      expect(card.thinkingSaveError).toBeTruthy();

      await card.retryThinkingSave();
      card = renderHook({ agent: { id: "a1" }, onUpdateAgent });
      expect(card.thinkingSaveError).toBe(null);
      expect(onUpdateAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe("set primary", () => {
    it("tracks the clicked row as pending and surfaces failures inline", async () => {
      const deferred = makeDeferred();
      const onUpdateAgent = vi.fn(() => deferred.promise);
      const agent = { id: "a1" };

      let card = renderHook({ agent, onUpdateAgent });
      const commit = card.handleSelectModel("openai/gpt-5");

      card = renderHook({ agent, onUpdateAgent });
      expect(card.pendingModelKey).toBe("openai/gpt-5");
      expect(card.updatingModel).toBe(true);
      expect(onUpdateAgent).toHaveBeenCalledWith(
        "a1",
        { model: { primary: "openai/gpt-5" } },
        "Agent model updated",
        { toastOnError: false },
      );

      deferred.reject(new Error("nope"));
      await commit;

      card = renderHook({ agent, onUpdateAgent });
      expect(card.pendingModelKey).toBe("");
      expect(card.updatingModel).toBe(false);
      expect(card.modelSaveError).toMatchObject({ attempted: "openai/gpt-5" });
    });

    it("shows a Setting... label on the clicked row and disables siblings", async () => {
      useModels.mockReturnValue({
        ...kModelsReady,
        configuredModels: {
          "anthropic/claude-sonnet-4-5": {},
          "anthropic/claude-haiku-4-5": {},
        },
        authProfiles: [{ provider: "anthropic", key: true }],
      });
      const deferred = makeDeferred();
      const onUpdateAgent = vi.fn(() => deferred.promise);
      const agent = { id: "a1" };

      harness.beginRender();
      let tree = expandTree(AgentModelCard({ agent, onUpdateAgent }));
      const setPrimary = findButtonByText(tree, "Set primary");
      expect(setPrimary).toBeTruthy();
      expect(setPrimary.props.disabled).toBe(false);

      setPrimary.props.onclick();
      harness.beginRender();
      tree = expandTree(AgentModelCard({ agent, onUpdateAgent }));
      const pendingButton = findButtonByText(tree, "Setting...");
      expect(pendingButton).toBeTruthy();
      expect(pendingButton.props.disabled).toBe(true);

      deferred.resolve({ id: "a1" });
      await flushAsync();
    });
  });

  describe("thinking options fetch", () => {
    it("handles a rejected options fetch without an unhandled rejection", async () => {
      fetchThinkingOptions.mockRejectedValue(new Error("options down"));
      const onUpdateAgent = vi.fn();

      renderHook({ agent: { id: "a1" }, onUpdateAgent });
      harness.effects[0]?.();
      await flushAsync();

      const card = renderHook({ agent: { id: "a1" }, onUpdateAgent });
      expect(card.thinkingOptionsError).toBeTruthy();
      expect(card.thinkingOptionsLoading).toBe(false);
      expect(card.showThinkingSelect).toBe(false);
    });
  });

  describe("card header while loading", () => {
    it("keeps the overflow menu rendered with only data-independent items", () => {
      useModels.mockReturnValue({ ...kModelsReady, loading: true, ready: false });

      harness.beginRender();
      const tree = expandTree(
        AgentModelCard({
          agent: { id: "a1", model: { primary: "openai/gpt-5" } },
          onUpdateAgent: vi.fn(),
        }),
      );

      expect(findAllByType(tree, OverflowMenu)).toHaveLength(1);
      const text = collectText(tree).join(" ");
      expect(text).toContain("Manage models");
      expect(text).not.toContain("Inherit model from defaults");
      expect(text).not.toContain("Inherit thinking from defaults");
    });
  });
});
