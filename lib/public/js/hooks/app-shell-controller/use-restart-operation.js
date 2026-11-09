import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import {
  fetchRestartStatus,
  dismissRestartStatus,
  scheduleGatewayRestart,
  cancelScheduledGatewayRestart,
  restartGatewayAsync,
  retryUpgradeAsync,
  confirmWorkspaceMoveAsync,
  subscribeGatewayRestartEvents,
} from "../../lib/api.js";
import { shouldRequireRestartForBrowsePath } from "../../lib/browse-restart-policy.js";
import {
  kOptimisticStepName,
  kUpgradeOperationKind,
} from "../../components/restart-progress-card.js";
import { useVisibleInterval } from "../use-visible-interval.js";
import { isGatewaySurfaceLocation } from "../../lib/routes.js";
import { showToast } from "../../components/toast.js";
import { kBrowseFileSavedEvent, kRestartRequiredEvent } from "../../lib/ui-events.js";
import {
  kSuccessCollapseMs,
  kRefusalNoticeMs,
  kFailedOutcomeRetireAfterRunningMs,
  isPolicyRefusalCode,
  failureFromRecord,
  stepsFromPhaseAt,
} from "./restart-operation-model.js";

// The gateway restart and OpenClaw data upgrade operations (one pipeline),
// and the restart-required banner. Both are read from the server's restart
// record: /api/restart-status and the operation's event stream.
export const useRestartOperation = ({
  location,
  onboarded,
  sharedStatus,
  refreshSharedStatuses,
  refreshUpgradeStatus,
}) => {
  const [restartRequired, setRestartRequired] = useState(false);
  const [restartReasons, setRestartReasons] = useState([]);
  const [restartSchedule, setRestartSchedule] = useState(null);
  const [browseRestartRequired, setBrowseRestartRequired] = useState(false);
  const [serverRestartInProgress, setServerRestartInProgress] = useState(false);
  const [restartOperation, setRestartOperation] = useState(null);
  const [restartNotice, setRestartNotice] = useState(null);
  const [gatewayRestartSignal, setGatewayRestartSignal] = useState(0);
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
  const isAnyRestartRequired = restartRequired || browseRestartRequired;
  const restartingGateway =
    restartOperation?.phase === "running" || serverRestartInProgress;

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
    if (isUpgrade) refreshUpgradeStatus();
    // An unfinished upgrade stays on the card until the operator acts.
    if (isUpgrade && upgrade?.doctor === "failed") {
      if (!isGatewaySurfaceLocation(locationRef.current)) {
        showToast("The gateway is running again, but OpenClaw's data upgrade didn't finish", "error");
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
    if (restartOperationRef.current?.kind === kUpgradeOperationKind) refreshUpgradeStatus();
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

  const attachToRestartOperation = (
    operationId,
    { resumed = false, startedAt = null, phaseAt = null, kind = null } = {},
  ) => {
    clearRestartSubscription();
    if (successCollapseTimerRef.current) {
      clearTimeout(successCollapseTimerRef.current);
      successCollapseTimerRef.current = null;
    }
    updateRestartOperation((operation) => ({
      operationId,
      lockStartedAt: operation?.operationId === operationId ? operation.lockStartedAt ?? null : null,
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
      // kRestartPolicyRefusalCodes in restart-operation-model.js).
      if (kind === kUpgradeOperationKind && err?.notStarted) {
        // The Retry upgrade confirm shows the refusal itself (busy, nothing
        // to retry, unchanged since the failure → Retry anyway).
        updateRestartOperation(null);
        refreshSharedStatuses();
        refreshUpgradeStatus();
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
      setRestartSchedule(data.schedule || null);
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
      } else if (
        current.phase === "failed" &&
        data.lastOperation?.operationId === current.operationId &&
        data.lastOperation.recovery?.status &&
        data.lastOperation.recovery.status !== current.error?.recovery?.status
      ) {
        // The record's recovery settled after the stream closed (Bug C): the
        // stream's "checking now" clause gives way to what actually happened.
        const { status, reason = null } = data.lastOperation.recovery;
        updateRestartOperation({ ...current, error: { ...current.error, recovery: { status, reason } } });
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

  const statusOperationStartedAt = sharedStatus?.state?.operation?.startedAt ?? null;

  // The lock badge a running restart holds, recorded once from the status
  // frames, so the Gateway card can tell that restart's stale lock from a
  // newer one after it succeeds.
  const runningOperationId = restartOperation?.phase === "running" ? restartOperation.operationId || null : null;
  const statusOperationKind = sharedStatus?.state?.operation?.kind ?? null;
  useEffect(() => {
    if (!runningOperationId || statusOperationStartedAt == null) return;
    updateRestartOperation((operation) => {
      if (operation?.phase !== "running" || operation.operationId !== runningOperationId || operation.lockStartedAt != null) return operation;
      const lockKind = operation.kind === kUpgradeOperationKind ? "openclaw_upgrade" : "restart";
      return statusOperationKind === lockKind ? { ...operation, lockStartedAt: statusOperationStartedAt } : operation;
    });
  }, [runningOperationId, statusOperationKind, statusOperationStartedAt, updateRestartOperation]);

  // A lock badge that appears or changes while a finished restart's success
  // line shows may be a newer restart started elsewhere (another tab), so ask
  // the record at once: a running operation attaches and shows its progress.
  const succeededOperationId = restartOperation?.phase === "succeeded" ? restartOperation.operationId || "unknown" : null;
  useEffect(() => {
    if (!succeededOperationId || statusOperationStartedAt == null) return;
    refreshRestartStatus();
  }, [succeededOperationId, statusOperationStartedAt, refreshRestartStatus]);

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

  controllerRef.current.refreshRestartStatus = refreshRestartStatus;
  controllerRef.current.dismissRestartOutcome = dismissRestartOutcome;
  controllerRef.current.finishOperationSuccess = finishOperationSuccess;
  controllerRef.current.finishOperationFailure = finishOperationFailure;
  controllerRef.current.resolveOperationFromServer = resolveOperationFromServer;
  controllerRef.current.attachToRestartOperation = attachToRestartOperation;

  useEffect(
    () => () => {
      clearRestartSubscription();
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
    if (!onboarded) return;
    refreshRestartStatus();
  }, [onboarded, refreshRestartStatus]);

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

  const dismissRestartBanner = useCallback(async () => {
    setRestartRequired(false);
    setBrowseRestartRequired(false);
    setRestartReasons([]);
    setRestartSchedule(null);
    try {
      await dismissRestartStatus();
      await refreshRestartStatus();
    } catch (err) {
      showToast(err.message || "Could not dismiss restart banner", "error");
      await refreshRestartStatus();
    }
  }, [refreshRestartStatus]);

  // Returns whether the schedule was saved, so the banner can close its picker.
  const scheduleRestart = useCallback(async (at) => {
    try {
      const data = await scheduleGatewayRestart(at);
      setRestartSchedule(data.schedule || null);
      return true;
    } catch (err) {
      showToast(err.message || "Could not schedule the restart", "error");
      return false;
    } finally {
      await refreshRestartStatus();
    }
  }, [refreshRestartStatus]);

  const cancelScheduledRestart = useCallback(async () => {
    try {
      await cancelScheduledGatewayRestart();
      setRestartSchedule(null);
    } catch (err) {
      showToast(err.message || "Could not cancel the scheduled restart", "error");
    } finally {
      await refreshRestartStatus();
    }
  }, [refreshRestartStatus]);

  return {
    restartOperation,
    restartNotice,
    restartReasons,
    restartSchedule,
    isAnyRestartRequired,
    restartingGateway,
    gatewayRestartSignal,
    setRestartRequired,
    refreshRestartStatus,
    dismissRestartOutcome,
    handleGatewayRestart,
    handleUpgradeRetry,
    handleConfirmWorkspaceMove,
    loadRestartEvidence,
    dismissRestartBanner,
    scheduleRestart,
    cancelScheduledRestart,
  };
};
