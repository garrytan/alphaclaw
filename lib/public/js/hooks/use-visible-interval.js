import { useEffect, useRef } from "preact/hooks";

// The ONE recurring-callback primitive for the Setup UI (fix wave PR 11).
// usePolling owns fetch+state pollers and useNowMs owns clocks; everything
// else that used to hand-roll `setInterval` (tree refresh, presence polls,
// popup-closed checks, keepalive pings) goes through here so the
// pause-when-hidden convention is enforced in one place and the structural
// guard (tests/server/guards/ui-intervals.guard.test.js) can stay at zero
// raw intervals.
//
// - `pauseWhenHidden` (default true): no ticks while document.hidden; the
//   callback runs once immediately when the tab becomes visible again.
// - `pauseWhenHidden: false` is for work the hidden tab must keep doing
//   (WebSocket keepalive, outbox flush, "did the OAuth popup close").
// - `immediate`: run the callback once when the interval (re)starts.
// The latest callback is always the one that fires (ref-backed), so callers
// pass plain closures without stabilizing them.
export const useVisibleInterval = (
  callback,
  intervalMs,
  { enabled = true, pauseWhenHidden = true, immediate = false } = {},
) => {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return undefined;
    let id = null;
    const tick = () => {
      try {
        // Returns the callback's result (usually a promise) so a captured
        // interval callback can be awaited in tests; the interval ignores it.
        return callbackRef.current?.();
      } catch {
        // A throwing tick must not kill the interval or bubble into Preact.
        return undefined;
      }
    };
    const hidden = () =>
      pauseWhenHidden && typeof document !== "undefined" && document.hidden;
    // window's timers when there is a window (browser code always scheduled
    // through it; tests stub them there), bare globals otherwise.
    const timers = typeof window !== "undefined" ? window : globalThis;
    const start = ({ runNow }) => {
      if (id != null) return;
      if (runNow) tick();
      id = timers.setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (id != null) timers.clearInterval(id);
      id = null;
    };
    const onVisibility = () => {
      if (hidden()) stop();
      else start({ runNow: true });
    };
    if (!hidden()) start({ runNow: immediate });
    if (pauseWhenHidden && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      stop();
      if (pauseWhenHidden && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [enabled, intervalMs, pauseWhenHidden, immediate]);
};
