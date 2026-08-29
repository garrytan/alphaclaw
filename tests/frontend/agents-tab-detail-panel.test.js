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

// channels.js transitively imports channel-login-modal, which uses CDN URL
// imports the node ESM loader can't resolve.
vi.mock("../../lib/public/js/components/channels.js", () => ({
  ALL_CHANNELS: ["telegram", "discord", "slack", "whatsapp"],
  ChannelsCard: () => null,
  getChannelMeta: (id) => ({ label: String(id || "") }),
}));

import * as preactHooks from "preact/hooks";
import { AgentDetailPanel } from "../../lib/public/js/components/agents-tab/agent-detail-panel.js";
import { AgentToolsPanel } from "../../lib/public/js/components/agents-tab/agent-tools/index.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

const harness = preactHooks.__harness;

// Shallow expand: only walk vnode props (no function-component rendering) so
// the deep Overview/Tools trees stay unexpanded and we can assert on props.
const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  return out;
};

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const makeDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const kAgent = {
  id: "main",
  name: "Main",
  default: true,
  tools: { profile: "full" },
};

describe("frontend/agents-tab detail panel", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  it("locks the tools panel while a tools save is in flight", async () => {
    const deferred = makeDeferred();
    const onUpdateAgent = vi.fn(() => deferred.promise);
    const render = () => {
      harness.beginRender();
      return AgentDetailPanel({
        agent: kAgent,
        agents: [kAgent],
        activeTab: "tools",
        saving: false,
        onUpdateAgent,
      });
    };

    let tree = render();
    let toolsPanel = findAllByType(tree, AgentToolsPanel)[0];
    expect(toolsPanel.props.disabled).toBe(false);

    const saveButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Save changes",
    );
    const savePromise = saveButton.props.onClick();

    tree = render();
    toolsPanel = findAllByType(tree, AgentToolsPanel)[0];
    // Edits made mid-save would be rebased away when the response is adopted.
    expect(toolsPanel.props.disabled).toBe(true);

    deferred.resolve({ ...kAgent, tools: { profile: "full" } });
    await savePromise;

    tree = render();
    toolsPanel = findAllByType(tree, AgentToolsPanel)[0];
    expect(toolsPanel.props.disabled).toBe(false);
  });

  it("unlocks the tools panel when the save fails", async () => {
    const onUpdateAgent = vi.fn().mockRejectedValue(new Error("save failed"));
    const render = () => {
      harness.beginRender();
      return AgentDetailPanel({
        agent: kAgent,
        agents: [kAgent],
        activeTab: "tools",
        saving: false,
        onUpdateAgent,
      });
    };

    let tree = render();
    const saveButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Save changes",
    );
    await saveButton.props.onClick();

    tree = render();
    const toolsPanel = findAllByType(tree, AgentToolsPanel)[0];
    expect(toolsPanel.props.disabled).toBe(false);
  });
});
