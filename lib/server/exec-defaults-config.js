const fs = require("fs");
const path = require("path");
const { fireAndForgetNotify } = require("./notification-policy");
const {
  readOpenclawConfig,
  resolveOpenclawConfigPath,
  writeOpenclawConfig,
} = require("./openclaw-config");

// `mode` (enum deny|allowlist|ask|auto|full) validates on BOTH the pinned
// 2026.7.1-2 and the 2026.9.x beta, while the older `security`/`ask` pair is
// flagged legacy by the beta's doctor (config refusals until `doctor --fix`).
// Seeding `mode` is therefore version-portable; era gating is not needed here.
const kManagedOpenclawExecDefaults = Object.freeze({
  mode: "full",
  strictInlineEval: false,
});

const resolveExecApprovalsConfigPath = ({ openclawDir }) =>
  path.join(openclawDir, "exec-approvals.json");

const hasOwn = (obj, key) =>
  !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

const ensureManagedOpenclawExecDefaults = (rawConfig = {}) => {
  const config =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const before = JSON.stringify(config);
  if (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools)) {
    config.tools = {};
  }
  if (!hasOwn(config.tools, "exec")) {
    config.tools.exec = {
      mode: kManagedOpenclawExecDefaults.mode,
      strictInlineEval: kManagedOpenclawExecDefaults.strictInlineEval,
    };
  }
  return {
    config,
    changed: JSON.stringify(config) !== before,
  };
};

// Self-heal a box already poisoned by an older alphaclaw (issue #23): a
// SQLite-era gateway refuses channels/cron/heartbeat while the legacy file
// exists next to its exec_approvals_config row. RENAME — never delete —
// (non-destructive, matches the incident workaround) so the gateway's
// existence gate unblocks; openclaw caches absence only, so this helps even a
// running gateway. `reapAllowed` is the caller's era decision: the row must
// be present AND the ACTIVE runtime must be sqlite-era — row presence alone
// is historical state (a restored backup or forced downgrade can leave a row
// next to a live file the old runtime still needs), and a genuine legacy file
// awaiting `doctor --fix` import (no row yet) must never be renamed before
// the import runs.
const reapStrayLegacyExecApprovals = ({
  fsModule = fs,
  openclawDir,
  logger = console,
  nowFn = Date.now,
  reapAllowed = false,
} = {}) => {
  try {
    const legacyPath = resolveExecApprovalsConfigPath({ openclawDir });
    if (
      typeof fsModule.existsSync !== "function" ||
      !fsModule.existsSync(legacyPath)
    ) {
      return { reaped: false };
    }
    if (reapAllowed !== true) {
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

const ensureManagedExecDefaults = async ({
  fsModule = fs,
  openclawDir,
  // Injected from openclaw-state-era's createStateEra().resolveExecApprovalsBackend.
  resolveExecApprovalsBackend = null,
  logger = console,
  nowFn = Date.now,
  // Optional auto-fix notifier (lib/server.js wires upgradeNotifier.notify).
  // Fire-and-forget and never-throw: a notifier failure must not turn a
  // successful cleanup into a failed boot step.
  notify = null,
} = {}) => {
  const announce = (message, opts) =>
    fireAndForgetNotify(notify, message, opts);
  let openclawChanged = false;

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

  // Issue #23: exec approvals live in SQLite on the pinned OpenClaw, and the
  // legacy exec-approvals.json must never be (re)created — its mere existence
  // hard-breaks the gateway. OpenClaw seeds its own approvals defaults, so the
  // only approvals work left here is renaming a stray legacy file away, and
  // that needs the era resolver's reapAllowed (the row AND a runtime known to
  // be on the SQLite era).
  let backend = { backend: "sqlite", signal: "unresolved", reapAllowed: false };
  if (typeof resolveExecApprovalsBackend === "function") {
    try {
      backend = await resolveExecApprovalsBackend();
    } catch (error) {
      logger.warn?.(
        `[alphaclaw] exec-approvals backend resolution failed (${error.message || error}) — not reaping this boot`,
      );
      backend = { backend: "sqlite", signal: "error", reapAllowed: false };
    }
  }
  // The backend decision was invisible during the #23 incident — log it.
  logger.log?.(
    `[alphaclaw] exec-approvals backend: ${backend.backend} (signal: ${backend.signal})`,
  );

  let reaped = { reaped: false };
  if (backend.reapAllowed === true) {
    reaped = reapStrayLegacyExecApprovals({
      fsModule,
      openclawDir,
      logger,
      nowFn,
      reapAllowed: true,
    });
    if (reaped.reaped) {
      // A real auto-fix: the file's presence fails the gateway closed on
      // sqlite-era openclaw. Per-file id: a re-created stray is a new event;
      // same-file boot loops dedupe within the outbox window.
      announce(
        `🩹 Renamed a stray legacy exec-approvals.json that would have blocked the gateway (kept as ${path.basename(reaped.strayPath || "")}).`,
        {
          eventType: "recovery",
          id: `exec-approvals-reaped-${path.basename(reaped.strayPath || "stray")}`,
        },
      );
    }
  }

  return {
    changed: openclawChanged,
    openclawChanged,
    approvalsBackend: backend.backend,
    approvalsBackendSignal: backend.signal,
    reaped: reaped.reaped === true,
  };
};

module.exports = {
  kManagedOpenclawExecDefaults,
  resolveExecApprovalsConfigPath,
  ensureManagedOpenclawExecDefaults,
  ensureManagedExecDefaults,
  reapStrayLegacyExecApprovals,
};
