// `alphaclaw diagnose` / GET /api/diagnose — ONE collector, two callers
// (issue #76 Part A, plan A9).
//
// The bundle is what an operator pastes into an incident: every piece of
// on-volume evidence the boot spine leaves behind, read in one pass, with
// each section stamped by where it came from:
//
//   live         computed in this process right now (a running server's
//                watchdog/channel info, a fresh /proc pidfile decision)
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
// its `.alphaclaw` managed dir comes from the store (never recomputed here),
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
const {
  readSqliteUserVersion: defaultReadSqliteUserVersion,
  resolveDeclaredSchemaVersionsAsync,
  createSchemaVersionTable,
} = require("../openclaw-schema-versions");
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
  "channelState",
  "pidfile",
  "stateDb",
  "supportedSchema",
  "incidents",
  "runs",
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
const kRunLimit = 3;
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

// Mirrors channel-sync's enumerateStateDbEntries: the global control-plane
// DB (kind "state") and every per-agent DB (kind "agent"). Two kinds, two
// schema lines — the renderer never compares them against each other.
const enumerateStateDbEntries = ({ fsModule, stateDir }) => {
  const entries = [];
  const globalDb = path.join(stateDir, "state", "openclaw.sqlite");
  if (fileExists(fsModule, globalDb)) entries.push({ path: globalDb, kind: "state", agentId: null });
  const agentsDir = path.join(stateDir, "agents");
  let agentIds = [];
  try {
    agentIds = fsModule.readdirSync(agentsDir);
  } catch {}
  for (const agentId of agentIds) {
    const agentDb = path.join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
    if (fileExists(fsModule, agentDb)) entries.push({ path: agentDb, kind: "agent", agentId });
  }
  return entries;
};

// <rootDir>/.env as KEY=VALUE pairs for the secret scrubber. env.js's
// readEnvFile is pinned to constants.ENV_FILE_PATH (the process's own root);
// the diagnose collector may be pointed at another root, so it applies the
// same line rule (blank/comment skipped, first `=` splits) to its own path.
// Callers that already hold readEnvFile()'s result pass `envFileVars`.
const readDotEnvVars = ({ fsModule, rootDir }) => {
  let content;
  try {
    content = fsModule.readFileSync(path.join(rootDir, ".env"), "utf8");
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
    const config = readOpenclawConfig({ fsModule, openclawDir, fallback: null });
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

const slimRun = (run) =>
  isPlainObject(run)
    ? {
        operationId: run.operationId ?? null,
        state: run.state ?? null,
        target: run.target ?? null,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
        ok: run.ok ?? null,
        steps: Array.isArray(run.steps) ? run.steps : [],
        backup: run.backup ?? null,
        dbPreflight: run.dbPreflight ?? null,
        result: isPlainObject(run.result)
          ? pickPresent(run.result, ["code", "error", "reason", "hint", "summary"])
          : null,
      }
    : null;

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
  openclawDir = path.join(rootDir, ".openclaw"),
  nowFn = Date.now,
  env = process.env,
  // The release-channel store for THIS root; built here when the caller has
  // none (the CLI). Every managed-dir path comes from it.
  channelStore = null,
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
  getChannelInfo = null,
  // Boot reports / self-version: a reader object, a function returning the
  // record, or the record itself; null → the modules read the managed dir.
  bootReports = null,
  selfVersion = null,
  schemaTable = null,
  readSqliteUserVersion = defaultReadSqliteUserVersion,
  // (packageDir) => declared | Promise<declared>
  resolveDeclared = null,
} = {}) => {
  const at = Number(nowFn());
  const generatedAtMs = Number.isFinite(at) ? at : Date.now();
  const bundleLogger = createSectionLogger();

  let store = channelStore;
  if (!store) {
    try {
      const { createOpenclawReleaseChannelStore } = require("../openclaw-release-channel");
      store = createOpenclawReleaseChannelStore({
        fsModule,
        rootDir,
        openclawDir,
        nowFn,
        logger: bundleLogger,
      });
    } catch (error) {
      bundleLogger.warn(`release-channel store unavailable: ${errorText(error)}`);
      store = null;
    }
  }
  const resolvedManagedDir =
    managedDir ?? store?.managedDir ?? path.join(openclawDir, ".alphaclaw");
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
  const requireStore = () => {
    if (!store) throw new Error("release-channel store unavailable");
    return store;
  };

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
      const unreadable = Array.isArray(reports?.unreadable) ? reports.unreadable.map(String) : [];
      const warnings = unreadable.map((name) => `${name} is unreadable (corrupt JSON)`);
      return {
        warnings,
        data: {
          managedDir: resolvedManagedDir,
          current,
          previous,
          incident,
          unreadable,
          verdict: Array.isArray(current?.serverPhase?.verdict) ? current.serverPhase.verdict : null,
        },
      };
    },

    channelState: () => {
      const channel = requireStore();
      const state = channel.readState();
      const stateCorrupted = state?.corrupted === true;
      const warnings = [];
      if (stateCorrupted) {
        warnings.push(
          `${channel.statePath} is unparseable — every field below is a DEFAULT, not evidence; gatewayHold cannot be read (hold gates fail closed on this)`,
        );
      }
      let installedVersion = null;
      if (resolvedInstallDir) {
        try {
          installedVersion = channel.readInstalledVersion({ installDir: resolvedInstallDir });
        } catch (error) {
          warnings.push(`installed version unreadable: ${errorText(error)}`);
        }
      }
      let info = null;
      if (typeof getChannelInfo === "function") {
        info = getChannelInfo();
        if (isPlainObject(info) && info.stateCorrupted === true && !stateCorrupted) {
          warnings.push("live channel info reports the state file as corrupted");
        }
      }
      return {
        source: info ? kDiagnoseSources.live : kDiagnoseSources.disk,
        warnings,
        data: {
          statePath: channel.statePath,
          stateCorrupted,
          installedVersion,
          pinVersion: state.pinVersion ?? null,
          applied: state.applied ?? null,
          lastKnownGood: state.lastKnownGood ?? null,
          blocklist: Array.isArray(state.blocklist) ? state.blocklist : [],
          gatewayHold: state.gatewayHold ?? null,
          lastBoot: state.lastBoot ?? null,
          lastUpdateRun: state.lastUpdateRun ?? null,
          configMigration: state.configMigration ?? null,
          lastTransition: state.lastTransition ?? null,
          pinLag: state.pinLag ?? null,
          rollbackRefused: state.rollbackRefused ?? null,
          forwardRecovery: state.forwardRecovery ?? null,
          noBootableVersion: state.noBootableVersion ?? null,
          previousPin: state.previousPin ?? null,
          pinWindow: state.pinWindow ?? null,
          backupsRecorded: Array.isArray(state.backups) ? state.backups.length : 0,
          info: isPlainObject(info)
            ? pickPresent(info, [
                "releaseChannel",
                "installedVersion",
                "expectedVersion",
                "expectedKind",
                "installedIsPin",
                "installedDiverged",
                "pinDiverged",
                "isPin",
                "appliedVersion",
                "inStabilizationWindow",
                "stateCorrupted",
              ])
            : null,
        },
      };
    },

    pidfile: () => {
      const channel = requireStore();
      const { formatServerPidDecision } = require("../openclaw-release-channel");
      const decision = channel.describeServerPidDecision();
      return {
        source: kDiagnoseSources.live,
        data: {
          path: channel.serverPidPath,
          decision,
          line: formatServerPidDecision(decision),
        },
      };
    },

    stateDb: () => {
      const entries = enumerateStateDbEntries({ fsModule, stateDir }).map((entry) => {
        let sizeBytes = null;
        try {
          sizeBytes = fsModule.statSync(entry.path).size;
        } catch {}
        const read = readSqliteUserVersion(entry.path, { fsModule });
        return {
          ...entry,
          sizeBytes,
          userVersion: Number.isInteger(read?.userVersion) ? read.userVersion : null,
          status: String(read?.status || "error"),
          error: read?.error ?? null,
        };
      });
      const warnings = [];
      if (entries.length === 0) warnings.push(`no state databases under ${stateDir} (fresh box, or a different OPENCLAW_STATE_DIR)`);
      for (const entry of entries) {
        if (entry.status === "corrupt") warnings.push(`${entry.path} is unreadable (${entry.error?.code || "corrupt"})`);
      }
      return {
        warnings,
        data: {
          stateDir,
          stateDirFromEnv: Boolean(String(env?.OPENCLAW_STATE_DIR || "").trim()),
          entries,
        },
      };
    },

    supportedSchema: async (logger) => {
      const channel = requireStore();
      if (!resolvedInstallDir) return unavailable("install dir unresolved — nothing to scan");
      const packageDir = path.join(resolvedInstallDir, "node_modules", "openclaw");
      const installedVersion = channel.readInstalledVersion({ installDir: resolvedInstallDir });
      const declared = await (typeof resolveDeclared === "function"
        ? resolveDeclared(packageDir)
        : resolveDeclaredSchemaVersionsAsync(packageDir, { fsModule }));
      const table =
        schemaTable ?? createSchemaVersionTable({ fsModule, managedDir: resolvedManagedDir, nowFn, logger });
      const tableRead = table.read();
      const fromTable = installedVersion ? table.supportedFor(installedVersion) : null;
      // Declared > table, per kind — the same precedence channel-sync's
      // mergeSupportedSchema applies at the apply/compat gates.
      const supportedFor = (kind) => {
        if (Number.isInteger(declared?.[kind])) return { value: declared[kind], source: "declared" };
        if (Number.isInteger(fromTable?.[kind])) return { value: fromTable[kind], source: fromTable.source };
        return { value: null, source: null };
      };
      const state = supportedFor("state");
      const agent = supportedFor("agent");
      const warnings = [];
      if (!installedVersion) warnings.push(`${packageDir}/package.json has no readable version`);
      if (state.value === null) warnings.push("state schema line unknown for the installed build (no declared constant, no table entry)");
      if (agent.value === null) warnings.push("agent schema line unknown for the installed build (no declared constant, no table entry)");
      return {
        warnings,
        data: {
          installedVersion,
          packageDir,
          declared: {
            state: declared?.state ?? null,
            agent: declared?.agent ?? null,
            files: Array.isArray(declared?.files) ? declared.files : [],
          },
          table: {
            path: table.filePath ?? null,
            origin: tableRead?.origin ?? null,
            installedEntry: fromTable,
            byVersion: isPlainObject(tableRead?.byVersion) ? tableRead.byVersion : {},
          },
          supported: {
            state: state.value,
            agent: agent.value,
            source: { state: state.source, agent: agent.source },
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

    runs: (logger) => {
      const { createRunLedger } = require("../openclaw-run-ledger");
      const ledger = createRunLedger({ fsModule, openclawDir, nowFn, logger });
      const runs = ledger.listRuns();
      const recent = runs.slice(0, kRunLimit);
      const recentIds = new Set(recent.map((run) => run.operationId));
      const running = runs.filter((run) => run.state === "running" && !recentIds.has(run.operationId));
      return {
        data: {
          total: runs.length,
          recent: recent.map(slimRun),
          running: running.map(slimRun),
        },
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
      // The one archive-name predicate every retention/inventory path uses.
      const { isBackupArchiveName } = require("../openclaw-channel-sync");
      const dir = path.join(rootDir, "backups", "openclaw");
      let names;
      try {
        names = fsModule.readdirSync(dir);
      } catch (error) {
        if (error?.code === "ENOENT") {
          return { data: { dir, present: false, archives: [], tmp: [], unverified: [], other: [], totals: null } };
        }
        throw error;
      }
      const archives = [];
      const tmp = [];
      const unverified = [];
      const other = [];
      const totals = {
        archives: { count: 0, bytes: 0 },
        tmp: { count: 0, bytes: 0 },
        unverified: { count: 0, bytes: 0 },
        other: { count: 0, bytes: 0 },
      };
      for (const name of names) {
        const full = path.join(dir, name);
        let stat = null;
        try {
          stat = fsModule.lstatSync ? fsModule.lstatSync(full) : fsModule.statSync(full);
        } catch {
          continue;
        }
        const isDir = typeof stat.isDirectory === "function" && stat.isDirectory();
        const entry = {
          name,
          sizeBytes: isDir ? null : Number(stat.size) || 0,
          mtimeMs: Number(stat.mtimeMs) || null,
          ...(isDir ? { directory: true } : {}),
        };
        const add = (bucket, list) => {
          list.push(entry);
          totals[bucket].count += 1;
          totals[bucket].bytes += entry.sizeBytes || 0;
        };
        if (name.endsWith(".tmp") || name.startsWith(".offline-copy-")) add("tmp", tmp);
        else if (name.endsWith(".unverified")) add("unverified", unverified);
        else if (!isDir && isBackupArchiveName(name)) add("archives", archives);
        else add("other", other);
      }
      const newestFirst = (list) => list.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
      const warnings = [];
      if (totals.tmp.count > 0) warnings.push(`${totals.tmp.count} temp entr${totals.tmp.count === 1 ? "y" : "ies"} (${totals.tmp.bytes} bytes) — crash debris the boot sweep should have removed`);
      if (totals.unverified.count > 0) warnings.push(`${totals.unverified.count} quarantined .unverified archive${totals.unverified.count === 1 ? "" : "s"} (${totals.unverified.bytes} bytes)`);
      return {
        warnings,
        data: {
          dir,
          present: true,
          archives: newestFirst(archives),
          tmp: newestFirst(tmp),
          unverified: newestFirst(unverified),
          other: newestFirst(other),
          totals,
        },
      };
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
    // The pidfile decision is live on every path; any OTHER live section
    // means a running server's getters were handed in.
    mode: bySource.live > 1 ? "server" : "cli",
    paths: {
      rootDir,
      openclawDir,
      managedDir: resolvedManagedDir,
      stateDir,
      installDir: resolvedInstallDir,
    },
    summary: {
      sources: bySource,
      unavailable: unavailableSections,
      bootVerdict: sections.bootReports.data?.verdict ?? null,
      stateCorrupted: sections.channelState.data?.stateCorrupted ?? null,
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
  enumerateStateDbEntries,
  slimIncident,
};
