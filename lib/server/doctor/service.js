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
const {
  calculateWorkspaceDelta,
  computeWorkspaceSnapshot,
  computeWorkspaceSnapshotAsync,
} = require("./workspace-fingerprint");
const doctorDb = require("../db/doctor");
const {
  kDoctorCardStatus,
  kDoctorEngine,
  kDoctorMeaningfulChangeScoreThreshold,
  kDoctorPromptVersion,
  kDoctorRunStatus,
  kDoctorRunTimeoutMs,
  kDoctorStaleThresholdMs,
} = require("./constants");
const {
  kDoctorBootstrapContextTtlMs,
  kDoctorStatusMemoTtlMs,
  kDoctorWorkspaceSnapshotTtlMs,
} = require("../constants");

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
  // Defaulted from the db module (not server.js wiring) so the status hot
  // path gets the slim queries without touching every construction site.
  listDoctorRunSummaries = doctorDb.listDoctorRunSummaries,
  getDoctorRunWorkspaceManifest = doctorDb.getDoctorRunWorkspaceManifest,
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
  computeSnapshot = computeWorkspaceSnapshot,
  computeSnapshotAsync = computeWorkspaceSnapshotAsync,
  workspaceRoot,
  managedRoot,
  alphaclawRootDir = process.env.ALPHACLAW_ROOT_DIR || "~/.alphaclaw",
  protectedPaths = [],
  lockedPaths = [],
}) => {
  const state = {
    activeRunId: 0,
    activeRunPromise: null,
    snapshotCache: null,
    snapshotRefreshPromise: null,
    snapshotRefreshFailureLogged: false,
    bootstrapContextCache: null,
    changeSummaryCache: null,
    statusCache: null,
  };

  const getLatestCompletedRun = () =>
    listDoctorRuns({ limit: 25 }).find((run) => run.status === kDoctorRunStatus.completed) || null;

  const refreshSnapshotInBackground = () => {
    if (state.snapshotRefreshPromise) return state.snapshotRefreshPromise;
    const previousManifest = state.snapshotCache?.snapshot?.manifest || null;
    state.snapshotRefreshPromise = computeSnapshotAsync(workspaceRoot, { previousManifest })
      .then((snapshot) => {
        state.snapshotCache = {
          computedAt: Date.now(),
          snapshot,
        };
        state.snapshotRefreshFailureLogged = false;
        return snapshot;
      })
      .catch((error) => {
        // Worker crash fallback: keep serving the stale snapshot and log once
        // per failure streak so a broken worker cannot spam the log every tick.
        if (!state.snapshotRefreshFailureLogged) {
          state.snapshotRefreshFailureLogged = true;
          console.error(
            `[doctor] workspace snapshot refresh failed: ${error?.message || "Unknown error"}`,
          );
        }
        return state.snapshotCache?.snapshot || null;
      })
      .finally(() => {
        state.snapshotRefreshPromise = null;
      });
    return state.snapshotRefreshPromise;
  };

  const getCurrentWorkspaceSnapshot = () => {
    if (!state.snapshotCache) {
      // Cold boot only: callers are synchronous and need a first snapshot.
      // Every later refresh happens in the background worker.
      const snapshot = computeSnapshot(workspaceRoot);
      state.snapshotCache = {
        computedAt: Date.now(),
        snapshot,
      };
      return snapshot;
    }
    if (Date.now() - state.snapshotCache.computedAt >= kDoctorWorkspaceSnapshotTtlMs) {
      refreshSnapshotInBackground();
    }
    return state.snapshotCache.snapshot;
  };

  // A settled run becomes the new drift baseline, so stale memos must not
  // hide it from the next status tick.
  const handleDoctorRunSettled = () => {
    if (state.snapshotCache) state.snapshotCache.computedAt = 0;
    state.changeSummaryCache = null;
    state.statusCache = null;
  };

  const getOrCreateInitialBaseline = () => {
    const existingBaseline = getInitialWorkspaceBaseline?.();
    if (existingBaseline?.fingerprint && existingBaseline?.manifest) {
      return existingBaseline;
    }
    const snapshot = getCurrentWorkspaceSnapshot();
    const nextBaseline = {
      fingerprint: snapshot.fingerprint,
      manifest: snapshot.manifest,
      capturedAt: new Date().toISOString(),
    };
    return setInitialWorkspaceBaseline?.(nextBaseline) || nextBaseline;
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

  const getBootstrapContext = () => {
    const now = Date.now();
    if (
      state.bootstrapContextCache &&
      now - state.bootstrapContextCache.computedAt < kDoctorBootstrapContextTtlMs
    ) {
      return state.bootstrapContextCache.context;
    }
    const context = analyzeBootstrapContext({ workspaceRoot });
    state.bootstrapContextCache = {
      computedAt: now,
      context,
    };
    return context;
  };

  const buildEmptyDelta = () => ({
    addedFilesCount: 0,
    removedFilesCount: 0,
    modifiedFilesCount: 0,
    changedFilesCount: 0,
    deltaScore: 0,
    changedPaths: [],
  });

  const loadBaselineManifest = ({ baselineRun, initialBaseline }) => {
    if (baselineRun) {
      // The status path lists slim run summaries; the baseline manifest is
      // fetched (and JSON.parsed) only here, on fingerprint change.
      try {
        const manifest = getDoctorRunWorkspaceManifest(baselineRun.id);
        return manifest && typeof manifest === "object" ? manifest : null;
      } catch {
        return null;
      }
    }
    return initialBaseline?.manifest && typeof initialBaseline.manifest === "object"
      ? initialBaseline.manifest
      : null;
  };

  const buildChangeSummary = ({ baselineRun, initialBaseline, currentSnapshot }) => {
    const baselineKey = baselineRun ? `run:${baselineRun.id}` : initialBaseline ? "initial" : "none";
    const baselineFingerprint = baselineRun
      ? String(baselineRun.workspaceFingerprint || "")
      : String(initialBaseline?.fingerprint || "");
    const currentFingerprint = String(currentSnapshot?.fingerprint || "");
    const cached = state.changeSummaryCache;
    if (
      cached &&
      cached.baselineKey === baselineKey &&
      cached.baselineFingerprint === baselineFingerprint &&
      cached.currentFingerprint === currentFingerprint
    ) {
      return cached.changeSummary;
    }
    let delta = buildEmptyDelta();
    let hasBaseline = false;
    if (currentSnapshot && baselineFingerprint && baselineFingerprint === currentFingerprint) {
      // Fingerprints derive from manifest hashes, so equality proves zero
      // drift without parsing either manifest.
      hasBaseline = true;
    } else if (currentSnapshot) {
      const baselineManifest = loadBaselineManifest({ baselineRun, initialBaseline });
      if (baselineManifest) {
        hasBaseline = true;
        delta = calculateWorkspaceDelta({
          previousManifest: baselineManifest,
          currentManifest: currentSnapshot.manifest,
        });
      }
    }
    const changeSummary = {
      ...delta,
      hasBaseline,
      baselineSource: baselineRun ? "last_run" : initialBaseline ? "initial_install" : "none",
      hasMeaningfulChanges:
        !!baselineRun && delta.deltaScore >= kDoctorMeaningfulChangeScoreThreshold,
    };
    state.changeSummaryCache = {
      baselineKey,
      baselineFingerprint,
      currentFingerprint,
      changeSummary,
    };
    return changeSummary;
  };

  // Slim by contract: status consumers never receive workspaceManifest or
  // rawResult; /api/doctor/runs keeps serving the full run models.
  const toSlimLatestRun = (run) =>
    run
      ? {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt || null,
          completedAt: run.completedAt || null,
          summary: run.summary || "",
          counts: {
            cardCount: Number(run.cardCount || 0),
            priorityCounts: run.priorityCounts || { P0: 0, P1: 0, P2: 0 },
            statusCounts: run.statusCounts || { open: 0, working: 0, dismissed: 0, fixed: 0 },
          },
        }
      : null;

  const buildStatus = () => {
    const now = Date.now();
    if (state.statusCache && now - state.statusCache.computedAt < kDoctorStatusMemoTtlMs) {
      return state.statusCache.status;
    }
    const bootstrapContext = getBootstrapContext();
    const recentRuns = listDoctorRunSummaries({ limit: 10 });
    const latestRun = recentRuns[0] || null;
    const latestCompletedRun =
      recentRuns.find((run) => run.status === kDoctorRunStatus.completed) || null;
    const lastRunAt =
      latestCompletedRun?.completedAt || latestCompletedRun?.startedAt || null;
    const lastRunAgeMs = hasValidIsoTime(lastRunAt) ? Date.now() - Date.parse(lastRunAt) : null;
    const stale = lastRunAgeMs == null || lastRunAgeMs >= kDoctorStaleThresholdMs;
    const baselineRun = latestCompletedRun;
    const initialBaseline = !baselineRun ? getOrCreateInitialBaseline() : null;
    const currentSnapshot = baselineRun || initialBaseline ? getCurrentWorkspaceSnapshot() : null;
    const status = {
      activeRunId: state.activeRunId || 0,
      runInProgress: !!state.activeRunPromise,
      lastRunAt,
      lastRunAgeMs,
      needsInitialRun: !latestCompletedRun,
      stale,
      bootstrapContext,
      changeSummary: buildChangeSummary({ baselineRun, initialBaseline, currentSnapshot }),
      latestRun: toSlimLatestRun(latestRun),
    };
    state.statusCache = {
      computedAt: now,
      status,
    };
    return status;
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
      handleDoctorRunSettled();
    }
  };

  const runDoctor = () => {
    if (state.activeRunPromise) {
      return {
        ok: false,
        alreadyRunning: true,
        runId: state.activeRunId || 0,
        status: buildStatus(),
        error: "Doctor run already in progress",
      };
    }
    const workspaceSnapshot = getCurrentWorkspaceSnapshot();
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
        rawResult: latestCompletedRun.rawResult,
      });
      handleDoctorRunSettled();
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
    // Bust the status memo so the returned status reflects the new run.
    state.statusCache = null;
    return {
      ok: true,
      runId,
      status: buildStatus(),
    };
  };

  const importDoctorResult = ({
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
    const workspaceSnapshot = getCurrentWorkspaceSnapshot();
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
    handleDoctorRunSettled();
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

  return {
    buildStatus,
    runDoctor,
    importDoctorResult,
    listDoctorRuns,
    listDoctorCards,
    getDoctorRun,
    getDoctorCardsByRunId,
    requestCardFix,
    setCardStatus,
    getDoctorCard,
  };
};

module.exports = {
  buildDoctorFixCompletionInstructions,
  buildDoctorIdempotencyKey,
  buildDoctorSessionKey,
  buildDoctorSessionId,
  createDoctorService,
};
