import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  armStoreUnavailableRecheck,
  cancelStoreUnavailableRecheck,
  kStoreUnavailableRecheckMs,
  settleStoreUnavailableRecheck,
} from "../../lib/public/js/lib/store-availability.js";

// While a store read is `unavailable` (state-DB backup barrier) nothing else
// re-reads it, so every adoption site arms ONE bounded timer per unavailable
// read (D14). Bounded means: never two timers, re-armed only by the next
// unavailable read, dropped by a readable one, cleared on unmount.
describe("frontend/store-availability recheck timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a ~30 s bound: short enough to clear a ~120 s barrier on its own, long enough never to look like polling", () => {
    expect(kStoreUnavailableRecheckMs).toBe(30000);
  });

  it("arms exactly ONE timer per site: a second arm while one is pending is a no-op", () => {
    const ref = { current: null };
    const recheck = vi.fn();
    expect(armStoreUnavailableRecheck(ref, recheck)).toBe(true);
    expect(armStoreUnavailableRecheck(ref, recheck)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(kStoreUnavailableRecheckMs - 1);
    expect(recheck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recheck).toHaveBeenCalledTimes(1);
    // The slot is free again once it fired, so the NEXT unavailable read can
    // re-arm — nothing re-arms by itself.
    expect(ref.current).toBeNull();
    vi.advanceTimersByTime(kStoreUnavailableRecheckMs * 3);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("settle: an unavailable read arms, a readable read drops the pending timer", () => {
    const ref = { current: null };
    const recheck = vi.fn();
    expect(settleStoreUnavailableRecheck(ref, { unavailable: true, recheck })).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(settleStoreUnavailableRecheck(ref, { unavailable: false, recheck })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(ref.current).toBeNull();
    vi.advanceTimersByTime(kStoreUnavailableRecheckMs * 2);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("cancel clears the timer (unmount) and tolerates an empty slot or a missing ref", () => {
    const ref = { current: null };
    armStoreUnavailableRecheck(ref, vi.fn());
    cancelStoreUnavailableRecheck(ref);
    expect(ref.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => cancelStoreUnavailableRecheck(ref)).not.toThrow();
    expect(() => cancelStoreUnavailableRecheck(null)).not.toThrow();
    expect(armStoreUnavailableRecheck(null, vi.fn())).toBe(false);
  });
});
