const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isDeepStrictEqual } = require("node:util");
const { isSqliteArtifactContractCurrent } = require("./openclaw-sqlite-artifacts");
const { readRegularFileBounded } = require("./utils/bounded-file");

const isDatabaseHold = (hold) => ["state_db_unverified", "state_db_unreadable"].includes(hold?.reason);
const boundedString = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const normalizeDatabaseBaseline = (value) => {
  if (!value || value.version !== 1 || !Array.isArray(value.databases) || value.databases.length > 512 ||
      typeof value.identity !== "string" || !/^[a-f0-9]{64}$/.test(value.identity) || !boundedString(value.stateDir) || !boundedString(value.requestedStateDir) || !boundedString(value.configPath) ||
      ![value.stateDir, value.requestedStateDir, value.configPath].every((file) => path.isAbsolute(file)) ||
      (value.configDigest !== null && !/^[a-f0-9]{64}$/.test(value.configDigest))) return null;
  const databases = [];
  const seen = new Set();
  for (const row of value.databases) {
    if (!boundedString(row?.path) || path.isAbsolute(row.path) || row.path.split(/[\\/]/).includes("..") ||
        !["state", "agent"].includes(row.dbKind) ||
        (row.dbKind === "agent" && (typeof row.agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.agentId) || ["__proto__", "constructor", "prototype"].includes(row.agentId))) ||
        (row.dbKind === "state" && row.agentId != null) || seen.has(row.path)) return null;
    seen.add(row.path);
    databases.push({ path: row.path, dbKind: row.dbKind, agentId: row.agentId || null });
  }
  return { version: 1, identity: value.identity, stateDir: value.stateDir, requestedStateDir: value.requestedStateDir,
    configPath: value.configPath, configDigest: value.configDigest, databases };
};
const normalizeDatabasePending = (value) => {
  const baseline = normalizeDatabaseBaseline(value?.baseline);
  if (!baseline || !boundedString(value?.recoveryId)) return null;
  return { recoveryId: value.recoveryId, baseline, at: Number.isFinite(value.at) ? value.at : null };
};
const verificationIdentity = ({ inventory, build, fsModule = fs }) => {
  if (!inventory || !build?.buildId || !build.packageDir || !build.bin) return null;
  const statIdentity = (file) => {
    const stat = fsModule.statSync(file);
    if (!stat.isFile()) throw new Error("Executing build metadata is not a regular file");
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  };
  try {
    const root = fsModule.realpathSync(inventory.requestedStateDir || inventory.stateDir);
    if (root !== inventory.stateDir) return null;
    const rootStat = fsModule.statSync(root);
    if (inventory.rootIdentity && (inventory.rootIdentity.dev !== rootStat.dev || inventory.rootIdentity.ino !== rootStat.ino)) return null;
    let digest = null;
    try {
      digest = crypto.createHash("sha256").update(readRegularFileBounded(inventory.configPath, { fsModule, encoding: null })).digest("hex");
    } catch (error) { if (error.code !== "ENOENT") return null; }
    if (inventory.configDigest !== undefined && digest !== inventory.configDigest) return null;
    return crypto.createHash("sha256").update(JSON.stringify({
      requestedStateDir: inventory.requestedStateDir || root, root, rootIdentity: [rootStat.dev, rootStat.ino],
      configPath: inventory.configPath, configDigest: digest,
      build: [build.buildId, build.version, build.packageDir, build.bin, build.source],
      packageIdentity: statIdentity(path.join(build.packageDir, "package.json")), binIdentity: statIdentity(build.bin),
    })).digest("hex");
  } catch { return null; }
};
const captureDatabaseBaseline = ({ verdict, fsModule = fs }) => {
  const inventory = verdict?.inventory;
  const identity = verificationIdentity({ inventory, build: verdict?.executingBuild, fsModule });
  if (!identity || !Array.isArray(inventory?.dbs)) return null;
  return normalizeDatabaseBaseline({ version: 1, identity, stateDir: inventory.stateDir, requestedStateDir: inventory.requestedStateDir || inventory.stateDir,
    configPath: inventory.configPath, configDigest: inventory.configDigest,
    databases: inventory.dbs.map((row) => ({ path: row.archivePath || path.relative(inventory.stateDir, row.sourcePath), dbKind: row.dbKind, agentId: row.agentId })) });
};
const databaseObservationIsCurrent = ({ inventory, fsModule = fs }) => {
  try {
    if (!inventory?.dbs?.length || inventory.dbs.length > 512) return false;
    if (inventory.excludedArtifacts?.length && !isSqliteArtifactContractCurrent(inventory.artifactContract, { fsModule })) return false;
    for (const row of inventory.dbs) {
      if (!row.sourceIdentity || !row.sourcePath) return false;
      const relative = path.relative(inventory.stateDir, row.sourcePath);
      if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) return false;
      let named = inventory.stateDir;
      const parts = relative.split(path.sep);
      for (let index = 0; index < parts.length; index++) {
        named = path.join(named, parts[index]);
        const stat = fsModule.lstatSync(named);
        if (index < parts.length - 1) { if (!stat.isDirectory() || stat.isSymbolicLink()) return false; }
        else if (!stat.isFile() || stat.size < 100 || stat.nlink !== 1 || stat.dev !== row.sourceIdentity.dev || stat.ino !== row.sourceIdentity.ino) return false;
      }
    }
    return true;
  } catch { return false; }
};
const checkDatabaseBaseline = ({ baseline, verdict, fsModule = fs, manual = false }) => {
  const current = captureDatabaseBaseline({ verdict, fsModule });
  if (!current || verdict?.complete !== true || verdict?.inventory?.databaseSetComplete !== true) return { ok: false, code: "recovery_inventory_incomplete" };
  if (!baseline && !manual) return { ok: false, code: "recovery_baseline_unavailable" };
  if (!current.databases.length || (verdict.inventory.skipped || []).some((row) => row.kind === "missing-registry-database")) return { ok: false, code: "required_database_missing" };
  if (!baseline) {
    const expected = verdict.inventory.expectedDatabases;
    if (!Array.isArray(expected) || !expected.length || expected.length > 512) return { ok: false, code: "recovery_baseline_unavailable" };
    for (const row of expected) {
      if (row.present !== true || !["canonical", "registry"].includes(row.ownership) ||
          !current.databases.some((db) => db.path === row.archivePath && db.dbKind === row.dbKind && db.agentId === (row.agentId || null)) ||
          !verdict.perDb?.some((db) => db.sourcePath === row.sourcePath && db.dbKind === row.dbKind && (db.agentId || null) === (row.agentId || null) && db.compatible === true && db.migrationRequired === false)) {
        return { ok: false, code: "required_database_missing" };
      }
    }
  }
  if (baseline && baseline.identity !== current.identity) return { ok: false, code: "recovery_source_changed" };
  if (baseline && baseline.databases.some((expected) => !current.databases.some((row) => isDeepStrictEqual(row, expected)))) return { ok: false, code: "required_database_missing" };
  if (verdict.compatible !== true || verdict.migrationRequired !== false) return { ok: false, code: verdict.migrationRequired === true ? "recovery_choice_required" : "database_verification_failed" };
  return { ok: true, baseline: current };
};

const checkPendingApplyCoverage = ({ pending, inventory, verdict, fsModule = fs }) => {
  const baseline = normalizeDatabaseBaseline(pending?.baseline);
  if (!baseline || !baseline.databases.length) return { ok: false, code: "recovery_baseline_unavailable" };
  if (!inventory || inventory.databaseSetComplete !== true || verdict?.compatible !== true || verdict.migrationRequired == null) return { ok: false, code: "database_verification_failed" };
  if (baseline.stateDir !== inventory.stateDir || baseline.requestedStateDir !== inventory.requestedStateDir || baseline.configPath !== inventory.configPath) return { ok: false, code: "recovery_source_changed" };
  for (const expected of baseline.databases) {
    const entry = inventory.dbs.find((db) => db.archivePath === expected.path && db.dbKind === expected.dbKind && (db.agentId || null) === expected.agentId);
    if (!entry || !verdict.perDb?.some((row) => row.sourcePath === entry.sourcePath && row.dbKind === expected.dbKind &&
        (row.agentId || null) === expected.agentId && row.compatible === true && row.migrationRequired != null)) return { ok: false, code: "required_database_missing" };
  }
  if (!databaseObservationIsCurrent({ inventory, fsModule })) return { ok: false, code: "recovery_source_changed" };
  return { ok: true };
};

module.exports = { isDatabaseHold, normalizeDatabaseBaseline, normalizeDatabasePending, verificationIdentity, captureDatabaseBaseline, checkDatabaseBaseline, databaseObservationIsCurrent, checkPendingApplyCoverage };
