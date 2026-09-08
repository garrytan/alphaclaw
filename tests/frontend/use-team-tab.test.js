import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as use-general-tab.test.js): hook state
// lives in per-call-index slots so the hook can be invoked directly without a
// DOM renderer. Effects are collected, not run.
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
  createTeamInvite: vi.fn(),
  disableTeam: vi.fn(),
  enableTeam: vi.fn(),
  fetchDevicePairings: vi.fn(),
  fetchTeam: vi.fn(),
  fetchTeamPresence: vi.fn(),
  rejectDevice: vi.fn(),
  removeTeamMember: vi.fn(),
  revokeTeamInvite: vi.fn(),
  updateTeamMember: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { useTeamTab } from "../../lib/public/js/components/team-tab/use-team-tab.js";
import { showToast } from "../../lib/public/js/components/toast.js";

const harness = preactHooks.__harness;

const renderHook = (props = {}) => {
  harness.beginRender();
  return useTeamTab(props);
};

describe("frontend/use-team-tab", () => {
  beforeEach(() => {
    harness.reset();
    vi.resetAllMocks();
  });

  it.each([
    ["onUpdateMember", "updateTeamMember"],
    ["onRemoveMember", "removeTeamMember"],
  ])("%s shows deferred gateway advice while preserving the saved-member outcome", async (action, apiName) => {
    const hint = "Resolve the hold, then save member settings again to sync gateway authentication.";
    api[apiName].mockResolvedValue({ ok: true, memberSaved: true, gatewayConfigDeferred: true, restartDeferred: true, hint });
    const updated = { enabled: true, members: [{ id: "m1", disabled: true }] };
    api.fetchTeam.mockResolvedValue(updated);
    const onRefreshStatuses = vi.fn();
    const hook = renderHook({ onRefreshStatuses });
    expect(await hook[action]("m1", { disabled: true })).toBe(true);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(hint, "warning", { durationMs: 10_000 });
    const next = renderHook({ onRefreshStatuses });
    expect(next.team).toEqual(updated);
    expect(next.busyMemberId).toBeNull();
    expect(onRefreshStatuses).toHaveBeenCalledTimes(1);
  });

  it("a saved disable failure refreshes the actual mode and settles with an unverified warning", async () => {
    const onRefreshStatuses = vi.fn();
    const hint = "Resolve the gateway hold before restarting.";
    api.fetchTeam.mockResolvedValueOnce({ enabled: true }).mockResolvedValueOnce({ enabled: false });
    let hook = renderHook({ onRefreshStatuses });
    await hook.reload();
    hook = renderHook({ onRefreshStatuses });
    api.disableTeam.mockRejectedValue(Object.assign(new Error("Gateway restart deferred"), {
      disabled: true, enabled: false, configSaved: true, configRestored: true,
      gatewayRestored: false, restartDeferred: true, hint,
    }));
    expect(await hook.onDisableTeam()).toBe(true);
    expect(renderHook({ onRefreshStatuses }).team.enabled).toBe(false);
    expect(onRefreshStatuses).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(hint), "warning", { durationMs: 10_000 });
    expect(showToast.mock.calls[0][0]).toContain("still needs verification");
  });

  it("a refusal before disabling remains an error and never claims the mode changed", async () => {
    api.fetchTeam.mockResolvedValue({ enabled: true });
    api.disableTeam.mockRejectedValue(Object.assign(new Error("Gateway held"), {
      disabled: false, enabled: true, configSaved: false, restartDeferred: true,
    }));
    const onRefreshStatuses = vi.fn();
    expect(await renderHook({ onRefreshStatuses }).onDisableTeam()).toBe(false);
    expect(renderHook({ onRefreshStatuses }).team.enabled).toBe(true);
    expect(showToast).toHaveBeenCalledExactlyOnceWith("Gateway held", "error");
  });

  it("a failed refresh cannot put a confirmed saved disable back into the enabled state", async () => {
    api.fetchTeam.mockResolvedValueOnce({ enabled: true }).mockRejectedValueOnce(new Error("Refresh unavailable"));
    let hook = renderHook();
    await hook.reload();
    hook = renderHook();
    api.disableTeam.mockRejectedValue(Object.assign(new Error("Gateway held"), { disabled: true, configRestored: true }));
    expect(await hook.onDisableTeam()).toBe(true);
    const next = renderHook();
    expect(next.team.enabled).toBe(false);
    expect(next.loadError).toBe("Refresh unavailable");
    expect(showToast.mock.calls[0][1]).toBe("warning");
  });

  it("a failed enable after an auth write refreshes mode and keeps the failure visible", async () => {
    const onRefreshStatuses = vi.fn();
    api.fetchTeam.mockResolvedValue({ enabled: true, disableLegacyLogin: false });
    api.enableTeam.mockRejectedValue(Object.assign(new Error("Gateway identity not verified"), {
      enabled: true, configSaved: true, configApplied: true, code: "lease_expired", hint: "Wait, then retry.",
    }));
    const hook = renderHook({ onRefreshStatuses });
    expect(await hook.onEnable({ ownerEmail: "owner@example.com" })).toBeNull();
    const next = renderHook({ onRefreshStatuses });
    expect(next.team).toMatchObject({ enabled: true, disableLegacyLogin: false });
    expect(next.enableError).toMatchObject({ message: "Gateway identity not verified", code: "lease_expired" });
    expect(next.enableResult).toBeNull();
    expect(next.enabling).toBe(false);
    expect(onRefreshStatuses).toHaveBeenCalledTimes(1);
  });

  describe("onOpenControlUi", () => {
    it("opens the server-side launcher synchronously for admins and members alike", () => {
      const openSpy = vi.fn();
      vi.stubGlobal("window", { open: openSpy });
      try {
        const hook = renderHook();

        const result = hook.onOpenControlUi();
        // Synchronous: no dashboard-URL fetch first (the launcher 302 resolves
        // the token server-side and keeps members tokenless via isAdminRequest),
        // so Safari's popup blocker never sees an async window.open.
        expect(result).toBeUndefined();
        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(openSpy).toHaveBeenCalledWith(
          "/gateway/launch",
          "_blank",
          "noopener",
        );
        for (const apiFn of Object.values(api)) {
          expect(apiFn).not.toHaveBeenCalled();
        }
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
