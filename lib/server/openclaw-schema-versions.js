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
//   declared  — constants read (never executed) from that build's own dist
//   (CLI)     — upstream `database preflight`, STATE DB only (channel-sync)
//   seeded    — kSeededSchemaVersions, verified 2026-09-06 from the tarballs
//   observed  — a live DB's user_version after that build ran: EVIDENCE only,
//               never a maximum (a build runs happily against an older schema)
//
// Upstream's `database preflight` verb compares one copied SQLite file with
// the release's STATE schema only; feeding it an AGENT DB produced the false
// 409 of #78. Agent DBs are judged here: user_version vs the declared agent
// constant, through compareSchema.
//
// The learned table (`<managedDir>/openclaw-schema-versions.json`) persists
// `declared` entries and `observed` evidence:
//
//   { "byVersion": { "<version>": {
//       "state": 15, "agent": 19, "source": "declared", "at": <ms>,   // supported
//       "observed": { "state": 15, "agent": 19, "at": <ms> }          // evidence
//   } } }
//
// Seeds are built in and never written; an observed-only version carries just
// the `observed` record. Readers are lenient (a missing or unparseable table
// yields the seeds), so the table can never throw into the boot sequence.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { writeFileAtomic } = require("./utils/safe-file");
const { kReadonlyBusyTimeoutMs } = require("./openclaw-state-db");

const kSchemaVersionsFileName = "openclaw-schema-versions.json";
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
const kSchemaConstantPattern = /OPENCLAW_(STATE|AGENT)_SCHEMA_VERSION\s*=\s*(\d+)/g;

// Verified 2026-09-06 by streaming the npm tarballs (plan "Upstream facts
// verified"). 2026.7.1-2 predates the agent DB and declares nothing; its
// state schema is live-observed.
const kSeededSchemaVersions = Object.freeze({
  "2026.7.1-2": Object.freeze({ state: 1, agent: null }),
  "2026.8.2": Object.freeze({ state: 15, agent: 19 }),
  "2026.9.1-beta.1": Object.freeze({ state: 12, agent: 17 }),
  "2026.9.1": Object.freeze({ state: 15, agent: 19 }),
  "2026.9.2": Object.freeze({ state: 15, agent: 19 }),
});

const kReservedVersionKeys = new Set(["__proto__", "constructor", "prototype"]);

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
// Same shape as channel-sync's readJournalMode; server-phase callers inject
// openTrackedReadonlyDatabase instead so the quiet barrier counts the handle.
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

// ── declared constants (dist scan, never executed) ─────────────────────────

const toSchemaInt = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

const extractSchemaConstants = (text) => {
  const hits = [];
  for (const match of String(text).matchAll(kSchemaConstantPattern)) {
    const value = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(value)) continue;
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

// ── compare ────────────────────────────────────────────────────────────────

// Mirrors upstream's preflight vocabulary: found < target needs a migration
// (the target build upgrades the DB), found > target cannot be read by the
// target build, and either side unknown is "unknown" (callers fail open with
// a loud warning, never a guess).
const compareSchema = ({ found, target } = {}) => {
  if (toSchemaInt(found) === null || toSchemaInt(target) === null) return "unknown";
  if (found === target) return "exact";
  return found < target ? "migration-required" : "incompatible";
};

// ── learned table ──────────────────────────────────────────────────────────

const assertVersionKey = (version) => {
  if (typeof version !== "string" || version.trim() === "" || kReservedVersionKeys.has(version)) {
    throw new TypeError(`schema table: invalid OpenClaw version key ${JSON.stringify(version)}`);
  }
  return version;
};

const normalizeObserved = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const state = toSchemaInt(raw.state);
  const agent = toSchemaInt(raw.agent);
  if (state === null && agent === null) return null;
  return { state, agent, at: Number.isFinite(raw.at) ? raw.at : null };
};

// Only `declared` is a persisted supported-source; seeds are built in, and
// `observed` is evidence. Anything else in the file (an older AlphaClaw's
// experiment, a hand edit) is dropped rather than trusted.
const normalizeLearnedEntry = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const entry = {};
  if (raw.source === "declared") {
    const state = toSchemaInt(raw.state);
    const agent = toSchemaInt(raw.agent);
    if (state !== null || agent !== null) {
      Object.assign(entry, { state, agent, source: "declared", at: Number.isFinite(raw.at) ? raw.at : null });
    }
  }
  const observed = normalizeObserved(raw.observed);
  if (observed) entry.observed = observed;
  return Object.keys(entry).length > 0 ? entry : null;
};

const createSchemaVersionTable = ({ fsModule = fs, managedDir, nowFn = Date.now, logger = console } = {}) => {
  if (typeof managedDir !== "string" || managedDir === "") {
    throw new TypeError("createSchemaVersionTable: managedDir is required");
  }
  const filePath = path.join(managedDir, kSchemaVersionsFileName);
  let warnedUnreadable = false;

  const warnUnreadable = (error) => {
    if (warnedUnreadable) return;
    warnedUnreadable = true;
    logger.warn(
      `[schema-versions] ${filePath} is unreadable (${error?.message || error}) — using the built-in seeded schema table until it is rewritten`,
    );
  };

  // Persisted (learned) entries only: { [version]: entry } plus how the file
  // read went. Lenient by contract — corruption yields an empty table and ONE
  // warning per table instance, never an exception.
  const readLearned = () => {
    let raw;
    try {
      raw = fsModule.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { entries: {}, origin: "missing" };
      warnUnreadable(error);
      return { entries: {}, origin: "unreadable" };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      warnUnreadable(error);
      return { entries: {}, origin: "unreadable" };
    }
    const byVersion = parsed?.byVersion;
    if (!byVersion || typeof byVersion !== "object" || Array.isArray(byVersion)) {
      warnUnreadable(new Error("missing byVersion object"));
      return { entries: {}, origin: "unreadable" };
    }
    const entries = {};
    for (const [version, rawEntry] of Object.entries(byVersion)) {
      if (kReservedVersionKeys.has(version)) continue;
      const entry = normalizeLearnedEntry(rawEntry);
      if (entry) entries[version] = entry;
    }
    return { entries, origin: "file" };
  };

  const writeLearned = (entries) => {
    try {
      writeFileAtomic(filePath, `${JSON.stringify({ byVersion: entries }, null, 2)}\n`, { fsModule });
      return true;
    } catch (error) {
      // The table is advisory: a failed write must never fail the apply or
      // boot that learned the number. The seed still answers.
      logger.warn(`[schema-versions] could not write ${filePath} (${error?.message || error})`);
      return false;
    }
  };

  // Merged view: seeds first, learned declared entries override, observed
  // evidence attached. Every entry is { state, agent, source, at, observed }.
  const read = () => {
    const { entries, origin } = readLearned();
    const byVersion = {};
    for (const [version, seed] of Object.entries(kSeededSchemaVersions)) {
      byVersion[version] = { state: seed.state, agent: seed.agent, source: "seeded", at: null, observed: null };
    }
    for (const [version, entry] of Object.entries(entries)) {
      const current = byVersion[version] || { state: null, agent: null, source: null, at: null, observed: null };
      if (entry.source === "declared") {
        Object.assign(current, { state: entry.state, agent: entry.agent, source: "declared", at: entry.at });
      }
      if (entry.observed) current.observed = entry.observed;
      byVersion[version] = current;
    }
    return { byVersion, origin };
  };

  // What build `version` supports: declared > seeded; observed is never used
  // (a build that ran against an older DB proves nothing about its maximum).
  const supportedFor = (version) => {
    const entry = read().byVersion[version];
    if (!entry || entry.source === null) return { state: null, agent: null, source: null };
    return { state: entry.state, agent: entry.agent, source: entry.source };
  };

  // Per-field merge over a previous declaration: a version's dist is
  // immutable, so a later scan that finds LESS (budget skip, partial chunk)
  // never erases a constant an earlier scan read. Both null → nothing to
  // declare → no write (a null declaration must not shadow a seed).
  const recordDeclared = (version, { state, agent } = {}) => {
    assertVersionKey(version);
    const declared = { state: toSchemaInt(state), agent: toSchemaInt(agent) };
    if (declared.state === null && declared.agent === null) return supportedFor(version);
    const { entries } = readLearned();
    const prev = entries[version] || {};
    const merged = {
      state: declared.state ?? (prev.source === "declared" ? prev.state : null),
      agent: declared.agent ?? (prev.source === "declared" ? prev.agent : null),
      source: "declared",
      at: nowFn(),
    };
    entries[version] = prev.observed ? { ...merged, observed: prev.observed } : merged;
    writeLearned(entries);
    return { state: merged.state, agent: merged.agent, source: "declared" };
  };

  // Evidence only: the user_version a DB carried after `version` ran it.
  // Never consulted by supportedFor.
  const recordObserved = (version, { state, agent } = {}) => {
    assertVersionKey(version);
    const observed = { state: toSchemaInt(state), agent: toSchemaInt(agent), at: nowFn() };
    if (observed.state === null && observed.agent === null) return null;
    const { entries } = readLearned();
    const prev = entries[version] || {};
    entries[version] = { ...prev, observed };
    writeLearned(entries);
    return observed;
  };

  return { filePath, read, supportedFor, recordDeclared, recordObserved };
};

module.exports = {
  kSchemaVersionsFileName,
  kSchemaContractFilePattern,
  kDeclaredScanFallbackMaxBytes,
  kDeclaredScanReadBudgetBytes,
  kSeededSchemaVersions,
  readSqliteUserVersion,
  resolveDeclaredSchemaVersions,
  resolveDeclaredSchemaVersionsAsync,
  compareSchema,
  createSchemaVersionTable,
};
