const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  readOpenclawConfig,
  resolveOpenclawConfigPath,
  writeOpenclawConfig,
} = require("./openclaw-config");
const { resolveOpenclawStateDbPath, hasTable } = require("./openclaw-state-db");

const kManagedExecApprovalsDefaults = Object.freeze({
  security: "full",
  ask: "off",
  askFallback: "full",
});

const kManagedOpenclawExecDefaults = Object.freeze({
  security: "full",
  strictInlineEval: false,
});

const resolveExecApprovalsConfigPath = ({ openclawDir }) =>
  path.join(openclawDir, "exec-approvals.json");

const readExecApprovalsConfig = ({
  fsModule = fs,
  openclawDir,
  fallback = { version: 1 },
} = {}) => {
  const filePath = resolveExecApprovalsConfigPath({ openclawDir });
  try {
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
};

const writeExecApprovalsConfig = ({
  fsModule = fs,
  openclawDir,
  file = {},
  spacing = 2,
} = {}) => {
  const filePath = resolveExecApprovalsConfigPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  fsModule.writeFileSync(filePath, JSON.stringify(file, null, spacing) + "\n", "utf8");
  return filePath;
};

const hasOwn = (obj, key) =>
  !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

// openclaw >= 2026.9.1-beta.1 stores exec approvals in SQLite
// (<openclawDir>/state/openclaw.sqlite, table exec_approvals_config) and
// hard-fails ALL channels/cron/heartbeat while the legacy exec-approvals.json
// exists. Feature-detect the store — never version-sniff (repo philosophy).
// The injected fsModule answers "is there a state db" so memory-fs harnesses
// can steer the answer; the table check needs a real read-only DatabaseSync
// (openReadonlyOpenclawStateDb uses the real fs, hence the split). Any error
// (locked/corrupt db, fake path from a memory fs) degrades to false =
// file-era behavior; worst case the legacy file is recreated once and the
// boot reaper self-heals on the next boot.
const detectSqliteExecApprovals = ({ fsModule = fs, openclawDir } = {}) => {
  try {
    const databasePath = resolveOpenclawStateDbPath({ openclawDir });
    if (
      typeof fsModule.existsSync !== "function" ||
      !fsModule.existsSync(databasePath)
    ) {
      return false;
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return hasTable(db, "exec_approvals_config");
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
};

const ensureManagedExecApprovalsDefaults = (rawFile = {}) => {
  const file =
    rawFile && typeof rawFile === "object" && !Array.isArray(rawFile) ? rawFile : {};
  const before = JSON.stringify(file);
  const defaults =
    file.defaults && typeof file.defaults === "object" && !Array.isArray(file.defaults)
      ? file.defaults
      : null;
  const hasNonEmptyDefaults = !!defaults && Object.keys(defaults).length > 0;
  if (!hasNonEmptyDefaults) {
    if (!Number.isInteger(file.version)) file.version = 1;
    file.defaults = {
      security: kManagedExecApprovalsDefaults.security,
      ask: kManagedExecApprovalsDefaults.ask,
      askFallback: kManagedExecApprovalsDefaults.askFallback,
    };
  }
  const changed = JSON.stringify(file) !== before;
  // Callers always get a well-formed agents map (previously only the seed
  // branch guaranteed it). Shape normalization alone never marks the file
  // changed, so an existing file is never rewritten just to add "agents": {}
  // — the byte-identical round-trip contract stays intact.
  if (!file.agents || typeof file.agents !== "object" || Array.isArray(file.agents)) {
    file.agents = {};
  }
  return {
    file,
    changed,
  };
};

const ensureManagedOpenclawExecDefaults = (rawConfig = {}) => {
  const config =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const before = JSON.stringify(config);
  if (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools)) {
    config.tools = {};
  }
  if (!hasOwn(config.tools, "exec")) {
    config.tools.exec = {
      security: kManagedOpenclawExecDefaults.security,
      strictInlineEval: kManagedOpenclawExecDefaults.strictInlineEval,
    };
  }
  return {
    config,
    changed: JSON.stringify(config) !== before,
  };
};

const ensureManagedExecDefaults = ({
  fsModule = fs,
  openclawDir,
  detectSqliteStore = detectSqliteExecApprovals,
} = {}) => {
  let openclawChanged = false;
  let approvalsChanged = false;

  const openclawConfigPath = resolveOpenclawConfigPath({ openclawDir });
  const openclawExists =
    typeof fsModule.existsSync === "function" ? fsModule.existsSync(openclawConfigPath) : null;
  if (openclawExists !== false) {
    const cfg = readOpenclawConfig({
      fsModule,
      openclawDir,
      fallback: openclawExists === true ? null : {},
    });
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
      const ensuredConfig = ensureManagedOpenclawExecDefaults(cfg);
      if (ensuredConfig.changed) {
        writeOpenclawConfig({
          fsModule,
          openclawDir,
          config: ensuredConfig.config,
          spacing: 2,
        });
        openclawChanged = true;
      }
    }
  }

  // Issue #23: on a SQLite-era openclaw the legacy exec-approvals.json must
  // never be (re)created — its mere existence hard-breaks the gateway. The
  // managed defaults below are byte-identical to what openclaw's own
  // ensureExecApprovals() seeds into its SQLite store, so skipping the file
  // half entirely loses nothing on that era. File-era behavior is unchanged.
  if (detectSqliteStore({ fsModule, openclawDir }) !== true) {
    const approvalsPath = resolveExecApprovalsConfigPath({ openclawDir });
    const approvalsExists =
      typeof fsModule.existsSync === "function" ? fsModule.existsSync(approvalsPath) : null;
    const approvals = readExecApprovalsConfig({
      fsModule,
      openclawDir,
      fallback: approvalsExists === true ? null : { version: 1 },
    });
    if (approvals && typeof approvals === "object" && !Array.isArray(approvals)) {
      const ensuredApprovals = ensureManagedExecApprovalsDefaults(approvals);
      if (ensuredApprovals.changed || approvalsExists === false) {
        writeExecApprovalsConfig({
          fsModule,
          openclawDir,
          file: ensuredApprovals.file,
          spacing: 2,
        });
        approvalsChanged = true;
      }
    }
  }

  return {
    changed: openclawChanged || approvalsChanged,
    openclawChanged,
    approvalsChanged,
  };
};

// Self-heal a box already poisoned by an older alphaclaw (issue #23): a
// SQLite-era gateway refuses channels/cron/heartbeat while the legacy file
// exists next to its exec_approvals_config table. RENAME — never delete —
// (non-destructive, matches the incident workaround) so the gateway's
// existence gate unblocks; openclaw caches absence only, so this helps even a
// running gateway. Called from the earliest pre-server hook (runtime-init,
// beside migrateManagedInternalFiles), which has no notifier access — the
// loud log line is the record (notification id "exec-approvals-stray-reaped"
// would need plumbing that does not exist that early; deliberately log-only).
const reapStrayLegacyExecApprovals = ({
  fsModule = fs,
  openclawDir,
  logger = console,
  nowFn = Date.now,
  detectSqliteStore = detectSqliteExecApprovals,
} = {}) => {
  try {
    const legacyPath = resolveExecApprovalsConfigPath({ openclawDir });
    if (
      typeof fsModule.existsSync !== "function" ||
      !fsModule.existsSync(legacyPath)
    ) {
      return { reaped: false };
    }
    if (detectSqliteStore({ fsModule, openclawDir }) !== true) {
      // File-era openclaw: the legacy file is the live store — leave it alone.
      return { reaped: false };
    }
    const strayPath = `${legacyPath}.stray-${nowFn()}`;
    fsModule.renameSync(legacyPath, strayPath);
    logger.warn?.(
      `[alphaclaw] Legacy exec-approvals.json blocks this openclaw (exec approvals live in SQLite) — renamed it to ${strayPath}`,
    );
    return { reaped: true, strayPath };
  } catch (error) {
    logger.error?.(
      `[alphaclaw] Failed to reap stray exec-approvals.json: ${error.message || String(error)}`,
    );
    return { reaped: false, error: error.message || String(error) };
  }
};

module.exports = {
  kManagedExecApprovalsDefaults,
  kManagedOpenclawExecDefaults,
  resolveExecApprovalsConfigPath,
  readExecApprovalsConfig,
  writeExecApprovalsConfig,
  ensureManagedExecApprovalsDefaults,
  ensureManagedOpenclawExecDefaults,
  ensureManagedExecDefaults,
  detectSqliteExecApprovals,
  reapStrayLegacyExecApprovals,
};
