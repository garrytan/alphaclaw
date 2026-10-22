// OpenClaw schema-version oracles (issues #76 / #78).
//
// OpenClaw keeps two SQLite schema lines: the global STATE DB
// (state/openclaw.sqlite) and one AGENT DB per agent
// (agents/<id>/agent/openclaw-agent.sqlite). Every DB carries its schema as
// `PRAGMA user_version`; every build AlphaClaw can run (2026.9.3 and later)
// declares the schema it supports in its public package.json
// `openclaw.schemaVersions`. The numbers are NOT ordered by release, so nothing
// here derives a schema from a version compare. That metadata is the only
// authority: absent metadata is unknown ({state: null, agent: null}), and
// malformed metadata is explicitly unknown for both kinds.
//
// Readers only: openclaw-runtime.js asks what the installed build declares
// and what the DBs on disk carry; the watchdog stamps the latter on relaunch
// rows. Nothing here decides whether a build may launch.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { kReadonlyBusyTimeoutMs } = require("./openclaw-state-db");
const { parseSchemaMetadata, metadataDeclaration } = require("./openclaw-schema-metadata");

// ── PRAGMA user_version ────────────────────────────────────────────────────

// SQLite primary result codes (https://sqlite.org/rescode.html). node:sqlite
// reports the EXTENDED code on `error.errcode`; the primary code is its low
// byte (SQLITE_BUSY_SNAPSHOT 517 → SQLITE_BUSY 5).
const kSqlitePrimaryCodeNames = Object.freeze({
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  11: "SQLITE_CORRUPT",
  14: "SQLITE_CANTOPEN",
  26: "SQLITE_NOTADB",
});
const kSqliteCorruptNames = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);
const kSqliteBusyNames = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

// Default handle: read-only, busy-timeout-armed (a reader that fails fast
// stalls a rollback-journal writer's COMMIT loop — openclaw-state-db.js).
// Server-phase callers may inject openclaw-state-db's openReadonlyDatabase.
const openReadonlyForUserVersion = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${kReadonlyBusyTimeoutMs};`);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
  return db;
};

const classifySqliteFailure = (error, { exists }) => {
  const code = String(error?.code || "");
  const message = String(error?.errstr || error?.message || error || "");
  if (code === "ENOENT") return { status: "missing", code };
  const hasErrcode = Number.isInteger(error?.errcode);
  const primaryName = hasErrcode ? kSqlitePrimaryCodeNames[error.errcode & 0xff] || null : null;
  const detail = { code: primaryName || code || "UNKNOWN", errcode: hasErrcode ? error.errcode : null, message };
  if (primaryName) {
    if (kSqliteCorruptNames.has(primaryName)) return { status: "corrupt", ...detail };
    if (kSqliteBusyNames.has(primaryName)) return { status: "busy", ...detail };
    if (primaryName === "SQLITE_CANTOPEN" && exists === false) return { status: "missing", ...detail };
    return { status: "error", ...detail };
  }
  // No numeric code (an injected open, or a node:sqlite build that omits
  // errcode): fall back to SQLite's own wording.
  if (/not a database|malformed/i.test(message)) return { status: "corrupt", ...detail };
  if (/database is locked|database is busy/i.test(message)) return { status: "busy", ...detail };
  return { status: "error", ...detail };
};

// { userVersion: integer | null, status: "ok" | "corrupt" | "busy" | "missing"
//   | "error", error?: { code, errcode, message } }
// `null` is always "indeterminate" — a DB whose user_version IS 0 reports 0.
// Callers decide what each status means for them (CEO 2.1 / Codex 5: corrupt
// is fail-closed at the launch gate, busy is indeterminate, missing is the
// fresh-box state and is skipped silently). Never throws.
const readSqliteUserVersion = (dbPath, { open = openReadonlyForUserVersion, fsModule = fs } = {}) => {
  let exists = null;
  try {
    exists = fsModule.existsSync(dbPath);
  } catch {}
  if (exists === false) return { userVersion: null, status: "missing" };
  let db = null;
  try {
    db = open(dbPath);
    const row = db.prepare("PRAGMA user_version").get();
    const raw = row?.user_version;
    const userVersion = typeof raw === "bigint" ? Number(raw) : raw;
    if (!Number.isInteger(userVersion) || userVersion < 0) {
      return {
        userVersion: null,
        status: "error",
        error: {
          code: "USER_VERSION_UNREADABLE",
          errcode: null,
          message: `PRAGMA user_version returned ${JSON.stringify(raw ?? null)}`,
        },
      };
    }
    return { userVersion, status: "ok" };
  } catch (error) {
    let existsNow = exists;
    try {
      existsNow = fsModule.existsSync(dbPath);
    } catch {}
    const { status, ...detail } = classifySqliteFailure(error, { exists: existsNow });
    if (status === "missing") return { userVersion: null, status };
    return { userVersion: null, status, error: detail };
  } finally {
    try {
      db?.close();
    } catch {}
  }
};

const toSchemaInt = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

// The launch-record shape every relaunch and restart-op record persists (#76
// A2): the global state DB's user_version plus one entry per agent DB, read at
// REQUEST time. Pure normalizer shared by the watchdog and the restart store —
// `null` when the reader gave nothing usable, never a partial object.
//   { userVersion: integer | null, agentUserVersions: integer[] }
const normalizeStateDbVersions = (raw) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const userVersion = toSchemaInt(raw.userVersion);
  const agentUserVersions = Array.isArray(raw.agentUserVersions)
    ? raw.agentUserVersions.map(toSchemaInt).filter((value) => value !== null)
    : [];
  if (userVersion === null && agentUserVersions.length === 0) return null;
  return { userVersion, agentUserVersions };
};

// ── declared schema (public package.json metadata) ─────────────────────────

const emptyDeclared = () => ({ state: null, agent: null, files: [], source: "declared" });

// A missing package.json or absent metadata is unknown; an unreadable file
// or malformed metadata is explicitly unknown (metadataDeclaration's "invalid").
const declarationForReadError = (error) =>
  error?.code === "ENOENT" ? emptyDeclared() : metadataDeclaration({ status: "invalid" });
const declarationForPackageJson = (raw) => metadataDeclaration(parseSchemaMetadata(raw)) || emptyDeclared();

// { state, agent, files, source: "declared", metadata? } — null per kind = unknown.
// Sync form: bin phase (initialize-openclaw-auth).
const resolveDeclaredSchemaVersions = (packageDir, { fsModule = fs } = {}) => {
  let raw;
  try {
    raw = fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8");
  } catch (error) {
    return declarationForReadError(error);
  }
  return declarationForPackageJson(raw);
};

// Async twin for the server phase (openclaw-runtime).
const resolveDeclaredSchemaVersionsAsync = async (packageDir, { fsModule = fs } = {}) => {
  const fsp = fsModule.promises || fs.promises;
  let raw;
  try {
    raw = await fsp.readFile(path.join(packageDir, "package.json"), "utf8");
  } catch (error) {
    return declarationForReadError(error);
  }
  return declarationForPackageJson(raw);
};

module.exports = {
  classifySqliteFailure,
  readSqliteUserVersion,
  normalizeStateDbVersions,
  resolveDeclaredSchemaVersions,
  resolveDeclaredSchemaVersionsAsync,
};
