const fs = require("fs");
const path = require("path");
const {
  readOpenclawConfig,
  resolveOpenclawConfigPath,
  writeOpenclawConfig,
} = require("./openclaw-config");
const { hasExecApprovalsRow } = require("./openclaw-state-era");

const kManagedExecApprovalsDefaults = Object.freeze({
  security: "full",
  ask: "off",
  askFallback: "full",
});

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

// Issue #23 era detection, corrected (the v0.9.43 regression): 2026.7.1-2
// eagerly creates the exec_approvals_config TABLE (empty) in every state db,
// so table existence misclassified every pinned box as sqlite-era — skipping
// the managed seeding there and, worse, letting the boot reaper rename away
// the LIVE approvals file. Only a ROW proves the sqlite era ever recorded
// approvals. Row presence is still historical state (it survives backup
// restores and downgrades), so destructive actions additionally require the
// version-derived era hint — see resolveBackend below.
const detectSqliteExecApprovals = ({ fsModule = fs, openclawDir, logger = console } = {}) =>
  hasExecApprovalsRow({ fsModule, openclawDir, logger });

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
      mode: kManagedOpenclawExecDefaults.mode,
      strictInlineEval: kManagedOpenclawExecDefaults.strictInlineEval,
    };
  }
  return {
    config,
    changed: JSON.stringify(config) !== before,
  };
};

const kStrayPattern = /^exec-approvals\.json\.stray-(\d+)$/;

// Remediation for boxes damaged by the v0.9.43 reaper (which renamed the LIVE
// approvals file on file-era boxes every boot): recover operator state from
// the `.stray-<ts>` files it left behind. Repeated bad boots stack strays
// where the ORIGINAL allowlist lives in the OLDEST one and the newest is just
// a re-seeded default, so this merges across ALL of them — allowlists are
// unioned per agent (deduped by pattern), the socket comes from the oldest
// stray that has a token. Merge only, never overwrite; processed strays are
// renamed to `.merged` so the recovery is idempotent and nothing is deleted.
const mergeStrayLegacyExecApprovals = ({
  fsModule = fs,
  openclawDir,
  logger = console,
} = {}) => {
  let strays = [];
  try {
    strays = fsModule
      .readdirSync(openclawDir)
      .map((name) => {
        const match = kStrayPattern.exec(name);
        return match ? { name, ts: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return { merged: false, strays: 0 };
  }
  if (strays.length === 0) return { merged: false, strays: 0 };

  const approvalsPath = resolveExecApprovalsConfigPath({ openclawDir });
  const live = readExecApprovalsConfig({ fsModule, openclawDir, fallback: { version: 1 } });
  if (!live.agents || typeof live.agents !== "object" || Array.isArray(live.agents)) {
    live.agents = {};
  }
  const before = JSON.stringify(live);

  let recoveredEntries = 0;
  for (const stray of strays) {
    let doc = null;
    try {
      doc = JSON.parse(fsModule.readFileSync(path.join(openclawDir, stray.name), "utf8"));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
    // Oldest stray with a socket token wins when the live file has none.
    if (
      !live.socket &&
      doc.socket &&
      typeof doc.socket === "object" &&
      String(doc.socket.token || "").length > 0
    ) {
      live.socket = doc.socket;
    }
    const agents = doc.agents && typeof doc.agents === "object" && !Array.isArray(doc.agents)
      ? doc.agents
      : {};
    for (const [agentId, agent] of Object.entries(agents)) {
      const allowlist = Array.isArray(agent?.allowlist) ? agent.allowlist : [];
      if (allowlist.length === 0) continue;
      const target =
        live.agents[agentId] && typeof live.agents[agentId] === "object"
          ? live.agents[agentId]
          : (live.agents[agentId] = {});
      const targetList = Array.isArray(target.allowlist) ? target.allowlist : (target.allowlist = []);
      const known = new Set(
        targetList.map((entry) => String(entry?.pattern ?? entry ?? "").trim()),
      );
      for (const entry of allowlist) {
        const pattern = String(entry?.pattern ?? entry ?? "").trim();
        if (!pattern || known.has(pattern)) continue;
        known.add(pattern);
        targetList.push(entry);
        recoveredEntries += 1;
      }
    }
  }

  const changed = JSON.stringify(live) !== before;
  if (changed) {
    writeExecApprovalsConfig({ fsModule, openclawDir, file: live });
    logger.warn?.(
      `[alphaclaw] Recovered ${recoveredEntries} exec-approvals allowlist entr${recoveredEntries === 1 ? "y" : "ies"} from ${strays.length} stray file(s) left by an earlier alphaclaw (issue #23 reaper regression) into ${approvalsPath}`,
    );
  }
  // Mark every stray processed (even no-op ones) so boots stay idempotent —
  // rename, never delete.
  for (const stray of strays) {
    try {
      fsModule.renameSync(
        path.join(openclawDir, stray.name),
        path.join(openclawDir, `${stray.name}.merged`),
      );
    } catch {}
  }
  return { merged: changed, strays: strays.length, recoveredEntries };
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

// Fallback backend resolution for callers that cannot supply the era
// resolver (unit-test harnesses). Row-presence only — no version hint means
// no reaping and no determinate file-era guarantee; every PRODUCTION caller
// injects resolveExecApprovalsBackend from openclaw-state-era instead.
const resolveBackendFallback = ({ fsModule, openclawDir, logger }) => {
  const rowPresent = hasExecApprovalsRow({ fsModule, openclawDir, logger });
  return rowPresent
    ? { backend: "sqlite", signal: "row", rowPresent, reapAllowed: false }
    : { backend: "file", signal: "row-absent-fallback", rowPresent, reapAllowed: false };
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
  const announce = (message, opts) => {
    try {
      const completion = notify?.(message, opts);
      if (completion && typeof completion.catch === "function") {
        completion.catch(() => {});
      }
    } catch {}
  };
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
  // managed defaults below match what openclaw's own ensureExecApprovals()
  // seeds except askFallback ("full" here vs openclaw's "deny" — inert while
  // ask stays "off"), so skipping the file half on that era loses nothing.
  // Writers fail CLOSED on file creation: only a determinate file-era answer
  // may touch the file (an indeterminate probe on a beta box must not brick
  // it; a skipped seeding on a file-era box is harmless — openclaw self-seeds).
  let backend;
  try {
    backend =
      typeof resolveExecApprovalsBackend === "function"
        ? await resolveExecApprovalsBackend()
        : resolveBackendFallback({ fsModule, openclawDir, logger });
  } catch (error) {
    logger.warn?.(
      `[alphaclaw] exec-approvals backend resolution failed (${error.message || error}) — skipping legacy writes this boot`,
    );
    backend = { backend: "indeterminate", signal: "error", reapAllowed: false };
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

  // Recover state a buggy earlier reaper renamed away, on ANY determinate
  // file era — including row-present boxes (a restored backup or forced
  // downgrade leaves a stale row next to the live file the old runtime
  // reads); the version gate saying "file era" is what proves the file is
  // live. Runs before seeding so the seed never shadows recovered entries.
  if (backend.backend === "file" || backend.hint === "file-era") {
    const mergeResult = mergeStrayLegacyExecApprovals({
      fsModule,
      openclawDir,
      logger,
    });
    if (mergeResult?.merged) {
      announce(
        `🩹 Merged ${mergeResult.recoveredEntries ?? 0} approval entrie(s) recovered from ${mergeResult.strays} stray legacy exec-approvals file(s).`,
        {
          eventType: "recovery",
          id: `exec-approvals-merged-${mergeResult.strays}-${mergeResult.recoveredEntries ?? 0}`,
        },
      );
    }
  }

  if (backend.backend === "file") {
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
    approvalsBackend: backend.backend,
    approvalsBackendSignal: backend.signal,
    reaped: reaped.reaped === true,
  };
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
  mergeStrayLegacyExecApprovals,
  reapStrayLegacyExecApprovals,
};
