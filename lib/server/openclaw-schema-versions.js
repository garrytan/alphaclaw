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
// `declared` entries and `observed` evidence. Packages retain byVersion;
// dev builds use the additive byBuild map keyed by the full checkout SHA:
//
//   { "byVersion": { "<version>": {
//       "state": 15, "agent": 19, "source": "declared", "at": <ms>,   // supported
//       "observed": { "state": 15, "agent": 19, "at": <ms> }          // evidence
//   } } }
//
// Seeds are built in and never written; an observed-only version carries just
// the `observed` record. Readers are lenient (a missing or unparseable table
// yields the seeds), so the table can never throw into the boot sequence.
//
// Two pure decisions sit on top of the oracles (Stage 3): the launch gate
// `assessLaunchCompatibility` (may THIS build open the DBs on disk — C1 belt /
// C2) and the bootable-candidate chooser `chooseBootableVersion` (which local
// build can — B1.4). Both take every I/O as an injected seam; the prober they
// consult is channel-sync's existing rollback prober, never a new one.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { writeFileAtomic } = require("./utils/safe-file");
const { kReadonlyBusyTimeoutMs } = require("./openclaw-state-db");
const { compareVersionParts } = require("./helpers");
const { parseSchemaMetadata, metadataDeclaration } = require("./openclaw-schema-metadata");

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
  const unknownKinds = kSchemaKinds.filter((kind) => raw.unknownKinds?.includes(kind));
  if (raw.source === "declared") {
    const state = toSchemaInt(raw.state);
    const agent = toSchemaInt(raw.agent);
    if (state !== null || agent !== null || unknownKinds.length > 0) {
      Object.assign(entry, { state, agent, source: "declared", at: Number.isFinite(raw.at) ? raw.at : null });
      if (unknownKinds.length) entry.unknownKinds = unknownKinds;
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
      if (error?.code === "ENOENT") return { entries: {}, buildEntries: {}, origin: "missing" };
      warnUnreadable(error);
      return { entries: {}, buildEntries: {}, origin: "unreadable" };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      warnUnreadable(error);
      return { entries: {}, buildEntries: {}, origin: "unreadable" };
    }
    const byVersion = parsed?.byVersion;
    if (!byVersion || typeof byVersion !== "object" || Array.isArray(byVersion)) {
      warnUnreadable(new Error("missing byVersion object"));
      return { entries: {}, buildEntries: {}, origin: "unreadable" };
    }
    const entries = {};
    for (const [version, rawEntry] of Object.entries(byVersion)) {
      if (kReservedVersionKeys.has(version)) continue;
      const entry = normalizeLearnedEntry(rawEntry);
      if (entry) entries[version] = entry;
    }
    const buildEntries = {};
    for (const [buildId, rawEntry] of Object.entries(parsed.byBuild || {})) {
      if (kReservedVersionKeys.has(buildId)) continue;
      const entry = normalizeLearnedEntry(rawEntry);
      if (entry) buildEntries[buildId] = entry;
    }
    return { entries, buildEntries, origin: "file" };
  };

  const writeLearned = (entries, buildEntries = {}) => {
    try {
      writeFileAtomic(filePath, `${JSON.stringify({ byVersion: entries, ...(Object.keys(buildEntries).length ? { byBuild: buildEntries } : {}) }, null, 2)}\n`, { fsModule });
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
    const { entries, buildEntries, origin } = readLearned();
    const byVersion = {};
    for (const [version, seed] of Object.entries(kSeededSchemaVersions)) {
      byVersion[version] = { state: seed.state, agent: seed.agent, source: "seeded", at: null, observed: null };
    }
    for (const [version, entry] of Object.entries(entries)) {
      const current = byVersion[version] || { state: null, agent: null, source: null, at: null, observed: null };
      if (entry.source === "declared") {
        Object.assign(current, { state: entry.state, agent: entry.agent, source: "declared", at: entry.at });
        if (entry.unknownKinds) current.unknownKinds = entry.unknownKinds;
      }
      if (entry.observed) current.observed = entry.observed;
      byVersion[version] = current;
    }
    return { byVersion, ...(Object.keys(buildEntries).length ? { byBuild: buildEntries } : {}), origin };
  };

  // What build `version` supports: declared > seeded; observed is never used
  // (a build that ran against an older DB proves nothing about its maximum).
  const supportedFor = (version, { buildId = version } = {}) => {
    const table = read();
    const entry = buildId !== version ? table.byBuild?.[buildId] : table.byVersion[version];
    if (!entry || entry.source === null) return { state: null, agent: null, source: null };
    return { state: entry.state ?? null, agent: entry.agent ?? null, source: entry.source ?? null,
      ...(entry.unknownKinds ? { unknownKinds: entry.unknownKinds } : {}) };
  };

  // Per-field merge over a previous declaration: a version's dist is
  // immutable, so a later scan that finds LESS (budget skip, partial chunk)
  // never erases a constant an earlier scan read. Both null → nothing to
  // declare → no write (a null declaration must not shadow a seed).
  const recordDeclared = (version, { state, agent, unknownKinds = [] } = {}, { buildId = version } = {}) => {
    assertVersionKey(version);
    assertVersionKey(buildId);
    const blocked = kSchemaKinds.filter((kind) => unknownKinds.includes(kind));
    const declared = { state: toSchemaInt(state), agent: toSchemaInt(agent) };
    if (declared.state === null && declared.agent === null && !blocked.length) return supportedFor(version, { buildId });
    const { entries, buildEntries } = readLearned();
    const target = buildId === version ? entries : buildEntries;
    const prev = target[buildId] || {};
    const unknown = kSchemaKinds.filter((kind) => blocked.includes(kind) ||
      (declared[kind] === null && prev.unknownKinds?.includes(kind)));
    const merged = {
      state: unknown.includes("state") ? null : declared.state ?? (prev.source === "declared" ? prev.state : null),
      agent: unknown.includes("agent") ? null : declared.agent ?? (prev.source === "declared" ? prev.agent : null),
      source: "declared",
      at: nowFn(),
      ...(unknown.length ? { unknownKinds: unknown } : {}),
    };
    target[buildId] = prev.observed ? { ...merged, observed: prev.observed } : merged;
    writeLearned(entries, buildEntries);
    return { state: merged.state, agent: merged.agent, source: "declared", ...(unknown.length ? { unknownKinds: unknown } : {}) };
  };

  // Evidence only: the user_version a DB carried after `version` ran it.
  // Never consulted by supportedFor.
  const recordObserved = (version, { state, agent } = {}, { buildId = version } = {}) => {
    assertVersionKey(version);
    assertVersionKey(buildId);
    const observed = { state: toSchemaInt(state), agent: toSchemaInt(agent), at: nowFn() };
    if (observed.state === null && observed.agent === null) return null;
    const { entries, buildEntries } = readLearned();
    const target = buildId === version ? entries : buildEntries;
    const prev = target[buildId] || {};
    target[buildId] = { ...prev, observed };
    writeLearned(entries, buildEntries);
    return observed;
  };

  return { filePath, read, supportedFor, recordDeclared, recordObserved };
};

// ── launch compatibility (#76 C1 belt / C2) ────────────────────────────────

// Reason tokens the launch gate reports. The names are shared vocabulary:
// `state_schema_too_new` / `agent_schema_too_new` are kGatewayCrashCauses AND
// kBootVerdicts members, `state_db_unreadable` is a structural gatewayHold
// class and a kBootVerdicts member, `legacy_exec_approvals_present` is a
// kBootVerdicts member — so a gate refusal, a crash classification and a
// boot verdict for the same defect print the same word (pinned in the test).
// "state DB" follows the codebase's plural sense (the global STATE DB and
// every AGENT DB are the state databases): a corrupt agent DB is
// `state_db_unreadable` too; the perDb row names the path and kind.
const kLaunchCompatReasons = Object.freeze({
  // blocking (compatible: false)
  stateSchemaTooNew: "state_schema_too_new",
  agentSchemaTooNew: "agent_schema_too_new",
  stateDbUnreadable: "state_db_unreadable",
  stateDbPreflightBlocked: "state_db_preflight_blocked",
  legacyExecApprovalsPresent: "legacy_exec_approvals_present",
  // indeterminate (compatible: null)
  stateDbBusy: "state_db_busy",
  stateDbIndeterminate: "state_db_indeterminate",
  supportedSchemaUnknown: "supported_schema_unknown",
});
const kUserVersionReadStatuses = new Set(["ok", "corrupt", "busy", "missing", "error"]);

// An injected reader may throw or hand back garbage; the gate treats either
// as an indeterminate read (never as "compatible", never as a throw out of
// the boot sequence).
const readUserVersionSafely = async (readUserVersion, dbPath) => {
  let read;
  try {
    read = await readUserVersion(dbPath);
  } catch (error) {
    return {
      userVersion: null,
      status: "error",
      error: { code: "READ_THREW", errcode: null, message: String(error?.message || error) },
    };
  }
  const status = kUserVersionReadStatuses.has(read?.status) ? read.status : "error";
  const userVersion = status === "ok" ? toSchemaInt(read.userVersion) : null;
  if (status === "ok" && userVersion === null) {
    return { userVersion: null, status: "error", error: read?.error ?? null };
  }
  return { userVersion, status, error: read?.error ?? null };
};

// Can the build whose supported schema is `supported` open the state
// databases in `entries` right now? Pure decision over injected oracles:
//
//   entries        [{ path, kind: "state" | "agent" }] (enumerateStateDbEntries)
//   supported      { state, agent } | null — the build's supported schema as
//                  the caller resolved it (declared dist constants, else the
//                  table; Eng 1A: cache THAT per installedVersion, never the
//                  user_versions, which this reads fresh on every call)
//   readUserVersion (path) → readSqliteUserVersion result; server-phase
//                  callers inject the tracked read-only open
//   lacksVerb      the build predates `database preflight` (no probe possible)
//   probeState     async () → "pass" | "block" | "unsupported" |
//                  "budget_exhausted" | null — the existing rollback prober
//                  run against the STATE DB; consulted ONLY when the state
//                  schema is unknown from declared/table and the build has
//                  the verb (upstream's verb is state-only, #78)
//   legacyExecApprovalsPresent  the caller's exec-approvals.json finding for a
//                  build on which the file is existence-fatal (#23)
//
// → { compatible: true | false | null, reasons: string[], perDb: [...] }
//   false  found > supported for any DB, a corrupt DB (Codex 5: corruption is
//          fail-closed), a probe block, or the legacy exec-approvals file
//   null   nothing blocks, but something could not be resolved: a busy or
//          otherwise unreadable-but-not-corrupt DB, a kind whose supported
//          schema no oracle knows (callers fail open with a loud warning)
//   true   every present DB is readable and at or below the supported schema
//          (no DBs at all is the fresh-box state and is trivially compatible)
// reasons lists blocking tokens first, then indeterminate ones, deduped.
// perDb rows: { path, kind, userVersion, status, verdict, supported } with
// verdict from compareSchema on the NUMBERS; a state row the prober judged
// also carries `probe`. A missing DB is skipped (row kept, no reason).
const assessLaunchCompatibility = async ({
  entries = [],
  supported = null,
  readUserVersion = readSqliteUserVersion,
  lacksVerb = false,
  probeState = null,
  legacyExecApprovalsPresent = false,
} = {}) => {
  const target = { state: toSchemaInt(supported?.state), agent: toSchemaInt(supported?.agent) };
  const blocking = new Set();
  const indeterminate = new Set();
  const perDb = [];
  const unresolvedStateRows = [];
  if (legacyExecApprovalsPresent === true) blocking.add(kLaunchCompatReasons.legacyExecApprovalsPresent);
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.path !== "string" || entry.path === "" || !kSchemaKinds.includes(entry.kind)) continue;
    const { kind } = entry;
    const read = await readUserVersionSafely(readUserVersion, entry.path);
    const row = {
      path: entry.path,
      kind,
      userVersion: read.userVersion,
      status: read.status,
      verdict: compareSchema({ found: read.userVersion, target: target[kind] }),
      supported: target[kind],
    };
    perDb.push(row);
    if (read.status === "missing") continue;
    if (read.status === "corrupt") {
      blocking.add(kLaunchCompatReasons.stateDbUnreadable);
      continue;
    }
    if (read.status === "busy") {
      indeterminate.add(kLaunchCompatReasons.stateDbBusy);
      continue;
    }
    if (read.status !== "ok") {
      indeterminate.add(kLaunchCompatReasons.stateDbIndeterminate);
      continue;
    }
    if (row.verdict === "incompatible") {
      blocking.add(kind === "state" ? kLaunchCompatReasons.stateSchemaTooNew : kLaunchCompatReasons.agentSchemaTooNew);
    } else if (row.verdict === "unknown") {
      // Only the STATE line has a second oracle (the verb); an unknown agent
      // line stays unknown.
      if (kind === "state") unresolvedStateRows.push(row);
      else indeterminate.add(kLaunchCompatReasons.supportedSchemaUnknown);
    }
  }
  if (unresolvedStateRows.length > 0) {
    // The probe is the expensive oracle: skip it once the verdict is already
    // false, and when the build cannot answer (no verb / no prober wired).
    if (blocking.size > 0 || lacksVerb === true || typeof probeState !== "function") {
      indeterminate.add(kLaunchCompatReasons.supportedSchemaUnknown);
    } else {
      let probe = null;
      try {
        probe = await probeState();
      } catch {
        probe = null;
      }
      for (const row of unresolvedStateRows) row.probe = probe ?? null;
      if (probe === "block") blocking.add(kLaunchCompatReasons.stateDbPreflightBlocked);
      else if (probe !== "pass") indeterminate.add(kLaunchCompatReasons.supportedSchemaUnknown);
    }
  }
  const compatible = blocking.size > 0 ? false : indeterminate.size > 0 ? null : true;
  return { compatible, reasons: [...blocking, ...indeterminate], perDb };
};

// ── bootable-candidate chooser (#76 B1.4) ──────────────────────────────────

// `openclaw database preflight` first shipped in the 2026.8 line (verified
// absent from the 2026.7.1-2 dist, present from 2026.8.1). Older builds
// cannot confirm anything about a DB, so the chooser accepts them on the
// seeded table alone (Codex 4). channel-sync carries the same predicate for
// its rollback chooser.
const kDatabasePreflightMinCoreVersion = "2026.8.0";
const lacksDatabasePreflightVerb = (version) => {
  const core = String(version || "").trim().split("-")[0];
  return Boolean(core && compareVersionParts(core, kDatabasePreflightMinCoreVersion) < 0);
};

// Eng 4A / Codex 4: at most this many overlays enter the candidate list, and
// at most this many shortlisted candidates are confirmed by the prober.
const kChooserMaxCandidates = 3;

const isVersionString = (value) => typeof value === "string" && value.trim() !== "";

// expected → lastKnownGood → the `maxOverlays` newest overlays, deduped
// (first occurrence keeps its source, so an expected build that is also an
// overlay reports "expected").
const orderChooserCandidates = ({ expected, lastKnownGood, overlays, maxOverlays }) => {
  const out = [];
  const seen = new Set();
  const push = (version, source) => {
    if (!isVersionString(version) || seen.has(version)) return;
    seen.add(version);
    out.push({ version, source });
  };
  push(expected, "expected");
  push(lastKnownGood, "lastKnownGood");
  const newestFirst = [...new Set((Array.isArray(overlays) ? overlays : []).filter(isVersionString))].sort((a, b) =>
    compareVersionParts(b, a),
  );
  for (const version of newestFirst.slice(0, Math.max(0, maxOverlays))) push(version, "overlay");
  return out;
};

// Inspect the candidate's current declaration before trusting a remembered
// version. Public metadata costs one small read and bypasses the legacy
// scan. Explicit unknown kinds never fall back to an older table entry.
const resolveChooserSupported = async (version, { table, resolveSupported }) => {
  let fromTable = null;
  try {
    fromTable = typeof table?.supportedFor === "function" ? table.supportedFor(version) : null;
  } catch {
    fromTable = null;
  }
  const known = { state: toSchemaInt(fromTable?.state), agent: toSchemaInt(fromTable?.agent) };
  if (typeof resolveSupported !== "function") return known;
  let declared = null;
  try {
    declared = await resolveSupported(version);
  } catch {
    declared = null;
  }
  const pick = (kind) => declared?.unknownKinds?.includes(kind)
    ? null
    : toSchemaInt(declared?.[kind]) ?? known[kind];
  return { state: pick("state"), agent: pick("agent") };
};

// The cheap pre-filter: for every kind whose user_version is known, the
// candidate must be KNOWN to support at least that number. An unknown
// supported line is not shortlisted — the chooser never picks a guess; its
// failure mode is the caller's pause + informative notice, not a launch.
const tablePermitsCandidate = (supported, found) =>
  kSchemaKinds.every(
    (kind) => found[kind] === null || (supported[kind] !== null && supported[kind] >= found[kind]),
  );

// Which locally available build can open the current databases?
//
//   expected / lastKnownGood  version strings (or null)
//   overlays                  versions with a complete overlay (store.listOverlays())
//   userVersions              { state, agent } — the live DBs' user_version
//                             (null for a kind with no DB / unreadable)
//   table                     the schema table ({ supportedFor })
//   resolveSupported          optional async (version) → { state, agent } | null,
//                             the candidate's declared dist constants — used
//                             before falling back to the remembered table
//   maxCandidates             cap on overlays considered AND on confirm() calls
//   confirm                   optional async (version) → "pass" | "block" |
//                             "unsupported" | "budget_exhausted" | null — the
//                             existing boot rollback prober (VACUUM INTO
//                             snapshot + `database preflight` + the
//                             agents.entries config-shape guard) run against
//                             that candidate's overlay bin
//   lacksVerb                 (version) → boolean; defaults to the 2026.8 rule
//
// → { version, source: "expected" | "lastKnownGood" | "overlay", confirmed } | null
// Walks the ordered candidates; a candidate the table permits is shortlisted
// and, when confirm is wired, probed: "pass" → chosen (confirmed: true);
// "block" → skipped; anything else proves nothing and is accepted only for a
// pre-2026.8 candidate (no verb — the seeded table is all there is). Without
// confirm the first permitted candidate is chosen unconfirmed. null when no
// candidate survives (or none was supplied).
const chooseBootableVersion = async ({
  expected = null,
  lastKnownGood = null,
  overlays = [],
  userVersions = null,
  table = null,
  resolveSupported = null,
  maxCandidates = kChooserMaxCandidates,
  confirm = null,
  lacksVerb = lacksDatabasePreflightVerb,
} = {}) => {
  const cap = Number.isInteger(maxCandidates) && maxCandidates > 0 ? maxCandidates : kChooserMaxCandidates;
  const found = { state: toSchemaInt(userVersions?.state), agent: toSchemaInt(userVersions?.agent) };
  const candidates = orderChooserCandidates({ expected, lastKnownGood, overlays, maxOverlays: cap });
  let shortlisted = 0;
  for (const candidate of candidates) {
    if (shortlisted >= cap) break;
    const supported = await resolveChooserSupported(candidate.version, { table, resolveSupported });
    if (!tablePermitsCandidate(supported, found)) continue;
    shortlisted += 1;
    const chosen = (confirmed) => ({ version: candidate.version, source: candidate.source, confirmed });
    if (typeof confirm !== "function") return chosen(false);
    let verdict = null;
    try {
      verdict = await confirm(candidate.version);
    } catch {
      verdict = null;
    }
    if (verdict === "pass") return chosen(true);
    if (verdict === "block") continue;
    // "unsupported" / "budget_exhausted" / null: the prober could not judge.
    // A build that SHOULD have the verb and still could not be verified is
    // skipped; a pre-2026.8 build rests on the table that shortlisted it.
    const noVerb = typeof lacksVerb === "function" ? lacksVerb : lacksDatabasePreflightVerb;
    if (noVerb(candidate.version) === true) return chosen(false);
  }
  return null;
};

module.exports = {
  kSchemaVersionsFileName,
  kSchemaContractFilePattern,
  kDeclaredScanFallbackMaxBytes,
  kDeclaredScanReadBudgetBytes,
  kSeededSchemaVersions,
  readSqliteUserVersion,
  normalizeStateDbVersions,
  resolveDeclaredSchemaVersions,
  resolveDeclaredSchemaVersionsAsync,
  compareSchema,
  createSchemaVersionTable,
  kLaunchCompatReasons,
  assessLaunchCompatibility,
  kChooserMaxCandidates,
  lacksDatabasePreflightVerb,
  chooseBootableVersion,
};
