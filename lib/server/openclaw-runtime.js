const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const constants = require("./constants");
const { describeExecutingBuild } = require("./openclaw-build");
const { resolveSelfDependency } = require("./self-dependency");
const { readOpenclawHold, describeOpenclawPin } = require("./openclaw-pin-state");
const { readRegularFileBounded } = require("./utils/bounded-file");
const { writeFileAtomic } = require("./utils/safe-file");
const { openReadonlyDatabase } = require("./openclaw-state-db");
const {
  readSqliteUserVersion,
  resolveDeclaredSchemaVersionsAsync,
} = require("./openclaw-schema-versions");

// "Back up now" gets a timeout sized to the state it archives: 30 minutes,
// plus 2 minutes per GiB for writing and verifying the archive, at most 12
// hours. A flat 30 minutes timed out on a 34 GB state with the archive half
// written (ALPH-95: 14 GB of gzip after 30 min, staging started 7 min in).
const kBackupTimeoutFloorMs = 30 * 60 * 1000;
const kBackupTimeoutPerGiBMs = 2 * 60 * 1000;
const kBackupTimeoutCapMs = 12 * 60 * 60 * 1000;
// The state is measured synchronously before the spawn, within this many
// entries and milliseconds; a walk that runs out gets the cap.
const kBackupMeasureMaxEntries = 200_000;
const kBackupMeasureBudgetMs = 250;
// OpenClaw writes the archive inside a hidden staging dir in the output dir
// (dist/backup-create-*.mjs createBackupArchivePublication) and removes it
// itself, except when it is killed.
const kBackupStagingPrefix = ".openclaw-backup-publish-";
const kBackupMaxOutputBytes = 8 * 1024 * 1024;

const resolveBackupTimeoutMs = (stateBytes) => {
  if (!Number.isFinite(stateBytes)) return kBackupTimeoutCapMs;
  const perGiB = Math.ceil((Math.max(0, stateBytes) / 1024 ** 3) * kBackupTimeoutPerGiBMs);
  return Math.min(kBackupTimeoutCapMs, kBackupTimeoutFloorMs + perGiB);
};
// The last archive OpenClaw itself reported verified (backup create
// --verify), bound to the archive's path, size and mtime so a later reader
// can tell whether the file on disk is still that archive. Survives the
// restart that the upgrade alert usually follows.
const kBackupReceiptFileName = "openclaw-backup-receipt.json";

// What AlphaClaw knows about the OpenClaw it runs: always the pinned package
// installed beside it (package.json dependencies.openclaw). Replaces the old
// release-channel service — there is no version switching, no overlay, no
// gateway hold and no AlphaClaw backup ladder anymore.
const createOpenclawRuntime = ({
  openclawDir = constants.OPENCLAW_DIR,
  packageRoot = constants.kNpmPackageRoot,
  backupsDir = constants.kOpenclawBackupsDir,
  // Defaults beside openclawDir (constants.kOpenclawManagedDir in production)
  // so a runtime built for another tree never writes into the live one.
  managedDir = null,
  // Whether the installed pin's data upgrade had completed when a backup
  // was taken (openclaw-boot-migration.js completedForVersion).
  readCompletedForVersion = () => null,
  resolveInstallDir = () => resolveSelfDependency({ fsImpl: fs }).installDir,
  // The deployment's deliberate hold (openclaw-pin-state.js readOpenclawHold).
  readHeldVersion = () => readOpenclawHold({ fsModule }),
  openclawSpawnEnv = () => process.env,
  // Called after a verified archive with { archivePath, backupsDir }; its
  // result rides the backup status (the relay's own copy, relay/backup.js).
  // A failure there is reported beside the archive, never fails it.
  onBackupVerified = null,
  execFileFn = execFile,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  const readJson = (filePath) => {
    try {
      return JSON.parse(readRegularFileBounded(filePath, { fsModule }));
    } catch {
      return null;
    }
  };
  const pinnedVersion = readJson(path.join(packageRoot, "package.json"))?.dependencies?.openclaw || null;
  const executingBuild = () => describeExecutingBuild({ installDir: resolveInstallDir(), fsModule });

  // { installedVersion, pinnedVersion, installedDiverged } — cheap (two small
  // package.json reads); installedDiverged means the installed tree is not the
  // pin. When the deployment declares a hold, heldVersion names it and
  // installedHeld says whether the installed tree is that deliberate hold
  // (describeOpenclawPin state "held"), which is not a broken install.
  const heldVersion = readHeldVersion();
  const getInfo = () => {
    const installedVersion = executingBuild()?.version ?? null;
    const info = {
      installedVersion,
      pinnedVersion,
      installedDiverged: Boolean(installedVersion && pinnedVersion && installedVersion !== pinnedVersion),
    };
    if (!heldVersion) return info;
    return { ...info, heldVersion, installedHeld: describeOpenclawPin({ ...info, heldVersion }).state === "held" };
  };

  // The schema line the installed build supports: its public package.json
  // `openclaw.schemaVersions`. null per kind = unknown.
  let schemaMemo = null;
  const supportedSchemaFor = (build) => {
    if (schemaMemo?.packageDir === build.packageDir && schemaMemo.version === build.version) return schemaMemo.promise;
    const promise = resolveDeclaredSchemaVersionsAsync(build.packageDir, { fsModule })
      .catch(() => null)
      .then((declared) => {
        const pick = (kind) =>
          declared && declared[kind] != null
            ? { value: declared[kind], source: "declared" }
            : { value: null, source: null };
        const state = pick("state");
        const agent = pick("agent");
        return { state: state.value, agent: agent.value, source: { state: state.source, agent: agent.source } };
      });
    schemaMemo = { packageDir: build.packageDir, version: build.version, promise };
    return promise;
  };
  const getExecutingBuild = async () => {
    const build = executingBuild();
    return build ? { ...build, schemas: await supportedSchemaFor(build) } : null;
  };

  // The global state DB plus one DB per agent, each tagged with its kind.
  const stateDir = () => openclawSpawnEnv().OPENCLAW_STATE_DIR || openclawDir;
  const enumerateStateDbEntries = (root = stateDir()) => {
    const entries = [];
    const globalDb = path.join(root, "state", "openclaw.sqlite");
    if (fsModule.existsSync(globalDb)) entries.push({ path: globalDb, kind: "state", agentId: null });
    try {
      for (const agentId of fsModule.readdirSync(path.join(root, "agents"))) {
        const agentDb = path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
        if (fsModule.existsSync(agentDb)) entries.push({ path: agentDb, kind: "agent", agentId });
      }
    } catch {}
    return entries;
  };
  const readStateDbVersions = async () => {
    const entries = enumerateStateDbEntries().map((entry) => {
      const read = readSqliteUserVersion(entry.path, { open: openReadonlyDatabase, fsModule });
      return {
        ...entry,
        userVersion: Number.isInteger(read?.userVersion) ? read.userVersion : null,
        status: String(read?.status || "error"),
        error: read?.error?.code ?? null,
      };
    });
    return {
      userVersion: entries.find((entry) => entry.kind === "state")?.userVersion ?? null,
      agentUserVersions: entries.filter((entry) => entry.kind === "agent").map((entry) => entry.userVersion).filter(Number.isInteger),
      entries,
    };
  };
  // The boot report's / crash classifier's facts: per-DB user_version plus
  // the schema line the installed build supports.
  const describeStateDbSchema = async () => {
    const build = await getExecutingBuild();
    const versions = await readStateDbVersions();
    return {
      installedVersion: build?.version ?? null,
      packageDir: build?.packageDir ?? null,
      executingBuild: build,
      stateDb: versions.entries.map(({ path: dbPath, kind, agentId, userVersion, status, error }) => ({
        path: dbPath, kind, agentId, userVersion, status, ...(error ? { error } : {}),
      })),
      supportedSchema: build?.schemas ?? { state: null, agent: null, source: { state: null, agent: null } },
    };
  };

  // "Back up now": OpenClaw's own `openclaw backup create --verify` into the
  // backups dir, one at a time. The result is kept in memory for the UI.
  let backupRunning = false;
  let lastBackup = null;
  const resolvedManagedDir = managedDir || path.join(openclawDir, ".alphaclaw");
  const receiptPath = path.join(resolvedManagedDir, kBackupReceiptFileName);
  const readBackupReceipt = () => {
    const receipt = readJson(receiptPath);
    return receipt && typeof receipt.archivePath === "string" && receipt.verified === true ? receipt : null;
  };
  const writeBackupReceipt = ({ archivePath, bytes, startedAt, finishedAt }) => {
    try {
      const stat = fsModule.statSync(archivePath);
      const openclawVersion = executingBuild()?.version ?? null;
      const receipt = {
        archivePath,
        bytes: Number(stat.size),
        mtimeMs: Number(stat.mtimeMs),
        startedAt,
        finishedAt,
        verified: true,
        openclawVersion,
        upgradeCompleted: Boolean(openclawVersion) && readCompletedForVersion() === openclawVersion,
      };
      fsModule.mkdirSync(resolvedManagedDir, { recursive: true });
      writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { fsModule });
      return receipt;
    } catch (error) {
      logger.warn?.(`[alphaclaw] could not record the backup receipt: ${error.message}`);
      return null;
    }
  };
  const getBackupStatus = () => {
    if (lastBackup || backupRunning) return { running: backupRunning, last: lastBackup };
    const receipt = readBackupReceipt();
    return {
      running: false,
      last: receipt
        ? { ok: true, archivePath: receipt.archivePath, bytes: receipt.bytes, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, error: null, fromReceipt: true }
        : null,
    };
  };
  // Bytes of regular files under the state dir (symlinks not followed, the
  // backups dir skipped); null when the walk ran out of its budget.
  const measureStateBytes = () => {
    const deadline = nowFn() + kBackupMeasureBudgetMs;
    const skip = path.resolve(backupsDir);
    const pending = [path.resolve(stateDir())];
    let bytes = 0;
    let entries = 0;
    while (pending.length) {
      const dir = pending.pop();
      let names;
      try {
        names = fsModule.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of names) {
        entries += 1;
        if (entries > kBackupMeasureMaxEntries || nowFn() > deadline) return null;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full !== skip) pending.push(full);
        } else if (entry.isFile()) {
          try {
            bytes += fsModule.lstatSync(full).size;
          } catch {}
        }
      }
    }
    return bytes;
  };
  const listStagingDirs = () => {
    try {
      return fsModule.readdirSync(backupsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(kBackupStagingPrefix))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const startBackup = () => {
    if (backupRunning) return { ok: false, code: "backup_in_progress", error: "A backup is already running." };
    const build = executingBuild();
    if (!build) return { ok: false, code: "openclaw_unavailable", error: "The installed OpenClaw could not be found." };
    backupRunning = true;
    const startedAt = nowFn();
    const finish = (outcome) => {
      lastBackup = { startedAt, finishedAt: nowFn(), archivePath: null, bytes: null, error: null, ...outcome };
      if (lastBackup.ok) writeBackupReceipt(lastBackup);
      backupRunning = false;
      const summary = lastBackup.ok ? `wrote ${lastBackup.archivePath}` : `failed: ${lastBackup.error}`;
      logger.log?.(`[alphaclaw] openclaw backup create ${summary}`);
    };
    try {
      fsModule.mkdirSync(backupsDir, { recursive: true });
    } catch (error) {
      finish({ ok: false, error: `Could not create ${backupsDir}: ${error.message}` });
      return { ok: true, started: true };
    }
    const stagingBefore = new Set(listStagingDirs());
    const stateBytes = measureStateBytes();
    const timeoutMs = resolveBackupTimeoutMs(stateBytes);
    // A killed or failed run leaves its staging dir, with the unfinished
    // archive.tar.gz.tmp inside: remove the ones this run created.
    const removePartialArchives = () => {
      let removed = 0;
      for (const name of listStagingDirs()) {
        if (stagingBefore.has(name)) continue;
        try {
          fsModule.rmSync(path.join(backupsDir, name), { recursive: true, force: true });
          removed += 1;
        } catch (error) {
          logger.warn?.(`[alphaclaw] could not remove the unfinished backup in ${name}: ${error.message}`);
        }
      }
      return removed;
    };
    execFileFn(
      process.execPath,
      [build.bin, "backup", "create", "--output", backupsDir, "--verify", "--json"],
      { env: openclawSpawnEnv(), timeout: timeoutMs, maxBuffer: kBackupMaxOutputBytes, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr || error.message || "").trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 500);
          const partialArchivesRemoved = removePartialArchives();
          finish({
            ok: false,
            error: error.killed ? "openclaw backup create timed out" : tail || "openclaw backup create failed",
            ...(error.killed ? { timeoutMs, stateBytes } : {}),
            ...(partialArchivesRemoved ? { partialArchivesRemoved } : {}),
          });
          return;
        }
        let result = null;
        try {
          result = JSON.parse(String(stdout || "").trim());
        } catch {}
        const archivePath = typeof result?.archivePath === "string" ? result.archivePath : null;
        if (!archivePath || result.verified !== true) {
          finish({ ok: false, error: "openclaw backup create did not report a verified archive" });
          return;
        }
        let bytes = null;
        try {
          bytes = fsModule.statSync(archivePath).size;
        } catch {}
        let extra = {};
        if (typeof onBackupVerified === "function") {
          try {
            extra = onBackupVerified({ archivePath, backupsDir }) || {};
          } catch (hookError) {
            extra = { relay: { ok: false, error: String(hookError?.message || hookError) } };
          }
        }
        finish({ ok: true, archivePath, bytes, ...extra });
      },
    );
    return { ok: true, started: true };
  };

  return {
    getInfo,
    getExecutingBuild,
    readStateDbVersions,
    describeStateDbSchema,
    startBackup,
    getBackupStatus,
    readBackupReceipt,
    listStateDbFiles: () => enumerateStateDbEntries().map((entry) => entry.path),
  };
};

module.exports = { createOpenclawRuntime, kBackupReceiptFileName, resolveBackupTimeoutMs };
