const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  isStateDbQuiet,
  enterStateDbHandle,
  exitStateDbHandle,
  StateDbQuietError,
} = require("./state-db-quiet");

const kOpenclawStateDbPath = path.join("state", "openclaw.sqlite");
// A reader that meets the gateway's (or a backup's) write lock waits briefly
// instead of failing with SQLITE_BUSY — and in rollback-journal mode a
// reader that fails fast is exactly what stalls the writer's COMMIT loop.
const kReadonlyBusyTimeoutMs = 2000;
const kWritableBusyTimeoutMs = 3000;

const resolveOpenclawStateDbPath = ({ openclawDir }) =>
  path.join(openclawDir, kOpenclawStateDbPath);

// Every handle this module hands out is counted while open so the quiet
// barrier can wait for in-flight readers/writers to finish and the offline
// copy can prove exclusivity — its /proc fd scan skips THIS process, so the
// counter is the only witness for our own handles. The count is released by
// the handle's own close() (callers keep calling db.close()) and only once
// the connection is known to be closed: a native close() that throws is
// retried once, and a connection that is still open after that STAYS
// counted. The offline copy then refuses honestly (handleCount ≠ 0) until a
// later close succeeds or the process restarts — the alternative, an
// uncounted open reader under a copy that believes it is exclusive, is the
// exact false verdict the counter exists to prevent. A double close on an
// already-released handle surfaces node:sqlite's own error unchanged.
const trackHandle = (db) => {
  const nativeClose = db.close.bind(db);
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    exitStateDbHandle();
  };
  enterStateDbHandle();
  db.close = () => {
    if (!counted) return nativeClose();
    try {
      nativeClose();
    } catch (error) {
      if (db.isOpen === false) {
        release();
        throw error;
      }
      try {
        nativeClose();
      } catch (retryError) {
        if (db.isOpen === false) {
          release();
          throw error;
        }
        console.error(
          `[alphaclaw] state-db handle close failed twice (${retryError.message}); the handle stays counted — backups that need exclusivity refuse until it closes`,
        );
        throw retryError;
      }
      console.log(`[alphaclaw] state-db handle close succeeded on retry after: ${error.message}`);
    }
    release();
  };
  return db;
};

const openTrackedDatabase = (databasePath, { readOnly, busyTimeoutMs }) => {
  const db = new DatabaseSync(databasePath, readOnly ? { readOnly: true } : {});
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
  return trackHandle(db);
};

// Read-only DatabaseSync on an arbitrary state-tree database path, counted
// and busy-timeout-armed. For callers that resolve/verify the path
// themselves (openclaw-state-era's injected-fs harnesses).
const openTrackedReadonlyDatabase = (databasePath) =>
  openTrackedDatabase(databasePath, { readOnly: true, busyTimeoutMs: kReadonlyBusyTimeoutMs });

// Read-only handle on openclaw's state database, or null when it does not
// exist yet (fresh install, gateway never started) OR while the state-DB
// quiet period holds — callers already treat null as "unavailable" and fall
// back to their legacy source. Callers must close().
const openReadonlyOpenclawStateDb = ({ openclawDir }) => {
  if (isStateDbQuiet()) return null;
  const databasePath = resolveOpenclawStateDbPath({ openclawDir });
  if (!fs.existsSync(databasePath)) return null;
  return {
    db: openTrackedReadonlyDatabase(databasePath),
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
// parameterized statements. While the quiet barrier holds (a backup is
// snapshotting the state dir) writers fail closed with StateDbQuietError —
// routes map it to 409 backup_in_progress.
const openWritableOpenclawStateDb = ({ openclawDir }) => {
  if (isStateDbQuiet()) throw new StateDbQuietError();
  const databasePath = resolveOpenclawStateDbPath({ openclawDir });
  if (!fs.existsSync(databasePath)) return null;
  const db = openTrackedDatabase(databasePath, {
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
  openTrackedReadonlyDatabase,
  openWritableOpenclawStateDb,
  hasTable,
};
