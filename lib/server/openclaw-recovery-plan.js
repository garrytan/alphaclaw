const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { fork } = require("child_process");
const { readOpenclawConfigForWrite } = require("./openclaw-config");
const { resolveBackupPath, resolveBackupStateRoot, remapBackupSourcePath, isBackupEnvPath } = require("./openclaw-backup-paths");
const { isRegistryImportArtifact } = require("./openclaw-backup-registry");

const kRecoveryLimits = Object.freeze({ fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024, files: 256, databases: 512, entries: 4096 });
const inside = (file, root) => file === root || file.startsWith(`${root}${path.sep}`);
const validAgent = (id) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);
const fail = (message) => { throw Object.assign(new Error(message), { code: "RECOVERY_INVENTORY_UNSUPPORTED" }); };

const runMetadataWorker = (data, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const worker = fork(path.join(__dirname, "openclaw-recovery-probe.js"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], env: { PATH: process.env.PATH } });
  let settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const complete = () => error ? reject(error) : resolve(result);
    if (!worker.pid || worker.exitCode !== null || worker.signalCode !== null) complete();
    else {
      worker.once("exit", complete);
      worker.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => finish(Object.assign(new Error("Recovery metadata observation timed out"), { code: "RECOVERY_PROBE_TIMEOUT" })), Math.max(1, Math.min(timeoutMs, 5000)));
  worker.once("message", (result) => result.error ? finish(Object.assign(new Error(result.error), { code: result.code, errcode: result.errcode, status: result.status, sourcePath: result.sourcePath })) : finish(null, result));
  worker.once("error", finish);
  worker.once("exit", () => finish(new Error("Recovery metadata worker exited without a result")));
  worker.send(data, (error) => { if (error) finish(error); });
});

const buildRecoveryInventory = async ({ stateDir, spawnEnv = process.env, fsModule = fs, checkpoint = () => {} } = {}) => {
  const rootInfo = resolveBackupStateRoot({ stateDir, fsModule });
  const root = rootInfo.stateDir;
  const files = [];
  const dbs = [];
  const skipped = [];
  const roots = new Map();
  const inodeOwners = new Map();
  const protectedPaths = new Set();
  let totalBytes = 0;
  let entries = 0;
  const tick = async () => {
    if (++entries > kRecoveryLimits.entries) fail("Recovery inventory enumeration limit exceeded");
    await checkpoint("inventory");
    if (entries % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
  };
  const select = (value, fallback) => {
    if (typeof value === "string" && (value.includes("\0") || value.split(path.sep).includes(".."))) fail("Ambiguous recovery storage selector");
    const file = remapBackupSourcePath(resolveBackupPath(value, { spawnEnv, fallback }), rootInfo);
    if (!inside(file, root) || isBackupEnvPath(path.relative(root, file))) fail("Recovery source is outside supported state storage or selects environment secrets");
    return file;
  };
  const inspect = (file) => {
    if (!inside(file, root) || isBackupEnvPath(path.relative(root, file))) fail("Unsupported recovery source");
    const segments = path.relative(root, file).split(path.sep).filter(Boolean);
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      let stat;
      try { stat = fsModule.lstatSync(current); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      if (stat.isSymbolicLink()) fail("Symlinked recovery source is unsupported");
      if (i < segments.length - 1 && !stat.isDirectory()) fail("Recovery source ancestor is not a directory");
      if (i === segments.length - 1) return stat;
    }
    return fsModule.statSync(root);
  };
  const protect = (file) => {
    while (inside(file, root)) {
      protectedPaths.add(file);
      if (file === root) break;
      file = path.dirname(file);
    }
  };
  const add = (file, kind, dbKind, agentId) => {
    const stat = inspect(file);
    let walBytes = 0;
    if (kind === "sqlite") {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const sidecar = inspect(`${file}${suffix}`);
        if (sidecar && (!stat || !sidecar.isFile())) fail("Database has orphaned or unsupported sidecars");
        if (suffix === "-wal" && sidecar) walBytes = sidecar.size;
      }
    }
    if (!stat) return null;
    if (!stat.isFile()) fail("Recovery source is not a regular file");
    const existing = [...files, ...dbs].find((item) => item.sourcePath === file);
    if (existing) {
      if (existing.kind !== kind || existing.dbKind !== dbKind || existing.agentId !== agentId) fail("Ambiguous database owner");
      return existing;
    }
    const inode = `${stat.dev}:${stat.ino}`;
    if (inodeOwners.has(inode) && (kind === "sqlite" || inodeOwners.get(inode) === "sqlite")) fail("Ambiguous SQLite inode alias");
    inodeOwners.set(inode, kind);
    const list = kind === "sqlite" ? dbs : files;
    if (list.length >= (kind === "sqlite" ? kRecoveryLimits.databases : kRecoveryLimits.files)) fail("Recovery inventory file limit exceeded");
    if (kind !== "sqlite") {
      totalBytes += stat.size;
      if (stat.size > kRecoveryLimits.fileBytes || totalBytes > kRecoveryLimits.totalBytes) fail("Recovery configuration byte limit exceeded");
    }
    const item = { sourcePath: file, archivePath: path.relative(root, file).split(path.sep).join("/"), kind, bytes: stat.size,
      sourceIdentity: { dev: stat.dev, ino: stat.ino, ...(kind === "sqlite" ? {} : { size: stat.size, mtimeMs: stat.mtimeMs }) },
      ...(kind === "sqlite" ? { dbKind, walBytes, ...(agentId ? { agentId } : {}) } : {}) };
    list.push(item);
    protect(file);
    return item;
  };
  const visit = async (directory, consume) => {
    const stat = inspect(directory);
    if (!stat) return;
    if (!stat.isDirectory()) fail("Recovery owner path is not a directory");
    const handle = fsModule.opendirSync(directory);
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        await tick();
        await consume(path.join(directory, entry.name), entry);
      }
    } finally { handle.closeSync(); }
  };
  const addRoot = (directory, agentId) => {
    if (!validAgent(agentId)) fail("Unsupported agent identity");
    if (roots.has(directory) && roots.get(directory) !== agentId) fail("Ambiguous agent directory owner");
    roots.set(directory, agentId);
  };
  await checkpoint("inventory");
  if (spawnEnv.OPENCLAW_STATE_DIR && select(spawnEnv.OPENCLAW_STATE_DIR) !== root) fail("State directory selector disagrees with recovery inventory");
  const configPath = select(spawnEnv.OPENCLAW_CONFIG_PATH, path.join(root, "openclaw.json"));
  const configFile = add(configPath, "config");
  let config = {};
  let configDigest = null;
  if (configFile) {
    const fd = fsModule.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let raw;
    try {
      const stat = fsModule.fstatSync(fd);
      if (!stat.isFile() || stat.dev !== configFile.sourceIdentity.dev || stat.ino !== configFile.sourceIdentity.ino || stat.size !== configFile.bytes || stat.mtimeMs !== configFile.sourceIdentity.mtimeMs) fail("Configuration identity changed during inventory");
      const buffer = Buffer.alloc(kRecoveryLimits.fileBytes + 1);
      let count = 0;
      for (;;) {
        const read = fsModule.readSync(fd, buffer, count, buffer.length - count, count);
        count += read;
        if (count > kRecoveryLimits.fileBytes) fail("Recovery configuration byte limit exceeded");
        if (!read) break;
      }
      raw = buffer.subarray(0, count);
      const after = fsModule.fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || count !== stat.size) fail("Configuration changed during inventory");
    } finally { fsModule.closeSync(fd); }
    config = readOpenclawConfigForWrite({ openclawDir: root, fsModule: { readFileSync: () => raw.toString("utf8") } });
    const rawAgents = JSON.parse(raw.toString("utf8")).agents;
    if (rawAgents !== undefined && (!rawAgents || typeof rawAgents !== "object" || Array.isArray(rawAgents))) fail("Unsupported configured agent roster");
    if (rawAgents?.entries !== undefined) {
      if (!rawAgents.entries || typeof rawAgents.entries !== "object" || Array.isArray(rawAgents.entries)) fail("Unsupported configured agent roster");
      for (const [id, agent] of Object.entries(rawAgents.entries)) {
        if (!agent || typeof agent !== "object" || Array.isArray(agent) || (agent.id !== undefined && agent.id !== id)) fail("Ambiguous configured agent identity");
      }
    }
    configDigest = createHash("sha256").update(raw).digest("hex");
    configFile.sourceIdentity.sha256 = configDigest;
    const pending = [config];
    while (pending.length) {
      const value = pending.pop();
      if (value && typeof value === "object") {
        if (Object.hasOwn(value, "$include")) fail("Configuration includes are unsupported for recovery coverage");
        pending.push(...Object.values(value));
      }
    }
  }
  if (config.agents?.entries !== undefined || (config.agents?.list !== undefined && !Array.isArray(config.agents.list))) fail("Unsupported configured agent roster");
  for (const agent of config.agents?.list || []) {
    if (!agent || !validAgent(agent.id)) fail("Unsupported configured agent identity");
    addRoot(select(agent.agentDir, path.join(root, "agents", agent.id, "agent")), agent.id);
  }
  if (spawnEnv.OPENCLAW_AGENT_DIR || spawnEnv.PI_CODING_AGENT_DIR || config.session?.store) fail("Unsupported database storage selector");
  await visit(path.join(root, "agents"), (directory, entry) => {
    if (entry.isDirectory() || entry.isSymbolicLink()) addRoot(path.join(directory, "agent"), entry.name);
  });
  add(path.join(root, "openclaw.sqlite"), "sqlite", "state");
  await visit(path.join(root, "state"), (file, entry) => {
    if (/\.sqlite(?:-(?:wal|shm|journal))?$/.test(entry.name)) add(file.replace(/-(wal|shm|journal)$/, ""), "sqlite", "state");
  });
  if (dbs.length) {
    const { registry } = await runMetadataWorker({ mode: "registry", dbs });
    for (const row of registry) {
      await tick();
      if (!validAgent(row.agent_id) || typeof row.path !== "string" || !row.path.trim() || row.path.length > 4096 || row.path.split(path.sep).includes("..")) fail("Unsupported database registry owner");
      const file = select(path.isAbsolute(row.path) ? row.path : path.join(rootInfo.requestedStateDir, row.path));
      if (isRegistryImportArtifact({ file, stateDir: root, fsModule })) {
        skipped.push({ kind: "registry-import-artifact", sourcePath: file });
        continue;
      }
      if (add(file, "sqlite", "agent", row.agent_id)) addRoot(path.dirname(file), row.agent_id);
      else skipped.push({ kind: "missing-registry-database", sourcePath: file });
    }
  }
  for (const [directory, agentId] of roots) {
    await tick();
    await visit(directory, (file, entry) => {
      if (/\.sqlite(?:-(?:wal|shm|journal))?$/.test(entry.name)) add(file.replace(/-(wal|shm|journal)$/, ""), "sqlite", "agent", agentId);
    });
    for (const name of ["auth-profiles.json", "auth-state.json", "auth.json"]) add(path.join(directory, name), "auth");
    protect(directory);
  }
  for (const name of ["device.json", "device-auth.json"]) add(path.join(root, "identity", name), "identity");
  await checkpoint("inventory");
  return { ...rootInfo, configPath, configDigest, configPresent: !!configFile, files, dbs, skipped, databaseSetComplete: true,
    agentRoots: [...roots].map(([sourcePath, agentId]) => ({ sourcePath, agentId })), protectedPaths: [...protectedPaths], totalBytes };
};

const inspectRecoveryDatabases = async ({ inventory, supported, timeoutMs = 5000 } = {}) => {
  const dbs = inventory?.dbs || [];
  let perDb;
  try {
    if (inventory?.databaseSetComplete !== true || dbs.length > kRecoveryLimits.databases) throw new Error("Recovery database inventory is incomplete");
    ({ perDb } = await runMetadataWorker({ mode: "inspect", dbs, supported }, timeoutMs));
  } catch (error) {
    return { ok: false, compatible: null, migrationRequired: null, perDb: [], byKind: {}, dbSizesBytes: {}, reasons: [error.code || error.message],
      ...(error.sourcePath ? { sourcePath: error.sourcePath, error: { code: error.code, errcode: error.errcode, status: error.status, message: error.message } } : {}) };
  }
  const compatible = perDb.some((db) => db.compatible === false) ? false : perDb.some((db) => db.compatible === null) ? null : true;
  const migrationRequired = perDb.some((db) => db.migrationRequired === null) ? null : perDb.some((db) => db.migrationRequired);
  perDb = perDb.map((db) => ({ ...db, path: db.sourcePath, supported: supported?.[db.dbKind] ?? null,
    status: db.status || (db.compatible === null ? "unverified" : "ok"), verdict: db.compatible === null ? "indeterminate" : db.compatible ? "compatible" : "incompatible" }));
  const byKind = Object.fromEntries(["state", "agent"].map((kind) => {
    const rows = perDb.filter((db) => db.dbKind === kind);
    const versions = rows.map((db) => db.contentVersion).filter(Number.isSafeInteger);
    return [kind, { count: rows.length,
      compatible: rows.some((db) => db.compatible === false) ? false : rows.some((db) => db.compatible === null) ? null : true,
      migrationRequired: rows.some((db) => db.migrationRequired === null) ? null : rows.some((db) => db.migrationRequired),
      foundVersion: versions.length ? Math.min(...versions) : null, targetVersion: supported?.[kind] ?? null }];
  }));
  return { ok: compatible === true && migrationRequired !== null, compatible, migrationRequired, perDb, byKind,
    dbSizesBytes: Object.fromEntries(dbs.map((db) => [db.sourcePath, db.bytes])), reasons: perDb.flatMap((db) => db.reasons) };
};

module.exports = { buildRecoveryInventory, inspectRecoveryDatabases, kRecoveryLimits };
