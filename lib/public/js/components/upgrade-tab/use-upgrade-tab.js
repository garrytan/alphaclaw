import { prepareBackupRiskApply } from "./backup-risk-consent.js";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  applyOpenclawVersion,
  createOpenclawBackup,
  requestOpenclawBackupRiskConsent,
  clearOpenclawBlocklist,
  fetchOpenclawRunLogText,
  markOpenclawGood,
  reconcileInstalledOpenclaw,
  retryOpenclawReconcile,
  rollbackOpenclaw,
  runOpenclawRepair,
  subscribeOpenclawApplyEvents,
  updateOpenclawReleaseChannel,
} from "../../lib/api.js";
import { invalidateCache } from "../../lib/api-cache.js";
import { gatewayShellStore } from "../restart-progress-card.js";
import {
  buildApplyConfirmModel,
  buildBackupReuseConsent,
  buildBackupReuseConsentModel,
  buildBackupReuseOfferModel,
  buildChannelSaveErrorModel,
  buildErrorEnvelopeModel,
  buildNoBackupConsentOfferModel,
  buildLastManualBackupLine,
  buildNoTargetNotice,
  buildStalenessLabel,
  compareVersions,
  describeTarget,
  getLatestApplicableTarget,
} from "./helpers.js";
import { useBackupsInventory } from "./use-backups-inventory.js";
import { resumeLedgerOperation, useOperationMonitor } from "./use-operation-monitor.js";
import { kChannelCacheKey, useUpgradeReads } from "./use-upgrade-reads.js";
import { showToast } from "../toast.js";
import { useNowMs } from "../../hooks/use-now-ms.js";

const kMaxOutputChars = 40000;
// A backup-failure offer (reuse / no-backup consent) remembers the declared
// direction of the apply it came from, so its token-bound retry re-posts it.
const withIntent = (offer, intent) =>
  offer && intent ? { ...offer, intent } : offer;

const kCatalogStaleFollowUpMs = 5_000;

export const useUpgradeTab = ({
  statusData = null,
  onRefreshStatuses = () => {},
  // Test seam for the stale follow-up delay (see kCatalogStaleFollowUpMs).
  catalogStaleFollowUpMs = kCatalogStaleFollowUpMs,
} = {}) => {
  const {
    channelInfo, channelError, loadingChannel, catalog, whatsNew,
    catalogError, loadingCatalog, refreshingCatalog, loadChannel, loadCatalog, updateChannel,
    runs, runsError, loadRuns,
  } = useUpgradeReads({ catalogStaleFollowUpMs });
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [savingChannel, setSavingChannel] = useState(false);
  const [channelSaveError, setChannelSaveError] = useState(null);
  // v0.9.81 (C3): "Back up now" request in flight (before the operation card
  // takes over).
  const [backupNowStarting, setBackupNowStarting] = useState(false);
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
  // Second-stage rollback fence (issue #20): null | { message, backupFile }
  // from the server's 409 rollback_requires_confirmation envelope — the
  // update migrated the state DBs, so rolling back needs data-risk consent.
  const [rollbackDataRisk, setRollbackDataRisk] = useState(null);
  // Backup-reuse offer (WI-4.5): null | buildBackupReuseOfferModel() from a
  // 409 backup_failed that carried `reusableBackup`. The second-stage consent
  // dialog (backupReuseRetryPrompt) resends the apply bound to its sha256.
  const [backupReuseOffer, setBackupReuseOffer] = useState(null);
  const [backupReuseRetryPrompt, setBackupReuseRetryPrompt] = useState(false);
  // No-backup consent offer (#79 (b)): null | buildNoBackupConsentOfferModel()
  // from a 409 backup_required_for_migration (the ONLY overridable backup
  // code). The second-stage dialog (noBackupConsentPrompt) holds a
  // dialog-local checkbox — default OFF on every open, never persisted — and
  // its confirm resends the apply with `confirmNoBackup: true`.
  const [noBackupConsentOffer, setNoBackupConsentOffer] = useState(null);
  const [noBackupConsentPrompt, setNoBackupConsentPrompt] = useState(false);
  const [noBackupConsentChecked, setNoBackupConsentChecked] = useState(false);
  const [noBackupConsentStarting, setNoBackupConsentStarting] = useState(false);
  const noBackupConsentBusyRef = useRef(false);
  const noBackupConsentGeneration = useRef(0);
  // Both backup offers describe ONE failed apply; every path that retires the
  // reuse offer retires this one too (setters only — safe from any closure).
  const clearNoBackupConsent = () => {
    noBackupConsentGeneration.current += 1;
    setNoBackupConsentOffer(null);
    setNoBackupConsentPrompt(false);
    setNoBackupConsentChecked(false);
  };
  // Gateway-hold recovery: which retry is in flight (null | "retry" | "strip"),
  // whether the strip confirm is open, and the persistent inline error state.
  const [retryingReconcile, setRetryingReconcile] = useState(null);
  const [stripReconcilePrompt, setStripReconcilePrompt] = useState(false);
  const [reconcileError, setReconcileError] = useState(null);
  // Installed-tree reconcile (#76 B1.2): pending flag + persistent inline
  // error for the "Re-activate recorded build" card.
  const [reconcilingInstalled, setReconcilingInstalled] = useState(false);
  const [reconcileInstalledError, setReconcileInstalledError] = useState(null);
  const [clearingBlocklistId, setClearingBlocklistId] = useState(null);
  const [lastClearedId, setLastClearedId] = useState(null);
  // Mark-good / rollback / blocklist-clear failures: persistent inline chip
  // near the controls (never toast-only for a failed action).
  const [actionError, setActionError] = useState(null);
  const unsubscribeRef = useRef(null);
  const streamGenerationRef = useRef(0);
  const expectedRef = useRef(null);
  const rehydratedRef = useRef(false);
  // The apply in flight ({ payload, label }) — the streamed terminal failure
  // needs the target to build a reuse offer, and the SSE handler's closure
  // predates the operation state.
  const applyTargetRef = useRef(null);
  const activeChannel =
    selectedChannel ||
    channelInfo?.releaseChannel ||
    statusData?.openclawChannel?.releaseChannel ||
    "stable";

  const stopStream = useCallback(() => {
    streamGenerationRef.current += 1;
    if (unsubscribeRef.current) {
      try {
        unsubscribeRef.current();
      } catch {}
      unsubscribeRef.current = null;
    }
  }, []);

  useEffect(() => {
    loadChannel({ fromCache: true });
    loadCatalog({ fromCache: true });
    loadRuns();
  }, [loadChannel, loadCatalog, loadRuns]);

  // Discover every active kind from the durable ledger. Once selected, the
  // monitor reads that exact operation, even if a newer run appears.
  useEffect(() => {
    if (rehydratedRef.current || operation) return;
    const resumed = resumeLedgerOperation(runs);
    if (!resumed) return;
    rehydratedRef.current = true;
    expectedRef.current = resumed.target;
    setOperation(resumed);
  }, [operation, runs]);

  // Elapsed-timer / heartbeat / staleness clock: 1s during an operation,
  // 30s otherwise; pauses while hidden (shared useNowMs, fix wave F160).
  const nowMs = useNowMs(operation ? 1000 : 30000);

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

  // Backup inventory (WI-4.3): cached read shared by the Backups card and the
  // apply confirm's reuse-consent candidate; force-refreshed whenever an apply
  // settles (the archive set only changes then).
  const backups = useBackupsInventory();
  const refreshBackups = backups.refreshBackups;

  const beginRestartHandoff = useCallback(() => {
    stopStream();
    setOperation((op) => (op ? { ...op, phase: "restarting" } : op));
  }, [stopStream]);

  const subscribeToOperation = useCallback(
    (operationId, { repair = false, backup = false } = {}) => {
      stopStream();
      const generation = streamGenerationRef.current;
      unsubscribeRef.current = subscribeOpenclawApplyEvents({
        operationId,
        onMessage: ({ event, data }) => {
          if (streamGenerationRef.current !== generation) return;
          if (event === "step") {
            setOperation((op) => {
              if (!op || op.operationId !== operationId) return op;
              const next = { ...op, steps: [...op.steps, data] };
              if (data?.name === "restarting" && !repair && !backup) next.phase = "restarting";
              return next;
            });
            if (data?.name === "restarting" && !repair && !backup) stopStream();
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
            if (repair) {
              // Repair completes in place — no process restart to reconnect to.
              stopStream();
              setOperation((op) => op?.operationId === operationId ? { ...op, phase: "completed", finishedAt: Date.now(), result: data || null } : op);
              showToast("Repair completed", "success");
              loadChannel();
              loadRuns();
              return;
            }
            if (backup) {
              // v0.9.81 (C3): a standalone backup completes in place too — the
              // card turns into the completed state (archive name, "Retry
              // update to X" when this backup repaired a failed update).
              stopStream();
              setOperation((op) =>
                op ? { ...op, phase: "completed", finishedAt: Date.now(), result: data || null } : op,
              );
              showToast(
                data?.archive?.file
                  ? `Backup written: ${String(data.archive.file).split("/").pop()}`
                  : "Backup completed",
                "success",
              );
              refreshBackups();
              loadRuns();
              return;
            }
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
            // A standalone backup (v0.9.81) has no update to wave through:
            // neither consent offer applies, and applyTargetRef still names
            // the LAST apply — binding an offer to it would start an update
            // the operator never asked for.
            if (backup || repair) {
              loadRuns();
              refreshBackups();
              return;
            }
            // A streamed 409 backup_failed carrying `reusableBackup` offers
            // the consented retry exactly like the quick-result path.
            const inFlight = applyTargetRef.current;
            setBackupReuseOffer(
              withIntent(
                buildBackupReuseOfferModel({
                  error: { code: data?.code, reusableBackup: data?.reusableBackup },
                  target: inFlight?.payload || null,
                  label: inFlight?.label || "",
                }),
                inFlight?.intent || null,
              ),
            );
            // Likewise a streamed 409 backup_required_for_migration offers
            // the no-backup consent against the in-flight target.
            setNoBackupConsentOffer(
              withIntent(
                buildNoBackupConsentOfferModel({
                  error: { code: data?.code, message: data?.error, hint: data?.hint,
                    backupRiskEligible: data?.backupRiskEligible, operationId },
                  target: inFlight?.payload || null,
                  label: inFlight?.label || "",
                }),
                inFlight?.intent || null,
              ),
            );
            loadChannel();
            refreshBackups();
          }
        },
        onError: () => {
          if (streamGenerationRef.current !== generation) return;
          // The connection dropped. If the apply reached the restart phase,
          // hand off to the reconnect poller; otherwise fall back to polling
          // the persisted run state (a long dev build surviving an SSE blip).
          setOperation((op) => {
            if (!op || op.operationId !== operationId || op.phase !== "running") return op;
            const reachedRestart = !repair && !backup && op.steps.some(
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
    [beginRestartHandoff, loadChannel, refreshBackups, stopStream, loadRuns],
  );

  // D3: dev-checkout failures recover with `openclaw update repair`; package
  // channels re-stage the version instead (the server enforces this too).
  const repairAvailable =
    channelInfo?.releaseChannel === "dev" ||
    channelInfo?.applied?.channel === "dev";

  const onRunRepair = useCallback(async () => {
    stopStream();
    setApplyError(null);
    setVerdict(null);
    // A repair replaces the failed apply's surfaces: a 409 backup_failed offer
    // left over from that apply must not render under the repair's own error
    // (and re-send the earlier target with consent from there).
    setBackupReuseOffer(null);
    setBackupReuseRetryPrompt(false);
    clearNoBackupConsent();
    setOperation({
      operationId: null,
      resumed: false,
      target: { repair: true },
      label: "repair",
      startedAt: Date.now(),
      steps: [],
      output: "",
      lastOutputAt: null,
      phase: "running",
      error: null,
    });
    try {
      const result = await runOpenclawRepair();
      const operationId = result?.operationId || null;
      if (operationId && result?.events) {
        setOperation((op) => (op ? { ...op, operationId } : op));
        subscribeToOperation(operationId, { repair: true });
        return;
      }
      // Quick synchronous success — repair finished in place, no restart.
      setOperation((op) => op ? { ...op, operationId, phase: "completed", finishedAt: Date.now(), result } : op);
      showToast("Repair completed", "success");
      loadChannel();
      loadRuns();
    } catch (err) {
      setOperation(null);
      setApplyError(buildErrorEnvelopeModel(err));
    }
  }, [loadChannel, loadRuns, stopStream, subscribeToOperation]);

  // `allowBackupReuse` ({ sha256 } | null) and `confirmNoBackup` (true |
  // false) ride the request body ONLY — the operation's recorded target stays
  // the bare payload, so a later "Re-stage version" never silently inherits a
  // consent given for one attempt.
  // v0.9.81 (D13): the direction a stable/beta apply DECLARES to the server,
  // derived from the running version when the caller did not say. Dev
  // payloads carry none (a commit has no version direction).
  const deriveIntentFor = useCallback(
    (payload) => {
      if (!payload || payload.channel === "dev" || !payload.version) return null;
      const installed = channelInfo?.installedVersion || null;
      if (!installed) return "switch";
      const cmp = compareVersions(payload.version, installed);
      return cmp > 0 ? "update" : cmp < 0 ? "downgrade" : "switch";
    },
    [channelInfo],
  );
  // onRequestApply is declared below startApply (it needs the catalog and
  // channel state); the catalog_stale re-open reaches it through this ref.
  const onRequestApplyRef = useRef(null);

  const startApply = useCallback(
    async ({
      payload,
      label,
      allowBackupReuse = null,
      confirmNoBackup = false,
      confirmNoBackupToken = null,
      intent = null,
      expectLatest = false,
      // Set on the ONE re-open a 409 catalog_stale triggers: a second stale
      // verdict in the same click chain is an error, never a loop (D2).
      staleRetried = false,
    }) => {
      stopStream();
      setApplyError(null);
      setVerdict(null);
      setRunFailure(null);
      setBackupReuseOffer(null);
      setBackupReuseRetryPrompt(false);
      clearNoBackupConsent();
      // A dev apply never carries a direction (a commit has no version).
      const declaredIntent = payload?.channel === "dev" ? null : intent || deriveIntentFor(payload);
      applyTargetRef.current = {
        payload,
        label: label || describeTarget(payload),
        intent: declaredIntent,
        expectLatest: expectLatest === true,
      };
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
        intent: declaredIntent,
        startedAt: Date.now(),
        steps: [],
        output: "",
        lastOutputAt: null,
        phase: "running",
        error: null,
      });
      try {
        const result = await applyOpenclawVersion({
          ...payload,
          ...(declaredIntent ? { intent: declaredIntent } : {}),
          ...(expectLatest === true ? { expectLatest: true } : {}),
          ...(allowBackupReuse ? { allowBackupReuse } : {}),
          ...(confirmNoBackup === true ? { confirmNoBackup: true, confirmNoBackupToken } : {}),
        });
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
        // 409 catalog_stale (v0.9.81, D2): the server's channel latest is
        // newer than what this page believed. Reload the catalog (forced)
        // ONCE and re-open the confirm on the server's `latest`; a second
        // stale verdict in the same chain is an error toast, never a loop.
        if (err?.code === "catalog_stale" && err.latest && payload?.channel && !staleRetried) {
          showToast(
            `${err.latest} is now the latest ${payload.channel} — catalog refreshed, review the update again.`,
            "info",
          );
          await loadCatalog({ refresh: true });
          onRequestApplyRef.current?.({
            payload: { channel: payload.channel, version: err.latest },
            label: err.latest,
            isDowngrade: false,
            intent: "update",
            expectLatest: true,
            staleRetried: true,
          });
          return;
        }
        setApplyError(buildErrorEnvelopeModel(err));
        // 409 intent_mismatch: the page's view of the running version or the
        // row's direction is stale — reload both so the buttons say the truth.
        if (err?.code === "intent_mismatch" || err?.code === "catalog_stale") {
          showToast(err.message || "The update target changed — review it again.", "error");
          loadChannel();
          loadCatalog({ refresh: true });
        }
        // 409 backup_failed + reusableBackup: not a dead end — offer the
        // consented retry (second-stage dialog) next to the error.
        setBackupReuseOffer(
          withIntent(buildBackupReuseOfferModel({ error: err, target: payload, label }), declaredIntent),
        );
        // 409 backup_required_for_migration: offer the explicit no-backup
        // consent (second-stage dialog) next to the error.
        setNoBackupConsentOffer(
          withIntent(buildNoBackupConsentOfferModel({ error: err, target: payload, label }), declaredIntent),
        );
        refreshBackups();
      }
    },
    [channelInfo, deriveIntentFor, loadCatalog, loadChannel, refreshBackups, subscribeToOperation],
  );

  // "Back up now" (v0.9.81, C3): the standalone backup run. `retryUpdate`
  // remembers the failed apply this backup is repairing, so the completed card
  // can offer "Retry update to X" (one click, one run — never chained).
  const kBackupEntryRefusalCodes = [
    "operation_in_progress",
    "gateway_busy",
    "gateway_operation_in_progress",
    "not_onboarded",
    "self_update_in_progress",
    "apply_in_progress",
    "gateway_held",
    "gateway_hold_unreadable",
    "booting",
    "lease_expired",
    "backup_unavailable",
  ];
  const startBackup = useCallback(
    async ({ retryUpdate = null } = {}) => {
      if (backupNowStarting) return;
      stopStream();
      setBackupNowStarting(true);
      setApplyError(null);
      setVerdict(null);
      setRunFailure(null);
      setBackupReuseOffer(null);
      setBackupReuseRetryPrompt(false);
      clearNoBackupConsent();
      setOperation({
        operationId: null,
        resumed: false,
        target: { kind: "backup" },
        label: "manual backup",
        startedAt: Date.now(),
        steps: [],
        output: "",
        lastOutputAt: null,
        phase: "running",
        error: null,
        ...(retryUpdate ? { retryUpdate } : {}),
      });
      try {
        const result = await createOpenclawBackup();
        const operationId = result?.operationId || null;
        if (operationId && result?.events) {
          setOperation((op) => (op ? { ...op, operationId } : op));
          subscribeToOperation(operationId, { backup: true });
          return;
        }
        // Quick synchronous success: the archive is already on disk.
        setOperation((op) =>
          op ? { ...op, operationId, phase: "completed", finishedAt: Date.now(), result } : op,
        );
        showToast(
          result?.archive?.file
            ? `Backup written: ${String(result.archive.file).split("/").pop()}`
            : "Backup completed",
          "success",
        );
        refreshBackups();
        loadRuns();
      } catch (err) {
        if (kBackupEntryRefusalCodes.includes(err?.code)) {
          // Refused before anything started: no failed card, just the reason.
          setOperation(null);
          showToast(err.message || "The backup could not start.", "error");
          return;
        }
        // The ladder ran and failed (a quick 409 backup_failed): the card
        // stays up as a failed backup with "Retry backup".
        setOperation((op) =>
          op
            ? {
                ...op,
                operationId: err?.operationId || op.operationId || null,
                phase: "failed",
                finishedAt: Date.now(),
                error: buildErrorEnvelopeModel(err),
              }
            : op,
        );
        refreshBackups();
        loadRuns();
      } finally {
        setBackupNowStarting(false);
      }
    },
    [backupNowStarting, loadRuns, refreshBackups, subscribeToOperation],
  );

  const onBackupNow = useCallback(() => {
    if (operation) return;
    return startBackup();
  }, [operation, startBackup]);

  // C4: "Retry backup" on a backup-class failure — dismiss the failed card
  // (re-enabling the page) THEN start a standalone backup, remembering the
  // failed update (payload + declared intent) for the completed card's "Retry
  // update to X". A failed standalone backup simply retries itself.
  const onRetryBackup = useCallback(() => {
    if (backupNowStarting) return;
    let retryUpdate = null;
    if (operation) {
      if (operation.phase !== "failed") return;
      retryUpdate =
        operation.target?.kind === "backup"
          ? operation.retryUpdate || null
          : operation.target?.channel
            ? { payload: operation.target, label: operation.label || describeTarget(operation.target), intent: operation.intent || null }
            : null;
      stopStream();
      setLogOpen(false);
    } else if (applyError && applyTargetRef.current?.payload?.channel) {
      const inFlight = applyTargetRef.current;
      retryUpdate = { payload: inFlight.payload, label: inFlight.label, intent: inFlight.intent || null };
    }
    setOperation(null);
    setBackupReuseOffer(null);
    setBackupReuseRetryPrompt(false);
    clearNoBackupConsent();
    return startBackup({ retryUpdate });
  }, [applyError, backupNowStarting, operation, startBackup, stopStream]);

  // "Retry update to X" after a repair backup completed: dismiss the backup
  // card and re-open the update's confirm with the ORIGINAL payload and
  // intent — the operator confirms, and a fresh apply runs (the new archive
  // also satisfies the ≤ 24 h consented-reuse gate if the ladder fails again).
  const onRetryUpdate = useCallback(() => {
    const retry = operation?.retryUpdate || null;
    if (!retry?.payload || operation?.phase !== "completed") return;
    stopStream();
    setOperation(null);
    setLogOpen(false);
    onRequestApplyRef.current?.({
      payload: retry.payload,
      label: retry.label || describeTarget(retry.payload),
      isDowngrade: retry.intent === "downgrade",
      intent: retry.intent || null,
      afterCompletedOperation: true,
    });
  }, [operation, stopStream]);

  // D3: "Re-stage version" — re-run the same apply target after a failed
  // package-channel update (overlay staging replaces the whole tree).
  const onRetryApply = useCallback(() => {
    const target = operation?.target || null;
    if (!target || target.repair) return;
    startApply({
      payload: target,
      label: operation?.label || null,
      intent: operation?.intent || null,
    });
  }, [operation, startApply]);

  const operationMonitor = useOperationMonitor({
    operation,
    setOperation,
    expectedRef,
    onTerminal: (run, phase) => {
      loadRuns();
      loadChannel();
      refreshBackups();
      if (phase !== "failed" || run.target?.repair || run.target?.kind === "backup") return;
      setBackupReuseOffer(buildBackupReuseOfferModel({
        error: run.result, target: run.target, label: describeTarget(run.target),
      }));
      setNoBackupConsentOffer(buildNoBackupConsentOfferModel({
        error: { ...run.result, operationId: run.operationId },
        target: run.target, label: describeTarget(run.target),
      }));
    },
    onRestartFinished: (verdictModel) => {
      setVerdict(verdictModel);
      setOperation(null);
      loadChannel();
      loadCatalog();
      loadRuns();
      onRefreshStatuses();
      refreshBackups();
    },
  });

  useEffect(() => () => {
    noBackupConsentGeneration.current += 1;
    stopStream();
  }, [stopStream]);

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
        // 2.1: whatsNew (and its securityFlips) rides the catalog payload and
        // is channel-scoped — reload it so a same-session stable→beta flip
        // surfaces the NEW channel's WhatsNewCard and populates the apply
        // dialog's security-flips block. No refresh: this is a cheap re-read,
        // not a network-forcing catalog rebuild.
        await loadCatalog();
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
    [
      activeChannel,
      loadChannel,
      loadCatalog,
      onRefreshStatuses,
      operation,
      savingChannel,
    ],
  );

  const onDismissChannelSaveError = useCallback(
    () => setChannelSaveError(null),
    [],
  );

  const onRequestApply = useCallback(
    ({
      payload,
      label,
      isDowngrade: isDowngradeClaim = false,
      intent: intentClaim = null,
      expectLatest = false,
      staleRetried = false,
      // "Retry update to X" (v0.9.81) opens the confirm from a COMPLETED
      // backup card it is dismissing in the same tick — the closure still
      // sees that operation, so the caller says it has already cleared it.
      afterCompletedOperation = false,
    }) => {
      if (operation && !(afterCompletedOperation && operation.phase === "completed")) return;
      // Defense in depth (v0.9.81, B2): the direction is derived from the
      // running version here too, so a caller that passes isDowngrade: false
      // for an older version still gets the "Downgrade to …?" confirm with
      // the hard-gate copy — and posts the matching intent.
      const derivedIntent = deriveIntentFor(payload);
      const isDowngrade = isDowngradeClaim === true || derivedIntent === "downgrade";
      const intent = payload?.channel === "dev" ? null : derivedIntent || intentClaim || null;
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
      // Curated security-default flips (D5): surfaced when the target crosses
      // into the channel the whats-new entry covers (e.g. stable→beta), so
      // critical behavior changes are visible on the moment of commitment.
      const securityFlips =
        payload?.channel &&
        payload.channel !== currentChannel &&
        whatsNew &&
        whatsNew.channel === payload.channel &&
        Array.isArray(whatsNew.securityFlips)
          ? whatsNew.securityFlips
          : [];
      setPendingApply({
        payload,
        label,
        isDowngrade,
        intent,
        expectLatest: expectLatest === true && intent === "update",
        staleRetried: staleRetried === true,
        // Reuse consent is dialog-local and defaults OFF on EVERY open — never
        // remembered across dialogs, never read from storage.
        reuseConsent: false,
        confirm: buildApplyConfirmModel({
          payload,
          label,
          isDowngrade,
          currentChannel,
          notesAvailable,
          securityFlips,
          backupInventory: backups.inventory,
          backupInventoryError: backups.error,
          backupInventoryLoading: backups.loading,
          channelInfo,
          nowMs: Date.now(),
        }),
      });
    },
    [backups.error, backups.inventory, backups.loading, catalog, channelInfo, deriveIntentFor, operation, whatsNew],
  );
  onRequestApplyRef.current = onRequestApply;

  const onCancelApply = useCallback(() => setPendingApply(null), []);

  // An open hard-gated confirm keeps its reuse candidate bound to the LIVE
  // inventory: the forced re-read after a failed apply may land while the
  // operator is already looking at the next confirm, and the consent must
  // name (and send the digest of) the archive that is newest NOW, never the
  // one a pre-failure snapshot remembered. A consent the operator already
  // CHECKED is bound to the digest they saw: when the rebind changes that
  // digest (or the candidate disappears) the consent is revoked and the
  // dialog says why — a stale checkmark must never ride the apply with an
  // archive nobody authorized. Same digest = same authorization, kept.
  // Declared last so the harness's effect indices for the earlier effects
  // stay stable.
  useEffect(() => {
    setPendingApply((pending) => {
      if (!pending?.confirm?.hardGate) return pending;
      const next = buildBackupReuseConsentModel({
        inventory: backups.inventory,
        inventoryError: backups.error,
        inventoryLoading: backups.loading,
        channelInfo,
        nowMs: Date.now(),
      });
      const prev = pending.confirm.backupReuse || null;
      if (
        prev &&
        prev.available === next.available &&
        prev.sha256 === next.sha256 &&
        prev.reason === next.reason
      ) {
        return pending;
      }
      const digestChanged = (prev?.sha256 || null) !== (next.sha256 || null);
      const revoked = pending.reuseConsent === true && digestChanged;
      return {
        ...pending,
        reuseConsent: revoked ? false : pending.reuseConsent,
        reuseConsentReset: revoked ? true : pending.reuseConsentReset === true,
        confirm: { ...pending.confirm, backupReuse: next },
      };
    });
  }, [backups.error, backups.inventory, backups.loading, channelInfo]);

  const onToggleBackupReuseConsent = useCallback(
    (next) =>
      setPendingApply((pending) =>
        // A fresh decision on the CURRENT candidate retires the revocation
        // notice — the operator has now seen (and ruled on) this archive.
        pending
          ? { ...pending, reuseConsent: next === true, reuseConsentReset: false }
          : pending,
      ),
    [],
  );

  const onConfirmApply = useCallback(async () => {
    const pending = pendingApply;
    if (!pending) return;
    setPendingApply(null);
    await startApply({
      payload: pending.payload,
      label: pending.label,
      intent: pending.intent || null,
      expectLatest: pending.expectLatest === true,
      staleRetried: pending.staleRetried === true,
      allowBackupReuse: buildBackupReuseConsent({
        consentModel: pending.confirm?.backupReuse || null,
        checked: pending.reuseConsent === true,
      }),
    });
  }, [pendingApply, startApply]);

  // Second-stage reuse retry (WI-4.5): the CTA only OPENS the dialog; its
  // confirm resends the same target with consent bound to the offered sha256.
  const onRequestBackupReuseRetry = useCallback(() => {
    if (!backupReuseOffer) return;
    setBackupReuseRetryPrompt(true);
  }, [backupReuseOffer]);

  const onCancelBackupReuseRetry = useCallback(
    () => setBackupReuseRetryPrompt(false),
    [],
  );

  const onConfirmBackupReuseRetry = useCallback(async () => {
    const offer = backupReuseOffer;
    if (!offer?.target || !offer.sha256) return;
    setBackupReuseRetryPrompt(false);
    await startApply({
      payload: offer.target,
      label: offer.label,
      intent: offer.intent || null,
      allowBackupReuse: { sha256: offer.sha256 },
    });
  }, [backupReuseOffer, startApply]);

  // Second-stage no-backup consent (#79 (b)): the CTA only OPENS the dialog
  // with its checkbox OFF; the confirm is inert until the operator checks it,
  // and then resends the same target with confirmNoBackup: true.
  const onRequestNoBackupConsent = useCallback(() => {
    if (!noBackupConsentOffer) return;
    setNoBackupConsentChecked(false);
    setNoBackupConsentPrompt(true);
  }, [noBackupConsentOffer]);

  const onCancelNoBackupConsent = useCallback(() => {
    noBackupConsentGeneration.current += 1;
    setNoBackupConsentPrompt(false);
    setNoBackupConsentChecked(false);
  }, []);

  const onToggleNoBackupConsent = useCallback(
    (next) => setNoBackupConsentChecked(next === true),
    [],
  );

  const onConfirmNoBackupConsent = useCallback(async () => {
    const offer = noBackupConsentOffer;
    if (!offer?.target || noBackupConsentChecked !== true || noBackupConsentBusyRef.current) return;
    noBackupConsentBusyRef.current = true;
    setNoBackupConsentStarting(true);
    const generation = noBackupConsentGeneration.current;
    try {
      const apply = await prepareBackupRiskApply(offer, requestOpenclawBackupRiskConsent);
      if (generation !== noBackupConsentGeneration.current) return;
      setNoBackupConsentPrompt(false);
      setNoBackupConsentChecked(false);
      await startApply({ ...apply, intent: apply.intent || deriveIntentFor(apply.payload) });
    } catch (error) {
      if (generation !== noBackupConsentGeneration.current) return;
      setApplyError(buildErrorEnvelopeModel(error));
      setNoBackupConsentPrompt(false);
      setNoBackupConsentChecked(false);
    } finally {
      noBackupConsentBusyRef.current = false;
      setNoBackupConsentStarting(false);
    }
  }, [deriveIntentFor, noBackupConsentChecked, noBackupConsentOffer, startApply]);

  // U2: primary CTA — newest applicable target of the active channel.
  const onUpdateToLatest = useCallback(() => {
    // Same inputs as the view's `latestTarget` (index.js) — including the
    // engines gate (v0.9.80): the click must never resolve to a row the card
    // just rendered as "Needs Node.js …" with a disabled Apply.
    const target = getLatestApplicableTarget({
      catalog,
      releaseChannel: activeChannel,
      nodeVersion: channelInfo?.nodeVersion || null,
      installedVersion: channelInfo?.installedVersion || null,
    });
    if (!target) {
      // Empty-because-degraded is NOT "you're current" — and neither is a
      // latest that is blocklisted or needs a newer Node (v0.9.81 reasons).
      showToast(
        buildNoTargetNotice({
          catalog,
          releaseChannel: activeChannel,
          nodeVersion: channelInfo?.nodeVersion || null,
          installedVersion: channelInfo?.installedVersion || null,
        }),
        "info",
      );
      return;
    }
    // Belt 2 (v0.9.81): "Update to latest" is an upgrade or nothing. The
    // helper already filters to strictly-newer rows; this refuses anything
    // that still is not, instead of opening a confirm with the downgrade
    // warning switched off.
    const installed = channelInfo?.installedVersion || null;
    if (
      target.applyPayload?.channel !== "dev" &&
      (!installed || compareVersions(target.label, installed) <= 0)
    ) {
      showToast(
        `Update to latest refused: ${target.label} is not newer than the running ${installed || "version"}.`,
        "error",
      );
      return;
    }
    onRequestApply({
      payload: target.applyPayload,
      label: target.label,
      isDowngrade: false,
      // Dev's "latest" is main HEAD: no direction, no latest claim.
      intent: target.applyPayload?.channel === "dev" ? null : target.intent || "update",
      expectLatest: target.applyPayload?.channel !== "dev" && target.expectLatest === true,
    });
  }, [activeChannel, catalog, channelInfo, onRequestApply]);

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

  // Gateway-hold recovery: re-run the failed settings migration, optionally
  // consenting to strip the exact keys the validator blamed. Success clears
  // the hold server-side and relaunches the gateway — reload the channel so
  // the hold card leaves (and refresh the shared /api/status consumers).
  const runReconcileRetry = useCallback(
    async ({ stripBlamedKeys = false } = {}) => {
      if (retryingReconcile) return;
      setRetryingReconcile(stripBlamedKeys ? "strip" : "retry");
      setReconcileError(null);
      try {
        const result = await retryOpenclawReconcile(
          stripBlamedKeys ? { stripBlamedKeys: true } : {},
        );
        if (result?.gatewayStart && result.gatewayStart.ok === false) {
          // Migration succeeded (the hold is cleared) but the relaunch
          // errored — that must never read as a silent success.
          setReconcileError({
            headline:
              "Settings migration succeeded, but the gateway failed to start.",
            error: { message: result.gatewayStart.error || "Gateway start failed" },
          });
        } else {
          showToast(
            "Settings migration succeeded — the gateway is starting",
            "success",
          );
        }
        await loadChannel();
        onRefreshStatuses();
      } catch (err) {
        // A 409 still-held response carries the FRESH outcome — name the new
        // hold inline instead of a generic failure. Structural holds keep
        // their prose in `detail` (`reason` is a class token).
        const heldReason =
          err?.code === "reconcile_still_held"
            ? err?.outcome?.hold?.detail || err?.outcome?.hold?.reason || null
            : null;
        setReconcileError(
          heldReason
            ? { headline: `Migration is still held: ${heldReason}`, error: null }
            : { headline: "Couldn't retry the settings migration.", error: err },
        );
        // The hold (reason, blamed keys) may have changed — re-read it.
        await loadChannel();
      } finally {
        setRetryingReconcile(null);
      }
    },
    [loadChannel, onRefreshStatuses, retryingReconcile],
  );

  const onRetryReconcile = useCallback(
    () => runReconcileRetry(),
    [runReconcileRetry],
  );

  // The strip CTA never fires directly — it opens a confirm dialog first
  // (same pattern as rollbackPrompt); the dialog's confirm consents.
  const onRequestStripReconcile = useCallback(() => {
    if (retryingReconcile) return;
    setStripReconcilePrompt(true);
  }, [retryingReconcile]);

  const onCancelStripReconcile = useCallback(
    () => setStripReconcilePrompt(false),
    [],
  );

  const onConfirmStripReconcile = useCallback(async () => {
    setStripReconcilePrompt(false);
    await runReconcileRetry({ stripBlamedKeys: true });
  }, [runReconcileRetry]);

  const onDismissReconcileError = useCallback(
    () => setReconcileError(null),
    [],
  );

  // Installed-tree reconcile (#76 B1.2 / CEO 11.1): swap the recorded
  // build's local copy back in and relaunch. Success → toast (server copy) +
  // channel reload (the card leaves once installedDiverged clears) + shared
  // status refresh; a relaunch that did not verify is NOT a silent success;
  // failure → persistent inline chip with the server's envelope.
  const onReconcileInstalled = useCallback(async () => {
    if (reconcilingInstalled) return;
    const copy = channelInfo?.reconcileInstalled?.copy || {};
    setReconcilingInstalled(true);
    setReconcileInstalledError(null);
    try {
      const result = await reconcileInstalledOpenclaw();
      if (result?.action === "activated" && result?.relaunch && result.relaunch.ok === false) {
        setReconcileInstalledError({
          headline: copy.relaunchFailedHeadline || "The gateway did not come back.",
          error: {
            message: result.relaunch.error || result.relaunch.verdict || "Relaunch failed",
          },
        });
      } else {
        showToast(
          result?.action === "activated"
            ? copy.successToast || "Recorded build re-activated"
            : copy.noopToast || "Nothing to reconcile",
          "success",
        );
      }
      invalidateCache(kChannelCacheKey);
      await loadChannel();
      onRefreshStatuses();
    } catch (err) {
      setReconcileInstalledError({
        headline: copy.errorHeadline || "Couldn't re-activate the recorded build.",
        error: err,
      });
      // The blocker (hold, apply) may have changed — re-read it.
      await loadChannel();
    } finally {
      setReconcilingInstalled(false);
    }
  }, [channelInfo, loadChannel, onRefreshStatuses, reconcilingInstalled]);

  const onDismissReconcileInstalledError = useCallback(
    () => setReconcileInstalledError(null),
    [],
  );

  // The rollback CTA never fires directly — it opens a confirm dialog first
  // (same pattern as pendingApply), and the dialog's confirm calls onRollback.
  const onRequestRollback = useCallback(() => {
    if (operation || rollingBack) return;
    setRollbackPrompt(true);
  }, [operation, rollingBack]);

  const onCancelRollback = useCallback(() => setRollbackPrompt(false), []);

  // Both rollback attempts (initial and data-risk-confirmed) share the same
  // restart handoff: seed the reconnect poller's expected target and flip the
  // progress card to "restarting".
  const startRollbackHandoff = useCallback(
    (result) => {
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
    },
    [channelInfo],
  );

  const runRollback = useCallback(
    async ({ confirmDataRisk = false } = {}) => {
      if (rollingBack || operation) return;
      setRollbackPrompt(false);
      setRollbackDataRisk(null);
      setRollingBack(true);
      setActionError(null);
      try {
        const result = await rollbackOpenclaw(
          confirmDataRisk ? { confirmDataRisk: true } : {},
        );
        startRollbackHandoff(result);
      } catch (err) {
        if (err?.code === "rollback_requires_confirmation") {
          // Rollback fence (issue #20): this update migrated the state DBs.
          // Not a failure — open the second-stage data-risk confirm naming
          // the verified pre-update backup instead of the error chip.
          setRollbackDataRisk({
            message: err.message || null,
            backupFile: err.backupFile || null,
            // WI-4.1 re-stat caveats; absent on older servers (undefined →
            // the dialog treats the archive as present, no caveats).
            backupFileExists:
              typeof err.backupFileExists === "boolean" ? err.backupFileExists : undefined,
            // Why a PRESENT archive must not be restored (symlink /
            // content_changed / unverifiable ...); without it the dialog
            // would call every failed re-verification "pruned".
            backupFileCaveat:
              typeof err.backupFileCaveat === "string" && err.backupFileCaveat
                ? err.backupFileCaveat
                : undefined,
            backupPartial: err.backupPartial === true,
            backupReused: err.backupReused === true,
            reusedAgeMs: Number.isFinite(err.reusedAgeMs) ? err.reusedAgeMs : null,
            newestSurvivingBackup:
              err.newestSurvivingBackup && typeof err.newestSurvivingBackup === "object"
                ? err.newestSurvivingBackup
                : null,
          });
        } else {
          setActionError({
            headline: "Couldn't roll back OpenClaw.",
            error: err,
          });
        }
      } finally {
        setRollingBack(false);
      }
    },
    [operation, rollingBack, startRollbackHandoff],
  );

  const onRollback = useCallback(() => runRollback(), [runRollback]);

  const onConfirmRollbackDataRisk = useCallback(
    () => runRollback({ confirmDataRisk: true }),
    [runRollback],
  );

  const onCancelRollbackDataRisk = useCallback(
    () => setRollbackDataRisk(null),
    [],
  );

  const onClearBlocklist = useCallback(
    async (id) => {
      if (clearingBlocklistId) return;
      setClearingBlocklistId(id || "all");
      setActionError(null);
      try {
        const data = await clearOpenclawBlocklist(id || null);
        updateChannel((info) => ({ ...info, blocklist: data?.blocklist || [] }));
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
    [clearingBlocklistId, loadCatalog, updateChannel],
  );

  // Always available (v0.9.81, RC1a): a read-only refresh is never gated by a
  // running or failed operation. The toast says what the server did — the
  // 30 s force floor used to downgrade a click to a cached read silently.
  const onCheckNow = useCallback(async () => {
    const fresh = await loadCatalog({ refresh: true });
    if (!fresh) return;
    if (fresh.refreshed) {
      showToast("Checked just now", "success");
    } else if (fresh.refreshThrottledForMs > 0) {
      const waitS = Math.max(1, Math.ceil(fresh.refreshThrottledForMs / 1000));
      showToast(`Checked moments ago — try again in ${waitS} s`, "info");
    } else if (fresh.stale) {
      // The forced fetch reached out and the sources did not answer: the
      // rows shown are the cached ones — never "checked just now".
      showToast(
        `Could not reach the version registry — showing the catalog ${buildStalenessLabel(fresh.staleAsOf, Date.now()).replace(/^Catalog /, "")}`,
        "warning",
      );
    }
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
  const onDismissApplyError = useCallback(() => {
    setApplyError(null);
    setBackupReuseOffer(null);
    setBackupReuseRetryPrompt(false);
    clearNoBackupConsent();
  }, []);
  const onDismissActionError = useCallback(() => setActionError(null), []);

  // A failed (or wedged) apply used to leave `operation` set forever, which
  // disabled every control on the page with no way out short of a reload.
  // Dismissing clears the operation and reloads channel/runs so the incident
  // card and timeline reflect the failed run; every control re-enables and
  // the user can retry from the catalog. Failed-only guard: the card only
  // offers Dismiss on failed states, and a running op must never be cleared.
  const onDismissOperation = useCallback(() => {
    if (!operation || (operation.phase !== "failed" && operation.phase !== "completed")) return;
    stopStream();
    setOperation(null);
    setLogOpen(false);
    setBackupReuseOffer(null);
    setBackupReuseRetryPrompt(false);
    clearNoBackupConsent();
    loadChannel();
    loadRuns();
  }, [loadChannel, loadRuns, operation, stopStream]);

  const actionsDisabled =
    Boolean(operation) ||
    savingChannel ||
    markingGood ||
    rollingBack ||
    Boolean(retryingReconcile) ||
    reconcilingInstalled ||
    Boolean(clearingBlocklistId) ||
    refreshingCatalog;

  return {
    // data
    channelInfo,
    channelError,
    onRetryChannel: loadChannel,
    loadingChannel,
    catalog,
    whatsNew,
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
    onToggleBackupReuseConsent,
    // backup-reuse retry (409 backup_failed + reusableBackup)
    backupReuseOffer,
    backupReuseRetryPrompt,
    onRequestBackupReuseRetry,
    onCancelBackupReuseRetry,
    onConfirmBackupReuseRetry,
    // no-backup consent (409 backup_required_for_migration, #79 (b))
    noBackupConsentOffer,
    noBackupConsentPrompt,
    noBackupConsentChecked,
    noBackupConsentStarting,
    onRequestNoBackupConsent,
    onCancelNoBackupConsent,
    onToggleNoBackupConsent,
    onConfirmNoBackupConsent,
    // backup inventory (Backups card)
    backupsInventory: backups.inventory,
    backupsError: backups.error,
    backupsLoading: backups.loading,
    onRetryBackups: refreshBackups,
    // apply progress
    operation: operation ? { ...operation, monitorError: operationMonitor.error } : null,
    onRetryOperationStatus: operationMonitor.retry,
    onDismissOperation,
    applyError,
    onDismissApplyError,
    logOpen,
    onToggleLog,
    verdict,
    onDismissVerdict,
    // failed-operation recovery (D3)
    repairAvailable,
    onRunRepair,
    onRetryApply,
    // v0.9.81 (C3/C4): standalone backup + the right recovery CTAs
    onBackupNow,
    backupNowStarting,
    onRetryBackup,
    onRetryUpdate,
    lastManualBackup: buildLastManualBackupLine(runs, nowMs),
    // run ledger (timeline + post-restart continuity)
    runs,
    runsError,
    onRetryRuns: loadRuns,
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
    rollbackDataRisk,
    onConfirmRollbackDataRisk,
    onCancelRollbackDataRisk,
    // gateway-hold recovery (settings migration)
    retryingReconcile,
    onRetryReconcile,
    stripReconcilePrompt,
    onRequestStripReconcile,
    onCancelStripReconcile,
    onConfirmStripReconcile,
    reconcileError,
    onDismissReconcileError,
    // installed-tree reconcile (#76 B1.2)
    reconcilingInstalled,
    onReconcileInstalled,
    reconcileInstalledError,
    onDismissReconcileInstalledError,
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
