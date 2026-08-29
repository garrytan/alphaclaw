import { useEffect, useState } from "preact/hooks";

// Shared "current time" ticker for countdown/relative-time renders.
// - Pauses while the document is hidden (mirrors usePolling's
//   pauseWhenHidden) and refreshes immediately on return.
// - `enabled: false` skips the interval entirely so components with nothing
//   time-dependent on screen don't re-render every tick.
export const useNowMs = (intervalMs = 1000, { enabled = true } = {}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    let id = null;
    const start = () => {
      if (id != null) return;
      setNowMs(Date.now());
      id = setInterval(() => setNowMs(Date.now()), intervalMs);
    };
    const stop = () => {
      if (id != null) clearInterval(id);
      id = null;
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.hidden) stop();
      else start();
    };
    if (typeof document === "undefined" || !document.hidden) start();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [intervalMs, enabled]);

  return nowMs;
};
