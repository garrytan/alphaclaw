import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  kPopupWatchIntervalMs,
  watchPopupClosed,
} from "../../lib/public/js/lib/popup-watch.js";

describe("frontend/lib popup-watch (OAuth popup closed watcher)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onClosed exactly once when the popup closes, then stops polling", () => {
    const popup = { closed: false };
    const onClosed = vi.fn();
    watchPopupClosed(popup, onClosed);
    vi.advanceTimersByTime(kPopupWatchIntervalMs * 4);
    expect(onClosed).not.toHaveBeenCalled();
    popup.closed = true;
    vi.advanceTimersByTime(kPopupWatchIntervalMs);
    expect(onClosed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(kPopupWatchIntervalMs * 10);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() cancels the watch (unmount / a second click) and is idempotent", () => {
    const popup = { closed: false };
    const onClosed = vi.fn();
    const stop = watchPopupClosed(popup, onClosed);
    stop();
    stop();
    popup.closed = true;
    vi.advanceTimersByTime(kPopupWatchIntervalMs * 3);
    expect(onClosed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates a popup whose `closed` getter throws (cross-origin) and no popup at all", () => {
    const onClosed = vi.fn();
    const hostile = {
      get closed() {
        throw new Error("cross-origin");
      },
    };
    const stop = watchPopupClosed(hostile, onClosed);
    expect(() => vi.advanceTimersByTime(kPopupWatchIntervalMs * 2)).not.toThrow();
    expect(onClosed).not.toHaveBeenCalled();
    stop();
    expect(typeof watchPopupClosed(null, onClosed)).toBe("function");
    expect(typeof watchPopupClosed({ closed: false }, null)).toBe("function");
    expect(vi.getTimerCount()).toBe(0);
  });
});
