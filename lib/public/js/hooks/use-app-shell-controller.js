import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import {
  fetchStatus,
  fetchAuthStatus,
  fetchAuthIdentity,
  fetchRestartStatus,
  dismissRestartStatus,
  restartGatewayAsync,
  retryUpgradeAsync,
  confirmWorkspaceMoveAsync,
  fetchUpgradeStatus,
  subscribeGatewayRestartEvents,
  resumeWatchdogChannels,
  fetchWatchdogStatus,
  fetchDoctorStatus,
  subscribeStatusEvents,
  fetchBootProgress,
} from "../lib/api.js";
import { createBootReconnectTracker, stageLabelOf } from "../lib/boot-reconnect.js";
import { shouldRequireRestartForBrowsePath } from "../lib/browse-restart-policy.js";
import {
  gatewayShellStore,
  kOptimisticStepName,
  kUpgradeOperationKind,
} from "../components/restart-progress-card.js";
import { usePolling } from "./usePolling.js";
import { useManagedUpdateAttempt } from "./use-managed-update-attempt.js";
import { useVisibleInterval } from "./use-visible-interval.js";
import { createStatusIngestion } from "../lib/status-ingestion.js";
import { showToast } from "../components/toast.js";
import { kBrowseFileSavedEvent, kRestartRequiredEvent } from "../lib/ui-events.js";
import {
  startOnboardStatusLoad,
  kReconnectBudgetMs,
  createConnectivityMonitor,
  createReachabilityPoller,
} from "../lib/shell-connectivity.js";

// The two routes that render the Gateway card; operation outcomes reaching
// the user elsewhere surface as toasts instead.
const isGatewaySurfaceLocation = (location = "") =>
  String(location || "").startsWith("/general") ||
  String(location || "").startsWith("/watchdog");

const kSuccessCollapseMs = 8000;
// The upgrade alert changes only on a Doctor run or an admin action (both
// refresh it explicitly); the poll is the slow safety net.
const kUpgradeStatusPollMs = 60_000;
// A policy refusal is an info line, not an outcome: it clears on its own.
const kRefusalNoticeMs = 10000;
// A failed outcome retires once the gateway has been observed Running for
// this long — the user can see for themselves that the box recovered.
export const kFailedOutcomeRetireAfterRunningMs = 60000;

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
  const acManagedUpdate = useManagedUpdateAttempt({ enabled: onboarded === true, identityRole });
  const acVersion = acManagedUpdate.version?.currentVersion || null;
  const acCurrentOpenclawVersion = acManagedUpdate.version?.currentOpenclawVersion || null;
  const acLatest = acManagedUpdate.version?.latestVersion || null;
  const acLatestOpenclawVersion = acManagedUpdate.version?.latestOpenclawVersion || null;
  const acHasUpdate = Boolean(acManagedUpdate.version?.hasUpdate);
  const acUpdateStrategy = acManagedUpdate.version?.updateStrategy || null;
  const [acUpdating, setAcUpdating] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [restartReasons, setRestartReasons] = useState([]);
  const [browseRestartRequired, setBrowseRestartRequired] = useState(false);
  const [serverRestartInProgress, setServerRestartInProgress] = useState(false);
  const [restartOperation, setRestartOperation] = useState(null);
  const [restartNotice, setRestartNotice] = useState(null);
  const [gatewayRestartSignal, setGatewayRestartSignal] = useState(0);
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
  const [connectivityMode, setConnectivityMode] = useState("online");
  // null | { mode: "restarting" | "unreachable" } — AlphaClaw self-restart
  // reconnect flow (update). Overrides the outage monitor.
  const [selfRestart, setSelfRestart] = useState(null);
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
      "dismissOutcome",
      "dismissRestartBanner",
      "loadEvidence",
      "retryConnect",
      "openSetup",
      "retryUpgrade",
      "confirmWorkspaceMove",
      "refreshUpgradeStatus",
    ]) {
      stable[key] = (...args) => shellActionsRef.current[key]?.(...args);
    }
    stableShellActionsRef.current = stable;
  }
  const locationRef = useRef(location);
  locationRef.current = location;
  const restartOperationRef = useRef(null);
  const restartSubscriptionRef = useRef(null);
  // Operation ids whose terminal outcome was retired (dismissed, superseded
  // by a new attempt, or outlived by a Running gateway): a refresh must never
  // resurrect any of them, however the server orders its records.
  const acknowledgedOperationIdsRef = useRef(new Set());
  const successCollapseTimerRef = useRef(null);
  const refusalNoticeTimerRef = useRef(null);
  const resolveTimerRef = useRef(null);
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
  // The OpenClaw data upgrade alert: one shared read (the alert, the
  // Gateway card pointer and the banner all hydrate from this cache key).
  const upgradeStatusPoll = usePolling(fetchUpgradeStatus, kUpgradeStatusPollMs, {
    enabled: onboarded === true,
    cacheKey: "/api/openclaw/upgrade-status",
  });
  const upgradeAlertRef = useRef(null);
  {
    const alert = upgradeStatusPoll.data?.alert || null;
    const previous = upgradeAlertRef.current;
    if (!alert) upgradeAlertRef.current = null;
    else if (previous?.kind !== alert.kind || previous?.headline !== alert.headline) {
      upgradeAlertRef.current = { kind: alert.kind, headline: alert.headline };
    }
  }
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
    bootTrackerRef.current.recordStatusFrame(snapshot.status?.bootProgress || null);
    setStatusStreamStatus(snapshot.status);
    if (snapshot.watchdogStatus !== undefined) setStatusStreamWatchdog(snapshot.watchdogStatus);
    if (snapshot.doctorStatus !== undefined) setStatusStreamDoctor(snapshot.doctorStatus);
    return true;
  }, []);
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
      acknowledgedOperationIdsRef.current.add(current.operationId);
    }
    if (successCollapseTimerRef.current) {
      clearTimeout(successCollapseTimerRef.current);
      successCollapseTimerRef.current = null;
    }
    updateRestartOperation(null);
  }, [updateRestartOperation]);

  const finishOperationSuccess = ({ durationMs = null, downtimeMs = null, how = null, observedExitsCount = null, upgrade = null, retryTarget = null }) => {
    clearRestartSubscription();
    const isUpgrade = restartOperationRef.current?.kind === kUpgradeOperationKind;
    updateRestartOperation((operation) =>
      operation
        ? {
            ...operation,
            phase: "succeeded",
            durationMs: Number.isFinite(durationMs) ? durationMs : null,
            downtimeMs: Number.isFinite(downtimeMs) ? downtimeMs : null,
            how: how || null,
            observedExitsCount: Number.isFinite(observedExitsCount) ? observedExitsCount : null,
            upgrade: upgrade || operation.upgrade || null,
            retryTarget: retryTarget || null,
          }
        : operation,
    );
    setBrowseRestartRequired(false);
    setGatewayRestartSignal(Date.now());
    refreshSharedStatuses();
    controllerRef.current.refreshRestartStatus?.();
    if (isUpgrade) upgradeStatusPoll.refresh({ force: true });
    // An unfinished upgrade stays on the card until the operator acts.
    if (isUpgrade && upgrade?.doctor === "failed") {
      if (!isGatewaySurfaceLocation(locationRef.current)) {
        showToast("OpenClaw is running again, but its data upgrade didn't finish", "error");
      }
      return;
    }
    if (isUpgrade && !isGatewaySurfaceLocation(locationRef.current)) {
      showToast("OpenClaw data upgraded", "success");
    } else if (!isGatewaySurfaceLocation(locationRef.current)) {
      // Toast only when the outcome lands while the user is on another page —
      // on General/Watchdog the card itself announces it.
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
  // say why. These codes come from the route's readRestartBlocker. The
  // server books them as "skipped" in the incident ledger
  // and stamps the record with the code so a reload never resurrects them.
  const kRestartPolicyRefusalCodes = new Set([
    "booting",
    "operation_in_progress",
    "relaunch_in_progress",
    "not_onboarded",
  ]);
  const isPolicyRefusalCode = (code) =>
    typeof code === "string" && kRestartPolicyRefusalCodes.has(code);
  // Every delivery path carries the server's message (409 body `error`, the
  // operation's terminal `error` event, the persisted record's errorSummary),
  // so the copy has one home on the server (readRestartBlocker); the fallback is generic on purpose.
  const dismissPolicyRefusal = ({ message, hint = null }) => {
    clearRestartSubscription();
    updateRestartOperation(null);
    const notice = hint || message || "Gateway restart refused";
    setRestartNotice({ message: notice });
    if (refusalNoticeTimerRef.current) clearTimeout(refusalNoticeTimerRef.current);
    refusalNoticeTimerRef.current = setTimeout(() => {
      refusalNoticeTimerRef.current = null;
      setRestartNotice(null);
    }, kRefusalNoticeMs);
    if (!isGatewaySurfaceLocation(locationRef.current)) {
      showToast(`Can't restart right now: ${notice}`, "error");
    }
    refreshSharedStatuses();
    controllerRef.current.refreshRestartStatus?.();
  };

  const clearRefusalNotice = () => {
    if (refusalNoticeTimerRef.current) {
      clearTimeout(refusalNoticeTimerRef.current);
      refusalNoticeTimerRef.current = null;
    }
    setRestartNotice(null);
  };

  const finishOperationFailure = ({
    message,
    hint = null,
    code = null,
    budgetMs = null,
    how = null,
    phase = null,
    recovery = null,
    upgrade = null,
    retryTarget = null,
  }) => {
    clearRestartSubscription();
    if (restartOperationRef.current?.kind === kUpgradeOperationKind) upgradeStatusPoll.refresh({ force: true });
    updateRestartOperation((operation) =>
      operation
        ? {
            ...operation,
            phase: "failed",
            upgrade: upgrade || operation.upgrade || null,
            retryTarget: retryTarget || operation.retryTarget || null,
            error: {
              message: message || "Gateway restart failed",
              hint: hint || null,
              code: code || null,
              budgetMs: Number.isFinite(budgetMs) ? budgetMs : null,
              how: how || null,
              phase: phase || null,
              // The watchdog's recovery clause (bug #137): what automatic
              // recovery will do about this failure — from the `recovery`
              // stream event, or the persisted record on reload.
              recovery: recovery || operation.recovery || null,
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

  // The persisted record carries the same failure fields the SSE error event
  // does, so a reload renders the identical sentence.
  const failureFromRecord = (last = {}) => ({
    message: last.errorSummary || "Gateway restart failed",
    hint: last.hint || null,
    code: last.code || null,
    budgetMs: Number.isFinite(Number(last.budgetMs)) ? Number(last.budgetMs) : null,
    how: last.how || null,
    phase: last.failedPhase || null,
    recovery: last.recovery && typeof last.recovery === "object" ? last.recovery : null,
    ...(last.upgrade && typeof last.upgrade === "object" ? { upgrade: last.upgrade } : {}),
    ...(last.retryTarget ? { retryTarget: last.retryTarget } : {}),
  });

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
          how: last.how ?? null,
          upgrade: last.upgrade || null,
          retryTarget: last.retryTarget || null,
        });
      } else if (isPolicyRefusalCode(last.code)) {
        dismissPolicyRefusal({ message: last.errorSummary, hint: last.hint });
      } else {
        finishOperationFailure(failureFromRecord(last));
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

  // The persisted record's phase timestamps seed the status line (phase +
  // server-anchored elapsed time) before the SSE replay lands.
  const stepsFromPhaseAt = (phaseAt) =>
    Object.entries(phaseAt && typeof phaseAt === "object" ? phaseAt : {})
      .map(([name, at]) => ({ name, status: "running", at: Number(at) }))
      .filter((step) => Number.isFinite(step.at))
      .sort((a, b) => a.at - b.at);

  const attachToRestartOperation = (
    operationId,
    { resumed = false, startedAt = null, phaseAt = null, kind = null } = {},
  ) => {
    clearRestartSubscription();
    updateRestartOperation((operation) => ({
      operationId,
      kind: kind || operation?.kind || "gateway_restart",
      startedAt: operation?.startedAt || Number(startedAt) || Date.now(),
      phase: "running",
      // Resumed attaches rebuild steps from the SSE replay (seeded from the
      // record's phase stamps); fresh attaches keep the optimistic
      // placeholder until the first real step lands.
      steps: resumed ? stepsFromPhaseAt(phaseAt) : operation?.steps || [],
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
              how: data?.how ?? null,
              observedExitsCount: Number(data?.observedExitsCount),
              upgrade: data?.upgrade || null,
              retryTarget: data?.retryTarget || null,
            });
            return;
          }
          if (event === "recovery") {
            // Precedes the terminal error event: what the watchdog will do.
            updateRestartOperation((operation) =>
              operation && operation.operationId === operationId
                ? { ...operation, recovery: { status: data?.status || null, reason: data?.reason || null, text: data?.text || "" } }
                : operation,
            );
            return;
          }
          if (event === "error") {
            if (isPolicyRefusalCode(data?.code)) {
              // Queued-then-refused (post-lock hold/apply): not a failure.
              dismissPolicyRefusal({ message: data?.error, hint: data?.hint });
              return;
            }
            controllerRef.current.finishOperationFailure?.({
              message: data?.error || "Gateway restart failed",
              hint: data?.hint || null,
              code: data?.code || null,
              budgetMs: Number(data?.budgetMs),
              how: data?.how || null,
              phase: data?.phase || null,
              upgrade: data?.upgrade || null,
              retryTarget: data?.retryTarget || null,
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

  // One pipeline for Restart and Retry upgrade: the kind decides the
  // endpoint and the copy; the operation stream and record are shared.
  const startGatewayOperation = async ({ kind, start }) => {
    const current = restartOperationRef.current;
    if (current?.phase === "running") return { ok: true, attached: true, operationId: current.operationId };
    // A new attempt (Restart or Try again) retires the previous outcome for
    // good — a refresh must never resurrect the superseded failure.
    if ((current?.phase === "failed" || current?.phase === "recovered") && current.operationId) {
      acknowledgedOperationIdsRef.current.add(current.operationId);
    }
    if (successCollapseTimerRef.current) {
      clearTimeout(successCollapseTimerRef.current);
      successCollapseTimerRef.current = null;
    }
    clearRefusalNotice();
    // Optimistic first frame: the progress card renders before the 202 lands.
    updateRestartOperation({
      operationId: null,
      kind,
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
      const data = await start();
      if (data?.attached) {
        showToast(
          "Another operation is running — attached to its progress",
          "info",
        );
      }
      if (data?.operationId) {
        controllerRef.current.attachToRestartOperation?.(data.operationId, {
          resumed: !!data?.attached,
          kind,
        });
      } else {
        // Version skew: an old server ignored ?async=1 and completed the
        // restart synchronously.
        controllerRef.current.finishOperationSuccess?.({});
      }
      return data;
    } catch (err) {
      // Policy refusals (409) are not failed restarts: nothing ran, so there
      // is no progress card to leave up — clear it and say why (see
      // kRestartPolicyRefusalCodes above).
      if (kind === kUpgradeOperationKind && err?.notStarted) {
        // The Retry upgrade confirm shows the refusal itself (busy, nothing
        // to retry, unchanged since the failure → Retry anyway).
        updateRestartOperation(null);
        refreshSharedStatuses();
        upgradeStatusPoll.refresh({ force: true });
        return { ok: false, notStarted: true, error: err.message, code: err.code, hint: err.hint, unchanged: err.unchanged === true };
      }
      if (err?.notStarted || isPolicyRefusalCode(err?.code)) {
        dismissPolicyRefusal({ message: err.message, hint: err.hint });
        return { ok: false, notStarted: true, error: err.message, code: err.code, recovery: err.recovery };
      }
      // The response was lost: reconcile against the persisted record
      // instead of replaying the mutation. Until a refresh answers, the
      // outcome is unknown and offers no Try again.
      const reconciled = await fetchRestartStatus().catch(() => null);
      if (reconciled?.activeOperation?.operationId) {
        const active = reconciled.activeOperation;
        controllerRef.current.attachToRestartOperation?.(active.operationId, {
          resumed: true,
          startedAt: active.startedAt,
          phaseAt: active.phaseAt,
          kind: active.kind || null,
        });
        return { ok: true, attached: true, operationId: active.operationId };
      }
      controllerRef.current.finishOperationFailure?.({
        message: err?.message || "Restart result unknown — response lost.",
        code: "response_lost",
      });
      return null;
    }
  };
  const handleGatewayRestart = useCallback(
    (options = {}) => startGatewayOperation({ kind: "gateway_restart", start: () => restartGatewayAsync(options) }),
    [updateRestartOperation],
  );
  const handleUpgradeRetry = useCallback(
    (options = {}) => startGatewayOperation({ kind: kUpgradeOperationKind, start: () => retryUpgradeAsync(options) }),
    [updateRestartOperation],
  );
  const handleConfirmWorkspaceMove = useCallback(
    (move = {}) => startGatewayOperation({ kind: kUpgradeOperationKind, start: () => confirmWorkspaceMoveAsync(move) }),
    [updateRestartOperation],
  );

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
          startedAt: active.startedAt,
          phaseAt: active.phaseAt,
          kind: active.kind || null,
        });
        return;
      }
      // A lost response has now been reconciled: nothing is running, so the
      // unknown outcome resolves to the persisted record (below) or to the
      // plain controls when nothing was ever booked.
      const unknown = current?.phase === "failed" && current.error?.code === "response_lost";
      if (unknown) updateRestartOperation(null);
      if (!current || unknown) {
        const last = data.lastOperation;
        const failed =
          last &&
          (last.status === "failed" || last.status === "interrupted") &&
          // A policy refusal never ran — it is not a failed restart to revive.
          !isPolicyRefusalCode(last.code) &&
          !acknowledgedOperationIdsRef.current.has(last.operationId);
        if (failed) {
          // Terminal outcomes survive reloads until acknowledged/superseded.
          // A failed restart whose gateway came back reads as the recovery
          // line, not the stale failure sentence (bug #137 PR 2).
          updateRestartOperation({
            operationId: last.operationId,
            kind: last.kind || "gateway_restart",
            upgrade: last.upgrade || null,
            retryTarget: last.retryTarget || null,
            startedAt: last.startedAt || Date.now(),
            phase: last.recovered ? "recovered" : "failed",
            steps: stepsFromPhaseAt(last.phaseAt),
            error: failureFromRecord(last),
            recovered: last.recovered || null,
            durationMs: last.durationMs ?? null,
            downtimeMs: last.downtimeMs ?? null,
            resumed: true,
          });
        }
      } else if (current.phase === "failed" && data.lastOperation?.operationId === current.operationId && data.lastOperation.recovered) {
        updateRestartOperation({ ...current, phase: "recovered", recovered: data.lastOperation.recovered });
      }
    } catch {}
  }, [onboarded, updateRestartOperation]);

  // A failed outcome retires once the gateway has stayed Running for a full
  // minute: the box recovered on its own (or via Repair), so the stale
  // failure sentence would only contradict the green dot above it.
  // Before retiring, the record is asked once more: a `recovered` stamp
  // turns the line into the recovery sentence instead of silence (the
  // recovered line itself retires on the next restart or dismissal).
  const failedOperationId = restartOperation?.phase === "failed" ? restartOperation.operationId || "unknown" : null;
  const observedRunning = sharedStatus?.state?.state === "running";
  useEffect(() => {
    if (!failedOperationId || !observedRunning) return undefined;
    const timerId = setTimeout(async () => {
      const current = restartOperationRef.current;
      if (current?.phase !== "failed") return;
      const data = await fetchRestartStatus().catch(() => null);
      const last = data?.lastOperation;
      if (restartOperationRef.current !== current) return;
      if (last?.operationId === current.operationId && last.recovered) {
        updateRestartOperation({ ...current, phase: "recovered", recovered: last.recovered });
        return;
      }
      if (current.operationId) acknowledgedOperationIdsRef.current.add(current.operationId);
      updateRestartOperation(null);
    }, kFailedOutcomeRetireAfterRunningMs);
    return () => clearTimeout(timerId);
  }, [failedOperationId, observedRunning, updateRestartOperation]);

  const loadRestartEvidence = useCallback(async (operationId) => {
    // Failure evidence is served by reference — fetched on demand by the
    // Watchdog tab's "Restart evidence" disclosure, never in status frames.
    // null → "Evidence expired".
    try {
      const data = await fetchRestartStatus();
      const last = data?.lastOperation;
      if (last?.operationId === operationId && (last.evidence || last.stopEvidence || last.timeline?.length)) {
        return {
          text: last.evidence || "",
          stopEvidence: last.stopEvidence || null,
          failedPhase: last.failedPhase || null,
          how: last.how || null,
          timeline: Array.isArray(last.timeline) ? last.timeline : [],
          startedAt: last.startedAt || null,
        };
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
    window.requestAnimationFrame?.(() => document.getElementById("gateway-setup")?.focus());
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
      if (refusalNoticeTimerRef.current) {
        clearTimeout(refusalNoticeTimerRef.current);
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
            connectivityMonitorRef.current.recordFrame();
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
    if (request) connectivityMonitorRef.current.recordFrame();
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
    connectivityMonitorRef.current.recordFailure();
    bootTrackerRef.current.recordOutage();
  }, [onboarded, sharedStatusPoll.error, statusStreamConnected]);

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

  // An unknown outcome (lost response) keeps polling the record until the
  // server answers — that answer is what brings Try again back.
  const restartOutcomeUnknown =
    restartOperation?.phase === "failed" && restartOperation.error?.code === "response_lost";
  useVisibleInterval(refreshRestartStatus, 2000, {
    enabled: Boolean(onboarded && (restartRequired || restartingGateway || restartOutcomeUnknown)),
    immediate: false,
  });

  useEffect(() => {
    const handleBrowseFileSaved = (event) => {
      const savedPath = String(event?.detail?.path || "");
      if (!shouldRequireRestartForBrowsePath(savedPath)) return;
      setBrowseRestartRequired(true);
    };
    window.addEventListener(kBrowseFileSavedEvent, handleBrowseFileSaved);
    return () => {
      window.removeEventListener(kBrowseFileSavedEvent, handleBrowseFileSaved);
    };
  }, []);
  useEffect(() => {
    const handleRestartRequired = () => setRestartRequired(true);
    window.addEventListener(kRestartRequiredEvent, handleRestartRequired);
    return () => {
      window.removeEventListener(kRestartRequiredEvent, handleRestartRequired);
    };
  }, []);

  const handleAcUpdate = useCallback(async () => {
    if (acUpdating || acManagedUpdate.disabled) return;
    const data = await acManagedUpdate.submit();
    if (!data) return;
    if (data.managedUpdate || data.managedUpdateAttempt) {
      showToast("Deployment request recorded — check the provider for its outcome", "info");
      return;
    }
    if (data.restarting === true) {
      setAcUpdating(true);
      showToast("AlphaClaw updated — restarting...", "success");
      beginAlphaclawReconnect({ graceMs: 5000 });
    }
  }, [acUpdating, acManagedUpdate.disabled, acManagedUpdate.submit, beginAlphaclawReconnect]);

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

  useEffect(() => {
    // Stable action identities: the handlers close over per-render state, so
    // publish latest-ref delegates instead — the store's shallow compare can
    // then skip no-change publishes (each 2s frame re-renders this hook).
    shellActionsRef.current = {
      restart: handleGatewayRestart,
      refresh: async () => {
        refreshSharedStatuses();
        await refreshRestartStatus();
      },
      resumeChannels: handleResumeChannels,
      dismissOutcome: dismissRestartOutcome,
      dismissRestartBanner,
      loadEvidence: loadRestartEvidence,
      retryConnect: handleRetryConnect,
      openSetup: handleOpenSetup,
      retryUpgrade: handleUpgradeRetry,
      confirmWorkspaceMove: handleConfirmWorkspaceMove,
      refreshUpgradeStatus: () => upgradeStatusPoll.refresh({ force: true }),
    };
    gatewayShellStore.publish({
      hasStatus: !!sharedStatus,
      statusState: sharedStatus?.state || null,
      legacyGatewayStatus: sharedStatus?.gateway || null,
      watchdogStatus: sharedWatchdogStatus,
      restartOperation,
      restartNotice,
      restartRequired: isAnyRestartRequired,
      restartReasons,
      upgradeAlert: upgradeAlertRef.current,
      bootProgress: sharedStatus?.bootProgress || null,
      bootReconnect: bootReconnectRef.current,
      connectivityMode: combinedConnectivityMode,
      lastFrameAtMs: lastStatusFrameAtRef.current || 0,
      statusFreshness,
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
      acManagedUpdate,
      acUpdating: acUpdating || acManagedUpdate.submitting,
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
      statusFreshness,
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
