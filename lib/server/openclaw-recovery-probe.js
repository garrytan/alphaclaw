const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { classifySqliteFailure } = require("./openclaw-schema-versions");

const tableExists = (db, name) => {
  const row = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name);
  if (row && row.type !== "table") throw new Error("Unsupported metadata table type");
  return !!row;
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const readRows = (statement, ...args) => {
  const rows = [];
  for (const row of statement.iterate(...args)) {
    if (rows.length >= 512) throw new Error("Recovery metadata row limit exceeded");
    rows.push(row);
  }
  return rows;
};
const inspect = (db, entry, supported) => {
  const result = { ...entry, compatible: null, migrationRequired: null, reasons: [] };
  const unknown = (reason) => ({ ...result, reasons: [reason] });
  const target = supported?.[entry.dbKind];
  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (!integer(userVersion)) return unknown("invalid_user_version");
  result.userVersion = userVersion;
  result.hasApplicationTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' LIMIT 1").get();
  result.empty = userVersion === 0 && !result.hasApplicationTables;
  let contentVersion = userVersion;
  if (entry.dbKind === "state" && tableExists(db, "config_machine_state")) {
    const row = db.prepare("SELECT substr(value_json, 1, 65) AS value_json, typeof(value_json) AS value_type FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'").get();
    if (row) {
      if (row.value_type !== "text" || row.value_json.length > 64) return unknown("invalid_content_version");
      const value = JSON.parse(row.value_json);
      if (!integer(value)) return unknown("invalid_content_version");
      contentVersion = Math.max(userVersion, value);
    }
  }
  result.contentVersion = contentVersion;
  if (!integer(target) || (entry.dbKind === "state" ? ![15, 16, 17].includes(target) : entry.dbKind !== "agent" || ![17, 18, 19, 20, 21].includes(target))) return unknown("unsupported_target_schema_contract");
  if (result.empty) return unknown("empty_database_unverified");
  if (contentVersion > target) return { ...result, compatible: false, migrationRequired: false, reasons: ["database_schema_newer_than_target"] };
  const meta = tableExists(db, "schema_meta") ? db.prepare("SELECT substr(role, 1, 32) AS role, CASE WHEN typeof(schema_version) = 'integer' THEN schema_version END AS schema_version, substr(agent_id, 1, 65) AS agent_id, typeof(agent_id) AS agent_type FROM schema_meta WHERE meta_key = 'primary'").get() : null;
  if (!meta || meta.role !== (entry.dbKind === "state" ? "global" : "agent") || meta.schema_version !== userVersion || (entry.dbKind === "agent" && (meta.agent_type !== "text" || meta.agent_id !== entry.agentId))) return unknown("database_owner_or_schema_metadata_mismatch");
  if (entry.dbKind === "state" ? ![15, 16, 17].includes(contentVersion) : ![17, 18, 19, 20, 21].includes(userVersion)) return unknown("unsupported_source_schema_contract");
  if (entry.dbKind === "state" && contentVersion === 16) {
    for (const [table, columns] of [["skill_workshop_collection_reviews", ["workspace_dir"]], ["skill_workshop_proposals", ["workspace_dir", "claim_released_time"]]]) {
      if (db.prepare("SELECT name FROM pragma_table_info(?)").all(table).some((row) => columns.includes(row.name))) return unknown("state_schema_16_requires_physical_shape_validation");
    }
  }
  if (entry.dbKind === "state" && tableExists(db, "update_runs")) {
    const now = Date.now();
    const rows = readRows(db.prepare("SELECT substr(run_id, 1, 256) AS run_id, substr(before_json, 1, 65537) AS before_json, status, updated_at_ms, finished_at_ms FROM update_runs WHERE (status = 'running' AND updated_at_ms >= ?) OR (status != 'running' AND (finished_at_ms > ? OR finished_at_ms IS NULL))"), now - 1800000, now - 300000);
    for (const row of rows) {
      if (typeof row.before_json !== "string" || row.before_json.length > 65536) return unknown("invalid_publication_marker");
      const before = JSON.parse(row.before_json);
      if (typeof before?.version === "string" && /^v?2026\.9\.2(?:[-+]|$)/.test(before.version)) {
        result.publicationBlocker = { runId: row.run_id, updaterVersion: before.version };
        return { ...result, reasons: ["state_schema_publication_blocked"] };
      }
    }
  }
  return { ...result, compatible: true, migrationRequired: contentVersion < target, deferredPublication: contentVersion > userVersion };
};

const inspectPath = (file) => {
  const parts = path.resolve(file).split(path.sep).filter(Boolean);
  let current = path.parse(path.resolve(file)).root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw Object.assign(new Error("Unsafe SQLite file or ancestor"), { code: "RECOVERY_SQLITE_UNSAFE_PATH" });
    }
    if (index === parts.length - 1) return stat;
  }
  throw new Error("Invalid SQLite file path");
};
const observeDatabase = (entry, callback) => {
  const names = [entry.sourcePath, ...["-wal", "-shm", "-journal"].map((suffix) => entry.sidecarPaths?.[suffix] || `${entry.sourcePath}${suffix}`)];
  const before = names.map(inspectPath);
  const stat = before[0];
  if (!stat || stat.dev !== entry.sourceIdentity.dev || stat.ino !== entry.sourceIdentity.ino) throw Object.assign(new Error("Recovery database identity changed"), { code: "RECOVERY_SQLITE_IDENTITY_CHANGED" });
  if (new Set(before.filter(Boolean).map((item) => `${item.dev}:${item.ino}`)).size !== before.filter(Boolean).length) throw new Error("Aliased SQLite sidecar");
  for (const [index, suffix] of ["-wal", "-shm", "-journal"].entries()) {
    const expected = entry.sidecarIdentities?.[suffix];
    const current = before[index + 1];
    if (expected && (!current || current.dev !== expected.dev || current.ino !== expected.ino || (current.mode & 0o777) & ~(expected.mode & 0o777))) throw Object.assign(new Error("Recovery SQLite sidecar identity changed"), { code: "RECOVERY_SQLITE_IDENTITY_CHANGED" });
    if (current && names[index + 1] !== `${entry.sourcePath}${suffix}`) throw Object.assign(new Error("Unsupported SQLite sidecar spelling"), { code: "RECOVERY_SQLITE_UNSAFE_PATH" });
  }
  let db;
  const mask = process.umask(0o777 & ~(stat.mode & 0o600));
  try {
    db = new DatabaseSync(entry.sourcePath, { readOnly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 100; BEGIN");
    const result = callback(db);
    db.close();
    db = null;
    for (let index = 0; index < names.length; index++) {
      const after = inspectPath(names[index]);
      const previous = before[index];
      if (previous && (!after || previous.dev !== after.dev || previous.ino !== after.ino || (after.mode & 0o777) & ~(previous.mode & 0o777))) throw Object.assign(new Error("Recovery SQLite identity or permissions changed"), { code: "RECOVERY_SQLITE_IDENTITY_CHANGED" });
      if (!previous && after && (index === 3 || (after.mode & 0o777) & ~(stat.mode & 0o777))) throw Object.assign(new Error("Unsafe SQLite coordination file creation"), { code: "RECOVERY_SQLITE_UNSAFE_PATH" });
    }
    return result;
  } finally { try { db?.close(); } finally { process.umask(mask); } }
};

const runProbe = (workerData) => {
  const perDb = [];
  const registry = [];
  for (const entry of workerData.dbs) {
    if (workerData.mode !== "registry" && entry.artifactReason) {
      perDb.push({ ...entry, compatible: null, migrationRequired: null, reasons: [entry.artifactReason] });
      continue;
    }
    try {
      const observed = observeDatabase(entry, (db) => {
        let result;
        if (workerData.mode === "registry") {
          if (tableExists(db, "agent_databases")) {
            const rows = readRows(db.prepare("SELECT substr(agent_id, 1, 65) AS agent_id, substr(path, 1, 4097) AS path, typeof(agent_id) AS id_type, typeof(path) AS path_type FROM agent_databases"));
            if (rows.some((row) => row.id_type !== "text")) throw new Error("Unsupported registry agent identity storage type");
            if (rows.some((row) => row.path_type !== "text")) throw new Error("Unsupported registry database path storage type");
            registry.push(...rows);
          }
          if (registry.length > 512) throw new Error("Recovery registry row limit exceeded");
        } else result = inspect(db, entry, workerData.supported);
        return result;
      });
      if (observed) perDb.push(observed);
    } catch (error) {
      const { status, ...failure } = classifySqliteFailure(error, { exists: error.code !== "ENOENT" });
      if (workerData.mode === "registry") throw Object.assign(error, failure, { sourcePath: entry.sourcePath, status });
      perDb.push({ ...entry, status, error: failure, compatible: null, migrationRequired: null, reasons: [failure.code || error.message] });
    }
  }
  return { perDb, registry };
};

if (require.main === module) {
  process.umask(0o077);
  process.once("message", async (workerData) => {
    try {
      const result = workerData.mode === "assessment"
        ? await require("./openclaw-recovery-assessment").runAssessmentInProcess(workerData.options)
        : runProbe(workerData);
      process.send(result);
    } catch (error) { process.send({ error: String(error.message).slice(0, 4096), code: error.code, errcode: error.errcode, status: error.status, sourcePath: error.sourcePath }); }
  });
}

module.exports = { runProbe, observeDatabase };
