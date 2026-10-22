const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const constants = require("./constants");
const { describeExecutingBuild } = require("./openclaw-build");
const { resolveSelfDependency } = require("./self-dependency");
const { readRegularFileBounded } = require("./utils/bounded-file");
const { writeFileAtomic } = require("./utils/safe-file");
const { openReadonlyDatabase } = require("./openclaw-state-db");
const {
  readSqliteUserVersion,
  resolveDeclaredSchemaVersionsAsync,
} = require("./openclaw-schema-versions");

const kBackupTimeoutMs = 30 * 60 * 1000;
const kBackupMaxOutputBytes = 8 * 1024 * 1024;
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
  openclawSpawnEnv = () => process.env,
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
  // package.json reads); installedDiverged means the install is broken or
  // stale (the image did not install the pin), never a version choice.
  const getInfo = () => {
    const installedVersion = executingBuild()?.version ?? null;
    return {
      installedVersion,
      pinnedVersion,
      installedDiverged: Boolean(installedVersion && pinnedVersion && installedVersion !== pinnedVersion),
    };
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
    execFileFn(
      process.execPath,
      [build.bin, "backup", "create", "--output", backupsDir, "--verify", "--json"],
      { env: openclawSpawnEnv(), timeout: kBackupTimeoutMs, maxBuffer: kBackupMaxOutputBytes, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr || error.message || "").trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 500);
          finish({ ok: false, error: error.killed ? "openclaw backup create timed out" : tail || "openclaw backup create failed" });
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
        finish({ ok: true, archivePath, bytes });
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

module.exports = { createOpenclawRuntime, kBackupReceiptFileName };
