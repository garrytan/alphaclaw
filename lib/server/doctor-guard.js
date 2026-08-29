// Restore guard around every `openclaw doctor --fix` invocation (issue #20
// bug 3): doctor can silently replace openclaw.json with a stale
// `openclaw.json.last-good` — in the incident, a 6-week-old file — dropping
// MCP servers, providers, and plugin flags while printing a success summary.
//
//   withDoctorRestoreGuard({ run })
//     │ inventory the live config (names/paths only — never values)
//     ▼
//   QUARANTINE openclaw.json.last-good → .last-good.quarantined-<opId>
//     │ (deterministic prevention: doctor cannot restore what isn't there;
//     │  rename happens under the config file lock)
//     ▼
//   run doctor (caller's spawn, output captured — never stdio:"ignore")
//     │
//     ▼
//   un-quarantine (doctor wrote a FRESH last-good? keep doctor's, drop the
//     │            stale original — the fresh one is post-migration)
//     ▼
//   TRIPWIRES (defense in depth for restore sources we don't know about):
//     output mentions a restore · tracked timestamps moved backward ·
//     MCP-server/provider inventory shrank · an env-ref value became a
//     literal secret
//     → on trip: put the pre-doctor config back (atomic, under the lock),
//       return { ok:false, code:"doctor_restored_stale_config", ... }
//
// A doctor that rolls the config back NEVER reports success through
// AlphaClaw. All guard outputs carry key paths and counts only — the config
// contains secrets and none of them may reach notifications or the ledger.
//
// Deliberately NOT a generic config-diff engine: fixed signals only (review
// decision — the quarantine kills the observed mechanism; the tripwires are
// tripwires, not a semantic differ).

const fs = require("fs");
const path = require("path");

const { withFileLockSync, writeFileAtomic } = require("./utils/safe-file");

const kQuarantinePattern = /^openclaw\.json\.last-good\.quarantined-.+$/;
const kEnvRefPattern = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const kRestoreOutputPattern = /auto-?restored|last-?known-?good|last-good/i;

const safeParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// Collect the dotted paths of string values that are `${ENV_REF}` templates.
// Depth-capped defensively; arrays skipped (env refs live in objects).
const collectEnvRefPaths = (node, prefix = "", depth = 0, out = []) => {
  if (depth > 8 || !node || typeof node !== "object" || Array.isArray(node)) {
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      if (kEnvRefPattern.test(value)) out.push(keyPath);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      collectEnvRefPaths(value, keyPath, depth + 1, out);
    }
  }
  return out;
};

const takeInventory = (config) => {
  if (!config || typeof config !== "object") return null;
  return {
    mcpServers: Object.keys(config?.mcp?.servers || {}),
    providers: Object.keys(config?.models?.providers || {}),
    lastTouchedAt: config?.meta?.lastTouchedAt ?? null,
    wizardLastRunAt: config?.wizard?.lastRunAt ?? null,
    envRefPaths: collectEnvRefPaths(config),
  };
};

const valueAtPath = (config, keyPath) => {
  let node = config;
  for (const segment of String(keyPath).split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = node[segment];
  }
  return node;
};

const parseTimestamp = (value) => {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
};

const createDoctorGuard = ({
  fsModule = fs,
  openclawDir,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  const log = (message) => {
    try {
      logger.log?.(`[doctor-guard] ${message}`);
    } catch {}
  };
  const configPath = path.join(openclawDir, "openclaw.json");
  const lastGoodPath = path.join(openclawDir, "openclaw.json.last-good");

  const quarantinePathFor = (operationId) =>
    path.join(
      openclawDir,
      `openclaw.json.last-good.quarantined-${
        String(operationId || "")
          .replace(/[^0-9A-Za-z-]/g, "")
          .slice(0, 16) || String(nowFn())
      }`,
    );

  // Boot orphan recovery (crash-safe quarantine): a crash mid-doctor strands
  // the rename; put the file back so openclaw's own machinery keeps working.
  // Idempotent, mirrors channel-sync's recoverStagedMigrations.
  const recoverQuarantinedLastGood = () => {
    let entries = [];
    try {
      entries = fsModule.readdirSync(openclawDir);
    } catch {
      return { recovered: 0 };
    }
    let recovered = 0;
    for (const name of entries) {
      if (!kQuarantinePattern.test(name)) continue;
      const stranded = path.join(openclawDir, name);
      try {
        if (!fsModule.existsSync(lastGoodPath)) {
          fsModule.renameSync(stranded, lastGoodPath);
          log(`recovered stranded quarantine ${name} → openclaw.json.last-good`);
        } else {
          // A fresh last-good exists — the stale quarantined original must
          // not linger as a restore candidate.
          fsModule.unlinkSync(stranded);
          log(`dropped stranded quarantine ${name} (fresh last-good present)`);
        }
        recovered += 1;
      } catch (error) {
        log(`quarantine recovery failed for ${name}: ${error.message}`);
      }
    }
    return { recovered };
  };

  // Wraps one doctor --fix invocation. `run` is the caller's spawn (must
  // capture output; returns { ok, tail?, ... }). Returns the run result
  // augmented with guard evidence, or the restore-detected failure.
  const withDoctorRestoreGuard = async ({ operationId = null, run }) => {
    let preRaw = null;
    try {
      preRaw = fsModule.readFileSync(configPath, "utf8");
    } catch {}
    const preConfig = preRaw != null ? safeParse(preRaw) : null;
    const preInventory = takeInventory(preConfig);

    // Quarantine under the config lock so we never race a concurrent config
    // writer mid-rename.
    const quarantined = { path: null };
    try {
      withFileLockSync(configPath, () => {
        if (fsModule.existsSync(lastGoodPath)) {
          const target = quarantinePathFor(operationId);
          fsModule.renameSync(lastGoodPath, target);
          quarantined.path = target;
        }
      });
    } catch (error) {
      log(`quarantine skipped (${error.message}) — tripwires still armed`);
    }

    let result;
    try {
      result = await run();
    } finally {
      // Un-quarantine: doctor may have written a FRESH last-good from the
      // migrated config — that one is strictly newer, keep it and drop the
      // stale original. Otherwise the original goes back (least surprise —
      // openclaw owns its last-good lifecycle).
      if (quarantined.path) {
        try {
          if (fsModule.existsSync(lastGoodPath)) {
            fsModule.unlinkSync(quarantined.path);
            log("doctor wrote a fresh last-good; dropped the quarantined original");
          } else {
            fsModule.renameSync(quarantined.path, lastGoodPath);
          }
        } catch (error) {
          log(`un-quarantine failed: ${error.message} (boot recovery will finish it)`);
        }
      }
    }

    // Tripwires run even when doctor claims success — the incident's doctor
    // exited 0 after replacing the config.
    let postRaw = null;
    try {
      postRaw = fsModule.readFileSync(configPath, "utf8");
    } catch {}
    const postConfig = postRaw != null ? safeParse(postRaw) : null;
    const postInventory = takeInventory(postConfig);
    const signals = [];
    const droppedKeyPaths = [];

    const outputText = String(result?.tail ?? result?.output ?? "");
    if (kRestoreOutputPattern.test(outputText) && /restor/i.test(outputText)) {
      signals.push("output_mentions_restore");
    }
    if (preInventory && postInventory) {
      for (const field of ["lastTouchedAt", "wizardLastRunAt"]) {
        const before = parseTimestamp(preInventory[field]);
        const after = parseTimestamp(postInventory[field]);
        if (before != null && after != null && after < before) {
          signals.push(`${field}_moved_backward`);
        }
      }
      for (const [field, label] of [
        ["mcpServers", "mcp.servers"],
        ["providers", "models.providers"],
      ]) {
        const missing = preInventory[field].filter(
          (name) => !postInventory[field].includes(name),
        );
        if (missing.length) {
          signals.push(`${field}_shrank`);
          droppedKeyPaths.push(...missing.map((name) => `${label}.${name}`));
        }
      }
      // An env-ref (`${KEY}`) that became a literal string means a stale
      // config resurrected a plaintext secret — the incident's worst drop.
      for (const keyPath of preInventory.envRefPaths) {
        const after = valueAtPath(postConfig, keyPath);
        if (
          typeof after === "string" &&
          after.length > 0 &&
          !kEnvRefPattern.test(after)
        ) {
          signals.push("env_ref_became_literal");
          droppedKeyPaths.push(keyPath);
        }
      }
    }

    if (!signals.length) {
      return { ...result, guard: { quarantined: Boolean(quarantined.path) } };
    }

    // Restore detected: put the pre-doctor config back, atomically, under
    // the lock. Never report success.
    let reverted = false;
    if (preRaw != null) {
      try {
        withFileLockSync(configPath, () => {
          writeFileAtomic(configPath, preRaw, { fsModule });
        });
        reverted = true;
      } catch (error) {
        log(`revert failed: ${error.message}`);
      }
    }
    log(
      `restore detected (${signals.join(", ")}); ${reverted ? "reverted to the pre-doctor config" : "REVERT FAILED"}; dropped: ${droppedKeyPaths.length} key path(s)`,
    );
    return {
      ok: false,
      code: "doctor_restored_stale_config",
      signals,
      droppedKeyPaths,
      reverted,
      guard: { quarantined: Boolean(quarantined.path) },
    };
  };

  return { withDoctorRestoreGuard, recoverQuarantinedLastGood };
};

// Single source for the operator-facing "stale restore blocked" copy — the
// watchdog-repair path (lib/server.js) and the boot reconciler both fire it,
// and the two texts must not drift (key-path COUNTS only, never values).
const buildDoctorRestoreBlockedNotification = (
  droppedKeyPathCount,
  { held = false } = {},
) =>
  `⚠️ OpenClaw's doctor tried to replace your settings with a stale backup (${droppedKeyPathCount} setting path(s) would have been lost). AlphaClaw blocked it — your settings are unchanged.${held ? " The gateway is held; see the Upgrade page." : ""}`;

module.exports = { createDoctorGuard, buildDoctorRestoreBlockedNotification };
