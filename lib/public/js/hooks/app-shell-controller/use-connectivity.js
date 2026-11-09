import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { fetchStatus, fetchBootProgress } from "../../lib/api.js";
import { createBootReconnectTracker, stageLabelOf } from "../../lib/boot-reconnect.js";
import {
  kReconnectBudgetMs,
  createConnectivityMonitor,
  createReachabilityPoller,
} from "../../lib/shell-connectivity.js";
import { usePolling } from "../usePolling.js";

// Whether the browser can reach AlphaClaw: the status feed's outage monitor,
// the AlphaClaw self-restart reconnect (update) and the boot progress probe
// that says whether something is still booting while the feed is down.
export const useConnectivity = ({ onboarded }) => {
  const [connectivityMode, setConnectivityMode] = useState("online");
  // null | { mode: "restarting" | "unreachable" } — AlphaClaw self-restart
  // reconnect flow (update). Overrides the outage monitor.
  const [selfRestart, setSelfRestart] = useState(null);
  const selfRestartPollerCleanupRef = useRef(null);
  const selfRestartPollerOptionsRef = useRef(null);
  const bootTrackerRef = useRef(null);
  if (!bootTrackerRef.current) bootTrackerRef.current = createBootReconnectTracker({ budgetMs: kReconnectBudgetMs });
  const bootReconnectRef = useRef({ mode: "online" });
  const connectivityMonitorRef = useRef(null);
  if (!connectivityMonitorRef.current) {
    connectivityMonitorRef.current = createConnectivityMonitor({
      onChange: setConnectivityMode,
    });
  }

  // --- AlphaClaw self-restart reconnect (M3.4) --------------------------
  const stopSelfRestartPoller = () => {
    if (selfRestartPollerCleanupRef.current) {
      selfRestartPollerCleanupRef.current();
      selfRestartPollerCleanupRef.current = null;
    }
  };

  const beginAlphaclawReconnect = useCallback((options = {}) => {
    const { graceMs = 0, isReady = null, maxAttempts = null } = options;
    stopSelfRestartPoller();
    // Remembered so a manual Retry keeps the same readiness discriminator —
    // a managed update must never reload against the old process.
    selfRestartPollerOptionsRef.current = options;
    bootTrackerRef.current.recordOutage();
    setSelfRestart({ mode: "restarting" });
    selfRestartPollerCleanupRef.current = createReachabilityPoller({
      poll: fetchStatus,
      graceMs,
      isReady,
      keepWaiting: () => ["preparing", "booting"].includes(bootTrackerRef.current.getState().mode),
      ...(maxAttempts != null ? { maxAttempts } : {}),
      onSuccess: () => window.location.reload(),
      onExhausted: () => setSelfRestart({ mode: "unreachable" }),
    });
  }, []);

  // Returns true when it retried a self-restart reconnect; otherwise the
  // outage monitor goes back to reconnecting and the caller reopens the feed.
  const retry = useCallback(() => {
    if (selfRestart) {
      // Reuse the original poller options (minus the grace window — the
      // restart happened long ago) so retries keep the readiness check.
      beginAlphaclawReconnect({
        ...(selfRestartPollerOptionsRef.current || {}),
        graceMs: 0,
      });
      return true;
    }
    connectivityMonitorRef.current.retry();
    return false;
  }, [beginAlphaclawReconnect, selfRestart]);

  useEffect(() => () => stopSelfRestartPoller(), []);

  const baseConnectivityMode = selfRestart
    ? selfRestart.mode === "restarting"
      ? "alphaclaw_restarting"
      : "unreachable"
    : connectivityMode;
  // While AlphaClaw is unreachable for the status feed, the public boot
  // progress says whether something is still booting (placeholder or real
  // server) — separate from liveness; see lib/boot-reconnect.js.
  const bootProbeEnabled = onboarded === true && baseConnectivityMode !== "online";
  const bootProbe = usePolling(
    async () => {
      const frame = await fetchBootProgress();
      bootTrackerRef.current.recordProbe(frame);
      return { frame, at: Date.now() };
    },
    3000,
    { enabled: bootProbeEnabled, cacheKey: "/boot-progress.json" },
  );
  void bootProbe.data;
  const bootReconnectState = bootTrackerRef.current.getState();
  {
    const next = {
      mode: bootReconnectState.mode,
      count: bootReconnectState.count || 0,
      label: bootReconnectState.frame?.label || null,
      stageLabel: stageLabelOf(bootReconnectState.frame),
    };
    const previous = bootReconnectRef.current;
    if (previous.mode !== next.mode || previous.count !== next.count || previous.label !== next.label || previous.stageLabel !== next.stageLabel) {
      bootReconnectRef.current = next;
    }
  }
  let combinedConnectivityMode = baseConnectivityMode;
  if (bootReconnectState.mode === "restart_loop") combinedConnectivityMode = "restart_loop";
  else if (baseConnectivityMode !== "online") {
    if (bootReconnectState.mode === "preparing" || bootReconnectState.mode === "booting") combinedConnectivityMode = "alphaclaw_booting";
    else if (bootReconnectState.mode === "stalled") combinedConnectivityMode = "alphaclaw_stalled";
    else if (bootReconnectState.mode === "stuck") combinedConnectivityMode = "alphaclaw_stuck";
  }

  return {
    // The status feed's own outage mode (it sets the poll cadence).
    feedMode: connectivityMode,
    connectivityMode: combinedConnectivityMode,
    bootReconnect: bootReconnectRef.current,
    monitor: connectivityMonitorRef.current,
    bootTracker: bootTrackerRef.current,
    beginAlphaclawReconnect,
    retry,
  };
};
