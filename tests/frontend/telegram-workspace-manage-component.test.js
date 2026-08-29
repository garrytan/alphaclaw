import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as models-tab-model-picker-component
// tests): the component function is invoked directly, state lives in
// per-call-index slots, and effects are collected without running — tests
// that need the mount fetches invoke harness.effects manually.
vi.mock("preact/hooks", () => {
  const harness = {
    slots: [],
    cursor: 0,
    effects: [],
  };
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
  listTopics: vi.fn(),
  createTopicsBulk: vi.fn(),
  deleteTopic: vi.fn(),
  updateTopic: vi.fn(),
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

import { ManageTelegramWorkspace } from "../../lib/public/js/components/telegram-workspace/manage.js";
import { ConfirmDialog } from "../../lib/public/js/components/confirm-dialog.js";
import * as telegramApi from "../../lib/public/js/lib/telegram-api.js";
import * as api from "../../lib/public/js/lib/api.js";
import * as preactHooks from "preact/hooks";

const harness = preactHooks.__harness;

// useState call order in ManageTelegramWorkspace (see component source).
const kTopicsSlot = 0;
const kDeletingSlot = 6;
const kEditingTopicIdSlot = 7;
const kEditingTopicNameSlot = 8;
const kErrorSlot = 12;
const kDeleteTopicConfirmSlot = 13;
const kRegistryRowsSlot = 15;
const kRegistryDiscoverySlot = 16;
const kRegistryErrorSlot = 17;
const kShowDeletedSlot = 18;
const kTopicsErrorSlot = 26;
const kEditSaveErrorSlot = 27;

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
    // Expand nested function components (Badge, TopicHealthCell, ...) so
    // their text is visible. Hook-using children are tolerated best-effort.
    try {
      collectText(vnode.type(vnode.props || {}), out);
    } catch {}
  }
  if (vnode.props) {
    collectText(vnode.props.children, out);
  }
  return out;
};

const renderToText = (tree) =>
  collectText(tree).join(" ").replace(/\s+/g, " ");

const collectNodes = (vnode, out = []) => {
  if (vnode == null || typeof vnode !== "object") return out;
  if (Array.isArray(vnode)) {
    for (const child of vnode) collectNodes(child, out);
    return out;
  }
  out.push(vnode);
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

const renderManage = (props = {}) => {
  harness.beginRender();
  return ManageTelegramWorkspace({
    accountId: "alerts",
    groupId: "-100123",
    groupName: "Ops HQ",
    initialTopics: { 42: { name: "Ops" } },
    debugEnabled: false,
    onResetOnboarding: () => {},
    ...props,
  });
};

describe("frontend/telegram-workspace manage component", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    telegramApi.listTopics.mockResolvedValue({
      ok: true,
      topics: { 42: { name: "Ops" } },
    });
    telegramApi.deleteTopic.mockResolvedValue({ ok: true });
    telegramApi.updateTopic.mockResolvedValue({ ok: true });
    api.getTelegramTopics.mockResolvedValue({
      ok: true,
      topics: [],
      discovery: null,
    });
    api.fetchAgents.mockResolvedValue({ agents: [] });
    api.verifyTelegramTopic.mockResolvedValue({ ok: true, status: "ok" });
  });

  afterEach(() => {
    harness.reset();
  });

  it("renders the base table without registry data", () => {
    const tree = renderManage();
    const text = renderToText(tree);

    expect(text).toContain("Existing Topics");
    expect(text).toContain("Ops");
    expect(text).not.toContain("Health");
    expect(text).not.toContain("Deleted topics");
  });

  it("renders badges, health, discovered, deleted, and discovery sections from registry rows", () => {
    renderManage();
    const nowMs = Date.now();
    harness.slots[kRegistryRowsSlot] = [
      {
        groupId: "-100123",
        threadId: "42",
        name: "Ops",
        stale: true,
        accountId: null,
        lastSeenAt: nowMs - 31 * 24 * 60 * 60 * 1000,
        seenAgentId: "main",
      },
      {
        groupId: "-100123",
        threadId: "77",
        name: "",
        discovered: true,
        accountId: "alerts",
        lastSeenAt: nowMs - 60 * 1000,
      },
      {
        groupId: "-100123",
        threadId: "99",
        name: "Old room",
        deleted: true,
        deletedAt: nowMs - 1000,
      },
    ];
    harness.slots[kShowDeletedSlot] = true;
    harness.slots[kRegistryDiscoverySlot] = {
      enabled: true,
      running: true,
      lastSweepAt: nowMs - 10 * 60 * 1000,
      lastResult: { discovered: 1, named: 0 },
    };

    const tree = renderManage();
    const text = renderToText(tree);

    expect(text).toContain("Health");
    expect(text).toContain("stale");
    expect(text).toContain("Verify now");
    expect(text).toContain("no account attributed");
    expect(text).toContain("seen by agent main");
    expect(text).toContain("Discovered Topics");
    expect(text).toContain("thread 77");
    expect(text).toContain("Deleted topics ( 1 )");
    expect(text).toContain("Old room");
    expect(text).toContain("Restore");
    expect(text).toContain("Topic discovery is on");
    expect(text).toContain("Sweep now");
  });

  it("renders the non-dismissable banner for unreadable registry states", () => {
    renderManage();
    harness.slots[kRegistryErrorSlot] = {
      code: "TOPIC_REGISTRY_UNREADABLE",
      title: "Topic registry is unreadable",
      text: "registry file is corrupt",
    };

    const tree = renderManage();
    const text = renderToText(tree);

    expect(text).toContain("Topic registry is unreadable");
    expect(text).toContain("registry file is corrupt");
  });

  it("never clobbers child-fetched topics with a stale parent snapshot prop", async () => {
    const freshTopics = { 42: { name: "Ops" }, 43: { name: "Fresh" } };
    telegramApi.listTopics.mockResolvedValue({ ok: true, topics: freshTopics });

    renderManage({ initialTopics: { 42: { name: "Ops" } } });
    for (const effect of [...harness.effects]) effect();
    await flushAsync();
    expect(harness.slots[kTopicsSlot]).toEqual(freshTopics);

    // Parent re-renders with a stale snapshot prop; running the collected
    // effects must not synchronously overwrite the child's server truth
    // (the old snapshot effect did exactly that).
    renderManage({ initialTopics: { 42: { name: "Ops (stale)" } } });
    for (const effect of [...harness.effects]) effect();
    expect(harness.slots[kTopicsSlot]).toEqual(freshTopics);
    await flushAsync();
    expect(harness.slots[kTopicsSlot]).toEqual(freshTopics);
  });

  it("discards stale listTopics responses (latest request wins)", async () => {
    const resolvers = [];
    telegramApi.listTopics.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );

    renderManage();
    const loadEffect = harness.effects[0];
    loadEffect();
    loadEffect();
    expect(resolvers).toHaveLength(2);

    resolvers[1]({ ok: true, topics: { 7: { name: "Newest" } } });
    await flushAsync();
    resolvers[0]({ ok: true, topics: { 7: { name: "Stale" } } });
    await flushAsync();

    expect(harness.slots[kTopicsSlot]).toEqual({ 7: { name: "Newest" } });
  });

  it("keeps optimistic verify results when a pre-mutation registry refetch lands late", async () => {
    const staleRow = {
      groupId: "-100123",
      threadId: "42",
      name: "Ops",
      stale: true,
    };
    const registryResolvers = [];
    api.getTelegramTopics.mockImplementation(
      () => new Promise((resolve) => registryResolvers.push(resolve)),
    );

    renderManage();
    harness.slots[kRegistryRowsSlot] = [staleRow];
    const tree = renderManage();
    // Registry refetch starts before the mutation...
    harness.effects[0]();

    const verifyButton = findButtonByText(tree, "Verify now");
    expect(verifyButton).toBeTruthy();
    await verifyButton.props.onclick();
    expect(harness.slots[kRegistryRowsSlot][0].stale).toBe(false);

    // ...and resolves after it with the pre-mutation snapshot: discarded.
    registryResolvers[0]({ ok: true, topics: [staleRow], discovery: null });
    await flushAsync();
    expect(harness.slots[kRegistryRowsSlot][0].stale).toBe(false);
  });

  it("shows an inline error with retry when loadTopics fails, never a confident empty state", async () => {
    telegramApi.listTopics.mockResolvedValue({ ok: false, error: "nope" });

    renderManage({ initialTopics: {} });
    harness.effects[0]();
    await flushAsync();

    expect(harness.slots[kTopicsErrorSlot]).toBe("nope");
    const text = renderToText(renderManage({ initialTopics: {} }));
    expect(text).toContain("Couldn't load topics.");
    expect(text).toContain("nope");
    expect(text).not.toContain("No topics yet.");
  });

  it("surfaces registry load failures via the registry error banner", async () => {
    api.getTelegramTopics.mockRejectedValue(new Error("io fail"));

    renderManage();
    harness.effects[0]();
    await flushAsync();

    expect(harness.slots[kRegistryErrorSlot]).toMatchObject({
      title: "Topic registry could not be loaded",
      text: "io fail",
    });
    const text = renderToText(renderManage());
    expect(text).toContain("Topic registry could not be loaded");
    expect(text).toContain("io fail");
  });

  it("shows Saving... on the edit-row save button and renders save errors inline", async () => {
    let rejectUpdate;
    telegramApi.updateTopic.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpdate = reject;
        }),
    );

    renderManage();
    harness.slots[kEditingTopicIdSlot] = "42";
    harness.slots[kEditingTopicNameSlot] = "Ops2";
    let tree = renderManage();

    const saveButton = findButtonByText(tree, "Save");
    const savePromise = saveButton.props.onclick();
    tree = renderManage();
    expect(renderToText(tree)).toContain("Saving...");

    rejectUpdate(new Error("boom"));
    await savePromise;
    await flushAsync();

    expect(harness.slots[kEditSaveErrorSlot]).toBe("boom");
    expect(harness.slots[kErrorSlot]).toBe(null);
    const text = renderToText(renderManage());
    expect(text).toContain("Couldn't save this topic.");
    expect(text).toContain("boom");
  });

  it("keeps the delete-topic confirm dialog open (loading) until the delete resolves", async () => {
    let resolveDelete;
    telegramApi.deleteTopic.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );

    renderManage();
    harness.slots[kDeleteTopicConfirmSlot] = { id: "42", name: "Ops" };
    const tree = renderManage();
    const deleteDialog = collectNodes(tree).find(
      (vnode) =>
        vnode.type === ConfirmDialog && vnode.props?.title === "Delete topic?",
    );
    expect(deleteDialog).toBeTruthy();

    const confirmPromise = deleteDialog.props.onConfirm();
    // Pending: the dialog stays visible with its loading state.
    expect(harness.slots[kDeleteTopicConfirmSlot]).toEqual({
      id: "42",
      name: "Ops",
    });
    expect(harness.slots[kDeletingSlot]).toBe("42");

    resolveDelete({ ok: true });
    await confirmPromise;

    expect(harness.slots[kDeleteTopicConfirmSlot]).toBe(null);
    expect(harness.slots[kDeletingSlot]).toBe(null);
  });
});
