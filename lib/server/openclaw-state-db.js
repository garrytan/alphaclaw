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

module.exports = {
  kOpenclawStateDbPath,
  resolveOpenclawStateDbPath,
  openReadonlyOpenclawStateDb,
  hasTable,
};
