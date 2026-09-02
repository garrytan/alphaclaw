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
//     │ assessExclusivity  stop confirmed · quiet barrier held · 0 live openclaw
//     │                    processes · 0 in-process handles · /proc/*/fd scan
//     │                    (Linux; elsewhere evidence "partial", copy proceeds
//     │                    — sqlite's online backup() is consistent under
//     │                    concurrent access)         ─ any HARD miss → refuse
//     │ space              free ≥ 2× state bytes in backupsDir
//     ▼
//   enumerate             *.sqlite under state/ + agents/*/agent/ (+ any other
//                         *.sqlite in the walk) · non-DB assets verbatim ·
//                         workspaces inline only < kOpenclawBackupWorkspaceInlineBytes
//     ▼  (every stage: isQuiet()? else quiet_lost · deadline? else budget)
//   sqlite_backup         readOnly source, busy_timeout 30 s, sqlite.backup()
//   integrity             PRAGMA integrity_check + user_version on each copy
//   copy_assets           openclaw.json, credentials, identity, sessions, …
//   manifest              upstream core fields + AlphaClaw fields
//   archive               tar -I 'gzip -1' (fallback: tar | gzip -1 via sh)
//   verify                gzip -t + tar -xzOf … --wildcards '*/manifest.json'
//     ▼
//   <backupsDir>/openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz
//   invalid: copy after quiet_lost (aborts); a failing hard precondition never
//   produces a file; every failure is an OfflineCopyError{stage}.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sqlite = require("node:sqlite");
const {
  kOpenclawBackupOfflineCopyBudgetMs,
  kOpenclawBackupWorkspaceInlineBytes,
  kOpenclawBackupOfflineCopyBusyTimeoutMs,
  kOpenclawBackupReuseVerifyTimeoutMs,
} = require("./constants");
const { parseJsonObjectFromNoisyOutput } = require("./utils/json");

const kOfflineCopyProducer = "alphaclaw-offline-copy";
const kUpstreamProducer = "openclaw";
const kOfflineCopyFormatVersion = 1;
const kManifestSchemaVersion = 1;
const kOfflineCopyArchiveSuffix = ".alphaclaw.tar.gz";
const kSqliteDbPattern = /\.sqlite$/i;
const kSqliteSidecarPattern = /\.sqlite-(wal|shm|journal)$/i;
// AlphaClaw's own bookkeeping, logs, temp trees and the backups themselves
// are not OpenClaw state.
const kSkipDirNames = new Set([".alphaclaw", "logs", "tmp", "node_modules", "backups"]);
const kWorkspaceDirPattern = /^workspace(-.*)?$/;
const kTarUnsupportedOptionPattern = /unrecognized option|invalid option|unknown option|illegal option/i;
const kSpaceFactor = 2;
const kMaxWalkEntries = 200_000;

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
// evidence "partial" instead of a false "clean".
const defaultListFdHolders = ({ fsModule = fs, dbPaths = [], selfPid = process.pid } = {}) => {
  const targets = new Set();
  for (const dbPath of dbPaths) {
    targets.add(dbPath);
    targets.add(`${dbPath}-wal`);
    targets.add(`${dbPath}-shm`);
    targets.add(`${dbPath}-journal`);
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
  let quiet = "missing";
  if (quietToken?.disabled) quiet = "disabled";
  else if (quietToken && isQuiet()) quiet = "held";
  else if (quietToken) quiet = "lost";
  if (quiet !== "held") failures.push(`state-db quiet barrier ${quiet}`);
  const live = Array.isArray(liveProcesses) ? liveProcesses : [];
  if (live.length > 0) {
    failures.push(`${live.length} live openclaw process(es): ${live.map((p) => p.pid).join(", ")}`);
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

const walkStateTree = ({ stateDir, fsModule }) => {
  const dbs = [];
  const files = [];
  const skipped = [];
  const workspaces = new Map();
  let entriesSeen = 0;
  const visit = (dir, rel, workspaceRoot) => {
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
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skipped.push({ kind: "symlink", sourcePath: full, reason: "symlink not followed" });
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
        visit(full, relPath, nextWorkspace);
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
  };
  visit(stateDir, "", null);
  return { dbs, files, skipped, workspaces };
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

const copyDatabase = async ({ sqliteModule, source, destination, busyTimeoutMs, fsModule }) => {
  fsModule.mkdirSync(path.dirname(destination), { recursive: true });
  let src = null;
  try {
    src = new sqliteModule.DatabaseSync(source, { readOnly: true });
    src.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    await sqliteModule.backup(src, destination);
  } catch (error) {
    throw new OfflineCopyError(
      "sqlite_backup",
      `online copy of ${path.basename(source)} failed: ${error.message}`,
      { cause: error },
    );
  } finally {
    try {
      src?.close();
    } catch {}
  }
};

const checkIntegrity = ({ sqliteModule, copyPath }) => {
  let db = null;
  try {
    db = new sqliteModule.DatabaseSync(copyPath, { readOnly: true });
    const integrity = db.prepare("PRAGMA integrity_check").get();
    const verdict = String(integrity?.integrity_check ?? "");
    const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (verdict !== "ok") {
      throw new OfflineCopyError(
        "integrity",
        `integrity_check on ${path.basename(copyPath)}: ${verdict.slice(0, 200) || "no verdict"}`,
      );
    }
    return { integrity: "ok", userVersion };
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
// `gzip -t`, its manifest must extract and parse, and the manifest must list
// the state databases this box has. Never throws — a failing check is a
// { ok:false, stage, reason } the caller treats as a verify failure.
const verifyArchiveManifest = async ({
  file,
  runCommand,
  requiredArchivePaths = [],
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
    extracted = await runCommand({
      command: "tar",
      args: ["-xzOf", file, "--wildcards", "*/manifest.json"],
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
  if (!manifest || !Array.isArray(manifest.assets)) {
    return { ok: false, stage: "parse", reason: "manifest.json is not a JSON object with assets[]" };
  }
  const listed = manifest.assets.map((asset) =>
    toPosix(asset?.archivePath || "") + "\n" + toPosix(asset?.sourcePath || ""),
  );
  const missing = requiredArchivePaths.filter((required) => {
    const suffix = toPosix(required);
    return !listed.some((entry) =>
      entry.split("\n").some((candidate) => candidate === suffix || candidate.endsWith(`/${suffix}`)),
    );
  });
  if (missing.length > 0) {
    return {
      ok: false,
      stage: "assets",
      reason: `manifest lists no ${missing.join(", ")}`,
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
  fsModule = fs,
  sqliteModule = sqlite,
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
  const checkpoint = (stage) => {
    if (!isQuiet()) {
      throw new OfflineCopyError("quiet_lost", `state-db quiet period ended during ${stage}`);
    }
    if (nowFn() > deadline) {
      throw new OfflineCopyError("budget", `offline-copy budget (${Math.round(budgetMs / 1000)} s) exhausted during ${stage}`);
    }
  };

  const tree = walkStateTree({ stateDir, fsModule });
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
  const tempDir = path.join(backupsDir, `.offline-copy-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
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
      await copyDatabase({ sqliteModule, source: db.sourcePath, destination, busyTimeoutMs, fsModule });
      const check = checkIntegrity({ sqliteModule, copyPath: destination });
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
    const configPath = path.join(stateDir, "openclaw.json");
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
    for (const [workspaceDir, ws] of tree.workspaces) {
      if (!includeWorkspace) {
        skipped.push({
          kind: "workspace",
          sourcePath: workspaceDir,
          reason: `workspace files excluded (${Math.round(workspaceBytes / 1e6)} MB > ${Math.round(workspaceInlineBytes / 1e6)} MB inline limit)`,
        });
        continue;
      }
      for (const file of ws.files) {
        checkpoint("copy_assets");
        await copyFile(file, "workspace");
      }
    }
    checkpoint("manifest");
    const credentialsDir = path.join(stateDir, "credentials");
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
        configPath: fsModule.existsSync(configPath) ? configPath : null,
        oauthDir: fsModule.existsSync(credentialsDir) ? credentialsDir : null,
        workspaceDirs: [...tree.workspaces.keys()],
        agentRoots: agentRootsOf({ stateDir, fsModule }),
      },
      assets,
      skipped,
      producer: kOfflineCopyProducer,
      alphaclawFormatVersion: kOfflineCopyFormatVersion,
      exclusivityEvidence: exclusivityReport.evidence,
      diagnosis,
    };
    try {
      fsModule.writeFileSync(
        path.join(archiveRoot, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
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
      partial: !includeWorkspace && workspaceBytes > 0,
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
  OfflineCopyError,
  isOfflineCopyArchiveName,
  producerOfArchiveName,
  assessExclusivity,
  defaultListFdHolders,
  walkStateTree,
  verifyArchiveManifest,
  createOfflineCopy,
};
