import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as upgrade-tab.test.js): hook state
// lives in per-call-index slots so component functions can be invoked
// directly without a DOM renderer. Effects are collected, not run.
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
  fetchOpenclawNotifications: vi.fn(),
  updateOpenclawNotifications: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import {
  UpdateNotificationsSection,
  WatchdogSettingsCard,
  kDefaultRoutingNote,
} from "../../lib/public/js/components/watchdog-tab/settings/index.js";
import { InfoTooltip } from "../../lib/public/js/components/info-tooltip.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";

const harness = preactHooks.__harness;

// Components whose render bodies need a real DOM (portals) — keep as vnodes.
const kSkipExpand = new Set([Tooltip, InfoTooltip]);

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function" && !kSkipExpand.has(node.type)) {
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

const treeText = (tree) => collectText(tree).join(" ");

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const findButtonByText = (tree, text) =>
  findAllByType(tree, "button").find((vnode) =>
    collectText(vnode).join(" ").includes(text),
  );

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const renderSection = (props = {}) => {
  harness.beginRender();
  return expandTree(UpdateNotificationsSection(props));
};

const hydrateSection = async (props = {}) => {
  renderSection(props);
  // Run the load effect (without its cleanup), then re-render loaded state.
  harness.effects[0]?.();
  await flushAsync();
  return renderSection(props);
};

describe("frontend/watchdog update-notification settings", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    api.fetchOpenclawNotifications.mockResolvedValue({
      ok: true,
      notifications: { preferredChannel: null, adminTargets: [] },
    });
  });

  it("explains the default routing when no admin targets are set", async () => {
    const tree = await hydrateSection();

    const text = treeText(tree);
    expect(text).toContain("Update notifications");
    expect(text).toContain(kDefaultRoutingNote);
    expect(kDefaultRoutingNote).toContain(
      "notify every paired user on every channel (default)",
    );
    // Channel-specific target help.
    expect(text).toContain("telegram = chat id");
    expect(text).toContain("slack = user/channel id");
    expect(text).toContain("discord = user id");
    expect(text).toContain("whatsapp = number");
  });

  it("offers all four channels plus none in the preferred-channel select", async () => {
    const tree = await hydrateSection();

    const selects = findAllByType(tree, "select");
    expect(selects.length).toBe(1);
    const optionValues = findAllByType(selects[0], "option").map(
      (vnode) => vnode.props.value,
    );
    expect(optionValues).toEqual([
      "",
      "telegram",
      "slack",
      "discord",
      "whatsapp",
    ]);
  });

  it("renders loaded targets with editable rows and a remove control", async () => {
    api.fetchOpenclawNotifications.mockResolvedValue({
      ok: true,
      notifications: {
        preferredChannel: "slack",
        adminTargets: [
          { channel: "slack", target: "U123", accountId: "work" },
        ],
      },
    });
    const tree = await hydrateSection();

    const inputs = findAllByType(tree, "input");
    expect(inputs.map((vnode) => vnode.props.value)).toEqual(["U123", "work"]);
    expect(findButtonByText(tree, "Remove")).toBeTruthy();
    expect(treeText(tree)).not.toContain(kDefaultRoutingNote);
  });

  it("adds a target row via Add target", async () => {
    let tree = await hydrateSection();

    findButtonByText(tree, "Add target").props.onclick();
    tree = renderSection();

    const rowSelects = findAllByType(tree, "select");
    // preferred-channel select + the new row's channel select
    expect(rowSelects.length).toBe(2);
    expect(treeText(tree)).not.toContain(kDefaultRoutingNote);
  });

  it("saves via PUT with trimmed targets and empty rows dropped", async () => {
    api.fetchOpenclawNotifications.mockResolvedValue({
      ok: true,
      notifications: {
        preferredChannel: "telegram",
        adminTargets: [
          { channel: "telegram", target: " 12345 ", accountId: "" },
          { channel: "discord", target: "", accountId: "" },
        ],
      },
    });
    api.updateOpenclawNotifications.mockResolvedValue({
      ok: true,
      notifications: {
        preferredChannel: "telegram",
        adminTargets: [{ channel: "telegram", target: "12345", accountId: null }],
      },
    });
    const tree = await hydrateSection();

    await findButtonByText(tree, "Save").props.onclick();

    expect(api.updateOpenclawNotifications).toHaveBeenCalledWith({
      preferredChannel: "telegram",
      adminTargets: [{ channel: "telegram", target: "12345", accountId: null }],
    });
    expect(showToast).toHaveBeenCalledWith(
      "Update notification settings saved",
      "success",
    );
  });

  it("surfaces save failures as an error toast", async () => {
    api.updateOpenclawNotifications.mockRejectedValue(
      new Error("Store not available"),
    );
    const tree = await hydrateSection();

    await findButtonByText(tree, "Save").props.onclick();

    expect(showToast).toHaveBeenCalledWith("Store not available", "error");
  });

  it("relocates the test-notification button next to the section", () => {
    harness.beginRender();
    const tree = expandTree(
      WatchdogSettingsCard({
        settings: { autoRepair: false, notificationsEnabled: true },
      }),
    );

    // The Test button now renders inside the Update notifications section
    // (passed through as testButton), not in the kill-switch row.
    const section = findAllByType(tree, UpdateNotificationsSection)[0];
    expect(section).toBeTruthy();
    const testButton = findButtonByText(section, "Test");
    expect(testButton).toBeTruthy();
  });
});
