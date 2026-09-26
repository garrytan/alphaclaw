const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");

const kFileBytes = 1024 * 1024;
const kTotalBytes = 16 * kFileBytes;
const kFileCount = 256;
const kConfigBudgetMs = 10_000;
const kDatabaseBudgetMs = 8 * 60_000;
const kFormat = "alphaclaw-recovery-checkpoint";
const kIdPattern = /^recovery-[0-9a-f-]{36}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => {
  const error = new Error(`Recovery checkpoint refused: ${code}`);
  error.code = code;
  throw error;
};
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameIdentity = (actual, expected) => expected && ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode"].every((key) => expected[key] === undefined || actual[key] === expected[key]);
const safeRelative = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\\") && !value.includes("\0") && !path.isAbsolute(value) && value.split("/").every((part) => part && part !== "." && part !== ".." && part !== ".alphaclaw" && part !== ".env" && !part.startsWith(".env."));
const configPathAllowed = (value, configArchivePath) => value === configArchivePath || /^identity\/(device|device-auth)\.json$/.test(value) || /\/(auth-profiles|auth-state|auth)\.json$/.test(value);
const databasePathAllowed = (value) => safeRelative(value) && value.endsWith(".sqlite");
const dbInventory = (entries) => entries.map(({ sourcePath, archivePath, dbKind, agentId, sourceIdentity }) => ({ sourcePath, archivePath, dbKind: dbKind ?? null, agentId: agentId ?? null, sourceIdentity })).sort((a, b) => a.archivePath.localeCompare(b.archivePath));
const inventoryDigest = (entries) => digest(JSON.stringify(dbInventory(entries)));
const tick = () => new Promise((resolve) => setImmediate(resolve));

const checkPath = (root, relative, fsModule, privatePath = false) => {
  if (!safeRelative(relative)) fail("CHECKPOINT_UNSAFE_PATH");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = fsModule.lstatSync(current);
    if (stat.isSymbolicLink()) fail("CHECKPOINT_SOURCE_ALIAS");
    if (privatePath && stat.mode & 0o077) fail("CHECKPOINT_PERMISSIONS");
  }
  if (fsModule.realpathSync(current) !== current) fail("CHECKPOINT_SOURCE_ALIAS");
  return current;
};

const readBound = (file, maxBytes, fsModule, expected) => {
  const fd = fsModule.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fsModule.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) fail("CHECKPOINT_SOURCE_ALIAS");
    if (before.size > maxBytes) fail("CHECKPOINT_LIMIT");
    if (expected && !sameIdentity(before, expected)) fail("CHECKPOINT_SOURCE_CHANGED");
    const data = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const count = fsModule.readSync(fd, data, offset, data.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== before.size || !sameIdentity(fsModule.fstatSync(fd), identity(before)) || !sameIdentity(fsModule.lstatSync(file), identity(before))) fail("CHECKPOINT_SOURCE_CHANGED");
    const bytes = data.subarray(0, offset);
    const sha256 = digest(bytes);
    if (expected?.sha256 && expected.sha256 !== sha256) fail("CHECKPOINT_SOURCE_CHANGED");
    return { data: bytes, sha256, sourceIdentity: identity(before) };
  } finally {
    fsModule.closeSync(fd);
  }
};

const syncPath = (file, fsModule) => {
  const fd = fsModule.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fsModule.fsyncSync(fd); } finally { fsModule.closeSync(fd); }
};
const writePrivate = (file, data, fsModule) => {
  const fd = fsModule.openSync(file, "wx", 0o600);
  try {
    fsModule.writeFileSync(fd, data);
    fsModule.fsyncSync(fd);
  } finally { fsModule.closeSync(fd); }
};
const privateParents = (root, relative, fsModule) => {
  let current = root;
  for (const part of path.dirname(relative).split(path.sep)) {
    if (part === ".") continue;
    current = path.join(current, part);
    try { fsModule.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!fsModule.lstatSync(current).isDirectory() || (fsModule.statSync(current).mode & 0o077)) fail("CHECKPOINT_PERMISSIONS");
  }
};

const runDatabaseWorker = ({ source, destination, verifyOnly = false, check, onProgress }) => new Promise((resolve, reject) => {
  const child = fork(path.join(__dirname, "openclaw-recovery-checkpoint-worker.js"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], env: { PATH: process.env.PATH } });
  let result;
  let failure;
  const abort = (error) => {
    failure ||= error;
    child.kill("SIGKILL");
  };
  const timer = setInterval(() => {
    try { check(); } catch (error) { abort(error); }
  }, 25);
  child.on("message", (message) => {
    try {
      check();
      if (message.error) fail("CHECKPOINT_DATABASE_INVALID");
      if (message.progress) onProgress?.(message.progress);
      if (message.result) result = message.result;
    } catch (error) { abort(error); }
  });
  child.on("error", abort);
  child.on("close", (code) => {
    clearInterval(timer);
    if (failure) reject(failure);
    else if (code !== 0 || !result) {
      try { fail("CHECKPOINT_DATABASE_INVALID"); } catch (error) { reject(error); }
    } else resolve(result);
  });
  child.send({ source, destination, verifyOnly }, (error) => { if (error) abort(error); });
});

const resultFor = (file, manifest, manifestSha256 = digest(JSON.stringify(manifest))) => ({
  kind: manifest.kind,
  file,
  checkpoint: {
    id: manifest.id, file, verified: true,
    manifestSha256, operationId: manifest.operationId,
    fileCount: manifest.files.length,
    bytes: manifest.files.reduce((sum, entry) => sum + entry.bytes, 0),
    sourceBuild: manifest.sourceBuild, targetBuild: manifest.targetBuild,
  },
  databases: {
    complete: manifest.kind === "database_set" && manifest.requiredPaths.length > 0, verified: manifest.kind === "database_set" && manifest.requiredPaths.length > 0,
    requiredPaths: Object.freeze([...manifest.requiredPaths]),
    inventoryDigest: manifest.inventoryDigest,
    entries: manifest.databases.map((entry) => ({ ...entry, path: entry.archivePath, verified: true })),
  },
  restore: { configAvailable: true, databaseSetAvailable: manifest.kind === "database_set" && manifest.requiredPaths.length > 0 },
  manifest,
});

const createRecoveryCheckpoint = async ({ inventory, backupsDir, operationId, sourceBuild, targetBuild, includeDatabases = false, isLeaseValid = () => true, isQuiet = () => true, onProgress, fsModule = fs, nowFn = Date.now, budgetMs = includeDatabases ? kDatabaseBudgetMs : kConfigBudgetMs, signal } = {}) => {
  budgetMs = Math.min(budgetMs, includeDatabases ? kDatabaseBudgetMs : kConfigBudgetMs);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) fail("CHECKPOINT_INVALID_INPUT");
  const started = nowFn();
  const check = () => {
    if (signal?.aborted) fail("CHECKPOINT_CANCELLED");
    if (!isLeaseValid()) fail("CHECKPOINT_LEASE_LOST");
    if (!isQuiet()) fail("CHECKPOINT_QUIET_LOST");
    if (nowFn() - started >= budgetMs) fail("CHECKPOINT_BUDGET");
  };
  check();
  if (!operationId || !sourceBuild || !targetBuild || !inventory || !Array.isArray(inventory.files) || !Array.isArray(inventory.dbs)) fail("CHECKPOINT_INVALID_INPUT");
  inventory = structuredClone(inventory);
  sourceBuild = structuredClone(sourceBuild);
  targetBuild = structuredClone(targetBuild);
  if (inventory.files.length > kFileCount) fail("CHECKPOINT_LIMIT");
  if (inventory.dbs.length > 512) fail("CHECKPOINT_LIMIT");
  if (inventory.databaseSetComplete === false || new Set(inventory.dbs.map((entry) => entry.archivePath)).size !== inventory.dbs.length || inventory.dbs.some((entry) => !databasePathAllowed(entry.archivePath) || !["state", "agent"].includes(entry.dbKind))) fail("CHECKPOINT_INVALID_INPUT");
  const root = fsModule.realpathSync(inventory.stateDir);
  const configArchivePath = path.relative(root, fsModule.realpathSync(inventory.configPath)).split(path.sep).join("/");
  if (!safeRelative(configArchivePath) || !configArchivePath.endsWith(".json") || ["alphaclaw.json", "openclaw-channel-state.json"].includes(path.basename(configArchivePath))) fail("CHECKPOINT_CONFIG_REQUIRED");
  const requestedRoot = inventory.requestedStateDir || inventory.stateDir;
  const rootIdentity = identity(fsModule.statSync(root));
  const validateRoot = () => {
    if (fsModule.realpathSync(requestedRoot) !== root || !sameIdentity(fsModule.statSync(root), { dev: rootIdentity.dev, ino: rootIdentity.ino })) fail("CHECKPOINT_SOURCE_CHANGED");
  };
  validateRoot();
  const names = new Set();
  const inodes = new Set();
  const sources = new Map();
  const validateEntry = (entry, database) => {
    if (!safeRelative(entry.archivePath) || !(database ? databasePathAllowed(entry.archivePath) : configPathAllowed(entry.archivePath, configArchivePath)) || names.has(entry.archivePath)) fail("CHECKPOINT_UNSAFE_PATH");
    names.add(entry.archivePath);
    const source = checkPath(root, entry.archivePath, fsModule);
    if (fsModule.realpathSync(entry.sourcePath) !== source) fail("CHECKPOINT_SOURCE_ALIAS");
    const stat = fsModule.lstatSync(source);
    if (!stat.isFile() || stat.nlink !== 1 || !entry.sourceIdentity || !sameIdentity(stat, entry.sourceIdentity)) fail("CHECKPOINT_SOURCE_CHANGED");
    const inode = `${stat.dev}:${stat.ino}`;
    if (inodes.has(inode)) fail("CHECKPOINT_SOURCE_ALIAS");
    inodes.add(inode);
    sources.set(entry.archivePath, { source, stat: identity(stat), mode: stat.mode });
    return stat.size;
  };
  let configBytes = 0;
  for (const entry of inventory.files) {
    const size = validateEntry(entry, false);
    if (size > kFileBytes) fail("CHECKPOINT_LIMIT");
    configBytes += size;
  }
  if (configBytes > kTotalBytes) fail("CHECKPOINT_LIMIT");
  const config = inventory.files.find((entry) => entry.archivePath === configArchivePath);
  if (!config || fsModule.realpathSync(inventory.configPath) !== sources.get(configArchivePath).source) fail("CHECKPOINT_CONFIG_REQUIRED");
  let databaseBytes = 0;
  const sidecars = new Map();
  const sidecarModes = new Map();
  if (includeDatabases) {
    for (const entry of inventory.dbs) {
      databaseBytes += validateEntry(entry, true);
      const source = sources.get(entry.archivePath).source;
      for (const suffix of ["-wal", "-journal", "-shm"]) {
        sidecarModes.set(`${source}${suffix}`, sources.get(entry.archivePath).mode);
        try {
          const sidecar = `${source}${suffix}`;
          checkPath(root, `${entry.archivePath}${suffix}`, fsModule);
          const stat = fsModule.lstatSync(sidecar);
          if (!stat.isFile() || stat.nlink !== 1) fail("CHECKPOINT_SOURCE_ALIAS");
          databaseBytes += stat.size;
          const observed = suffix === "-shm" ? { dev: stat.dev, ino: stat.ino } : identity(stat);
          if (suffix === "-wal") delete observed.ctimeMs;
          sidecars.set(sidecar, { ...observed, mode: stat.mode });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sidecars.set(`${source}${suffix}`, null);
        }
      }
    }
  }
  const requestedBackups = path.resolve(backupsDir);
  let parent = requestedBackups;
  for (;;) {
    let stat;
    try { stat = fsModule.lstatSync(parent); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink() || fsModule.realpathSync(parent) !== parent) fail("CHECKPOINT_DESTINATION_ALIAS");
      break;
    }
    parent = path.dirname(parent);
  }
  fsModule.mkdirSync(requestedBackups, { recursive: true, mode: 0o700 });
  const canonicalBackups = fsModule.realpathSync(backupsDir);
  if (canonicalBackups !== requestedBackups || fsModule.lstatSync(requestedBackups).isSymbolicLink()) fail("CHECKPOINT_DESTINATION_ALIAS");
  const backupsFd = fsModule.openSync(requestedBackups, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try {
    const before = fsModule.fstatSync(backupsFd);
    fsModule.fchmodSync(backupsFd, 0o700);
    fsModule.fsyncSync(backupsFd);
    if ((fsModule.fstatSync(backupsFd).mode & 0o777) !== 0o700) fail("CHECKPOINT_PERMISSIONS");
    const named = fsModule.lstatSync(requestedBackups);
    if (!named.isDirectory() || named.dev !== before.dev || named.ino !== before.ino) fail("CHECKPOINT_DESTINATION_ALIAS");
  } finally { fsModule.closeSync(backupsFd); }
  if (includeDatabases) {
    const space = fsModule.statfsSync(canonicalBackups);
    if (Number(space.bavail) * Number(space.bsize) < (databaseBytes + configBytes) * 2 + 64 * kFileBytes) fail("CHECKPOINT_DISK_SPACE");
  }
  const id = `recovery-${randomUUID()}`;
  const staging = path.join(canonicalBackups, `.${id}.staging`);
  const file = path.join(canonicalBackups, id);
  fsModule.mkdirSync(staging, { mode: 0o700 });
  let published = false;
  try {
    const files = [];
    for (const entry of inventory.files) {
      check();
      if (nowFn() - started >= kConfigBudgetMs) fail("CHECKPOINT_BUDGET");
      validateRoot();
      const source = checkPath(root, entry.archivePath, fsModule);
      const captured = readBound(source, kFileBytes, fsModule, entry.sourceIdentity);
      privateParents(staging, `payload/${entry.archivePath}`, fsModule);
      writePrivate(path.join(staging, "payload", entry.archivePath), captured.data, fsModule);
      if (readBound(path.join(staging, "payload", entry.archivePath), kFileBytes, fsModule).sha256 !== captured.sha256) fail("CHECKPOINT_PAYLOAD_INVALID");
      files.push({ archivePath: entry.archivePath, kind: entry.kind, bytes: captured.data.length, sha256: captured.sha256, sourcePath: entry.sourcePath, sourceIdentity: captured.sourceIdentity, publishedIdentity: identity(fsModule.statSync(path.join(staging, "payload", entry.archivePath))) });
      onProgress?.({ phase: "config", fileCount: files.length, bytes: captured.data.length });
      await tick();
    }
    if (nowFn() - started >= kConfigBudgetMs) fail("CHECKPOINT_BUDGET");
    const databases = [];
    for (const entry of includeDatabases ? inventory.dbs : []) {
      check();
      const source = checkPath(root, entry.archivePath, fsModule);
      const fd = fsModule.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(fsModule.fstatSync(fd), sources.get(entry.archivePath).stat)) fail("CHECKPOINT_SOURCE_CHANGED");
        privateParents(staging, `payload/${entry.archivePath}`, fsModule);
        const destination = path.join(staging, "payload", entry.archivePath);
        const snapshotStartedAt = new Date(nowFn()).toISOString();
        const copied = await runDatabaseWorker({ source, destination, check, onProgress: (progress) => onProgress?.({ phase: "database", archivePath: entry.archivePath, ...progress }) });
        check();
        if (!sameIdentity(fsModule.fstatSync(fd), sources.get(entry.archivePath).stat)) fail("CHECKPOINT_SOURCE_CHANGED");
        fsModule.chmodSync(destination, 0o600);
        syncPath(destination, fsModule);
        databases.push({ ...dbInventory([entry])[0], ...copied, publishedIdentity: identity(fsModule.statSync(destination)), capturedSourceIdentity: sources.get(entry.archivePath).stat, snapshotStartedAt, snapshotCompletedAt: new Date(nowFn()).toISOString() });
      } finally { fsModule.closeSync(fd); }
    }
    check();
    validateRoot();
    for (const entry of [...files, ...databases]) {
      const source = checkPath(root, entry.archivePath, fsModule);
      if (!sameIdentity(fsModule.lstatSync(source), sources.get(entry.archivePath).stat)) fail("CHECKPOINT_SOURCE_CHANGED");
      const payload = checkPath(staging, `payload/${entry.archivePath}`, fsModule);
      if (!sameIdentity(fsModule.lstatSync(payload), entry.publishedIdentity)) fail("CHECKPOINT_PAYLOAD_CHANGED");
    }
    for (const [sidecar, before] of sidecars) {
      let after = null;
      try { after = fsModule.lstatSync(sidecar); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (after && (!after.isFile() || after.nlink !== 1)) fail("CHECKPOINT_SOURCE_ALIAS");
      if (before && (!after || !sameIdentity(after, before))) fail("CHECKPOINT_SOURCE_CHANGED");
      if (!before && after) {
        const readSidecar = sidecar.endsWith("-shm") || sidecar.endsWith("-wal") && after.size === 0;
        if (!readSidecar || ((after.mode & 0o777) & ~(sidecarModes.get(sidecar) & 0o777))) fail("CHECKPOINT_SOURCE_CHANGED");
      }
    }
    const manifest = { format: kFormat, version: 1, id, operationId, sourceBuild, targetBuild, createdAt: new Date(nowFn()).toISOString(), kind: includeDatabases ? "database_set" : "config_only", stateDir: root, requestedStateDir: requestedRoot, configArchivePath, rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino }, files, databases, requiredPaths: inventory.dbs.map((entry) => entry.archivePath).sort(), inventoryDigest: inventoryDigest(inventory.dbs), discoveredDatabaseCount: inventory.dbs.length };
    const raw = JSON.stringify(manifest);
    if (Buffer.byteLength(raw) > kFileBytes) fail("CHECKPOINT_LIMIT");
    writePrivate(path.join(staging, "manifest.json"), raw, fsModule);
    if (readBound(path.join(staging, "manifest.json"), kFileBytes, fsModule).sha256 !== digest(raw)) fail("CHECKPOINT_MANIFEST_INVALID");
    const directories = new Set([staging]);
    for (const entry of [...files, ...databases]) {
      let dir = path.dirname(path.join(staging, "payload", entry.archivePath));
      while (dir !== staging) { directories.add(dir); dir = path.dirname(dir); }
    }
    for (const dir of [...directories].sort((a, b) => b.length - a.length)) syncPath(dir, fsModule);
    writePrivate(path.join(staging, "ready.json"), JSON.stringify({ id, manifestSha256: digest(raw) }), fsModule);
    syncPath(staging, fsModule);
    check();
    fsModule.renameSync(staging, file);
    published = true;
    syncPath(canonicalBackups, fsModule);
    return resultFor(file, manifest);
  } catch (error) {
    fsModule.rmSync(published ? file : staging, { recursive: true, force: true });
    throw error;
  }
};

const readRecoveryCheckpoint = async (file, { fsModule = fs, nowFn = Date.now, budgetMs = kDatabaseBudgetMs, isLeaseValid = () => true, isQuiet = () => true, signal, operationId, sourceBuild, targetBuild, inventory } = {}) => {
  budgetMs = Math.min(budgetMs, kDatabaseBudgetMs);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) fail("CHECKPOINT_INVALID_INPUT");
  const started = nowFn();
  const check = () => {
    if (signal?.aborted) fail("CHECKPOINT_CANCELLED");
    if (!isLeaseValid()) fail("CHECKPOINT_LEASE_LOST");
    if (!isQuiet()) fail("CHECKPOINT_QUIET_LOST");
    if (nowFn() - started >= budgetMs) fail("CHECKPOINT_BUDGET");
  };
  check();
  if (!kIdPattern.test(path.basename(file)) || fsModule.lstatSync(file).isSymbolicLink()) fail("CHECKPOINT_NOT_READY");
  const root = fsModule.realpathSync(file);
  if (fsModule.statSync(root).mode & 0o077) fail("CHECKPOINT_PERMISSIONS");
  const read = (relative, limit) => {
    const target = checkPath(root, relative, fsModule, true);
    if (fsModule.statSync(target).mode & 0o077) fail("CHECKPOINT_PERMISSIONS");
    return readBound(target, limit, fsModule);
  };
  let ready;
  let manifest;
  const raw = read("manifest.json", kFileBytes).data;
  try {
    ready = JSON.parse(read("ready.json", kFileBytes).data);
    manifest = JSON.parse(raw);
  } catch { fail("CHECKPOINT_MANIFEST_INVALID"); }
  if (ready.id !== path.basename(file) || ready.manifestSha256 !== digest(raw) || manifest.id !== ready.id || manifest.format !== kFormat || manifest.version !== 1 || !["config_only", "database_set"].includes(manifest.kind) || !manifest.operationId || !manifest.sourceBuild || !manifest.targetBuild || !Array.isArray(manifest.files) || !Array.isArray(manifest.databases)) fail("CHECKPOINT_MANIFEST_INVALID");
  for (const [expected, actual] of [[operationId, manifest.operationId], [sourceBuild, manifest.sourceBuild], [targetBuild, manifest.targetBuild]]) {
    if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(actual)) fail("CHECKPOINT_BINDING_MISMATCH");
  }
  if (manifest.kind === "config_only") budgetMs = Math.min(budgetMs, kConfigBudgetMs);
  if (!Array.isArray(manifest.requiredPaths) || manifest.requiredPaths.length !== manifest.discoveredDatabaseCount || new Set(manifest.requiredPaths).size !== manifest.requiredPaths.length || !manifest.requiredPaths.every((entry) => safeRelative(entry) && databasePathAllowed(entry))) fail("CHECKPOINT_MANIFEST_INVALID");
  if (inventory && (inventoryDigest(inventory.dbs) !== manifest.inventoryDigest || JSON.stringify(inventory.dbs.map((entry) => entry.archivePath).sort()) !== JSON.stringify([...manifest.requiredPaths].sort()))) fail("CHECKPOINT_BINDING_MISMATCH");
  if (inventory && (inventory.files.length !== manifest.files.length || inventory.files.some((expected) => {
    const entry = manifest.files.find((candidate) => candidate.archivePath === expected.archivePath);
    return !entry || entry.sourcePath !== expected.sourcePath || !sameIdentity(entry.sourceIdentity, expected.sourceIdentity) || (expected.sourceIdentity?.sha256 && expected.sourceIdentity.sha256 !== entry.sha256);
  }))) fail("CHECKPOINT_BINDING_MISMATCH");
  if (!safeRelative(manifest.configArchivePath) || !manifest.configArchivePath.endsWith(".json") || ["alphaclaw.json", "openclaw-channel-state.json"].includes(path.basename(manifest.configArchivePath)) || manifest.files.length > kFileCount || !manifest.files.some((entry) => entry.archivePath === manifest.configArchivePath) || manifest.files.reduce((sum, entry) => sum + entry.bytes, 0) > kTotalBytes) fail("CHECKPOINT_MANIFEST_INVALID");
  if (manifest.kind === "config_only" ? manifest.databases.length !== 0 : manifest.databases.length !== manifest.discoveredDatabaseCount || inventoryDigest(manifest.databases) !== manifest.inventoryDigest) fail("CHECKPOINT_MANIFEST_INVALID");
  if (manifest.kind === "database_set" && JSON.stringify(manifest.databases.map((entry) => entry.archivePath).sort()) !== JSON.stringify([...manifest.requiredPaths].sort())) fail("CHECKPOINT_MANIFEST_INVALID");
  const names = new Set();
  for (const entry of [...manifest.files, ...manifest.databases]) {
    check();
    const database = manifest.databases.includes(entry);
    if (!safeRelative(entry.archivePath) || !(database ? databasePathAllowed(entry.archivePath) : configPathAllowed(entry.archivePath, manifest.configArchivePath)) || names.has(entry.archivePath) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail("CHECKPOINT_MANIFEST_INVALID");
    names.add(entry.archivePath);
    if (!database) {
      const captured = read(`payload/${entry.archivePath}`, kFileBytes);
      if (captured.data.length !== entry.bytes || captured.sha256 !== entry.sha256) fail("CHECKPOINT_PAYLOAD_INVALID");
    } else {
      if (!["state", "agent"].includes(entry.dbKind)) fail("CHECKPOINT_MANIFEST_INVALID");
      const destination = checkPath(root, `payload/${entry.archivePath}`, fsModule, true);
      const before = fsModule.lstatSync(destination);
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.size !== entry.bytes) fail("CHECKPOINT_PAYLOAD_INVALID");
      for (const suffix of ["-wal", "-shm", "-journal"]) if (fsModule.existsSync(`${destination}${suffix}`)) fail("CHECKPOINT_PAYLOAD_INVALID");
      const verified = await runDatabaseWorker({ destination, verifyOnly: true, check });
      if (!sameIdentity(fsModule.lstatSync(destination), identity(before)) || verified.sha256 !== entry.sha256 || verified.userVersion !== entry.userVersion || entry.integrity !== "ok") fail("CHECKPOINT_PAYLOAD_INVALID");
    }
    await tick();
  }
  check();
  return resultFor(file, manifest, digest(raw));
};

const inspectRecoveryCheckpoint = (file, { fsModule = fs, record, backupsDir } = {}) => {
  try {
    if (!record || record.checkpoint?.verified !== true || !backupsDir || typeof file !== "string" || !kIdPattern.test(path.basename(file))) fail("CHECKPOINT_NOT_READY");
    const backupsRoot = fsModule.realpathSync(backupsDir);
    const root = path.join(backupsRoot, path.basename(file));
    if (path.resolve(file) !== root || fsModule.realpathSync(file) !== root || fsModule.lstatSync(file).isSymbolicLink() || !fsModule.statSync(file).isDirectory() || fsModule.statSync(file).mode & 0o077) fail("CHECKPOINT_UNSAFE_PATH");
    if (record.checkpoint.file !== file || record.file !== undefined && record.file !== file || record.checkpoint.id !== path.basename(file) || !/^[a-f0-9]{64}$/.test(record.checkpoint.manifestSha256 || "")) fail("CHECKPOINT_BINDING_MISMATCH");
    const readMetadata = (relative) => {
      const target = checkPath(root, relative, fsModule, true);
      if (fsModule.statSync(target).mode & 0o077) fail("CHECKPOINT_PERMISSIONS");
      return readBound(target, kFileBytes, fsModule).data;
    };
    const raw = readMetadata("manifest.json");
    const ready = JSON.parse(readMetadata("ready.json"));
    const manifest = JSON.parse(raw);
    const sha256 = digest(raw);
    if (record.checkpoint.manifestSha256 !== sha256 || ready.manifestSha256 !== sha256 || ready.id !== path.basename(file) || manifest.id !== ready.id || manifest.format !== kFormat || manifest.version !== 1) fail("CHECKPOINT_BINDING_MISMATCH");
    const forwardOnly = record.kind === "forward_only" && manifest.kind === "config_only";
    if (manifest.kind !== record.kind && !forwardOnly || !["config_only", "database_set"].includes(manifest.kind) || !manifest.operationId || !manifest.sourceBuild || !manifest.targetBuild) fail("CHECKPOINT_MANIFEST_INVALID");
    for (const key of ["operationId", "sourceBuild", "targetBuild"]) {
      if (JSON.stringify(record.checkpoint[key]) !== JSON.stringify(manifest[key])) fail("CHECKPOINT_BINDING_MISMATCH");
    }
    if (!Array.isArray(manifest.files) || !Array.isArray(manifest.databases) || manifest.files.length > kFileCount || manifest.databases.length > 512 || !Array.isArray(manifest.requiredPaths) || manifest.requiredPaths.length > 512 || !safeRelative(manifest.configArchivePath) || !manifest.files.some((entry) => entry.archivePath === manifest.configArchivePath)) fail("CHECKPOINT_MANIFEST_INVALID");
    if (record.checkpoint.fileCount !== manifest.files.length || record.checkpoint.bytes !== manifest.files.reduce((sum, entry) => sum + entry.bytes, 0) || record.checkpoint.bytes > kTotalBytes || record.databases?.inventoryDigest !== manifest.inventoryDigest || JSON.stringify(record.databases?.requiredPaths) !== JSON.stringify(manifest.requiredPaths) || manifest.requiredPaths.length !== manifest.discoveredDatabaseCount || new Set(manifest.requiredPaths).size !== manifest.requiredPaths.length || !manifest.requiredPaths.every(databasePathAllowed)) fail("CHECKPOINT_BINDING_MISMATCH");
    if (manifest.kind === "config_only" ? manifest.databases.length !== 0 : manifest.databases.length !== manifest.requiredPaths.length || inventoryDigest(manifest.databases) !== manifest.inventoryDigest || JSON.stringify(manifest.databases.map((entry) => entry.archivePath).sort()) !== JSON.stringify([...manifest.requiredPaths].sort())) fail("CHECKPOINT_MANIFEST_INVALID");
    const complete = manifest.kind === "database_set" && manifest.requiredPaths.length > 0;
    if (record.databases.complete !== complete || record.databases.verified !== complete) fail("CHECKPOINT_BINDING_MISMATCH");
    if (JSON.stringify(record.databases?.entries) !== JSON.stringify(manifest.databases.map((entry) => ({ ...entry, path: entry.archivePath, verified: true })))) fail("CHECKPOINT_BINDING_MISMATCH");
    const names = new Set();
    for (const entry of [...manifest.files, ...manifest.databases]) {
      const database = manifest.databases.includes(entry);
      if (!safeRelative(entry.archivePath) || !(database ? databasePathAllowed(entry.archivePath) : configPathAllowed(entry.archivePath, manifest.configArchivePath)) || names.has(entry.archivePath) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !database && entry.bytes > kFileBytes || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) fail("CHECKPOINT_MANIFEST_INVALID");
      names.add(entry.archivePath);
      const payload = checkPath(root, `payload/${entry.archivePath}`, fsModule, true);
      const stat = fsModule.lstatSync(payload);
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || !entry.publishedIdentity || !["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => Number.isFinite(entry.publishedIdentity[key])) || !sameIdentity(stat, entry.publishedIdentity) || stat.size !== entry.bytes) fail("CHECKPOINT_PAYLOAD_CHANGED");
      if (database) {
        if (!["state", "agent"].includes(entry.dbKind) || entry.integrity !== "ok" || !Number.isSafeInteger(entry.userVersion)) fail("CHECKPOINT_MANIFEST_INVALID");
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          try { fsModule.lstatSync(`${payload}${suffix}`); fail("CHECKPOINT_PAYLOAD_CHANGED"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
    }
    const recovery = resultFor(file, manifest, sha256);
    if (forwardOnly) recovery.kind = "forward_only";
    return { ok: true, reason: null, recovery };
  } catch (error) {
    return { ok: false, reason: error.code || "CHECKPOINT_MANIFEST_INVALID" };
  }
};

module.exports = { createRecoveryCheckpoint, readRecoveryCheckpoint, verifyRecoveryCheckpoint: readRecoveryCheckpoint, inspectRecoveryCheckpoint };
