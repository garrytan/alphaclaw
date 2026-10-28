const fs = require("fs");
const path = require("path");
const { openReadonlyOpenclawStateDb, hasTable } = require("./openclaw-state-db");
const { withNormalizedAgentsConfig } = require("./agents/shared");

// The agent databases behind OpenClaw's gateway-start warning "Skipped
// openclaw-agent.sqlite: database is not a configured target": rows of the
// state database's agent_databases registry whose agent is not in the
// configured roster. OpenClaw leaves those files untouched at gateway start,
// but Doctor still inventories them (its recovery copy includes them). Read
// only, never changed: deleting agent data is the owner's call.
//
// OpenClaw matches a row to a configured agent by path; this compares agent
// ids, the part the owner can act on, so a configured agent's row under an
// unusual path is not reported here.
//
// OpenClaw 2026.10.8 registers paths relative to the state directory
// ("agents/<id>/agent/openclaw-agent.sqlite"), so a path is resolved against
// openclawDir, never the process's working directory. A registered file that
// is gone costs Doctor nothing (its recovery copy lists it as missing), so it
// is reported as missing rather than with the registry's stale size_bytes.
const kMaxDatabases = 50;

const fileBytes = (filePath, fsModule) => {
  let stat;
  try {
    stat = fsModule.lstatSync(filePath);
  } catch (error) {
    return error?.code === "ENOENT" ? { bytes: null, missing: true } : { bytes: null, missing: false };
  }
  if (!stat.isFile()) return { bytes: null, missing: false };
  let total = Number(stat.size) || 0;
  try {
    total += Number(fsModule.lstatSync(filePath + "-wal").size) || 0;
  } catch {}
  return { bytes: total, missing: false };
};

// → { available, reason, databases: [{ agentId, path, bytes, missing }] }
// where bytes is the file and its -wal on disk (null when it is missing or
// unreadable).
const readUnconfiguredAgentDatabases = ({
  openclawDir,
  config,
  fsModule = fs,
  openStateDb = openReadonlyOpenclawStateDb,
}) => {
  let rows;
  try {
    const handle = openStateDb({ openclawDir });
    if (!handle) return { available: false, reason: "no_state_db", databases: [] };
    try {
      if (!hasTable(handle.db, "agent_databases")) return { available: false, reason: "no_registry", databases: [] };
      rows = handle.db
        .prepare("SELECT agent_id AS agentId, path FROM agent_databases ORDER BY agent_id, path")
        .all();
    } finally {
      handle.db.close();
    }
  } catch (error) {
    return { available: false, reason: "unreadable", error: error.message, databases: [] };
  }
  const configured = new Set(
    withNormalizedAgentsConfig({ OPENCLAW_DIR: openclawDir, cfg: config }).agents.list
      .map((entry) => String(entry.id || "").trim())
      .filter(Boolean),
  );
  const databases = rows
    .filter((row) => row.agentId && !configured.has(String(row.agentId)))
    .slice(0, kMaxDatabases)
    .map((row) => {
      const registeredPath = String(row.path || "");
      const onDisk = registeredPath
        ? fileBytes(path.resolve(openclawDir, registeredPath), fsModule)
        : { bytes: null, missing: false };
      return { agentId: String(row.agentId), path: registeredPath, ...onDisk };
    });
  return { available: true, reason: null, databases };
};

const formatSize = ({ bytes, missing }) => {
  if (missing) return "file missing";
  if (bytes === null) return "size unknown";
  return bytes < 1e7 ? (bytes / 1e6).toFixed(1) + " MB" : (bytes / 1e9).toFixed(bytes < 1e9 ? 2 : 1) + " GB";
};

const formatUnconfiguredAgentDatabasesLine = ({ databases }) =>
  "[alphaclaw] " + databases.length + " agent " + (databases.length === 1 ? "database belongs" : "databases belong") +
  " to no configured agent: " + databases.map((entry) => entry.agentId + " (" + formatSize(entry) + ")").join(", ") +
  ". OpenClaw logs \"database is not a configured target\" for these at gateway start and leaves them untouched;" +
  " doctor --fix still includes them in its recovery copy. Nothing was deleted.";

module.exports = {
  formatUnconfiguredAgentDatabasesLine,
  readUnconfiguredAgentDatabases,
};
