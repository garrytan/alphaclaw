// `alphaclaw diagnose` / GET /api/diagnose — ONE collector, two callers
// (issue #76 Part A, plan A9).
//
// The bundle is what an operator pastes into an incident: every piece of
// on-volume evidence the boot spine leaves behind, read in one pass, with
// each section stamped by where it came from:
//
//   live         computed in this process right now (a running server's
//                watchdog status, a fresh /proc pidfile decision, a fresh
//                read of the state DBs' schema)
//   disk         read from the volume (a CLI run with the server down sees
//                exactly these; the server sees them too)
//   unavailable  the reader threw or has nothing to read from — `reason`
//                says why. A missing file is NOT unavailable: it is the
//                documented empty state and the section says so.
//
// Every section is independently try/caught (the readStatusSource pattern in
// routes/system.js): a corrupt watchdog.db must never hide the boot report
// that explains it, and no section may throw into the route or the CLI.
// The whole bundle is redacted (value-match against .env / openclaw.json /
// secret-named env keys, then the shape pass) BEFORE it is returned — the
// markdown renderer only ever sees redacted data.
//
// Paths are derived, never mkdir'd: <rootDir>/.openclaw is the state dir,
// `.alphaclaw` beneath it is the managed dir,
// <rootDir>/db/watchdog.db, <rootDir>/gateway-state.json,
// <rootDir>/backups/openclaw and <rootDir>/logs/process.log are the server's
// own conventions (db/watchdog/index.js, lib/server.js, constants.js,
// log-writer.js).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const constants = require("../constants");
const { readOpenclawConfig } = require("../openclaw-config");
const { kReadonlyBusyTimeoutMs } = require("../openclaw-state-db");
const { createOpenclawRuntime } = require("../openclaw-runtime");
const { createServerPidfile, formatServerPidDecision } = require("../server-pidfile");
const { kRetirementFileName } = require("../openclaw-channel-retirement");
const { kBootMigrationFileName } = require("../openclaw-boot-migration");
const { readRegularFileBounded } = require("../utils/bounded-file");
const { kRestartOperationFilePath } = require("../restart-required-state");
const {
  collectSecretValues,
  redactSecrets,
  redactSecretShapes,
} = require("../utils/redact");
const { tailLines: readTailLines, filterLogLines } = require("../utils/tail-bytes");

const kDiagnoseSchema = "alphaclaw.diagnose.v1";
const kDiagnoseSources = Object.freeze({
  live: "live",
  disk: "disk",
  unavailable: "unavailable",
});
// Ordered: the markdown renders sections in this order and the route/CLI
// tests pin the set.
const kDiagnoseSectionNames = Object.freeze([
  "selfVersion",
  "bootReports",
  "openclaw",
  "pidfile",
  "stateDb",
  "supportedSchema",
  "incidents",
  "restartOperation",
  "gatewayState",
  "backups",
  "watchdog",
  "logTail",
]);
// process.log carries every subsystem's console output; the diagnose tail
// keeps the boot spine's own lines. Substring match — timestamps or the
// log-writer's prefixes may precede the tag.
const kDiagnoseLogLinePattern = /\[(alphaclaw|openclaw-channel|gateway|watchdog)\]/;
const kDefaultLogTailLines = 200;
const kDefaultLogTailBytes = 512 * 1024;
const kIncidentLimit = 3;
// The boot-report writer needs a bootId to MERGE; a reader never merges, so
// the diagnose reader carries a marker id that can never equal a real boot's
// `${pid}:${ms}`.
const kDiagnoseReaderBootId = "diagnose:reader";
// getStatus() fields worth pasting into an incident (stable scalars; the
// history/tails the console renders stay out of the bundle).
const kWatchdogStatusFields = Object.freeze([
  "lifecycle",
  "health",
  "uptimeStartedAt",
  "lastHealthCheckAt",
  "repairAttempts",
  "repairAttemptLimit",
  "autoRepair",
  "autoRepairPaused",
  "crashCountInWindow",
  "operationInProgress",
  "gatewayPid",
  "servingPid",
  "supervisionMode",
  "readiness",
  "readinessReason",
  // #87: the last /readyz phase (started|starting|draining) and how the last
  // read went (ok|unconfigured|unsupported|unavailable|timeout|malformed).
  "readinessStatus",
  "readinessProbe",
  "replacementPending",
  "lastRepairVerdict",
  "incumbentConflict",
  "safeMode",
  "degradedReason",
  "degradedSince",
  "lastExit",
  "versionMismatch",
  "prelaunchHook",
]);
// Incident summary fields the bundle keeps (the close-time status/resource
// snapshots are evidence for the console, not for a paste).
const kIncidentSummaryFields = Object.freeze([
  "trigger",
  "severity",
  "outcome",
  "durationMs",
  "eventCounts",
  "cause",
  "crashedPids",
]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const errorText = (error) => String(error?.message || error || "unknown error");

const pickPresent = (source, keys) => {
  if (!isPlainObject(source)) return null;
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
};

// Per-section logger: sub-readers (the store, the schema table, the boot
// report reader) warn on corrupt files; those warnings belong IN the section
// they describe, not on the caller's console.
const createSectionLogger = () => {
  const warnings = [];
  const note = (message) => {
    warnings.push(String(message));
  };
  return { warnings, warn: note, error: note, log: () => {}, info: () => {} };
};

// { status: "ok", value } | { status: "missing" } | { status: "unreadable", error }
const readJsonFileLenient = (fsModule, filePath) => {
  let raw;
  try {
    raw = fsModule.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", error: errorText(error) };
  }
  try {
    const value = JSON.parse(raw);
    if (!isPlainObject(value)) return { status: "unreadable", error: "not a JSON object" };
    return { status: "ok", value };
  } catch (error) {
    return { status: "unreadable", error: errorText(error) };
  }
};

const fileExists = (fsModule, filePath) => {
  try {
    return fsModule.existsSync(filePath);
  } catch {
    return false;
  }
};

// The state dir the INSTALLED CLI uses — the same rule as channel-sync's
// stateDir(): OPENCLAW_STATE_DIR from the env when set (`~/` expanded,
// resolved), else the openclaw dir.
const resolveStateDir = ({ env, openclawDir }) => {
  let fromEnv = "";
  try {
    fromEnv = String(env?.OPENCLAW_STATE_DIR || "").trim();
  } catch {}
  if (!fromEnv) return openclawDir;
  if (fromEnv.startsWith("~/")) fromEnv = path.join(os.homedir(), fromEnv.slice(2));
  return path.resolve(fromEnv);
};

// <rootDir>/.env as KEY=VALUE pairs for the secret scrubber. env.js's
// readEnvFile is pinned to constants.ENV_FILE_PATH (the process's own root);
// the diagnose collector may be pointed at another root, so it applies the
// same line rule (blank/comment skipped, first `=` splits) to its own path.
// Callers that already hold readEnvFile()'s result pass `envFileVars`.
const readDotEnvVars = ({ fsModule, rootDir }) => {
  let content;
  try {
    content = readRegularFileBounded(fsModule.realpathSync(path.join(rootDir, ".env")), { fsModule });
  } catch {
    return [];
  }
  const vars = [];
  for (const line of String(content).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    vars.push({ key: trimmed.slice(0, eqIdx).trim(), value: trimmed.slice(eqIdx + 1) });
  }
  return vars;
};

// Value-match (every collected secret) then shape pass, on every string leaf
// of the bundle. Keys are structure, not evidence, and stay as they are.
const redactDeep = (value, scrub) => {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, scrub));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactDeep(entry, scrub);
    return out;
  }
  return value;
};

const buildScrubber = ({ fsModule, rootDir, openclawDir, env, envFileVars }) => {
  const configObjects = [];
  try {
    const config = readOpenclawConfig({ fsModule: {
      readFileSync: (file) => readRegularFileBounded(fsModule.realpathSync(file), { fsModule }),
    }, openclawDir, fallback: null });
    if (isPlainObject(config)) configObjects.push(config);
  } catch {}
  let fileVars = Array.isArray(envFileVars) ? envFileVars : null;
  if (fileVars === null) {
    try {
      fileVars = readDotEnvVars({ fsModule, rootDir });
    } catch {
      fileVars = [];
    }
  }
  const secrets = collectSecretValues({ env, envFileVars: fileVars, configObjects });
  return (text) => redactSecretShapes(redactSecrets(String(text ?? ""), { secrets }));
};

// Slim incident record shared by the live (db.listIncidents) and the disk
// (read-only SELECT) paths. `cause` (plan A3, `cause_json`) is read from
// whichever place the row carries it; null when the column predates A3.
const slimIncident = (row) => {
  if (!isPlainObject(row)) return null;
  const parse = (raw) => {
    if (raw == null || raw === "") return null;
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return { unreadable: true };
    }
  };
  const summary = parse(row.summary ?? row.summary_json);
  const cause = row.cause !== undefined ? row.cause : parse(row.cause_json);
  return {
    id: Number(row.id),
    incidentKey: row.incidentKey ?? row.incident_key ?? null,
    status: row.status ?? null,
    openedAt: row.openedAt ?? row.opened_at ?? null,
    resolvedAt: row.resolvedAt ?? row.resolved_at ?? null,
    cause: cause ?? (isPlainObject(summary) ? summary.cause ?? null : null),
    eventCount: Number.isFinite(Number(row.eventCount ?? row.event_count))
      ? Number(row.eventCount ?? row.event_count)
      : null,
    summary: isPlainObject(summary)
      ? summary.unreadable
        ? { unreadable: true }
        : pickPresent(summary, kIncidentSummaryFields)
      : null,
  };
};

// CLI path: the server is down (or this is not the server), so the DB is
// opened READ-ONLY for one SELECT and closed. Never initWatchdogDb — that
// would create the schema, start the prune timer and take a writer handle.
const readIncidentsReadOnly = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${kReadonlyBusyTimeoutMs};`);
    return db
      .prepare(`SELECT * FROM watchdog_incidents ORDER BY id DESC LIMIT ${kIncidentLimit}`)
      .all();
  } finally {
    try {
      db.close();
    } catch {}
  }
};

const splitCompleteLines = (text) => {
  const value = String(text ?? "");
  if (!value) return [];
  let lines = value.split("\n");
  if (!value.endsWith("\n")) lines = lines.slice(0, -1);
  return lines.filter((line) => line.length > 0);
};

const callOrValue = (candidate) => (typeof candidate === "function" ? candidate() : candidate);

const collectDiagnose = async ({
  fsModule = fs,
  rootDir = constants.kRootDir,
  rootSource = "server_configuration",
  openclawDir = path.join(rootDir, ".openclaw"),
  nowFn = Date.now,
  env = process.env,
  managedDir = null,
  // AlphaClaw's install dir (node_modules/openclaw lives under it).
  installDir = null,
  // Value list from readEnvFile() when the caller already has it.
  envFileVars = null,
  // (maxBytes) => string — the server's log-writer readLogTail; default reads
  // <rootDir>/logs/process.log through utils/tail-bytes.
  readLogTail = null,
  tailLines: logTailLines = kDefaultLogTailLines,
  logTailBytes = kDefaultLogTailBytes,
  // Live seams (server path). Absent → the section reads disk or is
  // unavailable with a reason naming the CLI path.
  incidentsDb = null,
  getWatchdogStatus = null,
  // The server's openclaw runtime (openclaw-runtime.js); the CLI builds one
  // for this root.
  openclawRuntime = null,
  // Boot reports / self-version: a reader object, a function returning the
  // record, or the record itself; null → the modules read the managed dir.
  bootReports = null,
  selfVersion = null,
} = {}) => {
  const at = Number(nowFn());
  const generatedAtMs = Number.isFinite(at) ? at : Date.now();
  const bundleLogger = createSectionLogger();

  const resolvedManagedDir = managedDir ?? path.join(openclawDir, ".alphaclaw");
  const stateDir = resolveStateDir({ env, openclawDir });
  let resolvedInstallDir = installDir;
  if (!resolvedInstallDir) {
    try {
      const { resolveSelfDependency } = require("../self-dependency");
      resolvedInstallDir = resolveSelfDependency({ fsImpl: fsModule }).installDir || null;
    } catch (error) {
      bundleLogger.warn(`install dir unresolved: ${errorText(error)}`);
      resolvedInstallDir = null;
    }
  }
  const runtime = openclawRuntime ?? createOpenclawRuntime({
    openclawDir,
    resolveInstallDir: () => resolvedInstallDir,
    openclawSpawnEnv: () => ({ ...env, OPENCLAW_STATE_DIR: stateDir }),
    fsModule,
    nowFn,
    logger: bundleLogger,
  });

  // The readStatusSource discipline per section: the reader's own failure
  // becomes THAT section's `unavailable` + reason, nothing else moves.
  const section = async (name, read) => {
    const logger = createSectionLogger();
    try {
      const result = await read(logger);
      const source = result?.source ?? kDiagnoseSources.disk;
      return {
        source,
        reason: source === kDiagnoseSources.unavailable ? String(result?.reason || "no reader") : null,
        warnings: [...logger.warnings, ...(Array.isArray(result?.warnings) ? result.warnings : [])],
        data: source === kDiagnoseSources.unavailable ? null : (result?.data ?? null),
      };
    } catch (error) {
      return {
        source: kDiagnoseSources.unavailable,
        reason: `${name} failed: ${errorText(error)}`,
        warnings: [...logger.warnings],
        data: null,
      };
    }
  };
  const unavailable = (reason) => ({ source: kDiagnoseSources.unavailable, reason });

  const readers = {
    selfVersion: (logger) => {
      const { readSelfVersionStamp, kSelfVersionFileName } = require("../alphaclaw-self-version");
      const stampPath = path.join(resolvedManagedDir, kSelfVersionFileName);
      const record =
        selfVersion !== null
          ? callOrValue(selfVersion)
          : readSelfVersionStamp({ fsModule, managedDir: resolvedManagedDir, logger });
      const present = fileExists(fsModule, stampPath);
      const warnings = [];
      if (present && record == null) warnings.push(`${stampPath} is present but unreadable`);
      return {
        warnings,
        data: { path: stampPath, present, record: isPlainObject(record) ? record : null },
      };
    },

    bootReports: (logger) => {
      let reports;
      if (typeof bootReports === "function") {
        reports = bootReports();
      } else if (bootReports && typeof bootReports.readBootReports === "function") {
        reports = bootReports.readBootReports();
      } else if (isPlainObject(bootReports)) {
        reports = bootReports;
      } else {
        const bootReportModule = require("../boot-report");
        reports =
          typeof bootReportModule.readBootReports === "function"
            ? bootReportModule.readBootReports({ fsModule, managedDir: resolvedManagedDir, logger })
            : bootReportModule
                .createBootReportWriter({
                  fsModule,
                  managedDir: resolvedManagedDir,
                  nowFn,
                  bootId: kDiagnoseReaderBootId,
                  logger,
                })
                .readBootReports();
      }
      const current = isPlainObject(reports?.current) ? reports.current : null;
      const previous = Array.isArray(reports?.previous) ? reports.previous.filter(isPlainObject) : [];
      const incident = isPlainObject(reports?.incident) ? reports.incident : null;
      // The last start the pidfile guard REFUSED for a corroborated live
      // owner (boot-report-refused.json). The writer keeps it out of the
      // ring so a doomed second instance never evicts the live server's
      // report; it is its own entry here and never the current boot.
      const refused = isPlainObject(reports?.refused) ? reports.refused : null;
      const unreadable = Array.isArray(reports?.unreadable) ? reports.unreadable.map(String) : [];
      const warnings = unreadable.map((name) => `${name} is unreadable (corrupt JSON)`);
      const currentStateDir = current?.openclaw?.stateDir;
      const previousStateDir = previous[0]?.openclaw?.stateDir;
      if (typeof currentStateDir === "string" && currentStateDir &&
          typeof previousStateDir === "string" && previousStateDir &&
          currentStateDir !== previousStateDir) {
        warnings.push(`OpenClaw state path changed between boots: ${previousStateDir} → ${currentStateDir}. Cron jobs and run history are keyed by this path, even when both paths resolve to the same directory. Restore the previous OPENCLAW_STATE_DIR if this change was unintended; do not re-key SQLite rows by hand.`);
      }
      return {
        warnings,
        data: {
          managedDir: resolvedManagedDir,
          current,
          previous,
          incident,
          refused,
          unreadable,
          verdict: Array.isArray(current?.serverPhase?.verdict) ? current.serverPhase.verdict : null,
        },
      };
    },

    openclaw: () => {
      const info = runtime.getInfo();
      const readRecord = (name) => {
        const read = readJsonFileLenient(fsModule, path.join(resolvedManagedDir, name));
        return read.status === "ok" ? read.value : null;
      };
      const warnings = [];
      if (info.installedDiverged) {
        warnings.push(`installed OpenClaw ${info.installedVersion} is not the pinned ${info.pinnedVersion} — the install is broken or stale; redeploy this AlphaClaw`);
      }
      return {
        source: kDiagnoseSources.live,
        warnings,
        data: {
          ...info,
          bootMigration: readRecord(kBootMigrationFileName),
          retiredChannel: readRecord(kRetirementFileName),
        },
      };
    },

    pidfile: () => {
      const pidfile = createServerPidfile({ managedDir: resolvedManagedDir, fsModule });
      const decision = pidfile.describeServerPidDecision();
      return {
        source: kDiagnoseSources.live,
        data: {
          path: pidfile.serverPidPath,
          decision,
          line: formatServerPidDecision(decision),
        },
      };
    },

    stateDb: async () => {
      const versions = await runtime.readStateDbVersions();
      const warnings = [];
      if (!versions.entries.length) warnings.push(`no state databases found under ${stateDir}`);
      for (const entry of versions.entries) {
        if (entry.status === "corrupt") warnings.push(`${entry.path} is unreadable (${entry.error || "corrupt"})`);
      }
      const sizeOf = (filePath) => {
        try {
          return Number(fsModule.statSync(filePath).size);
        } catch {
          return null;
        }
      };
      return {
        source: kDiagnoseSources.live,
        warnings,
        data: {
          stateDir,
          stateDirFromEnv: Boolean(String(env?.OPENCLAW_STATE_DIR || "").trim()),
          entries: versions.entries.map((entry) => ({ ...entry, sizeBytes: sizeOf(entry.path) })),
        },
      };
    },

    supportedSchema: async () => {
      const build = await runtime.getExecutingBuild();
      const supported = build?.schemas || {};
      const warnings = [];
      if (!build) warnings.push("The installed OpenClaw build could not be found");
      if (supported.state == null) warnings.push("state schema line unknown for the installed build");
      if (supported.agent == null) warnings.push("agent schema line unknown for the installed build");
      return {
        warnings,
        data: {
          installedVersion: build?.version ?? null,
          packageDir: build?.packageDir ?? null,
          supported: {
            state: supported.state ?? null,
            agent: supported.agent ?? null,
            source: { state: supported.source?.state ?? null, agent: supported.source?.agent ?? null },
          },
        },
      };
    },

    incidents: () => {
      if (incidentsDb && typeof incidentsDb.listIncidents === "function") {
        const rows = incidentsDb.listIncidents({ limit: kIncidentLimit });
        return {
          source: kDiagnoseSources.live,
          data: {
            dbPath: null,
            incidents: (Array.isArray(rows) ? rows : []).slice(0, kIncidentLimit).map(slimIncident).filter(Boolean),
          },
        };
      }
      const dbPath = path.join(rootDir, "db", "watchdog.db");
      if (!fileExists(fsModule, dbPath)) {
        return unavailable(`${dbPath} not found (no watchdog has run on this root)`);
      }
      const rows = readIncidentsReadOnly(dbPath);
      return {
        data: { dbPath, incidents: rows.map(slimIncident).filter(Boolean) },
      };
    },

    restartOperation: () => {
      const filePath = path.join(openclawDir, path.basename(kRestartOperationFilePath));
      const read = readJsonFileLenient(fsModule, filePath);
      const warnings = read.status === "unreadable" ? [`${filePath} is unreadable (${read.error})`] : [];
      return {
        warnings,
        data: {
          path: filePath,
          present: read.status !== "missing",
          record: read.status === "ok" ? read.value : null,
        },
      };
    },

    gatewayState: () => {
      const filePath = path.join(rootDir, "gateway-state.json");
      const read = readJsonFileLenient(fsModule, filePath);
      const warnings = read.status === "unreadable" ? [`${filePath} is unreadable (${read.error})`] : [];
      return {
        warnings,
        data: {
          path: filePath,
          present: read.status !== "missing",
          record: read.status === "ok" ? read.value : null,
        },
      };
    },

    backups: () => {
      const dir = path.join(rootDir, "backups", "openclaw");
      let names;
      try {
        names = fsModule.readdirSync(dir);
      } catch (error) {
        if (error?.code === "ENOENT") return { data: { dir, present: false, entries: [], totalBytes: 0 } };
        throw error;
      }
      const entries = [];
      let totalBytes = 0;
      for (const name of names) {
        let stat = null;
        try {
          stat = fsModule.lstatSync ? fsModule.lstatSync(path.join(dir, name)) : fsModule.statSync(path.join(dir, name));
        } catch {
          continue;
        }
        const isDir = typeof stat.isDirectory === "function" && stat.isDirectory();
        const sizeBytes = isDir ? null : Number(stat.size) || 0;
        totalBytes += sizeBytes || 0;
        entries.push({ name, sizeBytes, mtimeMs: Number(stat.mtimeMs) || null, ...(isDir ? { directory: true } : {}) });
      }
      entries.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
      return { data: { dir, present: true, entries, totalBytes } };
    },

    watchdog: () => {
      if (typeof getWatchdogStatus !== "function") {
        return unavailable("no live watchdog in this process (the CLI reads disk only; GET /api/diagnose on the running server has it)");
      }
      const status = getWatchdogStatus();
      if (!isPlainObject(status)) return unavailable("watchdog.getStatus() returned nothing");
      return { source: kDiagnoseSources.live, data: pickPresent(status, kWatchdogStatusFields) };
    },

    logTail: () => {
      const logPath = path.join(rootDir, "logs", "process.log");
      const maxLines = Number.isInteger(logTailLines) && logTailLines > 0 ? logTailLines : kDefaultLogTailLines;
      const warnings = [];
      let lines;
      let source = null;
      if (typeof readLogTail === "function") {
        lines = splitCompleteLines(readLogTail(logTailBytes));
        source = "readLogTail";
      } else {
        if (!fileExists(fsModule, logPath)) warnings.push(`${logPath} not found`);
        lines = readTailLines(logPath, logTailBytes);
        source = logPath;
      }
      const matched = filterLogLines(lines, kDiagnoseLogLinePattern);
      const kept = matched.slice(-maxLines);
      return {
        warnings,
        data: {
          path: source,
          pattern: kDiagnoseLogLinePattern.source,
          scannedLines: lines.length,
          matchedLines: matched.length,
          truncated: matched.length > kept.length,
          lines: kept,
        },
      };
    },
  };

  const sections = {};
  for (const name of kDiagnoseSectionNames) {
    sections[name] = await section(name, readers[name]);
  }

  const bySource = { live: 0, disk: 0, unavailable: 0 };
  const unavailableSections = [];
  for (const name of kDiagnoseSectionNames) {
    const source = sections[name].source;
    bySource[source] = (bySource[source] || 0) + 1;
    if (source === kDiagnoseSources.unavailable) unavailableSections.push(name);
  }

  const bundle = {
    schema: kDiagnoseSchema,
    generatedAt: new Date(generatedAtMs).toISOString(),
    generatedAtMs,
    // A live watchdog is only handed in by the running server.
    mode: typeof getWatchdogStatus === "function" ? "server" : "cli",
    paths: {
      rootDir,
      rootSource: ["cli", "environment", "default_home", "server_configuration"].includes(rootSource)
        ? rootSource : "server_configuration",
      openclawDir,
      managedDir: resolvedManagedDir,
      stateDir,
      installDir: resolvedInstallDir,
    },
    summary: {
      sources: bySource,
      unavailable: unavailableSections,
      bootVerdict: sections.bootReports.data?.verdict ?? null,
    },
    warnings: [...bundleLogger.warnings],
    sections,
    redacted: true,
  };

  const scrub = buildScrubber({ fsModule, rootDir, openclawDir, env, envFileVars });
  return redactDeep(bundle, scrub);
};

module.exports = {
  kDiagnoseSchema,
  kDiagnoseSources,
  kDiagnoseSectionNames,
  kDiagnoseLogLinePattern,
  kDefaultLogTailLines,
  kDefaultLogTailBytes,
  kWatchdogStatusFields,
  collectDiagnose,
  // Exposed for tests / the renderer.
  resolveStateDir,
  slimIncident,
};
