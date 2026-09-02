import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (use-general-tab.test.js pattern): hook state lives in
// per-call-index slots so the hook can be invoked directly without a DOM
// renderer. Effects are collected, not run.
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
  fetchWatchdogOverseer: vi.fn(),
  fetchWatchdogOverseerSituation: vi.fn(),
  requestWatchdogOverseerReview: vi.fn(),
  updateWatchdogOverseer: vi.fn(),
}));

// One controllable poll object: tests mutate `poll.data` between renders.
vi.mock("../../lib/public/js/hooks/usePolling.js", () => {
  const poll = { data: null, error: null, refresh: vi.fn(async () => null), isPolling: false };
  return { usePolling: vi.fn(() => poll), __poll: poll };
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

// Sibling tab hooks are out of scope here — stub their modules so this test
// only exercises the overseer slice.
vi.mock("../../lib/public/js/components/watchdog-tab/console/use-console.js", () => ({
  useWatchdogConsole: vi.fn(() => ({})),
}));
vi.mock("../../lib/public/js/components/watchdog-tab/incidents/use-incidents.js", () => ({
  useWatchdogIncidents: vi.fn(() => ({})),
}));
vi.mock("../../lib/public/js/components/watchdog-tab/resources/use-resources.js", () => ({
  useWatchdogResources: vi.fn(() => ({})),
}));
vi.mock("../../lib/public/js/components/watchdog-tab/settings/use-settings.js", () => ({
  useWatchdogSettings: vi.fn(() => ({})),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import * as pollingModule from "../../lib/public/js/hooks/usePolling.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import {
  kOverseerReviewCopy,
  useWatchdogOverseer,
} from "../../lib/public/js/components/watchdog-tab/use-watchdog-tab.js";

const harness = preactHooks.__harness;
const poll = pollingModule.__poll;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const kNow = Date.parse("2026-08-29T12:00:00Z");

const record = (overrides = {}) => ({
  state: "done",
  verdict: "watch",
  action: "none",
  headline: "Probes flapping",
  summary: "s",
  recommendation: "r",
  manual: true,
  situation: true,
  at: kNow,
  evidence: { collectedFrom: kNow - 60_000 },
  ...overrides,
});

const okReview = (rec = record(), extra = {}) => ({
  ok: true,
  result: { ran: true, mode: "situation", record: rec, persisted: true, ...extra },
});

const renderHook = (props = {}) => {
  harness.beginRender();
  return useWatchdogOverseer(props);
};

const runEffects = () => {
  const cleanups = [];
  for (const effect of [...harness.effects]) {
    const cleanup = effect?.();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
};

describe("frontend/watchdog-tab useWatchdogOverseer (lifted review state)", () => {
  beforeEach(() => {
    harness.reset();
    poll.data = null;
    poll.error = null;
    poll.refresh.mockClear();
    api.fetchWatchdogOverseer.mockResolvedValue({
      ok: true,
      enabled: true,
      availability: { available: true, reason: null, message: "ok" },
    });
    api.updateWatchdogOverseer.mockResolvedValue({ ok: true, enabled: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the situation endpoint unconditionally with the cache key + dedupe, regardless of the toggle", async () => {
    api.fetchWatchdogOverseer.mockResolvedValue({ ok: true, enabled: false, availability: null });
    renderHook();
    expect(pollingModule.usePolling).toHaveBeenCalledWith(
      api.fetchWatchdogOverseerSituation,
      15000,
      { cacheKey: "/api/watchdog/overseer/situation", dedupeInFlight: true },
    );
  });

  it("loads settings on mount, exposes enabled/availability, and re-probes a null availability (bounded)", async () => {
    vi.useFakeTimers();
    api.fetchWatchdogOverseer.mockResolvedValue({
      ok: true,
      enabled: true,
      availability: { available: null, reason: "probing", message: "" },
    });
    let state = renderHook();
    expect(state.settingsLoaded).toBe(false);
    runEffects();
    await flush();
    state = renderHook();
    expect(state.settingsLoaded).toBe(true);
    expect(state.enabled).toBe(true);
    expect(state.availability).toEqual({ available: null, reason: "probing", message: "" });

    // The probe effect schedules a 3s retry while available === null.
    api.fetchWatchdogOverseer.mockClear();
    api.fetchWatchdogOverseer.mockResolvedValue({
      ok: true,
      enabled: true,
      availability: { available: true, reason: null, message: "ok" },
    });
    // Skip the mount effect (index 0) — only the probe effect is under test.
    const probeEffect = harness.effects[1];
    const cleanup = probeEffect();
    expect(api.fetchWatchdogOverseer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.fetchWatchdogOverseer).toHaveBeenCalledTimes(1);
    cleanup?.();
    state = renderHook();
    expect(state.availability).toEqual({ available: true, reason: null, message: "ok" });
  });

  it("onToggle saves and toasts the new copy", async () => {
    let state = renderHook();
    await state.onToggle(true);
    expect(api.updateWatchdogOverseer).toHaveBeenCalledWith(true);
    expect(showToast).toHaveBeenCalledWith(kOverseerReviewCopy.toggleOn, "info");
    state = renderHook();
    expect(state.enabled).toBe(true);
    await state.onToggle(false);
    expect(showToast).toHaveBeenCalledWith(kOverseerReviewCopy.toggleOff, "info");
    expect(renderHook().enabled).toBe(false);
  });

  it("onReviewSituation: no incidentId, ephemeral set, toast, forced poll refresh, incidents refreshed", async () => {
    const onRefreshIncidents = vi.fn();
    const rec = record();
    api.requestWatchdogOverseerReview.mockResolvedValue(okReview(rec));
    const state = renderHook({ onRefreshIncidents });
    await state.onReviewSituation();
    expect(api.requestWatchdogOverseerReview).toHaveBeenCalledTimes(1);
    expect(api.requestWatchdogOverseerReview.mock.calls[0]).toEqual([]);
    const after = renderHook({ onRefreshIncidents });
    expect(after.ephemeral).toBe(rec);
    expect(after.reviewStatus).toBe(null);
    expect(after.reviewInFlight).toBe(null);
    expect(showToast).toHaveBeenCalledWith(kOverseerReviewCopy.situationReady, "success");
    expect(poll.refresh).toHaveBeenCalledWith({ force: true });
    expect(onRefreshIncidents).toHaveBeenCalledTimes(1);
  });

  it("one reviewInFlight value drives both paths: a concurrent incident review is a no-op", async () => {
    const pending = deferred();
    api.requestWatchdogOverseerReview.mockReturnValue(pending.promise);
    let state = renderHook();
    const running = state.onReviewSituation();
    state = renderHook();
    expect(state.reviewInFlight).toBe("situation");
    // Same-tick duplicate and a row click both bounce off the ref guard.
    await state.onReviewIncident(7);
    await state.onReviewSituation();
    expect(api.requestWatchdogOverseerReview).toHaveBeenCalledTimes(1);
    pending.resolve(okReview());
    await running;
    expect(renderHook().reviewInFlight).toBe(null);
  });

  it("persisted === false keeps the report ephemerally and raises the warning status bound to the record", async () => {
    const rec = record({ at: kNow + 5000 });
    api.requestWatchdogOverseerReview.mockResolvedValue({
      ok: true,
      message: "Report displayed but not saved (database write failed).",
      result: { ran: true, mode: "situation", record: rec, persisted: false },
    });
    await renderHook().onReviewSituation();
    const state = renderHook();
    expect(state.ephemeral).toBe(rec);
    expect(state.reviewStatus).toEqual({
      tone: "warning",
      text: "Report displayed but not saved (database write failed).",
      sinceAt: kNow + 5000,
    });
    expect(showToast).toHaveBeenCalledWith(kOverseerReviewCopy.situationReady, "success");
  });

  it("a refusal becomes an error status with the server message, baselined on the polled current", async () => {
    poll.data = { ok: true, current: { state: "failed", at: kNow - 1000 }, lastVerdict: null };
    const refusal = new Error("Manual reviews are limited to one every 2 minutes — try again in about 1m.");
    api.requestWatchdogOverseerReview.mockRejectedValue(refusal);
    await renderHook().onReviewSituation();
    const state = renderHook();
    expect(state.reviewStatus).toEqual({
      tone: "error",
      text: refusal.message,
      error: refusal,
      sinceAt: kNow - 1000,
    });
    expect(state.ephemeral).toBe(null);
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("a dropped connection mid-review shows the connection-lost copy as a muted line", async () => {
    api.requestWatchdogOverseerReview.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderHook().onReviewSituation();
    expect(renderHook().reviewStatus).toEqual({
      tone: "muted",
      text: kOverseerReviewCopy.connectionLost,
      sinceAt: 0,
    });
  });

  it("the next click clears the previous client-transient status and the ephemeral", async () => {
    api.requestWatchdogOverseerReview.mockRejectedValueOnce(new Error("busy"));
    await renderHook().onReviewSituation();
    expect(renderHook().reviewStatus?.text).toBe("busy");
    const pending = deferred();
    api.requestWatchdogOverseerReview.mockReturnValueOnce(pending.promise);
    const running = renderHook().onReviewSituation();
    expect(renderHook().reviewStatus).toBe(null);
    pending.resolve(okReview());
    await running;
  });

  it("onReviewIncident posts the id, toasts the recorded copy, refreshes incidents, and tracks the id in flight", async () => {
    const onRefreshIncidents = vi.fn();
    const pending = deferred();
    api.requestWatchdogOverseerReview.mockReturnValue(pending.promise);
    const running = renderHook({ onRefreshIncidents }).onReviewIncident(7);
    expect(renderHook({ onRefreshIncidents }).reviewInFlight).toBe(7);
    pending.resolve({
      ok: true,
      result: { ran: true, mode: "incident", incidentId: 7, record: record(), persisted: true },
    });
    await running;
    expect(api.requestWatchdogOverseerReview).toHaveBeenCalledWith({ incidentId: 7 });
    expect(showToast).toHaveBeenCalledWith("Review recorded on incident #7", "success");
    expect(onRefreshIncidents).toHaveBeenCalledTimes(1);
    // The server mutex is shared with the situation report: a stale
    // inFlight=true from the last poll must not hold the header button.
    expect(poll.refresh).toHaveBeenCalledWith({ force: true });
    const state = renderHook({ onRefreshIncidents });
    expect(state.reviewInFlight).toBe(null);
    expect(state.incidentReviewError).toBe(null);
    // The incident path never touches the situation ephemeral.
    expect(state.ephemeral).toBe(null);
  });

  it("a failed settings load still unblocks the card; a failed toggle save toasts and keeps the switch", async () => {
    api.fetchWatchdogOverseer.mockRejectedValue(new Error("offline"));
    renderHook();
    runEffects();
    await flush();
    expect(renderHook()).toMatchObject({ settingsLoaded: true, enabled: false, availability: null });
    api.updateWatchdogOverseer.mockRejectedValue(new Error("nope"));
    await renderHook().onToggle(true);
    expect(showToast).toHaveBeenCalledWith("nope", "error");
    const after = renderHook();
    expect(after.enabled).toBe(false);
    expect(after.saving).toBe(false);
  });

  it("onReviewIncident(null) never posts; an old server's incident-mode answer to the situation POST gets the generic toast", async () => {
    api.requestWatchdogOverseerReview.mockClear();
    await renderHook().onReviewIncident(null);
    expect(api.requestWatchdogOverseerReview).not.toHaveBeenCalled();
    // Version skew: a 0.9.68 server reviews the newest settled incident instead.
    api.requestWatchdogOverseerReview.mockResolvedValue({
      ok: true,
      result: { ran: true, incidentId: 3 },
    });
    await renderHook().onReviewSituation();
    expect(showToast).toHaveBeenCalledWith("Review finished", "success");
    expect(renderHook().ephemeral).toBe(null);
  });

  it("prefers the server's warning envelope message when a report was not saved", async () => {
    api.requestWatchdogOverseerReview.mockResolvedValue({
      ...okReview(record(), { persisted: false }),
      warning: { code: "persist_failed", message: "Server says: not saved." },
    });
    await renderHook().onReviewSituation();
    expect(renderHook().reviewStatus).toMatchObject({
      tone: "warning",
      text: "Server says: not saved.",
    });
    api.requestWatchdogOverseerReview.mockResolvedValue({
      ok: true,
      result: { ran: true, mode: "incident", incidentId: 4, record: { state: "done" }, persisted: false },
      warning: { code: "persist_failed", message: "Server says: not saved." },
    });
    await renderHook().onReviewIncident(4);
    expect(showToast).toHaveBeenCalledWith("Server says: not saved.", "warning");
  });

  it("onReviewIncident: persisted === false is a warning toast, not a success", async () => {
    api.requestWatchdogOverseerReview.mockResolvedValue({
      ok: true,
      message: "Report displayed but not saved (database write failed).",
      result: { ran: true, mode: "incident", incidentId: 7, record: record(), persisted: false },
    });
    await renderHook().onReviewIncident(7);
    expect(showToast).toHaveBeenCalledWith(
      "Report displayed but not saved (database write failed).",
      "warning",
    );
    expect(showToast).not.toHaveBeenCalledWith("Review recorded on incident #7", "success");
  });

  it("onReviewIncident failures land on the row (incidentReviewError), incl. connection-lost copy", async () => {
    const refusal = new Error("That incident is still ongoing — use Review current situation for the live picture.");
    api.requestWatchdogOverseerReview.mockRejectedValueOnce(refusal);
    await renderHook().onReviewIncident(9);
    expect(renderHook().incidentReviewError).toEqual({
      incidentId: 9,
      error: refusal,
      message: refusal.message,
    });
    api.requestWatchdogOverseerReview.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await renderHook().onReviewIncident(9);
    expect(renderHook().incidentReviewError).toEqual({
      incidentId: 9,
      error: null,
      message: kOverseerReviewCopy.connectionLost,
    });
    // Cleared by the next click of either button.
    const pending = deferred();
    api.requestWatchdogOverseerReview.mockReturnValueOnce(pending.promise);
    const running = renderHook().onReviewSituation();
    expect(renderHook().incidentReviewError).toBe(null);
    pending.resolve(okReview());
    await running;
  });

  it("primaryKind pin swaps the primary and resets to auto when a newer record arrives", () => {
    const incidents = [
      { id: 5, status: "resolved", overseer: { v: 1, current: { state: "done", at: kNow - 60_000 } } },
    ];
    poll.data = { ok: true, current: null, lastVerdict: record({ at: kNow }) };
    let state = renderHook({ incidents });
    expect(state.primaryKind).toBe("auto");
    state.onSelectPrimaryKind("incident");
    state = renderHook({ incidents });
    expect(state.primaryKind).toBe("incident");
    // A newer polled record anywhere drops the pin.
    poll.data = { ok: true, current: null, lastVerdict: record({ at: kNow + 10_000 }) };
    expect(renderHook({ incidents }).primaryKind).toBe("auto");
    // "auto" (or nothing) clears an existing pin explicitly.
    renderHook({ incidents }).onSelectPrimaryKind("situation");
    expect(renderHook({ incidents }).primaryKind).toBe("situation");
    renderHook({ incidents }).onSelectPrimaryKind("auto");
    expect(renderHook({ incidents }).primaryKind).toBe("auto");
  });

  it("exposes the polled situation and its error for the card", () => {
    poll.data = { ok: true, current: null, lastVerdict: null, nextManualAt: 0, inFlight: false };
    poll.error = null;
    let state = renderHook();
    expect(state.situation).toBe(poll.data);
    expect(state.situationError).toBe(null);
    poll.data = null;
    poll.error = new Error("not_wired");
    state = renderHook();
    expect(state.situation).toBe(null);
    expect(state.situationError).toBe(poll.error);
  });
});
