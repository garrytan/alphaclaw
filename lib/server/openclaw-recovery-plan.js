const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { fork } = require("child_process");
const { readOpenclawConfigForWrite } = require("./openclaw-config");
const { resolveBackupPath, resolveBackupStateRoot, remapBackupSourcePath, isBackupEnvPath } = require("./openclaw-backup-paths");
const { isRegistryImportArtifact } = require("./openclaw-backup-registry");
const { matchSqliteArtifact, qualifySqliteArtifacts, isSqliteArtifactContractCurrent } = require("./openclaw-sqlite-artifacts");

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

const buildRecoveryInventory = async ({ stateDir, spawnEnv = process.env, fsModule = fs, checkpoint = () => {}, executingBuild, metadataWorker = runMetadataWorker } = {}) => {
  const rootInfo = resolveBackupStateRoot({ stateDir, fsModule });
  const root = rootInfo.stateDir;
  const files = [];
  const dbs = [];
  const skipped = [];
  const excludedArtifacts = [];
  const provisional = new Map();
  const sidecars = new Map();
  const contract = qualifySqliteArtifacts({ executingBuild, fsModule });
  const rootStat = fsModule.statSync(root);
  const roots = new Map();
  const registered = new Map();
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
    const sidecarIdentities = {};
    const sidecarPaths = {};
    if (kind === "sqlite") {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        sidecarPaths[suffix] = sidecars.get(`${file}${suffix}`) || `${file}${suffix}`;
        const sidecar = inspect(sidecarPaths[suffix]);
        if (sidecar && (!stat || !sidecar.isFile() || sidecar.nlink !== 1)) fail("Database has orphaned or unsupported sidecars");
        if (suffix === "-wal" && sidecar) walBytes = sidecar.size;
        sidecarIdentities[suffix] = sidecar ? { dev: sidecar.dev, ino: sidecar.ino, mode: sidecar.mode } : null;
      }
    }
    if (!stat) return null;
    if (!stat.isFile()) fail("Recovery source is not a regular file");
    if (kind === "sqlite" && stat.nlink !== 1) fail("Ambiguous SQLite inode alias");
    const existing = [...files, ...dbs].find((item) => item.sourcePath === file);
    if (existing) {
      if (existing.kind !== kind || existing.dbKind !== dbKind || existing.agentId !== agentId) fail("Ambiguous database owner");
      if (kind === "sqlite") Object.assign(existing, { walBytes, sidecarIdentities, sidecarPaths });
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
      ...(kind === "sqlite" ? { dbKind, walBytes, sidecarIdentities, sidecarPaths, ...(agentId ? { agentId } : {}) } : {}) };
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
    if (!roots.has(directory) && roots.size >= kRecoveryLimits.databases) fail("Recovery database owner limit exceeded");
    roots.set(directory, agentId);
  };
  const discover = async (directory, dbKind, agentId) => {
    const candidates = new Set();
    await visit(directory, (file, entry) => {
      const artifact = matchSqliteArtifact(entry.name);
      if (!artifact && !/\.sqlite(?:-(?:wal|shm|journal))?$/i.test(entry.name)) return;
      const stat = inspect(file);
      if (!stat?.isFile() || stat.nlink !== 1) fail("Unsupported or aliased SQLite candidate");
      const main = file.replace(/-(wal|shm|journal)$/i, "");
      const suffix = file.slice(main.length).toLowerCase();
      if (suffix) {
        const key = `${main}${suffix}`;
        if (sidecars.has(key) && sidecars.get(key) !== file) fail("Ambiguous SQLite sidecar spelling");
        sidecars.set(key, file);
      }
      if (artifact) provisional.set(main, { file: main, dbKind, agentId, artifact });
      else candidates.add(main);
    });
    for (const file of candidates) add(file, "sqlite", dbKind, agentId);
  };
  const expectedDatabases = () => {
    const expected = new Map();
    const expectDatabase = (sourcePath, dbKind, agentId, ownership) => expected.set(sourcePath, {
      sourcePath, archivePath: path.relative(root, sourcePath).split(path.sep).join("/"), dbKind, ...(agentId ? { agentId } : {}), ownership,
      present: dbs.some((entry) => entry.sourcePath === sourcePath && entry.dbKind === dbKind && entry.agentId === agentId),
    });
    const canonicalState = [path.join(root, "openclaw.sqlite"), path.join(root, "state/openclaw.sqlite")].filter((file) => dbs.some((entry) => entry.sourcePath === file));
    for (const file of canonicalState.length ? canonicalState : [path.join(root, "state/openclaw.sqlite")]) expectDatabase(file, "state", undefined, "canonical");
    for (const [directory, agentId] of roots) {
      const canonical = path.join(directory, "openclaw-agent.sqlite");
      if (dbs.some((entry) => entry.sourcePath === canonical) || ![...registered].some(([file, owner]) => owner === agentId && path.dirname(file) === directory)) expectDatabase(canonical, "agent", agentId, "canonical");
    }
    for (const [file, agentId] of registered) expectDatabase(file, "agent", agentId, "registry");
    return [...expected.values()];
  };
  try {
    await checkpoint("inventory");
    if (spawnEnv.OPENCLAW_STATE_DIR && select(spawnEnv.OPENCLAW_STATE_DIR) !== root) fail("State directory selector disagrees with recovery inventory");
    const configPath = select(spawnEnv.OPENCLAW_CONFIG_PATH, path.join(root, "openclaw.json"));
    const configFile = add(configPath, "config");
    let config = {};
    let configDigest = null;
    if (configFile) {
      const fd = fsModule.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
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
    await discover(path.join(root, "state"), "state");
    if (dbs.length) {
      const { registry } = await metadataWorker({ mode: "registry", dbs });
      for (const row of registry) {
        await tick();
        if (!validAgent(row.agent_id) || typeof row.path !== "string" || !row.path.trim() || row.path.length > 4096 || row.path.split(path.sep).includes("..")) fail("Unsupported database registry owner");
        const file = select(path.isAbsolute(row.path) ? row.path : path.join(rootInfo.requestedStateDir, row.path));
        if (isRegistryImportArtifact({ file, stateDir: root, fsModule })) {
          skipped.push({ kind: "registry-import-artifact", sourcePath: file });
          continue;
        }
        if (registered.has(file) && registered.get(file) !== row.agent_id) fail("Ambiguous registry database owner");
        registered.set(file, row.agent_id);
        if (add(file, "sqlite", "agent", row.agent_id)) addRoot(path.dirname(file), row.agent_id);
        else skipped.push({ kind: "missing-registry-database", sourcePath: file, archivePath: path.relative(root, file), dbKind: "agent", agentId: row.agent_id });
      }
    }
    for (const [directory, agentId] of roots) {
      await tick();
      add(path.join(directory, "openclaw-agent.sqlite"), "sqlite", "agent", agentId);
      await discover(directory, "agent", agentId);
      for (const name of ["auth-profiles.json", "auth-state.json", "auth.json"]) add(path.join(directory, name), "auth");
      protect(directory);
    }
    for (const name of ["device.json", "device-auth.json"]) add(path.join(root, "identity", name), "identity");
    for (const { file, dbKind, agentId, artifact } of provisional.values()) {
      await tick();
      const owned = dbs.find((entry) => entry.sourcePath === file);
      if (owned) {
        add(file, "sqlite", owned.dbKind, owned.agentId);
        continue;
      }
      if (!contract.families.includes(artifact.family)) {
        const entry = add(file, "sqlite", dbKind, agentId);
        if (entry) entry.artifactReason = "unsupported_transient_artifact_contract";
        continue;
      }
      for (const candidate of [file, ...["-wal", "-shm", "-journal"].map((suffix) => sidecars.get(`${file}${suffix}`) || `${file}${suffix}`)]) {
        const stat = inspect(candidate);
        if (!stat) continue;
        if (!stat.isFile() || stat.nlink !== 1 || inodeOwners.has(`${stat.dev}:${stat.ino}`)) fail("Ambiguous SQLite artifact alias");
        const excluded = { kind: "transient-sqlite-artifact", sourcePath: candidate, archivePath: path.relative(root, candidate), family: artifact.family, reason: contract.reason };
        excludedArtifacts.push(excluded);
        skipped.push(excluded);
      }
    }
    await checkpoint("inventory");
    if (excludedArtifacts.length && !isSqliteArtifactContractCurrent(contract, { fsModule })) fail("Executing SQLite artifact contract changed");
    if (fsModule.realpathSync(rootInfo.requestedStateDir) !== root || fsModule.statSync(root).ino !== rootStat.ino || fsModule.statSync(root).dev !== rootStat.dev) fail("Recovery state root identity changed");
    return { ...rootInfo, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, executingBuild, configPath, configDigest, configPresent: !!configFile, files, dbs, expectedDatabases: expectedDatabases(), skipped, excludedArtifacts, artifactContract: contract,
      databaseSetComplete: !skipped.some((entry) => entry.kind === "missing-registry-database"),
      agentRoots: [...roots].map(([sourcePath, agentId]) => ({ sourcePath, agentId })), protectedPaths: [...protectedPaths], totalBytes };
  } catch (error) {
    const config = files.find((entry) => entry.kind === "config");
    error.inventory = { ...rootInfo, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, executingBuild, files, dbs, expectedDatabases: expectedDatabases(), skipped: skipped.filter((entry) => entry.kind !== "transient-sqlite-artifact"),
      configPath: config?.sourcePath || path.join(root, "openclaw.json"), configPresent: !!config, configDigest: config?.sourceIdentity.sha256 || null,
      excludedArtifacts: [], databaseSetComplete: false, agentRoots: [...roots].map(([sourcePath, agentId]) => ({ sourcePath, agentId })), protectedPaths: [...protectedPaths], totalBytes };
    throw error;
  }
};

const inspectRecoveryDatabases = async ({ inventory, supported, timeoutMs = 5000, metadataWorker = runMetadataWorker } = {}) => {
  const dbs = inventory?.dbs || [];
  let perDb;
  const assertInventoryCurrent = () => {
    if (inventory?.rootIdentity) {
      const stat = fs.statSync(inventory.stateDir);
      if (fs.realpathSync(inventory.requestedStateDir) !== inventory.stateDir || stat.dev !== inventory.rootIdentity.dev || stat.ino !== inventory.rootIdentity.ino) throw new Error("Recovery state root identity changed");
    }
    const config = inventory?.files?.find((entry) => entry.kind === "config");
    if (config) {
      const stat = fs.lstatSync(config.sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== config.sourceIdentity.dev || stat.ino !== config.sourceIdentity.ino || stat.size !== config.bytes || stat.mtimeMs !== config.sourceIdentity.mtimeMs) throw new Error("Recovery configuration identity changed");
      const fd = fs.openSync(config.sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) throw new Error("Recovery configuration identity changed during open");
        const buffer = Buffer.alloc(kRecoveryLimits.fileBytes + 1);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (count !== config.bytes || createHash("sha256").update(buffer.subarray(0, count)).digest("hex") !== inventory.configDigest) throw new Error("Recovery configuration changed");
      } finally { fs.closeSync(fd); }
    } else if (inventory?.configPath && fs.existsSync(inventory.configPath)) throw new Error("Recovery configuration appeared during observation");
    if (inventory?.excludedArtifacts?.length && !isSqliteArtifactContractCurrent(inventory.artifactContract)) throw new Error("Executing SQLite artifact contract changed");
  };
  try {
    assertInventoryCurrent();
    if (dbs.length > kRecoveryLimits.databases) throw new Error("Recovery database inventory is incomplete");
    ({ perDb } = await metadataWorker({ mode: "inspect", dbs, supported }, timeoutMs));
    assertInventoryCurrent();
    for (const missing of inventory?.skipped?.filter((entry) => entry.kind === "missing-registry-database") || []) perDb.push({ ...missing, compatible: null, migrationRequired: null, reasons: ["required_database_missing"] });
    if (inventory?.databaseSetComplete !== true && !perDb.some((entry) => entry.reasons.includes("required_database_missing"))) throw new Error("Recovery database inventory is incomplete");
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
