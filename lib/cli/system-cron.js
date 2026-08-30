const path = require("path");

// The ONE builder for /etc/cron.d/openclaw-hourly-sync. Three call sites
// write this file (onboarding install, every-boot reconcile in
// bin/alphaclaw.js, PUT /api/sync-cron) and they had drifted: only the
// onboarding writer carried ALPHACLAW_ROOT_DIR (issue #105), and the boot
// writer rewrote the file on every start — destroying the good copy. cron
// applies no environment beyond what the file declares, so without these
// lines the hourly job resolves a phantom ~/.alphaclaw install, and any
// `openclaw` child resolves ~/.openclaw — on >= 2026.9.1-beta.1 that CREATES
// a divergent second state database (issue #25).
//
// cron.d env assignments cannot quote or escape, and the command line passes
// through sh — so paths are validated against a strict allowlist and the
// builder REFUSES (returns null) rather than writing a file cron would
// misparse or execute wrong.
const kSafeCronPath = /^\/[A-Za-z0-9/_.-]+$/;

const kCronScheduleShape = /^(\S+\s+){4}\S+$/;

const buildSystemCronFile = ({ schedule, scriptPath, rootDir, openclawDir, logger = console }) => {
  const normalizedSchedule = String(schedule || "").trim();
  const paths = { scriptPath, rootDir, openclawDir };
  for (const [name, value] of Object.entries(paths)) {
    if (!kSafeCronPath.test(String(value || ""))) {
      logger.error?.(
        `[alphaclaw] REFUSING to write the system cron file: ${name} (${JSON.stringify(String(value || ""))}) contains characters cron.d cannot carry safely (allowed: absolute path of [A-Za-z0-9/_.-])`,
      );
      return null;
    }
  }
  if (!kCronScheduleShape.test(normalizedSchedule)) {
    logger.error?.(
      `[alphaclaw] REFUSING to write the system cron file: schedule ${JSON.stringify(normalizedSchedule)} is not a five-field cron expression`,
    );
    return null;
  }
  return [
    "SHELL=/bin/bash",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `ALPHACLAW_ROOT_DIR=${rootDir}`,
    `OPENCLAW_HOME=${rootDir}`,
    `OPENCLAW_STATE_DIR=${openclawDir}`,
    `OPENCLAW_CONFIG_PATH=${path.join(openclawDir, "openclaw.json")}`,
    `${normalizedSchedule} root bash "${scriptPath}" >> /var/log/openclaw-hourly-sync.log 2>&1`,
    // /etc/cron.d files without a trailing newline are ignored by cron.
    "",
  ].join("\n");
};

module.exports = { buildSystemCronFile, kSafeCronPath };
