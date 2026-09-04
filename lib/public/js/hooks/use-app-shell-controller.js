import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import {
  fetchStatus,
  fetchOnboardStatus,
  fetchAuthStatus,
  fetchAuthIdentity,
  fetchAlphaclawVersion,
  updateAlphaclaw,
  fetchRestartStatus,
  dismissRestartStatus,
  restartGatewayAsync,
  subscribeGatewayRestartEvents,
  resumeWatchdogChannels,
  rollbackOpenclaw,
  fetchWatchdogStatus,
  fetchDoctorStatus,
  subscribeStatusEvents,
} from "../lib/api.js";
import { shouldRequireRestartForBrowsePath } from "../lib/browse-restart-policy.js";
import { gatewayShellStore } from "../components/restart-progress-card.js";
import { usePolling } from "./usePolling.js";
import { showToast } from "../components/toast.js";

// ---------------------------------------------------------------------------
// M3.4 helpers (exported for tests)
// ---------------------------------------------------------------------------

// A failed /api/onboarded fetch means AlphaClaw is unreachable or still
// booting — NOT that the user is un-onboarded. Retry with backoff instead of
// dropping an onboarded user into the setup wizard.
export const kOnboardRetryDelaysMs = [1000, 2000, 4000, 8000, 10000];

export const startOnboardStatusLoad = ({
  fetchOnboardStatusFn = fetchOnboardStatus,
  onResolved = () => {},
  delaysMs = kOnboardRetryDelaysMs,
} = {}) => {
  let disposed = false;
  let timerId = null;
  let attempt = 0;
  const load = () => {
    fetchOnboardStatusFn()
      .then((data) => {
        if (!disposed) onResolved(!!data?.onboarded);
      })
      .catch(() => {
        if (disposed) return;
        const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
        attempt += 1;
        timerId = setTimeout(load, delay);
      });
  };
  load();
  return () => {
    disposed = true;
    if (timerId) clearTimeout(timerId);
  };
};

// Outage state machine for the status feed: frames flip it online, repeated
// failures walk reconnecting → unreachable once the budget is spent.
// "unreachable" is sticky until a frame arrives or the user retries.
export const kReconnectBudgetMs = 120000;

export const createConnectivityMonitor = ({
  budgetMs = kReconnectBudgetMs,
  onChange = () => {},
  now = () => Date.now(),
} = {}) => {
  let mode = "online";
  let outageStartedAt = null;
  const setMode = (next) => {
    if (mode === next) return;
    mode = next;
    onChange(mode);
  };
  return {
    getMode: () => mode,
    recordFrame: () => {
      outageStartedAt = null;
      setMode("online");
    },
    recordFailure: () => {
      if (outageStartedAt == null) outageStartedAt = now();
      if (mode === "unreachable") return;
      setMode(
        now() - outageStartedAt >= budgetMs ? "unreachable" : "reconnecting",
      );
    },
    retry: () => {
      outageStartedAt = now();
      setMode("reconnecting");
    },
  };
};

// Post-self-restart reachability poller (the Upgrade tab's reconnect
// pattern): poll /api/status every `intervalMs` for up to `maxAttempts`;
// reload only once a poll succeeds — never a blind timed reload.
export const kReachabilityPollIntervalMs = 3000;
export const kReachabilityPollMaxAttempts = 40; // ~2 minutes at 3s cadence
// Managed deploys build + swap out-of-band (minutes, not seconds).
export const kManagedUpdatePollMaxAttempts = 100; // ~5 minutes at 3s cadence

export const createReachabilityPoller = ({
  poll,
  intervalMs = kReachabilityPollIntervalMs,
  graceMs = 0,
  maxAttempts = kReachabilityPollMaxAttempts,
  isReady = null,
  onSuccess = () => {},
  onExhausted = () => {},
} = {}) => {
  let cancelled = false;
  let timerId = null;
  let attempts = 0;
  const attempt = async () => {
    if (cancelled) return;
    attempts += 1;
    try {
      const payload = await poll();
      // Reachable is not always ready: a managed deploy keeps the OLD
      // process serving until the platform swaps it, so callers can gate
      // success on the polled payload (e.g. a changed version). A not-ready
      // poll counts as an attempt and keeps polling.
      if (typeof isReady !== "function" || isReady(payload)) {
        if (!cancelled) onSuccess();
        return;
      }
    } catch {
      // Still restarting.
    }
    if (cancelled) return;
    if (attempts >= maxAttempts) {
      onExhausted();
      return;
    }
    timerId = setTimeout(attempt, intervalMs);
  };
  timerId = setTimeout(attempt, graceMs > 0 ? graceMs : intervalMs);
  return () => {
    cancelled = true;
    if (timerId) clearTimeout(timerId);
  };
};

// The two routes that render the Gateway card; operation outcomes reaching
// the user elsewhere surface as toasts instead.
const isGatewaySurfaceLocation = (location = "") =>
  String(location || "").startsWith("/general") ||
  String(location || "").startsWith("/watchdog");

const kOptimisticStepName = "__requesting";
const kSuccessCollapseMs = 8000;

export const useAppShellController = ({ location = "" } = {}) => {
  const kInitialStatusPollDelayMs = 5000;
  // The server guarantees >=1 status frame per 10s (heartbeat); a connected
  // stream that has been silent for longer than this is treated as hung.
  const kStatusStreamStaleAfterMs = 15000;
  const kStatusStreamStaleCheckIntervalMs = 5000;
  const [onboarded, setOnboarded] = useState(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  // "admin" (legacy or member-admin) | "member" | null while unknown.
  const [identityRole, setIdentityRole] = useState(null);
  const [acVersion, setAcVersion] = useState(null);
  const [acCurrentOpenclawVersion, setAcCurrentOpenclawVersion] = useState(null);
  const [acLatest, setAcLatest] = useState(null);
  const [acLatestOpenclawVersion, setAcLatestOpenclawVersion] = useState(null);
  const [acHasUpdate, setAcHasUpdate] = useState(false);
  const [acUpdateStrategy, setAcUpdateStrategy] = useState(null);
  const [acUpdating, setAcUpdating] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [restartReasons, setRestartReasons] = useState([]);
  const [browseRestartRequired, setBrowseRestartRequired] = useState(false);
  const [serverRestartInProgress, setServerRestartInProgress] = useState(false);
  const [restartOperation, setRestartOperation] = useState(null);
  const [gatewayRestartSignal, setGatewayRestartSignal] = useState(0);
  const [statusPollCadenceMs, setStatusPollCadenceMs] = useState(15000);
  const [statusPollingGraceElapsed, setStatusPollingGraceElapsed] = useState(false);
  const [statusStreamConnected, setStatusStreamConnected] = useState(false);
  const [statusStreamStatus, setStatusStreamStatus] = useState(null);
  const [statusStreamWatchdog, setStatusStreamWatchdog] = useState(null);
  const [statusStreamDoctor, setStatusStreamDoctor] = useState(null);
  // Bumping this re-runs the stream effect: the old EventSource is closed by
  // the effect cleanup and a fresh one is opened (SSE staleness fallback).
  const [statusStreamGeneration, setStatusStreamGeneration] = useState(0);
  const [connectivityMode, setConnectivityMode] = useState("online");
  // null | { mode: "restarting" | "unreachable" } — AlphaClaw self-restart
  // reconnect flow (update / rollback). Overrides the outage monitor.
  const [selfRestart, setSelfRestart] = useState(null);
  // null | { message, backupFile } — second-stage rollback fence (issue #20):
  // the server refused the rollback with 409 rollback_requires_confirmation
  // because the update migrated the state DBs. The Gateway card renders the
  // data-risk confirm off this slice.
  const [rollbackDataRisk, setRollbackDataRisk] = useState(null);
  const lastStatusFrameAtRef = useRef(0);
  // Latest-ref delegation for shell actions (stable identities across
  // renders so store subscribers only re-render on real state changes).
  const shellActionsRef = useRef({});
  const stableShellActionsRef = useRef(null);
  if (!stableShellActionsRef.current) {
    const stable = {};
    for (const key of [
      "restart",
      "refresh",
      "resumeChannels",
      "rollBack",
      "confirmRollbackDataRisk",
      "cancelRollbackDataRisk",
      "dismissOutcome",
      "dismissRestartBanner",
      "loadEvidence",
      "retryConnect",
      "openSetup",
    ]) {
      stable[key] = (...args) => shellActionsRef.current[key]?.(...args);
    }
    stableShellActionsRef.current = stable;
  }
  const locationRef = useRef(location);
  locationRef.current = location;
  const restartOperationRef = useRef(null);
  const restartSubscriptionRef = useRef(null);
  const acknowledgedOperationIdRef = useRef(null);
  const successCollapseTimerRef = useRef(null);
  const resolveTimerRef = useRef(null);
  const selfRestartPollerCleanupRef = useRef(null);
  const selfRestartPollerOptionsRef = useRef(null);
  const connectivityMonitorRef = useRef(null);
  if (!connectivityMonitorRef.current) {
    connectivityMonitorRef.current = createConnectivityMonitor({
      onChange: setConnectivityMode,
    });
  }

  const sharedStatusPoll = usePolling(fetchStatus, statusPollCadenceMs, {
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
  const sharedStatus = statusStreamStatus || sharedStatusPoll.data || null;
  const sharedWatchdogStatus =
    statusStreamWatchdog || sharedWatchdogPoll.data?.status || null;
  const sharedDoctorStatus =
    statusStreamDoctor || sharedDoctorPoll.data?.status || null;
  const isAnyRestartRequired = restartRequired || browseRestartRequired;
  const restartingGateway =
    restartOperation?.phase === "running" || serverRestartInProgress;

  const refreshSharedStatuses = useCallback(() => {
    sharedStatusPoll.refresh();
    sharedWatchdogPoll.refresh();
    sharedDoctorPoll.refresh();
  }, [sharedDoctorPoll.refresh, sharedStatusPoll.refresh, sharedWatchdogPoll.refresh]);

  // ---------------------------------------------------------------------
  // Restart operation pipeline (M3): optimistic start, SSE step stream,
  // honest terminal outcomes, restart-safe rehydration.
  //
  // The mutually-recursive handlers below live on a ref so SSE callbacks
  // (bound once at subscribe time) always dispatch to the latest render's
  // implementations without stale closures.
  // ---------------------------------------------------------------------
  const controllerRef = useRef({});

  const updateRestartOperation = useCallback((updater) => {
    setRestartOperation((previous) => {
      const next = typeof updater === "function" ? updater(previous) : updater;
      restartOperationRef.current = next;
      return next;
    });
  }, []);

  const clearRestartSubscription = () => {
    if (restartSubscriptionRef.current) {
      try {
        restartSubscriptionRef.current();
      } catch {}
      restartSubscriptionRef.current = null;
    }
    if (resolveTimerRef.current) {
      clearTimeout(resolveTimerRef.current);
      resolveTimerRef.current = null;
    }
  };

  const dismissRestartOutcome = useCallback(() => {
    const current = restartOperationRef.current;
    if (!current || current.phase === "running") return;
    if (current.operationId) {
      acknowledgedOperationIdRef.current = current.operationId;
    }
    if (successCollapseTimerRef.current) {
      clearTimeout(successCollapseTimerRef.current);
      successCollapseTimerRef.current = null;
    }
    updateRestartOperation(null);
  }, [updateRestartOperation]);

  const finishOperationSuccess = ({ durationMs = null, downtimeMs = null }) => {
    clearRestartSubscription();
    updateRestartOperation((operation) =>
      operation
        ? {
            ...operation,
            phase: "succeeded",
            durationMs: Number.isFinite(durationMs) ? durationMs : null,
            downtimeMs: Number.isFinite(downtimeMs) ? downtimeMs : null,
          }
        : operation,
    );
    setBrowseRestartRequired(false);
    setGatewayRestartSignal(Date.now());
    refreshSharedStatuses();
    controllerRef.current.refreshRestartStatus?.();
    // Toast only when the outcome lands while the user is on another page —
    // on General/Watchdog the card itself announces it.
    if (!isGatewaySurfaceLocation(locationRef.current)) {
      const seconds = Number.isFinite(downtimeMs)
        ? downtimeMs
        : Number.isFinite(durationMs)
          ? durationMs
          : null;
      showToast(
        seconds != null
          ? `Gateway restarted — ready in ${Math.max(1, Math.round(seconds / 1000))}s`
          : "Gateway restarted",
        "success",
      );
    }
    if (successCollapseTimerRef.current) {
      clearTimeout(successCollapseTimerRef.current);
    }
    successCollapseTimerRef.current = setTimeout(() => {
      controllerRef.current.dismissRestartOutcome?.();
    }, kSuccessCollapseMs);
  };

  // Policy refusals from the restart route (fast gate OR post-lock re-check):
  // nothing ran, so there is no failed restart to show — clear the card and
  // say why. The server books these as "skipped" in the incident ledger and
  // stamps the record with the code so a reload never resurrects them.
  const kRestartPolicyRefusalCodes = new Set([
    "apply_in_progress",
    "gateway_held",
    "gateway_hold_unreadable",
    "booting",
  ]);
  const isPolicyRefusalCode = (code) =>
    typeof code === "string" && kRestartPolicyRefusalCodes.has(code);
  const kPolicyRefusalFallbackCopy = {
    apply_in_progress:
      "A channel update is in progress — wait for it to finish before restarting.",
    gateway_held:
      "The gateway is held after a failed settings migration — resolve it on the Upgrade page.",
    gateway_hold_unreadable:
      "AlphaClaw could not read the gateway hold state — restart refused until it is readable.",
    booting: "AlphaClaw is still starting the gateway — wait for boot to finish.",
  };
  const dismissPolicyRefusal = ({ message, code }) => {
    clearRestartSubscription();
    updateRestartOperation(null);
    showToast(message || kPolicyRefusalFallbackCopy[code] || "Gateway restart refused", "error");
    refreshSharedStatuses();
    controllerRef.current.refreshRestartStatus?.();
  };

  const finishOperationFailure = ({ message, hint = null, code = null }) => {
    clearRestartSubscription();
    updateRestartOperation((operation) =>
      operation
        ? {
            ...operation,
            phase: "failed",
            error: {
              message: message || "Gateway restart failed",
              hint: hint || null,
              code: code || null,
            },
          }
        : operation,
    );
    setGatewayRestartSignal(Date.now());
    refreshSharedStatuses();
    controllerRef.current.refreshRestartStatus?.();
    if (!isGatewaySurfaceLocation(locationRef.current)) {
      showToast(message || "Gateway restart failed", "error");
    }
  };

  // The SSE stream dropped mid-operation: resolve the outcome from the
  // persisted record instead of leaving the card spinning forever.
  const resolveOperationFromServer = async (operationId) => {
    const stillCurrent = () =>
      restartOperationRef.current?.operationId === operationId &&
      restartOperationRef.current?.phase === "running";
    if (!stillCurrent()) return;
    let data = null;
    try {
      data = await fetchRestartStatus();
    } catch {
      if (!stillCurrent()) return;
      resolveTimerRef.current = setTimeout(
        () => controllerRef.current.resolveOperationFromServer?.(operationId),
        3000,
      );
      return;
    }
    if (!stillCurrent()) return;
    const last = data?.lastOperation;
    if (last?.operationId === operationId && last.status !== "running") {
      if (last.status === "succeeded") {
        finishOperationSuccess({
          durationMs: last.durationMs ?? null,
          downtimeMs: last.downtimeMs ?? null,
        });
      } else if (isPolicyRefusalCode(last.code)) {
        dismissPolicyRefusal({ message: last.errorSummary, code: last.code });
      } else {
        finishOperationFailure({
          message: last.errorSummary || "Gateway restart failed",
        });
      }
      return;
    }
    // Still running: reattach shortly (SSE replay restores the step list).
    resolveTimerRef.current = setTimeout(() => {
      if (stillCurrent()) {
        controllerRef.current.attachToRestartOperation?.(operationId, {
          resumed: true,
        });
      }
    }, 2000);
  };

  const attachToRestartOperation = (operationId, { resumed = false } = {}) => {
    clearRestartSubscription();
    updateRestartOperation((operation) => ({
      operationId,
      startedAt: operation?.startedAt || Date.now(),
      phase: "running",
      // Resumed attaches rebuild steps from the SSE replay; fresh attaches
      // keep the optimistic placeholder until the first real step lands.
      steps: resumed ? [] : operation?.steps || [],
      error: null,
      durationMs: null,
      downtimeMs: null,
      resumed: !!resumed,
    }));
    try {
      restartSubscriptionRef.current = subscribeGatewayRestartEvents({
        operationId,
        onMessage: ({ event, data }) => {
          if (event === "step") {
            updateRestartOperation((operation) => {
              if (!operation || operation.operationId !== operationId) {
                return operation;
              }
              const steps = operation.steps.filter(
                (step) => String(step?.name || "") !== kOptimisticStepName,
              );
              return { ...operation, steps: [...steps, data] };
            });
            return;
          }
          if (event === "done") {
            controllerRef.current.finishOperationSuccess?.({
              durationMs: data?.durationMs ?? null,
              downtimeMs: data?.downtimeMs ?? null,
            });
            return;
          }
          if (event === "error") {
            if (isPolicyRefusalCode(data?.code)) {
              // Queued-then-refused (post-lock hold/apply): not a failure.
              dismissPolicyRefusal({ message: data?.error, code: data.code });
              return;
            }
            controllerRef.current.finishOperationFailure?.({
              message: data?.error || "Gateway restart failed",
              hint: data?.hint || null,
              code: data?.code || null,
            });
          }
        },
        onError: () => {
          clearRestartSubscription();
          controllerRef.current.resolveOperationFromServer?.(operationId);
        },
      });
    } catch {
      // EventSource unsupported: fall back to polling the persisted record.
      controllerRef.current.resolveOperationFromServer?.(operationId);
    }
  };

  const handleGatewayRestart = useCallback(async () => {
    if (restartOperationRef.current?.phase === "running") return;
    if (successCollapseTimerRef.current) {
      clearTimeout(successCollapseTimerRef.current);
      successCollapseTimerRef.current = null;
    }
    // Optimistic first frame: the progress card renders before the 202 lands.
    updateRestartOperation({
      operationId: null,
      startedAt: Date.now(),
      phase: "running",
      steps: [
        {
          name: kOptimisticStepName,
          label: "Contacting AlphaClaw…",
          status: "running",
        },
      ],
      error: null,
      durationMs: null,
      downtimeMs: null,
      resumed: false,
    });
    try {
      const data = await restartGatewayAsync();
      if (data?.attached) {
        showToast(
          "Another operation is running — attached to its progress",
          "info",
        );
      }
      if (data?.operationId) {
        controllerRef.current.attachToRestartOperation?.(data.operationId, {
          resumed: !!data?.attached,
        });
      } else {
        // Version skew: an old server ignored ?async=1 and completed the
        // restart synchronously.
        controllerRef.current.finishOperationSuccess?.({});
      }
    } catch (err) {
      // Policy refusals (409) are not failed restarts: nothing ran, so there
      // is no progress card to leave up — clear it and say why. Both codes
      // come from the route's readRestartBlocker (fast gate or post-lock).
      if (isPolicyRefusalCode(err?.code)) {
        dismissPolicyRefusal({ message: err.message, code: err.code });
        return;
      }
      controllerRef.current.finishOperationFailure?.({
        message: err?.message || "Could not restart gateway",
      });
    }
  }, [updateRestartOperation]);

  const refreshRestartStatus = useCallback(async () => {
    if (!onboarded) return;
    try {
      const data = await fetchRestartStatus();
      setRestartRequired(!!data.restartRequired);
      setServerRestartInProgress(!!data.restartInProgress);
      setRestartReasons(Array.isArray(data.reasons) ? data.reasons : []);
      const current = restartOperationRef.current;
      const active = data.activeOperation;
      if (
        active?.operationId &&
        active.status === "running" &&
        (!current || current.phase !== "running")
      ) {
        // A restart is already running (other tab, or page reload mid-op):
        // attach; SSE replay restores the step list.
        controllerRef.current.attachToRestartOperation?.(active.operationId, {
          resumed: true,
        });
        return;
      }
      if (!current) {
        const last = data.lastOperation;
        const failed =
          last &&
          (last.status === "failed" || last.status === "interrupted") &&
          // A policy refusal never ran — it is not a failed restart to revive.
          !isPolicyRefusalCode(last.code) &&
          acknowledgedOperationIdRef.current !== last.operationId;
        if (failed) {
          // Terminal outcomes survive reloads until acknowledged/superseded.
          updateRestartOperation({
            operationId: last.operationId,
            startedAt: last.startedAt || Date.now(),
            phase: "failed",
            steps: [],
            error: {
              message: last.errorSummary || "Gateway restart failed",
              hint: null,
              code: null,
            },
            durationMs: last.durationMs ?? null,
            downtimeMs: last.downtimeMs ?? null,
            resumed: true,
          });
        }
      }
    } catch {}
  }, [onboarded, updateRestartOperation]);

  const loadRestartEvidence = useCallback(async (operationId) => {
    // Failure evidence is served by reference — fetched on demand, never in
    // status frames. null → the card renders "Evidence expired".
    try {
      const data = await fetchRestartStatus();
      const last = data?.lastOperation;
      if (last?.operationId === operationId && last.evidence) {
        return last.evidence;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  // Server action id "setup" (the not_onboarded state's only action): the
  // setup surface the app already owns is the Welcome wizard, gated on
  // `onboarded` — the state is reachable while the client-side flag is true
  // (onboarding marker present but openclaw.json missing), so flip the gate.
  const handleOpenSetup = useCallback(() => {
    setOnboarded(false);
  }, []);

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
    setSelfRestart({ mode: "restarting" });
    selfRestartPollerCleanupRef.current = createReachabilityPoller({
      poll: fetchStatus,
      graceMs,
      isReady,
      ...(maxAttempts != null ? { maxAttempts } : {}),
      onSuccess: () => window.location.reload(),
      onExhausted: () => setSelfRestart({ mode: "unreachable" }),
    });
  }, []);

  // Both rollback attempts (initial and data-risk-confirmed) share the same
  // success handling: announce and hand off to the reconnect poller.
  const runGatewayRollback = useCallback(
    async ({ confirmDataRisk = false } = {}) => {
      setRollbackDataRisk(null);
      try {
        await rollbackOpenclaw(confirmDataRisk ? { confirmDataRisk: true } : {});
        showToast(
          "Rolling back to the last known-good build — AlphaClaw is restarting",
          "info",
        );
        beginAlphaclawReconnect({ graceMs: 3000 });
      } catch (err) {
        if (err?.code === "rollback_requires_confirmation") {
          // Rollback fence (issue #20): this update migrated the state DBs.
          // Not a failure — raise the second-stage data-risk confirm naming
          // the verified pre-update backup instead of toasting an error.
          setRollbackDataRisk({
            message: err.message || null,
            backupFile: err.backupFile || null,
          });
          return;
        }
        showToast(err?.message || "Could not roll back OpenClaw", "error");
      }
    },
    [beginAlphaclawReconnect],
  );

  const handleGatewayRollback = useCallback(
    () => runGatewayRollback(),
    [runGatewayRollback],
  );

  const confirmRollbackDataRisk = useCallback(
    () => runGatewayRollback({ confirmDataRisk: true }),
    [runGatewayRollback],
  );

  const cancelRollbackDataRisk = useCallback(
    () => setRollbackDataRisk(null),
    [],
  );

  const handleRetryConnect = useCallback(() => {
    if (selfRestart) {
      // Reuse the original poller options (minus the grace window — the
      // restart happened long ago) so retries keep the readiness check.
      beginAlphaclawReconnect({
        ...(selfRestartPollerOptionsRef.current || {}),
        graceMs: 0,
      });
      return;
    }
    connectivityMonitorRef.current.retry();
    setStatusStreamGeneration((generation) => generation + 1);
    refreshSharedStatuses();
  }, [beginAlphaclawReconnect, refreshSharedStatuses, selfRestart]);

  controllerRef.current.refreshRestartStatus = refreshRestartStatus;
  controllerRef.current.dismissRestartOutcome = dismissRestartOutcome;
  controllerRef.current.finishOperationSuccess = finishOperationSuccess;
  controllerRef.current.finishOperationFailure = finishOperationFailure;
  controllerRef.current.resolveOperationFromServer = resolveOperationFromServer;
  controllerRef.current.attachToRestartOperation = attachToRestartOperation;

  useEffect(
    () => () => {
      clearRestartSubscription();
      stopSelfRestartPoller();
      if (successCollapseTimerRef.current) {
        clearTimeout(successCollapseTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const stopOnboardLoad = startOnboardStatusLoad({
      onResolved: setOnboarded,
    });
    fetchAuthStatus()
      .then((data) => setAuthEnabled(!!data.authEnabled))
      .catch(() => {});
    fetchAuthIdentity()
      .then((data) => setIdentityRole(data?.identity?.role || null))
      .catch(() => {});
    return stopOnboardLoad;
  }, []);

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
            connectivityMonitorRef.current.recordFrame();
            if (payload.status && typeof payload.status === "object") {
              setStatusStreamStatus(payload.status);
            }
            if (payload.watchdogStatus && typeof payload.watchdogStatus === "object") {
              setStatusStreamWatchdog(payload.watchdogStatus);
            }
            if (payload.doctorStatus && typeof payload.doctorStatus === "object") {
              setStatusStreamDoctor(payload.doctorStatus);
            }
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
      setStatusStreamConnected(false);
      if (typeof cleanup === "function") {
        cleanup();
      }
    };
  }, [onboarded, statusStreamGeneration]);

  // SSE staleness fallback: the heartbeat guarantees frames while healthy, so
  // a "connected" stream with no frames for >15s is hung. Flip the stream to
  // disconnected (re-enabling the polling fallback) and reopen it.
  useEffect(() => {
    if (onboarded !== true || !statusStreamConnected) return;
    const staleCheckId = setInterval(() => {
      const lastFrameAt = lastStatusFrameAtRef.current || 0;
      if (Date.now() - lastFrameAt > kStatusStreamStaleAfterMs) {
        setStatusStreamConnected(false);
        setStatusStreamGeneration((generation) => generation + 1);
      }
    }, kStatusStreamStaleCheckIntervalMs);
    return () => clearInterval(staleCheckId);
  }, [onboarded, statusStreamConnected]);

  // Reconnecting detection (M3.4): a successful poll is a frame; a failed
  // poll while the stream is down is an outage observation. The monitor walks
  // reconnecting → unreachable once the ~2min budget is spent.
  useEffect(() => {
    if (onboarded !== true) return;
    if (!sharedStatusPoll.data) return;
    lastStatusFrameAtRef.current = Date.now();
    connectivityMonitorRef.current.recordFrame();
  }, [onboarded, sharedStatusPoll.data]);

  // A latched stream frame must never shadow fresher polling-fallback data:
  // once a poll result lands (SSE staleness fallback, or a manual/post-restart
  // refresh), drop the stream copy so the selectors at the top render the
  // fresh data. The next stream frame re-takes precedence when it arrives.
  useEffect(() => {
    if (!sharedStatusPoll.data) return;
    setStatusStreamStatus(null);
  }, [sharedStatusPoll.data]);
  useEffect(() => {
    if (!sharedWatchdogPoll.data) return;
    setStatusStreamWatchdog(null);
  }, [sharedWatchdogPoll.data]);
  useEffect(() => {
    if (!sharedDoctorPoll.data) return;
    setStatusStreamDoctor(null);
  }, [sharedDoctorPoll.data]);

  useEffect(() => {
    if (onboarded !== true) return;
    if (statusStreamConnected) return;
    if (!sharedStatusPoll.error) return;
    connectivityMonitorRef.current.recordFailure();
  }, [onboarded, sharedStatusPoll.error, statusStreamConnected]);

  useEffect(() => {
    if (!onboarded) return;
    let active = true;
    const check = async (refresh = false) => {
      try {
        const data = await fetchAlphaclawVersion(refresh);
        if (!active) return;
        setAcVersion(data.currentVersion || null);
        setAcCurrentOpenclawVersion(data.currentOpenclawVersion || null);
        setAcLatest(data.latestVersion || null);
        setAcLatestOpenclawVersion(data.latestOpenclawVersion || null);
        setAcHasUpdate(!!data.hasUpdate);
        setAcUpdateStrategy(data.updateStrategy || null);
      } catch {}
    };
    // Non-refresh on mount: refresh=true bypassed the server's 10-minute
    // version cache on every page load. The periodic re-check stays non-refresh.
    check(false);
    const id = setInterval(() => check(false), 5 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [onboarded]);

  useEffect(() => {
    if (!onboarded) return;
    refreshRestartStatus();
  }, [onboarded, refreshRestartStatus]);

  useEffect(() => {
    if (onboarded !== true) return;
    const inStatusView =
      location.startsWith("/general") || location.startsWith("/watchdog");
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
    const reconnectFastPoll = connectivityMode !== "online";
    const nextCadenceMs =
      reconnectFastPoll || (inStatusView && (shouldFastPollWatchdog || shouldFastPollGateway))
        ? 2000
        : 15000;
    setStatusPollCadenceMs((currentCadenceMs) =>
      currentCadenceMs === nextCadenceMs ? currentCadenceMs : nextCadenceMs,
    );
  }, [
    connectivityMode,
    location,
    onboarded,
    sharedStatus?.gateway,
    sharedWatchdogStatus?.health,
    sharedWatchdogStatus?.lifecycle,
    sharedWatchdogStatus?.operationInProgress,
  ]);

  useEffect(() => {
    if (!onboarded || (!restartRequired && !restartingGateway)) return;
    const id = setInterval(refreshRestartStatus, 2000);
    return () => clearInterval(id);
  }, [onboarded, restartRequired, restartingGateway, refreshRestartStatus]);

  useEffect(() => {
    const handleBrowseFileSaved = (event) => {
      const savedPath = String(event?.detail?.path || "");
      if (!shouldRequireRestartForBrowsePath(savedPath)) return;
      setBrowseRestartRequired(true);
    };
    window.addEventListener("alphaclaw:browse-file-saved", handleBrowseFileSaved);
    return () => {
      window.removeEventListener("alphaclaw:browse-file-saved", handleBrowseFileSaved);
    };
  }, []);
  useEffect(() => {
    const handleRestartRequired = () => setRestartRequired(true);
    window.addEventListener("alphaclaw:restart-required", handleRestartRequired);
    return () => {
      window.removeEventListener("alphaclaw:restart-required", handleRestartRequired);
    };
  }, []);

  const handleAcUpdate = useCallback(async () => {
    if (acUpdating) return;
    setAcUpdating(true);
    try {
      const data = await updateAlphaclaw();
      if (data.ok) {
        showToast(
          data.managedUpdate
            ? "Deployment update started — reconnecting..."
            : "AlphaClaw updated — restarting...",
          "success",
        );
        // Reconnect pattern instead of a blind timed reload: give the old
        // process a grace window to exit, then poll until a status call
        // succeeds and reload only then. A managed update only triggers an
        // external deploy while the OLD process keeps serving, so a reachable
        // /api/status is not enough — reload only once the polled process
        // reports a different AlphaClaw version (the platform swapped it in).
        beginAlphaclawReconnect(
          data.managedUpdate
            ? {
                graceMs: 8000,
                maxAttempts: kManagedUpdatePollMaxAttempts,
                isReady: (payload) => {
                  const previous = String(data.previousVersion || "");
                  const reported = String(payload?.alphaclawVersion || "");
                  // Without a discriminator (version-skew), fall back to
                  // reachable-means-ready rather than never reloading.
                  if (!previous) return true;
                  return !!reported && reported !== previous;
                },
              }
            : { graceMs: 5000 },
        );
      } else {
        showToast(data.error || "AlphaClaw update failed", "error");
        setAcUpdating(false);
      }
    } catch (err) {
      showToast(err.message || "Could not update AlphaClaw", "error");
      setAcUpdating(false);
    }
  }, [acUpdating, beginAlphaclawReconnect]);

  const dismissRestartBanner = useCallback(async () => {
    setRestartRequired(false);
    setBrowseRestartRequired(false);
    setRestartReasons([]);
    try {
      await dismissRestartStatus();
      await refreshRestartStatus();
    } catch (err) {
      showToast(err.message || "Could not dismiss restart banner", "error");
      await refreshRestartStatus();
    }
  }, [refreshRestartStatus]);

  // Publish the gateway-facing slice for the Gateway card and global banner
  // (they render in trees this hook's props don't reach).
  const combinedConnectivityMode = selfRestart
    ? selfRestart.mode === "restarting"
      ? "alphaclaw_restarting"
      : "unreachable"
    : connectivityMode;

  useEffect(() => {
    // Stable action identities: the handlers close over per-render state, so
    // publish latest-ref delegates instead — the store's shallow compare can
    // then skip no-change publishes (each 2s frame re-renders this hook).
    shellActionsRef.current = {
      restart: handleGatewayRestart,
      refresh: refreshSharedStatuses,
      resumeChannels: handleResumeChannels,
      rollBack: handleGatewayRollback,
      confirmRollbackDataRisk,
      cancelRollbackDataRisk,
      dismissOutcome: dismissRestartOutcome,
      dismissRestartBanner,
      loadEvidence: loadRestartEvidence,
      retryConnect: handleRetryConnect,
      openSetup: handleOpenSetup,
    };
    gatewayShellStore.publish({
      hasStatus: !!sharedStatus,
      statusState: sharedStatus?.state || null,
      legacyGatewayStatus: sharedStatus?.gateway || null,
      watchdogStatus: sharedWatchdogStatus,
      restartOperation,
      restartRequired: isAnyRestartRequired,
      restartReasons,
      connectivityMode: combinedConnectivityMode,
      rollbackDataRisk,
      lastFrameAtMs: lastStatusFrameAtRef.current || 0,
      actions: stableShellActionsRef.current,
    });
  });

  return {
    state: {
      acHasUpdate,
      acLatest,
      acLatestOpenclawVersion,
      acCurrentOpenclawVersion,
      acUpdateStrategy,
      acUpdating,
      acVersion,
      authEnabled,
      connectivityMode: combinedConnectivityMode,
      gatewayRestartSignal,
      identityRole,
      isAnyRestartRequired,
      onboarded,
      restartOperation,
      restartReasons,
      restartingGateway,
      sharedDoctorStatus,
      sharedStatus,
      sharedWatchdogStatus,
    },
    actions: {
      handleAcUpdate,
      handleGatewayRestart,
      handleOnboardingComplete: () => setOnboarded(true),
      handleRetryConnect,
      refreshSharedStatuses,
      dismissRestartBanner,
      dismissRestartOutcome,
      setRestartRequired,
    },
  };
};
