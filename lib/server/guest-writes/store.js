const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { applyOperationalPragmas } = require("../db/pragmas");

// The broker's durable state (guest-writes/broker.db, 0600, root):
//   guest_claims  one row per claim the guard wrote, keyed by the sha256 of
//                 the claim ref (the ref itself is never stored), spent only
//                 by an accepted save and pruned after it expires;
//   guest_saves   one row per save, keyed by its idempotency key, with the
//                 request id of its current attempt, the slug, the audience
//                 member every later gbrain call goes on behalf of, and its
//                 state.
// Save states: submitting (sent, outcome not learned yet: reconciled by
// request id before any retry), retry (gbrain was busy; the same request id
// is reused), pending (accepted, not committed), saved, failed, deleted
// (retention removed it), orphaned (the member left the broker's
// may_act_for, so only the owner's host-side sweep can remove it).
const kLiveStates = ["submitting", "retry", "pending", "saved"];
// A save keeps its rendered page only until gbrain settles it, so a write
// that comes back as a slug conflict can be sent again under the next slug.
const kUnsettledStates = ["submitting", "retry", "pending"];

const createSchema = (db) => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS guest_claims (" +
      " ref_hash TEXT PRIMARY KEY," +
      " run_id TEXT NOT NULL," +
      " session_key TEXT NOT NULL," +
      " group_key TEXT NOT NULL," +
      " group_slug TEXT NOT NULL," +
      " member_slug TEXT NOT NULL," +
      " member_uid INTEGER NOT NULL," +
      " audience_member TEXT NOT NULL," +
      " sender_label TEXT NOT NULL," +
      " channel TEXT NOT NULL," +
      " created_at INTEGER NOT NULL," +
      " expires_at INTEGER NOT NULL," +
      " spent_at INTEGER);" +
      "CREATE INDEX IF NOT EXISTS guest_claims_expiry ON guest_claims (expires_at);" +
      "CREATE TABLE IF NOT EXISTS guest_saves (" +
      " idem_key TEXT PRIMARY KEY," +
      " request_id TEXT NOT NULL," +
      " attempt INTEGER NOT NULL DEFAULT 1," +
      " slug TEXT NOT NULL," +
      " state TEXT NOT NULL," +
      " kind TEXT NOT NULL," +
      " title TEXT NOT NULL," +
      " group_key TEXT NOT NULL," +
      " group_slug TEXT NOT NULL," +
      " member_slug TEXT NOT NULL," +
      " audience_member TEXT NOT NULL," +
      " day TEXT NOT NULL," +
      " file_rel TEXT," +
      " page_json TEXT," +
      " error_code TEXT," +
      " created_at INTEGER NOT NULL," +
      " updated_at INTEGER NOT NULL," +
      " promoted_at INTEGER," +
      " deleted_at INTEGER);" +
      "CREATE INDEX IF NOT EXISTS guest_saves_member ON guest_saves (group_key, member_slug, state);" +
      "CREATE INDEX IF NOT EXISTS guest_saves_slug ON guest_saves (slug);",
  );
};

const toSave = (row) =>
  row
    ? {
        idemKey: row.idem_key,
        requestId: row.request_id,
        attempt: row.attempt,
        slug: row.slug,
        state: row.state,
        kind: row.kind,
        title: row.title,
        groupKey: row.group_key,
        groupSlug: row.group_slug,
        memberSlug: row.member_slug,
        audienceMember: row.audience_member,
        day: row.day,
        fileRel: row.file_rel,
        page: row.page_json ? JSON.parse(row.page_json) : null,
        errorCode: row.error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        promotedAt: row.promoted_at,
        deletedAt: row.deleted_at,
      }
    : null;

const toClaim = (row) =>
  row
    ? {
        runId: row.run_id,
        sessionKey: row.session_key,
        groupKey: row.group_key,
        groupSlug: row.group_slug,
        memberSlug: row.member_slug,
        memberUid: row.member_uid,
        audienceMember: row.audience_member,
        senderLabel: row.sender_label,
        channel: row.channel,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        spentAt: row.spent_at,
      }
    : null;

const openGuestStore = ({ dbPath, now = Date.now, fsModule = fs }) => {
  fsModule.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  applyOperationalPragmas(db);
  createSchema(db);
  try {
    fsModule.chmodSync(dbPath, 0o600);
  } catch {}

  const liveList = kLiveStates.map(() => "?").join(", ");

  const insertClaim = (refHash, claim) => {
    const at = now();
    db.prepare(
      "INSERT INTO guest_claims (ref_hash, run_id, session_key, group_key, group_slug, member_slug, member_uid, audience_member, sender_label, channel, created_at, expires_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      refHash,
      claim.runId,
      claim.sessionKey,
      claim.groupKey,
      claim.groupSlug,
      claim.memberSlug,
      claim.memberUid,
      claim.audienceMember,
      claim.senderLabel,
      claim.channel,
      at,
      at + claim.ttlMs,
    );
  };

  const getClaim = (refHash) => toClaim(db.prepare("SELECT * FROM guest_claims WHERE ref_hash = ?").get(refHash));

  const spendClaim = (refHash) => {
    db.prepare("UPDATE guest_claims SET spent_at = ? WHERE ref_hash = ? AND spent_at IS NULL").run(now(), refHash);
  };

  const pruneClaims = () => db.prepare("DELETE FROM guest_claims WHERE expires_at < ?").run(now()).changes;

  const getSave = (idemKey) => toSave(db.prepare("SELECT * FROM guest_saves WHERE idem_key = ?").get(idemKey));

  const getSaveBySlug = (slug) => toSave(db.prepare("SELECT * FROM guest_saves WHERE slug = ? ORDER BY created_at DESC LIMIT 1").get(slug));

  const insertSave = (save) => {
    const at = now();
    db.prepare(
      "INSERT OR REPLACE INTO guest_saves (idem_key, request_id, attempt, slug, state, kind, title, group_key, group_slug, member_slug, audience_member, day, file_rel, page_json, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      save.idemKey,
      save.requestId,
      save.attempt,
      save.slug,
      save.state,
      save.kind,
      save.title,
      save.groupKey,
      save.groupSlug,
      save.memberSlug,
      save.audienceMember,
      save.day,
      save.fileRel ?? null,
      save.page ? JSON.stringify(save.page) : null,
      at,
      at,
    );
    return getSave(save.idemKey);
  };

  const updateSave = (idemKey, patch) => {
    const columns = { requestId: "request_id", attempt: "attempt", slug: "slug", state: "state", errorCode: "error_code", promotedAt: "promoted_at", deletedAt: "deleted_at", fileRel: "file_rel" };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(column + " = ?");
      values.push(patch[key]);
    }
    if (patch.state !== undefined && !kUnsettledStates.includes(patch.state)) sets.push("page_json = NULL");
    sets.push("updated_at = ?");
    values.push(now());
    db.prepare("UPDATE guest_saves SET " + sets.join(", ") + " WHERE idem_key = ?").run(...values, idemKey);
    return getSave(idemKey);
  };

  const countDaily = ({ groupKey, memberSlug, day }) =>
    db
      .prepare("SELECT COUNT(*) AS n FROM guest_saves WHERE group_key = ? AND member_slug = ? AND day = ? AND state IN (" + liveList + ", 'failed', 'deleted', 'orphaned')")
      .get(groupKey, memberSlug, day, ...kLiveStates).n;

  const countLive = ({ groupKey, memberSlug }) =>
    db.prepare("SELECT COUNT(*) AS n FROM guest_saves WHERE group_key = ? AND member_slug = ? AND state IN (" + liveList + ")").get(groupKey, memberSlug, ...kLiveStates).n;

  const countsByGroup = () => {
    const out = {};
    for (const row of db.prepare("SELECT group_key, state, COUNT(*) AS n FROM guest_saves GROUP BY group_key, state").all()) {
      out[row.group_key] = out[row.group_key] || {};
      out[row.group_key][row.state] = row.n;
    }
    return out;
  };

  const listExpired = ({ olderThan, limit = 100 }) =>
    db
      .prepare("SELECT * FROM guest_saves WHERE state IN ('pending', 'saved') AND promoted_at IS NULL AND updated_at < ? ORDER BY updated_at LIMIT ?")
      .all(olderThan, limit)
      .map(toSave);

  const listUnsettled = ({ limit = 100 } = {}) =>
    db.prepare("SELECT * FROM guest_saves WHERE state IN ('submitting', 'retry', 'pending') ORDER BY updated_at LIMIT ?").all(limit).map(toSave);

  const listFilesPastRestore = ({ deletedBefore, limit = 100 }) =>
    db
      .prepare("SELECT * FROM guest_saves WHERE file_rel IS NOT NULL AND ((state = 'deleted' AND deleted_at < ?) OR state = 'failed') ORDER BY updated_at LIMIT ?")
      .all(deletedBefore, limit)
      .map(toSave);

  const listOrphaned = () => db.prepare("SELECT * FROM guest_saves WHERE state = 'orphaned' ORDER BY updated_at").all().map(toSave);

  const close = () => {
    try {
      db.close();
    } catch {}
  };

  return {
    insertClaim,
    getClaim,
    spendClaim,
    pruneClaims,
    getSave,
    getSaveBySlug,
    insertSave,
    updateSave,
    countDaily,
    countLive,
    countsByGroup,
    listExpired,
    listUnsettled,
    listFilesPastRestore,
    listOrphaned,
    close,
  };
};

module.exports = { openGuestStore, kLiveStates };
