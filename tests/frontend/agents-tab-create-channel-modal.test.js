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
  fetchChannelAccountToken: vi.fn(),
  fetchOpenclawCapabilities: vi.fn(async () => ({ capabilities: {} })),
}));

vi.mock("../../lib/public/js/lib/clipboard.js", () => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock("../../lib/public/js/components/channels.js", () => ({
  ALL_CHANNELS: ["telegram", "discord", "slack", "whatsapp"],
  getChannelMeta: (id) => ({
    label: String(id || "").charAt(0).toUpperCase() + String(id || "").slice(1),
  }),
}));

import * as preactHooks from "preact/hooks";
import { fetchChannelAccountToken } from "../../lib/public/js/lib/api.js";
import { CreateChannelModal } from "../../lib/public/js/components/agents-tab/create-channel-modal.js";

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

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// htm/preact lowercases DOM event props (onInput -> oninput).
const getOnInput = (vnode) => vnode.props?.oninput || vnode.props?.onInput;

const findNameInput = (tree) =>
  collectNodes(tree).find(
    (vnode) =>
      vnode.type === "input" &&
      vnode.props?.type === "text" &&
      !vnode.props?.readOnly &&
      typeof getOnInput(vnode) === "function",
  );

const renderModal = (props) => {
  harness.beginRender();
  return expandTree(CreateChannelModal(props));
};

const runEffects = () => {
  for (const effect of harness.effects) effect?.();
};

describe("frontend/agents-tab create channel modal", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    // ModalShell's escape-key effect touches window when runEffects() fires.
    global.window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    fetchChannelAccountToken.mockResolvedValue({ token: "tok", appToken: "" });
  });

  it("does not reset an open form when background refreshes swap list identities", () => {
    const baseProps = {
      visible: true,
      agents: [{ id: "a1", name: "Main" }],
      existingChannels: [],
      initialAgentId: "a1",
      initialProvider: "telegram",
    };
    let tree = renderModal(baseProps);
    runEffects();
    tree = renderModal(baseProps);
    expect(findNameInput(tree).props.value).toBe("Telegram");

    // User edits the name.
    getOnInput(findNameInput(tree))({ target: { value: "My Bot" } });
    tree = renderModal(baseProps);
    expect(findNameInput(tree).props.value).toBe("My Bot");

    // Background refresh: new array identities (and even new accounts) arrive.
    const refreshedProps = {
      ...baseProps,
      agents: [{ id: "a1", name: "Main" }, { id: "a2", name: "Second" }],
      existingChannels: [
        { channel: "telegram", accounts: [{ id: "default", name: "Other" }] },
      ],
    };
    tree = renderModal(refreshedProps);
    runEffects();
    tree = renderModal(refreshedProps);
    expect(findNameInput(tree).props.value).toBe("My Bot");
  });

  it("re-initializes when the modal closes and reopens", () => {
    const baseProps = {
      visible: true,
      agents: [{ id: "a1", name: "Main" }],
      existingChannels: [],
      initialAgentId: "a1",
      initialProvider: "telegram",
    };
    let tree = renderModal(baseProps);
    runEffects();
    tree = renderModal(baseProps);
    getOnInput(findNameInput(tree))({ target: { value: "Draft name" } });

    renderModal({ ...baseProps, visible: false });
    runEffects();
    tree = renderModal(baseProps);
    runEffects();
    tree = renderModal(baseProps);
    expect(findNameInput(tree).props.value).toBe("Telegram");
  });

  it("shows an inline note when the token prefill fails in edit mode", async () => {
    fetchChannelAccountToken.mockRejectedValue(new Error("secrets locked"));
    const editProps = {
      visible: true,
      mode: "edit",
      account: {
        provider: "telegram",
        id: "default",
        name: "Bot",
        ownerAgentId: "a1",
        token: "****",
      },
      agents: [{ id: "a1", name: "Main" }],
      existingChannels: [
        { channel: "telegram", accounts: [{ id: "default", name: "Bot" }] },
      ],
      initialAgentId: "a1",
      initialProvider: "telegram",
    };

    let tree = renderModal(editProps);
    runEffects();
    await flushAsync();
    tree = renderModal(editProps);

    const text = collectText(tree).join(" ");
    expect(text).toContain(
      "Could not load current token — leaving it blank keeps the",
    );
  });

  it("shows no token note when the prefill succeeds", async () => {
    const editProps = {
      visible: true,
      mode: "edit",
      account: {
        provider: "telegram",
        id: "default",
        name: "Bot",
        ownerAgentId: "a1",
        token: "****",
      },
      agents: [{ id: "a1", name: "Main" }],
      existingChannels: [
        { channel: "telegram", accounts: [{ id: "default", name: "Bot" }] },
      ],
      initialAgentId: "a1",
      initialProvider: "telegram",
    };

    let tree = renderModal(editProps);
    runEffects();
    await flushAsync();
    tree = renderModal(editProps);

    expect(collectText(tree).join(" ")).not.toContain(
      "Could not load current token",
    );
  });
});
