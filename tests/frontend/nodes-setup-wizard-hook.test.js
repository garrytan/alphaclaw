import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as use-saved-setting.test.js): hook
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
  fetchDevicePairings: vi.fn(),
  fetchNodeConnectInfo: vi.fn(),
  rejectDevice: vi.fn(),
  routeExecToNode: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useSetupWizard } from "../../lib/public/js/components/nodes-tab/setup-wizard/use-setup-wizard.js";

const harness = preactHooks.__harness;

const renderWizard = (options = {}) => {
  harness.beginRender();
  return useSetupWizard({ visible: true, ...options });
};

describe("frontend/nodes setup wizard hook", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    api.fetchDevicePairings.mockResolvedValue({ pending: [] });
  });

  it("rethrows approve failures so DeviceRow can clear busy and surface the error", async () => {
    const error = new Error("approve exploded");
    api.approveDevice.mockRejectedValue(error);
    const refreshNodes = vi.fn(async () => {});
    const state = renderWizard({ refreshNodes });

    await expect(state.handleDeviceApprove("req-1")).rejects.toBe(error);
    expect(showToast).toHaveBeenCalledWith("approve exploded", "error");
    // A failed approve must not refresh — nothing changed server-side.
    expect(refreshNodes).not.toHaveBeenCalled();
  });

  it("rethrows reject failures so DeviceRow can clear busy and surface the error", async () => {
    const error = new Error("reject exploded");
    api.rejectDevice.mockRejectedValue(error);
    const state = renderWizard({ refreshNodes: vi.fn(async () => {}) });

    await expect(state.handleDeviceReject("req-1")).rejects.toBe(error);
    expect(showToast).toHaveBeenCalledWith("reject exploded", "error");
  });

  it("does not report a refresh failure as an approval failure", async () => {
    api.approveDevice.mockResolvedValue({});
    const refreshNodes = vi.fn(async () => {
      throw new Error("refresh boom");
    });
    const state = renderWizard({ refreshNodes });

    await expect(state.handleDeviceApprove("req-1")).resolves.toBeUndefined();
    expect(showToast).toHaveBeenCalledWith("Pairing approved", "success");
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("does not report a refresh failure as a rejection failure", async () => {
    api.rejectDevice.mockResolvedValue({});
    const refreshNodes = vi.fn(async () => {
      throw new Error("refresh boom");
    });
    const state = renderWizard({ refreshNodes });

    await expect(state.handleDeviceReject("req-1")).resolves.toBeUndefined();
    expect(showToast).toHaveBeenCalledWith("Pairing rejected", "info");
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("refreshes the node list after a successful approve", async () => {
    api.approveDevice.mockResolvedValue({});
    api.fetchDevicePairings.mockResolvedValue({ pending: [{ id: "d2" }] });
    const refreshNodes = vi.fn(async () => {});
    const state = renderWizard({ refreshNodes });

    await state.handleDeviceApprove("req-1");
    expect(refreshNodes).toHaveBeenCalledTimes(1);
    expect(api.fetchDevicePairings).toHaveBeenCalledTimes(1);

    const next = renderWizard({ refreshNodes });
    expect(next.devicePending).toEqual([{ id: "d2" }]);
    expect(next.approvedInSession).toBe(true);
  });
});
