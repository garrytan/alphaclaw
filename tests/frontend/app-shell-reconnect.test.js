import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectivityMonitor,
  createReachabilityPoller,
  kOnboardRetryDelaysMs,
  kReconnectBudgetMs,
  startOnboardStatusLoad,
} from "../../lib/public/js/hooks/use-app-shell-controller.js";
import {
  buildGlobalBannerModel,
  kReconnectingBannerText,
  kUnreachableBannerText,
} from "../../lib/public/js/components/global-restart-banner.js";

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("frontend/app-shell reconnect flow (M3.4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("SSE+poll failure → reconnecting banner → budget exhaustion → escape hatch + Retry", () => {
    let now = 0;
    const modes = [];
    const monitor = createConnectivityMonitor({
      onChange: (mode) => modes.push(mode),
      now: () => now,
    });

    // First failed poll while the stream is down: reconnecting.
    monitor.recordFailure();
    expect(monitor.getMode()).toBe("reconnecting");
    expect(
      buildGlobalBannerModel({
        shell: { connectivityMode: monitor.getMode(), restartRequired: true },
      }).text,
    ).toBe(kReconnectingBannerText);

    // Failures keep arriving inside the budget: still reconnecting.
    now += kReconnectBudgetMs - 1;
    monitor.recordFailure();
    expect(monitor.getMode()).toBe("reconnecting");

    // Budget exhausted: escape-hatch copy with a manual Retry.
    now += 1;
    monitor.recordFailure();
    expect(monitor.getMode()).toBe("unreachable");
    const model = buildGlobalBannerModel({
      shell: { connectivityMode: monitor.getMode() },
    });
    expect(model.text).toBe(kUnreachableBannerText);
    expect(model.showRetry).toBe(true);

    // Unreachable is sticky across further failures (no flapping back).
    monitor.recordFailure();
    expect(monitor.getMode()).toBe("unreachable");

    // Retry restarts the budget.
    monitor.retry();
    expect(monitor.getMode()).toBe("reconnecting");
    now += kReconnectBudgetMs;
    monitor.recordFailure();
    expect(monitor.getMode()).toBe("unreachable");

    // A frame (SSE or successful poll) always restores online.
    monitor.recordFrame();
    expect(monitor.getMode()).toBe("online");
    expect(modes).toEqual([
      "reconnecting",
      "unreachable",
      "reconnecting",
      "unreachable",
      "online",
    ]);
  });

  it("reachability poller reloads only once a poll succeeds — never on a timer alone", async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ ok: true });
    const onSuccess = vi.fn();
    const onExhausted = vi.fn();
    createReachabilityPoller({
      poll,
      intervalMs: 3000,
      graceMs: 5000,
      maxAttempts: 40,
      onSuccess,
      onExhausted,
    });

    // Grace window: nothing happens before it elapses.
    await vi.advanceTimersByTimeAsync(4999);
    expect(poll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(onSuccess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    // Once reachable, the poller stops.
    await vi.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("isReady gates the reload: a reachable poll still reporting the OLD process keeps polling (managed updates)", async () => {
    // Managed updates only trigger an external deploy — the old process keeps
    // serving /api/status, so "reachable" must not mean "ready": the poller
    // reloads only once the polled payload reports a different version.
    const responses = [
      { alphaclawVersion: "0.9.34" },
      { alphaclawVersion: "0.9.34" },
      { alphaclawVersion: "0.9.35" },
    ];
    const poll = vi.fn(async () => responses.shift() || { alphaclawVersion: "0.9.35" });
    const onSuccess = vi.fn();
    const onExhausted = vi.fn();
    createReachabilityPoller({
      poll,
      intervalMs: 3000,
      graceMs: 8000,
      maxAttempts: 40,
      isReady: (payload) => payload?.alphaclawVersion !== "0.9.34",
      onSuccess,
      onExhausted,
    });

    // First poll succeeds against the still-running old process: no reload.
    await vi.advanceTimersByTimeAsync(8000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(onSuccess).not.toHaveBeenCalled();

    // The platform swapped the deploy in: NOW the reload fires.
    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("not-ready polls consume the attempt budget and exhaust into the escape hatch", async () => {
    const poll = vi.fn(async () => ({ alphaclawVersion: "0.9.34" }));
    const onSuccess = vi.fn();
    const onExhausted = vi.fn();
    createReachabilityPoller({
      poll,
      intervalMs: 3000,
      maxAttempts: 5,
      isReady: () => false,
      onSuccess,
      onExhausted,
    });
    await vi.advanceTimersByTimeAsync(3000 * 10);
    expect(poll).toHaveBeenCalledTimes(5);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("reachability poller gives up after the attempt budget", async () => {
    const poll = vi.fn().mockRejectedValue(new Error("down"));
    const onSuccess = vi.fn();
    const onExhausted = vi.fn();
    createReachabilityPoller({
      poll,
      intervalMs: 3000,
      maxAttempts: 5,
      onSuccess,
      onExhausted,
    });
    await vi.advanceTimersByTimeAsync(3000 * 10);
    expect(poll).toHaveBeenCalledTimes(5);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("reachability poller can be cancelled", async () => {
    const poll = vi.fn().mockRejectedValue(new Error("down"));
    const cancel = createReachabilityPoller({ poll, intervalMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledTimes(1);
    cancel();
    await vi.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("frontend/onboard status retry with backoff (M3.4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a failed fetch never resolves onboarded=false — it retries with backoff", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ onboarded: true });
    const onResolved = vi.fn();
    startOnboardStatusLoad({
      fetchOnboardStatusFn: fetchFn,
      onResolved,
      delaysMs: [1000, 2000, 4000],
    });

    await flushMicrotasks();
    // The slow-boot bug: this used to call setOnboarded(false) and show the
    // wizard to an onboarded user. Now: no resolution, just a retry.
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await flushMicrotasks();
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith(true);

    // No further polling once resolved.
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("backoff is capped at the last delay and keeps retrying", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("down"));
    startOnboardStatusLoad({
      fetchOnboardStatusFn: fetchFn,
      onResolved: vi.fn(),
      delaysMs: [1000, 2000],
    });
    await flushMicrotasks();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // Capped: every further retry uses the final delay.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("an un-onboarded answer still resolves false (real wizard case)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ onboarded: false });
    const onResolved = vi.fn();
    startOnboardStatusLoad({ fetchOnboardStatusFn: fetchFn, onResolved });
    await flushMicrotasks();
    expect(onResolved).toHaveBeenCalledWith(false);
  });

  it("dispose stops pending retries", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("down"));
    const stop = startOnboardStatusLoad({
      fetchOnboardStatusFn: fetchFn,
      onResolved: vi.fn(),
      delaysMs: [1000],
    });
    await flushMicrotasks();
    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("exports sensible default backoff delays", () => {
    expect(kOnboardRetryDelaysMs[0]).toBeGreaterThan(0);
    expect(kOnboardRetryDelaysMs.length).toBeGreaterThan(1);
  });
});
