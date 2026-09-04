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
  fetchWatchdogSettings: vi.fn(),
  updateWatchdogSettings: vi.fn(),
  triggerWatchdogRepair: vi.fn(),
  triggerWatchdogTestNotification: vi.fn(),
  resumeWatchdogChannels: vi.fn(),
  fetchWatchdogMemorySettings: vi.fn(),
  updateWatchdogMemorySettings: vi.fn(),
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
import {
  buildTestNotificationOutcome,
  formatTestNotificationFailure,
} from "../../lib/public/js/components/watchdog-tab/settings/test-notification.js";
import { InfoTooltip } from "../../lib/public/js/components/info-tooltip.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
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

  it("renders the editor frame with disabled controls while loading — never a hostage", () => {
    api.fetchOpenclawNotifications.mockReturnValue(new Promise(() => {}));
    const tree = renderSection();

    const text = treeText(tree);
    expect(text).toContain("Loading...");
    const selects = findAllByType(tree, "select");
    expect(selects.length).toBe(1); // frame present pre-fetch
    expect(selects[0].props.disabled).toBe(true);
    expect(findButtonByText(tree, "Save").props.disabled).toBe(true);
    expect(findButtonByText(tree, "Add target").props.disabled).toBe(true);
    // The unknown default routing is not presented as fact mid-load.
    expect(text).not.toContain(kDefaultRoutingNote);
  });

  it("keeps the editor visible on load failure with an inline error + Retry", async () => {
    api.fetchOpenclawNotifications.mockRejectedValue(new Error("offline"));
    let tree = await hydrateSection();

    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(treeText(tree)).toContain("Couldn't load notification settings.");
    const selects = findAllByType(tree, "select");
    expect(selects.length).toBe(1); // editor frame still rendered
    expect(selects[0].props.disabled).toBe(true);
    expect(findButtonByText(tree, "Save").props.disabled).toBe(true);
    expect(treeText(tree)).not.toContain(kDefaultRoutingNote);

    // Retry re-runs the load and re-enables the controls.
    api.fetchOpenclawNotifications.mockResolvedValue({
      ok: true,
      notifications: { preferredChannel: "slack", adminTargets: [] },
    });
    chips[0].props.onRetry();
    tree = await hydrateSection();
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
    const reloadedSelect = findAllByType(tree, "select")[0];
    expect(reloadedSelect.props.disabled).toBe(false);
    expect(reloadedSelect.props.value).toBe("slack");
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

// WI-3.5: POST /api/watchdog/test-notification answers 502 {ok:false, error,
// result} when every channel failed; the card must list result.failures[]
// per channel/target/reason instead of a bare toast.
describe("frontend/watchdog test-notification outcome", () => {
  // Mirrors kTestNotificationNoChannels in lib/server/routes/watchdog.js.
  const kNoChannelsServerMessage =
    "No notification channel delivered the test message — nothing is configured or paired.";
  const kTelegramParseFailure = {
    channel: "telegram",
    target: "12345",
    reason: "Bad Request: can't parse entities",
    errorCode: 400,
    deterministic: true,
  };

  const renderCard = (props = {}) => {
    harness.beginRender();
    return expandTree(
      WatchdogSettingsCard({
        settings: { autoRepair: false, notificationsEnabled: true },
        ...props,
      }),
    );
  };

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    api.fetchOpenclawNotifications.mockReturnValue(new Promise(() => {}));
    api.fetchWatchdogMemorySettings.mockReturnValue(new Promise(() => {}));
  });

  it("builds the outcome model: 502 failures per channel/target/reason, success parts, no-channels", () => {
    const failed = buildTestNotificationOutcome({
      error: Object.assign(new Error("Test notification failed on every channel — telegram: …"), {
        status: 502,
        result: {
          ok: false,
          channels: { telegram: { sent: 0, failed: 1, skipped: false } },
          failures: [kTelegramParseFailure, { channel: "slack", reason: "channel_not_found" }],
        },
      }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.message).toBe("Test notification failed on every channel — telegram: …");
    expect(failed.failures).toEqual([
      {
        channel: "telegram",
        target: "12345",
        reason: "Bad Request: can't parse entities",
        errorCode: "400",
      },
      { channel: "slack", target: null, reason: "channel_not_found", errorCode: null },
    ]);
    expect(formatTestNotificationFailure(failed.failures[0])).toBe(
      "telegram (12345): Bad Request: can't parse entities [400]",
    );
    expect(formatTestNotificationFailure(failed.failures[1])).toBe("slack: channel_not_found");

    // A rejection without a preserved body still renders its message.
    expect(buildTestNotificationOutcome({ error: new Error("offline") })).toEqual(
      expect.objectContaining({ ok: false, message: "offline", failures: [] }),
    );

    const sent = buildTestNotificationOutcome({
      data: {
        ok: true,
        result: { channels: { telegram: { sent: 1, failed: 0 }, webhook: { sent: 1, failed: 0 } } },
      },
    });
    expect(sent).toEqual(
      expect.objectContaining({
        ok: true,
        hasFailures: false,
        message: "Test notification sent: telegram: 1 sent, webhook: 1 sent",
      }),
    );

    const partial = buildTestNotificationOutcome({
      data: {
        ok: true,
        result: {
          channels: { telegram: { sent: 1, failed: 0 }, slack: { sent: 0, failed: 1 } },
          failures: [{ channel: "slack", target: "C1", reason: "not_in_channel" }],
        },
      },
    });
    expect(partial.hasFailures).toBe(true);
    expect(partial.message).toBe(
      "Test notification partially delivered — telegram: 1 sent, slack: 1 failed",
    );
    expect(partial.failures).toHaveLength(1);

    // "Nothing configured" is a 502 (the notifier's verdict is `ok: sent > 0`,
    // reason no_channels_delivered, no failures) — the server's own message
    // is the single string; the model never invents a second one.
    const nothingConfigured = buildTestNotificationOutcome({
      error: Object.assign(new Error(kNoChannelsServerMessage), {
        status: 502,
        result: { ok: false, sent: 0, failed: 0, reason: "no_channels_delivered", failures: [], channels: {} },
      }),
    });
    expect(nothingConfigured).toEqual(
      expect.objectContaining({ ok: false, message: kNoChannelsServerMessage, failures: [], parts: [] }),
    );
    expect("noChannels" in nothingConfigured).toBe(false);
    // A 200 without per-channel counts (not a shape the server emits) still
    // honours the server's ok:true rather than claiming nothing is configured.
    expect(buildTestNotificationOutcome({ data: { ok: true, result: { channels: {} } } })).toEqual(
      expect.objectContaining({ ok: true, hasFailures: false, message: "Test notification sent" }),
    );
  });

  it("renders the 502 per-channel failures inline (channel, target, reason) — not a bare toast", async () => {
    api.triggerWatchdogTestNotification.mockRejectedValue(
      Object.assign(
        new Error(
          "Test notification failed on every channel — telegram: Bad Request: can't parse entities (400)",
        ),
        {
          status: 502,
          result: { ok: false, failures: [kTelegramParseFailure] },
        },
      ),
    );
    let tree = renderCard();
    await findButtonByText(tree, "Test").props.onClick();
    tree = renderCard();

    const text = treeText(tree);
    expect(text).toContain(
      "Test notification failed on every channel — telegram: Bad Request: can't parse entities (400)",
    );
    expect(text).toContain("telegram (12345): Bad Request: can't parse entities [400]");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("keeps the success path a toast; a partial delivery also lists the failed targets inline", async () => {
    api.triggerWatchdogTestNotification.mockResolvedValue({
      ok: true,
      result: { channels: { telegram: { sent: 1, failed: 0 } } },
    });
    let tree = renderCard();
    await findButtonByText(tree, "Test").props.onClick();
    tree = renderCard();
    expect(showToast).toHaveBeenCalledWith(
      "Test notification sent: telegram: 1 sent",
      "success",
    );
    expect(treeText(tree)).not.toContain("Bad Request");

    showToast.mockClear();
    api.triggerWatchdogTestNotification.mockResolvedValue({
      ok: true,
      result: {
        channels: { telegram: { sent: 1, failed: 0 }, slack: { sent: 0, failed: 1 } },
        failures: [{ channel: "slack", target: "C1", reason: "not_in_channel", errorCode: null }],
      },
    });
    tree = renderCard();
    await findButtonByText(tree, "Test").props.onClick();
    tree = renderCard();
    expect(showToast).toHaveBeenCalledWith(
      "Test notification partially delivered — telegram: 1 sent, slack: 1 failed",
      "warning",
    );
    expect(treeText(tree)).toContain("slack (C1): not_in_channel");
  });

  it("renders the nothing-configured 502 inline with the server's message — no toast, no invented string", async () => {
    api.triggerWatchdogTestNotification.mockRejectedValue(
      Object.assign(new Error(kNoChannelsServerMessage), {
        status: 502,
        result: { ok: false, sent: 0, failed: 0, reason: "no_channels_delivered", failures: [], channels: {} },
      }),
    );
    let tree = renderCard();
    await findButtonByText(tree, "Test").props.onClick();
    tree = renderCard();
    expect(treeText(tree)).toContain(kNoChannelsServerMessage);
    expect(treeText(tree)).not.toContain("No channels configured");
    expect(showToast).not.toHaveBeenCalled();
  });
});
