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
import {
  cachedFetch,
  getCached,
  invalidateCache,
  setCached,
} from "../../lib/api-cache.js";
import { gatewayShellStore } from "../restart-progress-card.js";
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
// Mount loads go through the SWR cache so back-navigation paints instantly
// from the last result while a background revalidation refreshes the state.
const kChannelCacheKey = "/api/openclaw/channel";
const kCatalogCacheKey = "/api/openclaw/catalog";
const kUpgradeCacheMaxAgeMs = 60_000;

export const useUpgradeTab = ({
  statusData = null,
  onRefreshStatuses = () => {},
} = {}) => {
  // Cache-backed remounts: tab switches render the last-loaded channel and
  // catalog instantly (AGENTS.md convention) while the mount loads revalidate.
  // The catalog cache stores the fetch ENVELOPE ({ catalog }) — same shape
  // loadCatalog's setCached writes — so unwrap when seeding.
  const [channelInfo, setChannelInfo] = useState(() => getCached(kChannelCacheKey));
  const [channelError, setChannelError] = useState(null);
  const [loadingChannel, setLoadingChannel] = useState(true);
  const [catalog, setCatalog] = useState(
    () => getCached(kCatalogCacheKey)?.catalog || null,
  );
  const [catalogError, setCatalogError] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(
    () => (getCached(kCatalogCacheKey)?.catalog || null) === null,
  );
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
  // Mark-good / rollback / blocklist-clear failures: persistent inline chip
  // near the controls (never toast-only for a failed action).
  const [actionError, setActionError] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const unsubscribeRef = useRef(null);
  const expectedRef = useRef(null);
  const rehydratedRef = useRef(false);
  // Mutation stamps: every mutation-path write bumps its stamp, so a mount
  // SWR revalidation that was dispatched BEFORE the mutation can be detected
  // as stale when it resolves — it must not clobber the fresher result in
  // component state, and the cache copy it just re-stamped is dropped.
  const channelMutationStampRef = useRef(0);
  const catalogMutationStampRef = useRef(0);

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

  // Two complementary guards on the channel/catalog loads:
  // - mutation stamps (upstream): a mount-time cached revalidation landing
  //   after a mutation-driven direct reload must not resurrect pre-mutation
  //   data (it also drops the cache entry it just re-stamped).
  // - latest-request-wins loadIds: overlapping loads are reachable (mount +
  //   blocklist clear + finish() + Check now), and an older response landing
  //   late must never overwrite newer channel/catalog state — that is how a
  //   just-cleared blocklist entry used to flash back as an incident.
  const channelLoadIdRef = useRef(0);
  const catalogLoadIdRef = useRef(0);

  // fromCache is mount-only: mutation-driven reloads (apply/mark-good/switch)
  // must observe the server change immediately, so they fetch directly and
  // re-seed the cache for the next mount.
  const loadChannel = useCallback(async ({ fromCache = false } = {}) => {
    const loadId = ++channelLoadIdRef.current;
    const stampAtDispatch = channelMutationStampRef.current;
    try {
      let data;
      if (fromCache) {
        data = await cachedFetch(kChannelCacheKey, fetchOpenclawChannel, {
          maxAgeMs: kUpgradeCacheMaxAgeMs,
          onRevalidate: (fresh) => {
            if (channelMutationStampRef.current !== stampAtDispatch) {
              // A mutation completed while this revalidation was in flight:
              // its result is fresher. Drop this frame — the generation-aware
              // cache already refused the stale write, and invalidating here
              // would delete the FRESH entry the mutation just seeded.
              return;
            }
            if (channelLoadIdRef.current !== loadId) return;
            setChannelInfo(fresh);
            setChannelError(null);
          },
        });
      } else {
        data = await fetchOpenclawChannel();
        channelMutationStampRef.current += 1;
        // loadId-gated: a direct load superseded by a newer load OR by a
        // mutation that bumped the loadId (blocklist clear) must not re-seed
        // the cache with pre-mutation data.
        if (channelLoadIdRef.current === loadId) {
          setCached(kChannelCacheKey, data);
        }
      }
      if (channelLoadIdRef.current !== loadId) return data;
      setChannelInfo(data);
      setChannelError(null);
      return data;
    } catch (err) {
      if (channelLoadIdRef.current === loadId) {
        setChannelError(buildErrorEnvelopeModel(err));
      }
      return null;
    } finally {
      if (channelLoadIdRef.current === loadId) setLoadingChannel(false);
    }
  }, []);

  const loadCatalog = useCallback(
    async ({ refresh = false, fromCache = false } = {}) => {
      const loadId = ++catalogLoadIdRef.current;
      const stampAtDispatch = catalogMutationStampRef.current;
      if (refresh) setRefreshingCatalog(true);
      try {
        const fetchCatalog = () => fetchOpenclawCatalog({ refresh });
        let data;
        if (fromCache && !refresh) {
          data = await cachedFetch(kCatalogCacheKey, fetchCatalog, {
            maxAgeMs: kUpgradeCacheMaxAgeMs,
            onRevalidate: (fresh) => {
              if (catalogMutationStampRef.current !== stampAtDispatch) {
                // Same guard as loadChannel: drop the frame — the cache's
                // generation guard already refused the stale write, and an
                // invalidate here would delete the mutation's fresh entry.
                return;
              }
              if (catalogLoadIdRef.current !== loadId) return;
              setCatalog(fresh?.catalog || null);
              setCatalogError(null);
            },
          });
        } else {
          data = await fetchCatalog();
          catalogMutationStampRef.current += 1;
          // loadId-gated cache seed (see loadChannel).
          if (catalogLoadIdRef.current === loadId) {
            setCached(kCatalogCacheKey, data);
          }
        }
        if (catalogLoadIdRef.current !== loadId) return data?.catalog || null;
        setCatalog(data?.catalog || null);
        setCatalogError(null);
        return data?.catalog || null;
      } catch (err) {
        if (catalogLoadIdRef.current === loadId) {
          setCatalogError(buildErrorEnvelopeModel(err));
        }
        return null;
      } finally {
        // Only the call that owns the "Checking..." label may clear it — a
        // concurrent non-refresh load finishing first must not kill the
        // indicator while the real refresh is still in flight.
        if (catalogLoadIdRef.current === loadId) {
          setRefreshingCatalog(false);
          setLoadingCatalog(false);
        }
      }
    },
    [],
  );

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
    loadChannel({ fromCache: true });
    loadCatalog({ fromCache: true });
    loadRuns();
  }, [loadChannel, loadCatalog, loadRuns]);

  // Rehydration (U4/EV10): an apply may already be in flight when the page
  // mounts (or after a reload mid-update). Resume the progress view from the
  // persisted step list; a channel poll below keeps it fresh.
  useEffect(() => {
    if (rehydratedRef.current || operation || !channelInfo) return;
    const run = channelInfo.lastUpdateRun || null;
    // Only a genuinely unfinished PERSISTED run rehydrates. A stale
    // applyInProgress flag alone (the latch is intentionally held through the
    // activation restart, and status polls can serve last-loaded data while
    // the server is down) must not conjure a phantom "Updating to unknown
    // target" card — live-caught during browser QA of the restart handoff.
    const inFlight = Boolean(run && run.target && run.finishedAt == null);
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
  }, [channelInfo, operation]);

  // Elapsed-timer / heartbeat / staleness tick.
  useEffect(() => {
    const cadenceMs = operation ? 1000 : 30000;
    const timerId = setInterval(() => setNowMs(Date.now()), cadenceMs);
    return () => clearInterval(timerId);
  }, [Boolean(operation)]);

  // M3.4: the restart handoff also announces globally — the app banner shows
  // "AlphaClaw is restarting — reconnecting automatically" while this page's
  // reconnect poller waits for the new server.
  useEffect(() => {
    const restarting = operation?.phase === "restarting";
    gatewayShellStore.publish({ upgradeRestartActive: restarting });
    return () => {
      if (restarting) {
        gatewayShellStore.publish({ upgradeRestartActive: false });
      }
    };
  }, [operation?.phase]);

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
                    finishedAt: data?.finishedAt ?? Date.now(),
                    // Streamed errors carry the same envelope fields as
                    // rejected applies — keep code/hint/docsUrl so the
                    // failure card can render the hint (U12).
                    error: buildErrorEnvelopeModel({
                      message: data?.error || "The update failed",
                      code: data?.code || null,
                      hint: data?.hint || null,
                      docsUrl: data?.docsUrl || null,
                      repairApplicable: data?.repairApplicable || null,
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
                    finishedAt: run.finishedAt ?? Date.now(),
                    error: buildErrorEnvelopeModel({
                      message:
                        run.result?.message || "The update did not complete.",
                      code: run.result?.code || null,
                      hint: run.result?.hint || null,
                      docsUrl: run.result?.docsUrl || null,
                      repairApplicable: run.result?.repairApplicable || null,
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
        // The sidebar footer and update modal read the shared /api/status
        // channel — refresh it so they don't show the old channel until the
        // next poll tick (matches onMarkGood).
        onRefreshStatuses();
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
    [activeChannel, loadChannel, onRefreshStatuses, operation, savingChannel],
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
    setActionError(null);
    try {
      await markOpenclawGood();
      showToast(
        "Marked as good — auto-rollback disarmed for this version",
        "success",
      );
      await loadChannel();
      onRefreshStatuses();
    } catch (err) {
      setActionError({
        headline: "Couldn't mark this version as good.",
        error: err,
      });
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
    setActionError(null);
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
      setActionError({ headline: "Couldn't roll back OpenClaw.", error: err });
    } finally {
      setRollingBack(false);
    }
  }, [channelInfo, operation, rollingBack]);

  const onClearBlocklist = useCallback(
    async (id) => {
      if (clearingBlocklistId) return;
      setClearingBlocklistId(id || "all");
      setActionError(null);
      try {
        const data = await clearOpenclawBlocklist(id || null);
        // The server state changed: an in-flight mount revalidation is now
        // stale (it would resurrect the cleared row), and so is the cached
        // channel payload. The loadId bump additionally invalidates any
        // DIRECT load already in flight — its response predates the clear
        // and must neither write channelInfo nor re-seed the cache.
        channelMutationStampRef.current += 1;
        channelLoadIdRef.current += 1;
        invalidateCache(kChannelCacheKey);
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
        setActionError({
          headline: "Couldn't clear the blocklist entry.",
          error: err,
        });
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
  const onDismissActionError = useCallback(() => setActionError(null), []);

  // A failed (or wedged) apply used to leave `operation` set forever, which
  // disabled every control on the page with no way out short of a reload.
  // Dismissing clears the operation and reloads channel/runs so the incident
  // card and timeline reflect the failed run; every control re-enables and
  // the user can retry from the catalog.
  const onDismissOperation = useCallback(() => {
    stopStream();
    setOperation(null);
    setLogOpen(false);
    loadChannel();
    loadRuns();
  }, [loadChannel, loadRuns, stopStream]);

  const actionsDisabled =
    Boolean(operation) ||
    savingChannel ||
    markingGood ||
    rollingBack ||
    Boolean(clearingBlocklistId) ||
    refreshingCatalog;

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
    onDismissOperation,
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
    actionError,
    onDismissActionError,
    onCheckNow,
    onUpdateToLatest,
    expandedNotesId,
    onToggleNotes,
    devAdvancedOpen,
    onToggleDevAdvanced,
    actionsDisabled,
  };
};
