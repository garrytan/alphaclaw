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

const harness = preactHooks.__harness;

const renderHook = (props = {}) => {
  harness.beginRender();
  return useTeamTab(props);
};

describe("frontend/use-team-tab", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
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
