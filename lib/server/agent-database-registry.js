const fs = require("fs");
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
const kMaxDatabases = 50;

const fileBytes = (filePath, fsModule) => {
  try {
    const stat = fsModule.lstatSync(filePath);
    if (!stat.isFile()) return null;
    let total = Number(stat.size) || 0;
    try {
      total += Number(fsModule.lstatSync(filePath + "-wal").size) || 0;
    } catch {}
    return total;
  } catch {
    return null;
  }
};

// → { available, reason, databases: [{ agentId, path, bytes }] } where bytes
// is the file (and -wal) on disk, else the registry's size_bytes, else null.
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
        .prepare("SELECT agent_id AS agentId, path, size_bytes AS sizeBytes FROM agent_databases ORDER BY agent_id, path")
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
      const onDisk = fileBytes(String(row.path || ""), fsModule);
      const registered = Number.isFinite(Number(row.sizeBytes)) && row.sizeBytes !== null ? Number(row.sizeBytes) : null;
      return { agentId: String(row.agentId), path: String(row.path || ""), bytes: onDisk ?? registered };
    });
  return { available: true, reason: null, databases };
};

const formatBytes = (bytes) => (bytes === null ? "size unknown" : (bytes / 1e9).toFixed(bytes < 1e9 ? 2 : 1) + " GB");

const formatUnconfiguredAgentDatabasesLine = ({ databases }) =>
  "[alphaclaw] " + databases.length + " agent " + (databases.length === 1 ? "database belongs" : "databases belong") +
  " to no configured agent: " + databases.map((entry) => entry.agentId + " (" + formatBytes(entry.bytes) + ")").join(", ") +
  ". OpenClaw logs \"database is not a configured target\" for these at gateway start and leaves them untouched;" +
  " doctor --fix still includes them in its recovery copy. Nothing was deleted.";

module.exports = {
  formatUnconfiguredAgentDatabasesLine,
  readUnconfiguredAgentDatabases,
};
