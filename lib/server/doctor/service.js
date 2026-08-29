const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const { resolveContainedPath } = require("../utils/safe-path");
const {
  buildBootstrapTruncationCards,
  createBootstrapContextAnalyzer,
  resolveMainBootstrapBudget,
} = require("./bootstrap-context");
const {
  kDoctorBootstrapMaxChars,
  kDoctorBootstrapTotalMaxChars,
  selectDoctorContextProfile,
} = require("./context-profiles");
const { buildDeterministicCards } = require("./deterministic-checks");
const { runOpenclawDoctorBridge } = require("./openclaw-doctor");
const { createDoctorTextSanitizer } = require("./sanitize");
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
  kAlphaclawHardeningPrefix,
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
const {
  kDoctorBootstrapContextTtlMs,
  kDoctorStatusMemoTtlMs,
  kDoctorWorkspaceSnapshotTtlMs,
} = require("../constants");

const kMaxSnippetLines = 20;
// Generous: snippets are ≤ kMaxSnippetLines; the cap only bounds runaway lines.
const kSnippetRedactMaxChars = 10000;
// Chunk size for the forward scan that locates a cited line: findings can
// cite lines anywhere in a file, so the reader streams cap-sized chunks
// (keeping only the requested window) instead of buffering the whole file.
const kSnippetReadMaxBytes = 512 * 1024;
// Hard bound on the total bytes scanned to produce one snippet. Evidence
// snippets come from AI `openclaw doctor` output or the /api/doctor/import
// rawOutput, i.e. untrusted paths, and a huge in-workspace file must not
// exhaust memory or block the event loop (CX4): a citation whose window
// cannot be completed within this bound yields no snippet (null) rather than
// an unbounded read; when EOF is not reached within the bound, totalFileLines
// is dropped instead of scanning to EOF just to count lines.
const kSnippetScanMaxBytes = 8 * 1024 * 1024;
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

const readFileSnippet = (rootDir, relativePath, startLine, endLine, redact = (text) => text) => {
  try {
    // Containment: evidence paths come from LLM/bridge output — a traversal
    // or absolute path must never read outside the workspace into a card.
    const requestedPath = String(relativePath || "");
    if (path.isAbsolute(requestedPath)) return null;
    const root = path.resolve(rootDir);
    // Realpath-safe containment (H6, via the shared H4 primitive): a
    // `../../etc/passwd` or an in-workspace symlink must not escape the
    // workspace root — and the read below operates on the RETURNED canonical
    // path so it cannot re-follow the very symlink the check cleared.
    const contained = resolveContainedPath(
      path.resolve(root, requestedPath),
      root,
    );
    if (!contained.ok) return null;
    const realPath = contained.absolutePath;
    // Regular files only, checked BEFORE open: opening a FIFO for read blocks
    // until a writer appears. (No whole-file size cap: the bounded reader
    // below never scans past kSnippetScanMaxBytes regardless of file size, so
    // an oversized file costs a bounded read, not an OOM — CX4.)
    if (!fs.statSync(realPath).isFile()) return null;
    // Bounded windowed read through an fd: stream kSnippetReadMaxBytes-sized
    // chunks counting newlines until the requested [start, cappedEnd) window
    // is captured — a citation deep in a multi-MB file still gets its real
    // lines, but never more than kSnippetScanMaxBytes are read for one
    // snippet.
    const start = Math.max(0, (startLine || 1) - 1);
    const end = endLine && endLine >= startLine ? endLine : start + 1;
    const cappedEnd = Math.min(end, start + kMaxSnippetLines);
    const fd = fs.openSync(realPath, "r");
    const windowLines = [];
    // Known only when EOF is reached within the scan bound; dropped otherwise.
    let totalFileLines = null;
    try {
      const stats = fs.fstatSync(fd);
      if (!stats.isFile()) return null;
      const decoder = new StringDecoder("utf8");
      const chunk = Buffer.allocUnsafe(
        Math.min(Math.max(stats.size, 1), kSnippetReadMaxBytes),
      );
      let carry = "";
      let lineIndex = 0;
      let scannedBytes = 0;
      while (true) {
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, scannedBytes);
        if (bytesRead <= 0) {
          // EOF terminates the final line (an empty file is one empty line,
          // matching String.prototype.split("\n") on a full read).
          carry += decoder.end();
          if (lineIndex >= start && lineIndex < cappedEnd) windowLines.push(carry);
          totalFileLines = lineIndex + 1;
          break;
        }
        scannedBytes += bytesRead;
        const parts = (carry + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
        carry = parts.pop();
        for (const line of parts) {
          if (lineIndex >= start && lineIndex < cappedEnd) windowLines.push(line);
          lineIndex += 1;
        }
        if (lineIndex >= cappedEnd) {
          // Window complete. Keep scanning only to report totalFileLines, and
          // only when EOF is guaranteed inside the scan bound — otherwise stop
          // here and drop the field instead of reading up to the bound. (The
          // scannedBytes check keeps a file that grew after fstat bounded.)
          if (stats.size > kSnippetScanMaxBytes || scannedBytes >= kSnippetScanMaxBytes) {
            break;
          }
        } else if (scannedBytes >= kSnippetScanMaxBytes) {
          // Scan bound exhausted before the cited window was reached: no
          // snippet rather than an unbounded (or silently wrong) one.
          return null;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    // The cited startLine is past EOF: the line does not exist — no snippet.
    if (windowLines.length === 0) return null;
    return {
      text: redact(windowLines.join("\n")),
      startLine: start + 1,
      endLine: start + windowLines.length,
      // Truncated when the requested range was cut by kMaxSnippetLines (a
      // range clamped only by EOF is fully served, exactly like the full-read
      // implementation before the bounded reader).
      truncated:
        totalFileLines === null
          ? cappedEnd < end
          : Math.min(cappedEnd, totalFileLines) < Math.min(end, totalFileLines),
      ...(totalFileLines === null ? {} : { totalFileLines }),
    };
  } catch {
    return null;
  }
};

const captureEvidenceSnippets = (cards, rootDir, redact = (text) => text) => {
  for (const card of cards) {
    if (!Array.isArray(card.evidence)) continue;
    for (const item of card.evidence) {
      if (!item || item.type !== "path" || !item.path || !item.startLine) continue;
      const snippet = readFileSnippet(rootDir, item.path, item.startLine, item.endLine, redact);
      if (snippet) item.snippet = snippet;
    }
  }
};

const buildDoctorSessionKey = (runId) => `agent:main:doctor:${Number(runId || 0)}`;
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
  // Snippets are persisted card content read from workspace files — the same
  // secret redaction as every other card field (no markdown escaping, no
  // single-line collapsing: card snippets render as plain multi-line text).
  const redactSnippetText = (text) =>
    sanitizer.sanitize(text, { maxChars: kSnippetRedactMaxChars });
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

  // Reuse runs clone ONLY the LLM cards (their inputs — workspace bytes,
  // promptVersion, context profile, installed version — are all part of the
  // reuse key). Every sourced card — bootstrap, deterministic, AND the
  // openclaw-doctor bridge — reads inputs that live outside the fingerprinted
  // workspace tree (openclaw.json, CLI state), so cloning them would freeze
  // new/resolved upstream findings across every reused scan; they are all
  // recomputed fresh on every run, including reuse runs.
  const cloneRunCards = ({ sourceRunId, targetRunId }) => {
    const sourceCards = getDoctorCardsByRunId(sourceRunId)
      .filter((card) => !card.source || card.source === kDoctorCardSource.llm)
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

  const getBootstrapContext = () => {
    const now = Date.now();
    if (
      state.bootstrapContextCache &&
      now - state.bootstrapContextCache.computedAt < kDoctorBootstrapContextTtlMs
    ) {
      return state.bootstrapContextCache.context;
    }
    const context = bootstrapAnalyzer.analyze();
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
    // The profile shapes drift weights and can flip on a channel switch
    // without a restart — key the cache on it too.
    const profile = getActiveProfile();
    const baselineKey = baselineRun ? `run:${baselineRun.id}` : initialBaseline ? "initial" : "none";
    const baselineFingerprint = baselineRun
      ? String(baselineRun.workspaceFingerprint || "")
      : String(initialBaseline?.fingerprint || "");
    const currentFingerprint = String(currentSnapshot?.fingerprint || "");
    const cached = state.changeSummaryCache;
    if (
      cached &&
      cached.profileId === profile.id &&
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
          profile,
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
      profileId: profile.id,
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
      gatewayReadiness: safeGatewayReadiness(),
      autoRun: {
        enabled: readAutoRunEnabledSafe(),
        lastCheckAt: autoRunState.lastCheckAt,
        lastSkipReason: autoRunState.lastSkipReason,
      },
      releaseChannel: safeReleaseChannel(),
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
      // One dismissed-keys read per run, shared by every sourced-card filter.
      const dismissedKeys = readDismissedSourceKeys();
      const sourcedCards = buildFreshSourcedCards({ config: runConfig, dismissedKeys });
      const bridgeCards = filterDismissedSourcedCards(bridgeResult.cards, dismissedKeys);
      const cards = [...sourcedCards, ...bridgeCards, ...normalizedResult.cards];
      captureEvidenceSnippets(cards, workspaceRoot, redactSnippetText);
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
      handleDoctorRunSettled();
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
  // Callers thread one config snapshot (and one dismissed-keys read) through
  // a flow instead of re-reading per filter.
  const buildFreshSourcedCards = ({
    config = safeReadConfig(),
    dismissedKeys = undefined,
  } = {}) => {
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
    return filterDismissedSourcedCards(
      [...bootstrapCards, ...deterministicCards],
      dismissedKeys,
    );
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
        // EFFECTIVE main-agent budgets, not just agents.defaults: the
        // analyzer honors per-agent overrides (agents.entries/agents.list
        // main entry), so raising the main override to fix a truncation must
        // flip envChanged and schedule the follow-up scan.
        perFile: resolveMainBootstrapBudget(
          config,
          "bootstrapMaxChars",
          kDoctorBootstrapMaxChars,
        ),
        total: resolveMainBootstrapBudget(
          config,
          "bootstrapTotalMaxChars",
          kDoctorBootstrapTotalMaxChars,
        ),
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
      // Deep enough that a stretch of failed/import runs cannot empty the
      // baseline and re-notify every persistent P0.
      const baselineRun = listRunSummaries({ limit: 100 }).find(
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
            // singleLine: an LLM/workspace-derived title must not forge extra
            // lines inside the trusted notification frame.
            `- ${sanitizer.escapeMarkdown(
              sanitizer.sanitize(card.title, {
                maxChars: kDoctorNotifyMaxLineChars,
                singleLine: true,
              }),
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
      // The run is created RUNNING and holds the busy latch until every card
      // — the LLM clone, sourced cards, AND the fresh bridge pass — is in.
      // Creating it "completed" up front let other API calls observe an
      // incomplete completed run during the bridge await, and let a
      // concurrent runDoctor reuse it (starting a second bridge).
      const runId = createDoctorRun({
        status: kDoctorRunStatus.running,
        engine: kDoctorEngine.deterministicReuse,
        workspaceRoot,
        workspaceFingerprint,
        workspaceManifest: workspaceSnapshot.manifest,
        promptVersion: kDoctorPromptVersion,
        contextProfile: activeProfile.id,
        openclawVersion: installedVersion,
        reusedFromRunId: latestCompletedRun.id,
      });
      state.activeRunId = runId;
      // NOTE: the async body below runs synchronously up to its first await
      // (the bridge call), so the latch assignment after it still lands
      // before any other event-loop turn can observe the in-flight run. The
      // latch is cleared around the await in THIS function — not in a finally
      // inside the block — because a bridge-less enrichment completes fully
      // synchronously, and an inner finally would then be clobbered by the
      // latch assignment (a settled promise latched forever).
      const reuseEnrichment = (async () => {
        try {
          cloneRunCards({
            sourceRunId: latestCompletedRun.id,
            targetRunId: runId,
          });
          // Environment-dependent checks are recomputed even when the
          // workspace bytes are unchanged (config/budget/hook state lives
          // outside the fingerprinted tree). That includes the upstream-doctor
          // bridge: openclaw.json is outside the fingerprint, so cloning its
          // point-in-time findings would keep them stale across every reused
          // scan. Fail-soft like the main path — a throw or absent CLI yields
          // zero bridge cards, never a failed reuse run.
          const reuseConfig = safeReadConfig();
          const dismissedKeys = readDismissedSourceKeys();
          const sourcedCards = buildFreshSourcedCards({
            config: reuseConfig,
            dismissedKeys,
          });
          let bridgeCards = [];
          if (runDoctorLintJson) {
            let bridgeResult = null;
            try {
              bridgeResult = await runOpenclawDoctorBridge({
                runLintJson: runDoctorLintJson,
                sanitize: sanitizer.sanitize,
              });
            } catch {
              bridgeResult = { ok: false, cards: [], droppedCount: 0 };
            }
            if (bridgeResult.droppedCount > 0) {
              console.warn(
                `[doctor] openclaw doctor bridge dropped ${bridgeResult.droppedCount} lower-priority findings (card cap)`,
              );
            }
            bridgeCards = filterDismissedSourcedCards(bridgeResult.cards, dismissedKeys);
          }
          const freshCards = [...sourcedCards, ...bridgeCards];
          if (freshCards.length) {
            captureEvidenceSnippets(freshCards, workspaceRoot, redactSnippetText);
            insertDoctorCards({ runId, cards: freshCards });
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
        } catch (error) {
          // Unexpected (non-bridge) failure: the run must not stay "running"
          // forever — settle it as failed, then keep rejecting to the caller
          // exactly as the pre-latch reuse path did.
          completeDoctorRun({
            id: runId,
            status: kDoctorRunStatus.failed,
            error: error.message || "Doctor run failed",
          });
          throw error;
        }
      })();
      state.activeRunPromise = reuseEnrichment;
      // Bust the status memo so concurrent status reads see the running run.
      state.statusCache = null;
      try {
        // Unlike the LLM branch, callers still get the settled reuse result —
        // enrichment is a fast local pass plus one bridge call, not an LLM run.
        await reuseEnrichment;
      } finally {
        state.activeRunId = 0;
        state.activeRunPromise = null;
        handleDoctorRunSettled();
      }
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
    // Bust the status memo so the returned status reflects the new run.
    state.statusCache = null;
    return {
      ok: true,
      runId,
      status: buildStatus(),
    };
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
      if (state.activeRunPromise) {
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
      // after the inputs change or the backoff window passes. "Inputs" are
      // BOTH the env signature (config/version) AND the workspace
      // fingerprint the failed run recorded: real workspace edits after a
      // failed scan lift the backoff instead of staying suppressed for the
      // full window. The fingerprint is deliberately NOT part of
      // envSignature — workspace drift has its own stale+meaningful trigger;
      // here it only decides whether the backoff still applies.
      if (
        lastAutoRun?.outcome === "failed" &&
        lastAutoRun?.envSignature === envSignature &&
        Date.now() - lastAutoRunAt < kDoctorAutoRunFailureBackoffMs
      ) {
        // Compare against a fresh fingerprint (worker refresh, never a sync
        // walk — the backoff path would otherwise never observe workspace
        // changes: it returns before buildStatus can kick the refresh). A
        // marker without a fingerprint (pre-upgrade) or an unknown current
        // fingerprint reads as unchanged — conservative, the backoff holds.
        if (
          !state.snapshotCache ||
          Date.now() - state.snapshotCache.computedAt >= kDoctorWorkspaceSnapshotTtlMs
        ) {
          await refreshSnapshotInBackground();
        }
        const failedRunFingerprint = String(lastAutoRun?.workspaceFingerprint || "");
        const currentFingerprint = String(
          state.snapshotCache?.snapshot?.fingerprint || "",
        );
        const workspaceChangedSinceFailure =
          !!failedRunFingerprint &&
          !!currentFingerprint &&
          failedRunFingerprint !== currentFingerprint;
        if (!workspaceChangedSinceFailure) {
          autoRunState.lastSkipReason = "backoff";
          return;
        }
      }
      const status = buildStatus();
      const staleAndMeaningful =
        status.stale && status.changeSummary?.hasMeaningfulChanges === true;
      const lastEnvSignature = readMetaValue("last_env_signature");
      // A missing signature means no run since env-signature tracking shipped
      // — the post-upgrade scan is due by design (an existing install with
      // old completed runs must not skip forever); the 6h throttle bounds it.
      const envChanged = !lastEnvSignature || lastEnvSignature !== envSignature;
      // A P0-worthy context condition with zero workspace delta triggers a
      // scan only when the latest run has not already reported it — and not
      // when the user DISMISSED it (dismissal suppresses re-emission, which
      // must not read as "new" forever and re-run every throttle window).
      // Candidate keys are derived from the CURRENT condition (the exact
      // sourceKeys its cards would carry), so a dismissed unrelated key from
      // the same family (e.g. an old boot:file_limit:USER.md card) can never
      // suppress a genuinely new hardening-blocked state.
      const hardeningState = String(status.bootstrapContext?.hardening?.state || "");
      const hasActiveTruncation = status.bootstrapContext?.hasActiveTruncation === true;
      const hardeningBad =
        ["blocked", "starved"].includes(hardeningState) || hasActiveTruncation;
      let hardeningNew = false;
      if (hardeningBad) {
        const candidateKeys = new Set();
        if (["blocked", "starved"].includes(hardeningState)) {
          candidateKeys.add(`det:hardening:${hardeningState}`);
        }
        if (hasActiveTruncation) {
          // Mirrors buildBootstrapTruncationCards' key shapes exactly:
          // per-file truncation → boot:file_limit:<path>, everything driven
          // by the total budget (total/both/starved) → boot:total_limit.
          // AlphaClaw hardening files are excluded from those generic cards
          // (det:hardening:* is their single owner, covered above) — so they
          // must not mint boot:* candidate keys here either.
          for (const file of status.bootstrapContext?.activeTruncatedFiles || []) {
            if (String(file.path || "").startsWith(kAlphaclawHardeningPrefix)) continue;
            if (file.reason === "file_limit") {
              candidateKeys.add(`boot:file_limit:${file.path}`);
            } else {
              candidateKeys.add("boot:total_limit");
            }
          }
        }
        const latestRun = getLatestCompletedRun();
        const latestCards = latestRun ? getDoctorCardsByRunId(latestRun.id) : [];
        const reportedKeys = new Set(
          latestCards.map((card) => String(card.sourceKey || "")),
        );
        const dismissedKeys = readDismissedSourceKeys() || new Set();
        hardeningNew = [...candidateKeys].some(
          (key) => !reportedKeys.has(key) && !dismissedKeys.has(key),
        );
      }
      // Fresh install: no completed run means no baseline, no stored env
      // signature, and (with healthy hardening) no other trigger can ever
      // fire — enabling the toggle must still schedule the first run.
      const needsInitialRun = status.needsInitialRun === true;
      if (!(staleAndMeaningful || envChanged || hardeningNew || needsInitialRun)) {
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
        workspaceFingerprint: String(state.snapshotCache?.snapshot?.fingerprint || ""),
      });
      // The background tick must never sync-walk the workspace (headless
      // installs run scheduled scans with a cold/stale cache — a sync walk
      // there blocks the event loop for seconds). Refresh on the worker so
      // runDoctor's requireFresh check sees a fresh cache.
      if (
        !state.snapshotCache ||
        Date.now() - state.snapshotCache.computedAt >= kDoctorWorkspaceSnapshotTtlMs
      ) {
        await refreshSnapshotInBackground();
      }
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
        // The fingerprint the run actually consumed: a later tick lifts the
        // failure backoff when the workspace no longer matches it.
        workspaceFingerprint: String(
          run?.workspaceFingerprint ||
            state.snapshotCache?.snapshot?.fingerprint ||
            "",
        ),
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
    const sourcedCards = buildFreshSourcedCards();
    const cards = [...sourcedCards, ...normalizedResult.cards];
    captureEvidenceSnippets(cards, workspaceRoot, redactSnippetText);
    const workspaceSnapshot = getCurrentWorkspaceSnapshot({ allowSyncCompute: true, requireFresh: true });
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
    // Fix dispatch is fire-and-forget into the same gateway — fail fast with
    // the reason instead of flipping the card to working and timing out.
    const readiness = safeGatewayReadiness();
    if (!readiness.ok) {
      const error = new Error(`Gateway is not ready for a Doctor fix: ${readiness.reason}`);
      error.gatewayUnavailable = true;
      error.reason = readiness.reason;
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

  // Shutdown hook: the default async computer runs on the shared module-level
  // worker thread — tear it down so the process exits clean. Injected
  // computers (tests, custom wiring) own their lifecycle.
  const dispose = () => {
    if (autoRunState.timer) {
      clearInterval(autoRunState.timer);
      autoRunState.timer = null;
    }
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
