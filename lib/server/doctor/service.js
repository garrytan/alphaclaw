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
const {
  buildModelDriftCards,
  collectConfiguredModels,
} = require("./model-drift");
const { buildDashboardTokenCards } = require("./dashboard-token-check");
const { runOpenclawDoctorBridge } = require("./openclaw-doctor");
const { createDoctorTextSanitizer } = require("./sanitize");
const { buildDoctorPrompt } = require("./prompt");
const { hashDoctorFixToken } = require("./fix-completion");
const { getReplyTargetFromSessionKey } = require("../utils/session-keys");
const { normalizeDoctorResult } = require("./normalize");
const {
  calculateWorkspaceDelta,
  computeWorkspaceSnapshot,
  computeWorkspaceSnapshotAsync,
  terminateSharedSnapshotWorkerClient,
  resolveEffectiveScanCaps,
  kSnapshotLegacyMaxFiles,
  kSnapshotLegacyMaxFileBytes,
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
  kFallbackOnboardingModels,
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
// Byte budget for the SHELL-ESCAPED gateway --params argument: one exec
// argument is capped by Linux MAX_ARG_STRLEN (~128KiB); 120KB leaves margin
// for the fixed command prefix (measured post-escaping, so apostrophe
// expansion is already counted).
const kDoctorFixParamsMaxBytes = 120 * 1000;

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
  "No workspace changes since last scan. LLM findings carried over; environment checks re-evaluated.";

// Older reuse runs froze the elapsed phrase into the DB ("No workspace
// changes since last scan (12 minutes ago). Same findings apply."). Scrub
// those on read with an EXACT template match: the full sentence pair,
// anchored, with the parenthetical limited to the retired helper's only
// output shapes ("N minute(s)/hour(s)/day(s) ago" or its "the last scan"
// fallback). A loose "(N units ago)" pattern would be both overbroad — an
// AI-authored summary can legitimately contain that phrase in some other
// sentence — and incomplete, since it would miss the fallback shape. The
// second-sentence alternation covers both retired copies: upstream's "Same
// findings apply." and this branch's pre-merge "LLM findings carried over;
// environment checks re-evaluated." (with or without the elapsed phrase).
const kLegacyReuseSummaryPattern =
  /^No workspace changes since last scan(?: \((?:\d+ (?:minute|hour|day)s? ago|the last scan)\))?\. (?:Same findings apply|LLM findings carried over; environment checks re-evaluated)\.$/;

const scrubLegacyReuseSummary = (summary) =>
  typeof summary === "string" && kLegacyReuseSummaryPattern.test(summary)
    ? kDoctorReuseSummary
    : summary;

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
  setDoctorCardFixDelivery = null,
  // Fix-dispatch session validation: resolves a sessionKey against the live
  // `sessions --json --all-agents` list (absent ⇒ validation skipped, e.g.
  // legacy test doubles; production always wires it).
  findSendableSession = null,
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
  // Configured scan caps ({maxFiles, maxFileMb}, nulls = built-in defaults),
  // read at call time so settings changes apply without a restart.
  readScanCaps = null,
  getDoctorMeta = null,
  setDoctorMeta = null,
  listDismissedSourceKeys = null,
  // Gateway memory-leak trend (watchdog.getMemoryTrend cached snapshot) +
  // the shared heap-raise remedy string. Both optional and fail-soft: absent
  // or throwing getters mean "no leak card", never a failed scan.
  getGatewayMemoryTrend = null,
  getGatewayHeapAdvice = null,
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
  // The dashboard-URL service registers post-construction (route wiring owns
  // the shared instance, created after this service boots); a holder object
  // keeps the closure over one slot. Unregistered (older wiring, test
  // doubles) the check is skipped — never a false card.
  const dashboardTokenState = { service: null };
  const registerDashboardTokenCheck = (service) => {
    dashboardTokenState.service = service || null;
  };
  // The model catalog cache also registers post-construction (route wiring
  // owns the shared instance). Unregistered, the model-drift check falls
  // back to the bundled bootstrap catalog — never an exec, never a stall.
  const modelCatalogState = { cache: null };
  const registerModelCatalog = (cache) => {
    modelCatalogState.cache = cache || null;
  };
  const safeCatalog = () => {
    try {
      const catalog = modelCatalogState.cache?.peekCatalog?.();
      if (Array.isArray(catalog?.models) && catalog.models.length > 0) {
        return { models: catalog.models, source: String(catalog.source || "") };
      }
    } catch {
      // fall through to the bundled fallback
    }
    return { models: kFallbackOnboardingModels, source: "bootstrap" };
  };
  const state = {
    activeRunId: 0,
    activeRunPromise: null,
    // Synchronous latch for the pre-run snapshot await: runDoctor awaits the
    // worker snapshot BEFORE setting activeRunPromise, and two concurrent
    // calls must not both pass the busy check in that window.
    runStartPending: false,
    snapshotCache: null,
    // Bumped whenever the configured caps change: an in-flight worker result
    // computed under the old caps must not repopulate the cache.
    capsEpoch: 0,
    lastLimitedLogged: null,
    lastSnapshotSource: null,
    sessionValidationSkippedWarned: false,
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

  // Effective caps resolve at call time (settings changes need no restart).
  const resolveScanCaps = () => {
    let configured = { maxFiles: null, maxFileMb: null };
    try {
      const read = readScanCaps?.();
      if (read && typeof read === "object") {
        configured = {
          maxFiles: read.maxFiles ?? null,
          maxFileMb: read.maxFileMb ?? null,
        };
      }
    } catch {
      // unreadable config reads as defaults
    }
    return {
      configured,
      // Both byte- and MB-denominated so status consumers never re-derive
      // units (shared resolution rule lives in workspace-fingerprint).
      effective: resolveEffectiveScanCaps(configured),
    };
  };

  // Log the limited state on TRANSITION only — a capped workspace refreshes
  // every ≤60s and must not spam the log with a line per refresh.
  const logLimitedTransition = (snapshot) => {
    const limited = !!snapshot?.limited;
    if (state.lastLimitedLogged === limited) return;
    if (state.lastLimitedLogged === null && !limited) {
      state.lastLimitedLogged = limited;
      return;
    }
    state.lastLimitedLogged = limited;
    if (limited) {
      const stats = snapshot?.stats || {};
      console.warn(
        `[doctor] workspace scan is partial: ${Number(stats.totalFiles || 0)} files found ` +
          `(cap ${Number(snapshot?.capsUsed?.maxFiles || 0)}), ` +
          `${Number(stats.skippedLargeCount || 0)} over-size skipped, ` +
          `${Number(stats.skippedDirCount || 0)} unreadable dirs`,
      );
    } else {
      console.log("[doctor] workspace scan is complete again (caps no longer exceeded)");
    }
  };

  const commitSnapshot = (snapshot) => {
    state.snapshotCache = {
      computedAt: Date.now(),
      snapshot,
    };
    // The memoized status was computed against the previous snapshot (or
    // none at all on a cold boot) — let the next tick rebuild it.
    state.statusCache = null;
    state.changeSummaryCache = null;
    logLimitedTransition(snapshot);
  };

  // Worker-backed refresh. REJECTS on worker failure — background callers
  // wrap it (refreshSnapshotInBackground); the run path catches to fall back
  // to a bounded sync walk.
  const startSnapshotRefresh = () => {
    if (state.snapshotRefreshPromise) return state.snapshotRefreshPromise;
    const previousManifest = state.snapshotCache?.snapshot?.manifest || null;
    const previousFingerprint = state.snapshotCache?.snapshot?.fingerprint || "";
    const { effective } = resolveScanCaps();
    const capsEpoch = state.capsEpoch;
    state.snapshotRefreshPromise = computeSnapshotAsync(workspaceRoot, {
      previousManifest,
      previousFingerprint,
      maxFiles: effective.maxFiles,
      maxFileBytes: effective.maxFileBytes,
    })
      .then((snapshot) => {
        // A successful round-trip re-arms the once-per-streak failure log
        // even when the RESULT is discarded below (stale epoch) — the worker
        // itself is healthy.
        state.snapshotRefreshFailureLogged = false;
        // Stale-epoch results (caps changed mid-flight) must not repopulate
        // the cache — the epoch bump already queued a fresh-caps refresh.
        if (capsEpoch === state.capsEpoch) {
          state.lastSnapshotSource = "worker";
          commitSnapshot(snapshot);
        }
        return snapshot;
      })
      .finally(() => {
        state.snapshotRefreshPromise = null;
      });
    return state.snapshotRefreshPromise;
  };

  const refreshSnapshotInBackground = () =>
    startSnapshotRefresh().catch((error) => {
      // Worker crash fallback: keep serving the stale snapshot and log once
      // per failure streak so a broken worker cannot spam the log every tick.
      if (!state.snapshotRefreshFailureLogged) {
        state.snapshotRefreshFailureLogged = true;
        console.error(
          `[doctor] workspace snapshot refresh failed: ${error?.message || "Unknown error"}`,
        );
      }
      return state.snapshotCache?.snapshot || null;
    });

  // Status-path reader: NEVER hashes the workspace on the event loop (a big
  // workspace blocks every request for seconds, at exactly the post-restart
  // moment the UI polls hardest). Cold/stale caches kick the worker.
  const getCurrentWorkspaceSnapshot = () => {
    if (!state.snapshotCache) {
      refreshSnapshotInBackground();
      return null;
    }
    if (Date.now() - state.snapshotCache.computedAt >= kDoctorWorkspaceSnapshotTtlMs) {
      refreshSnapshotInBackground();
    }
    return state.snapshotCache.snapshot;
  };

  // Run/import-path reader: explicit doctor runs decide "reuse vs re-scan"
  // off this fingerprint, so it must be FRESH. Prefers the worker; only a
  // worker failure falls back to a sync walk, clamped to the legacy caps so
  // degraded-mode event-loop blocking is bounded to the pre-configurable
  // worst case regardless of how high the operator raised the caps.
  const getRunWorkspaceSnapshot = async () => {
    if (
      state.snapshotCache &&
      Date.now() - state.snapshotCache.computedAt < kDoctorWorkspaceSnapshotTtlMs
    ) {
      return state.snapshotCache.snapshot;
    }
    try {
      // startSnapshotRefresh may hand back an ALREADY-IN-FLIGHT job: one
      // started under previous caps (settings PUT mid-flight), or a
      // background refresh whose walk BEGAN before this run was requested —
      // a file changed after that walk passed it would be missing, and the
      // stale fingerprint could silently take the deterministic-reuse branch
      // for the very scan the user just asked for. In either case, scan once
      // more after the joined job settles (the second call starts fresh:
      // the finally clears snapshotRefreshPromise).
      const epochBefore = state.capsEpoch;
      const joinedInFlight = !!state.snapshotRefreshPromise;
      const snapshot = await startSnapshotRefresh();
      if (!joinedInFlight && epochBefore === state.capsEpoch) return snapshot;
      return await startSnapshotRefresh();
    } catch {
      const { effective } = resolveScanCaps();
      const snapshot = computeSnapshot(workspaceRoot, {
        previousManifest: state.snapshotCache?.snapshot?.manifest || null,
        maxFiles: Math.min(effective.maxFiles, kSnapshotLegacyMaxFiles),
        maxFileBytes: Math.min(effective.maxFileBytes, kSnapshotLegacyMaxFileBytes),
      });
      // Operators must be able to tell "worker dead, running legacy-clamped"
      // apart from an ordinary limited scan (status: workspaceScan.source).
      state.lastSnapshotSource = "sync-fallback";
      commitSnapshot(snapshot);
      return snapshot;
    }
  };

  // Settings changes invalidate the snapshot: bump the epoch (discards
  // in-flight old-cap results), mark the cache stale (keeps the manifest for
  // incremental hash reuse), and kick a fresh-caps refresh.
  const invalidateSnapshotCache = () => {
    state.capsEpoch += 1;
    if (state.snapshotCache) state.snapshotCache.computedAt = 0;
    state.statusCache = null;
    state.changeSummaryCache = null;
    const pending = state.snapshotRefreshPromise;
    if (pending) {
      // An old-caps job is in flight; the epoch guard discards its result —
      // queue the fresh-caps refresh behind it (startSnapshotRefresh would
      // otherwise just return the in-flight old-caps promise).
      return pending.catch(() => null).then(() => refreshSnapshotInBackground());
    }
    return refreshSnapshotInBackground();
  };

  // Coverage forensics persisted per run: the caps + stats the run's
  // snapshot was built under.
  const buildRunScanStats = (snapshot) =>
    snapshot
      ? { capsUsed: snapshot.capsUsed || null, ...(snapshot.stats || {}) }
      : null;

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

  // Sorted (path, reason, exists, skipped, truncated) tuples: catches the
  // same reason moving between files, which a bag-of-reasons diff misses.
  const hardeningFingerprint = (context) => {
    const hardening = context?.hardening || {};
    const tuples = (Array.isArray(hardening.files) ? hardening.files : [])
      .map(
        (file) =>
          `${file.path}|${file.reason || ""}|${file.exists ? 1 : 0}|` +
          `${file.skipped ? 1 : 0}|${file.truncated ? 1 : 0}`,
      )
      .sort();
    return `${hardening.state || ""}|${hardening.reason || ""}::${tuples.join(",")}`;
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
    // "When did hardening break?" must be answerable from server logs even
    // when no scan ran. Diff BEFORE the cache assignment overwrites the
    // previous context; the first compute after boot has no previous — never
    // a false "transition". A lazy TTL refresh records first OBSERVATION,
    // not the exact break moment (hence the wording).
    const previous = state.bootstrapContextCache?.context;
    if (previous && hardeningFingerprint(previous) !== hardeningFingerprint(context)) {
      // Paths originate in openclaw.json (agent-writable; not a security
      // boundary) — strip control chars so nobody can forge or split entries
      // in the very log line that serves as the forensic record.
      const sanitizeLogValue = (value) =>
        // eslint-disable-next-line no-control-regex
        String(value ?? "").replace(/[\r\n\u0000-\u001f\u2028\u2029]/g, " ");
      const describe = (ctx) => {
        const hardening = ctx?.hardening || {};
        const files = (Array.isArray(hardening.files) ? hardening.files : [])
          .map(
            (file) =>
              `${sanitizeLogValue(file.path)}: ${sanitizeLogValue(
                file.reason || (file.exists ? "ok" : "missing"),
              )}`,
          )
          .join(", ");
        return `${sanitizeLogValue(hardening.state || "unknown")}${files ? ` (${files})` : ""}`;
      };
      console.warn(
        `[doctor] hardening state change observed: ${describe(previous)} -> ${describe(context)}`,
      );
    }
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
      // Real scan numbers for the UI: configured + effective caps, plus the
      // caps/stats of the snapshot actually served (capsUsed may lag the
      // configured caps until the next refresh lands — report both).
      workspaceScan: (() => {
        const caps = resolveScanCaps();
        const snapshot = currentSnapshot || state.snapshotCache?.snapshot || null;
        return {
          configured: caps.configured,
          effective: caps.effective,
          capsUsed: snapshot?.capsUsed || null,
          stats: snapshot?.stats || null,
          // "sync-fallback" = the worker is unavailable and scans run
          // legacy-clamped — distinguishable from an ordinary limited scan.
          source: state.lastSnapshotSource,
        };
      })(),
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
      const sourcedCards = await buildFreshSourcedCards({ config: runConfig, dismissedKeys });
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
  const buildFreshSourcedCards = async ({
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
      memoryTrend: safeGatewayMemoryTrend(),
      heapAdvice: safeGatewayHeapAdvice(),
      sanitize: sanitizer.sanitize,
    });
    // Model-drift checks ride the same sourced-card pass: recomputed on
    // every run (config, catalog, and skills inputs all live outside the
    // fingerprinted-content reuse guarantees for this data).
    const modelCatalog = safeCatalog();
    const modelDriftCards = buildModelDriftCards({
      config,
      catalogModels: modelCatalog.models,
      catalogSource: modelCatalog.source,
      workspaceRoot,
      sanitize: sanitizer.sanitize,
    });
    // Rides the same sourced-card pass as the sibling checks so on-demand
    // runs, reuse runs, AND scheduled scans all re-evaluate it. Exec-free
    // probe only: never the CLI, never SecretRef provider resolution.
    const dashboardTokenCards = await buildDashboardTokenCards({
      hasConfiguredDashboardToken:
        dashboardTokenState.service?.hasConfiguredDashboardToken,
      config,
      onboarded: safeIsOnboarded(),
    });
    return filterDismissedSourcedCards(
      [
        ...bootstrapCards,
        ...deterministicCards,
        ...modelDriftCards,
        ...dashboardTokenCards,
      ],
      dismissedKeys,
    );
  };

  const safeGatewayMemoryTrend = () => {
    try {
      return typeof getGatewayMemoryTrend === "function"
        ? getGatewayMemoryTrend() || null
        : null;
    } catch {
      return null;
    }
  };
  const safeGatewayHeapAdvice = () => {
    try {
      return typeof getGatewayHeapAdvice === "function"
        ? String(getGatewayHeapAdvice() || "")
        : "";
    } catch {
      return "";
    }
  };
  // Normalized digest for the env signature: none|suspected|critical ONLY.
  // The full state enum would invalidate scan reuse on harmless transitions
  // (warming_up -> normal); suspected -> critical still re-triggers.
  const memoryTrendDigest = () => {
    const state = safeGatewayMemoryTrend()?.state;
    if (state === "critical") return "critical";
    if (state === "leak_suspected") return "suspected";
    return "none";
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
      // Inputs of the dashboard-token check (booleans only, never values):
      // deleting or fixing the token must flip envChanged so the scheduled
      // scan surfaces/clears the card without waiting on an unrelated edit.
      gatewayAuthMode: String(config?.gateway?.auth?.mode || "").trim() || null,
      dashboardTokenConfigured: (() => {
        try {
          return (
            dashboardTokenState.service?.hasConfiguredDashboardToken?.({
              config,
            }) ?? null
          );
        } catch {
          return null;
        }
      })(),
      memoryTrendState: memoryTrendDigest(),
      // Model-drift check inputs: a binding edit, a models.providers change,
      // or a catalog refresh must flip envChanged so scheduled scans
      // re-evaluate drift without waiting on a workspace-tree change
      // (openclaw.json lives OUTSIDE the fingerprinted workspace).
      modelBindings: (() => {
        try {
          return collectConfiguredModels(config);
        } catch {
          return null;
        }
      })(),
      customModelProviders: config?.models?.providers ?? null,
      modelCatalog: (() => {
        try {
          const catalog = safeCatalog();
          return {
            source: catalog.source,
            models: catalog.models.map((row) => [
              row?.key ?? null,
              row?.contextWindow ?? null,
              row?.maxTokens ?? null,
              row?.available ?? null,
            ]),
          };
        } catch {
          return null;
        }
      })(),
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
  // Busy-guard invariant: the ONE await before the activeRunPromise latch
  // (the fresh-snapshot fetch) is covered by the runStartPending latch,
  // set/cleared synchronously in a finally around it; everything after that
  // await up to the latch assignment is synchronous.
  const runDoctor = async () => {
    if (state.activeRunPromise || state.runStartPending) {
      return {
        ok: false,
        alreadyRunning: true,
        runId: state.activeRunId || 0,
        status: buildStatus(),
        error: "Doctor run already in progress",
      };
    }
    // The fresh-snapshot await happens BEFORE the activeRunPromise latch, so
    // runStartPending covers that window (set/cleared synchronously around
    // the one await; the rest of this function up to the latch assignment is
    // synchronous, preserving the original busy-guard invariant).
    state.runStartPending = true;
    let workspaceSnapshot;
    try {
      workspaceSnapshot = await getRunWorkspaceSnapshot();
    } finally {
      state.runStartPending = false;
    }
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
        scanStats: buildRunScanStats(workspaceSnapshot),
        promptVersion: kDoctorPromptVersion,
        contextProfile: activeProfile.id,
        openclawVersion: installedVersion,
        reusedFromRunId: latestCompletedRun.id,
      });
      state.activeRunId = runId;
      // NOTE: the async body below runs synchronously up to its first await
      // (the sourced-cards pass), so the latch assignment after it still
      // lands before any other event-loop turn can observe the in-flight
      // run. The latch is cleared around the await in THIS function — not in
      // a finally inside the block — where an inner finally could race the
      // latch assignment on an early-settling enrichment (a settled promise
      // latched forever).
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
          // The bridge is dispatched BEFORE the sourced-cards await (same
          // parallelism as executeDoctorRun) — the busy latch is observably
          // held from the first synchronous stretch of this block.
          let bridgePromise = null;
          if (runDoctorLintJson) {
            try {
              bridgePromise = runOpenclawDoctorBridge({
                runLintJson: runDoctorLintJson,
                sanitize: sanitizer.sanitize,
              }).catch(() => ({ ok: false, cards: [], droppedCount: 0 }));
            } catch {
              bridgePromise = null;
            }
          }
          const sourcedCards = await buildFreshSourcedCards({
            config: reuseConfig,
            dismissedKeys,
          });
          let bridgeCards = [];
          if (bridgePromise) {
            const bridgeResult = await bridgePromise;
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
          completeDoctorRun({
            id: runId,
            status: kDoctorRunStatus.completed,
            summary: kDoctorReuseSummary,
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
      scanStats: buildRunScanStats(workspaceSnapshot),
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
          // Informational (verbose): a routine scheduled scan finishing is
          // general health; new-P0 findings notify separately as important.
          { id: `doctor-auto-run-${result.runId}`, verbose: true },
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
    const sourcedCards = await buildFreshSourcedCards();
    const cards = [...sourcedCards, ...normalizedResult.cards];
    captureEvidenceSnippets(cards, workspaceRoot, redactSnippetText);
    const workspaceSnapshot = await getRunWorkspaceSnapshot();
    const runId = createDoctorRun({
      status: kDoctorRunStatus.completed,
      engine,
      workspaceRoot,
      workspaceFingerprint: workspaceSnapshot.fingerprint,
      workspaceManifest: workspaceSnapshot.manifest,
      scanStats: buildRunScanStats(workspaceSnapshot),
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
    // Validate the target against the live sendable-sessions list (parity
    // with POST /api/agent/message): an authenticated caller must not be able
    // to synthesize a key encoding an arbitrary destination.
    if (findSendableSession) {
      const foundSession = await findSendableSession(trimmedSessionKey);
      if (!foundSession) {
        const error = new Error("Selected session was not found");
        error.sessionNotFound = true;
        throw error;
      }
    } else if (!state.sessionValidationSkippedWarned) {
      // Fail-open guard: production wiring always provides the lookup — a
      // call site that forgets it silently loses the synthesized-destination
      // control, so say it loudly exactly once.
      state.sessionValidationSkippedWarned = true;
      console.warn(
        "[doctor] fix dispatch: findSendableSession not wired — session-target validation skipped",
      );
    }
    // The reply target derives server-side from the sessionKey — the client's
    // replyChannel/replyTo are advisory back-compat fields. A stale client
    // copy (cached session rows) must never decide where delivery goes.
    const derivedTarget = getReplyTargetFromSessionKey(trimmedSessionKey);
    const trimmedReplyChannel = String(replyChannel || "").trim();
    const trimmedReplyTo = String(replyTo || "").trim();
    if (
      (trimmedReplyChannel || trimmedReplyTo) &&
      (trimmedReplyChannel !== derivedTarget.replyChannel ||
        trimmedReplyTo !== derivedTarget.replyTo)
    ) {
      // Client-supplied strings: strip control chars and cap length before
      // echoing into the log (forged newlines must not fabricate log lines).
      // C0+C1 controls, DEL, and JS line separators — a forged value must
      // not fabricate log lines or smuggle terminal escapes.
      const safeLogField = (value) =>
        String(value || "-")
          .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
          .slice(0, 120);
      console.warn(
        `[doctor] fix dispatch: client reply target (${safeLogField(trimmedReplyChannel)}/${safeLogField(trimmedReplyTo)}) ` +
          `differs from server-derived (${safeLogField(derivedTarget.replyChannel)}/${safeLogField(derivedTarget.replyTo)}) — using derived`,
      );
    }
    const deliveryAttached = !!(derivedTarget.replyChannel && derivedTarget.replyTo);
    const delivery = {
      attached: deliveryAttached,
      replyChannel: derivedTarget.replyChannel,
      replyTo: derivedTarget.replyTo,
      replyAccountId: derivedTarget.replyAccountId || "",
    };
    const runId = `doctor-fix-${Number(card.id || cardId)}-${crypto.randomUUID()}`;
    const callbackToken = crypto.randomBytes(32).toString("hex");
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
      // agentId is intentionally omitted: the gateway derives the agent from
      // the agent-scoped sessionKey (resolveAgentIdFromSessionKey), and a
      // hardcoded id here would misroute non-main-agent sessions.
    };
    if (deliveryAttached) {
      gatewayParams.deliver = true;
      gatewayParams.replyChannel = derivedTarget.replyChannel;
      gatewayParams.replyTo = derivedTarget.replyTo;
      if (derivedTarget.replyAccountId) {
        gatewayParams.replyAccountId = derivedTarget.replyAccountId;
      }
    }
    // Byte budget on the FINAL payload AS THE SHELL SEES IT (route
    // pre-filters prompt CHARS, but exec's MAX_ARG_STRLEN limit is BYTES
    // after JSON escaping, UTF-8 expansion, the appended completion
    // instructions, AND shellEscapeArg's apostrophe expansion — each ' in
    // the prompt becomes 4 bytes, so JSON-length alone undercounts
    // apostrophe-heavy code prompts). Checked BEFORE the card flips to
    // working so an oversized prompt is a clean error, never an opaque
    // E2BIG after a state change.
    const escapedParams = shellEscapeArg(JSON.stringify(gatewayParams));
    if (Buffer.byteLength(escapedParams, "utf8") > kDoctorFixParamsMaxBytes) {
      const error = new Error(
        "Doctor fix prompt is too large to dispatch — shorten the instructions",
      );
      error.promptTooLarge = true;
      throw error;
    }
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
    // No else: a sessionKey without a reply target (e.g. agent:main:main) is
    // a legitimate "run in the main session" dispatch — the response's
    // `delivery.attached` tells the UI which of the two happened.
    const deliveryRecord = { ...delivery, dispatchedAt: null, gatewayOk: null };
    const recordDelivery = (patch) => {
      Object.assign(deliveryRecord, patch);
      try {
        // Conditional on fix_run_id: a stale dispatch settling after a
        // reopen + re-dispatch must not overwrite the newer record.
        setDoctorCardFixDelivery?.({ id: card.id, runId, delivery: { ...deliveryRecord } });
      } catch {
        // dispatch-record persistence is best-effort observability
      }
    };
    // Record BEFORE the gateway call so a thrown/failed dispatch leaves a
    // failure record instead of nothing.
    recordDelivery({ dispatchedAt: new Date().toISOString() });
    let result = null;
    try {
      result = await clawCmd(
        `gateway call agent --json --timeout ${kDoctorFixDispatchTimeoutMs} --params ${escapedParams}`,
        {
          quiet: true,
          timeoutMs: kDoctorFixDispatchTimeoutMs,
        },
      );
    } catch (error) {
      recordDelivery({ gatewayOk: false });
      cancelDoctorCardFix({ id: card.id, runId });
      throw error;
    }
    if (!result?.ok) {
      recordDelivery({ gatewayOk: false });
      cancelDoctorCardFix({ id: card.id, runId });
      throw new Error(result?.stderr || "Could not send Doctor fix request");
    }
    recordDelivery({ gatewayOk: true });
    console.log(
      `[doctor] fix dispatch queued: run=${runId} card=${card.id} deliveryAttached=${deliveryAttached}` +
        (deliveryAttached ? ` channel=${derivedTarget.replyChannel}` : ""),
    );
    return {
      ok: true,
      queued: true,
      runId,
      stdout: result.stdout || "",
      card: getDoctorCard(card.id) || workingCard,
      delivery,
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
    // Scan-cap settings changed: discard in-flight old-cap results and
    // re-scan under the new caps (no restart needed).
    invalidateSnapshotCache,
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
    // Late DI for the det:dashboard-token-unresolvable check (the shared
    // dashboard-url service is created during route wiring, after boot).
    registerDashboardTokenCheck,
    registerModelCatalog,
    dispose,
  };
};

module.exports = {
  buildDoctorFixCompletionInstructions,
  buildDoctorIdempotencyKey,
  buildDoctorSessionKey,
  createDoctorService,
};
