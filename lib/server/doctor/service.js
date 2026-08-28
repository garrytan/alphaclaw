const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  analyzeBootstrapContext,
  buildBootstrapTruncationCards,
} = require("./bootstrap-context");
const { buildDoctorPrompt } = require("./prompt");
const { hashDoctorFixToken } = require("./fix-completion");
const { normalizeDoctorResult } = require("./normalize");
const { calculateWorkspaceDelta } = require("./workspace-fingerprint");
const { createFingerprintClient } = require("./fingerprint-client");
const {
  kDoctorCardStatus,
  kDoctorEngine,
  kDoctorMeaningfulChangeScoreThreshold,
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
const buildDoctorSessionId = (runId) => buildDoctorSessionKey(runId);
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
}) => {
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
    const key = `${baselineKey}:${state.snapshotCache?.computedAt || 0}`;
    if (state.deltaCache?.key !== key) {
      state.deltaCache = {
        key,
        delta: calculateWorkspaceDelta({
          previousManifest: baselineManifest,
          currentManifest,
        }),
      };
    }
    return state.deltaCache.delta;
  };

  const cloneRunCards = ({ sourceRunId, targetRunId }) => {
    const sourceCards = getDoctorCardsByRunId(sourceRunId).map((card) => ({
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
    const bootstrapContext = analyzeBootstrapContext({ workspaceRoot });
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
      const result = await clawCmd(
        `gateway call agent --expect-final --json --timeout ${gatewayTimeoutMs} --params ${shellEscapeArg(
          JSON.stringify(gatewayParams),
        )}`,
        {
          quiet: true,
          timeoutMs: gatewayTimeoutMs,
        },
      );
      if (!result?.ok) {
        throw new Error(result?.stderr || "Doctor analysis command failed");
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
      const bootstrapTruncationCards = buildBootstrapTruncationCards(
        analyzeBootstrapContext({ workspaceRoot }),
      );
      const cards = [...bootstrapTruncationCards, ...normalizedResult.cards];
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
    let workspaceSnapshot;
    try {
      workspaceSnapshot = await getFreshSnapshotForRun();
    } catch (error) {
      state.runStarting = false;
      throw error;
    }
    try {
    const workspaceFingerprint = workspaceSnapshot.fingerprint;
    const latestCompletedRun = getLatestCompletedRun();
    if (
      latestCompletedRun &&
      latestCompletedRun.workspaceFingerprint &&
      latestCompletedRun.workspaceFingerprint === workspaceFingerprint
    ) {
      const runId = createDoctorRun({
        status: kDoctorRunStatus.completed,
        engine: kDoctorEngine.deterministicReuse,
        workspaceRoot,
        workspaceFingerprint,
        workspaceManifest: workspaceSnapshot.manifest,
        promptVersion: kDoctorPromptVersion,
        reusedFromRunId: latestCompletedRun.id,
      });
      cloneRunCards({
        sourceRunId: latestCompletedRun.id,
        targetRunId: runId,
      });
      const summary = `No workspace changes since last scan (${formatElapsedSince(
        latestCompletedRun.completedAt || latestCompletedRun.startedAt,
      )}). Same findings apply.`;
      completeDoctorRun({
        id: runId,
        status: kDoctorRunStatus.completed,
        summary,
        // latestCompletedRun is a lean summary (no rawResult) — fetch the
        // full source run only on this reuse path, where it's actually needed.
        rawResult: getDoctorRun(latestCompletedRun.id)?.rawResult ?? null,
      });
      state.runStarting = false;
      return {
        ok: true,
        runId,
        reusedPreviousRun: true,
        sourceRunId: latestCompletedRun.id,
        status: buildStatus(),
      };
    }
    const runId = createDoctorRun({
      status: kDoctorRunStatus.running,
      engine: kDoctorEngine.gatewayAgent,
      workspaceRoot,
      workspaceFingerprint,
      workspaceManifest: workspaceSnapshot.manifest,
      promptVersion: kDoctorPromptVersion,
    });
    state.activeRunId = runId;
    state.activeRunPromise = executeDoctorRun(runId);
    state.runStarting = false;
    return {
      ok: true,
      runId,
      status: buildStatus(),
    };
    } catch (error) {
      // Any throw after the snapshot (DB read/write, run creation) must not
      // leave the busy-guard latched forever.
      state.runStarting = false;
      throw error;
    }
  };

  const importDoctorResult = async ({
    rawOutput,
    engine = kDoctorEngine.manualImport,
  } = {}) => {
    const normalizedRawOutput = String(rawOutput || "");
    if (!normalizedRawOutput.trim()) {
      throw new Error("Doctor import requires raw output");
    }
    const normalizedResult = normalizeDoctorResult(normalizedRawOutput);
    const bootstrapTruncationCards = buildBootstrapTruncationCards(
      analyzeBootstrapContext({ workspaceRoot }),
    );
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
  buildDoctorSessionId,
  createDoctorService,
};
