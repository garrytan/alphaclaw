import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import {
  fetchStatus,
  resumeWatchdogChannels,
  fetchWatchdogStatus,
  fetchDoctorStatus,
  subscribeStatusEvents,
} from "../../lib/api.js";
import { usePolling } from "../usePolling.js";
import { useVisibleInterval } from "../use-visible-interval.js";
import { createStatusIngestion } from "../../lib/status-ingestion.js";
import { isGatewaySurfaceLocation } from "../../lib/routes.js";
import { showToast } from "../../components/toast.js";

const kInitialStatusPollDelayMs = 5000;
// The server guarantees >=1 status frame per 10s (heartbeat); a connected
// stream that has been silent for longer than this is treated as hung.
const kStatusStreamStaleAfterMs = 15000;
const kStatusStreamStaleCheckIntervalMs = 5000;

// The shared status feed: the /api/status event stream, its polling fallback
// (status, watchdog and Doctor) and how fresh the last observation is.
// `connectivity` is useConnectivity's result: frames and poll failures
// drive its outage monitor and boot tracker.
export const useStatusFeed = ({ location, onboarded, connectivity }) => {
  const { monitor, bootTracker, feedMode } = connectivity;
  const [statusPollCadenceMs, setStatusPollCadenceMs] = useState(15000);
  const [statusPollingGraceElapsed, setStatusPollingGraceElapsed] = useState(false);
  const [statusStreamConnected, setStatusStreamConnected] = useState(false);
  const [statusStreamStatus, setStatusStreamStatus] = useState(null);
  const [statusStreamWatchdog, setStatusStreamWatchdog] = useState(null);
  const [statusStreamDoctor, setStatusStreamDoctor] = useState(null);
  const [statusFreshness, setStatusFreshness] = useState({ mode: "unknown", observedAtMs: 0, receivedAtMs: 0 });
  const statusIngestionRef = useRef(null);
  if (!statusIngestionRef.current) statusIngestionRef.current = createStatusIngestion();
  const pollReceiptsRef = useRef(new WeakMap());
  // Bumping this re-runs the stream effect: the old EventSource is closed by
  // the effect cleanup and a fresh one is opened (SSE staleness fallback).
  const [statusStreamGeneration, setStatusStreamGeneration] = useState(0);
  const lastStatusFrameAtRef = useRef(0);

  const fetchStatusForShell = useCallback(async () => {
    const request = statusIngestionRef.current.beginRequest();
    const payload = await fetchStatus();
    if (payload && typeof payload === "object") pollReceiptsRef.current.set(payload, request);
    return payload;
  }, []);
  const sharedStatusPoll = usePolling(fetchStatusForShell, statusPollCadenceMs, {
    enabled:
      onboarded === true && !statusStreamConnected && statusPollingGraceElapsed,
    cacheKey: "/api/status",
  });
  const sharedWatchdogPoll = usePolling(fetchWatchdogStatus, statusPollCadenceMs, {
    enabled:
      onboarded === true && !statusStreamConnected && statusPollingGraceElapsed,
    cacheKey: "/api/watchdog/status",
  });
  const sharedDoctorPoll = usePolling(fetchDoctorStatus, statusPollCadenceMs, {
    enabled:
      onboarded === true && !statusStreamConnected && statusPollingGraceElapsed,
    cacheKey: "/api/doctor/status",
  });
  const sharedStatus = statusStreamStatus;
  const sharedWatchdogStatus =
    statusStreamWatchdog || (statusIngestionRef.current.get()?.epoch ? null : sharedWatchdogPoll.data?.status) || null;
  const sharedDoctorStatus =
    statusStreamDoctor || (statusIngestionRef.current.get()?.epoch ? null : sharedDoctorPoll.data?.status) || null;
  const ingestStatus = useCallback((payload, context = {}) => {
    const ingestion = statusIngestionRef.current;
    const accepted = ingestion.accept(payload, context);
    setStatusFreshness(ingestion.getFreshness());
    if (!accepted) return false;
    const snapshot = ingestion.get();
    bootTracker.recordStatusFrame(snapshot.status?.bootProgress || null);
    setStatusStreamStatus(snapshot.status);
    if (snapshot.watchdogStatus !== undefined) setStatusStreamWatchdog(snapshot.watchdogStatus);
    if (snapshot.doctorStatus !== undefined) setStatusStreamDoctor(snapshot.doctorStatus);
    return true;
  }, []);
  const refreshSharedStatuses = useCallback(() => {
    sharedStatusPoll.refresh();
    sharedWatchdogPoll.refresh();
    sharedDoctorPoll.refresh();
  }, [sharedDoctorPoll.refresh, sharedStatusPoll.refresh, sharedWatchdogPoll.refresh]);

  const handleResumeChannels = useCallback(async () => {
    try {
      const data = await resumeWatchdogChannels();
      if (data?.ok === false) {
        throw new Error(data?.error || "Could not resume channels");
      }
      showToast("Channels resumed", "success");
      refreshSharedStatuses();
    } catch (err) {
      showToast(err.message || "Could not resume channels", "error");
    }
  }, [refreshSharedStatuses]);

  // Reopens the status stream (the effect cleanup closes the old
  // EventSource) and re-reads the polled statuses.
  const reconnect = useCallback(() => {
    setStatusStreamGeneration((generation) => generation + 1);
    refreshSharedStatuses();
  }, [refreshSharedStatuses]);

  useEffect(() => {
    if (onboarded !== true) {
      setStatusPollingGraceElapsed(false);
      return () => {};
    }
    const timerId = setTimeout(() => {
      setStatusPollingGraceElapsed(true);
    }, kInitialStatusPollDelayMs);
    return () => {
      clearTimeout(timerId);
    };
  }, [onboarded]);

  useEffect(() => {
    if (onboarded !== true) return;
    let disposed = false;
    const stream = statusIngestionRef.current.beginStream();
    const startStream = () => {
      if (disposed) return;
      try {
        return subscribeStatusEvents({
          onOpen: () => {
            if (disposed) return;
            lastStatusFrameAtRef.current = Date.now();
            setStatusStreamConnected(true);
          },
          onMessage: (payload = {}) => {
            if (disposed) return;
            lastStatusFrameAtRef.current = Date.now();
            monitor.recordFrame();
            ingestStatus(payload, { stream });
          },
          onError: () => {
            if (disposed) return;
            setStatusStreamConnected(false);
          },
        });
      } catch {
        setStatusStreamConnected(false);
        return null;
      }
    };
    let cleanup = startStream();
    return () => {
      disposed = true;
      statusIngestionRef.current.endStream(stream);
      setStatusStreamConnected(false);
      if (typeof cleanup === "function") {
        cleanup();
      }
    };
  }, [onboarded, statusStreamGeneration]);

  // One existing visibility-aware clock checks delivery liveness and ages
  // the last successful observation. Stale heartbeats only prove transport.
  useVisibleInterval(() => {
    const freshness = statusIngestionRef.current.getFreshness();
    setStatusFreshness((current) => current.mode === freshness.mode &&
      current.observedAtMs === freshness.observedAtMs ? current : freshness);
    if (statusStreamConnected && Date.now() - lastStatusFrameAtRef.current > kStatusStreamStaleAfterMs) {
      setStatusStreamConnected(false);
      setStatusStreamGeneration((generation) => generation + 1);
    }
  }, kStatusStreamStaleCheckIntervalMs, { enabled: onboarded === true });

  useEffect(() => {
    if (onboarded !== true || !sharedStatusPoll.data) return;
    const request = pollReceiptsRef.current.get(sharedStatusPoll.data) || null;
    if (request) monitor.recordFrame();
    ingestStatus(sharedStatusPoll.data, { request });
  }, [onboarded, sharedStatusPoll.data, ingestStatus]);

  // Old servers do not include the companion samples in their status
  // response. Keep their existing independent fallback reads, but never let
  // an unversioned companion overwrite a modern atomic status snapshot.
  useEffect(() => {
    if (statusIngestionRef.current.get()?.epoch || !sharedWatchdogPoll.data) return;
    setStatusStreamWatchdog(sharedWatchdogPoll.data.status || null);
  }, [sharedWatchdogPoll.data]);
  useEffect(() => {
    if (statusIngestionRef.current.get()?.epoch || !sharedDoctorPoll.data) return;
    setStatusStreamDoctor(sharedDoctorPoll.data.status || null);
  }, [sharedDoctorPoll.data]);

  useEffect(() => {
    if (onboarded !== true) return;
    if (statusStreamConnected) return;
    if (!sharedStatusPoll.error) return;
    monitor.recordFailure();
    bootTracker.recordOutage();
  }, [onboarded, sharedStatusPoll.error, statusStreamConnected]);

  useEffect(() => {
    if (onboarded !== true) return;
    const inStatusView = isGatewaySurfaceLocation(location);
    const gatewayStatus = sharedStatus?.gateway ?? null;
    const watchdogHealth = String(sharedWatchdogStatus?.health || "").toLowerCase();
    const watchdogLifecycle = String(sharedWatchdogStatus?.lifecycle || "").toLowerCase();
    const shouldFastPollWatchdog =
      watchdogHealth === "unknown" ||
      watchdogLifecycle === "restarting" ||
      watchdogLifecycle === "stopped" ||
      !!sharedWatchdogStatus?.operationInProgress;
    const shouldFastPollGateway = !gatewayStatus || gatewayStatus !== "running";
    // While the feed is in an outage the polls double as the reconnect probe.
    const reconnectFastPoll = feedMode !== "online";
    const nextCadenceMs =
      reconnectFastPoll || (inStatusView && (shouldFastPollWatchdog || shouldFastPollGateway))
        ? 2000
        : 15000;
    setStatusPollCadenceMs((currentCadenceMs) =>
      currentCadenceMs === nextCadenceMs ? currentCadenceMs : nextCadenceMs,
    );
  }, [
    feedMode,
    location,
    onboarded,
    sharedStatus?.gateway,
    sharedWatchdogStatus?.health,
    sharedWatchdogStatus?.lifecycle,
    sharedWatchdogStatus?.operationInProgress,
  ]);

  return {
    sharedStatus,
    sharedWatchdogStatus,
    sharedDoctorStatus,
    statusFreshness,
    lastStatusFrameAtRef,
    refreshSharedStatuses,
    reconnect,
    handleResumeChannels,
  };
};
