import { beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness (use-saved-setting.test.js pattern): hook state lives in
// per-call-index slots so hooks/components run without a DOM renderer.
// Effects are collected, not run — tests invoke them to model mount.
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
  fetchWatchdogSettings: vi.fn(),
  updateWatchdogSettings: vi.fn(),
  triggerWatchdogRepair: vi.fn(),
  resumeWatchdogChannels: vi.fn(),
  fetchOpenclawNotifications: vi.fn(),
  updateOpenclawNotifications: vi.fn(),
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
  describeAutoRepairSaveError,
  describeNotificationsSaveError,
  describeVerboseSaveError,
  kAutoRepairContext,
  kNotificationsContext,
  kNotificationsVerboseContext,
  kWatchdogSettingsCacheKey,
  kWatchdogMemoryCacheKey,
  kMemoryEnabledContext,
  kMemoryAutoRestartContext,
  useWatchdogSettings,
  useWatchdogMemorySettings,
} from "../../lib/public/js/components/watchdog-tab/settings/use-settings.js";
import { WatchdogSettingsCard } from "../../lib/public/js/components/watchdog-tab/settings/index.js";
import { SavedToggle } from "../../lib/public/js/components/saved-toggle.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { InfoTooltip } from "../../lib/public/js/components/info-tooltip.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";
import { invalidateCache } from "../../lib/public/js/lib/api-cache.js";

const harness = preactHooks.__harness;

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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// The settings-doc load effect is the FIRST effect useWatchdogSettings
// registers (useSavedSetting's [key, loadNonce] effect).
const renderHook = (options = {}) => {
  let latest;
  const render = () => {
    harness.beginRender();
    latest = useWatchdogSettings(options);
    return latest;
  };
  render();
  return {
    result: () => latest,
    render,
    runLoadEffect: () => harness.effects[0](),
  };
};

const hydrateHook = async (options = {}) => {
  const hook = renderHook(options);
  hook.runLoadEffect();
  await flushAsync();
  hook.render();
  return hook;
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  invalidateCache(kWatchdogSettingsCacheKey);
  invalidateCache(kWatchdogMemoryCacheKey);
  api.fetchWatchdogSettings.mockResolvedValue({
    ok: true,
    settings: {
      autoRepair: false,
      notificationsEnabled: true,
      notificationsVerbose: true,
    },
  });
  api.fetchWatchdogMemorySettings.mockResolvedValue({
    ok: true,
    settings: { enabled: true, autoRestart: false, effectiveAutoRestart: false },
  });
});

describe("frontend/watchdog settings toggles (document-level useSavedSetting)", () => {
  it("hydrates all three toggles from ONE GET of the shared settings doc", async () => {
    // The server omits notificationsVerbose (older server): the documented
    // default (true) fills it in — verbose is ON unless explicitly off.
    api.fetchWatchdogSettings.mockResolvedValue({
      ok: true,
      settings: { autoRepair: true, notificationsEnabled: false },
    });
    const hook = await hydrateHook();
    expect(api.fetchWatchdogSettings).toHaveBeenCalledTimes(1);
    expect(hook.result().settingsHydrated).toBe(true);
    expect(hook.result().settings).toEqual({
      autoRepair: true,
      notificationsEnabled: false,
      notificationsVerbose: true,
    });
    expect(hook.result().settingsLoadError).toBe(null);
  });

  it("verbose commit sends ONLY its own field and toasts the mode copy", async () => {
    api.updateWatchdogSettings.mockResolvedValue({ ok: true });
    const hook = await hydrateHook();

    await hook.result().onToggleNotificationsVerbose(false);
    hook.render();
    expect(api.updateWatchdogSettings).toHaveBeenCalledWith({
      notificationsVerbose: false,
    });
    expect(hook.result().settings.notificationsVerbose).toBe(false);
    // Siblings stay for display, never written back.
    expect(hook.result().settings.notificationsEnabled).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      "Now sending important notifications only",
      "success",
    );

    await hook.result().onToggleNotificationsVerbose(true);
    expect(api.updateWatchdogSettings).toHaveBeenLastCalledWith({
      notificationsVerbose: true,
    });
    expect(showToast).toHaveBeenLastCalledWith(
      "Verbose notifications enabled",
      "success",
    );
  });

  it("verbose save failure reverts with a context-scoped chip", async () => {
    const error = new Error("disk full");
    api.updateWatchdogSettings.mockRejectedValue(error);
    const hook = await hydrateHook();

    await hook.result().onToggleNotificationsVerbose(false);
    hook.render();
    expect(hook.result().settings.notificationsVerbose).toBe(true); // reverted
    expect(hook.result().settingsSaveError).toMatchObject({
      error,
      context: kNotificationsVerboseContext,
    });
    expect(
      hook.result().settingsSaveError.attempted.notificationsVerbose,
    ).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("auto-repair flips optimistically, PUTs ONLY its own field, and toasts only on success", async () => {
    const putGate = deferred();
    api.updateWatchdogSettings.mockReturnValue(putGate.promise);
    const onRefreshStatuses = vi.fn();
    const hook = await hydrateHook({ onRefreshStatuses });

    const clicked = hook.result().onToggleAutoRepair(true);
    hook.render();
    expect(hook.result().settings.autoRepair).toBe(true); // instant — no waiting on the PUT
    expect(hook.result().savingSettings).toBe(true);
    expect(hook.result().savingSettingsContext).toBe(kAutoRepairContext);
    expect(showToast).not.toHaveBeenCalled(); // not before the PUT settles

    putGate.resolve({
      ok: true,
      settings: { autoRepair: true, notificationsEnabled: true },
    });
    await clicked;
    hook.render();
    // The PUT body is narrowed to the changed field (the endpoint patches
    // per-field): a stale local copy of the sibling is never written back.
    expect(api.updateWatchdogSettings).toHaveBeenCalledWith({
      autoRepair: true,
    });
    expect(hook.result().savingSettings).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Auto-repair enabled", "success");
    expect(onRefreshStatuses).toHaveBeenCalled();
  });

  it("notifications commit keeps the sibling locally but sends only its own field", async () => {
    api.fetchWatchdogSettings.mockResolvedValue({
      ok: true,
      settings: { autoRepair: true, notificationsEnabled: true },
    });
    api.updateWatchdogSettings.mockResolvedValue({ ok: true });
    const hook = await hydrateHook();

    await hook.result().onToggleNotifications(false);
    hook.render();
    expect(api.updateWatchdogSettings).toHaveBeenCalledWith({
      notificationsEnabled: false,
    });
    // The optimistic document still carries the sibling for display.
    expect(hook.result().settings.autoRepair).toBe(true);
    expect(hook.result().settings.notificationsEnabled).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Notifications disabled", "success");
  });

  it("reverts loudly on save failure — context-scoped inline error, NO error toast", async () => {
    const error = new Error("disk full");
    api.updateWatchdogSettings.mockRejectedValue(error);
    const onRefreshStatuses = vi.fn();
    const hook = await hydrateHook({ onRefreshStatuses });

    await hook.result().onToggleNotifications(false);
    hook.render();
    expect(hook.result().settings.notificationsEnabled).toBe(true); // reverted
    expect(hook.result().settingsSaveError).toMatchObject({
      error,
      context: kNotificationsContext,
    });
    expect(hook.result().settingsSaveError.attempted.notificationsEnabled).toBe(false);
    expect(showToast).not.toHaveBeenCalled(); // failure feedback is the chip
    expect(onRefreshStatuses).not.toHaveBeenCalled();

    // Reconcile: the failure re-loads server truth (loadNonce bumped).
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(api.fetchWatchdogSettings).toHaveBeenCalledTimes(2);
    expect(hook.result().settingsSaveError).toMatchObject({ context: kNotificationsContext });
  });

  it("a stale mount GET landing after a user toggle cannot clobber it", async () => {
    const getGate = deferred();
    api.fetchWatchdogSettings.mockReturnValue(getGate.promise);
    api.updateWatchdogSettings.mockResolvedValue({ ok: true });
    const hook = renderHook();
    hook.runLoadEffect(); // GET in flight

    await hook.result().onToggleAutoRepair(true); // fast PUT wins
    hook.render();
    expect(hook.result().settings.autoRepair).toBe(true);

    getGate.resolve({
      ok: true,
      settings: { autoRepair: false, notificationsEnabled: true }, // pre-write snapshot lands late
    });
    await flushAsync();
    hook.render();
    expect(hook.result().settings.autoRepair).toBe(true); // the click stands
    expect(hook.result().settingsHydrated).toBe(true);
  });

  it("exposes loadError + retry instead of presenting the defaults as fact", async () => {
    api.fetchWatchdogSettings.mockRejectedValue(new Error("offline"));
    const hook = await hydrateHook();
    expect(hook.result().settingsLoadError).toBeInstanceOf(Error);
    expect(hook.result().settings).toEqual({}); // never a fabricated doc

    api.fetchWatchdogSettings.mockResolvedValue({
      ok: true,
      settings: { autoRepair: true, notificationsEnabled: false },
    });
    hook.result().onRetryLoadSettings();
    hook.render();
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().settingsLoadError).toBe(null);
    expect(hook.result().settings.autoRepair).toBe(true);
  });

  it("describe copy promises server truth (the hook reconciles after failures)", () => {
    expect(describeAutoRepairSaveError({ autoRepair: true })).toBe(
      "Couldn't confirm enabling auto-repair — showing the server's current state.",
    );
    expect(describeAutoRepairSaveError({ autoRepair: false })).toBe(
      "Couldn't confirm disabling auto-repair — showing the server's current state.",
    );
    expect(describeNotificationsSaveError({ notificationsEnabled: true })).toBe(
      "Couldn't confirm enabling notifications — showing the server's current state.",
    );
    expect(describeNotificationsSaveError({ notificationsEnabled: false })).toBe(
      "Couldn't confirm disabling notifications — showing the server's current state.",
    );
    expect(describeVerboseSaveError({ notificationsVerbose: true })).toBe(
      "Couldn't confirm switching to verbose notifications — showing the server's current state.",
    );
    expect(describeVerboseSaveError({ notificationsVerbose: false })).toBe(
      "Couldn't confirm switching to important-only notifications — showing the server's current state.",
    );
  });
});

describe("frontend/watchdog settings card (SavedToggle wiring)", () => {
  const renderCard = (props = {}) => {
    harness.beginRender();
    return expandTree(
      WatchdogSettingsCard({
        settings: {
          autoRepair: false,
          notificationsEnabled: true,
          notificationsVerbose: true,
        },
        settingsHydrated: true,
        ...props,
      }),
    );
  };

  it("renders the env-var rows (incl. verbose) plus the memory-monitor rows as context-scoped SavedToggles", () => {
    const tree = renderCard();
    const savedToggles = findAllByType(tree, SavedToggle);
    // Three env-var toggles + the memory-monitor section's two (its own
    // settings document on /api/watchdog/memory).
    expect(savedToggles.length).toBe(5);
    expect(savedToggles.map((vnode) => vnode.props.context)).toEqual([
      kAutoRepairContext,
      kNotificationsContext,
      kNotificationsVerboseContext,
      "memoryEnabled",
      "memoryAutoRestart",
    ]);
    const toggles = findAllByType(tree, ToggleSwitch);
    expect(toggles[0].props.checked).toBe(false); // auto-repair
    expect(toggles[1].props.checked).toBe(true); // notifications
    expect(toggles[2].props.checked).toBe(true); // verbose
    expect(toggles[0].props.label).toBe("Disabled");
    expect(toggles[1].props.label).toBe("Enabled");
    // The verbose row names what you GET, not on/off.
    expect(toggles[2].props.label).toBe("Verbose");
    expect(toggles[2].props.disabled).toBe(false);
    // Verbose ON → no suppression helper line.
    expect(collectText(tree).join(" ")).not.toContain(
      "Informational notices are suppressed from chat.",
    );
  });

  it("verbose row is subordinate to the master toggle and explains quiet mode", () => {
    const tree = renderCard({
      settings: {
        autoRepair: false,
        notificationsEnabled: false,
        notificationsVerbose: true,
      },
    });
    const toggles = findAllByType(tree, ToggleSwitch);
    // Master off → the verbose row disables (the kill switch subsumes it).
    expect(toggles[2].props.disabled).toBe(true);
    expect(collectText(tree).join(" ")).not.toContain(
      "Informational notices are suppressed from chat.",
    );

    const quietTree = renderCard({
      settings: {
        autoRepair: false,
        notificationsEnabled: true,
        notificationsVerbose: false,
      },
    });
    const quietToggles = findAllByType(quietTree, ToggleSwitch);
    expect(quietToggles[2].props.label).toBe("Important only");
    // Quiet mode states its contract under the row.
    expect(collectText(quietTree).join(" ")).toContain(
      "Informational notices are suppressed from chat.",
    );
  });

  it("disables the auto-restart toggle while memory detection is off", () => {
    const tree = renderCard();
    const savedToggles = findAllByType(tree, SavedToggle);
    const autoRestart = savedToggles.find(
      (vnode) => vnode.props.context === "memoryAutoRestart",
    );
    // The unhydrated memory doc renders {} → detection not confirmed on →
    // the consent knob stays disabled rather than armable-by-default.
    expect(autoRestart.props.disabled).toBe(true);
  });

  it("shows Saving... only on the in-flight control; the sibling just disables", () => {
    const tree = renderCard({
      savingSettings: true,
      savingSettingsContext: kAutoRepairContext,
    });
    const toggles = findAllByType(tree, ToggleSwitch);
    expect(toggles[0].props.label).toBe("Saving...");
    expect(toggles[0].props.disabled).toBe(true);
    expect(toggles[1].props.label).toBe("Enabled"); // no false claim
    expect(toggles[1].props.disabled).toBe(true); // shared doc lock
  });

  it("renders the context-scoped revert chip on the failed control only", () => {
    const error = new Error("disk full");
    const tree = renderCard({
      settingsSaveError: {
        attempted: { autoRepair: true, notificationsEnabled: true },
        error,
        context: kAutoRepairContext,
      },
    });
    const savedToggles = findAllByType(tree, SavedToggle);
    const autoRepairChips = findAllByType(savedToggles[0], InlineErrorChip);
    const notificationChips = findAllByType(savedToggles[1], InlineErrorChip);
    expect(autoRepairChips.length).toBe(1);
    expect(notificationChips.length).toBe(0);
    expect(collectText(savedToggles[0]).join(" ")).toContain(
      "Couldn't confirm enabling auto-repair — showing the server's current state.",
    );
  });

  it("disables both toggles with load-failure chips instead of Disabled-as-fact", () => {
    const onRetryLoadSettings = () => {};
    const tree = renderCard({
      settings: {},
      settingsHydrated: true,
      settingsLoadError: new Error("offline"),
      onRetryLoadSettings,
    });
    const toggles = findAllByType(tree, ToggleSwitch);
    expect(toggles[0].props.disabled).toBe(true);
    expect(toggles[1].props.disabled).toBe(true);
    expect(toggles[2].props.disabled).toBe(true);
    const chips = findAllByType(tree, InlineErrorChip).filter(
      (vnode) => vnode.props.onRetry === onRetryLoadSettings,
    );
    expect(chips.length).toBe(3); // each control announces + offers Retry
    expect(collectText(tree).join(" ")).toContain("Couldn't load this setting.");
  });

  it("holds unhydrated toggles at Loading... instead of the defaults", () => {
    const tree = renderCard({ settings: {}, settingsHydrated: false });
    const toggles = findAllByType(tree, ToggleSwitch);
    expect(toggles[0].props.label).toBe("Loading...");
    expect(toggles[1].props.label).toBe("Loading...");
    expect(toggles[0].props.disabled).toBe(true);
    expect(toggles[1].props.disabled).toBe(true);
  });
});

describe("frontend/watchdog memory settings hook (per-field narrow saves)", () => {
  const renderMemoryHook = () => {
    let latest;
    const render = () => {
      harness.beginRender();
      latest = useWatchdogMemorySettings();
      return latest;
    };
    render();
    return {
      result: () => latest,
      render,
      runLoadEffect: () => harness.effects[0](),
    };
  };

  const hydrateMemoryHook = async () => {
    const hook = renderMemoryHook();
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    return hook;
  };

  it("enabled toggle PUTs ONLY {enabled}; the sibling field never rides along", async () => {
    api.updateWatchdogMemorySettings.mockResolvedValue({
      ok: true,
      settings: { enabled: false, autoRestart: false, effectiveAutoRestart: false },
    });
    const hook = await hydrateMemoryHook();
    expect(hook.result().memorySettings).toMatchObject({
      enabled: true,
      autoRestart: false,
    });
    await hook.result().onToggleMemoryEnabled(false);
    expect(api.updateWatchdogMemorySettings).toHaveBeenCalledTimes(1);
    expect(api.updateWatchdogMemorySettings).toHaveBeenCalledWith({
      enabled: false,
    });
    expect(showToast).toHaveBeenCalledWith(
      "Memory leak detection disabled",
      "success",
    );
  });

  it("autoRestart toggle PUTs ONLY {autoRestart} under its own save context", async () => {
    api.updateWatchdogMemorySettings.mockResolvedValue({
      ok: true,
      settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
    });
    const hook = await hydrateMemoryHook();
    const commit = hook.result().onToggleMemoryAutoRestart(true);
    hook.render();
    expect(hook.result().savingMemoryContext).toBe(kMemoryAutoRestartContext);
    await commit;
    expect(api.updateWatchdogMemorySettings).toHaveBeenCalledTimes(1);
    expect(api.updateWatchdogMemorySettings).toHaveBeenCalledWith({
      autoRestart: true,
    });
    hook.render();
    expect(hook.result().memorySettings.autoRestart).toBe(true);
  });

  it("a failed save reverts to server truth with a context-scoped error, no success toast", async () => {
    api.updateWatchdogMemorySettings.mockRejectedValue(new Error("boom"));
    const hook = await hydrateMemoryHook();
    await hook.result().onToggleMemoryEnabled(false);
    hook.render();
    expect(hook.result().memorySettings.enabled).toBe(true); // reverted
    expect(hook.result().memorySaveError?.context).toBe(kMemoryEnabledContext);
    expect(showToast).not.toHaveBeenCalled();
  });
});
