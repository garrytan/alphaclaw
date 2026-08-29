const createSchema = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_throttle_states (
      state_key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      lock_until INTEGER NOT NULL DEFAULT 0,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_login_throttle_states_last_seen
      ON login_throttle_states(last_seen_at);

    -- Team mode (4.1): named members with per-member credentials. password_hash
    -- is scrypt with a per-member random salt; the scrypt params are stored
    -- alongside so they can be raised later without invalidating old hashes.
    -- token_secret signs the member's session tokens — rotating it revokes
    -- every session for that member.
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      scrypt_params TEXT NOT NULL,
      token_secret TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Single-use invites: only the token HASH is stored. used_at flips exactly
    -- once via an atomic conditional UPDATE (two browsers racing one invite
    -- yield exactly one member).
    CREATE TABLE IF NOT EXISTS member_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by_member_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_member_invites_expires
      ON member_invites(expires_at);
  `);
};

module.exports = { createSchema };
