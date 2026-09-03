const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const kOpenclawStateDbPath = path.join("state", "openclaw.sqlite");

const resolveOpenclawStateDbPath = ({ openclawDir }) =>
  path.join(openclawDir, kOpenclawStateDbPath);

// Read-only handle on openclaw's state database, or null when it does not
// exist yet (fresh install, gateway never started). Callers must close().
const openReadonlyOpenclawStateDb = ({ openclawDir }) => {
  const databasePath = resolveOpenclawStateDbPath({ openclawDir });
  if (!fs.existsSync(databasePath)) return null;
  return {
    db: new DatabaseSync(databasePath, { readOnly: true }),
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
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 3000;");
  return { db, databasePath };
};

module.exports = {
  kOpenclawStateDbPath,
  resolveOpenclawStateDbPath,
  openReadonlyOpenclawStateDb,
  openWritableOpenclawStateDb,
  hasTable,
};
