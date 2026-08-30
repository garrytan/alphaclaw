// Shared operational pragmas for every node:sqlite DatabaseSync this app
// opens (previously copy-pasted across db/auth, db/doctor, db/watchdog,
// db/webhooks — TODOS.md "shared applyOperationalPragmas" item).
//
// Order matters: busy_timeout FIRST — the one-time WAL migration needs an
// exclusive lock, and a second process (CLI vs server) racing it without a
// timeout fails immediately with SQLITE_BUSY.
//
// cache_size: sized by resource autotune when active (per-connection page
// cache; the value is per DB and bounded 2–64MB). SQLite semantics gotcha: a
// POSITIVE cache_size is a PAGE count — KiB sizing requires a NEGATIVE value
// (https://sqlite.org/pragma.html#pragma_cache_size). Autotune off/error →
// no cache pragma at all (SQLite's default, exactly the legacy behavior).
// The pragma is connection-local, so a changed derivation only reaches new
// connections — the ledger reports it as pending an AlphaClaw restart.
const applyOperationalPragmas = (db, { busyTimeoutMs = 10000 } = {}) => {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  try {
    const { getSqliteCacheMb } = require("../autotune");
    const cacheMb = getSqliteCacheMb();
    if (cacheMb != null) {
      db.exec(`PRAGMA cache_size = -${cacheMb * 1024};`);
    }
  } catch {
    // Autotune must never break a DB open.
  }
};

module.exports = { applyOperationalPragmas };
