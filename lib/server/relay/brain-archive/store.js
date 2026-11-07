const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { applyOperationalPragmas } = require("../../db/pragmas");

// The archive's durable state (relay/archive.db, 0600): which conversations
// changed since they were last saved to the brain, each page part's entries,
// last written hash and gbrain revision, a write that gbrain accepted but has
// not committed yet (its request id, never resubmitted), and the page paths
// waiting for the batch's gbrain git commit-push. A part's rendered page is
// kept only until gbrain commits it, so a retry sends the same bytes under
// the same request id.
//
// Conversation states: idle (saved), due (changed, waiting for the debounce),
// backoff (a retry is scheduled), parked (waits for a person's Retry).
const createSchema = (db) => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS archive_conversations (" +
      " conversation_id TEXT PRIMARY KEY," +
      " relay_agent TEXT NOT NULL," +
      " relay_peer TEXT NOT NULL," +
      " box_agent INTEGER NOT NULL DEFAULT 0," +
      " source_mark TEXT," +
      " state TEXT NOT NULL DEFAULT 'due'," +
      " code TEXT," +
      " attempts INTEGER NOT NULL DEFAULT 0," +
      " next_attempt_at INTEGER NOT NULL DEFAULT 0," +
      " last_activity_at INTEGER NOT NULL," +
      " dirty_since INTEGER," +
      " last_saved_at INTEGER," +
      " updated_at INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS archive_conversations_state ON archive_conversations (state, next_attempt_at);" +
      "CREATE TABLE IF NOT EXISTS archive_parts (" +
      " conversation_id TEXT NOT NULL," +
      " part INTEGER NOT NULL," +
      " slug TEXT NOT NULL UNIQUE," +
      " entry_ids TEXT NOT NULL," +
      " closed INTEGER NOT NULL DEFAULT 0," +
      " frozen INTEGER NOT NULL DEFAULT 0," +
      " saved_hash TEXT," +
      " saved_bytes INTEGER NOT NULL DEFAULT 0," +
      " revision TEXT," +
      " pending_markdown TEXT," +
      " pending_hash TEXT," +
      " request_id TEXT," +
      " request_pending INTEGER NOT NULL DEFAULT 0," +
      " saved_at INTEGER," +
      " PRIMARY KEY (conversation_id, part));" +
      "CREATE TABLE IF NOT EXISTS archive_commits (path TEXT PRIMARY KEY, queued_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS archive_peer_usage (peer TEXT NOT NULL, day TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (peer, day));" +
      "CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT);",
  );
};

const toConversation = (row) =>
  row
    ? {
        conversationId: row.conversation_id,
        relayAgent: row.relay_agent,
        relayPeer: row.relay_peer,
        boxAgent: row.box_agent === 1,
        sourceMark: row.source_mark || null,
        state: row.state,
        code: row.code || null,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastActivityAt: row.last_activity_at,
        dirtySince: row.dirty_since || null,
        lastSavedAt: row.last_saved_at || null,
      }
    : null;

const toPart = (row) => ({
  conversationId: row.conversation_id,
  part: row.part,
  slug: row.slug,
  entryIds: JSON.parse(row.entry_ids || "[]"),
  closed: row.closed === 1,
  frozen: row.frozen === 1,
  savedHash: row.saved_hash || null,
  savedBytes: row.saved_bytes || 0,
  revision: row.revision || null,
  pendingMarkdown: row.pending_markdown || null,
  pendingHash: row.pending_hash || null,
  requestId: row.request_id || null,
  requestPending: row.request_pending === 1,
  savedAt: row.saved_at || null,
});

const kConversationColumns = Object.freeze({
  sourceMark: "source_mark",
  state: "state",
  code: "code",
  attempts: "attempts",
  nextAttemptAt: "next_attempt_at",
  lastActivityAt: "last_activity_at",
  dirtySince: "dirty_since",
  lastSavedAt: "last_saved_at",
});

const kPartColumns = Object.freeze({
  slug: "slug",
  closed: "closed",
  frozen: "frozen",
  savedHash: "saved_hash",
  savedBytes: "saved_bytes",
  revision: "revision",
  pendingMarkdown: "pending_markdown",
  pendingHash: "pending_hash",
  requestId: "request_id",
  requestPending: "request_pending",
  savedAt: "saved_at",
});

const previousWeek = (day) => new Date(Date.parse(day + "T00:00:00Z") - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const toDbValue = (value) => (typeof value === "boolean" ? (value ? 1 : 0) : value ?? null);

const openArchiveStore = ({ dbPath, now = Date.now, fsModule = fs }) => {
  fsModule.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  applyOperationalPragmas(db);
  createSchema(db);
  // Columns added after the first build of this table.
  const partColumns = new Set(db.prepare("PRAGMA table_info(archive_parts)").all().map((column) => column.name));
  if (!partColumns.has("frozen")) db.exec("ALTER TABLE archive_parts ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0");
  if (!partColumns.has("saved_bytes")) db.exec("ALTER TABLE archive_parts ADD COLUMN saved_bytes INTEGER NOT NULL DEFAULT 0");
  try {
    fsModule.chmodSync(dbPath, 0o600);
  } catch {}

  const getConversation = (conversationId) =>
    toConversation(db.prepare("SELECT * FROM archive_conversations WHERE conversation_id = ?").get(String(conversationId)));

  // A changed source mark makes the conversation due again (dirty_since
  // keeps its first unsaved change for the 15-minute cap). A parked
  // conversation stays parked: it waits for a person.
  const noteActivity = ({ conversationId, relayAgent, relayPeer, boxAgent, sourceMark }) => {
    const at = now();
    const existing = getConversation(conversationId);
    if (!existing) {
      db.prepare(
        "INSERT INTO archive_conversations (conversation_id, relay_agent, relay_peer, box_agent, source_mark, state, last_activity_at, dirty_since, updated_at)" +
          " VALUES (?, ?, ?, ?, ?, 'due', ?, ?, ?)",
      ).run(String(conversationId), relayAgent, relayPeer, boxAgent ? 1 : 0, sourceMark, at, at, at);
      return true;
    }
    if (existing.sourceMark === sourceMark) return false;
    db.prepare(
      "UPDATE archive_conversations SET source_mark = ?, last_activity_at = ?, dirty_since = COALESCE(dirty_since, ?)," +
        " state = CASE WHEN state = 'idle' THEN 'due' ELSE state END, updated_at = ? WHERE conversation_id = ?",
    ).run(sourceMark, at, at, at, String(conversationId));
    return true;
  };

  const updateConversation = (conversationId, fields) => {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(kConversationColumns)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      sets.push(column + " = ?");
      values.push(toDbValue(fields[key]));
    }
    sets.push("updated_at = ?");
    values.push(now(), String(conversationId));
    db.prepare("UPDATE archive_conversations SET " + sets.join(", ") + " WHERE conversation_id = ?").run(...values);
  };

  const listWorkable = (at = now()) =>
    db
      .prepare("SELECT * FROM archive_conversations WHERE state IN ('due', 'backoff') AND next_attempt_at <= ? ORDER BY last_activity_at, conversation_id")
      .all(at)
      .map(toConversation);

  const listParts = (conversationId) =>
    db.prepare("SELECT * FROM archive_parts WHERE conversation_id = ? ORDER BY part").all(String(conversationId)).map(toPart);

  const upsertPart = ({ conversationId, part, slug, entryIds, closed }) => {
    db.prepare(
      "INSERT INTO archive_parts (conversation_id, part, slug, entry_ids, closed) VALUES (?, ?, ?, ?, ?)" +
        " ON CONFLICT(conversation_id, part) DO UPDATE SET entry_ids = excluded.entry_ids, closed = excluded.closed",
    ).run(String(conversationId), part, slug, JSON.stringify(entryIds), closed ? 1 : 0);
  };

  const updatePart = (conversationId, part, fields) => {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(kPartColumns)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      sets.push(column + " = ?");
      values.push(toDbValue(fields[key]));
    }
    if (!sets.length) return;
    values.push(String(conversationId), part);
    db.prepare("UPDATE archive_parts SET " + sets.join(", ") + " WHERE conversation_id = ? AND part = ?").run(...values);
  };

  const queueCommit = (pagePath) =>
    db.prepare("INSERT INTO archive_commits (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING").run(pagePath, now());
  const listCommits = (limit = 100) =>
    db.prepare("SELECT path FROM archive_commits ORDER BY queued_at, path LIMIT ?").all(limit).map((row) => row.path);
  const clearCommits = (paths) => {
    const statement = db.prepare("DELETE FROM archive_commits WHERE path = ?");
    for (const pagePath of paths) statement.run(pagePath);
  };

  const getMeta = (key) => db.prepare("SELECT value FROM archive_meta WHERE key = ?").get(key)?.value ?? null;
  const setMeta = (key, value) =>
    db.prepare("INSERT INTO archive_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value === null ? null : String(value));

  // Retry from a person: every parked or backed-off conversation is due
  // now. A revision conflict (the page changed in the brain since this box
  // last wrote it) is the person's decision to replace it, so the stored
  // revision is dropped and the next write re-reads the page's revision.
  const retryAll = () => {
    const at = now();
    db.prepare("UPDATE archive_parts SET revision = NULL WHERE conversation_id IN (SELECT conversation_id FROM archive_conversations WHERE code = 'revision_conflict')").run();
    return db
      .prepare("UPDATE archive_conversations SET state = 'due', next_attempt_at = 0, attempts = 0, updated_at = ? WHERE state IN ('parked', 'backoff', 'due')")
      .run(at).changes;
  };

  const counts = () => {
    const out = { idle: 0, due: 0, backoff: 0, parked: 0 };
    for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM archive_conversations GROUP BY state").all()) out[row.state] = row.n;
    out.pendingWrites = db.prepare("SELECT COUNT(*) AS n FROM archive_parts WHERE request_pending = 1").get().n;
    out.pages = db.prepare("SELECT COUNT(*) AS n FROM archive_parts WHERE saved_hash IS NOT NULL").get().n;
    out.commitsQueued = db.prepare("SELECT COUNT(*) AS n FROM archive_commits").get().n;
    return out;
  };

  // Per-peer budget: bytes this box added to the peer's pages on one UTC day,
  // and the size of all of the peer's pages it saved.
  const peerUsage = (peer, day) => ({
    dayBytes: db.prepare("SELECT bytes FROM archive_peer_usage WHERE peer = ? AND day = ?").get(String(peer), String(day))?.bytes || 0,
    totalBytes:
      db
        .prepare("SELECT COALESCE(SUM(p.saved_bytes), 0) AS n FROM archive_parts p JOIN archive_conversations c ON c.conversation_id = p.conversation_id WHERE c.relay_peer = ?")
        .get(String(peer)).n || 0,
  });

  const addPeerBytes = (peer, day, bytes) => {
    if (!(bytes > 0)) return;
    db.prepare("INSERT INTO archive_peer_usage (peer, day, bytes) VALUES (?, ?, ?) ON CONFLICT(peer, day) DO UPDATE SET bytes = bytes + excluded.bytes").run(String(peer), String(day), bytes);
    db.prepare("DELETE FROM archive_peer_usage WHERE day < ?").run(previousWeek(day));
  };

  const overBudget = () =>
    db
      .prepare(
        "SELECT relay_peer AS peer, code, COUNT(*) AS n, MIN(next_attempt_at) AS resume_at FROM archive_conversations WHERE code IN ('peer_budget_daily', 'peer_budget_total') GROUP BY relay_peer, code ORDER BY relay_peer",
      )
      .all()
      .map((row) => ({ peer: row.peer, code: row.code, conversations: row.n, resumesAt: row.code === "peer_budget_daily" && row.resume_at ? row.resume_at : null }));

  const parkedCodes = () =>
    db.prepare("SELECT code, COUNT(*) AS n FROM archive_conversations WHERE state = 'parked' GROUP BY code ORDER BY n DESC").all().map((row) => ({ code: row.code, count: row.n }));

  return {
    getConversation,
    noteActivity,
    updateConversation,
    listWorkable,
    listParts,
    upsertPart,
    updatePart,
    queueCommit,
    listCommits,
    clearCommits,
    getMeta,
    setMeta,
    retryAll,
    counts,
    parkedCodes,
    peerUsage,
    addPeerBytes,
    overBudget,
    close: () => db.close(),
  };
};

module.exports = { openArchiveStore };
