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
  terminateSharedSnapshotWorkerClient,
} = require("./workspace-fingerprint");
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

// Reuse runs persist this exact summary. Deliberately no elapsed phrase:
// summaries are stored once and re-served forever, so a baked-in
// "(12 minutes ago)" reads stale on every later request. "How long ago" is
// the client's job, computed from the run's timestamp fields.
const kDoctorReuseSummary =
  "No workspace changes since last scan. Same findings apply.";

// Older reuse runs froze the elapsed phrase into the DB ("No workspace
// changes since last scan (12 minutes ago). Same findings apply."). Scrub
// those on read with an EXACT template match: the full sentence pair,
// anchored, with the parenthetical limited to the retired helper's only
// output shapes ("N minute(s)/hour(s)/day(s) ago" or its "the last scan"
// fallback). A loose "(N units ago)" pattern would be both overbroad — an
// AI-authored summary can legitimately contain that phrase in some other
// sentence — and incomplete, since it would miss the fallback shape.
const kLegacyReuseSummaryPattern =
  /^No workspace changes since last scan \((?:\d+ (?:minute|hour|day)s? ago|the last scan)\)\. Same findings apply\.$/;

const scrubLegacyReuseSummary = (summary) =>
  typeof summary === "string" && kLegacyReuseSummaryPattern.test(summary)
    ? kDoctorReuseSummary
    : summary;

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
  // Slim readers for the status hot path (wired from db/doctor in server.js).
  listDoctorRunSummaries = null,
  getDoctorRunWorkspaceManifest = null,
  // v0.9.36 injection names for the same readers; either name works.
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
    initialBaselineCache: null,
    snapshotRefreshPromise: null,
    snapshotRefreshFailureLogged: false,
    bootstrapContextCache: null,
    changeSummaryCache: null,
    statusCache: null,
  };

  // Fallbacks keep injected test doubles that only provide listDoctorRuns /
  // getDoctorRun working; production wires the lean summary readers.
  const listRunSummaries =
    listDoctorRunSummaries || ((options) => listDoctorRuns(options));
  const readRunManifest =
    getDoctorRunWorkspaceManifest ||
    getDoctorRunManifest ||
    ((id) => getDoctorRun(id)?.workspaceManifest ?? null);
  const readLatestCompletedRunSummary =
    getLatestCompletedRunSummary ||
    (() =>
      listRunSummaries({ limit: 25 }).find(
        (run) => run.status === kDoctorRunStatus.completed,
      ) || null);

  const getLatestCompletedRun = () => readLatestCompletedRunSummary();

  const refreshSnapshotInBackground = () => {
    if (state.snapshotRefreshPromise) return state.snapshotRefreshPromise;
    const previousManifest = state.snapshotCache?.snapshot?.manifest || null;
    state.snapshotRefreshPromise = computeSnapshotAsync(workspaceRoot, { previousManifest })
      .then((snapshot) => {
        state.snapshotCache = {
          computedAt: Date.now(),
          snapshot,
        };
        // The memoized status was computed against the previous snapshot (or
        // none at all on a cold boot) — let the next tick rebuild it.
        state.statusCache = null;
        state.changeSummaryCache = null;
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

  const getCurrentWorkspaceSnapshot = ({
    allowSyncCompute = false,
    requireFresh = false,
  } = {}) => {
    if (
      allowSyncCompute &&
      requireFresh &&
      state.snapshotCache &&
      Date.now() - state.snapshotCache.computedAt >= kDoctorWorkspaceSnapshotTtlMs
    ) {
      // Explicit doctor runs decide "reuse vs re-scan" off this fingerprint;
      // a stale one silently no-ops the run the user just asked for. The sync
      // walk here is a bounded, user-initiated action (pre-branch behavior).
      state.snapshotCache = {
        computedAt: Date.now(),
        snapshot: computeSnapshot(workspaceRoot),
      };
      return state.snapshotCache.snapshot;
    }
    if (!state.snapshotCache) {
      // Cold cache: the status path must NEVER hash the workspace on the
      // event loop (a big workspace blocks every request for seconds, at
      // exactly the post-restart moment the UI polls hardest). Kick the
      // worker and report "not yet known"; only explicit doctor-run paths
      // (bounded, user-initiated) may compute synchronously.
      if (!allowSyncCompute) {
        refreshSnapshotInBackground();
        return null;
      }
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
    state.initialBaselineCache = null;
    if (state.snapshotCache) state.snapshotCache.computedAt = 0;
    state.changeSummaryCache = null;
    state.statusCache = null;
  };

  const getOrCreateInitialBaseline = () => {
    // Pre-first-run, this runs on every status rebuild; the persisted
    // baseline embeds the FULL workspace manifest and re-parsing it each
    // time is exactly the hot-path JSON.parse this branch removed for runs.
    if (state.initialBaselineCache) return state.initialBaselineCache;
    const existingBaseline = getInitialWorkspaceBaseline?.();
    if (existingBaseline?.fingerprint && existingBaseline?.manifest) {
      state.initialBaselineCache = existingBaseline;
      return existingBaseline;
    }
    const snapshot = getCurrentWorkspaceSnapshot();
    // Status-path cold cache: defer baseline creation to a later tick (the
    // worker is already computing) rather than walking the workspace here.
    if (!snapshot) return null;
    const nextBaseline = {
      fingerprint: snapshot.fingerprint,
      manifest: snapshot.manifest,
      capturedAt: new Date().toISOString(),
    };
    const persisted = setInitialWorkspaceBaseline?.(nextBaseline) || nextBaseline;
    state.initialBaselineCache = persisted;
    return persisted;
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
        const manifest = readRunManifest(baselineRun.id);
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

  // Legacy-summary scrub for the full-run read paths (/api/doctor/runs and
  // /api/doctor/runs/:id are pass-throughs of the injected readers below).
  // Returns the run untouched unless the summary actually matches.
  const scrubRunSummary = (run) => {
    if (!run) return run;
    const summary = scrubLegacyReuseSummary(run.summary);
    return summary === run.summary ? run : { ...run, summary };
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
          summary: scrubLegacyReuseSummary(run.summary) || "",
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
    // Summaries only: run manifests/raw results are fetched lazily for the
    // single baseline run — never parsed per listed run.
    const recentRuns = listRunSummaries({ limit: 10 });
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
      changeSummary: {
        ...buildChangeSummary({ baselineRun, initialBaseline, currentSnapshot }),
        // Grafted from v0.9.36: snapshot freshness plus the bounded-manifest
        // signal (drift detection is limited on runaway workspaces).
        snapshotAgeMs: state.snapshotCache ? now - state.snapshotCache.computedAt : null,
        workspaceLimited: !!currentSnapshot?.limited,
      },
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

  // async so a throw anywhere (snapshot walk, DB read/write, run creation)
  // surfaces as a rejection to route handlers instead of a sync explosion.
  // The busy-guard needs no extra latch: nothing is awaited before
  // activeRunPromise is set, and a throw before that leaves the guard clear.
  const runDoctor = async () => {
    if (state.activeRunPromise) {
      return {
        ok: false,
        alreadyRunning: true,
        runId: state.activeRunId || 0,
        status: buildStatus(),
        error: "Doctor run already in progress",
      };
    }
    const workspaceSnapshot = getCurrentWorkspaceSnapshot({ allowSyncCompute: true, requireFresh: true });
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
      completeDoctorRun({
        id: runId,
        status: kDoctorRunStatus.completed,
        summary: kDoctorReuseSummary,
        // latestCompletedRun is a lean summary (no rawResult) — fetch the
        // full source run only on this reuse path, where it's actually needed.
        rawResult: getDoctorRun(latestCompletedRun.id)?.rawResult ?? null,
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

  // async for the same reason as runDoctor: guard failures surface to route
  // handlers as rejections.
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
    const workspaceSnapshot = getCurrentWorkspaceSnapshot({ allowSyncCompute: true, requireFresh: true });
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

  // Shutdown hook: the default async computer runs on the shared module-level
  // worker thread — tear it down so the process exits clean. Injected
  // computers (tests, custom wiring) own their lifecycle.
  const dispose = () => {
    if (computeSnapshotAsync === computeWorkspaceSnapshotAsync) {
      void terminateSharedSnapshotWorkerClient();
    }
  };

  return {
    buildStatus,
    // Test/settling hook: resolves when any in-flight background workspace
    // snapshot refresh lands (null when none is running).
    awaitWorkspaceSnapshotRefresh: () =>
      state.snapshotRefreshPromise || Promise.resolve(null),
    // Demand-driven refresh (boot cache priming, explicit re-scans). Resolves
    // with the fresh snapshot, or the stale one when the worker fails.
    refreshWorkspaceSnapshot: () => refreshSnapshotInBackground(),
    runDoctor,
    importDoctorResult,
    // Exported (route-facing) run readers scrub legacy frozen-elapsed reuse
    // summaries on the way out; internal callers keep the raw injected fns.
    listDoctorRuns: (options) => listDoctorRuns(options).map(scrubRunSummary),
    listDoctorCards,
    getDoctorRun: (id) => scrubRunSummary(getDoctorRun(id)),
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
