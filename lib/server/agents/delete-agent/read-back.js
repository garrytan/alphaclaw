const { openReadonlyOpenclawStateDb, hasTable } = require("../../openclaw-state-db");
const { readOpenclawConfigForWrite } = require("../../openclaw-config");
const { withNormalizedAgentsConfig } = require("../shared");

// What OpenClaw's own state says about one agent, read only: is it in the
// config roster, which agent databases are registered for it, and its row in
// OpenClaw's deletion journal. The outcome of a delete is decided from these
// facts, never from the CLI's exit code alone: OpenClaw can answer with an
// error after it committed, and a timed-out call can still finish in the
// gateway. A fact that cannot be read is null, and an outcome that depends
// on it stays unknown.
const readDeletionFacts = ({
  openclawDir,
  agentId,
  fsModule,
  openStateDb = openReadonlyOpenclawStateDb,
}) => {
  let configured = null;
  try {
    const cfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR: openclawDir,
      cfg: readOpenclawConfigForWrite({ fsModule, openclawDir }),
    });
    configured = cfg.agents.list.some((entry) => String(entry.id || "").trim() === agentId);
  } catch {}
  let registered = null;
  let journal = null;
  let stateReadable = false;
  try {
    const handle = openStateDb({ openclawDir });
    if (handle) {
      try {
        registered = hasTable(handle.db, "agent_databases")
          ? handle.db.prepare("SELECT path FROM agent_databases WHERE agent_id = ? ORDER BY path").all(agentId).map((row) => String(row.path || ""))
          : [];
        if (hasTable(handle.db, "agent_deletion_journal")) {
          const row = handle.db
            .prepare("SELECT operation_id AS operationId, cleanup_completed AS cleanupCompleted, created_at AS createdAt FROM agent_deletion_journal WHERE agent_id = ?")
            .get(agentId);
          journal = row ? { operationId: String(row.operationId || ""), complete: Number(row.cleanupCompleted) === 1, createdAt: row.createdAt ?? null } : null;
        }
        stateReadable = true;
      } finally {
        handle.db.close();
      }
    } else {
      registered = [];
      stateReadable = true;
    }
  } catch {}
  return { configured, registered, journal, stateReadable };
};

// answer: { kind: "ok" | "error" | "none" } from the gateway call ("none":
// no readable answer — timed out, killed, or not JSON).
//   deleted            not configured, journal complete
//   cleanup_incomplete not configured, journal incomplete, after an answer
//   not_deleted        still configured after an explicit refusal, or after
//                      the settle window with no deletion record
//   config_only        not configured and no journal: removed outside OpenClaw
//   unknown            anything a fact or the answer cannot settle yet
const classifyDeletion = ({ facts, answer, settled = false }) => {
  if (facts.configured === null || !facts.stateReadable) return "unknown";
  if (!facts.configured) {
    if (facts.journal?.complete) return "deleted";
    if (facts.journal) return answer.kind === "none" && !settled ? "unknown" : "cleanup_incomplete";
    return "config_only";
  }
  if (answer.kind === "error" && !facts.journal) return "not_deleted";
  if (settled && !facts.journal) return "not_deleted";
  if (answer.kind === "error" && settled) return "not_deleted";
  return "unknown";
};

// Deletions OpenClaw journaled but did not finish (a failed purge or file
// move), whoever started them. Read only; [] when the journal can't be read.
const readIncompleteDeletions = ({ openclawDir, openStateDb = openReadonlyOpenclawStateDb }) => {
  try {
    const handle = openStateDb({ openclawDir });
    if (!handle) return [];
    try {
      if (!hasTable(handle.db, "agent_deletion_journal")) return [];
      return handle.db
        .prepare("SELECT agent_id AS agentId FROM agent_deletion_journal WHERE cleanup_completed = 0 ORDER BY agent_id LIMIT 50")
        .all()
        .map((row) => String(row.agentId || ""))
        .filter(Boolean);
    } finally {
      handle.db.close();
    }
  } catch {
    return [];
  }
};

module.exports = { readDeletionFacts, classifyDeletion, readIncompleteDeletions };
