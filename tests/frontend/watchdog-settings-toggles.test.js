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
  kMemoryBudgetContext,
  kMemoryMaxRestartsContext,
  kMemoryBudgetMbBounds,
  kMemoryMaxRestartsPerDayBounds,
  describeMemoryBudgetSaveError,
  describeMemoryMaxRestartsSaveError,
  parseMemoryBudgetMbInput,
  parseMemoryMaxRestartsPerDayInput,
  resetMemoryBoundsForTests,
  useWatchdogSettings,
  useWatchdogMemorySettings,
} from "../../lib/public/js/components/watchdog-tab/settings/use-settings.js";
import {
  MemoryNumberField,
  WatchdogSettingsCard,
  describeMemoryNumberBounds,
} from "../../lib/public/js/components/watchdog-tab/settings/index.js";
import { SavedToggle } from "../../lib/public/js/components/saved-toggle.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { formatInteger } from "../../lib/public/js/lib/format.js";
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

  it("budget / restart-budget commits PUT ONLY their own field under their own contexts (issue #56)", async () => {
    api.updateWatchdogMemorySettings.mockResolvedValue({
      ok: true,
      settings: {
        enabled: true,
        autoRestart: true,
        effectiveAutoRestart: true,
        budgetMb: 2800,
        maxRestartsPerDay: 2,
      },
    });
    const hook = await hydrateMemoryHook();
    expect(hook.result().memorySettings).toMatchObject({
      budgetMb: null,
      maxRestartsPerDay: 2,
    });
    const commit = hook.result().onCommitMemoryBudgetMb(2800);
    hook.render();
    expect(hook.result().savingMemoryContext).toBe(kMemoryBudgetContext);
    await commit;
    expect(api.updateWatchdogMemorySettings).toHaveBeenLastCalledWith({
      budgetMb: 2800,
    });
    expect(showToast).toHaveBeenCalledWith(
      "Memory budget set to 2800 MB",
      "success",
    );

    api.updateWatchdogMemorySettings.mockResolvedValue({
      ok: true,
      settings: {
        enabled: true,
        autoRestart: true,
        effectiveAutoRestart: true,
        budgetMb: 2800,
        maxRestartsPerDay: 8,
      },
    });
    await hook.result().onCommitMemoryMaxRestartsPerDay(8);
    expect(api.updateWatchdogMemorySettings).toHaveBeenLastCalledWith({
      maxRestartsPerDay: 8,
    });
    hook.render();
    expect(hook.result().memorySettings.maxRestartsPerDay).toBe(8);

    // Clearing the budget sends an explicit null (derived cap again).
    await hook.result().onCommitMemoryBudgetMb(null);
    expect(api.updateWatchdogMemorySettings).toHaveBeenLastCalledWith({
      budgetMb: null,
    });
    // Junk never reaches the API.
    expect(await hook.result().onCommitMemoryMaxRestartsPerDay("x")).toEqual({
      ok: false,
    });
  });

  it("number-field parsers accept in-bounds values, blank-clears the budget only, and reject junk", () => {
    expect(parseMemoryBudgetMbInput("2800")).toBe(2800);
    expect(parseMemoryBudgetMbInput(" 2800 ")).toBe(2800);
    expect(parseMemoryBudgetMbInput("")).toBe(null);
    expect(parseMemoryBudgetMbInput(null)).toBe(null);
    expect(parseMemoryBudgetMbInput(undefined)).toBe(null);
    // Inclusive edges.
    expect(parseMemoryBudgetMbInput("256")).toBe(256);
    expect(parseMemoryBudgetMbInput("1048576")).toBe(1048576);
    expect(parseMemoryMaxRestartsPerDayInput("1")).toBe(1);
    expect(parseMemoryMaxRestartsPerDayInput("24")).toBe(24);
    // Whole numbers only — a fraction is rejected, never rounded (255.6 must
    // not sneak under the floor as 256).
    for (const junk of ["100", "abc", "-1", "9999999999", "2800.4", "255.6"]) {
      expect(parseMemoryBudgetMbInput(junk)).toBe(undefined);
    }
    // Server-supplied bounds override the fallback.
    expect(parseMemoryBudgetMbInput("100", { min: 64, max: 512 })).toBe(100);
    expect(parseMemoryBudgetMbInput("2800", { min: 64, max: 512 })).toBe(undefined);
    expect(parseMemoryMaxRestartsPerDayInput("6")).toBe(6);
    for (const junk of ["", "0", "25", "2.5", "x"]) {
      expect(parseMemoryMaxRestartsPerDayInput(junk)).toBe(undefined);
    }
  });

  it("describe copy names the attempted value (or the clear) and promises server truth", () => {
    expect(describeMemoryBudgetSaveError({ budgetMb: 2800 })).toBe(
      "Couldn't confirm the 2800 MB memory budget — showing the server's current value.",
    );
    expect(describeMemoryBudgetSaveError({ budgetMb: null })).toBe(
      "Couldn't confirm clearing the memory budget — showing the server's current value.",
    );
    expect(describeMemoryBudgetSaveError(undefined)).toContain("clearing the memory budget");
    expect(describeMemoryMaxRestartsSaveError({ maxRestartsPerDay: 8 })).toBe(
      "Couldn't confirm 8 auto-restarts per day — showing the server's current value.",
    );
    expect(describeMemoryMaxRestartsSaveError(undefined)).toBe(
      "Couldn't confirm the auto-restarts per day — showing the server's current value.",
    );
  });

  it("budget junk never reaches the API; clearing toasts the derived-cap copy", async () => {
    const hook = await hydrateMemoryHook();
    expect(await hook.result().onCommitMemoryBudgetMb("abc")).toEqual({ ok: false });
    expect(await hook.result().onCommitMemoryBudgetMb(Number.NaN)).toEqual({ ok: false });
    expect(api.updateWatchdogMemorySettings).not.toHaveBeenCalled();
    api.updateWatchdogMemorySettings.mockResolvedValue({
      ok: true,
      settings: { enabled: true, autoRestart: false, effectiveAutoRestart: false, budgetMb: null, maxRestartsPerDay: 2 },
    });
    await hook.result().onCommitMemoryBudgetMb(null);
    expect(showToast).toHaveBeenCalledWith(
      "Memory budget cleared — cap derived from heap and container again",
      "success",
    );
  });

  it("a failed budget / restart-budget save reverts to server truth under ITS context, no success toast", async () => {
    api.updateWatchdogMemorySettings.mockRejectedValue(new Error("boom"));
    const hook = await hydrateMemoryHook();
    const outcome = await hook.result().onCommitMemoryBudgetMb(2800);
    expect(outcome.ok).toBe(false);
    hook.render();
    expect(hook.result().memorySettings.budgetMb).toBe(null); // reverted
    expect(hook.result().memorySaveError?.context).toBe(kMemoryBudgetContext);
    expect(hook.result().memorySaveError?.attempted).toMatchObject({ budgetMb: 2800 });
    expect(showToast).not.toHaveBeenCalled();
    await hook.result().onCommitMemoryMaxRestartsPerDay(8);
    hook.render();
    expect(hook.result().memorySettings.maxRestartsPerDay).toBe(2); // reverted
    expect(hook.result().memorySaveError?.context).toBe(kMemoryMaxRestartsContext);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("adopts the server's bounds from GET (falls back to the mirrored constants before hydration)", async () => {
    resetMemoryBoundsForTests();
    api.fetchWatchdogMemorySettings.mockResolvedValue({
      ok: true,
      settings: { enabled: true, autoRestart: false, effectiveAutoRestart: false, budgetMb: null, maxRestartsPerDay: 2 },
      bounds: { budgetMb: { min: 512, max: 4096 }, maxRestartsPerDay: { min: 1, max: 6 } },
    });
    const hook = renderMemoryHook();
    expect(hook.result().memoryBounds).toEqual({
      budgetMb: kMemoryBudgetMbBounds,
      maxRestartsPerDay: kMemoryMaxRestartsPerDayBounds,
    });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().memoryBounds).toEqual({
      budgetMb: { min: 512, max: 4096 },
      maxRestartsPerDay: { min: 1, max: 6 },
    });
    // Malformed bounds from the server fall back per field.
    resetMemoryBoundsForTests();
    api.fetchWatchdogMemorySettings.mockResolvedValue({
      ok: true,
      settings: {},
      bounds: { budgetMb: { min: 9, max: 1 }, maxRestartsPerDay: "nope" },
    });
    const hook2 = await hydrateMemoryHook();
    expect(hook2.result().memoryBounds).toEqual({
      budgetMb: kMemoryBudgetMbBounds,
      maxRestartsPerDay: kMemoryMaxRestartsPerDayBounds,
    });
    resetMemoryBoundsForTests();
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

describe("frontend/watchdog MemoryNumberField (draft → blur/Enter commit, issue #56)", () => {
  const baseProps = () => ({
    label: "Memory budget (MB)",
    tooltip: "t",
    ariaLabel: "Gateway memory budget in MB",
    placeholder: "auto",
    nullable: true,
    min: kMemoryBudgetMbBounds.min,
    max: kMemoryBudgetMbBounds.max,
    step: 64,
    parse: parseMemoryBudgetMbInput,
    describe: describeMemoryBudgetSaveError,
    context: kMemoryBudgetContext,
    hydrated: true,
    onCommit: vi.fn(async () => ({ ok: true })),
  });
  // Same slot harness as the hooks: re-rendering without reset keeps state.
  const renderField = (props) => {
    harness.beginRender();
    return MemoryNumberField(props);
  };
  // Preact normalizes `onblur` to `onfocusout` on the vnode, so tests fire that prop.
  const inputOf = (tree) => collectNodes(tree).find((n) => n.type === "input");
  const chipsOf = (tree) => findAllByType(tree, InlineErrorChip);

  beforeEach(() => {
    harness.reset();
  });

  it("seeds the draft from the server value and shows the placeholder for null; re-seeds when server truth changes", () => {
    const props = { ...baseProps(), value: null };
    let tree = renderField(props);
    let input = inputOf(tree);
    expect(input.props.value).toBe("");
    expect(input.props.placeholder).toBe("auto");
    expect(input.props.type).toBe("number");
    expect(input.props.inputmode).toBe("numeric");
    expect(input.props["aria-label"]).toBe("Gateway memory budget in MB");
    expect(input.props["aria-invalid"]).toBe("false");
    expect(input.props.min).toBe(256);
    expect(input.props.max).toBe(1048576);
    expect(input.props.disabled).toBe(false);
    // No inline style: sizing comes from the utility class like the autotune input.
    expect(input.props.style).toBeUndefined();
    expect(input.props.class).toContain("w-28");
    expect(input.props.class).toContain("disabled:opacity-50");
    // Server truth moves (another tab saved): the effect re-seeds the draft.
    renderField({ ...props, value: 4096 });
    harness.effects[0]();
    tree = renderField({ ...props, value: 4096 });
    expect(inputOf(tree).props.value).toBe("4096");
  });

  it("blur commits a valid CHANGED draft exactly once; unchanged is a no-op; blank clears", async () => {
    const props = { ...baseProps(), value: 2800 };
    let tree = renderField(props);
    inputOf(tree).props.oninput({ target: { value: "4096" } });
    tree = renderField(props);
    expect(inputOf(tree).props.value).toBe("4096");
    await inputOf(tree).props.onfocusout();
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith(4096);
    // Same value as the server → no save at all.
    inputOf(tree).props.oninput({ target: { value: "2800" } });
    tree = renderField(props);
    await inputOf(tree).props.onfocusout();
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    // Blank clears (parse → null) when the server has a value.
    inputOf(tree).props.oninput({ target: { value: "" } });
    tree = renderField(props);
    await inputOf(tree).props.onfocusout();
    expect(props.onCommit).toHaveBeenLastCalledWith(null);
  });

  it("Enter commits and prevents the default; other keys do nothing", async () => {
    const props = { ...baseProps(), value: null };
    let tree = renderField(props);
    inputOf(tree).props.oninput({ target: { value: "512" } });
    tree = renderField(props);
    const preventDefault = vi.fn();
    inputOf(tree).props.onkeydown({ key: "a", preventDefault });
    await flushAsync();
    expect(props.onCommit).not.toHaveBeenCalled();
    inputOf(tree).props.onkeydown({ key: "Enter", preventDefault });
    await flushAsync();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith(512);
  });

  it("an out-of-bounds draft renders the bounds chip (via headline — the chip has no text prop) and never commits; typing clears it", async () => {
    const props = { ...baseProps(), value: null };
    let tree = renderField(props);
    inputOf(tree).props.oninput({ target: { value: "100" } });
    tree = renderField(props);
    await inputOf(tree).props.onfocusout();
    tree = renderField(props);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(inputOf(tree).props["aria-invalid"]).toBe("true");
    expect(chipsOf(tree).length).toBe(1);
    expect(chipsOf(tree)[0].props.headline).toBe(
      describeMemoryNumberBounds({ min: 256, max: 1048576, nullable: true }),
    );
    expect(chipsOf(tree)[0].props.headline).toContain("or leave blank");
    expect(chipsOf(tree)[0].props.text).toBeUndefined();
    inputOf(tree).props.oninput({ target: { value: "1024" } });
    tree = renderField(props);
    expect(chipsOf(tree).length).toBe(0);
    // Non-nullable variant (restarts/day): blank is invalid, no escape-hatch copy.
    harness.reset();
    const restarts = {
      ...baseProps(),
      placeholder: "",
      nullable: false,
      min: kMemoryMaxRestartsPerDayBounds.min,
      max: kMemoryMaxRestartsPerDayBounds.max,
      step: 1,
      parse: parseMemoryMaxRestartsPerDayInput,
      describe: describeMemoryMaxRestartsSaveError,
      context: kMemoryMaxRestartsContext,
      value: 2,
    };
    tree = renderField(restarts);
    inputOf(tree).props.oninput({ target: { value: "" } });
    tree = renderField(restarts);
    await inputOf(tree).props.onfocusout();
    tree = renderField(restarts);
    expect(restarts.onCommit).not.toHaveBeenCalled();
    expect(chipsOf(tree)[0].props.headline).toBe("Enter a whole number between 1 and 24.");
  });

  it("an unparseable number draft (validity.badInput, value \"\") is invalid — never a silent clear", async () => {
    const props = { ...baseProps(), value: 2800 };
    let tree = renderField(props);
    // Chromium reports value "" with validity.badInput for "1e" / "-" / "12abc".
    inputOf(tree).props.oninput({ target: { value: "", validity: { badInput: true } } });
    tree = renderField(props);
    await inputOf(tree).props.onfocusout();
    tree = renderField(props);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(chipsOf(tree).length).toBe(1);
    // A genuine clear (no badInput) still clears.
    inputOf(tree).props.oninput({ target: { value: "", validity: { badInput: false } } });
    tree = renderField(props);
    await inputOf(tree).props.onfocusout();
    expect(props.onCommit).toHaveBeenLastCalledWith(null);
  });

  it("formats large bounds through lib/format.js in the validation copy", () => {
    expect(describeMemoryNumberBounds({ min: 256, max: 1048576, nullable: false })).toBe(
      `Enter a whole number between ${formatInteger(256)} and ${formatInteger(1048576)}.`,
    );
  });

  it("renders the context-scoped save-error chip with the real error + describe(attempted); a sibling's error shows the helper instead", () => {
    const error = new Error("disk full");
    const own = renderField({
      ...baseProps(),
      value: null,
      helper: "helper text",
      saveError: { attempted: { budgetMb: 2800 }, error, context: kMemoryBudgetContext },
    });
    expect(chipsOf(own).length).toBe(1);
    expect(chipsOf(own)[0].props.error).toBe(error);
    expect(chipsOf(own)[0].props.headline).toBe(
      "Couldn't confirm the 2800 MB memory budget — showing the server's current value.",
    );
    expect(collectText(own).join(" ")).not.toContain("helper text");
    harness.reset();
    const other = renderField({
      ...baseProps(),
      value: null,
      helper: "helper text",
      saveError: { attempted: { maxRestartsPerDay: 8 }, error, context: kMemoryMaxRestartsContext },
    });
    expect(chipsOf(other).length).toBe(0);
    expect(collectText(other).join(" ")).toContain("helper text");
  });

  it("a failed commit re-seeds the draft from server truth so the rejected text is not re-sent on the next blur", async () => {
    const props = { ...baseProps(), value: 2800, onCommit: vi.fn(async () => ({ ok: false })) };
    let tree = renderField(props);
    inputOf(tree).props.oninput({ target: { value: "4096" } });
    tree = renderField(props);
    await inputOf(tree).props.onfocusout();
    expect(props.onCommit).toHaveBeenCalledWith(4096);
    tree = renderField(props);
    expect(inputOf(tree).props.value).toBe("2800");
    await inputOf(tree).props.onfocusout();
    expect(props.onCommit).toHaveBeenCalledTimes(1); // unchanged → no resend
  });

  it("disables while unhydrated, while explicitly disabled, and while ITS OWN save is in flight — never for a sibling's save", () => {
    expect(inputOf(renderField({ ...baseProps(), value: null, hydrated: false })).props.disabled).toBe(true);
    harness.reset();
    expect(inputOf(renderField({ ...baseProps(), value: null, disabled: true })).props.disabled).toBe(true);
    harness.reset();
    expect(
      inputOf(renderField({ ...baseProps(), value: null, saving: true, savingContext: kMemoryBudgetContext })).props.disabled,
    ).toBe(true);
    harness.reset();
    expect(
      inputOf(renderField({ ...baseProps(), value: null, saving: true, savingContext: kMemoryMaxRestartsContext })).props.disabled,
    ).toBe(false);
  });
});

describe("frontend/watchdog settings card — fast-leak profile fields wiring (issue #56)", () => {
  it("wires the two number fields with bounds, contexts, helpers, and detection/arm gating", () => {
    harness.reset();
    harness.beginRender();
    const tree = expandTree(
      WatchdogSettingsCard({
        settings: { autoRepair: false, notificationsEnabled: true, notificationsVerbose: true },
        settingsHydrated: true,
      }),
    );
    const fields = findAllByType(tree, MemoryNumberField);
    expect(fields.length).toBe(2);
    const [budget, restarts] = fields;
    expect(budget.props).toMatchObject({
      context: kMemoryBudgetContext,
      nullable: true,
      min: 256,
      max: 1048576,
      step: 64,
      placeholder: "auto",
      value: null,
      disabled: true, // unhydrated doc → detection not confirmed on
    });
    expect(restarts.props).toMatchObject({
      context: kMemoryMaxRestartsContext,
      min: 1,
      max: 24,
      value: 2,
      disabled: true, // needs detection on AND autoRestart === true
    });
    expect(typeof budget.props.onCommit).toBe("function");
    expect(typeof restarts.props.onCommit).toBe("function");
    // The SavedToggle count is unchanged by the number fields.
    expect(findAllByType(tree, SavedToggle).length).toBe(5);
  });
});
