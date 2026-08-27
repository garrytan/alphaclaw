import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  applyOpenclawVersion,
  clearOpenclawBlocklist,
  fetchOpenclawCatalog,
  fetchOpenclawChannel,
  fetchOpenclawRunLogText,
  fetchOpenclawRuns,
  fetchStatus,
  markOpenclawGood,
  rollbackOpenclaw,
  subscribeOpenclawApplyEvents,
  updateOpenclawReleaseChannel,
} from "../../lib/api.js";
import { showToast } from "../toast.js";
import {
  buildApplyConfirmModel,
  buildChannelSaveErrorModel,
  buildErrorEnvelopeModel,
  buildNoTargetNotice,
  buildRunFailureModel,
  buildVerdictBannerModel,
  describeTarget,
  getLatestApplicableTarget,
} from "./helpers.js";

const kRestartPollIntervalMs = 3000;
const kRestartPollMaxAttempts = 40; // ~2 minutes at 3s cadence
const kResumePollIntervalMs = 3000;
const kMaxOutputChars = 40000;

export const useUpgradeTab = ({
  statusData = null,
  onRefreshStatuses = () => {},
} = {}) => {
  const [channelInfo, setChannelInfo] = useState(null);
  const [channelError, setChannelError] = useState(null);
  const [loadingChannel, setLoadingChannel] = useState(true);
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [savingChannel, setSavingChannel] = useState(false);
  const [channelSaveError, setChannelSaveError] = useState(null);
  const [runs, setRuns] = useState([]);
  const [runFailure, setRunFailure] = useState(null);
  const [runLog, setRunLog] = useState(null);
  const [pendingApply, setPendingApply] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [operation, setOperation] = useState(null);
  const [logOpen, setLogOpen] = useState(false);
  const [verdict, setVerdict] = useState(null);
  const [expandedNotesId, setExpandedNotesId] = useState(null);
  const [devAdvancedOpen, setDevAdvancedOpen] = useState(false);
  const [markingGood, setMarkingGood] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackPrompt, setRollbackPrompt] = useState(false);
  const [clearingBlocklistId, setClearingBlocklistId] = useState(null);
  const [lastClearedId, setLastClearedId] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const unsubscribeRef = useRef(null);
  const expectedRef = useRef(null);
  const rehydratedRef = useRef(false);

  const activeChannel =
    selectedChannel ||
    channelInfo?.releaseChannel ||
    statusData?.openclawChannel?.releaseChannel ||
    "stable";

  const stopStream = useCallback(() => {
    if (unsubscribeRef.current) {
      try {
        unsubscribeRef.current();
      } catch {}
      unsubscribeRef.current = null;
    }
  }, []);

  const loadChannel = useCallback(async () => {
    try {
      const data = await fetchOpenclawChannel();
      setChannelInfo(data);
      setChannelError(null);
      return data;
    } catch (err) {
      setChannelError(buildErrorEnvelopeModel(err));
      return null;
    } finally {
      setLoadingChannel(false);
    }
  }, []);

  const loadCatalog = useCallback(async ({ refresh = false } = {}) => {
    if (refresh) setRefreshingCatalog(true);
    try {
      const data = await fetchOpenclawCatalog({ refresh });
      setCatalog(data?.catalog || null);
      setCatalogError(null);
      return data?.catalog || null;
    } catch (err) {
      setCatalogError(buildErrorEnvelopeModel(err));
      return null;
    } finally {
      setRefreshingCatalog(false);
      setLoadingCatalog(false);
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const data = await fetchOpenclawRuns();
      const list = Array.isArray(data?.runs) ? data.runs : [];
      setRuns(list);
      return list;
    } catch {
      // The timeline is best-effort context, never a blocker.
      return null;
    }
  }, []);

  useEffect(() => {
    loadChannel();
    loadCatalog();
    loadRuns();
  }, [loadChannel, loadCatalog, loadRuns]);

  // Rehydration (U4/EV10): an apply may already be in flight when the page
  // mounts (or after a reload mid-update). Resume the progress view from the
  // persisted step list; a channel poll below keeps it fresh.
  useEffect(() => {
    if (rehydratedRef.current || operation || !channelInfo) return;
    const run = channelInfo.lastUpdateRun || null;
    const inFlight =
      Boolean(statusData?.openclawChannel?.applyInProgress) ||
      Boolean(run && run.finishedAt == null);
    if (!inFlight) return;
    rehydratedRef.current = true;
    setOperation({
      operationId: run?.operationId || null,
      resumed: true,
      target: run?.target || null,
      label: describeTarget(run?.target),
      startedAt: run?.startedAt || Date.now(),
      steps: Array.isArray(run?.steps) ? run.steps : [],
      output: "",
      lastOutputAt: null,
      phase: "running",
      error: null,
    });
  }, [channelInfo, operation, statusData?.openclawChannel?.applyInProgress]);

  // Elapsed-timer / heartbeat / staleness tick.
  useEffect(() => {
    const cadenceMs = operation ? 1000 : 30000;
    const timerId = setInterval(() => setNowMs(Date.now()), cadenceMs);
    return () => clearInterval(timerId);
  }, [Boolean(operation)]);

  const beginRestartHandoff = useCallback(() => {
    stopStream();
    setOperation((op) => (op ? { ...op, phase: "restarting" } : op));
  }, [stopStream]);

  const subscribeToOperation = useCallback(
    (operationId) => {
      stopStream();
      unsubscribeRef.current = subscribeOpenclawApplyEvents({
        operationId,
        onMessage: ({ event, data }) => {
          if (event === "step") {
            setOperation((op) => {
              if (!op) return op;
              const next = { ...op, steps: [...op.steps, data] };
              if (data?.name === "restarting") next.phase = "restarting";
              return next;
            });
            if (data?.name === "restarting") stopStream();
            return;
          }
          if (event === "output") {
            setOperation((op) =>
              op
                ? {
                    ...op,
                    output: `${op.output}${String(data?.chunk || "")}`.slice(
                      -kMaxOutputChars,
                    ),
                    lastOutputAt: Date.now(),
                  }
                : op,
            );
            return;
          }
          if (event === "done") {
            beginRestartHandoff();
            return;
          }
          if (event === "error") {
            stopStream();
            setOperation((op) =>
              op
                ? {
                    ...op,
                    phase: "failed",
                    // Streamed errors carry the same envelope fields as
                    // rejected applies — keep code/hint/docsUrl so the
                    // failure card can render the hint (U12).
                    error: buildErrorEnvelopeModel({
                      message: data?.error || "The update failed",
                      code: data?.code || null,
                      hint: data?.hint || null,
                      docsUrl: data?.docsUrl || null,
                    }),
                  }
                : op,
            );
            loadChannel();
          }
        },
        onError: () => {
          // The connection dropped. If the apply reached the restart phase,
          // hand off to the reconnect poller; otherwise fall back to polling
          // the persisted run state (a long dev build surviving an SSE blip).
          setOperation((op) => {
            if (!op || op.phase !== "running") return op;
            const reachedRestart = op.steps.some(
              (step) =>
                step?.name === "restarting" ||
                (step?.name === "record" && step?.status === "completed"),
            );
            if (reachedRestart) {
              return { ...op, phase: "restarting" };
            }
            return { ...op, resumed: true };
          });
          stopStream();
        },
      });
    },
    [beginRestartHandoff, loadChannel, stopStream],
  );

  const startApply = useCallback(
    async ({ payload, label }) => {
      setApplyError(null);
      setVerdict(null);
      setRunFailure(null);
      expectedRef.current = {
        channel: payload?.channel || null,
        version: payload?.version || null,
        sha: payload?.sha || null,
        devHead: Boolean(payload?.devHead),
        previousId:
          channelInfo?.appliedId || channelInfo?.installedVersion || null,
      };
      setOperation({
        operationId: null,
        resumed: false,
        target: payload,
        label: label || describeTarget(payload),
        startedAt: Date.now(),
        steps: [],
        output: "",
        lastOutputAt: null,
        phase: "running",
        error: null,
      });
      try {
        const result = await applyOpenclawVersion(payload);
        if (result?.noop) {
          setOperation(null);
          showToast(`Already on ${label || describeTarget(payload)}`, "info");
          return;
        }
        const operationId = result?.operationId || null;
        if (operationId && result?.events) {
          setOperation((op) => (op ? { ...op, operationId } : op));
          subscribeToOperation(operationId);
          return;
        }
        // Quick synchronous success: the server restarts itself shortly.
        setOperation((op) =>
          op ? { ...op, operationId, phase: "restarting" } : op,
        );
      } catch (err) {
        setOperation(null);
        setApplyError(buildErrorEnvelopeModel(err));
      }
    },
    [channelInfo, subscribeToOperation],
  );

  // Resumed operations have no SSE stream; poll the persisted run state.
  useEffect(() => {
    if (!operation?.resumed || operation.phase !== "running") return undefined;
    let cancelled = false;
    let timerId = null;
    const poll = async () => {
      try {
        const data = await fetchOpenclawChannel();
        if (cancelled) return;
        setChannelInfo(data);
        const run = data?.lastUpdateRun || null;
        if (run && Array.isArray(run.steps)) {
          setOperation((op) =>
            op && op.phase === "running" ? { ...op, steps: run.steps } : op,
          );
        }
        if (run && run.finishedAt != null) {
          if (run.ok) {
            setOperation((op) =>
              op ? { ...op, phase: "restarting" } : op,
            );
          } else {
            setOperation((op) =>
              op
                ? {
                    ...op,
                    phase: "failed",
                    error: buildErrorEnvelopeModel({
                      message:
                        run.result?.message || "The update did not complete.",
                      code: run.result?.code || null,
                      hint: run.result?.hint || null,
                      docsUrl: run.result?.docsUrl || null,
                    }),
                  }
                : op,
            );
          }
          return;
        }
      } catch {
        // Server may be restarting under us; keep trying.
      }
      if (!cancelled) timerId = setTimeout(poll, kResumePollIntervalMs);
    };
    timerId = setTimeout(poll, kResumePollIntervalMs);
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [operation?.resumed, operation?.phase]);

  // Restart handoff (U4): poll /api/status every 3s until the new server
  // reports the expected version (or we give up after ~2 minutes).
  useEffect(() => {
    if (operation?.phase !== "restarting") return undefined;
    stopStream();
    let cancelled = false;
    let timerId = null;
    let attempts = 0;
    let lastChannelSeen = null;
    const finish = (verdictModel) => {
      setVerdict(verdictModel);
      setOperation(null);
      loadChannel();
      loadCatalog();
      onRefreshStatuses();
      // Post-restart continuity: the run ledger survives the restart and is
      // the authoritative outcome — an activation_failed/interrupted latest
      // run replaces the verdict banner with a failure card + full log.
      loadRuns().then((list) => {
        const failure = buildRunFailureModel((list || [])[0] || null);
        if (failure) {
          setRunFailure(failure);
          setVerdict(null);
        }
      });
    };
    const poll = async () => {
      attempts += 1;
      try {
        const payload = await fetchStatus();
        if (cancelled) return;
        const channel = payload?.openclawChannel || null;
        if (channel) {
          lastChannelSeen = channel;
          const verdictModel = buildVerdictBannerModel({
            expected: expectedRef.current,
            channel,
          });
          if (verdictModel?.ok) {
            finish(verdictModel);
            return;
          }
        }
      } catch {
        // Still restarting.
      }
      if (cancelled) return;
      if (attempts >= kRestartPollMaxAttempts) {
        finish(
          lastChannelSeen
            ? buildVerdictBannerModel({
                expected: expectedRef.current,
                channel: lastChannelSeen,
              })
            : {
                ok: false,
                message:
                  "Could not reconnect within ~2 minutes. The server may still be restarting — reload the page to check again.",
              },
        );
        return;
      }
      timerId = setTimeout(poll, kRestartPollIntervalMs);
    };
    timerId = setTimeout(poll, kRestartPollIntervalMs);
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [operation?.phase, loadChannel, loadCatalog, loadRuns, onRefreshStatuses, stopStream]);

  useEffect(() => () => stopStream(), [stopStream]);

  // Channel selection persists IMMEDIATELY — it is a pure catalog preference
  // (installs nothing). The segmented control shows a saving state; a failed
  // save reverts the selection LOUDLY via a persistent inline error chip.
  const onSelectChannel = useCallback(
    async (nextChannel) => {
      if (operation || savingChannel) return;
      if (!nextChannel || nextChannel === activeChannel) return;
      const previousChannel = activeChannel;
      setChannelSaveError(null);
      setSavingChannel(true);
      setSelectedChannel(nextChannel);
      try {
        await updateOpenclawReleaseChannel(nextChannel);
        await loadChannel();
      } catch (err) {
        setSelectedChannel(previousChannel);
        setChannelSaveError(
          buildChannelSaveErrorModel({
            attempted: nextChannel,
            activeChannel: previousChannel,
            error: err,
          }),
        );
      } finally {
        setSavingChannel(false);
      }
    },
    [activeChannel, loadChannel, operation, savingChannel],
  );

  const onDismissChannelSaveError = useCallback(
    () => setChannelSaveError(null),
    [],
  );

  const onRequestApply = useCallback(
    ({ payload, label, isDowngrade = false }) => {
      if (operation) return;
      // Breaking-change framing needs the running channel and whether the
      // target's release notes actually loaded (per-source degradation).
      const currentChannel = channelInfo?.applied?.channel || "stable";
      const rows =
        payload?.channel && Array.isArray(catalog?.[payload.channel])
          ? catalog[payload.channel]
          : [];
      const row =
        rows.find((entry) => entry?.version === payload?.version) || null;
      const notesAvailable = row
        ? Boolean(row.notes) && !row.notesUnavailable
        : null;
      setPendingApply({
        payload,
        label,
        isDowngrade,
        confirm: buildApplyConfirmModel({
          payload,
          label,
          isDowngrade,
          currentChannel,
          notesAvailable,
        }),
      });
    },
    [catalog, channelInfo, operation],
  );

  const onCancelApply = useCallback(() => setPendingApply(null), []);

  const onConfirmApply = useCallback(async () => {
    const pending = pendingApply;
    if (!pending) return;
    setPendingApply(null);
    await startApply({ payload: pending.payload, label: pending.label });
  }, [pendingApply, startApply]);

  // U2: primary CTA — newest applicable target of the active channel.
  const onUpdateToLatest = useCallback(() => {
    const target = getLatestApplicableTarget({
      catalog,
      releaseChannel: activeChannel,
    });
    if (!target) {
      // Empty-because-degraded is NOT "you're current".
      showToast(
        buildNoTargetNotice({ catalog, releaseChannel: activeChannel }),
        "info",
      );
      return;
    }
    onRequestApply({
      payload: target.applyPayload,
      label: target.label,
      isDowngrade: false,
    });
  }, [activeChannel, catalog, onRequestApply]);

  const onMarkGood = useCallback(async () => {
    if (markingGood) return;
    setMarkingGood(true);
    try {
      await markOpenclawGood();
      showToast(
        "Marked as good — auto-rollback disarmed for this version",
        "success",
      );
      await loadChannel();
      onRefreshStatuses();
    } catch (err) {
      showToast(err?.message || "Could not mark this version as good", "error");
    } finally {
      setMarkingGood(false);
    }
  }, [loadChannel, markingGood, onRefreshStatuses]);

  // The rollback CTA never fires directly — it opens a confirm dialog first
  // (same pattern as pendingApply), and the dialog's confirm calls onRollback.
  const onRequestRollback = useCallback(() => {
    if (operation || rollingBack) return;
    setRollbackPrompt(true);
  }, [operation, rollingBack]);

  const onCancelRollback = useCallback(() => setRollbackPrompt(false), []);

  const onRollback = useCallback(async () => {
    if (rollingBack || operation) return;
    setRollbackPrompt(false);
    setRollingBack(true);
    try {
      const result = await rollbackOpenclaw();
      const targetVersion =
        result?.target?.kind === "pin"
          ? channelInfo?.pinVersion || null
          : result?.target?.version || null;
      expectedRef.current = targetVersion
        ? { channel: "stable", version: targetVersion }
        : null;
      setVerdict(null);
      setOperation({
        operationId: null,
        resumed: false,
        target: targetVersion ? { version: targetVersion } : null,
        label: targetVersion || "last known good",
        startedAt: Date.now(),
        steps: [],
        output: "",
        lastOutputAt: null,
        phase: "restarting",
        error: null,
      });
    } catch (err) {
      showToast(err?.message || "Could not roll back OpenClaw", "error");
    } finally {
      setRollingBack(false);
    }
  }, [channelInfo, operation, rollingBack]);

  const onClearBlocklist = useCallback(
    async (id) => {
      if (clearingBlocklistId) return;
      setClearingBlocklistId(id || "all");
      try {
        const data = await clearOpenclawBlocklist(id || null);
        setChannelInfo((info) =>
          info ? { ...info, blocklist: data?.blocklist || [] } : info,
        );
        setLastClearedId(id || null);
        showToast(
          "Blocklist entry cleared — you can try that version again",
          "success",
        );
        await loadCatalog();
      } catch (err) {
        showToast(err?.message || "Could not clear the blocklist", "error");
      } finally {
        setClearingBlocklistId(null);
      }
    },
    [clearingBlocklistId, loadCatalog],
  );

  const onCheckNow = useCallback(() => {
    loadCatalog({ refresh: true });
  }, [loadCatalog]);

  const onToggleNotes = useCallback(
    (rowId) =>
      setExpandedNotesId((current) => (current === rowId ? null : rowId)),
    [],
  );

  const onToggleDevAdvanced = useCallback(
    () => setDevAdvancedOpen((open) => !open),
    [],
  );

  const onToggleLog = useCallback(() => setLogOpen((open) => !open), []);

  // Durable run-log viewer: works for finished runs after a reload (fetched
  // from the ledger), not just the live SSE stream.
  const onViewRunLog = useCallback(async (operationId) => {
    if (!operationId) return;
    setRunLog({ operationId, loading: true, text: "", error: null });
    try {
      const text = await fetchOpenclawRunLogText(operationId);
      setRunLog({ operationId, loading: false, text, error: null });
    } catch (err) {
      setRunLog({
        operationId,
        loading: false,
        text: "",
        error: buildErrorEnvelopeModel(err),
      });
    }
  }, []);

  const onCloseRunLog = useCallback(() => setRunLog(null), []);
  const onDismissRunFailure = useCallback(() => setRunFailure(null), []);

  const onDismissVerdict = useCallback(() => setVerdict(null), []);
  const onDismissApplyError = useCallback(() => setApplyError(null), []);

  const actionsDisabled =
    Boolean(operation) || savingChannel || markingGood || rollingBack;

  return {
    // data
    channelInfo,
    channelError,
    loadingChannel,
    catalog,
    catalogError,
    loadingCatalog,
    refreshingCatalog,
    activeChannel,
    nowMs,
    // channel selection (immediate persist)
    onSelectChannel,
    savingChannel,
    channelSaveError,
    onDismissChannelSaveError,
    // dialogs
    pendingApply,
    onRequestApply,
    onConfirmApply,
    onCancelApply,
    // apply progress
    operation,
    applyError,
    onDismissApplyError,
    logOpen,
    onToggleLog,
    verdict,
    onDismissVerdict,
    // run ledger (timeline + post-restart continuity)
    runs,
    runFailure,
    onDismissRunFailure,
    runLog,
    onViewRunLog,
    onCloseRunLog,
    // row / card actions
    markingGood,
    onMarkGood,
    rollingBack,
    onRollback,
    rollbackPrompt,
    onRequestRollback,
    onCancelRollback,
    clearingBlocklistId,
    lastClearedId,
    onClearBlocklist,
    onCheckNow,
    onUpdateToLatest,
    expandedNotesId,
    onToggleNotes,
    devAdvancedOpen,
    onToggleDevAdvanced,
    actionsDisabled,
  };
};
