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

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import { VerifyBotStep } from "../../lib/public/js/components/telegram-workspace/onboarding.js";
import * as api from "../../lib/public/js/lib/telegram-api.js";
import * as preactHooks from "preact/hooks";

const harness = preactHooks.__harness;

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

const renderStep = (props = {}) => {
  harness.beginRender();
  return VerifyBotStep({
    accountId: "default",
    botInfo: null,
    setBotInfo: () => {},
    onNext: () => {},
    ...props,
  });
};

describe("frontend/telegram-workspace onboarding VerifyBotStep", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    harness.reset();
  });

  it("shows the checking indicator while the verify request is in flight", async () => {
    let resolveVerify;
    api.verifyBot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVerify = resolve;
        }),
    );
    const setBotInfo = vi.fn();

    renderStep({ setBotInfo });
    harness.effects[0](); // mount verify: loading is set synchronously

    expect(renderToText(renderStep({ setBotInfo }))).toContain(
      "Checking bot token...",
    );

    resolveVerify({ ok: true, bot: { username: "opsbot", first_name: "Ops" } });
    await flushAsync();
    expect(setBotInfo).toHaveBeenCalledWith({
      username: "opsbot",
      first_name: "Ops",
    });
    expect(renderToText(renderStep({ setBotInfo }))).not.toContain(
      "Checking bot token...",
    );
  });

  it("offers Check again alongside the error state and retries the verify", async () => {
    api.verifyBot.mockRejectedValueOnce(new Error("bad token"));
    const setBotInfo = vi.fn();

    renderStep({ setBotInfo });
    harness.effects[0]();
    await flushAsync();

    const tree = renderStep({ setBotInfo });
    const text = renderToText(tree);
    expect(text).toContain("bad token");
    const retryButton = findButtonByText(tree, "Check again");
    expect(retryButton).toBeTruthy();

    api.verifyBot.mockResolvedValueOnce({
      ok: true,
      bot: { username: "opsbot", first_name: "Ops" },
    });
    await retryButton.props.onclick();

    expect(api.verifyBot).toHaveBeenCalledTimes(2);
    expect(setBotInfo).toHaveBeenCalledWith({
      username: "opsbot",
      first_name: "Ops",
    });
    // The failed-state error is cleared by the successful retry.
    expect(harness.slots[1]).toBe(null);
  });
});
