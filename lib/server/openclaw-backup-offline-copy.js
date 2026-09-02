// AlphaClaw offline copy of a QUIESCED OpenClaw state dir (issue #54).
//
// When the upstream `backup create` cannot finish while the gateway is paused
// (state-lease loss to our own traffic, a killed CLI, a rollback-journal DB
// large enough to self-block), AlphaClaw takes its own consistent copy instead
// of giving up on the hard gate. Format is AlphaClaw-owned and documented in
// docs/designs/backup-offline-copy.md: the manifest mirrors upstream's
// schemaVersion-1 core fields and adds producer/alphaclawFormatVersion/
// exclusivityEvidence/diagnosis. It never claims upstream tooling
// compatibility beyond the shared core fields — restore is the manual runbook.
//
//   createOfflineCopy(...)
//     │ assessExclusivity  stop confirmed · quiet barrier held (or disabled by
//     │                    the OPENCLAW_STATE_DB_QUIET kill switch — recorded
//     │                    as evidence, not a refusal) · 0 live openclaw
//     │                    processes · 0 in-process handles · /proc/*/fd scan
//     │                    (Linux; elsewhere evidence "partial", copy proceeds
//     │                    — sqlite's online backup() is consistent under
//     │                    concurrent access)         ─ any HARD miss → refuse
//     │ space              free ≥ 2× state bytes in backupsDir
//     ▼
//   enumerate             *.sqlite under state/ + agents/*/agent/ (+ any other
//                         *.sqlite in the walk) · non-DB assets verbatim ·
//                         workspaces inline only < kOpenclawBackupWorkspaceInlineBytes
//     ▼  (every stage: isQuiet()? else quiet_lost [not checked under the
//     ▼   disabled barrier] · deadline? else budget)
//   sqlite_backup         readOnly source, busy_timeout 30 s, sqlite.backup()
//   integrity             PRAGMA integrity_check + user_version on each copy,
//                         in a worker thread (DatabaseSync is synchronous —
//                         on the main thread a multi-GB copy would freeze
//                         /health, the SSE tick and the quiet/lease timers),
//                         bounded by the remaining budget + quiet checkpoints
//   copy_assets           openclaw.json, credentials, identity, sessions, …
//   manifest              upstream core fields + AlphaClaw fields
//   archive               tar -I 'gzip -1' (fallback: tar | gzip -1 via sh)
//   verify                gzip -t + tar -xzOf … --wildcards --no-wildcards-match-slash
//                         --occurrence=1 '*/manifest.json' (depth-1 manifest only)
//     ▼
//   <backupsDir>/openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz
//   invalid: copy after quiet_lost (aborts); a failing hard precondition never
//   produces a file; every failure is an OfflineCopyError{stage}.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sqlite = require("node:sqlite");
const { Worker } = require("node:worker_threads");
const {
  kOpenclawBackupOfflineCopyBudgetMs,
  kOpenclawBackupWorkspaceInlineBytes,
  kOpenclawBackupOfflineCopyBusyTimeoutMs,
  kOpenclawBackupReuseVerifyTimeoutMs,
  kOpenclawBackupOrphanSettleMs,
} = require("./constants");
const { parseJsonObjectFromNoisyOutput } = require("./utils/json");

const kOfflineCopyProducer = "alphaclaw-offline-copy";
const kUpstreamProducer = "openclaw";
const kOfflineCopyFormatVersion = 1;
const kManifestSchemaVersion = 1;
const kOfflineCopyArchiveSuffix = ".alphaclaw.tar.gz";
// The staging dir `<backupsDir>/<prefix><pid>-<rand>` the copy builds its
// archive root in. ONE token shared with the channel-sync sweeper that removes
// crash/SIGTERM debris — a rename on either side alone would silently stop
// the sweep from matching a full copy of the state tree.
const kOfflineCopyTempDirPrefix = ".offline-copy-";
// The integrity worker re-runs the caller's quiet checkpoint this often while
// PRAGMA integrity_check runs off-thread, so a lost barrier aborts the copy
// within a beat instead of only when the check finishes.
const kIntegrityCheckpointIntervalMs = 250;
const kSqliteDbPattern = /\.sqlite$/i;
const kSqliteSidecarPattern = /\.sqlite-(wal|shm|journal)$/i;
// AlphaClaw's own bookkeeping, logs, temp trees and the backups themselves
// are not OpenClaw state. The set applies OUTSIDE workspaces only: inside a
// workspace nothing is skipped — not node_modules, not .git — because the
// upstream backup includes workspace dirs wholesale and an offline copy that
// silently dropped part of a workspace would be a weaker restore than the
// archive it stands in for. The inline size limit (partial:true above it),
// the entry cap, and the budget checkpoint inside the walk bound the cost.
const kSkipDirNames = new Set([".alphaclaw", "logs", "tmp", "node_modules", "backups"]);
const kWorkspaceDirPattern = /^workspace(-.*)?$/;
const kTarUnsupportedOptionPattern = /unrecognized option|invalid option|unknown option|illegal option/i;
const kSpaceFactor = 2;
const kMaxWalkEntries = 200_000;
// The walk is synchronous per batch; every N entries it yields to the event
// loop and re-checks the budget/quiet barrier so a 200k-entry workspace is
// interrupted by the deadline instead of failing after the whole walk.
const kWalkCheckpointEvery = 500;
// The usable check reads the manifest back through a bounded runner tail
// (the runner's 64 KB default truncates a real per-file manifest). Producer
// and verifier share ONE ceiling: the copy refuses (stage "manifest") to
// write a manifest the verifier could not read back whole, with 1 MB of
// headroom under the tail for tool noise on the same stream. Memory: the
// verifier holds at most the tail in memory while parsing.
const kManifestTailBytes = 16 * 1024 * 1024;
const kManifestMaxBytes = kManifestTailBytes - 1024 * 1024;
// Core assets are the data a migration could lose or a restore cannot do
// without: the config file, the credential/identity stores, the state dir,
// every state database and each agent's data-plane dir. A symlink at one of
// these places would leave the archive silently lacking it, so the copy is
// recorded partial with the reason — except the config FILE itself, which
// is followed when it resolves to a regular file: a config-map-mounted or
// operator-symlinked openclaw.json is exactly the config the gateway reads
// and a small JSON document, so copying the target is safe and is what a
// restore needs. Directory symlinks are never followed (a credentials dir
// pointing elsewhere could be huge or cyclic) — the honest answer there is
// partial:true.
const kCoreAssetPathPattern =
  /^(openclaw\.json|credentials(\/.*)?|identity(\/.*)?|state(\/.*)?|agents\/[^/]+\/agent(\/.*)?)$/;
const kConfigFileName = "openclaw.json";
const isCoreAssetPath = (relPath) =>
  kCoreAssetPathPattern.test(relPath) || kSqliteDbPattern.test(relPath);

class OfflineCopyError extends Error {
  constructor(stage, message, { cause = null } = {}) {
    super(message);
    this.name = "OfflineCopyError";
    this.stage = stage;
    if (cause) this.cause = cause;
  }
}

const isOfflineCopyArchiveName = (name) =>
  String(name || "").endsWith(kOfflineCopyArchiveSuffix);

const producerOfArchiveName = (name) =>
  isOfflineCopyArchiveName(name) ? kOfflineCopyProducer : kUpstreamProducer;

const toPosix = (value) => String(value || "").split(path.sep).join("/");

// Linux-only: which OTHER processes hold any of the state DBs (or their
// sidecars) open. Returns null when /proc is unavailable — the caller records
// evidence "partial" instead of a false "clean". /proc/<pid>/fd links report
// the kernel-canonical path, so a state dir reached through a symlinked
// component (ALPHACLAW_ROOT_DIR=/srv/current → /data/alphaclaw, the same
// deployment shape gateway.js canonicalizes for) is matched under BOTH
// spellings — with only the configured spelling the scan would be a silent
// no-op and record a false "clean".
const defaultListFdHolders = ({ fsModule = fs, dbPaths = [], selfPid = process.pid } = {}) => {
  const targets = new Set();
  const addTargets = (base) => {
    targets.add(base);
    targets.add(`${base}-wal`);
    targets.add(`${base}-shm`);
    targets.add(`${base}-journal`);
  };
  const realpathSync = fsModule.realpathSync?.native || fsModule.realpathSync;
  for (const dbPath of dbPaths) {
    addTargets(dbPath);
    if (typeof realpathSync !== "function") continue;
    try {
      const real = realpathSync.call(fsModule, dbPath);
      if (real && real !== dbPath) addTargets(real);
    } catch {
      // ENOENT etc.: the configured spelling alone is still matched.
    }
  }
  let pids;
  try {
    pids = fsModule.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const holders = [];
  for (const entry of pids) {
    const pid = Number(entry);
    if (pid === selfPid) continue;
    let fds;
    try {
      fds = fsModule.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = fsModule.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const normalized = String(target).replace(/ \(deleted\)$/, "");
      if (targets.has(normalized)) holders.push({ pid, path: normalized });
    }
  }
  return holders;
};

// Every precondition, recorded whether it passed or not — the manifest carries
// the evidence so a later reader can judge how exclusive the copy really was.
const assessExclusivity = ({
  stopConfirmed,
  stopEvidence = null,
  quietToken = null,
  isQuiet = () => false,
  liveProcesses = [],
  handleCount = 0,
  dbPaths = [],
  platform = process.platform,
  fsModule = fs,
  listFdHolders = defaultListFdHolders,
}) => {
  const failures = [];
  if (stopConfirmed !== true) failures.push("gateway stop not confirmed");
  // Quiet-barrier verdicts: "held" is the normal proof; "disabled" means the
  // operator turned the barrier off with the OPENCLAW_STATE_DB_QUIET kill
  // switch (state-db-quiet returns a { disabled: true } token) — a deliberate
  // choice, recorded as evidence, NOT a refusal: the stop + live-process +
  // handle + fd checks still gate the copy. A token that is missing or has
  // expired ("lost") still refuses — that is an unexpected loss of the proof.
  let quiet = "missing";
  if (quietToken?.disabled) quiet = "disabled";
  else if (quietToken && isQuiet()) quiet = "held";
  else if (quietToken) quiet = "lost";
  if (quiet !== "held" && quiet !== "disabled") {
    failures.push(`state-db quiet barrier ${quiet}`);
  }
  const live = Array.isArray(liveProcesses) ? liveProcesses : [];
  if (live.length > 0) {
    // pid AND argv: the operator must be able to tell a foreign holder from
    // AlphaClaw's own transient CLI shell-out (`openclaw sessions list`, a
    // cron run) that happened to coincide with the sample.
    const named = live.map((p) => {
      const cmdline = String(p?.cmdline || "").trim().slice(0, 80);
      return cmdline ? `${p.pid} (${cmdline})` : String(p?.pid);
    });
    failures.push(`${live.length} live openclaw process(es): ${named.join(", ")}`);
  }
  if (handleCount !== 0) failures.push(`${handleCount} in-process state-db handle(s) open`);
  let fdScan = "unavailable";
  let fdHolders = [];
  if (platform === "linux") {
    const scanned = listFdHolders({ fsModule, dbPaths });
    if (scanned === null) {
      fdScan = "unavailable";
    } else {
      fdHolders = scanned;
      fdScan = scanned.length > 0 ? "holders" : "clean";
    }
  }
  if (fdScan === "holders") {
    failures.push(
      `other process(es) hold a state db open: ${fdHolders
        .map((h) => `pid ${h.pid} (${path.basename(h.path)})`)
        .join(", ")}`,
    );
  }
  return {
    ok: failures.length === 0,
    failures,
    evidence: {
      stopConfirmed: stopConfirmed === true,
      stopEvidence: stopEvidence ?? null,
      quiet,
      quietOwner: quietToken?.owner ?? null,
      liveProcesses: live.length,
      handleCount,
      fdScan,
      fdHolders: fdHolders.slice(0, 12),
      // "partial" is the honest label when the fd scan could not run.
      completeness: fdScan === "clean" ? "full" : "partial",
      platform,
    },
  };
};

// The walk is a generator: it yields every kWalkCheckpointEvery entries so
// the async driver can re-check the budget and hand the event loop a turn,
// while the sync export (tests, callers with no budget) simply drains it.
function* walkStateTreeSteps({ stateDir, fsModule, checkpointEvery = kWalkCheckpointEvery }) {
  const dbs = [];
  const files = [];
  const skipped = [];
  const workspaces = new Map();
  let entriesSeen = 0;
  function* visit(dir, rel, workspaceRoot) {
    let entries;
    try {
      entries = fsModule.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new OfflineCopyError("enumerate", `cannot read ${dir}: ${error.message}`, {
        cause: error,
      });
    }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > kMaxWalkEntries) {
        throw new OfflineCopyError(
          "enumerate",
          `state tree exceeds ${kMaxWalkEntries} entries — refusing an unbounded copy`,
        );
      }
      if (entriesSeen % checkpointEvery === 0) yield entriesSeen;
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (!workspaceRoot && relPath === kConfigFileName) {
          let target = null;
          try {
            target = fsModule.statSync(full);
          } catch {}
          if (target?.isFile()) {
            files.push({ sourcePath: full, archivePath: relPath, bytes: target.size, viaSymlink: true });
            continue;
          }
          skipped.push({
            kind: "symlink",
            sourcePath: full,
            reason: "config symlink does not resolve to a regular file",
            core: true,
          });
          continue;
        }
        const core = !workspaceRoot && isCoreAssetPath(relPath);
        skipped.push({
          kind: "symlink",
          sourcePath: full,
          reason: core ? "core asset is a symlink (not followed)" : "symlink not followed",
          ...(core ? { core: true } : {}),
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (!workspaceRoot && kSkipDirNames.has(entry.name)) {
          skipped.push({ kind: "dir", sourcePath: full, reason: "not OpenClaw state" });
          continue;
        }
        const nextWorkspace =
          workspaceRoot || (kWorkspaceDirPattern.test(entry.name) ? full : null);
        if (nextWorkspace && !workspaces.has(nextWorkspace)) {
          workspaces.set(nextWorkspace, { bytes: 0, files: [] });
        }
        yield* visit(full, relPath, nextWorkspace);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ kind: "special", sourcePath: full, reason: "not a regular file" });
        continue;
      }
      let size = 0;
      try {
        size = fsModule.statSync(full).size;
      } catch (error) {
        throw new OfflineCopyError("enumerate", `cannot stat ${full}: ${error.message}`, {
          cause: error,
        });
      }
      if (workspaceRoot) {
        const ws = workspaces.get(workspaceRoot);
        ws.bytes += size;
        ws.files.push({ sourcePath: full, archivePath: relPath, bytes: size });
        continue;
      }
      if (kSqliteSidecarPattern.test(entry.name)) {
        skipped.push({
          kind: "sqlite-sidecar",
          sourcePath: full,
          reason: "covered by the online sqlite copy",
          coveredBy: full.replace(kSqliteSidecarPattern, ".sqlite"),
        });
        continue;
      }
      if (kSqliteDbPattern.test(entry.name)) {
        dbs.push({ sourcePath: full, archivePath: relPath, bytes: size });
        continue;
      }
      files.push({ sourcePath: full, archivePath: relPath, bytes: size });
    }
  }
  yield* visit(stateDir, "", null);
  return { dbs, files, skipped, workspaces };
}

const walkStateTree = (options) => {
  const steps = walkStateTreeSteps(options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// Budgeted walk: `checkpoint(stage)` runs between batches (it throws the
// OfflineCopyError that aborts the copy) and the event loop gets a turn, so
// timers — the quiet barrier's expiry, the lifecycle lease — keep firing
// while a huge tree is enumerated with the gateway stopped.
const walkStateTreeAsync = async ({ checkpoint = () => {}, ...options }) => {
  const steps = walkStateTreeSteps(options);
  let step = steps.next();
  while (!step.done) {
    checkpoint("enumerate");
    await yieldToEventLoop();
    step = steps.next();
  }
  return step.value;
};

const agentRootsOf = ({ stateDir, fsModule }) => {
  const agentsDir = path.join(stateDir, "agents");
  try {
    return fsModule
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ agentId: entry.name, sourcePath: path.join(agentsDir, entry.name) }));
  } catch {
    return [];
  }
};

// node:sqlite's backup() has no cancel API, so the copy is bounded from the
// outside: a deadline timer rejects on time (stage "budget") and the
// `progress` hook — invoked between backup steps — runs the caller's
// checkpoint so a lost quiet barrier surfaces before the deadline does.
// An aborted backup is an ORPHAN: closing the source underneath it does NOT
// stop it (sqlite3_close_v2 zombifies the connection until the backup
// releases it — verified on Node 22.23, a backup whose source closed at step
// 3 ran to completion), and it may hold a read transaction on the state DB
// and an fd on its destination while the caller releases the quiet barrier
// and relaunches the gateway. So the abort path (1) closes the source at
// once, (2) unlinks the destination temp (the orphan's later writes go to an
// unlinked inode), (3) waits a short bound for the orphan to settle so the
// barrier is not released over a still-stepping backup silently, and (4)
// past the bound marks the thrown error `orphanedBackup: true` — the driver
// records that in the failure evidence. Nothing here can make the orphan
// stop; it can only be named.
const copyDatabase = async ({
  sqliteModule,
  source,
  destination,
  busyTimeoutMs,
  fsModule,
  checkpoint = () => {},
  remainingMs = () => Infinity,
  orphanSettleMs = kOpenclawBackupOrphanSettleMs,
}) => {
  fsModule.mkdirSync(path.dirname(destination), { recursive: true });
  let src = null;
  let run = null;
  let runSettled = false;
  const unlinkDestination = () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        fsModule.rmSync(`${destination}${suffix}`, { force: true });
      } catch {}
    }
  };
  try {
    src = new sqliteModule.DatabaseSync(source, { readOnly: true });
    src.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const settle = (finish) => (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        finish(value);
      };
      const budget = remainingMs();
      if (Number.isFinite(budget)) {
        timer = setTimeout(
          () =>
            settle(reject)(
              new OfflineCopyError(
                "budget",
                `offline-copy budget exhausted during sqlite_backup of ${path.basename(source)} — the online copy did not finish in time`,
              ),
            ),
          Math.max(1, budget),
        );
        timer.unref?.();
      }
      const progress = () => {
        try {
          checkpoint("sqlite_backup");
        } catch (error) {
          settle(reject)(error);
        }
      };
      try {
        run = Promise.resolve(sqliteModule.backup(src, destination, { progress }));
      } catch (error) {
        settle(reject)(error);
        return;
      }
      run.then(
        (value) => {
          runSettled = true;
          settle(resolve)(value);
        },
        (error) => {
          runSettled = true;
          settle(reject)(error);
        },
      );
    });
  } catch (error) {
    if (run && !runSettled) {
      // Abort with the backup still stepping: close the source first (the
      // documented contract, even though it does not stop the orphan), drop
      // the destination, then give the orphan the bound to settle.
      try {
        src?.close();
      } catch {}
      src = null;
      unlinkDestination();
      const settledInTime = await new Promise((resolve) => {
        const bound = setTimeout(() => resolve(false), Math.max(1, orphanSettleMs));
        bound.unref?.();
        run.then(
          () => {
            clearTimeout(bound);
            resolve(true);
          },
          () => {
            clearTimeout(bound);
            resolve(true);
          },
        );
      });
      if (!settledInTime) error.orphanedBackup = true;
    }
    if (error instanceof OfflineCopyError) throw error;
    const wrapped = new OfflineCopyError(
      "sqlite_backup",
      `online copy of ${path.basename(source)} failed: ${error.message}`,
      { cause: error },
    );
    if (error?.orphanedBackup === true) wrapped.orphanedBackup = true;
    throw wrapped;
  } finally {
    try {
      src?.close();
    } catch {}
  }
};

// One verdict shape for both integrity paths (worker and in-process).
const integrityVerdict = ({ copyPath, verdict, userVersion }) => {
  const text = String(verdict ?? "");
  if (text !== "ok") {
    throw new OfflineCopyError(
      "integrity",
      `integrity_check on ${path.basename(copyPath)}: ${text.slice(0, 200) || "no verdict"}`,
    );
  }
  return { integrity: "ok", userVersion: Number(userVersion ?? 0) };
};

// In-process integrity check — SYNCHRONOUS on the calling thread. Kept only
// for callers that inject a fake `sqliteModule` (the unit tests' stage/verdict
// pins): a fake cannot cross into a worker. Production never takes this path.
const checkIntegritySync = ({ sqliteModule, copyPath }) => {
  let db = null;
  try {
    db = new sqliteModule.DatabaseSync(copyPath, { readOnly: true });
    const verdict = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const userVersion = db.prepare("PRAGMA user_version").get()?.user_version;
    return integrityVerdict({ copyPath, verdict, userVersion });
  } catch (error) {
    if (error instanceof OfflineCopyError) throw error;
    throw new OfflineCopyError(
      "integrity",
      `integrity_check on ${path.basename(copyPath)} could not run: ${error.message}`,
      { cause: error },
    );
  } finally {
    try {
      db?.close();
    } catch {}
  }
};

// The worker body: open the COPY read-only, run integrity_check +
// user_version, post the raw values. Evaluated with `eval: true` so the module
// stays one file (no script path to resolve from a packed install).
const kIntegrityWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db = null;
try {
  db = new DatabaseSync(workerData.copyPath, { readOnly: true });
  const verdict = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const userVersion = db.prepare("PRAGMA user_version").get()?.user_version;
  parentPort.postMessage({ ok: true, verdict: verdict == null ? null : String(verdict), userVersion: Number(userVersion ?? 0) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
} finally {
  try { db?.close(); } catch {}
}
`;
const defaultSpawnIntegrityWorker = ({ copyPath }) =>
  new Worker(kIntegrityWorkerSource, { eval: true, workerData: { copyPath } });

// PRAGMA integrity_check reads every page of the copy plus the index
// cross-checks: seconds per GB from page cache, minutes on the slow/network
// volumes this path is dispatched for (rollback-journal > 256 MiB on
// cifs/smb/virtiofs/9p/nfs). DatabaseSync is synchronous, so on the main
// thread that is a full event-loop stall — /health, the 2 s SSE tick, the
// quiet barrier's expiry and the lifecycle lease all stop firing with the
// gateway stopped. The check therefore runs in a worker thread, bounded the
// same way copyDatabase bounds backup(): the remaining budget rejects with
// stage "budget", and the caller's checkpoint is re-run on an interval so a
// lost quiet barrier aborts the copy while the check is still running. The
// worker is terminated on either; a worker that dies or exits without a
// verdict is an integrity failure ("could not run"), never a pass.
// `spawnWorker === null` selects the in-process path (injected fakes only).
const checkIntegrity = async ({
  sqliteModule,
  copyPath,
  checkpoint = () => {},
  remainingMs = () => Infinity,
  spawnWorker = defaultSpawnIntegrityWorker,
}) => {
  if (!spawnWorker) return checkIntegritySync({ sqliteModule, copyPath });
  const name = path.basename(copyPath);
  let worker;
  try {
    worker = spawnWorker({ copyPath });
  } catch (error) {
    throw new OfflineCopyError(
      "integrity",
      `integrity_check on ${name} could not run: worker failed to start: ${error.message}`,
      { cause: error },
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer = null;
    let checkpointTimer = null;
    const settle = (finish) => (value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (checkpointTimer) clearInterval(checkpointTimer);
      finish(value);
    };
    const abort = (error) => {
      // terminate() is async; its settlement is irrelevant once we have a
      // verdict (or gave up), and a rejection here must never be unhandled.
      Promise.resolve()
        .then(() => worker.terminate())
        .catch(() => {});
      settle(reject)(error);
    };
    const budget = remainingMs();
    if (Number.isFinite(budget)) {
      deadlineTimer = setTimeout(
        () =>
          abort(
            new OfflineCopyError(
              "budget",
              `offline-copy budget exhausted during integrity of ${name} — integrity_check did not finish in time`,
            ),
          ),
        Math.max(1, budget),
      );
      deadlineTimer.unref?.();
    }
    checkpointTimer = setInterval(() => {
      try {
        checkpoint("integrity");
      } catch (error) {
        abort(error);
      }
    }, kIntegrityCheckpointIntervalMs);
    checkpointTimer.unref?.();
    worker.on("message", (message) => {
      if (message?.ok) {
        try {
          settle(resolve)(
            integrityVerdict({ copyPath, verdict: message.verdict, userVersion: message.userVersion }),
          );
        } catch (error) {
          settle(reject)(error);
        }
        return;
      }
      settle(reject)(
        new OfflineCopyError(
          "integrity",
          `integrity_check on ${name} could not run: ${String(message?.error || "worker reported no verdict")}`,
        ),
      );
    });
    worker.on("error", (error) => {
      settle(reject)(
        new OfflineCopyError(
          "integrity",
          `integrity_check on ${name} could not run: ${error?.message || String(error)}`,
          { cause: error },
        ),
      );
    });
    worker.on("exit", (code) => {
      settle(reject)(
        new OfflineCopyError(
          "integrity",
          `integrity_check on ${name} could not run: worker exited (${code}) without a verdict`,
        ),
      );
    });
  });
};

const runOrThrow = async (runCommand, stage, spec) => {
  let result;
  try {
    result = await runCommand(spec);
  } catch (error) {
    throw new OfflineCopyError(stage, `${spec.command} could not run: ${error.message}`, {
      cause: error,
    });
  }
  return result;
};

const describeFailure = (result) =>
  result?.timedOut
    ? "timed out"
    : result?.error
      ? String(result.error)
      : String(result?.tail || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .pop() || `exit ${result?.code ?? "?"}`;

// `tar -I 'gzip -1'` is GNU tar; a busybox/bsd tar answers "unrecognized
// option" and the shell pipeline takes over. Both spawn without a shell for
// the primary path; only the fallback needs `sh -c` for the pipe.
const writeArchive = async ({ runCommand, tempDir, rootName, tmpOut, timeoutMs }) => {
  const primary = await runOrThrow(runCommand, "archive", {
    command: "tar",
    args: ["-I", "gzip -1", "-cf", tmpOut, "-C", tempDir, rootName],
    timeoutMs,
  });
  if (primary.ok) return { method: "tar -I gzip -1" };
  if (!kTarUnsupportedOptionPattern.test(String(primary.tail || "")) || primary.timedOut) {
    throw new OfflineCopyError("archive", `tar failed: ${describeFailure(primary)}`);
  }
  const fallback = await runOrThrow(runCommand, "archive", {
    command: "sh",
    args: ["-c", 'tar -cf - -C "$1" "$2" | gzip -1 > "$3"', "sh", tempDir, rootName, tmpOut],
    timeoutMs,
  });
  if (!fallback.ok) {
    throw new OfflineCopyError("archive", `tar | gzip failed: ${describeFailure(fallback)}`);
  }
  return { method: "tar | gzip -1" };
};

// WI-6.1 "usable" check, shared by every verified artifact (upstream or
// offline copy) and by the consented-reuse gate: the archive must pass
// `gzip -t`, its manifest must extract and parse, and the manifest must COVER
// the state databases this box has. Never throws — a failing check is a
// { ok:false, stage, reason } the caller treats as a verify failure.
//
// Coverage, not listing: the real upstream manifests (verified against the
// 2026.7.1-2 pin and 2026.9.1-beta.1) carry ONE directory-level asset
//   { kind:"state", sourcePath:<stateDir>, archivePath:<root>/payload/posix<stateDir> }
// and the database files appear only as tar entries beneath it, while the
// offline copy lists each database as its own asset. A required database is
// therefore covered when an asset names it (archivePath/sourcePath suffix) OR
// an asset's sourcePath is an ancestor directory of it, resolved against
// manifest.paths.stateDir (falling back to the caller's stateDir).
// A per-file offline-copy manifest for a busy install runs to megabytes; the
// tail is kManifestTailBytes and the producer refuses to exceed
// kManifestMaxBytes, so a verified copy always reads back whole.

const isPathWithin = (candidate, ancestor) =>
  candidate === ancestor || candidate.startsWith(`${ancestor.replace(/\/+$/, "")}/`);

const assetCoversRequired = ({ asset, required, rootDir }) => {
  const archivePath = toPosix(asset?.archivePath || "");
  const sourcePath = toPosix(asset?.sourcePath || "");
  const suffix = toPosix(required);
  for (const candidate of [archivePath, sourcePath]) {
    if (candidate && (candidate === suffix || candidate.endsWith(`/${suffix}`))) return true;
  }
  if (!rootDir || !sourcePath) return false;
  const absolute = suffix.startsWith("/") ? suffix : `${rootDir.replace(/\/+$/, "")}/${suffix}`;
  return isPathWithin(absolute, sourcePath);
};

const verifyArchiveManifest = async ({
  file,
  runCommand,
  requiredArchivePaths = [],
  stateDir = null,
  timeoutMs = kOpenclawBackupReuseVerifyTimeoutMs,
  nowFn = Date.now,
}) => {
  const startedAt = nowFn();
  const remaining = () => Math.max(1, timeoutMs - (nowFn() - startedAt));
  let gzip;
  try {
    gzip = await runCommand({ command: "gzip", args: ["-t", file], timeoutMs: remaining() });
  } catch (error) {
    return { ok: false, stage: "gzip", reason: `gzip could not run: ${error.message}` };
  }
  if (!gzip?.ok) {
    return { ok: false, stage: "gzip", reason: `gzip -t: ${describeFailure(gzip)}` };
  }
  let extracted;
  try {
    // Exactly the depth-1 manifest: GNU tar's `*` spans `/`, so a bare
    // `*/manifest.json` would also match a workspace's own manifest.json
    // (Chrome extensions, PWAs, npm packages) and --occurrence=1 would then
    // hand back the WRONG file first. --no-wildcards-match-slash pins the
    // match to <archiveRoot>/manifest.json; --occurrence=1 stops the scan
    // there instead of decompressing a multi-GB payload it will discard. The
    // runner's default 64 KB tail truncates a real manifest, so the spec asks
    // for a tail large enough to hold any plausible one.
    extracted = await runCommand({
      command: "tar",
      args: [
        "-xzOf",
        file,
        "--wildcards",
        "--no-wildcards-match-slash",
        "--occurrence=1",
        "*/manifest.json",
      ],
      tailBytes: kManifestTailBytes,
      timeoutMs: remaining(),
    });
  } catch (error) {
    return { ok: false, stage: "manifest", reason: `tar could not run: ${error.message}` };
  }
  if (!extracted?.ok) {
    return {
      ok: false,
      stage: "manifest",
      reason: `manifest.json not extractable: ${describeFailure(extracted)}`,
    };
  }
  const manifest = parseJsonObjectFromNoisyOutput(String(extracted.tail || ""));
  if (
    !manifest ||
    typeof manifest.schemaVersion !== "number" ||
    !Array.isArray(manifest.assets)
  ) {
    return {
      ok: false,
      stage: "parse",
      reason: "manifest.json is not a JSON object with a numeric schemaVersion and assets[]",
    };
  }
  const rootDir = toPosix(
    (manifest.paths && typeof manifest.paths.stateDir === "string" && manifest.paths.stateDir) ||
      stateDir ||
      "",
  );
  const missing = requiredArchivePaths.filter(
    (required) =>
      !manifest.assets.some((asset) => assetCoversRequired({ asset, required, rootDir })),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      stage: "assets",
      reason: `manifest covers no ${missing.join(", ")}`,
      manifest,
    };
  }
  return { ok: true, manifest, producer: manifest.producer || kUpstreamProducer };
};

const createOfflineCopy = async ({
  stateDir,
  backupsDir,
  outputFile,
  exclusivity,
  isQuiet,
  runCommand,
  diagnosis = null,
  runtimeVersion = null,
  budgetMs = kOpenclawBackupOfflineCopyBudgetMs,
  workspaceInlineBytes = kOpenclawBackupWorkspaceInlineBytes,
  busyTimeoutMs = kOpenclawBackupOfflineCopyBusyTimeoutMs,
  // How long an aborted sqlite backup() gets to settle before the failure is
  // returned with `orphanedBackup: true` (see copyDatabase).
  orphanSettleMs = kOpenclawBackupOrphanSettleMs,
  manifestMaxBytes = kManifestMaxBytes,
  fsModule = fs,
  sqliteModule = sqlite,
  // undefined = decide from sqliteModule: the real module runs the integrity
  // check in a worker thread; an injected fake stays in-process (it cannot
  // cross a thread boundary). null forces in-process; a function is the seam
  // the hang/budget tests inject.
  spawnIntegrityWorker = undefined,
  nowFn = Date.now,
  platform = process.platform,
  listFdHolders = defaultListFdHolders,
  log = () => {},
}) => {
  if (typeof runCommand !== "function") {
    throw new TypeError("createOfflineCopy: runCommand is required");
  }
  if (typeof isQuiet !== "function") {
    throw new TypeError("createOfflineCopy: isQuiet is required");
  }
  const startedAt = nowFn();
  const deadline = startedAt + budgetMs;
  const integrityWorker =
    spawnIntegrityWorker === undefined
      ? sqliteModule === sqlite
        ? defaultSpawnIntegrityWorker
        : null
      : spawnIntegrityWorker;
  // Same decision as assessExclusivity: a kill-switch-disabled barrier never
  // "ends", so the per-stage quiet check is not a precondition under it —
  // otherwise the disabled verdict above would be accepted and the very first
  // stage would abort with quiet_lost.
  const quietBarrierDisabled = exclusivity?.quietToken?.disabled === true;
  const checkpoint = (stage) => {
    if (!quietBarrierDisabled && !isQuiet()) {
      throw new OfflineCopyError("quiet_lost", `state-db quiet period ended during ${stage}`);
    }
    if (nowFn() > deadline) {
      throw new OfflineCopyError("budget", `offline-copy budget (${Math.round(budgetMs / 1000)} s) exhausted during ${stage}`);
    }
  };

  const tree = await walkStateTreeAsync({ stateDir, fsModule, checkpoint });
  const dbPaths = tree.dbs.map((db) => db.sourcePath);
  const exclusivityReport = assessExclusivity({
    ...(exclusivity || {}),
    isQuiet,
    dbPaths,
    platform,
    fsModule,
    listFdHolders,
  });
  if (!exclusivityReport.ok) {
    throw new OfflineCopyError(
      "exclusivity",
      `state dir is not exclusively ours: ${exclusivityReport.failures.join("; ")}`,
    );
  }

  const workspaceBytes = [...tree.workspaces.values()].reduce((sum, ws) => sum + ws.bytes, 0);
  const includeWorkspace = workspaceBytes > 0 && workspaceBytes <= workspaceInlineBytes;
  const stateBytes =
    tree.dbs.reduce((sum, db) => sum + db.bytes, 0) +
    tree.files.reduce((sum, file) => sum + file.bytes, 0) +
    (includeWorkspace ? workspaceBytes : 0);
  try {
    const stats = fsModule.statfsSync(backupsDir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(free) && free < stateBytes * kSpaceFactor) {
      throw new OfflineCopyError(
        "space",
        `${Math.round(free / 1e6)} MB free in ${backupsDir}, ~${Math.round((stateBytes * kSpaceFactor) / 1e6)} MB needed`,
      );
    }
  } catch (error) {
    if (error instanceof OfflineCopyError) throw error;
  }

  const rootName = path.basename(outputFile).replace(/\.alphaclaw\.tar\.gz$|\.tar\.gz$/, "");
  const tempDir = path.join(
    backupsDir,
    `${kOfflineCopyTempDirPrefix}${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const archiveRoot = path.join(tempDir, rootName);
  const tmpOut = `${outputFile}.${crypto.randomUUID()}.tmp`;
  const assets = [];
  const skipped = [...tree.skipped];
  const databases = [];
  const removeTree = async (target) => {
    try {
      await (fsModule.promises || fs.promises).rm(target, { recursive: true, force: true });
    } catch {}
  };
  try {
    fsModule.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    for (const db of tree.dbs) {
      checkpoint("sqlite_backup");
      const destination = path.join(archiveRoot, db.archivePath);
      await copyDatabase({
        sqliteModule,
        source: db.sourcePath,
        destination,
        busyTimeoutMs,
        fsModule,
        checkpoint,
        remainingMs: () => deadline - nowFn(),
        orphanSettleMs,
      });
      checkpoint("integrity");
      const check = await checkIntegrity({
        sqliteModule,
        copyPath: destination,
        checkpoint,
        remainingMs: () => deadline - nowFn(),
        spawnWorker: integrityWorker,
      });
      // The copy inherits the source's WAL header, so even the read-only
      // integrity open leaves empty -wal/-shm sidecars beside it. They carry
      // nothing (the online copy is self-contained) and must not be archived.
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try {
          fsModule.rmSync(`${destination}${suffix}`, { force: true });
        } catch {}
      }
      let bytes = db.bytes;
      try {
        bytes = fsModule.statSync(destination).size;
      } catch {}
      databases.push({ path: db.sourcePath, bytes, ...check });
      assets.push({ kind: "sqlite", sourcePath: db.sourcePath, archivePath: db.archivePath });
    }
    const configPath = path.join(stateDir, kConfigFileName);
    const copyFile = async (file, kind) => {
      const destination = path.join(archiveRoot, file.archivePath);
      fsModule.mkdirSync(path.dirname(destination), { recursive: true });
      try {
        await (fsModule.promises || fs.promises).copyFile(file.sourcePath, destination);
      } catch (error) {
        throw new OfflineCopyError(
          "copy_assets",
          `copy of ${file.archivePath} failed: ${error.message}`,
          { cause: error },
        );
      }
      assets.push({ kind, sourcePath: file.sourcePath, archivePath: file.archivePath });
    };
    for (const file of tree.files) {
      checkpoint("copy_assets");
      await copyFile(file, file.sourcePath === configPath ? "config" : "file");
    }
    // Every reason the archive is less than the whole state dir — the
    // record's `partial` flag derives from this list, never from the
    // workspace decision alone, so a skipped core asset can never hide
    // behind a "fully verified" copy.
    const partialReasons = [];
    const workspaceExcludedReason = `workspace files excluded (${Math.round(workspaceBytes / 1e6)} MB > ${Math.round(workspaceInlineBytes / 1e6)} MB inline limit)`;
    for (const [workspaceDir, ws] of tree.workspaces) {
      if (!includeWorkspace) {
        skipped.push({ kind: "workspace", sourcePath: workspaceDir, reason: workspaceExcludedReason });
        continue;
      }
      for (const file of ws.files) {
        checkpoint("copy_assets");
        await copyFile(file, "workspace");
      }
    }
    if (!includeWorkspace && workspaceBytes > 0) partialReasons.push(workspaceExcludedReason);
    for (const entry of skipped) {
      if (entry.core) {
        partialReasons.push(`${toPosix(path.relative(stateDir, entry.sourcePath))}: ${entry.reason}`);
      }
    }
    checkpoint("manifest");
    // paths.* describe what is IN the archive, not what exists on disk: a
    // config that was skipped (symlink to a non-file) is null here even
    // though existsSync(configPath) would say yes; a credentials dir that is
    // a symlink was not walked and is null too.
    const credentialsDir = path.join(stateDir, "credentials");
    const configAsset = assets.find((asset) => asset.kind === "config") || null;
    let credentialsWalked = false;
    try {
      credentialsWalked = fsModule.lstatSync(credentialsDir).isDirectory();
    } catch {}
    const manifest = {
      schemaVersion: kManifestSchemaVersion,
      createdAt: new Date(nowFn()).toISOString(),
      archiveRoot: rootName,
      runtimeVersion,
      platform,
      nodeVersion: process.version,
      options: { includeWorkspace, onlyConfig: false },
      paths: {
        stateDir,
        configPath: configAsset ? configAsset.sourcePath : null,
        oauthDir: credentialsWalked ? credentialsDir : null,
        workspaceDirs: [...tree.workspaces.keys()],
        agentRoots: agentRootsOf({ stateDir, fsModule }),
      },
      assets,
      skipped,
      partialReasons,
      producer: kOfflineCopyProducer,
      alphaclawFormatVersion: kOfflineCopyFormatVersion,
      exclusivityEvidence: exclusivityReport.evidence,
      diagnosis,
    };
    const manifestJson = `${JSON.stringify(manifest)}\n`;
    const manifestBytes = Buffer.byteLength(manifestJson);
    if (manifestBytes > manifestMaxBytes) {
      throw new OfflineCopyError(
        "manifest",
        `manifest is ${Math.round(manifestBytes / 1e6)} MB (${assets.length} assets) — over the ${Math.round(manifestMaxBytes / 1e6)} MB the usable check can read back; too many files for one offline copy`,
      );
    }
    try {
      fsModule.writeFileSync(path.join(archiveRoot, "manifest.json"), manifestJson);
    } catch (error) {
      throw new OfflineCopyError("manifest", `manifest write failed: ${error.message}`, {
        cause: error,
      });
    }
    checkpoint("archive");
    const archiveTimeout = Math.max(1, deadline - nowFn());
    const { method } = await writeArchive({
      runCommand,
      tempDir,
      rootName,
      tmpOut,
      timeoutMs: archiveTimeout,
    });
    checkpoint("verify");
    const verified = await verifyArchiveManifest({
      file: tmpOut,
      runCommand,
      requiredArchivePaths: tree.dbs.map((db) => db.archivePath),
      timeoutMs: Math.max(1, deadline - nowFn()),
      nowFn,
    });
    if (!verified.ok) {
      throw new OfflineCopyError("verify", verified.reason);
    }
    if (verified.manifest.producer !== kOfflineCopyProducer) {
      throw new OfflineCopyError("verify", "extracted manifest is not an AlphaClaw offline copy");
    }
    let bytes = 0;
    try {
      bytes = fsModule.statSync(tmpOut).size;
    } catch {}
    if (!(bytes > 0)) throw new OfflineCopyError("verify", "archive is empty");
    // tar created the file under the umask (0644 with the usual 022) and it
    // carries credentials; tighten it BEFORE it becomes visible under the
    // final name. Best-effort: a filesystem that refuses chmod (cifs, some
    // bind mounts) still gets its backup, inside the 0700 backups dir.
    try {
      fsModule.chmodSync(tmpOut, 0o600);
    } catch (error) {
      log(`offline copy: chmod 0600 on the archive failed (${error.message}) — it keeps the filesystem's default mode`);
    }
    fsModule.renameSync(tmpOut, outputFile);
    const durationMs = nowFn() - startedAt;
    log(
      `offline copy: ${databases.length} db(s), ${assets.length} asset(s), ${Math.round(bytes / 1e6)} MB via ${method} in ${Math.round(durationMs / 1000)} s`,
    );
    return {
      ok: true,
      file: outputFile,
      bytes,
      durationMs,
      partial: partialReasons.length > 0,
      partialReasons,
      manifest,
      databases,
      exclusivityEvidence: exclusivityReport.evidence,
      method,
    };
  } catch (error) {
    await removeTree(tmpOut);
    if (error instanceof OfflineCopyError) throw error;
    throw new OfflineCopyError("archive", error.message, { cause: error });
  } finally {
    await removeTree(tempDir);
  }
};

module.exports = {
  kOfflineCopyProducer,
  kUpstreamProducer,
  kOfflineCopyFormatVersion,
  kOfflineCopyArchiveSuffix,
  kOfflineCopyTempDirPrefix,
  kIntegrityCheckpointIntervalMs,
  kManifestTailBytes,
  kManifestMaxBytes,
  kWalkCheckpointEvery,
  OfflineCopyError,
  isOfflineCopyArchiveName,
  producerOfArchiveName,
  assessExclusivity,
  defaultListFdHolders,
  defaultSpawnIntegrityWorker,
  checkIntegrity,
  walkStateTree,
  walkStateTreeAsync,
  verifyArchiveManifest,
  createOfflineCopy,
};
