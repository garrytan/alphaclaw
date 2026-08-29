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

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAgent: vi.fn(),
    deleteAgent: vi.fn(),
    fetchAgents: vi.fn(),
    setDefaultAgent: vi.fn(),
    updateAgent: vi.fn(),
  };
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

// channels.js transitively imports channel-login-modal, which uses CDN URL
// imports the node ESM loader can't resolve.
vi.mock("../../lib/public/js/components/channels.js", () => ({
  ALL_CHANNELS: ["telegram", "discord", "slack", "whatsapp"],
  ChannelsCard: () => null,
  getChannelMeta: (id) => ({ label: String(id || "") }),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { useAgents } from "../../lib/public/js/components/agents-tab/use-agents.js";
import { AgentsTab } from "../../lib/public/js/components/agents-tab/index.js";
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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

describe("frontend/agents-tab agents load error", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  describe("useAgents", () => {
    const renderHook = () => {
      harness.beginRender();
      return useAgents();
    };

    it("sets loadError on a failed fetch and clears it on a successful retry", async () => {
      api.fetchAgents.mockRejectedValueOnce(new Error("agents down"));
      let hook = renderHook();
      await hook.actions.loadAgents();

      hook = renderHook();
      expect(hook.state.loading).toBe(false);
      expect(hook.state.loadError).toBeTruthy();
      expect(hook.state.loadError.message).toBe("agents down");
      expect(hook.actions.loadError).toBe(hook.state.loadError);

      api.fetchAgents.mockResolvedValueOnce({ agents: [{ id: "a1" }] });
      await hook.actions.loadAgents();
      hook = renderHook();
      expect(hook.state.loadError).toBe(null);
      expect(hook.state.agents).toEqual([{ id: "a1" }]);
    });

    it("keeps last-known-good agents when a reload fails", async () => {
      api.fetchAgents.mockResolvedValueOnce({ agents: [{ id: "a1" }] });
      let hook = renderHook();
      await hook.actions.loadAgents();

      api.fetchAgents.mockRejectedValueOnce(new Error("boom"));
      hook = renderHook();
      await hook.actions.loadAgents();

      hook = renderHook();
      expect(hook.state.agents).toEqual([{ id: "a1" }]);
      expect(hook.state.loadError).toBeTruthy();
    });
  });

  describe("AgentsTab", () => {
    it("renders a retryable error region instead of the empty detail panel", () => {
      const loadAgents = vi.fn();
      harness.beginRender();
      const tree = expandTree(
        AgentsTab({
          agents: [],
          loading: false,
          saving: false,
          agentsActions: { loadAgents, loadError: new Error("agents down") },
        }),
      );

      const chips = findAllByType(tree, InlineErrorChip);
      expect(chips).toHaveLength(1);
      expect(chips[0].props.headline).toBe("Couldn't load agents.");

      chips[0].props.onRetry();
      expect(loadAgents).toHaveBeenCalledTimes(1);
    });

    it("still renders agents when a refresh failed but data exists", () => {
      harness.beginRender();
      const tree = expandTree(
        AgentsTab({
          agents: [{ id: "a1", name: "Main" }],
          loading: false,
          saving: false,
          selectedAgentId: "a1",
          agentsActions: {
            loadAgents: vi.fn(),
            loadError: new Error("stale refresh"),
          },
        }),
      );

      expect(findAllByType(tree, InlineErrorChip)).toHaveLength(0);
    });
  });
});
