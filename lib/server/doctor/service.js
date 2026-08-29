const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  buildBootstrapTruncationCards,
  createBootstrapContextAnalyzer,
} = require("./bootstrap-context");
const { selectDoctorContextProfile } = require("./context-profiles");
const { buildDeterministicCards } = require("./deterministic-checks");
const { runOpenclawDoctorBridge } = require("./openclaw-doctor");
const { createDoctorTextSanitizer } = require("./sanitize");
const { buildDoctorPrompt } = require("./prompt");
const { hashDoctorFixToken } = require("./fix-completion");
const { normalizeDoctorResult } = require("./normalize");
const { calculateWorkspaceDelta } = require("./workspace-fingerprint");
const { createFingerprintClient } = require("./fingerprint-client");
const {
  kDoctorAutoRunFailureBackoffMs,
  kDoctorAutoRunMinIntervalMs,
  kDoctorAutoRunTickMs,
  kDoctorCardSource,
  kDoctorCardStatus,
  kDoctorEngine,
  kDoctorMeaningfulChangeScoreThreshold,
  kDoctorNotifyMaxFindings,
  kDoctorNotifyMaxLineChars,
  kDoctorPromptVersion,
  kDoctorRunStatus,
  kDoctorRunTimeoutMs,
  kDoctorStaleThresholdMs,
} = require("./constants");

const kMaxSnippetLines = 20;
const kDoctorFixDispatchTimeoutMs = 30000;

const buildDoctorFixCompletionInstructions = ({
  cardId,
  runId,
  token,
  alphaclawRootDir,
}) => {
  const completionCommand = [
    "alphaclaw",
    "--root-dir",
    shellEscapeArg(alphaclawRootDir),
    "doctor finding complete",
    "--id",
    shellEscapeArg(String(Number(cardId || 0))),
    "--run",
    shellEscapeArg(runId),
    "--token",
    shellEscapeArg(token),
  ].join(" ");
  return [
    "AlphaClaw completion callback:",
    "After you have successfully applied and verified the requested fix, run this command exactly:",
    "```sh",
    completionCommand,
    "```",
    "Do not call the completion callback if the fix was not applied or verification failed. Explain the problem to the user instead.",
  ].join("\n");
};

const shellEscapeArg = (value) => {
  const safeValue = String(value || "");
  return `'${safeValue.replace(/'/g, `'\\''`)}'`;
};

const hasValidIsoTime = (value) => {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp);
};

const formatElapsedSince = (isoTime) => {
  if (!hasValidIsoTime(isoTime)) return "the last scan";
  const elapsedMs = Math.max(0, Date.now() - Date.parse(isoTime));
  const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60000));
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;
  }
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
  }
  const elapsedDays = Math.round(elapsedHours / 24);
  return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
};

const readFileSnippet = (rootDir, relativePath, startLine, endLine) => {
  try {
    const fullPath = path.join(rootDir, String(relativePath || ""));
    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, (startLine || 1) - 1);
    const end = endLine && endLine >= startLine ? Math.min(lines.length, endLine) : start + 1;
    const cappedEnd = Math.min(end, start + kMaxSnippetLines);
    return {
      text: lines.slice(start, cappedEnd).join("\n"),
      startLine: start + 1,
      endLine: start + (cappedEnd - start),
      truncated: cappedEnd < end,
      totalFileLines: lines.length,
    };
  } catch {
    return null;
  }
};

const captureEvidenceSnippets = (cards, rootDir) => {
  for (const card of cards) {
    if (!Array.isArray(card.evidence)) continue;
    for (const item of card.evidence) {
      if (!item || item.type !== "path" || !item.path || !item.startLine) continue;
      const snippet = readFileSnippet(rootDir, item.path, item.startLine, item.endLine);
      if (snippet) item.snippet = snippet;
    }
  }
};

const buildDoctorSessionKey = (runId) => `agent:main:doctor:${Number(runId || 0)}`;
const buildDoctorIdempotencyKey = (runId) => `doctor-run-${Number(runId || 0)}`;

const createDoctorService = ({
  clawCmd,
  listDoctorRuns,
  listDoctorRunSummaries = null,
  getDoctorRunManifest = null,
  getLatestCompletedRunSummary = null,
  listDoctorCards,
  getInitialWorkspaceBaseline,
  setInitialWorkspaceBaseline,
  createDoctorRun,
  completeDoctorRun,
  insertDoctorCards,
  getDoctorRun,
  getDoctorCardsByRunId,
  getDoctorCard,
  updateDoctorCardStatus,
  startDoctorCardFix,
  cancelDoctorCardFix,
  workspaceRoot,
  managedRoot,
  alphaclawRootDir = process.env.ALPHACLAW_ROOT_DIR || "~/.alphaclaw",
  protectedPaths = [],
  lockedPaths = [],
  computeSnapshotAsync = null,
  snapshotTtlMs = 45000,
  // Version-aware context contract (fail-closed to the stable profile).
  featureGates = null,
  getInstalledVersion = () => "",
  getReleaseChannel = () => "",
  readOpenclawConfig = null,
  isOnboarded = () => true,
  // Liveness integration (all optional — absent deps degrade gracefully).
  runDoctorLintJson = null,
  getGatewayReadiness = null,
  notify = null,
  readAutoRunEnabled = null,
  getDoctorMeta = null,
  setDoctorMeta = null,
  listDismissedSourceKeys = null,
  autoRunTickMs = kDoctorAutoRunTickMs,
}) => {
  const getActiveProfile = () =>
    selectDoctorContextProfile({
      supportsFeature: featureGates?.supportsFeature,
    });
  const safeInstalledVersion = () => {
    try {
      return String(getInstalledVersion() || "");
    } catch {
      return "";
    }
  };
  const safeReleaseChannel = () => {
    try {
      return String(getReleaseChannel() || "");
    } catch {
      return "";
    }
  };
  const bootstrapAnalyzer = createBootstrapContextAnalyzer({
    workspaceRoot,
    managedRoot,
    getProfile: getActiveProfile,
    readOpenclawConfig,
    isOnboarded,
  });
  const sanitizer = createDoctorTextSanitizer();
  const safeIsOnboarded = () => {
    try {
      return isOnboarded() !== false;
    } catch {
      return true;
    }
  };
  const safeReadConfig = () => {
    if (!readOpenclawConfig || !managedRoot) return null;
    try {
      return readOpenclawConfig({ openclawDir: managedRoot, fallback: null });
    } catch {
      return null;
    }
  };
  const safeGatewayReadiness = () => {
    if (!getGatewayReadiness) return { ok: true, reason: "" };
    try {
      const readiness = getGatewayReadiness();
      return {
        ok: readiness?.ok !== false,
        reason: String(readiness?.reason || ""),
      };
    } catch {
      return { ok: true, reason: "" };
    }
  };
  const readMetaValue = (key) => {
    try {
      return getDoctorMeta?.(key)?.value ?? null;
    } catch {
      return null;
    }
  };
  const writeMetaValue = (key, value) => {
    try {
      setDoctorMeta?.({ key, value });
    } catch {
      // meta persistence is best-effort; the outbox id-dedupe is the backstop
    }
  };
  const state = {
    activeRunId: 0,
    activeRunPromise: null,
    runStarting: false,
    snapshotCache: null,
    snapshotRefreshPromise: null,
    lastStatusConsumerAt: 0,
    fingerprintClient: null,
    lastRefreshErrorLoggedAt: 0,
    baselineManifestCache: null,
    initialBaselineCache: null,
    deltaCache: null,
  };

  // Fallbacks keep injected test doubles that only provide listDoctorRuns /
  // getDoctorRun working; production wires the lean summary readers.
  const listRunSummaries =
    listDoctorRunSummaries || ((options) => listDoctorRuns(options));
  const readRunManifest =
    getDoctorRunManifest || ((id) => getDoctorRun(id)?.workspaceManifest ?? null);
  const readLatestCompletedRunSummary =
    getLatestCompletedRunSummary ||
    (() =>
      listRunSummaries({ limit: 25 }).find(
        (run) => run.status === kDoctorRunStatus.completed,
      ) || null);

  // Status consumers within this window keep background refreshes flowing;
  // an idle instance (nobody polling) does zero fingerprint work.
  const consumerWindowMs = snapshotTtlMs * 2;

  const getSnapshotComputer = () => {
    if (computeSnapshotAsync) return computeSnapshotAsync;
    if (!state.fingerprintClient) {
      state.fingerprintClient = createFingerprintClient();
    }
    return (rootDir, options) => state.fingerprintClient.computeSnapshot(rootDir, options);
  };

  const getLatestCompletedRun = () => readLatestCompletedRunSummary();

  // Hot path (buildStatus): cache-only — NEVER computes a snapshot
  // synchronously. Returns null until the first background refresh lands;
  // buildStatus degrades to a zero delta in that window.
  const getCachedWorkspaceSnapshot = () => state.snapshotCache?.snapshot || null;

  const storeSnapshot = (snapshot) => {
    state.snapshotCache = {
      computedAt: Date.now(),
      snapshot,
    };
    return snapshot;
  };

  const refreshWorkspaceSnapshot = ({ incremental = true } = {}) => {
    if (state.snapshotRefreshPromise) return state.snapshotRefreshPromise;
    const compute = getSnapshotComputer();
    const previousManifest =
      incremental && state.snapshotCache?.snapshot?.manifest
        ? state.snapshotCache.snapshot.manifest
        : null;
    state.snapshotRefreshPromise = Promise.resolve()
      .then(() => compute(workspaceRoot, { previousManifest }))
      .then((snapshot) => storeSnapshot(snapshot))
      .catch((error) => {
        // Keep serving the stale snapshot; log at most once a minute.
        const now = Date.now();
        if (now - state.lastRefreshErrorLoggedAt > 60000) {
          state.lastRefreshErrorLoggedAt = now;
          console.warn(
            `[doctor] workspace snapshot refresh failed: ${error?.message || error}`,
          );
        }
        return getCachedWorkspaceSnapshot();
      })
      .finally(() => {
        state.snapshotRefreshPromise = null;
      });
    return state.snapshotRefreshPromise;
  };

  const maybeKickBackgroundRefresh = () => {
    if (state.snapshotRefreshPromise) return;
    const now = Date.now();
    if (now - state.lastStatusConsumerAt > consumerWindowMs) return;
    const cacheAgeMs = state.snapshotCache ? now - state.snapshotCache.computedAt : Infinity;
    if (cacheAgeMs < snapshotTtlMs) return;
    void refreshWorkspaceSnapshot({ incremental: true });
  };

  // Doctor-run entry points await a FULL fresh snapshot (no incremental
  // reuse) so mtime-granularity misses can never poison a run fingerprint.
  // The compute registers itself as THE in-flight refresh: the fingerprint
  // client allows one request at a time (a timed-out request fails all
  // pending ones), so an SSE-tick background refresh must join this run's
  // scan rather than start a second concurrent worker request.
  const getFreshSnapshotForRun = async () => {
    while (state.snapshotRefreshPromise) {
      await state.snapshotRefreshPromise.catch(() => {});
    }
    const compute = getSnapshotComputer();
    const promise = Promise.resolve()
      .then(() => compute(workspaceRoot, { previousManifest: null }))
      .then((snapshot) => storeSnapshot(snapshot));
    // Joiners (the void'd background refresh) must never see this run's
    // rejection — register a stale-serving variant, cleared once settled.
    const registered = promise
      .catch(() => getCachedWorkspaceSnapshot())
      .finally(() => {
        if (state.snapshotRefreshPromise === registered) {
          state.snapshotRefreshPromise = null;
        }
      });
    state.snapshotRefreshPromise = registered;
    return promise;
  };

  const getOrCreateInitialBaseline = () => {
    const existingBaseline = getInitialWorkspaceBaseline?.();
    if (existingBaseline?.fingerprint && existingBaseline?.manifest) {
      return existingBaseline;
    }
    const snapshot = getCachedWorkspaceSnapshot();
    if (!snapshot) return null;
    const nextBaseline = {
      fingerprint: snapshot.fingerprint,
      manifest: snapshot.manifest,
      capturedAt: new Date().toISOString(),
    };
    return setInitialWorkspaceBaseline?.(nextBaseline) || nextBaseline;
  };

  // The initial baseline is immutable once captured, but reading it re-parses
  // a manifest that can be multi-MB of JSON — cache it after the first hit so
  // the pre-first-run steady state (every fresh install) pays once, not per
  // status consumer.
  const getOrCreateInitialBaselineCached = () => {
    if (!state.initialBaselineCache) {
      state.initialBaselineCache = getOrCreateInitialBaseline() || null;
    }
    return state.initialBaselineCache;
  };

  // A completed run's manifest is likewise multi-MB and immutable — parse it
  // once per baseline run id, not per buildStatus call.
  const getBaselineManifestCached = (runId) => {
    if (state.baselineManifestCache?.runId !== runId) {
      let manifest = null;
      try {
        manifest = readRunManifest(runId) ?? null;
      } catch {
        // Transient read failure: serve a null delta this round but do NOT
        // cache it — caching would disable delta reporting until a different
        // run becomes the baseline.
        return null;
      }
      state.baselineManifestCache = { runId, manifest };
    }
    const cached = state.baselineManifestCache.manifest;
    return cached && typeof cached === "object" ? cached : null;
  };

  // calculateWorkspaceDelta walks both full manifests (10-60ms at the 15k-50k
  // file scale) — recompute only when the snapshot or the baseline actually
  // changed, not on every status consumer.
  const computeDeltaCached = ({ baselineKey, baselineManifest, currentManifest }) => {
    // The profile shapes drift weights and can flip on a channel switch
    // without a restart — key the cache on it too.
    const profile = getActiveProfile();
    const key = `${profile.id}:${baselineKey}:${state.snapshotCache?.computedAt || 0}`;
    if (state.deltaCache?.key !== key) {
      state.deltaCache = {
        key,
        delta: calculateWorkspaceDelta({
          previousManifest: baselineManifest,
          currentManifest,
          profile,
        }),
      };
    }
    return state.deltaCache.delta;
  };

  // Reuse runs clone the LLM cards (their inputs — workspace bytes,
  // promptVersion, context profile, installed version — are all part of the
  // reuse key) AND the bridge cards (point-in-time upstream findings; a fresh
  // `openclaw doctor --lint --json` would cost up to 60s and reuse must stay
  // instant — staleness is bounded by the next full run). Local sourced cards
  // (bootstrap/deterministic) read cheap out-of-tree inputs and are
  // recomputed fresh on every run — including reuse runs.
  const cloneRunCards = ({ sourceRunId, targetRunId }) => {
    const sourceCards = getDoctorCardsByRunId(sourceRunId)
      .filter(
        (card) =>
          !card.source ||
          card.source === kDoctorCardSource.llm ||
          card.source === kDoctorCardSource.openclawDoctor,
      )
      .map((card) => ({
        ...card,
        status:
          card.status === kDoctorCardStatus.working
            ? kDoctorCardStatus.open
            : card.status,
      }));
    insertDoctorCards({
      runId: targetRunId,
      cards: sourceCards,
    });
  };

  const buildStatus = () => {
    state.lastStatusConsumerAt = Date.now();
    maybeKickBackgroundRefresh();
    const bootstrapContext = bootstrapAnalyzer.analyze();
    // Summaries only: run manifests/raw results are fetched lazily (and
    // cached) for the single baseline run — never parsed per listed run.
    const recentRuns = listRunSummaries({ limit: 10 });
    const latestRun = recentRuns[0] || null;
    const latestCompletedRun =
      recentRuns.find((run) => run.status === kDoctorRunStatus.completed) || null;
    const lastRunAt =
      latestCompletedRun?.completedAt || latestCompletedRun?.startedAt || null;
    const lastRunAgeMs = hasValidIsoTime(lastRunAt) ? Date.now() - Date.parse(lastRunAt) : null;
    const stale = lastRunAgeMs == null || lastRunAgeMs >= kDoctorStaleThresholdMs;
    const baselineRun = latestCompletedRun;
    const initialBaseline = !baselineRun ? getOrCreateInitialBaselineCached() : null;
    const currentSnapshot =
      baselineRun || initialBaseline ? getCachedWorkspaceSnapshot() : null;
    const baselineManifest = baselineRun
      ? getBaselineManifestCached(baselineRun.id)
      : initialBaseline?.manifest && typeof initialBaseline.manifest === "object"
        ? initialBaseline.manifest
        : null;
    const hasManifestBaseline = !!baselineManifest;
    const delta =
      hasManifestBaseline && currentSnapshot
        ? computeDeltaCached({
            baselineKey: baselineRun ? `run:${baselineRun.id}` : "initial",
            baselineManifest,
            currentManifest: currentSnapshot.manifest,
          })
        : {
            addedFilesCount: 0,
            removedFilesCount: 0,
            modifiedFilesCount: 0,
            changedFilesCount: 0,
            deltaScore: 0,
            changedPaths: [],
          };
    const hasMeaningfulChanges =
      !!latestCompletedRun &&
      delta.deltaScore >= kDoctorMeaningfulChangeScoreThreshold;
    return {
      activeRunId: state.activeRunId || 0,
      runInProgress: !!state.activeRunPromise,
      lastRunAt,
      lastRunAgeMs,
      needsInitialRun: !latestCompletedRun,
      stale,
      bootstrapContext,
      gatewayReadiness: safeGatewayReadiness(),
      autoRun: {
        enabled: readAutoRunEnabledSafe(),
        lastCheckAt: autoRunState.lastCheckAt,
        lastSkipReason: autoRunState.lastSkipReason,
      },
      releaseChannel: safeReleaseChannel(),
      changeSummary: {
        ...delta,
        hasBaseline: hasManifestBaseline,
        baselineSource: baselineRun ? "last_run" : initialBaseline ? "initial_install" : "none",
        hasMeaningfulChanges,
        snapshotAgeMs: state.snapshotCache ? Date.now() - state.snapshotCache.computedAt : null,
        workspaceLimited: !!currentSnapshot?.limited,
      },
      latestRun,
    };
  };

  const executeDoctorRun = async (runId) => {
    try {
      const allCards = listDoctorCards();
      const resolvedCards = allCards
        .filter((card) => card.status === "dismissed" || card.status === "fixed")
        .map((card) => ({
          status: card.status,
          title: card.title || "",
          category: card.category || "",
        }));
      const prompt = buildDoctorPrompt({
        workspaceRoot,
        managedRoot,
        protectedPaths,
        lockedPaths,
        resolvedCards,
        promptVersion: kDoctorPromptVersion,
        profile: getActiveProfile(),
        bootstrapContext: bootstrapAnalyzer.analyze(),
        installedVersion: safeInstalledVersion(),
        releaseChannel: safeReleaseChannel(),
      });
      const gatewayTimeoutMs = kDoctorRunTimeoutMs + 30000;
      const gatewayParams = {
        agentId: "main",
        idempotencyKey: buildDoctorIdempotencyKey(runId),
        message: prompt,
        sessionKey: buildDoctorSessionKey(runId),
        thinking: "medium",
        timeout: Math.round(kDoctorRunTimeoutMs / 1000),
      };
      // The upstream-doctor bridge runs in parallel with the (much slower)
      // LLM call. Bridge failure is fail-soft; LLM failure fails the run.
      const [llmSettled, bridgeSettled] = await Promise.allSettled([
        clawCmd(
          `gateway call agent --expect-final --json --timeout ${gatewayTimeoutMs} --params ${shellEscapeArg(
            JSON.stringify(gatewayParams),
          )}`,
          {
            quiet: true,
            timeoutMs: gatewayTimeoutMs,
          },
        ),
        runDoctorLintJson
          ? runOpenclawDoctorBridge({
              runLintJson: runDoctorLintJson,
              sanitize: sanitizer.sanitize,
            })
          : Promise.resolve({ ok: false, cards: [], droppedCount: 0 }),
      ]);
      if (llmSettled.status === "rejected") {
        throw llmSettled.reason instanceof Error
          ? llmSettled.reason
          : new Error(String(llmSettled.reason || "Doctor analysis failed"));
      }
      const result = llmSettled.value;
      if (!result?.ok) {
        throw new Error(result?.stderr || "Doctor analysis command failed");
      }
      const bridgeResult =
        bridgeSettled.status === "fulfilled"
          ? bridgeSettled.value
          : { ok: false, cards: [], droppedCount: 0 };
      if (bridgeResult.droppedCount > 0) {
        console.warn(
          `[doctor] openclaw doctor bridge dropped ${bridgeResult.droppedCount} lower-priority findings (card cap)`,
        );
      }
      const stdoutText = String(result.stdout || "");
      const stderrText = String(result.stderr || "");
      let normalizedResult = null;
      try {
        normalizedResult = normalizeDoctorResult(stdoutText);
      } catch (error) {
        console.error(
          `[doctor] run ${runId} normalize failed: ${error.message || "Unknown error"}`,
        );
        console.error(`[doctor] run ${runId} stdout begin`);
        console.error(stdoutText || "(empty)");
        console.error(`[doctor] run ${runId} stdout end`);
        console.error(`[doctor] run ${runId} stderr begin`);
        console.error(stderrText || "(empty)");
        console.error(`[doctor] run ${runId} stderr end`);
        throw error;
      }
      const runConfig = safeReadConfig();
      const sourcedCards = buildFreshSourcedCards({ config: runConfig });
      const bridgeCards = filterDismissedSourcedCards(bridgeResult.cards);
      const cards = [...sourcedCards, ...bridgeCards, ...normalizedResult.cards];
      captureEvidenceSnippets(cards, workspaceRoot);
      insertDoctorCards({
        runId,
        cards,
      });
      completeDoctorRun({
        id: runId,
        status: kDoctorRunStatus.completed,
        summary: normalizedResult.summary,
        rawResult: normalizedResult.rawPayload,
      });
      writeMetaValue("last_env_signature", buildEnvSignature({ config: runConfig }));
      maybeNotifyNewP0s(runId);
    } catch (error) {
      completeDoctorRun({
        id: runId,
        status: kDoctorRunStatus.failed,
        error: error.message || "Doctor run failed",
      });
    } finally {
      state.activeRunId = 0;
      state.activeRunPromise = null;
    }
  };

  // Sourced-card dismissal suppression: a dismissed source_key is never
  // re-emitted (mirrors the LLM prompt's "previously dismissed" suppression).
  // Reads a targeted DISTINCT query when wired (the cards table is never
  // pruned); falls back to the full listing for injected test doubles.
  const readDismissedSourceKeys = () => {
    try {
      if (listDismissedSourceKeys) return new Set(listDismissedSourceKeys());
      return new Set(
        listDoctorCards()
          .filter(
            (card) => card.status === kDoctorCardStatus.dismissed && card.sourceKey,
          )
          .map((card) => card.sourceKey),
      );
    } catch {
      return null;
    }
  };

  const filterDismissedSourcedCards = (cards = [], dismissedKeys = undefined) => {
    if (!cards.length) return cards;
    const keys = dismissedKeys === undefined ? readDismissedSourceKeys() : dismissedKeys;
    if (!keys) return cards;
    return cards.filter((card) => !card.sourceKey || !keys.has(card.sourceKey));
  };

  // Environment-dependent (sourced) cards, recomputed on EVERY run including
  // fingerprint-reuse runs — their inputs (config, budgets, hook state,
  // channel, skills tree caps) live outside the fingerprinted workspace tree.
  // Callers thread one config snapshot through a flow instead of re-reading.
  const buildFreshSourcedCards = ({ config = safeReadConfig() } = {}) => {
    const bootstrapContext = bootstrapAnalyzer.analyze();
    const bootstrapCards = buildBootstrapTruncationCards(bootstrapContext);
    const deterministicCards = buildDeterministicCards({
      workspaceRoot,
      managedRoot,
      profile: getActiveProfile(),
      bootstrapContext,
      onboarded: safeIsOnboarded(),
      releaseChannel: safeReleaseChannel(),
      skillsLimits: config?.skills?.limits || {},
      sanitize: sanitizer.sanitize,
    });
    return filterDismissedSourcedCards([...bootstrapCards, ...deterministicCards]);
  };

  // Cheap per-tick hash of the sourced-card inputs: a change here is a
  // "P0-worthy condition with no workspace delta" trigger for scheduled scans.
  const buildEnvSignature = ({ config = safeReadConfig() } = {}) => {
    let gitSyncEnabled = null;
    try {
      const syncState = JSON.parse(
        fs.readFileSync(path.join(managedRoot, "cron", "system-sync.json"), "utf8"),
      );
      gitSyncEnabled = syncState?.enabled !== false;
    } catch {
      gitSyncEnabled = null;
    }
    const payload = JSON.stringify({
      gitSyncEnabled,
      extras: config?.hooks?.internal?.entries?.["bootstrap-extra-files"] ?? null,
      hooksEnabled: config?.hooks?.internal?.enabled === true,
      budgets: {
        perFile: config?.agents?.defaults?.bootstrapMaxChars ?? null,
        total: config?.agents?.defaults?.bootstrapTotalMaxChars ?? null,
      },
      skillsLimits: config?.skills?.limits ?? null,
      profileId: getActiveProfile().id,
      installedVersion: safeInstalledVersion(),
    });
    return crypto.createHash("sha256").update(payload).digest("hex");
  };

  // Notify on NEW P0s versus the previous completed non-import run. Bridge
  // cards are excluded (upstream findings surface in upstream tooling); a
  // P1→P0 escalation counts as new because the key is absent from the
  // baseline's P0 set. The deterministic outbox id absorbs crash replays.
  const maybeNotifyNewP0s = (runId) => {
    if (!notify) return;
    try {
      const lastNotifiedRunId = Number(readMetaValue("last_notified_run_id") || 0);
      if (runId <= lastNotifiedRunId) return;
      const baselineRun = listRunSummaries({ limit: 25 }).find(
        (run) =>
          run.id !== runId &&
          run.id < runId &&
          run.status === kDoctorRunStatus.completed &&
          run.engine !== kDoctorEngine.manualImport,
      );
      const cardKey = (card) => card.sourceKey || card.title || "";
      const baselineP0Keys = new Set(
        baselineRun
          ? getDoctorCardsByRunId(baselineRun.id)
              .filter((card) => card.priority === "P0")
              .map(cardKey)
          : [],
      );
      const newP0s = getDoctorCardsByRunId(runId).filter(
        (card) =>
          card.priority === "P0" &&
          card.source !== kDoctorCardSource.openclawDoctor &&
          !baselineP0Keys.has(cardKey(card)),
      );
      if (!newP0s.length) return;
      const lines = newP0s
        .slice(0, kDoctorNotifyMaxFindings)
        .map(
          (card) =>
            `- ${sanitizer.escapeMarkdown(
              sanitizer.sanitize(card.title, { maxChars: kDoctorNotifyMaxLineChars }),
            )}`,
        );
      const overflow = newP0s.length - kDoctorNotifyMaxFindings;
      const message = [
        "🐺 *AlphaClaw Watchdog*",
        `🩺 Drift Doctor found ${newP0s.length} new P0 finding${newP0s.length === 1 ? "" : "s"}`,
        ...lines,
        ...(overflow > 0 ? [`…and ${overflow} more`] : []),
        "Open the Doctor tab to review.",
      ].join("\n");
      const result = notify(message, { id: `doctor-run-${runId}-p0` });
      writeMetaValue("last_notified_run_id", runId);
      // Notification failure never fails the run.
      if (result && typeof result.catch === "function") {
        result.catch(() => {});
      }
    } catch (error) {
      console.warn(`[doctor] P0 notification skipped: ${error?.message || error}`);
    }
  };

  const runDoctor = async () => {
    // Busy-guard covers the async snapshot fetch too (runStarting): two
    // concurrent runDoctor calls must not both pass the check during the
    // await and double-create runs.
    if (state.activeRunPromise || state.runStarting) {
      return {
        ok: false,
        alreadyRunning: true,
        runId: state.activeRunId || 0,
        status: buildStatus(),
        error: "Doctor run already in progress",
      };
    }
    state.runStarting = true;
    // Single release point: any throw after the busy-guard (snapshot, DB
    // read/write, run creation) must not leave the guard latched forever.
    try {
      const workspaceSnapshot = await getFreshSnapshotForRun();
      const workspaceFingerprint = workspaceSnapshot.fingerprint;
      const activeProfile = getActiveProfile();
      const installedVersion = safeInstalledVersion();
      const latestCompletedRun = getLatestCompletedRun();
      // Reuse requires every LLM-card input to match: workspace bytes
      // (fingerprint), prompt contract (promptVersion), context profile, and
      // installed version (the prompt embeds the version/channel line — and
      // an upgrade should trigger a fresh scan anyway). Legacy runs without
      // the profile/version columns never match — the first post-upgrade run
      // is a full scan by design.
      if (
        latestCompletedRun &&
        latestCompletedRun.workspaceFingerprint &&
        latestCompletedRun.workspaceFingerprint === workspaceFingerprint &&
        latestCompletedRun.promptVersion === kDoctorPromptVersion &&
        (latestCompletedRun.contextProfile || "") === activeProfile.id &&
        (latestCompletedRun.openclawVersion || "") === installedVersion
      ) {
        const runId = createDoctorRun({
          status: kDoctorRunStatus.completed,
          engine: kDoctorEngine.deterministicReuse,
          workspaceRoot,
          workspaceFingerprint,
          workspaceManifest: workspaceSnapshot.manifest,
          promptVersion: kDoctorPromptVersion,
          contextProfile: activeProfile.id,
          openclawVersion: installedVersion,
          reusedFromRunId: latestCompletedRun.id,
        });
        cloneRunCards({
          sourceRunId: latestCompletedRun.id,
          targetRunId: runId,
        });
        // Environment-dependent checks are recomputed even when the
        // workspace bytes are unchanged (config/budget/hook state lives
        // outside the fingerprinted tree).
        const reuseConfig = safeReadConfig();
        const sourcedCards = buildFreshSourcedCards({ config: reuseConfig });
        if (sourcedCards.length) {
          captureEvidenceSnippets(sourcedCards, workspaceRoot);
          insertDoctorCards({ runId, cards: sourcedCards });
        }
        const summary = `No workspace changes since last scan (${formatElapsedSince(
          latestCompletedRun.completedAt || latestCompletedRun.startedAt,
        )}). LLM findings carried over; environment checks re-evaluated.`;
        completeDoctorRun({
          id: runId,
          status: kDoctorRunStatus.completed,
          summary,
          // latestCompletedRun is a lean summary (no rawResult) — fetch the
          // full source run only on this reuse path, where it's actually needed.
          rawResult: getDoctorRun(latestCompletedRun.id)?.rawResult ?? null,
        });
        writeMetaValue("last_env_signature", buildEnvSignature({ config: reuseConfig }));
        maybeNotifyNewP0s(runId);
        return {
          ok: true,
          runId,
          reusedPreviousRun: true,
          sourceRunId: latestCompletedRun.id,
          status: buildStatus(),
        };
      }
      // Fail fast instead of a 10-minute gateway timeout. The fingerprint
      // reuse above stays available offline (no dispatch); only the LLM
      // branch needs a healthy gateway.
      const readiness = safeGatewayReadiness();
      if (!readiness.ok) {
        return {
          ok: false,
          gatewayUnavailable: true,
          reason: readiness.reason,
          status: buildStatus(),
          error: `Gateway is not ready for a Doctor run: ${readiness.reason}`,
        };
      }
      const runId = createDoctorRun({
        status: kDoctorRunStatus.running,
        engine: kDoctorEngine.gatewayAgent,
        workspaceRoot,
        workspaceFingerprint,
        workspaceManifest: workspaceSnapshot.manifest,
        promptVersion: kDoctorPromptVersion,
        contextProfile: activeProfile.id,
        openclawVersion: installedVersion,
      });
      state.activeRunId = runId;
      state.activeRunPromise = executeDoctorRun(runId);
      return {
        ok: true,
        runId,
        status: buildStatus(),
      };
    } finally {
      state.runStarting = false;
    }
  };

  // Scheduled scans (opt-in, default off): a background tick that spends the
  // user's LLM tokens only when something changed AND the throttle allows it.
  const autoRunState = {
    timer: null,
    lastCheckAt: null,
    lastSkipReason: "",
  };
  const readAutoRunEnabledSafe = () => {
    try {
      return readAutoRunEnabled?.() === true;
    } catch {
      return false;
    }
  };

  const autoRunTick = async () => {
    autoRunState.lastCheckAt = new Date().toISOString();
    try {
      if (!readAutoRunEnabledSafe()) {
        autoRunState.lastSkipReason = "disabled";
        return;
      }
      if (state.activeRunPromise || state.runStarting) {
        autoRunState.lastSkipReason = "busy";
        return;
      }
      const readiness = safeGatewayReadiness();
      if (!readiness.ok) {
        autoRunState.lastSkipReason = "gateway-degraded";
        return;
      }
      const tickConfig = safeReadConfig();
      const envSignature = buildEnvSignature({ config: tickConfig });
      const lastAutoRun = readMetaValue("last_auto_run");
      const lastAutoRunAt = Date.parse(String(lastAutoRun?.at || "")) || 0;
      // Hard cost throttle: at most one auto-triggered LLM run per window,
      // regardless of how often the trigger conditions flap.
      if (lastAutoRunAt && Date.now() - lastAutoRunAt < kDoctorAutoRunMinIntervalMs) {
        autoRunState.lastSkipReason = "throttled";
        return;
      }
      // Failure backoff: a failed auto-run does not retry every tick — only
      // after the inputs change or the backoff window passes.
      if (
        lastAutoRun?.outcome === "failed" &&
        lastAutoRun?.envSignature === envSignature &&
        Date.now() - lastAutoRunAt < kDoctorAutoRunFailureBackoffMs
      ) {
        autoRunState.lastSkipReason = "backoff";
        return;
      }
      const status = buildStatus();
      const staleAndMeaningful =
        status.stale && status.changeSummary?.hasMeaningfulChanges === true;
      const lastEnvSignature = readMetaValue("last_env_signature");
      const envChanged = Boolean(lastEnvSignature) && lastEnvSignature !== envSignature;
      // A P0-worthy context condition with zero workspace delta triggers a
      // scan only when the latest run has not already reported it — and not
      // when the user DISMISSED it (dismissal suppresses re-emission, which
      // must not read as "new" forever and re-run every throttle window).
      const hardeningBad =
        ["blocked", "starved"].includes(status.bootstrapContext?.hardening?.state) ||
        status.bootstrapContext?.hasActiveTruncation === true;
      let hardeningNew = false;
      if (hardeningBad) {
        const latestRun = getLatestCompletedRun();
        const latestCards = latestRun ? getDoctorCardsByRunId(latestRun.id) : [];
        const dismissedKeys = readDismissedSourceKeys() || new Set();
        const isHardeningKey = (key) =>
          String(key || "").startsWith("det:hardening") ||
          String(key || "").startsWith("boot:");
        const alreadyReported = latestCards.some((card) => isHardeningKey(card.sourceKey));
        const alreadyDismissed = [...dismissedKeys].some(isHardeningKey);
        hardeningNew = !alreadyReported && !alreadyDismissed;
      }
      if (!(staleAndMeaningful || envChanged || hardeningNew)) {
        autoRunState.lastSkipReason = status.stale ? "no-meaningful-change" : "not-stale";
        return;
      }
      // Crash-safety marker: if the process dies mid-run, the throttle still
      // holds. Benign non-dispatches below restore the previous marker so
      // they never arm the throttle or the failure backoff.
      const previousAutoRun = lastAutoRun ?? null;
      writeMetaValue("last_auto_run", {
        at: new Date().toISOString(),
        outcome: "started",
        envSignature,
      });
      const result = await runDoctor();
      if (result?.alreadyRunning || result?.gatewayUnavailable) {
        // A manual run raced in, or the gateway flipped between our
        // pre-check and dispatch: nothing auto-ran — don't burn the throttle
        // slot, don't arm the backoff, and don't adopt the manual run's fate.
        writeMetaValue("last_auto_run", previousAutoRun);
        autoRunState.lastSkipReason = result.alreadyRunning ? "busy" : "gateway-degraded";
        return;
      }
      // Wait for the background LLM run to settle so the recorded outcome
      // reflects the run, not just the dispatch.
      if (state.activeRunPromise) {
        await state.activeRunPromise.catch(() => {});
      }
      const run = result?.runId ? getDoctorRun(result.runId) : null;
      const outcome =
        result?.ok && run?.status === kDoctorRunStatus.completed ? "ran" : "failed";
      writeMetaValue("last_auto_run", {
        at: new Date().toISOString(),
        outcome,
        envSignature,
      });
      autoRunState.lastSkipReason = outcome === "ran" ? "ran" : "failed";
      if (notify && result?.runId && outcome === "ran") {
        // Open findings only — reuse runs clone dismissed/fixed cards whose
        // statuses must not inflate the reported count.
        const findingsCount = getDoctorCardsByRunId(result.runId).filter(
          (card) =>
            card.status === kDoctorCardStatus.open ||
            card.status === kDoctorCardStatus.working,
        ).length;
        const completion = notify(
          [
            "🐺 *AlphaClaw Watchdog*",
            `🩺 Scheduled Drift Doctor scan finished: ${findingsCount} finding${findingsCount === 1 ? "" : "s"}`,
            "Open the Doctor tab to review.",
          ].join("\n"),
          { id: `doctor-auto-run-${result.runId}` },
        );
        if (completion && typeof completion.catch === "function") completion.catch(() => {});
      }
    } catch (error) {
      // A tick throw must never kill the interval.
      autoRunState.lastSkipReason = "error";
      console.warn(`[doctor] auto-run tick failed: ${error?.message || error}`);
    }
  };

  if (readAutoRunEnabled) {
    // Jittered cadence; unref'd so a background timer can never hold the
    // process open past the shutdown drain (dispose also clears it).
    const tickMs = autoRunTickMs + Math.floor(Math.random() * 60000);
    autoRunState.timer = setInterval(() => {
      void autoRunTick();
    }, tickMs);
    autoRunState.timer.unref?.();
  }

  const importDoctorResult = async ({
    rawOutput,
    engine = kDoctorEngine.manualImport,
  } = {}) => {
    const normalizedRawOutput = String(rawOutput || "");
    if (!normalizedRawOutput.trim()) {
      throw new Error("Doctor import requires raw output");
    }
    const normalizedResult = normalizeDoctorResult(normalizedRawOutput);
    const bootstrapTruncationCards = buildFreshSourcedCards();
    const cards = [...bootstrapTruncationCards, ...normalizedResult.cards];
    captureEvidenceSnippets(cards, workspaceRoot);
    const workspaceSnapshot = await getFreshSnapshotForRun();
    const runId = createDoctorRun({
      status: kDoctorRunStatus.completed,
      engine,
      workspaceRoot,
      workspaceFingerprint: workspaceSnapshot.fingerprint,
      workspaceManifest: workspaceSnapshot.manifest,
      promptVersion: kDoctorPromptVersion,
      contextProfile: getActiveProfile().id,
      openclawVersion: safeInstalledVersion(),
    });
    insertDoctorCards({
      runId,
      cards,
    });
    completeDoctorRun({
      id: runId,
      status: kDoctorRunStatus.completed,
      summary: normalizedResult.summary,
      rawResult: normalizedResult.rawPayload,
    });
    return {
      ok: true,
      runId,
      run: getDoctorRun(runId),
    };
  };

  const requestCardFix = async ({
    cardId,
    sessionKey = "",
    replyChannel = "",
    replyTo = "",
    prompt = "",
  } = {}) => {
    const card = getDoctorCard(cardId);
    if (!card) throw new Error("Doctor card not found");
    const resolvedPrompt = String(prompt || card.fixPrompt || "").trim();
    if (!resolvedPrompt) throw new Error("Doctor card does not include a fix prompt");
    const trimmedSessionKey = String(sessionKey || "").trim();
    if (!trimmedSessionKey) throw new Error("Doctor fix request requires a session key");
    // Fix dispatch is fire-and-forget into the same gateway — fail fast with
    // the reason instead of flipping the card to working and timing out.
    const readiness = safeGatewayReadiness();
    if (!readiness.ok) {
      const error = new Error(`Gateway is not ready for a Doctor fix: ${readiness.reason}`);
      error.gatewayUnavailable = true;
      throw error;
    }
    const trimmedReplyChannel = String(replyChannel || "").trim();
    const trimmedReplyTo = String(replyTo || "").trim();
    const runId = `doctor-fix-${Number(card.id || cardId)}-${crypto.randomUUID()}`;
    const callbackToken = crypto.randomBytes(32).toString("hex");
    const workingCard = startDoctorCardFix({
      id: card.id,
      runId,
      tokenHash: hashDoctorFixToken(callbackToken),
    });
    if (!workingCard) {
      const currentCard = getDoctorCard(card.id);
      if (currentCard?.status === kDoctorCardStatus.working) {
        throw new Error("Doctor fix already in progress");
      }
      throw new Error("Doctor finding must be open before requesting a fix");
    }
    const completionInstructions = buildDoctorFixCompletionInstructions({
      cardId: card.id,
      runId,
      token: callbackToken,
      alphaclawRootDir,
    });
    const gatewayParams = {
      idempotencyKey: runId,
      message: `${resolvedPrompt}\n\n${completionInstructions}`,
      sessionKey: trimmedSessionKey,
    };
    if (trimmedReplyChannel && trimmedReplyTo) {
      gatewayParams.deliver = true;
      gatewayParams.replyChannel = trimmedReplyChannel;
      gatewayParams.replyTo = trimmedReplyTo;
    }
    let result = null;
    try {
      result = await clawCmd(
        `gateway call agent --json --timeout ${kDoctorFixDispatchTimeoutMs} --params ${shellEscapeArg(
          JSON.stringify(gatewayParams),
        )}`,
        {
          quiet: true,
          timeoutMs: kDoctorFixDispatchTimeoutMs,
        },
      );
    } catch (error) {
      cancelDoctorCardFix({ id: card.id, runId });
      throw error;
    }
    if (!result?.ok) {
      cancelDoctorCardFix({ id: card.id, runId });
      throw new Error(result?.stderr || "Could not send Doctor fix request");
    }
    return {
      ok: true,
      queued: true,
      runId,
      stdout: result.stdout || "",
      card: workingCard,
    };
  };

  const setCardStatus = ({ cardId, status }) => {
    const updatedCard = updateDoctorCardStatus({
      id: cardId,
      status,
    });
    if (!updatedCard) throw new Error("Doctor card not found");
    return updatedCard;
  };

  const dispose = () => {
    if (autoRunState.timer) {
      clearInterval(autoRunState.timer);
      autoRunState.timer = null;
    }
    if (state.fingerprintClient) {
      state.fingerprintClient.dispose();
      state.fingerprintClient = null;
    }
  };

  return {
    buildStatus,
    runDoctor,
    importDoctorResult,
    refreshWorkspaceSnapshot,
    listDoctorRuns,
    listDoctorCards,
    getDoctorRun,
    getDoctorCardsByRunId,
    requestCardFix,
    setCardStatus,
    getDoctorCard,
    dispose,
  };
};

module.exports = {
  buildDoctorFixCompletionInstructions,
  buildDoctorIdempotencyKey,
  buildDoctorSessionKey,
  createDoctorService,
};
