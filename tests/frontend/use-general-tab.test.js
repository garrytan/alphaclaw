import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component.test.js): hook
// state lives in per-call-index slots so the hook can be invoked directly
// without a DOM renderer. Effects are collected, not run.
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
  approveDevice: vi.fn(),
  approvePairing: vi.fn(),
  fetchDashboardUrl: vi.fn(),
  fetchDevicePairings: vi.fn(),
  fetchPairings: vi.fn(),
  rejectDevice: vi.fn(),
  rejectPairing: vi.fn(),
  triggerWatchdogRepair: vi.fn(),
  updateOpenAiCompatApiFeature: vi.fn(),
  updateSyncCron: vi.fn(),
}));

// The hook calls usePolling twice per render (pairings, devices); hand back
// stable objects per call slot so refresh spies survive re-renders.
vi.mock("../../lib/public/js/hooks/usePolling.js", () => {
  const polls = [
    { data: [], refresh: vi.fn(async () => []), isPolling: false },
    { data: [], refresh: vi.fn(async () => []), isPolling: false },
  ];
  let cursor = 0;
  return {
    usePolling: () => polls[cursor++ % 2],
    __polls: polls,
  };
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock("../../lib/public/js/components/channels.js", () => ({
  ALL_CHANNELS: ["telegram", "whatsapp"],
  Channels: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import * as pollingModule from "../../lib/public/js/hooks/usePolling.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useGeneralTab } from "../../lib/public/js/components/general/use-general-tab.js";

const harness = preactHooks.__harness;
const polls = pollingModule.__polls;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const statusWith = ({ openAiCompatApiEnabled = null, syncCron = null } = {}) => ({
  gateway: "running",
  channels: {},
  alphaclaw:
    openAiCompatApiEnabled === null
      ? {}
      : { features: { openaiCompatApi: { enabled: openAiCompatApiEnabled } } },
  syncCron,
});

const renderHook = (props = {}) => {
  harness.beginRender();
  return useGeneralTab(props);
};

const runEffects = () => {
  for (const effect of [...harness.effects]) effect?.();
};

describe("frontend/use-general-tab", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    api.updateOpenAiCompatApiFeature.mockResolvedValue({ ok: true });
    api.updateSyncCron.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("OpenAI-compat API toggle vs status sync", () => {
    it("ignores stale status frames while the save is in flight", async () => {
      let props = { statusData: statusWith({ openAiCompatApiEnabled: false }) };
      let hook = renderHook(props);
      runEffects();
      hook = renderHook(props);
      expect(hook.state.openAiCompatApi.enabled).toBe(false);

      const saveGate = deferred();
      api.updateOpenAiCompatApiFeature.mockReturnValue(saveGate.promise);
      const togglePromise = hook.actions.handleOpenAiCompatApiToggle(true);

      // A poll/SSE frame with the pre-toggle value lands mid-save.
      hook = renderHook(props);
      runEffects();
      hook = renderHook(props);
      expect(hook.state.openAiCompatApi.enabled).toBe(true);
      expect(hook.state.savingOpenAiCompatApi).toBe(true);

      saveGate.resolve({ ok: true });
      await togglePromise;
      hook = renderHook(props);
      expect(hook.state.openAiCompatApi.enabled).toBe(true);
      expect(hook.state.savingOpenAiCompatApi).toBe(false);
    });

    it("suppresses a pre-PUT frame landing post-success until the window lapses", async () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const staleProps = { statusData: statusWith({ openAiCompatApiEnabled: false }) };
      let hook = renderHook(staleProps);
      runEffects();
      hook = renderHook(staleProps);

      await hook.actions.handleOpenAiCompatApiToggle(true);
      hook = renderHook(staleProps);
      expect(hook.state.openAiCompatApi.enabled).toBe(true);

      // Stale frame (generated pre-PUT) arrives after the save succeeded.
      runEffects();
      hook = renderHook(staleProps);
      expect(hook.state.openAiCompatApi.enabled).toBe(true);

      // Once the window lapses, the server's word wins again.
      nowSpy.mockReturnValue(1_000_000 + 6000);
      runEffects();
      hook = renderHook(staleProps);
      expect(hook.state.openAiCompatApi.enabled).toBe(false);
    });

    it("a confirming frame clears the suppress window so later frames apply", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      let props = { statusData: statusWith({ openAiCompatApiEnabled: false }) };
      let hook = renderHook(props);
      runEffects();
      hook = renderHook(props);

      await hook.actions.handleOpenAiCompatApiToggle(true);

      // Confirming frame arrives (still within the window).
      props = { statusData: statusWith({ openAiCompatApiEnabled: true }) };
      hook = renderHook(props);
      runEffects();
      hook = renderHook(props);
      expect(hook.state.openAiCompatApi.enabled).toBe(true);

      // A later authoritative "disabled" frame must now be accepted.
      props = { statusData: statusWith({ openAiCompatApiEnabled: false }) };
      hook = renderHook(props);
      runEffects();
      hook = renderHook(props);
      expect(hook.state.openAiCompatApi.enabled).toBe(false);
    });

    it("reverts loudly on failure: error state set, no error toast", async () => {
      const props = { statusData: statusWith({ openAiCompatApiEnabled: false }) };
      let hook = renderHook(props);
      runEffects();
      hook = renderHook(props);

      api.updateOpenAiCompatApiFeature.mockRejectedValue(new Error("nope"));
      await hook.actions.handleOpenAiCompatApiToggle(true);
      hook = renderHook(props);

      expect(hook.state.openAiCompatApi.enabled).toBe(false);
      expect(hook.state.openAiCompatApiError).toMatchObject({ attempted: true });
      expect(hook.state.openAiCompatApiError.error.message).toBe("nope");
      expect(showToast).not.toHaveBeenCalled();

      // Next attempt clears the error.
      api.updateOpenAiCompatApiFeature.mockResolvedValue({ ok: true });
      await hook.actions.handleOpenAiCompatApiToggle(true);
      hook = renderHook(props);
      expect(hook.state.openAiCompatApiError).toBe(null);
      expect(hook.state.openAiCompatApi.enabled).toBe(true);
    });
  });

  describe("auto-sync schedule select", () => {
    const cronProps = {
      statusData: statusWith({
        syncCron: { enabled: true, schedule: "0 * * * *", installed: true },
      }),
    };

    it("restores enabled, schedule, AND choice on save failure and sets syncCronError", async () => {
      let hook = renderHook(cronProps);
      runEffects();
      hook = renderHook(cronProps);
      expect(hook.state.syncCronChoice).toBe("0 * * * *");

      api.updateSyncCron.mockRejectedValue(new Error("cron write failed"));
      await hook.actions.handleSyncCronChoiceChange("disabled");
      hook = renderHook(cronProps);

      expect(hook.state.syncCronChoice).toBe("0 * * * *");
      expect(hook.state.syncCronEnabled).toBe(true);
      expect(hook.state.syncCronSchedule).toBe("0 * * * *");
      expect(hook.state.syncCronError.message).toBe("cron write failed");
      expect(showToast).not.toHaveBeenCalled();

      // Next attempt clears the error.
      api.updateSyncCron.mockResolvedValue({ ok: true });
      await hook.actions.handleSyncCronChoiceChange("0 0 * * *");
      hook = renderHook(cronProps);
      expect(hook.state.syncCronError).toBe(null);
      expect(hook.state.syncCronChoice).toBe("0 0 * * *");
    });

    it("does not let a status frame clobber the optimistic value mid-save", async () => {
      let hook = renderHook(cronProps);
      runEffects();
      hook = renderHook(cronProps);

      const saveGate = deferred();
      api.updateSyncCron.mockReturnValue(saveGate.promise);
      const savePromise = hook.actions.handleSyncCronChoiceChange("0 0 * * *");

      hook = renderHook(cronProps);
      expect(hook.state.savingSyncCron).toBe(true);
      expect(hook.state.syncCronChoice).toBe("0 0 * * *");

      // Stale frame with the pre-save schedule arrives mid-write.
      runEffects();
      hook = renderHook(cronProps);
      expect(hook.state.syncCronChoice).toBe("0 0 * * *");

      saveGate.resolve({ ok: true });
      await savePromise;
      hook = renderHook(cronProps);
      expect(hook.state.savingSyncCron).toBe(false);
      expect(hook.state.syncCronChoice).toBe("0 0 * * *");
    });
  });

  describe("restart signal burst", () => {
    it("fires once per signal even when polling flags flip between renders", () => {
      vi.useFakeTimers();
      try {
        const props = { restartSignal: 1, isActive: true, statusData: null };
        renderHook(props);
        runEffects();
        expect(polls[0].refresh).toHaveBeenCalledTimes(1);

        // Re-render with the same signal (e.g. a polling flag flipped).
        renderHook(props);
        runEffects();
        expect(polls[0].refresh).toHaveBeenCalledTimes(1);

        renderHook({ ...props, restartSignal: 2 });
        runEffects();
        expect(polls[0].refresh).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
