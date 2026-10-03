const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const kOpenclawStateDbPath = path.join("state", "openclaw.sqlite");
// A reader that meets the gateway's (or a backup's) write lock waits briefly
// instead of failing with SQLITE_BUSY — and in rollback-journal mode a
// reader that fails fast is exactly what stalls the writer's COMMIT loop.
const kReadonlyBusyTimeoutMs = 2000;
const kWritableBusyTimeoutMs = 3000;

const resolveOpenclawStateDbPath = ({ openclawDir }) =>
  path.join(openclawDir, kOpenclawStateDbPath);

const openDatabase = (databasePath, { readOnly, busyTimeoutMs }) => {
  const db = new DatabaseSync(databasePath, readOnly ? { readOnly: true } : {});
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
  return db;
};

// Read-only DatabaseSync on an arbitrary state-tree database path,
// busy-timeout-armed. For callers that resolve/verify the path themselves
// (openclaw-state-era's injected-fs harnesses).
const openReadonlyDatabase = (databasePath) =>
  openDatabase(databasePath, { readOnly: true, busyTimeoutMs: kReadonlyBusyTimeoutMs });

// Read-only handle on openclaw's state database, or null when it does not
// exist yet (fresh install, gateway never started) — callers treat null as
// "unavailable" and fall back to their legacy source. Callers must close().
const openReadonlyOpenclawStateDb = ({ openclawDir }) => {
  const databasePath = resolveOpenclawStateDbPath({ openclawDir });
  if (!fs.existsSync(databasePath)) return null;
  return {
    db: openReadonlyDatabase(databasePath),
    databasePath,
  };
};

const hasTable = (db, tableName) => {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return !!row;
};

// Writable handle on openclaw's state database, or null when it does not
// exist. Deliberately short-lived (open → write → close via the caller's
// finally) with a busy timeout so a concurrent gateway holding the write
// lock stalls us briefly instead of failing. Direct writes into openclaw's
// schema are the EXCEPTION, not the rule: only for operations with no CLI
// surface (pairing reject/cleanup, relocated shared auth store), always
// behind a schema guard (openclaw-state-era.tableHasColumns), always with
// parameterized statements.
const openWritableOpenclawStateDb = ({ openclawDir }) => {
  const databasePath = resolveOpenclawStateDbPath({ openclawDir });
  if (!fs.existsSync(databasePath)) return null;
  const db = openDatabase(databasePath, {
    readOnly: false,
    busyTimeoutMs: kWritableBusyTimeoutMs,
  });
  return { db, databasePath };
};

module.exports = {
  kOpenclawStateDbPath,
  kReadonlyBusyTimeoutMs,
  kWritableBusyTimeoutMs,
  resolveOpenclawStateDbPath,
  openReadonlyOpenclawStateDb,
  openReadonlyDatabase,
  openWritableOpenclawStateDb,
  hasTable,
};
