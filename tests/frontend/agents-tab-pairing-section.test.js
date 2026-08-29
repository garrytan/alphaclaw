import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component): hook state lives
// in per-call-index slots so components can be invoked directly without a DOM
// renderer. Effects are collected, not run.
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
  approvePairing: vi.fn(),
  fetchAgentBindings: vi.fn(),
  fetchChannelAccounts: vi.fn(),
  fetchPairings: vi.fn(),
  rejectPairing: vi.fn(),
}));

vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: vi.fn(),
}));

vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { usePolling } from "../../lib/public/js/hooks/usePolling.js";
import { AgentPairingSection } from "../../lib/public/js/components/agents-tab/agent-pairing-section.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { Pairings } from "../../lib/public/js/components/pairings.js";

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

const kBindingsKey = "/api/agents/a1/bindings";
const kChannelsKey = "/api/channels/accounts";

// Per-key state consumed by the useCachedFetch mock.
const cachedFetchState = new Map();
const setFetchState = (key, state) =>
  cachedFetchState.set(key, {
    data: null,
    error: null,
    loading: false,
    refresh: vi.fn(async () => cachedFetchState.get(key)?.data),
    ...state,
  });

const kOwnedBindings = {
  bindings: [{ match: { channel: "telegram", accountId: "default" } }],
};
const kOwnedChannels = {
  channels: [
    {
      channel: "telegram",
      accounts: [{ id: "default", status: "configured", boundAgentId: "a1" }],
    },
  ],
};

const renderSection = () => {
  harness.beginRender();
  return expandTree(AgentPairingSection({ agent: { id: "a1" } }));
};

describe("frontend/agents-tab pairing section", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    cachedFetchState.clear();
    global.window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    useCachedFetch.mockImplementation(
      (key) =>
        cachedFetchState.get(String(key)) || {
          data: null,
          error: null,
          loading: false,
          refresh: vi.fn(),
        },
    );
    usePolling.mockReturnValue({ data: [], refresh: vi.fn(), isPolling: false });
    setFetchState(kBindingsKey, { data: kOwnedBindings });
    setFetchState(kChannelsKey, { data: kOwnedChannels });
  });

  it("renders a retryable error card instead of vanishing when the load fails with no data", () => {
    setFetchState(kBindingsKey, { data: null, error: new Error("bindings down") });

    const tree = renderSection();
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips).toHaveLength(1);
    expect(chips[0].props.headline).toBe("Couldn't load pairing status.");

    chips[0].props.onRetry();
    expect(cachedFetchState.get(kBindingsKey).refresh).toHaveBeenCalledWith({
      force: true,
    });
    expect(cachedFetchState.get(kChannelsKey).refresh).toHaveBeenCalledWith({
      force: true,
    });
  });

  it("keeps last-known-good data rendered when a refresh fails", () => {
    setFetchState(kBindingsKey, {
      data: kOwnedBindings,
      error: new Error("refresh failed"),
    });

    const tree = renderSection();
    expect(findAllByType(tree, Pairings)).toHaveLength(1);
    expect(findAllByType(tree, InlineErrorChip)).toHaveLength(0);
  });

  it("propagates approve failures to the row (which owns the inline chip) — no duplicate section chip", async () => {
    const pendingPairing = {
      id: "p1",
      channel: "telegram",
      accountId: "default",
      code: "1234",
    };
    usePolling.mockReturnValue({
      data: [pendingPairing],
      refresh: vi.fn(),
      isPolling: false,
    });
    api.approvePairing.mockRejectedValueOnce(new Error("approve failed"));

    let tree = renderSection();
    const pairings = findAllByType(tree, Pairings)[0];
    // The rejection MUST propagate: PairingRow catches it, resets its busy
    // state, and renders the per-row chip (tested in
    // pairings-row-component.test.js). A second section-level chip for the
    // same failure would double the surface.
    await expect(
      pairings.props.onApprove("p1", "telegram", "default"),
    ).rejects.toThrow("approve failed");

    tree = renderSection();
    expect(findAllByType(tree, InlineErrorChip)).toHaveLength(0);
  });

  it("propagates reject failures to the row — no duplicate section chip", async () => {
    usePolling.mockReturnValue({
      data: [{ id: "p2", channel: "telegram", accountId: "default" }],
      refresh: vi.fn(),
      isPolling: false,
    });
    api.rejectPairing.mockRejectedValueOnce(new Error("reject failed"));

    let tree = renderSection();
    const pairings = findAllByType(tree, Pairings)[0];
    await expect(
      pairings.props.onReject("p2", "telegram", "default"),
    ).rejects.toThrow("reject failed");

    tree = renderSection();
    expect(findAllByType(tree, InlineErrorChip)).toHaveLength(0);
  });
});
