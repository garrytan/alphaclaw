// AlphaClaw-owned archives of quiesced OpenClaw state (#54, #79, #99).
// Full copies use the bounded streaming walker; migration-minimal copies use
// the independent owner inventory, excluding scratch without traversing it.
// Both require exclusivity, online SQLite snapshots and off-thread integrity
// checks, private staging, format-3 per-file/payload verification and atomic
// publication. Lease/quiet/budget checkpoints run through publication.
// Formats 1 and 2 and upstream directory manifests remain readable under
// their original contracts. Restore: docs/designs/backup-offline-copy.md.
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
const { verifyFormat3Payload, safeRelative } = require("./openclaw-backup-verification");

const kOfflineCopyProducer = "alphaclaw-offline-copy";
const kUpstreamProducer = "openclaw";
// Format 3 adds profiles, required per-file inventory and snapshot times.
// Format 2 added excludes and coverage; a reader accepts
// every version listed here and refuses the rest at the usable check (an
// archive from a NEWER AlphaClaw may follow a restore contract this one does
// not know — honest "cannot judge" beats a false "usable").
const kOfflineCopyFormatVersion = 3;
const kOfflineCopyReadableFormatVersions = Object.freeze([1, 2, 3]);
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
const kTarUnsupportedOptionPattern = /unrecognized option|invalid option|unknown option|illegal option/i;
const kSpaceFactor = 2;
// The usable check reads the manifest back through a bounded runner tail
// (the runner's 64 KB default truncates a real per-file manifest). Producer
// and verifier share ONE ceiling: the copy refuses (stage "manifest") to
// write a manifest the verifier could not read back whole, with 1 MB of
// headroom under the tail for tool noise on the same stream. Memory: the
// verifier holds at most the tail in memory while parsing.
const kManifestTailBytes = 32 * 1024 * 1024;
const kManifestMaxBytes = kManifestTailBytes - 1024 * 1024;

const { kOfflineCopyPolicyExcludes, kOfflineCopyExcludeMaxPatterns, kCoreAssetProbePaths, isCoreAssetPath, compileExcludePattern, resolveExcludes, resolveBackupPolicy, boundBackupRefusals } = require("./openclaw-backup-policy");
const { OfflineCopyError } = require("./openclaw-backup-errors");

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
    // v0.9.81: the matcher only fires on an OpenClaw executable or entry
    // script in the PROGRAM position (never a path argument such as a log
    // follower's `tail -F /tmp/openclaw/openclaw.log`) — say so, so a real
    // holder is distinguishable from noise in the run record.
    failures.push(
      `${live.length} live openclaw process(es): ${named.join(", ")} — argv names an OpenClaw executable or entry script`,
    );
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
// `excludes` (undefined → kOfflineCopyPolicyExcludes) applies INSIDE
// workspaces only; the result carries `excludes[{pattern, files, bytes}]`
// (one row per applied pattern, zero-match rows included so the manifest
// shows the policy that was in force) and `refusedExcludes[{pattern,
// reason}]`. Each workspace entry carries its post-exclude `bytes`/`files`
// plus `excludedBytes`/`excludedFiles`.
const { walkStateTree, walkStateTreeAsync, kWalkCheckpointEvery } = require("./openclaw-backup-walk");
const { buildMigrationInventory } = require("./openclaw-backup-inventory");
const { resolveBackupStateRoot } = require("./openclaw-backup-paths");
const kConfigFileName = "openclaw.json";

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

// node:sqlite's backup() has no cancel API, but it has ONE cancel path: a
// throw from the `progress` hook (invoked between backup steps) aborts the
// job at that step boundary — backup() rejects with the thrown value, no
// further step runs and the destination handle closes (verified on Node
// 22.23: a hook throwing at step 2 stopped the job at step 2). Closing the
// source does NOT cancel (sqlite3_close_v2 zombifies the connection until the
// backup releases it — a backup whose source closed at step 3 ran to
// completion), so the copy is bounded from INSIDE the job: the hook runs the
// caller's checkpoint (a lost quiet barrier or an exhausted deadline) and
// rethrows into node:sqlite, and once the outer deadline timer has fired
// (stage "budget") every later step throws the same error. Swallowing the
// checkpoint's throw here (the previous shape) left the job stepping as an
// orphan while the driver released the barrier and relaunched the gateway —
// and a stepping orphan restarts from page 1 on every gateway write, so it
// livelocked on the libuv threadpool holding a state-DB read lock and the
// unlinked destination's disk until the gateway went idle.
// The orphan path survives only as the fallback for a SINGLE step that never
// returns (a hook that is never called again cannot throw): the abort closes
// the source, unlinks the destination temp (a later write goes to an unlinked
// inode, which still consumes disk until the handle closes), waits a short
// bound for the job to settle, and past the bound marks the thrown error
// `orphanedBackup: true` so the driver records it in the failure evidence.
const copyDatabase = async ({
  sqliteModule,
  source,
  destination,
  busyTimeoutMs,
  fsModule,
  checkpoint = () => {},
  remainingMs = () => Infinity,
  orphanSettleMs = kOpenclawBackupOrphanSettleMs,
  // Observer of node:sqlite's per-step { totalPages, remainingPages }, run
  // only AFTER the checkpoint passed — a cancelled job reports no progress.
  // It is the progress feed, never the cancel path: that stays the throw.
  onStep = () => {},
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
      // The error the progress hook throws into node:sqlite once the copy has
      // been aborted from outside the job (deadline timer) or by an earlier
      // step's checkpoint: a step that returns after the abort must not let
      // the job continue.
      let cancel = null;
      const settle = (finish) => (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        finish(value);
      };
      const abort = (error) => {
        if (!cancel) cancel = error;
        settle(reject)(error);
      };
      const budget = remainingMs();
      if (Number.isFinite(budget)) {
        timer = setTimeout(
          () =>
            abort(
              new OfflineCopyError(
                "budget",
                `offline-copy budget exhausted during sqlite_backup of ${path.basename(source)} — the online copy did not finish in time`,
              ),
            ),
          Math.max(1, budget),
        );
        timer.unref?.();
      }
      const progress = (info) => {
        if (cancel) throw cancel;
        try {
          checkpoint("sqlite_backup");
        } catch (error) {
          abort(error);
          // Rethrow INTO node:sqlite: this is the cancel. The rejection it
          // produces on `run` is a duplicate of `abort`'s and settles nothing.
          throw error;
        }
        onStep(info);
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
      // Aborted before the job reported back. Normally the job is already
      // dying (the hook threw, or throws at its next step) and `run` settles
      // within the bound; a single step that never returns is the orphan.
      // Close the source first (the documented contract), drop the
      // destination, then give the job the bound to settle.
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
    const error = new OfflineCopyError(
      "integrity",
      `integrity_check on ${path.basename(copyPath)}: ${text.slice(0, 200) || "no verdict"}`,
    );
    if (text) { error.sourceCorrupt = true; error.code = "SQLITE_CORRUPT"; }
    throw error;
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
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error), errcode: error && error.errcode, code: error && error.code });
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
          { cause: { errcode: message?.errcode, code: message?.code } },
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
  requiredAssets = null,
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
  if (extracted.truncated === true || Buffer.byteLength(String(extracted.tail || "")) >= kManifestTailBytes) {
    return { ok: false, stage: "manifest", reason: "manifest extraction was truncated" };
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
  // An AlphaClaw offline copy must be a format this reader knows (1, 2 or 3 —
  // both share the restore runbook); a newer format is refused honestly
  // rather than judged "usable" on fields this build does not understand.
  // Upstream manifests carry no such version and are not gated here.
  const formatVersion =
    manifest.producer === kOfflineCopyProducer ? manifest.alphaclawFormatVersion : null;
  if (
    manifest.producer === kOfflineCopyProducer &&
    !kOfflineCopyReadableFormatVersions.includes(formatVersion)
  ) {
    return {
      ok: false,
      stage: "format",
      reason: `alphaclawFormatVersion ${String(formatVersion)} is not one this AlphaClaw can read (${kOfflineCopyReadableFormatVersions.join(", ")})`,
      manifest,
    };
  }
  if (formatVersion === 3) {
    const payload = await verifyFormat3Payload({ manifest, requiredAssets, file, runCommand, timeoutMs: remaining() });
    if (!payload.ok) return payload;
  }
  const rootDir = toPosix(
    (manifest.paths && typeof manifest.paths.stateDir === "string" && manifest.paths.stateDir) ||
      stateDir ||
      "",
  );
  const missing = requiredArchivePaths.filter(
    (required) =>
      !manifest.assets.some((asset) => formatVersion === 3
        ? asset.archivePath === toPosix(required) || (path.isAbsolute(required) && asset.sourcePath === required)
        : assetCoversRequired({ asset, required, rootDir })),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      stage: "assets",
      reason: `manifest covers no ${missing.join(", ")}`,
      manifest,
    };
  }
  return { ok: true, manifest, producer: manifest.producer || kUpstreamProducer, formatVersion };
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
  // Optional async sampler of live `openclaw` processes, called AFTER the
  // state walk and right before the exclusivity fd scan (see below). When
  // absent, `exclusivity.liveProcesses` is the sample.
  sampleLiveProcesses = null,
  // Policy excludes inside workspaces: undefined → kOfflineCopyPolicyExcludes;
  // an array REPLACES the defaults (validated; a pattern that could name a
  // core asset is refused, reported on the result and in the log, never
  // applied). See resolveExcludes.
  excludes = undefined,
  rootExcludes = undefined,
  policy = null,
  profile = "full",
  spawnEnv = process.env,
  isLeaseValid = () => true,
  // Optional observer ({ stage, doneBytes, totalBytes }) for the caller's
  // progress ticker. doneBytes is monotonic and ≤ totalBytes (the copy set
  // measured by the walk: databases + assets + inlined workspace files).
  // An observer that throws is logged once and ignored — it can never abort
  // the copy; the cancel path stays the checkpoint's throw.
  onProgress = null,
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
  if (!["full", "migration-minimal"].includes(profile)) throw new TypeError("invalid offline-copy profile");
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
    if (!isLeaseValid()) throw new OfflineCopyError("lease_lost", `lifecycle lease ended during ${stage}`);
    if (!quietBarrierDisabled && !isQuiet()) {
      throw new OfflineCopyError("quiet_lost", `state-db quiet period ended during ${stage}`);
    }
    if (nowFn() > deadline) {
      throw new OfflineCopyError("budget", `offline-copy budget (${Math.round(budgetMs / 1000)} s) exhausted during ${stage}`);
    }
  };

  let inventory = null;
  let inventoryError = null;
  try { inventory = await buildMigrationInventory({ stateDir, spawnEnv, fsModule, checkpoint }); }
  catch (error) {
    if (profile === "migration-minimal" || error.sourceCorrupt || ["BACKUP_EXTERNAL_SOURCE", "BACKUP_SQLITE_ALIAS", "BACKUP_SECRET_SOURCE"].includes(error.code) || ["budget", "quiet_lost", "lease_lost"].includes(error.stage)) throw error;
    inventoryError = error;
  }
  stateDir = inventory?.stateDir || resolveBackupStateRoot({ stateDir, fsModule }).stateDir;
  const requestedPolicy = policy || { excludes, rootExcludes };
  let effectivePolicy = resolveBackupPolicy(requestedPolicy, { inventory });
  if (inventoryError) {
    const refusal = [
      ...effectivePolicy.excludes.map((pattern) => ({ scope: "workspace", pattern })),
      ...effectivePolicy.rootExcludes.map((pattern) => ({ scope: "root", pattern })),
    ].map((entry) => ({ ...entry, reason: "protected source inventory is unavailable" }));
    effectivePolicy = { ...resolveBackupPolicy({ ...effectivePolicy, excludes: [], rootExcludes: [] }),
      refused: boundBackupRefusals(effectivePolicy.refused, refusal) };
  }
  let progressObserverBroken = false;
  const observeEnumeration = (event) => {
    if (progressObserverBroken) return;
    try { onProgress?.(event); } catch (error) {
      progressObserverBroken = true;
      log(`offline copy: progress observer threw (${error?.message || error}) — progress reporting stopped, the copy continues`);
    }
  };
  const tree = profile === "migration-minimal"
    ? { ...inventory, workspaces: new Map(), excludes: [], refusedExcludes: effectivePolicy.refused, measurementComplete: true,
        diagnostics: { complete: true, measurementComplete: true, rawWorkspaceBytes: null, topEntries: [], topBytes: [] } }
    : await walkStateTreeAsync({ stateDir, fsModule, checkpoint, policy: effectivePolicy, inventory, onProgress: observeEnumeration, nowFn });
  observeEnumeration({ stage: "enumerate", profile, diagnostics: tree.diagnostics, rawWorkspaceBytes: tree.diagnostics.rawWorkspaceBytes });
  if (tree.refusedExcludes.length > 0) {
    log(
      `offline copy: refused ${tree.refusedExcludes.length} exclude pattern(s), not applied: ${tree.refusedExcludes
        .map((entry) => `${JSON.stringify(entry.pattern)} (${entry.reason})`)
        .join("; ")}`,
    );
  }
  const dbPaths = tree.dbs.map((db) => db.sourcePath);
  // Full copies can discover workspace databases outside the migration
  // inventory. Apply the same inode-alias refusal to that expanded set.
  const databaseInodes = new Map();
  for (const db of tree.dbs) {
    const stat = fsModule.statSync(db.sourcePath);
    const inode = `${stat.dev}:${stat.ino}`;
    const other = databaseInodes.get(inode);
    if (other && other !== db.sourcePath) {
      const error = new OfflineCopyError("inventory", `SQLite inode is also required at ${other}; distinct database aliases cannot be snapshotted safely`);
      error.code = "BACKUP_SQLITE_ALIAS";
      throw error;
    }
    databaseInodes.set(inode, db.sourcePath);
  }
  // The walk yields to the event loop for seconds on a real box; a live
  // `openclaw` child that spawns meanwhile (the driver's own CLI shell-outs)
  // would be missed by a pre-walk argv sample yet caught by the fd scan below
  // and refused as a foreign holder. When the caller hands over its sampler
  // (the driver's settle loop), re-sample HERE so both checks describe the
  // same instant; the pre-walk sample stays the fallback evidence.
  // (No checkpoint here on purpose: a barrier lost by now must classify as
  // the exclusivity REFUSAL below, not as a retryable quiet_lost.)
  const liveProcesses =
    typeof sampleLiveProcesses === "function"
      ? await sampleLiveProcesses({ dbPaths })
      : exclusivity?.liveProcesses;
  const exclusivityReport = assessExclusivity({
    ...(exclusivity || {}),
    liveProcesses,
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

  // Post-exclude bytes: ws.bytes already omits what the policy dropped, so a
  // workspace whose junk pushed it over the inline limit is inlined once the
  // junk is out. `hasWorkspace` (not `workspaceBytes > 0`) drives the
  // decision so a workspace left empty by the policy still reads
  // includeWorkspace:true + coverage "policy_excluded", never a bogus
  // "over the inline limit" skip.
  const workspaceBytes = [...tree.workspaces.values()].reduce((sum, ws) => sum + ws.bytes, 0);
  const excludedBytes = [...tree.workspaces.values()].reduce((sum, ws) => sum + ws.excludedBytes, 0);
  const excludedFiles = [...tree.workspaces.values()].reduce((sum, ws) => sum + ws.excludedFiles, 0);
  const hasWorkspace = tree.workspaces.size > 0;
  const includeWorkspace = hasWorkspace && workspaceBytes <= workspaceInlineBytes;
  const stateBytes =
    tree.dbs.reduce((sum, db) => sum + db.bytes, 0) +
    tree.files.reduce((sum, file) => sum + file.bytes, 0) +
    (includeWorkspace ? workspaceBytes : 0);
  // Freeze the expected files before staging. Verification receives this
  // independently of the manifest extracted from the produced archive.
  const configPath = inventory?.configPath || path.join(stateDir, kConfigFileName);
  const requiredAssets = Object.freeze([
    ...tree.dbs.map((file) => ({ ...file, kind: "sqlite" })),
    ...tree.files.map((file) => ({ ...file, kind: file.sourcePath === configPath ? "config" : "file" })),
    ...(includeWorkspace ? [...tree.workspaces.values()].flatMap((ws) => ws.files.map((file) => ({ ...file, kind: "workspace" }))) : []),
  ].map(({ kind, sourcePath, archivePath }) => Object.freeze({ kind, sourcePath, archivePath })));
  if (requiredAssets.some((asset) => asset.archivePath === "manifest.json")) {
    throw new OfflineCopyError("inventory", "state-root manifest.json conflicts with the archive's generated manifest; use an upstream full backup or relocate this file");
  }
  // Progress feed: monotonic, clamped to the measured copy set (a database
  // that grew between the walk and its copy never reports > 100 %).
  const totalBytes = stateBytes;
  let doneBytes = 0;
  const report = (stage, done) => {
    if (typeof onProgress !== "function" || progressObserverBroken) return;
    doneBytes = Math.min(totalBytes, Math.max(doneBytes, Math.floor(done)));
    try {
      onProgress({ stage, doneBytes, totalBytes });
    } catch (error) {
      progressObserverBroken = true;
      log(`offline copy: progress observer threw (${error?.message || error}) — progress reporting stopped, the copy continues`);
    }
  };
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
  let stagedBytes = 0;
  let published = false;
  try {
    fsModule.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    const snapshotStartedAt = nowFn();
    const assertSource = (file) => {
      if (!safeRelative(file.archivePath)) throw new OfflineCopyError("inventory", "unsafe archive input path");
      if (file.sourceIdentity) {
        let stat;
        try { stat = fsModule.statSync(file.sourcePath); }
        catch (error) { throw new OfflineCopyError("inventory", `required source disappeared: ${file.archivePath}`, { cause: error }); }
        if (!stat.isFile() || stat.dev !== file.sourceIdentity.dev || stat.ino !== file.sourceIdentity.ino ||
          (file.sourceIdentity.mtimeMs !== undefined && (stat.mtimeMs !== file.sourceIdentity.mtimeMs || stat.size !== file.sourceIdentity.size))) {
          throw new OfflineCopyError("inventory", `required source changed after discovery: ${file.archivePath}`);
        }
      }
    };
    for (const db of tree.dbs) {
      checkpoint("sqlite_backup");
      assertSource(db);
      report("sqlite_backup", stagedBytes);
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
        onStep: (info) => {
          const totalPages = Number(info?.totalPages);
          const remainingPages = Number(info?.remainingPages);
          if (!(totalPages > 0) || !Number.isFinite(remainingPages)) return;
          const fraction = Math.min(1, Math.max(0, 1 - remainingPages / totalPages));
          report("sqlite_backup", stagedBytes + db.bytes * fraction);
        },
      });
      stagedBytes += db.bytes;
      checkpoint("integrity");
      report("integrity", stagedBytes);
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
    const copyFile = async (file, kind) => {
      assertSource(file);
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
      // Config/credential writers can run while state databases are quiet.
      // An atomic replacement during the await must not pair new config with
      // the old inventory; matching size/mtime alone cannot bind config bytes.
      assertSource(file);
      if (file.sourceIdentity?.sha256) {
        const copiedHash = crypto.createHash("sha256").update(fsModule.readFileSync(destination)).digest("hex");
        if (copiedHash !== file.sourceIdentity.sha256) {
          throw new OfflineCopyError("inventory", `required source content changed after discovery: ${file.archivePath}`);
        }
      }
      assets.push({ kind, sourcePath: file.sourcePath, archivePath: file.archivePath });
      stagedBytes += file.bytes;
      report("copy_assets", stagedBytes);
    };
    for (const file of tree.files) {
      checkpoint("copy_assets");
      await copyFile(file, file.sourcePath === configPath ? "config" : "file");
    }
    // Every reason the archive is less than the whole state dir — the
    // record's `partial` flag derives from this list, never from the
    // workspace decision alone, so a skipped core asset can never hide
    // behind a "fully verified" copy. A policy exclude is NOT on this list:
    // it is reported through `excludes[]` + `coverage.workspace`, and
    // `coverage.core` answers the core-asset question on its own.
    const partialReasons = profile === "migration-minimal" ? ["migration-minimal backup omits workspace files and other non-migration state"] : [];
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
    if (!includeWorkspace && hasWorkspace) partialReasons.push(workspaceExcludedReason);
    const snapshotCompletedAt = nowFn();
    let coreMissing = 0;
    for (const entry of skipped) {
      if (entry.core) {
        coreMissing += 1;
        partialReasons.push(`${toPosix(path.relative(stateDir, entry.sourcePath))}: ${entry.reason}`);
      }
    }
    // Honest coverage (Eng review Codex 17): `core` names whether every core
    // asset is in the archive; `workspace` distinguishes "all of it",
    // "minus the policy excludes" and "left out over the inline limit".
    const coverage = {
      migration: inventory ? "complete" : "unknown",
      core: profile === "migration-minimal" || coreMissing > 0 ? "partial" : "complete",
      workspace: profile === "migration-minimal" ? "omitted" :
        hasWorkspace && !includeWorkspace
          ? "omitted"
          : excludedFiles > 0
            ? "policy_excluded"
            : "complete",
    };
    checkpoint("manifest");
    // paths.* describe what is IN the archive, not what exists on disk: a
    // config that was skipped (symlink to a non-file) is null here even
    // though existsSync(configPath) would say yes; a credentials dir that is
    // a symlink was not walked and is null too.
    const credentialsDir = inventory?.oauthDir || path.join(stateDir, "credentials");
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
      profile,
      snapshotStartedAt,
      snapshotCompletedAt,
      partial: partialReasons.length > 0,
      paths: {
        stateDir,
        configPath: configAsset ? configAsset.sourcePath : null,
        oauthDir: credentialsWalked ? credentialsDir : null,
        workspaceDirs: [...tree.workspaces.keys()],
        agentRoots: inventory?.agentRoots || agentRootsOf({ stateDir, fsModule }),
      },
      assets,
      requiredAssets,
      skipped,
      partialReasons,
      producer: kOfflineCopyProducer,
      alphaclawFormatVersion: kOfflineCopyFormatVersion,
      exclusivityEvidence: exclusivityReport.evidence,
      diagnosis,
      excludes: tree.excludes,
      coverage,
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
    report("archive", stagedBytes);
    const archiveTimeout = Math.max(1, deadline - nowFn());
    const { method } = await writeArchive({
      runCommand,
      tempDir,
      rootName,
      tmpOut,
      timeoutMs: archiveTimeout,
    });
    checkpoint("verify");
    report("verify", stagedBytes);
    const identityOf = (file) => {
      const stat = fsModule.statSync(file);
      return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    };
    const verificationIdentity = identityOf(tmpOut);
    const verified = await verifyArchiveManifest({
      file: tmpOut,
      runCommand,
      requiredArchivePaths: tree.dbs.map((db) => db.archivePath),
      requiredAssets,
      timeoutMs: Math.max(1, deadline - nowFn()),
      nowFn,
    });
    if (!verified.ok) {
      throw new OfflineCopyError("verify", verified.reason);
    }
    if (verified.manifest.producer !== kOfflineCopyProducer) {
      throw new OfflineCopyError("verify", "extracted manifest is not an AlphaClaw offline copy");
    }
    const unchangedArchive = (identity) => Object.keys(verificationIdentity).every((key) => verificationIdentity[key] === identity[key]);
    if (!unchangedArchive(identityOf(tmpOut))) throw new OfflineCopyError("verify", "archive changed during verification");
    checkpoint("publish");
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
    published = true;
    const verifiedFileIdentity = Object.freeze(identityOf(outputFile));
    if (!unchangedArchive(verifiedFileIdentity)) throw new OfflineCopyError("verify", "archive changed before publication");
    const durationMs = nowFn() - startedAt;
    const excludedNote =
      excludedFiles > 0
        ? ` (policy excluded ${excludedFiles} workspace file(s), ${Math.round(excludedBytes / 1e6)} MB)`
        : "";
    log(
      `offline copy: ${databases.length} db(s), ${assets.length} asset(s), ${Math.round(bytes / 1e6)} MB via ${method} in ${Math.round(durationMs / 1000)} s${excludedNote}`,
    );
    return {
      ok: true,
      file: outputFile,
      verifiedFileIdentity,
      bytes,
      durationMs,
      partial: partialReasons.length > 0,
      partialReasons,
      coverage,
      profile,
      diagnostics: tree.diagnostics,
      snapshotStartedAt,
      snapshotCompletedAt,
      excludes: tree.excludes,
      refusedExcludes: tree.refusedExcludes,
      excludedBytes,
      manifest,
      databases,
      exclusivityEvidence: exclusivityReport.evidence,
      method,
    };
  } catch (error) {
    await removeTree(tmpOut);
    if (published) await removeTree(outputFile);
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
  kOfflineCopyReadableFormatVersions,
  kOfflineCopyPolicyExcludes,
  kOfflineCopyExcludeMaxPatterns,
  kCoreAssetProbePaths,
  kOfflineCopyArchiveSuffix,
  kOfflineCopyTempDirPrefix,
  kIntegrityCheckpointIntervalMs,
  kManifestTailBytes,
  kManifestMaxBytes,
  kWalkCheckpointEvery,
  OfflineCopyError,
  isOfflineCopyArchiveName,
  producerOfArchiveName,
  isCoreAssetPath,
  compileExcludePattern,
  resolveExcludes,
  resolveBackupPolicy,
  buildMigrationInventory,
  assessExclusivity,
  defaultListFdHolders,
  defaultSpawnIntegrityWorker,
  checkIntegrity,
  walkStateTree,
  walkStateTreeAsync,
  verifyArchiveManifest,
  createOfflineCopy,
};
