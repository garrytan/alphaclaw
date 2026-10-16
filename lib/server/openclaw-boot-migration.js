const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { collectSecretValues } = require("./utils/redact");
const { summarizeDoctorResult } = require("./doctor-outcome");
const { kOpenclawBootMigrationTimeoutMs } = require("./constants");

// The pinned OpenClaw only changes when a new AlphaClaw is deployed. Upstream
// defers legacy repairs and database migrations to `openclaw doctor --fix`
// ("After replacing OpenClaw manually, run openclaw doctor --fix before
// starting it"), so the first boot of a new pin runs it once, before the
// gateway starts. A doctor that fails is reported and the gateway starts
// anyway: an invalid config then exits the gateway, and the watchdog's crash
// classifier and medic own that path.
//
//   <managedDir>/openclaw-boot-migration.json
//   {
//     completedForVersion, at,   // the pin a Doctor last completed for
//     lastOutcome: { status, class, reason, detail, captureState,
//       captureCause, openclawVersion, source, durationMs, at },
//                                // the newest Doctor run of any caller
//     failed: { key, detail, reason, attempts, at }
//                                // a deterministic boot/retry failure, remembered
//     lastSuccess: { durationMs, openclawVersion, source, at }
//                                // the newest Doctor that completed (the
//                                // Retry upgrade confirm's downtime estimate)
//     snapshotless: { openclawVersion, captureCause, source, at }
//                                // the newest successful Doctor ran without
//                                // a pre-repair capture; a later success
//                                // that kept one clears it
//   }
//
// The upgrade for the installed pin is unfinished exactly while
// completedForVersion differs from it: a repair or medic Doctor that fails
// after the pin completed rewrites lastOutcome but never reopens the upgrade.
// Single writer: every Doctor runs under the gateway lifecycle lock in this
// process (the bin-phase channel retirement runs before the server loads).
//
// Failure memory exists so a Doctor OpenClaw will refuse again on the same
// state does not hold every boot for minutes. It cannot freeze: the key is
// what decides the outcome (both versions, the config bytes the Doctor reads,
// the directory layout and ancestor modes the atomic writes and the capture
// check judge); any change retries, and an unchanged key still retries once
// every 24 h. Transient failures (timeout, cancel, ENOSPC, a busy state) are
// never remembered. A Doctor that later completes for the pin — boot, watchdog
// repair or medic — clears it through recordDoctorCompletedForPin.
const kBootMigrationFileName = "openclaw-boot-migration.json";
const kRememberedFailureRetryMs = 24 * 60 * 60 * 1000;
// AlphaClaw v0.9.88–v0.9.97 pinned OpenClaw 2026.9.5, the bridge release
// OpenClaw names for most pre-window state.
const kDefaultBridgeVersion = "2026.9.5";

const readMigrationRecord = ({ managedDir, fsModule = fs }) => {
  try {
    const record = JSON.parse(fsModule.readFileSync(path.join(managedDir, kBootMigrationFileName), "utf8"));
    return record && typeof record === "object" && !Array.isArray(record) ? record : {};
  } catch {
    return {};
  }
};

const readCompletedForVersion = ({ managedDir, fsModule = fs }) => {
  const record = readMigrationRecord({ managedDir, fsModule });
  return typeof record.completedForVersion === "string" ? record.completedForVersion : null;
};

const updateMigrationRecord = ({ managedDir, fsModule = fs, mutate }) => {
  const record = readMigrationRecord({ managedDir, fsModule });
  mutate(record);
  writeFileAtomic(path.join(managedDir, kBootMigrationFileName), `${JSON.stringify(record, null, 2)}\n`, { fsModule });
  return record;
};

const recordDoctorCompletedForPin = ({ managedDir, version, fsModule = fs, nowFn = Date.now }) =>
  updateMigrationRecord({
    managedDir,
    fsModule,
    mutate: (record) => {
      record.completedForVersion = version;
      record.at = nowFn();
      delete record.failed;
    },
  });

const recordDoctorOutcome = ({ managedDir, outcome, fsModule = fs }) =>
  updateMigrationRecord({
    managedDir,
    fsModule,
    mutate: (record) => {
      record.lastOutcome = outcome;
      if (outcome?.status !== "ok") return;
      record.lastSuccess = {
        durationMs: outcome.durationMs ?? null,
        openclawVersion: outcome.openclawVersion || null,
        source: outcome.source || null,
        at: outcome.at || null,
      };
      if (outcome.captureState === "unavailable") {
        record.snapshotless = {
          openclawVersion: outcome.openclawVersion || null,
          captureCause: outcome.captureCause || null,
          source: outcome.source || null,
          at: outcome.at || null,
        };
      } else if (outcome.captureState === "available") {
        delete record.snapshotless;
      }
    },
  });

// The config bytes change on every boot without changing what Doctor
// decides: OpenClaw stamps meta (lastTouchedAt/Version) whenever it writes,
// and its wizard provenance (wizard.lastRun*), and autotune re-derives
// agents.defaults.maxConcurrent. The key hashes the
// parsed config with those removed and keys sorted; a config AlphaClaw cannot
// parse (JSON5, includes) falls back to its raw bytes.
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const hashDoctorRelevantConfig = (filePath, fsModule) => {
  let bytes;
  try {
    bytes = fsModule.readFileSync(filePath);
  } catch {
    return null;
  }
  let text = bytes;
  try {
    const config = JSON.parse(bytes.toString("utf8"));
    if (config && typeof config === "object" && !Array.isArray(config)) {
      delete config.meta;
      if (config.wizard && typeof config.wizard === "object") {
        for (const key of Object.keys(config.wizard)) if (key.startsWith("lastRun")) delete config.wizard[key];
        if (!Object.keys(config.wizard).length) delete config.wizard;
      }
      if (config.agents?.defaults && typeof config.agents.defaults === "object") {
        delete config.agents.defaults.maxConcurrent;
        if (!Object.keys(config.agents.defaults).length) delete config.agents.defaults;
        if (!Object.keys(config.agents).length) delete config.agents;
      }
    }
    text = canonicalJson(config);
  } catch {}
  return crypto.createHash("sha256").update(text).digest("hex");
};

const describeLayout = ({ openclawDir, fsModule }) => {
  let symlinked = false;
  let configDir = openclawDir;
  try {
    symlinked = fsModule.lstatSync(openclawDir).isSymbolicLink();
    configDir = fsModule.realpathSync(openclawDir);
  } catch {}
  const ancestors = [];
  for (let dir = configDir; ; dir = path.dirname(dir)) {
    try {
      const stat = fsModule.statSync(dir);
      ancestors.push(`${dir}:${stat.uid}:${stat.gid}:${(stat.mode & 0o7777).toString(8)}`);
    } catch {
      ancestors.push(`${dir}:?`);
    }
    if (path.dirname(dir) === dir) break;
  }
  return { symlinked, configDir, ancestors };
};

const buildFailureKey = ({ openclawDir, installedVersion, alphaclawVersion, fsModule }) => ({
  openclawVersion: installedVersion,
  alphaclawVersion: alphaclawVersion || null,
  configSha: hashDoctorRelevantConfig(path.join(openclawDir, "openclaw.json"), fsModule),
  layout: describeLayout({ openclawDir, fsModule }),
});

const sameKey = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const rememberDoctorFailure = ({ managedDir, key, summary, fsModule = fs, nowFn = Date.now }) =>
  updateMigrationRecord({
    managedDir,
    fsModule,
    mutate: (next) => {
      const attempts = next.failed && sameKey(next.failed.key, key) ? Number(next.failed.attempts || 0) + 1 : 1;
      next.failed = { key, reason: summary.reason, detail: summary.detail, attempts, at: nowFn() };
    },
  });

const buildFailureMessage = ({ installedVersion, summary }) => {
  const quotedDetail = summary.detail ? ` OpenClaw said: "${summary.detail}"` : "";
  if (summary.reason === "upgrade_window_refused") {
    const bridgeVersion = summary.bridgeVersion || kDefaultBridgeVersion;
    return (
      `⚠️ OpenClaw ${installedVersion}: \`openclaw doctor --fix\` refused to migrate state that predates OpenClaw's July 2026 upgrade support window. ` +
      `Leave the current state directory untouched. If you have a backup taken before this upgrade, restore it into a separate directory, run \`openclaw doctor --fix\` with OpenClaw ${bridgeVersion} there, and once it completes stop AlphaClaw, swap the migrated copy in for the state directory and start it again; anything written after that backup is lost. ` +
      `Without such a backup OpenClaw cannot migrate this state automatically (manual recovery: https://docs.openclaw.ai/install/updating#upgrading-very-old-versions). The gateway is starting anyway, but no repair on OpenClaw ${installedVersion} can migrate it.${quotedDetail}`
    );
  }
  return (
    `⚠️ OpenClaw ${installedVersion}: \`openclaw doctor --fix\` after the version change did not complete (${summary.reason}). ` +
    `The gateway is starting anyway; if it fails, the watchdog repairs and reports it.${quotedDetail}`
  );
};

const runBootMigration = async ({
  managedDir,
  openclawDir,
  installedVersion,
  alphaclawVersion = null,
  runDoctorFix,
  operation = null,
  notify = null,
  // Boot timeline hooks (boot-progress/): called only when Doctor actually
  // starts, and on every chunk of its output (proof of life, never content).
  onDoctorStart = null,
  onActivity = null,
  timeoutMs = kOpenclawBootMigrationTimeoutMs,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  if (!installedVersion) return { status: "skipped", reason: "version_unknown" };
  if (!fsModule.existsSync(path.join(openclawDir, "openclaw.json"))) return { status: "skipped", reason: "no_config" };
  const record = readMigrationRecord({ managedDir, fsModule });
  const completedForVersion = typeof record.completedForVersion === "string" ? record.completedForVersion : null;
  if (completedForVersion === installedVersion) return { status: "ok", ran: false };
  const key = buildFailureKey({ openclawDir, installedVersion, alphaclawVersion, fsModule });
  const remembered = record.failed;
  if (remembered && sameKey(remembered.key, key) && nowFn() - Number(remembered.at || 0) < kRememberedFailureRetryMs) {
    logger.warn?.(
      `[alphaclaw] doctor --fix for OpenClaw ${installedVersion} failed on this exact state before (${remembered.reason}); not rerunning it this boot — it retries when the config, layout or a version changes, or after 24h`,
    );
    return { status: "skipped", reason: "remembered_failure", class: "deterministic", detail: remembered.detail || null, ran: false };
  }
  logger.log?.(
    `[alphaclaw] OpenClaw ${completedForVersion ? `${completedForVersion} → ` : ""}${installedVersion}: running doctor --fix before the gateway starts`,
  );
  try {
    onDoctorStart?.({ fromVersion: completedForVersion, toVersion: installedVersion });
  } catch {}
  const result = await runDoctorFix({ timeoutMs, operation, source: "boot", ...(onActivity ? { onActivity } : {}) });
  const summary = summarizeDoctorResult(result, { secrets: collectSecretValues({ env: process.env }) });
  const captureUnavailable = summary.captureState === "unavailable" ? { cause: summary.captureCause } : null;
  if (summary.status === "ok") {
    recordDoctorCompletedForPin({ managedDir, version: installedVersion, fsModule, nowFn });
    logger.log?.(`[alphaclaw] doctor --fix completed for OpenClaw ${installedVersion}`);
    if (captureUnavailable) {
      try {
        await notify?.(
          `OpenClaw's data upgrade to ${installedVersion} finished, but without a safety snapshot. OpenClaw said: ${captureUnavailable.cause || "no reason given"}. ` +
            "Nothing is broken. To let future upgrades take one, see “Symlinked state directory” in docs/upgrade-troubleshooting.md (usually `chmod +t` on the directory named).",
          {
            eventType: "health",
            id: `boot-migration-no-snapshot-${installedVersion}-${crypto.createHash("sha256").update(String(captureUnavailable.cause)).digest("hex").slice(0, 12)}`,
          },
        );
      } catch {}
    }
    return { status: "ok", ran: true, reason: null, class: null, detail: null, captureUnavailable };
  }
  logger.warn?.(
    `[alphaclaw] doctor --fix for OpenClaw ${installedVersion} did not complete (${summary.reason}); starting the gateway anyway`,
  );
  if (summary.class === "deterministic") {
    try {
      rememberDoctorFailure({ managedDir, key, summary, fsModule, nowFn });
    } catch (error) {
      logger.warn?.(`[alphaclaw] could not remember the doctor --fix failure: ${error.message}`);
    }
  }
  try {
    await notify?.(buildFailureMessage({ installedVersion, summary }), {
      eventType: "health",
      id: `boot-migration-failed-${installedVersion}`,
    });
  } catch {}
  return {
    status: "failed",
    ran: true,
    reason: summary.reason,
    class: summary.class,
    detail: summary.detail,
    captureUnavailable,
  };
};

module.exports = {
  kBootMigrationFileName,
  kDefaultBridgeVersion,
  kRememberedFailureRetryMs,
  buildFailureKey,
  sameKey,
  rememberDoctorFailure,
  readCompletedForVersion,
  readMigrationRecord,
  recordDoctorCompletedForPin,
  recordDoctorOutcome,
  runBootMigration,
};
