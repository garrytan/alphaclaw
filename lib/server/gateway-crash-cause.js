// Pure crash-cause classifier for an unexpected gateway exit (issue #76, A3).
//
// Input: the exit code / signal and the stderr tail the watchdog already
// captures. Output: ONE cause from kGatewayCrashCauses plus the line it was
// read from, a stable fingerprint for "same crash again" accounting, and —
// separately — a corroboration verdict over facts gathered independently of
// stderr. stderr is UNTRUSTED text (the agent, a plugin or the gateway echoing
// a log can print anything), so the classifier only ever SUGGESTS a cause;
// enforcement (the Stage 3 structural ladder) acts solely on a corroborated
// cause and records an uncorroborated one as `suspectedCause`, staying on the
// legacy crash ladder. This is the second stderr-steering surface named in
// TODOS ("Corroborate the exit-1 state-writer classification before latching
// it") — every cause here carries the same caveat.
//
// Delegation, never re-declaration: the CLI startup-crash detector
// (doctor/classify-doctor-cli.js), the exit-1 ownership wording
// (openclaw-lock-contention.js) and the EX_CONFIG code / state-migration /
// heap-OOM signatures (watchdog.js) keep their single owners. This module
// adds only the version-family wording upstream prints when a build refuses
// a database, a legacy file or a plugin it cannot use.
//
// Verified against OpenClaw 2026.9.2 / 2026.9.1-beta.1 / 2026.7.1-2 wording,
// 2026-09-06 (2026.9.2 dist re-read from node_modules/openclaw 2026-09-07):
//   - `${databaseLabel} ${pathname} uses newer schema version ${n}; this
//     build supports ${m}.` then `Refused by ${build}.` on the next line
//     (dist/sqlite-user-version-*.js; labels "OpenClaw state database" /
//     "OpenClaw agent database"). The 2026.7.1-2 build the incident ran said
//     "this OpenClaw build supports" — both spellings match. The quarantine
//     store prints a sibling line WITHOUT a "supports" clause; it is not a
//     gateway-fatal refusal and is deliberately not a cause.
//   - `Legacy exec approvals exist at ${filePath}. <doctor --fix hint> before
//     using exec approvals.` (issue #23: existence-fatal on the SQLite-era
//     line, i.e. every build from 2026.8 on).
//   - `plugin requires plugin API ${range}, but this host is ${version};
//     skipping …` and `requires plugin API ${range}, but this OpenClaw runtime
//     exposes ${version}.` (plugin loader). The incident's 2026.7.1-2 host
//     printed the first form for a beta-era plugin.
//   - Port conflicts: upstream's own ADDRESS_IN_USE_RE is
//     /address already in use|EADDRINUSE/i; kPortInUsePattern mirrors it.
// Belt: replaceable by a structured upstream refusal (cause + versions) —
// re-verify the wording table whenever the pin moves.
const crypto = require("crypto");
const path = require("path");
const { kBackupTailClassifyLines } = require("./constants");
const { matchesCliStartupFailure } = require("./doctor/classify-doctor-cli");
const { classifyOwnershipConflict } = require("./openclaw-lock-contention");
const { stripAnsi } = require("./utils/redact");
const { pickCauseLine } = require("./utils/cause-line");

// The watchdog is this module's consumer (Stage 3 injects classifyGatewayCrash
// into createWatchdog); a top-level require in both directions would hand one
// side a half-built exports object, so the shared signatures are read lazily,
// at classification time.
const watchdogSignatures = () => require("./watchdog");

// Precedence order: the version family (the BUILD cannot use what is on disk)
// outranks ownership (another process holds the port / state dir), which
// outranks resource death (oom), which outranks the bare EX_CONFIG exit; an
// exit with no recognized signature is `unknown`.
const kGatewayCrashCauses = Object.freeze([
  "state_schema_too_new",
  "agent_schema_too_new",
  "state_schema_migration_failed",
  "legacy_exec_approvals",
  "plugin_api_too_old",
  "cli_startup_crash",
  "port_in_use",
  "state_dir_owned",
  "oom",
  "config_invalid",
  "unknown",
]);
// Causes that implicate the installed BUILD rather than the box; Stage 3's
// structural ladder acts on these (once corroborated) — everything else stays
// on the legacy crash ladder.
const kVersionFamilyGatewayCrashCauses = Object.freeze([
  "state_schema_too_new",
  "agent_schema_too_new",
  "state_schema_migration_failed",
  "legacy_exec_approvals",
  "plugin_api_too_old",
  "cli_startup_crash",
]);

// `${label} ${path} uses newer schema version N; this [OpenClaw ]build
// supports M.` — the path token is optional so a build that ever drops it
// still classifies (kind then falls back to the label).
const kSchemaTooNewPattern =
  /(?:(\S+\.sqlite)\s+)?uses newer schema version (\d+); this (?:OpenClaw )?build supports (\d+)/i;
const kAgentDbFileName = "openclaw-agent.sqlite";
const kAgentDatabaseLabelPattern = /\bagent database\b/i;
const kLegacyExecApprovalsPattern = /Legacy exec approvals exist at\s+(\S+?)\.?(?=\s|$)/i;
const kPluginApiTooOldPattern =
  /requires plugin API\s+([^,]+?),\s+but this (?:host is|OpenClaw runtime exposes)\s+([^\s;,)]+?)\.?(?=[\s;,)]|$)/i;
const kPortInUsePattern = /\bEADDRINUSE\b|address already in use/i;
// 128 + SIGKILL(9): the shell-style exit code of a force-killed child.
const kSigkillExitCode = 137;
const kFingerprintHexChars = 12;
// Anything that starts a slash-rooted token, up to a delimiter — absolute
// paths, `//host:port` URL tails, `/tmp/x.lock` — reads as one placeholder.
const kPathTokenPattern = /\/[^\s"'`;,()]+/g;

const toExitCode = (code) => {
  if (code === null || code === undefined || code === "") return null;
  const value = Number(code);
  return Number.isInteger(value) ? value : null;
};

const toSchemaInt = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

// Last kBackupTailClassifyLines non-empty, ANSI-free lines of the tail
// (array of lines or one string) — every matcher reads this window, never
// the whole tail and never only the final line (the #54 precedent: the cause
// sat several lines above the terminal "failed" line).
const selectTailLines = (stderrTail) => {
  const raw = Array.isArray(stderrTail)
    ? stderrTail.map((line) => String(line ?? "")).join("\n")
    : String(stderrTail ?? "");
  return stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-kBackupTailClassifyLines);
};

// Latest evidence first: the most recent matching line in the window.
const lastMatching = (lines, pattern) => {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = pattern.exec(lines[i]);
    if (match) return { line: lines[i], match };
  }
  return null;
};

const lastWhere = (lines, predicate) => {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (predicate(lines[i])) return lines[i];
  }
  return null;
};

const describeExit = ({ code, signal }) => {
  if (signal) return `signal ${signal}`;
  return code === null ? "exit without a code" : `exit ${code}`;
};

// ── matchers (one per cause; ordered by precedence below) ──────────────────

const matchSchemaTooNew = ({ lines }) => {
  const hit = lastMatching(lines, kSchemaTooNewPattern);
  if (!hit) return null;
  const rawPath = hit.match[1] ? hit.match[1].replace(/^["'`(]+/, "") : null;
  const found = Number.parseInt(hit.match[2], 10);
  const supports = Number.parseInt(hit.match[3], 10);
  const isAgent =
    (rawPath !== null && path.posix.basename(rawPath) === kAgentDbFileName) ||
    kAgentDatabaseLabelPattern.test(hit.line);
  const kind = isAgent ? "agent" : "state";
  return {
    cause: isAgent ? "agent_schema_too_new" : "state_schema_too_new",
    detail: `${kind} DB${rawPath ? ` ${rawPath}` : ""} carries schema ${found}; the exited build supports ${supports}`,
    matchedLine: hit.line,
    versions: { found, supports },
    dbPath: rawPath,
  };
};

const matchMigrationRefusal = ({ lines }) => {
  const hit = lastMatching(lines, watchdogSignatures().kStateMigrationRefusalPattern);
  if (!hit) return null;
  return {
    cause: "state_schema_migration_failed",
    detail: `the exited build refused to start: "${hit.match[0]}"`,
    matchedLine: hit.line,
  };
};

const matchLegacyExecApprovals = ({ lines }) => {
  const hit = lastMatching(lines, kLegacyExecApprovalsPattern);
  if (!hit) return null;
  return {
    cause: "legacy_exec_approvals",
    detail: `legacy exec-approvals file ${hit.match[1]} is existence-fatal on the exited build`,
    matchedLine: hit.line,
  };
};

const matchPluginApiTooOld = ({ lines }) => {
  const hit = lastMatching(lines, kPluginApiTooOldPattern);
  if (!hit) return null;
  const requires = hit.match[1].trim();
  const host = hit.match[2];
  return {
    cause: "plugin_api_too_old",
    detail: `a plugin requires plugin API ${requires}; the exited build exposes ${host}`,
    matchedLine: hit.line,
    versions: { requires, host },
  };
};

const matchCliStartupCrash = ({ lines }) => {
  const joined = lines.join("\n");
  if (!matchesCliStartupFailure(joined)) return null;
  // A one-line envelope or the plain crash text names its own line; a
  // multi-line envelope only parses as a whole, so point at its type line.
  const matchedLine =
    lastWhere(lines, (line) => matchesCliStartupFailure(line)) ??
    lastWhere(lines, (line) => /cli_error/.test(line));
  return {
    cause: "cli_startup_crash",
    detail: matchedLine ?? "cli_error envelope: the CLI could not start",
    matchedLine,
  };
};

const matchOwnershipConflict = ({ lines }) => {
  const conflict = classifyOwnershipConflict(lines.join("\n"));
  if (!conflict) return null;
  const matchedLine = lastWhere(
    lines,
    (line) => classifyOwnershipConflict(line)?.kind === conflict.kind,
  );
  const holder = [
    conflict.holderRole ? `held by ${conflict.holderRole}` : null,
    conflict.holderPid !== null ? `(pid ${conflict.holderPid})` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    cause: "state_dir_owned",
    detail: holder ? `${conflict.kind} ${holder}` : conflict.kind,
    matchedLine,
    conflict,
  };
};

const matchPortInUse = ({ lines }) => {
  const hit = lastMatching(lines, kPortInUsePattern);
  if (!hit) return null;
  return {
    cause: "port_in_use",
    detail: "the gateway port is already bound (EADDRINUSE)",
    matchedLine: hit.line,
  };
};

const matchOom = ({ lines, code, signal }) => {
  const hit = lastMatching(lines, watchdogSignatures().kHeapOomPattern);
  if (hit) {
    return {
      cause: "oom",
      detail: "V8 heap exhausted (JavaScript heap out of memory)",
      matchedLine: hit.line,
    };
  }
  if (code === kSigkillExitCode || signal === "SIGKILL") {
    return {
      cause: "oom",
      detail: `force-killed (${describeExit({ code, signal })}) — commonly the kernel OOM killer; not conclusive`,
      matchedLine: null,
    };
  }
  return null;
};

const matchConfigInvalid = ({ lines, code }) => {
  if (code !== watchdogSignatures().kOpenclawConfigErrorExitCode) return null;
  return {
    cause: "config_invalid",
    detail: `exit ${code} (EX_CONFIG) without a schema, migration or exec-approvals signature`,
    matchedLine: pickCauseLine(lines.join("\n")),
  };
};

const kMatchersByPrecedence = Object.freeze([
  matchSchemaTooNew,
  matchMigrationRefusal,
  matchLegacyExecApprovals,
  matchPluginApiTooOld,
  matchCliStartupCrash,
  matchOwnershipConflict,
  matchPortInUse,
  matchOom,
  matchConfigInvalid,
]);

// { cause, detail, matchedLine, versions?, dbPath?, conflict? } for any
// observed exit; null only when there is nothing to classify (no code, no
// signal, empty tail). An exit no matcher recognizes is `unknown` with the
// tail's most error-shaped line (pickCauseLine, no last-line fallback) so
// repeated unknown crashes still fingerprint alike.
const classifyGatewayCrash = ({ code = null, signal = null, stderrTail = [] } = {}) => {
  const exitCode = toExitCode(code);
  const exitSignal = typeof signal === "string" && signal ? signal : null;
  const lines = selectTailLines(stderrTail);
  if (exitCode === null && exitSignal === null && lines.length === 0) return null;
  const input = { lines, code: exitCode, signal: exitSignal };
  for (const matcher of kMatchersByPrecedence) {
    const result = matcher(input);
    if (result) return result;
  }
  return {
    cause: "unknown",
    detail: `${describeExit(input)} without a recognized stderr signature`,
    matchedLine: pickCauseLine(lines.join("\n")),
  };
};

// ── fingerprint ────────────────────────────────────────────────────────────

// Lower-cased, ANSI-free, every slash-rooted token → `<path>`, every digit
// run → `#`, whitespace collapsed: two refusals that differ only in numbers
// (schema versions, pids, ports, timestamps) or locations are the SAME crash.
const normalizeCrashLine = (line) =>
  stripAnsi(String(line ?? ""))
    .toLowerCase()
    .replace(kPathTokenPattern, "<path>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();

// Short hex digest of "cause|exit|normalized line". `code` is the exit slot;
// a signal-terminated child (code null) contributes its signal instead so
// SIGKILL and SIGABRT loops stay distinct. A cause outside the enum is
// hashed as `unknown` rather than thrown — this runs on the crash path.
const fingerprintGatewayCrash = ({ cause, code = null, signal = null, matchedLine = null } = {}) => {
  const safeCause = kGatewayCrashCauses.includes(cause) ? cause : "unknown";
  const exitCode = toExitCode(code);
  const exitSlot = exitCode === null ? String(signal ?? "") : String(exitCode);
  return crypto
    .createHash("sha256")
    .update(`${safeCause}|${exitSlot}|${normalizeCrashLine(matchedLine)}`)
    .digest("hex")
    .slice(0, kFingerprintHexChars);
};

// ── corroboration (facts gathered independently of stderr) ─────────────────

const kNotCorroborated = Object.freeze({ corroborated: false, by: null });
const kSchemaKindByCause = Object.freeze({
  state_schema_too_new: "state",
  agent_schema_too_new: "agent",
});

// The observed `PRAGMA user_version` of the DB stderr named: an exact key
// first; otherwise a UNIQUE basename match (a symlinked volume spells the
// same file differently). Several agents share `openclaw-agent.sqlite`, so
// an ambiguous basename yields null — never a guess.
const lookupObservedUserVersion = (userVersionsByPath, dbPath) => {
  if (!userVersionsByPath || typeof userVersionsByPath !== "object" || !dbPath) return null;
  if (Object.hasOwn(userVersionsByPath, dbPath)) return toSchemaInt(userVersionsByPath[dbPath]);
  const base = path.posix.basename(dbPath);
  const candidates = Object.keys(userVersionsByPath).filter(
    (candidate) => path.posix.basename(candidate) === base,
  );
  return candidates.length === 1 ? toSchemaInt(userVersionsByPath[candidates[0]]) : null;
};

// Row 1 of the plan's table. Both arms need the DB's OBSERVED user_version:
//   user_version     — stderr's `found` equals what the DB really carries
//                      (table-free);
//   supported_schema — the DB really carries more than the exited build
//                      supports (supportedSchema[kind], declared/seeded).
// A stderr-only "found > supports" is NOT accepted: every number in that
// line is attacker-writable.
const corroborateSchema = (classification, facts) => {
  const kind = kSchemaKindByCause[classification.cause];
  const found = toSchemaInt(classification.versions?.found);
  const observed = lookupObservedUserVersion(facts.userVersionsByPath, classification.dbPath);
  if (observed === null) return kNotCorroborated;
  if (found !== null && observed === found) return { corroborated: true, by: "user_version" };
  const supported = toSchemaInt(facts.supportedSchema?.[kind]);
  if (supported !== null && observed > supported) {
    return { corroborated: true, by: "supported_schema" };
  }
  return kNotCorroborated;
};

// Row 2: the installed tree is not the build the channel state says it is
// (getChannelInfo().installedDiverged) — a plugin/CLI surface mismatch is
// exactly what a silently swapped tree produces.
const corroborateInstalledDiverged = (classification, facts) =>
  facts.installedDiverged === true
    ? { corroborated: true, by: "installed_diverged" }
    : kNotCorroborated;

// Row 3: the file really exists (the caller checks the SQLite-era condition).
const corroborateLegacyExecApprovals = (classification, facts) =>
  facts.legacyExecApprovalsPresent === true
    ? { corroborated: true, by: "legacy_exec_approvals_file" }
    : kNotCorroborated;

const kCorroborators = Object.freeze({
  state_schema_too_new: corroborateSchema,
  agent_schema_too_new: corroborateSchema,
  plugin_api_too_old: corroborateInstalledDiverged,
  cli_startup_crash: corroborateInstalledDiverged,
  legacy_exec_approvals: corroborateLegacyExecApprovals,
});
const kCorroboratedGatewayCrashCauses = Object.freeze(Object.keys(kCorroborators));

// { corroborated, by } — `by` names the independent fact that agreed with
// stderr, null otherwise. Causes without a corroborator (migration failure,
// ownership, oom, EX_CONFIG, unknown) are never corroborated: the legacy
// ladder owns them.
const corroborateGatewayCrash = ({ classification = null, facts = {} } = {}) => {
  const cause = classification?.cause;
  if (typeof cause !== "string" || !Object.hasOwn(kCorroborators, cause)) {
    return { ...kNotCorroborated };
  }
  return { ...kCorroborators[cause](classification, facts ?? {}) };
};

module.exports = {
  kGatewayCrashCauses,
  kVersionFamilyGatewayCrashCauses,
  kCorroboratedGatewayCrashCauses,
  classifyGatewayCrash,
  fingerprintGatewayCrash,
  normalizeCrashLine,
  corroborateGatewayCrash,
};
