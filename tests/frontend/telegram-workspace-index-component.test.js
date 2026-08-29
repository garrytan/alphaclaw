import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component tests): state
// lives in per-call-index slots, effects are collected without running.
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

vi.mock("../../lib/public/js/lib/telegram-api.js", () => ({
  verifyBot: vi.fn(),
  workspace: vi.fn(),
  resetWorkspace: vi.fn(),
  verifyGroup: vi.fn(),
  listTopics: vi.fn(),
  createTopicsBulk: vi.fn(),
  deleteTopic: vi.fn(),
  updateTopic: vi.fn(),
  configureGroup: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchAgents: vi.fn(),
  getTelegramTopics: vi.fn(),
  restoreTelegramTopic: vi.fn(),
  verifyTelegramTopic: vi.fn(),
  sweepTopicDiscovery: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import { TelegramWorkspace } from "../../lib/public/js/components/telegram-workspace/index.js";
import { ManageTelegramWorkspace } from "../../lib/public/js/components/telegram-workspace/manage.js";
import * as api from "../../lib/public/js/lib/telegram-api.js";
import * as preactHooks from "preact/hooks";

const harness = preactHooks.__harness;

// useState/useRef call order in TelegramWorkspace (see component source).
const kStepSlot = 0;
const kWorkspaceConfigSlot = 7;
const kBootstrapErrorSlot = 8;
const kBootstrapAttemptSlot = 9;

const collectText = (vnode, out = []) => {
  if (vnode == null || vnode === false || vnode === true) return out;
  if (typeof vnode === "string" || typeof vnode === "number") {
    out.push(String(vnode));
    return out;
  }
  if (Array.isArray(vnode)) {
    for (const child of vnode) collectText(child, out);
    return out;
  }
  if (typeof vnode.type === "function") {
    try {
      collectText(vnode.type(vnode.props || {}), out);
    } catch {}
  }
  if (vnode.props) collectText(vnode.props.children, out);
  return out;
};

const renderToText = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");

const collectNodes = (vnode, out = []) => {
  if (vnode == null || typeof vnode !== "object") return out;
  if (Array.isArray(vnode)) {
    for (const child of vnode) collectNodes(child, out);
    return out;
  }
  out.push(vnode);
  if (typeof vnode.type === "function") {
    // Expand nested function components (InlineErrorChip, ...) so their
    // buttons are findable. Hook-using children are tolerated best-effort.
    try {
      collectNodes(vnode.type(vnode.props || {}), out);
    } catch {}
  }
  if (vnode.props) collectNodes(vnode.props.children, out);
  return out;
};

const findButtonByText = (tree, text) =>
  collectNodes(tree).find(
    (vnode) =>
      vnode.type === "button" && collectText(vnode).join(" ").includes(text),
  );

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const renderWorkspace = () => {
  harness.beginRender();
  return TelegramWorkspace({ accountId: "default", onBack: () => {} });
};

// Effect order: [0] persist onboarding state, [1] bootstrap GET.
const runBootstrapEffect = () => harness.effects[1]();

describe("frontend/telegram-workspace index component", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    api.workspace.mockResolvedValue({ ok: true, configured: false, groups: [] });
    api.resetWorkspace.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    harness.reset();
  });

  it("replaces the loading shell with an error and Retry when bootstrap fails, then recovers", async () => {
    api.workspace.mockRejectedValueOnce(new Error("network down"));

    let tree = renderWorkspace();
    expect(renderToText(tree)).toContain("Loading workspace...");

    runBootstrapEffect();
    await flushAsync();

    tree = renderWorkspace();
    const text = renderToText(tree);
    expect(text).toContain("Couldn't load your Telegram workspace.");
    expect(text).toContain("network down");
    expect(text).not.toContain("Loading workspace...");

    const retryButton = findButtonByText(tree, "Retry");
    expect(retryButton).toBeTruthy();
    retryButton.props.onclick();
    expect(harness.slots[kBootstrapErrorSlot]).toBe(null);
    expect(harness.slots[kBootstrapAttemptSlot]).toBe(1);

    api.workspace.mockResolvedValue({
      ok: true,
      configured: true,
      groups: [{ groupId: "-100", groupName: "HQ", topics: {} }],
      debugEnabled: false,
      concurrency: null,
    });
    renderWorkspace();
    runBootstrapEffect();
    await flushAsync();

    expect(harness.slots[kWorkspaceConfigSlot].ready).toBe(true);
    expect(harness.slots[kWorkspaceConfigSlot].configured).toBe(true);
    expect(renderToText(renderWorkspace())).toContain(
      "Manage Telegram Workspace",
    );
  });

  it("treats an ok:false bootstrap payload as a failure, not a permanent shell", async () => {
    api.workspace.mockResolvedValueOnce({ ok: false, error: "gateway sad" });

    renderWorkspace();
    runBootstrapEffect();
    await flushAsync();

    expect(harness.slots[kBootstrapErrorSlot]).toBe("gateway sad");
    const text = renderToText(renderWorkspace());
    expect(text).toContain("Couldn't load your Telegram workspace.");
  });

  it("discards a stale bootstrap response that lands after reset-onboarding", async () => {
    let resolveWorkspace;
    api.workspace.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWorkspace = resolve;
        }),
    );

    renderWorkspace();
    runBootstrapEffect(); // mount GET in flight

    // Make the manage view reachable so onResetOnboarding can be invoked.
    harness.slots[kWorkspaceConfigSlot] = {
      ready: true,
      configured: true,
      groups: [{ groupId: "-100", groupName: "HQ", topics: {} }],
      groupId: "-100",
      groupName: "HQ",
      topics: {},
      debugEnabled: true,
      concurrency: { agentMaxConcurrent: null, subagentMaxConcurrent: null },
    };
    const tree = renderWorkspace();
    const manageVNode = collectNodes(tree).find(
      (vnode) => vnode.type === ManageTelegramWorkspace,
    );
    expect(manageVNode).toBeTruthy();

    await manageVNode.props.onResetOnboarding("keep");
    expect(harness.slots[kWorkspaceConfigSlot].configured).toBe(false);
    expect(harness.slots[kStepSlot]).toBe(0);

    // The pre-reset GET resolves late with configured:true — must be ignored.
    resolveWorkspace({
      ok: true,
      configured: true,
      groups: [{ groupId: "-100", groupName: "HQ", topics: { 9: { name: "Zombie" } } }],
      debugEnabled: false,
    });
    await flushAsync();

    expect(harness.slots[kWorkspaceConfigSlot].configured).toBe(false);
    expect(harness.slots[kStepSlot]).toBe(0);
  });
});
