// Migration inputs are discovered from their owners, never by walking scratch.
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { readOpenclawConfig } = require("./openclaw-config");
const { OfflineCopyError } = require("./openclaw-backup-errors");
const { isRegistryImportArtifact } = require("./openclaw-backup-registry");
const { resolveBackupPath } = require("./openclaw-backup-paths");

const kDatabasePattern = /\.sqlite$/i;
const kSidecarPattern = /\.sqlite-(wal|shm|journal)$/i;
const kInventoryEntryLimit = 200_000;
// OpenClaw v2026.9.3's persisted agent identity grammar.
const kAgentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const inside = (file, root) => file === root || file.startsWith(`${root}${path.sep}`);
const posix = (file) => file.split(path.sep).join("/");
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const buildMigrationInventoryUnchecked = async ({
  stateDir,
  spawnEnv = process.env,
  fsModule = fs,
  checkpoint = () => {},
  maxEntries = kInventoryEntryLimit,
} = {}) => {
  const root = path.resolve(stateDir);
  const dbs = [];
  const files = [];
  const skipped = [];
  const agentRoots = [];
  const protectedPaths = new Set();
  const seen = new Set();
  const inodeOwners = new Map();
  let entries = 0;
  const fail = (file, reason, cause, code) => {
    const error = new OfflineCopyError("inventory", `cannot establish migration coverage for ${posix(path.relative(root, file)) || "."}: ${reason}`, { cause });
    if (code) error.code = code;
    throw error;
  };
  const resolveSelector = (value, fallback) => resolveBackupPath(value, { spawnEnv, fallback });
  const protect = (file) => {
    let ancestor = file;
    while (inside(ancestor, root)) {
      protectedPaths.add(ancestor);
      if (ancestor === root) break;
      ancestor = path.dirname(ancestor);
    }
  };
  const inspect = (file, { config = false } = {}) => {
    let stat;
    try { stat = fsModule.lstatSync(file); } catch (error) {
      if (error.code !== "ENOENT") fail(file, error.message, error);
      // ENOENT through a dangling symlink is not proof that an optional file
      // never existed. Inspect every existing ancestor before accepting it.
      let ancestor = path.dirname(file);
      while (ancestor !== path.dirname(ancestor)) {
        try {
          const parent = fsModule.lstatSync(ancestor);
          if (parent.isSymbolicLink() || !parent.isDirectory()) fail(file, "an ancestor is not a regular directory");
          break;
        } catch (parentError) {
          if (parentError instanceof OfflineCopyError) throw parentError;
          if (parentError.code !== "ENOENT") fail(file, parentError.message, parentError);
        }
        ancestor = path.dirname(ancestor);
      }
      return null;
    }
    if (!inside(file, root)) fail(file, "required source lies outside the supported OpenClaw state root; use an upstream full backup or relocate the source", null, "BACKUP_EXTERNAL_SOURCE");
    let ancestor = path.dirname(file);
    while (inside(ancestor, root) && ancestor !== root) {
      if (fsModule.lstatSync(ancestor).isSymbolicLink()) fail(file, "required source has a symlinked directory ancestor");
      ancestor = path.dirname(ancestor);
    }
    if (stat.isSymbolicLink()) {
      if (!config) fail(file, "required source is a symlink");
      let target;
      try {
        target = fsModule.realpathSync(file);
        stat = fsModule.statSync(file);
      } catch (error) { fail(file, "config symlink is unavailable", error); }
      const realRoot = fsModule.realpathSync(root);
      if (!inside(target, realRoot) || !stat.isFile()) fail(file, "config symlink does not resolve to a regular file inside the state root");
    }
    return stat;
  };
  const tick = async () => {
    entries += 1;
    if (entries > maxEntries) fail(root, `migration input inventory exceeds ${maxEntries} entries`);
    if (entries % 128 === 0) {
      checkpoint("inventory");
      await yieldToLoop();
    }
  };
  const addFile = (file, kind = "file", options = {}) => {
    const stat = inspect(file, options);
    if (!stat) {
      if (kind === "sqlite") {
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          if (inspect(`${file}${suffix}`)) fail(file, `database is absent but ${suffix} survives`);
        }
      }
      return false;
    }
    if (!stat.isFile()) fail(file, "required input is not a regular file");
    protect(file);
    const identity = fsModule.realpathSync(file);
    if (seen.has(identity)) return true;
    const inode = `${stat.dev}:${stat.ino}`;
    const owner = inodeOwners.get(inode);
    // SQLite aliases may have different WAL files despite sharing their main
    // inode. Neither silently dropping one nor snapshotting both proves the
    // intended restore state. Ordinary files retain each logical destination.
    if (owner && (kind === "sqlite" || owner.kind === "sqlite")) {
      fail(file, `SQLite inode is also required at ${posix(path.relative(root, owner.file))}; distinct database aliases cannot be snapshotted safely`, null, "BACKUP_SQLITE_ALIAS");
    }
    inodeOwners.set(inode, { file, kind });
    seen.add(identity);
    (kind === "sqlite" ? dbs : files).push({
      sourcePath: file, archivePath: posix(path.relative(root, file)), bytes: stat.size, kind,
      sourceIdentity: { dev: stat.dev, ino: stat.ino, ...(kind !== "sqlite" ? { size: stat.size, mtimeMs: stat.mtimeMs } : {}) },
    });
    return true;
  };
  const visit = async (directory, consume) => {
    const stat = inspect(directory);
    if (!stat) return;
    if (!stat.isDirectory()) fail(directory, "input directory is not a regular directory");
    let handle;
    try {
      handle = fsModule.opendirSync(directory);
      for (let entry; (entry = handle.readSync()) !== null;) {
        await tick();
        await consume(path.join(directory, entry.name), entry);
      }
    } catch (error) {
      if (error instanceof OfflineCopyError) throw error;
      fail(directory, error.message, error);
    } finally { handle?.closeSync(); }
  };
  const directDatabases = async (directory) => visit(directory, (file, entry) => {
    if (kDatabasePattern.test(entry.name)) addFile(file, "sqlite");
    else if (kSidecarPattern.test(entry.name)) {
      const dbPath = file.replace(kSidecarPattern, ".sqlite");
      if (!addFile(dbPath, "sqlite")) fail(dbPath, "database sidecar survives without its database");
      skipped.push({ kind: "sqlite-sidecar", sourcePath: file, coveredBy: dbPath, reason: "covered by the online sqlite copy" });
    }
  });
  const copyStore = async (directory) => {
    if (inspect(directory)) protect(directory);
    await visit(directory, async (file, entry) => {
      if (entry.isDirectory()) await copyStore(file);
      else if (kDatabasePattern.test(entry.name)) addFile(file, "sqlite");
      else if (kSidecarPattern.test(entry.name)) {
        const dbPath = file.replace(kSidecarPattern, ".sqlite");
        if (!addFile(dbPath, "sqlite")) fail(dbPath, "database sidecar survives without its database");
      } else addFile(file);
    });
  };

  checkpoint("inventory");
  const configPath = resolveSelector(spawnEnv.OPENCLAW_CONFIG_PATH, path.join(root, "openclaw.json"));
  const configExists = addFile(configPath, "config", { config: true });
  const config = configExists ? readOpenclawConfig({
    openclawDir: root, configPath, fsModule, fallback: null,
    onReadSource: (raw) => {
      files.find((file) => file.sourcePath === configPath).sourceIdentity.sha256 = createHash("sha256").update(raw).digest("hex");
    },
  }) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) fail(configPath, "configuration cannot be parsed; JSON5/includes require a full backup");
  const hasInclude = (value) => value && typeof value === "object" &&
    (Object.prototype.hasOwnProperty.call(value, "$include") || Object.values(value).some(hasInclude));
  if (hasInclude(config)) fail(configPath, "configuration includes cannot be resolved by migration-minimal backup; use a full backup");

  await directDatabases(root);
  await directDatabases(path.join(root, "state"));
  const roots = new Map();
  await visit(path.join(root, "agents"), (file, entry) => {
    // Check even symlinks: silently ignoring one could lose an entire agent.
    if (entry.isDirectory() || entry.isSymbolicLink()) roots.set(path.join(file, "agent"), entry.name);
  });
  if (config.agents?.list !== undefined && !Array.isArray(config.agents.list)) fail(configPath, "configured agents are not a list");
  for (const agent of config.agents?.list || []) {
    if (!agent || typeof agent.id !== "string" || !kAgentIdPattern.test(agent.id)) fail(configPath, "invalid configured agent identity");
    const directory = resolveSelector(agent.agentDir, path.join(root, "agents", agent.id, "agent"));
    roots.set(directory, agent.id);
  }
  const globalPath = path.join(root, "state", "openclaw.sqlite");
  if (dbs.some((db) => db.sourcePath === globalPath)) {
    let database;
    try {
      database = new DatabaseSync(globalPath, { readOnly: true });
      database.exec("PRAGMA busy_timeout = 2000");
      const table = database.prepare("SELECT type FROM sqlite_master WHERE name = 'agent_databases'").get();
      if (table && table.type !== "table") fail(globalPath, "invalid agent database registry");
      if (table) {
        for (const row of database.prepare("SELECT agent_id, path FROM agent_databases").iterate()) {
          await tick();
          if (typeof row.agent_id !== "string" || !kAgentIdPattern.test(row.agent_id)) fail(globalPath, "invalid registry agent identity");
          // Normalizing '..' before resolving symlinks can select a different
          // source than the registry owner. Refuse this ambiguous locator.
          if (typeof row.path !== "string" || !row.path.trim() || row.path.includes("\0") || row.path.split(path.sep).includes("..")) fail(globalPath, "invalid registry database path");
          const target = path.isAbsolute(row.path) ? path.resolve(row.path) : path.resolve(root, row.path);
          if (isRegistryImportArtifact({ file: target, stateDir: root, fsModule })) {
            skipped.push({ kind: "registry-import-artifact", sourcePath: target, reason: "registry-only imports entry is an offline artifact, not migration state" });
            continue;
          }
          if (addFile(target, "sqlite")) roots.set(path.dirname(target), row.agent_id);
          else skipped.push({ kind: "missing-registry-database", sourcePath: target, reason: "stale registry target and all sidecars are absent" });
        }
      }
    } catch (error) {
      if (error instanceof OfflineCopyError) throw error;
      fail(globalPath, `agent database registry cannot be read: ${error.message}`, error);
    } finally { database?.close(); }
  }
  for (const [directory, agentId] of roots) {
    if (inspect(directory)) {
      protect(directory);
      agentRoots.push({ agentId, sourcePath: directory });
    }
    await directDatabases(directory);
    addFile(path.join(directory, "auth-profiles.json"));
    addFile(path.join(directory, "auth.json"));
  }
  const oauthDir = resolveSelector(spawnEnv.OPENCLAW_OAUTH_DIR, path.join(root, "credentials"));
  await copyStore(oauthDir);
  await copyStore(path.join(root, "identity"));
  checkpoint("inventory");
  return { stateDir: root, dbs, files, skipped, protectedPaths: [...protectedPaths], agentRoots, configPath, oauthDir };
};

const buildMigrationInventory = async (options) => {
  try { return await buildMigrationInventoryUnchecked(options); }
  catch (error) {
    if (error instanceof OfflineCopyError || error.code === "diagnosis_budget") throw error;
    throw new OfflineCopyError("inventory", `cannot establish migration coverage: ${error.message}`, { cause: error });
  }
};

module.exports = { buildMigrationInventory, kInventoryEntryLimit };
