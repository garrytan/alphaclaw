// OpenClaw schema-version oracles (issues #76 / #78).
//
// OpenClaw keeps two SQLite schema lines: the global STATE DB
// (state/openclaw.sqlite) and one AGENT DB per agent
// (agents/<id>/agent/openclaw-agent.sqlite). Every DB carries its schema as
// `PRAGMA user_version`; every release declares the schema it supports as
// `OPENCLAW_{STATE,AGENT}_SCHEMA_VERSION` constants in its dist chunks. The
// numbers are NOT ordered by release (2026.9.1-beta.1 → {12,17} but
// 2026.8.2 → {15,19}), so nothing here derives a schema from a version
// compare. Authority order for "what schema does build X support":
//
//   declared  — public package.json openclaw.schemaVersions metadata; only
//               when absent, constants read (never executed) from its dist
//   seeded    — kSeededSchemaVersions, verified 2026-09-06 from the tarballs
//
// Readers only: openclaw-runtime.js asks what the installed build declares
// and what the DBs on disk carry; the watchdog stamps the latter on relaunch
// rows. Nothing here decides whether a build may launch.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { kReadonlyBusyTimeoutMs } = require("./openclaw-state-db");
const { parseSchemaMetadata, metadataDeclaration } = require("./openclaw-schema-metadata");

const kSchemaKinds = Object.freeze(["state", "agent"]);
// Pass 1 of the dist scan: the constant-bearing chunks upstream emits
// (`openclaw-{agent,state}-db-contract-<hash>.js`,
// `openclaw-agent-db-migration-required-<hash>.js`).
const kSchemaContractFilePattern = /^openclaw-(agent|state)-db-[^/]*\.js$/;
// Pass 2 (only for a kind pass 1 left without a hit): small chunks whose name
// hints at a database concern.
const kSchemaFallbackNamePattern = /db|schema|database/i;
const kDeclaredScanFallbackMaxBytes = 64 * 1024;
const kDeclaredScanReadBudgetBytes = 16 * 1024 * 1024;
// A declaration is an assignment (`const OPENCLAW_STATE_SCHEMA_VERSION = 15`);
// `===`/`==`/`>=` comparisons never match because a digit must follow the
// single `=`.
const kSchemaConstantPattern = /OPENCLAW_(STATE|AGENT)_SCHEMA_VERSION\s*=(?!=)\s*([^;\n,]+)/g;

// Verified 2026-09-06 by streaming the npm tarballs (plan "Upstream facts
// verified"). 2026.7.1-2 predates the agent DB and declares nothing; its
// state schema is live-observed.
const kSeededSchemaVersions = Object.freeze({
  "2026.7.1-2": Object.freeze({ state: 1, agent: null }),
  "2026.8.2": Object.freeze({ state: 15, agent: 19 }),
  "2026.9.1-beta.1": Object.freeze({ state: 12, agent: 17 }),
  "2026.9.1": Object.freeze({ state: 15, agent: 19 }),
  "2026.9.2": Object.freeze({ state: 15, agent: 19 }),
  // 2026.9.3 (pinned v0.9.80): { state: 16, agent: 19 }, verified 2026-09-08
  // against its package.json `openclaw.schemaVersions` (the metadata-first
  // authority above answers before this seed on an installed tree) and its
  // dist constants. The state schema moved 15 → 16: a state DB already at 16
  // cannot be opened by the older build.
  "2026.9.3": Object.freeze({ state: 16, agent: 19 }),
  // 2026.9.4 and 2026.9.5 (pinned v0.9.88): declared by each package.json
  // `openclaw.schemaVersions`, verified 2026-09-20 (2026.9.5 from the installed
  // tree, 2026.9.4 from the registry manifest). The state schema moved 16 → 17
  // at 2026.9.4 and the agent schema 19 → 21 at 2026.9.5; upstream documents
  // that "older builds cannot open" a schema-21 agent database, so a downgrade
  // from 2026.9.5 is restore-the-verified-backup, never reinstall-and-boot.
  // 2026.9.5 no longer emits an OPENCLAW_STATE_SCHEMA_VERSION dist constant;
  // the metadata-first authority above is what answers for it.
  "2026.9.4": Object.freeze({ state: 17, agent: 19 }),
  "2026.9.5": Object.freeze({ state: 17, agent: 21 }),
  // 2026.9.6, 2026.9.7 and 2026.9.8 (pinned v0.9.98): declared by each
  // package.json `openclaw.schemaVersions`, verified 2026-10-03 (2026.9.8 from
  // the installed tree, the other two from the registry manifests). 2026.9.6
  // moved state 17 → 18 and agent 21 → 23; 2026.9.7 moved state 18 → 19 and
  // agent 23 → 24; 2026.9.8 changes neither. A downgrade from the new pin to
  // 2026.9.5 is restore-the-verified-backup, never reinstall-and-boot.
  "2026.9.6": Object.freeze({ state: 18, agent: 23 }),
  "2026.9.7": Object.freeze({ state: 19, agent: 24 }),
  "2026.9.8": Object.freeze({ state: 19, agent: 24 }),
});

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

// ── declared constants (dist scan, never executed) ─────────────────────────

const extractSchemaConstants = (text) => {
  const hits = [];
  for (const match of String(text).matchAll(kSchemaConstantPattern)) {
    const literal = match[2].trim();
    const parsed = /^\d+$/.test(literal) ? Number(literal) : null;
    const value = Number.isSafeInteger(parsed) ? parsed : null;
    hits.push({ kind: match[1].toLowerCase(), value });
  }
  return hits;
};

// Multiple hits must agree; a disagreement is "unknown", never a guess.
const reduceHits = (hits) => {
  if (hits.length === 0) return null;
  const first = hits[0].value;
  return hits.every((hit) => hit.value === first) ? first : null;
};

const createScanState = ({ readBudgetBytes }) => ({
  hits: { state: [], agent: [] },
  files: new Set(),
  remainingBytes: readBudgetBytes,
});

// Accounts the file against the budget BEFORE reading; a file that would
// overshoot is skipped (never truncated — a half-read chunk could hide the
// constant and misreport "unknown" as agreement).
const reserveBudget = (scan, size) => {
  if (!Number.isFinite(size) || size < 0 || size > scan.remainingBytes) return false;
  scan.remainingBytes -= size;
  return true;
};

const recordFileHits = (scan, name, text, { kinds }) => {
  for (const hit of extractSchemaConstants(text)) {
    if (!kinds.includes(hit.kind)) continue;
    scan.hits[hit.kind].push({ file: name, value: hit.value });
    scan.files.add(name);
  }
};

// Pass 2 only fills kinds pass 1 left WITHOUT a hit: the named contract
// chunks are the authoritative declaration, and a disagreement among them is
// already final (more hits cannot make them agree).
const kindsMissingAfterPass1 = (scan) => kSchemaKinds.filter((kind) => scan.hits[kind].length === 0);

const isFallbackCandidateName = (name) =>
  !kSchemaContractFilePattern.test(name) && kSchemaFallbackNamePattern.test(name);
const isFallbackCandidateSize = (size) => size !== null && size < kDeclaredScanFallbackMaxBytes;

const finishScan = (scan) => ({
  state: reduceHits(scan.hits.state),
  agent: reduceHits(scan.hits.agent),
  files: [...scan.files].sort(),
  source: "declared",
  ...(kSchemaKinds.some((kind) => scan.hits[kind].length > 0 && reduceHits(scan.hits[kind]) === null)
    ? { unknownKinds: kSchemaKinds.filter((kind) => scan.hits[kind].length > 0 && reduceHits(scan.hits[kind]) === null) }
    : {}),
});

const emptyDeclared = () => ({ state: null, agent: null, files: [], source: "declared" });

// Top-level regular files only (the contract chunks live at dist/ root; a
// symlink Dirent is not a file, so it is never followed).
const listRegularFiles = (entries) => entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

// { state, agent, files, source: "declared" } — null for a kind whose constant
// is absent, disagreeing across chunks, or unreadable within the budget.
// Sync form: bin phase only (the pass-2 fallback may read up to the budget).
const resolveDeclaredSchemaVersions = (
  packageDir,
  { fsModule = fs, readBudgetBytes = kDeclaredScanReadBudgetBytes } = {},
) => {
  try {
    const metadata = metadataDeclaration(parseSchemaMetadata(fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8")));
    if (metadata) return metadata;
  } catch (error) {
    if (error?.code !== "ENOENT") return metadataDeclaration({ status: "invalid" });
  }
  const distDir = path.join(packageDir, "dist");
  let names;
  try {
    names = listRegularFiles(fsModule.readdirSync(distDir, { withFileTypes: true }));
  } catch {
    return emptyDeclared();
  }
  const scan = createScanState({ readBudgetBytes });
  const statSize = (name) => {
    try {
      return fsModule.statSync(path.join(distDir, name)).size;
    } catch {
      return null;
    }
  };
  const readInto = (name, kinds) => {
    const size = statSize(name);
    if (size === null || !reserveBudget(scan, size)) return;
    let text;
    try {
      text = fsModule.readFileSync(path.join(distDir, name), "utf8");
    } catch {
      return;
    }
    recordFileHits(scan, name, text, { kinds });
  };
  for (const name of names) {
    if (kSchemaContractFilePattern.test(name)) readInto(name, kSchemaKinds);
  }
  const missing = kindsMissingAfterPass1(scan);
  if (missing.length > 0) {
    for (const name of names) {
      if (!isFallbackCandidateName(name) || !isFallbackCandidateSize(statSize(name))) continue;
      readInto(name, missing);
    }
  }
  return finishScan(scan);
};

// Async twin for the server phase (apply, compat gate): same two passes over
// fs.promises so a pass-2 fallback never blocks the live event loop.
const resolveDeclaredSchemaVersionsAsync = async (
  packageDir,
  { fsModule = fs, readBudgetBytes = kDeclaredScanReadBudgetBytes } = {},
) => {
  const fsp = fsModule.promises || fs.promises;
  try {
    const metadata = metadataDeclaration(parseSchemaMetadata(await fsp.readFile(path.join(packageDir, "package.json"), "utf8")));
    if (metadata) return metadata;
  } catch (error) {
    if (error?.code !== "ENOENT") return metadataDeclaration({ status: "invalid" });
  }
  const distDir = path.join(packageDir, "dist");
  let names;
  try {
    names = listRegularFiles(await fsp.readdir(distDir, { withFileTypes: true }));
  } catch {
    return emptyDeclared();
  }
  const scan = createScanState({ readBudgetBytes });
  const statSize = async (name) => {
    try {
      return (await fsp.stat(path.join(distDir, name))).size;
    } catch {
      return null;
    }
  };
  const readInto = async (name, kinds) => {
    const size = await statSize(name);
    if (size === null || !reserveBudget(scan, size)) return;
    let text;
    try {
      text = await fsp.readFile(path.join(distDir, name), "utf8");
    } catch {
      return;
    }
    recordFileHits(scan, name, text, { kinds });
  };
  for (const name of names) {
    if (kSchemaContractFilePattern.test(name)) await readInto(name, kSchemaKinds);
  }
  const missing = kindsMissingAfterPass1(scan);
  if (missing.length > 0) {
    for (const name of names) {
      if (!isFallbackCandidateName(name) || !isFallbackCandidateSize(await statSize(name))) continue;
      await readInto(name, missing);
    }
  }
  return finishScan(scan);
};

module.exports = {
  kSchemaContractFilePattern,
  kDeclaredScanFallbackMaxBytes,
  kDeclaredScanReadBudgetBytes,
  kSeededSchemaVersions,
  classifySqliteFailure,
  readSqliteUserVersion,
  normalizeStateDbVersions,
  resolveDeclaredSchemaVersions,
  resolveDeclaredSchemaVersionsAsync,
};
