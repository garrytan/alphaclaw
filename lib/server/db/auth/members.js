const crypto = require("crypto");

// Team-mode member store (4.1). All functions take the auth DatabaseSync
// handle via the factory so tests can run against a temp DB.
//
// Password hashing: scrypt with a per-member random 16-byte salt; the params
// used at hash time are persisted next to the hash so they can be raised for
// new passwords without invalidating existing ones.
const kScryptParams = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });
const kDefaultInviteTtlMs = 7 * 24 * 60 * 60 * 1000;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

// Strict enough to keep the value safe as an HTTP header (x-alphaclaw-user)
// and a strict-schema JSON key (gateway.auth identityScopes/allowUsers): only
// printable ASCII excluding @, space, and control chars (\x21-\x7e minus
// \x40), so CRLF injection AND non-ASCII bytes that Node rejects in a header
// (ERR_INVALID_CHAR, e.g. an emoji local-part) are both refused. Exactly one
// @, non-empty local + dotted domain, bounded length. The invite holder is
// the lowest-trust actor and controls this input at accept-invite (H2).
const kEmailPattern =
  /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/;
const assertValidEmail = (email) => {
  // Validate the RAW (pre-lowercase) input: some non-ASCII characters fold to
  // ASCII under toLowerCase (Kelvin U+212A -> "k", Latin small long s, etc.),
  // so normalizing first would let a non-ASCII input pass an ASCII-only
  // pattern. Test the raw bytes, THEN return the normalized value.
  const raw = String(email || "").trim();
  if (!raw || raw.length > 254 || !kEmailPattern.test(raw)) {
    throw Object.assign(new Error("A valid email address is required"), {
      code: "invalid_email",
    });
  }
  return raw.toLowerCase();
};

const hashPassword = (password, saltHex, params = kScryptParams) =>
  crypto
    .scryptSync(String(password), Buffer.from(saltHex, "hex"), params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      // Node caps memory at 32MiB by default; keep headroom for larger N.
      maxmem: 128 * 1024 * 1024,
    })
    .toString("hex");

const verifyPassword = (password, row) => {
  let params;
  try {
    params = JSON.parse(row.scrypt_params);
  } catch {
    return false;
  }
  const expected = Buffer.from(row.password_hash, "hex");
  const actual = Buffer.from(
    hashPassword(password, row.password_salt, params),
    "hex",
  );
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
};

const hashInviteToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

const toMemberModel = (row) => {
  if (!row) return null;
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name || ""),
    role: row.role === "admin" ? "admin" : "member",
    disabled: Number(row.disabled || 0) === 1,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
};

const toInviteModel = (row) => {
  if (!row) return null;
  return {
    id: String(row.id),
    email: row.email ? String(row.email) : null,
    role: row.role === "admin" ? "admin" : "member",
    createdBy: String(row.created_by || ""),
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
    usedAt: row.used_at == null ? null : Number(row.used_at),
    usedByMemberId: row.used_by_member_id
      ? String(row.used_by_member_id)
      : null,
  };
};

const createMembersStore = ({ getDb, nowFn = Date.now } = {}) => {
  const db = () => {
    const database = typeof getDb === "function" ? getDb() : null;
    if (!database) throw new Error("Auth DB not initialized");
    return database;
  };

  const getMemberRowByEmail = (email) =>
    db()
      .prepare("SELECT * FROM members WHERE email = $email COLLATE NOCASE LIMIT 1")
      .get({ $email: normalizeEmail(email) }) || null;

  const getMemberRowById = (id) =>
    db()
      .prepare("SELECT * FROM members WHERE id = $id LIMIT 1")
      .get({ $id: String(id || "") }) || null;

  const createMember = ({
    email,
    displayName = "",
    role = "member",
    password,
  }) => {
    const normalizedEmail = assertValidEmail(email);
    if (typeof password !== "string" || password.length < 8) {
      throw Object.assign(
        new Error("Password must be at least 8 characters"),
        { code: "weak_password" },
      );
    }
    if (getMemberRowByEmail(normalizedEmail)) {
      throw Object.assign(new Error("A member with that email already exists"), {
        code: "email_taken",
      });
    }
    const now = nowFn();
    const id = crypto.randomBytes(12).toString("hex");
    const salt = crypto.randomBytes(16).toString("hex");
    db()
      .prepare(
        `INSERT INTO members (
           id, email, display_name, role, password_hash, password_salt,
           scrypt_params, token_secret, disabled, created_at, updated_at
         ) VALUES (
           $id, $email, $display_name, $role, $password_hash, $password_salt,
           $scrypt_params, $token_secret, 0, $now, $now
         )`,
      )
      .run({
        $id: id,
        $email: normalizedEmail,
        $display_name: String(displayName || "").trim().slice(0, 120),
        $role: role === "admin" ? "admin" : "member",
        $password_hash: hashPassword(password, salt),
        $password_salt: salt,
        $scrypt_params: JSON.stringify(kScryptParams),
        $token_secret: crypto.randomBytes(32).toString("hex"),
        $now: now,
      });
    return toMemberModel(getMemberRowById(id));
  };

  const verifyMemberPassword = ({ email, password }) => {
    const row = getMemberRowByEmail(email);
    if (!row || Number(row.disabled || 0) === 1) return null;
    if (!verifyPassword(String(password || ""), row)) return null;
    return toMemberModel(row);
  };

  const getTokenSecret = (memberId) => {
    const row = getMemberRowById(memberId);
    if (!row || Number(row.disabled || 0) === 1) return null;
    return String(row.token_secret);
  };

  // Rotating the token secret revokes every session issued for the member.
  const rotateTokenSecret = (memberId) => {
    const result = db()
      .prepare(
        "UPDATE members SET token_secret = $secret, updated_at = $now WHERE id = $id",
      )
      .run({
        $secret: crypto.randomBytes(32).toString("hex"),
        $now: nowFn(),
        $id: String(memberId || ""),
      });
    return Number(result.changes || 0) === 1;
  };

  const setPassword = ({ memberId, password }) => {
    if (typeof password !== "string" || password.length < 8) {
      throw Object.assign(
        new Error("Password must be at least 8 characters"),
        { code: "weak_password" },
      );
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const result = db()
      .prepare(
        `UPDATE members SET password_hash = $hash, password_salt = $salt,
           scrypt_params = $params, updated_at = $now WHERE id = $id`,
      )
      .run({
        $hash: hashPassword(password, salt),
        $salt: salt,
        $params: JSON.stringify(kScryptParams),
        $now: nowFn(),
        $id: String(memberId || ""),
      });
    return Number(result.changes || 0) === 1;
  };

  const countActiveAdmins = () =>
    Number(
      db()
        .prepare(
          "SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND disabled = 0",
        )
        .get().n || 0,
    );

  const updateMember = ({ memberId, role, displayName, disabled }) => {
    const row = getMemberRowById(memberId);
    if (!row) {
      throw Object.assign(new Error("Member not found"), {
        code: "member_not_found",
      });
    }
    const nextRole =
      role === undefined ? row.role : role === "admin" ? "admin" : "member";
    const nextDisabled =
      disabled === undefined ? Number(row.disabled || 0) : disabled ? 1 : 0;
    // Last-admin guard (D9): the roster must always keep one active admin.
    const losesAdmin =
      row.role === "admin" &&
      Number(row.disabled || 0) === 0 &&
      (nextRole !== "admin" || nextDisabled === 1);
    if (losesAdmin && countActiveAdmins() <= 1) {
      throw Object.assign(
        new Error("Cannot remove the last active admin"),
        { code: "last_admin" },
      );
    }
    db()
      .prepare(
        `UPDATE members SET role = $role, display_name = $display_name,
           disabled = $disabled, updated_at = $now WHERE id = $id`,
      )
      .run({
        $role: nextRole,
        $display_name:
          displayName === undefined
            ? String(row.display_name || "")
            : String(displayName || "").trim().slice(0, 120),
        $disabled: nextDisabled,
        $now: nowFn(),
        $id: String(memberId),
      });
    return toMemberModel(getMemberRowById(memberId));
  };

  const removeMember = (memberId) => {
    const row = getMemberRowById(memberId);
    if (!row) return false;
    if (
      row.role === "admin" &&
      Number(row.disabled || 0) === 0 &&
      countActiveAdmins() <= 1
    ) {
      throw Object.assign(
        new Error("Cannot remove the last active admin"),
        { code: "last_admin" },
      );
    }
    const result = db()
      .prepare("DELETE FROM members WHERE id = $id")
      .run({ $id: String(memberId) });
    return Number(result.changes || 0) === 1;
  };

  const listMembers = () =>
    db()
      .prepare("SELECT * FROM members ORDER BY created_at ASC")
      .all()
      .map(toMemberModel);

  const getMember = (memberId) => toMemberModel(getMemberRowById(memberId));
  const getMemberByEmail = (email) =>
    toMemberModel(getMemberRowByEmail(email));

  // --- invites -------------------------------------------------------------

  const createInvite = ({
    email = null,
    role = "member",
    createdBy = "",
    ttlMs = kDefaultInviteTtlMs,
  } = {}) => {
    const now = nowFn();
    // A pinned email is written into gateway.auth on accept — validate it at
    // creation, not just at accept, so a malformed pin can never reach the
    // config writer (H2).
    const pinnedEmail = email ? assertValidEmail(email) : null;
    // Opportunistic housekeeping: single-use invites that expired unaccepted
    // would otherwise accumulate forever (L2).
    try {
      purgeExpiredInvites();
    } catch {}
    const token = crypto.randomBytes(24).toString("base64url");
    const id = crypto.randomBytes(12).toString("hex");
    db()
      .prepare(
        `INSERT INTO member_invites (
           id, token_hash, email, role, created_by, created_at, expires_at
         ) VALUES ($id, $token_hash, $email, $role, $created_by, $now, $expires_at)`,
      )
      .run({
        $id: id,
        $token_hash: hashInviteToken(token),
        $email: pinnedEmail,
        $role: role === "admin" ? "admin" : "member",
        $created_by: String(createdBy || ""),
        $now: now,
        $expires_at: now + Math.max(60_000, Number(ttlMs) || kDefaultInviteTtlMs),
      });
    // The raw token is returned exactly once — only its hash is stored.
    return { ...toInviteModel({ id, role, created_at: now, expires_at: now + ttlMs, created_by: createdBy, email: pinnedEmail }), token };
  };

  // Atomic single-use consume (CEO finding 4): the conditional UPDATE's
  // affected-row count decides the race — exactly one caller wins.
  const consumeInvite = ({ token }) => {
    const now = nowFn();
    const tokenHash = hashInviteToken(String(token || ""));
    const result = db()
      .prepare(
        `UPDATE member_invites SET used_at = $now
         WHERE token_hash = $token_hash AND used_at IS NULL AND expires_at > $now`,
      )
      .run({ $now: now, $token_hash: tokenHash });
    if (Number(result.changes || 0) !== 1) return null;
    return toInviteModel(
      db()
        .prepare("SELECT * FROM member_invites WHERE token_hash = $token_hash")
        .get({ $token_hash: tokenHash }),
    );
  };

  // Accept an invite atomically. The token is validated FIRST (no email
  // existence oracle before a valid token, H3), and consume+create run in one
  // transaction so a create failure rolls the single-use burn back (F9/H4).
  // Returns { ok, code?, member? } — never throws for expected failures.
  const acceptInvite = ({
    token,
    providedEmail = "",
    password,
    displayName = "",
  } = {}) => {
    const tokenHash = hashInviteToken(String(token || ""));
    const peek = db()
      .prepare(
        `SELECT * FROM member_invites
         WHERE token_hash = $token_hash AND used_at IS NULL AND expires_at > $now
         LIMIT 1`,
      )
      .get({ $token_hash: tokenHash, $now: nowFn() });
    if (!peek) return { ok: false, code: "invite_invalid" };
    const invite = toInviteModel(peek);
    const rawEmail = invite.email || providedEmail;
    if (!rawEmail) return { ok: false, code: "email_required" };
    let email;
    try {
      email = assertValidEmail(rawEmail);
    } catch (err) {
      return { ok: false, code: err?.code || "invalid_email" };
    }
    if (typeof password !== "string" || password.length < 8) {
      return { ok: false, code: "weak_password" };
    }
    // Pre-check WITHOUT consuming: a known-taken email must not burn the
    // single-use token (H4). The atomic consume below still guards the
    // check-to-insert race.
    if (getMemberRowByEmail(email)) return { ok: false, code: "email_taken" };

    const database = db();
    database.exec("BEGIN IMMEDIATE");
    try {
      const consumed = database
        .prepare(
          `UPDATE member_invites SET used_at = $now
           WHERE token_hash = $token_hash AND used_at IS NULL AND expires_at > $now`,
        )
        .run({ $now: nowFn(), $token_hash: tokenHash });
      if (Number(consumed.changes || 0) !== 1) {
        database.exec("ROLLBACK");
        return { ok: false, code: "invite_invalid" };
      }
      const member = createMember({
        email,
        displayName,
        role: invite.role,
        password,
      });
      database
        .prepare(
          "UPDATE member_invites SET used_by_member_id = $m WHERE id = $id",
        )
        .run({ $m: member.id, $id: invite.id });
      database.exec("COMMIT");
      return { ok: true, member, invite };
    } catch (err) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      return {
        ok: false,
        code: err?.code || "invite_failed",
        error: err?.message || "Could not create the member account",
      };
    }
  };

  const markInviteUsedBy = ({ inviteId, memberId }) => {
    db()
      .prepare(
        "UPDATE member_invites SET used_by_member_id = $member_id WHERE id = $id",
      )
      .run({ $member_id: String(memberId || ""), $id: String(inviteId || "") });
  };

  const listInvites = ({ includeUsed = false } = {}) => {
    const rows = includeUsed
      ? db().prepare("SELECT * FROM member_invites ORDER BY created_at DESC").all()
      : db()
          .prepare(
            "SELECT * FROM member_invites WHERE used_at IS NULL ORDER BY created_at DESC",
          )
          .all();
    return rows.map(toInviteModel);
  };

  const deleteInvite = (inviteId) => {
    const result = db()
      .prepare("DELETE FROM member_invites WHERE id = $id")
      .run({ $id: String(inviteId || "") });
    return Number(result.changes || 0) === 1;
  };

  const purgeExpiredInvites = () => {
    const result = db()
      .prepare(
        "DELETE FROM member_invites WHERE used_at IS NULL AND expires_at <= $now",
      )
      .run({ $now: nowFn() });
    return Number(result.changes || 0);
  };

  return {
    createMember,
    verifyMemberPassword,
    getTokenSecret,
    rotateTokenSecret,
    setPassword,
    updateMember,
    removeMember,
    listMembers,
    getMember,
    getMemberByEmail,
    countActiveAdmins,
    createInvite,
    consumeInvite,
    acceptInvite,
    markInviteUsedBy,
    listInvites,
    deleteInvite,
    purgeExpiredInvites,
  };
};

module.exports = {
  createMembersStore,
  kDefaultInviteTtlMs,
  normalizeEmail,
};
