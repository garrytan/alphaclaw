const fs = require("fs");
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
  if (!integer(target) || (entry.dbKind === "state" ? ![15, 16, 17].includes(target) : entry.dbKind !== "agent" || ![17, 18, 19, 20, 21].includes(target))) return unknown("unsupported_target_schema_contract");
  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (!integer(userVersion)) return unknown("invalid_user_version");
  result.userVersion = userVersion;
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

process.umask(0o077);
process.once("message", (workerData) => {
  try {
    const perDb = [];
    const registry = [];
    for (const entry of workerData.dbs) {
      let db;
      try {
        const stat = fs.lstatSync(entry.sourcePath);
        if (!stat.isFile() || stat.dev !== entry.sourceIdentity.dev || stat.ino !== entry.sourceIdentity.ino) throw new Error("Recovery database identity changed");
        db = new DatabaseSync(entry.sourcePath, { readOnly: true });
        db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 100; BEGIN");
        let result;
        if (workerData.mode === "registry") {
          if (tableExists(db, "agent_databases")) {
            const rows = readRows(db.prepare("SELECT substr(agent_id, 1, 65) AS agent_id, substr(path, 1, 4097) AS path, typeof(agent_id) AS id_type, typeof(path) AS path_type FROM agent_databases"));
            if (rows.some((row) => row.id_type !== "text" || row.path_type !== "text")) throw new Error("Unsupported database registry storage type");
            registry.push(...rows);
          }
          if (registry.length > 512) throw new Error("Recovery registry row limit exceeded");
        } else result = inspect(db, entry, workerData.supported);
        const after = fs.lstatSync(entry.sourcePath);
        if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isFile()) throw new Error("Recovery database identity changed");
        if (result) perDb.push(result);
      } catch (error) {
        const { status, ...failure } = classifySqliteFailure(error, { exists: error.code !== "ENOENT" });
        if (workerData.mode === "registry") throw Object.assign(error, failure, { sourcePath: entry.sourcePath, status });
        perDb.push({ ...entry, status, error: failure, compatible: null, migrationRequired: null, reasons: [failure.code || error.message] });
      } finally { db?.close(); }
    }
    process.send({ perDb, registry });
  } catch (error) { process.send({ error: error.message, code: error.code, errcode: error.errcode, status: error.status, sourcePath: error.sourcePath }); }
});
