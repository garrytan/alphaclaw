import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as models-tab-model-picker-component
// tests): the component function is invoked directly, state lives in
// per-call-index slots, and effects are collected without running — so no
// fetches fire.
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
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useEffect, __harness: harness };
});

import { ManageTelegramWorkspace } from "../../lib/public/js/components/telegram-workspace/manage.js";
import * as preactHooks from "preact/hooks";

const harness = preactHooks.__harness;

// useState call order in ManageTelegramWorkspace (see component source).
const kRegistryRowsSlot = 15;
const kRegistryDiscoverySlot = 16;
const kRegistryErrorSlot = 17;
const kShowDeletedSlot = 18;

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
});
