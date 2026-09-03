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

// Schedule validation is fail-closed and per-field. The old shape
// /^(\S+\s+){4}\S+$/ used \s for the separators, which matches LF/CR/TAB —
// so a "schedule" containing newlines passed as a five-field expression and
// injected arbitrary env/command lines into this root-owned file (e.g.
// "PATH=/tmp/evil\n*\n*\n*\n*" overrode the safe PATH above). Now: exactly
// five fields separated by SPACES only, each limited to numeric cron syntax
// [0-9*,/-]. Aliases (@hourly, MON) are deliberately rejected — AlphaClaw
// only ever writes numeric schedules, and the tighter grammar cannot carry
// '=', '#', tabs, or control characters. Shared by all three call sites
// (builder, PUT /api/sync-cron, boot reconcile) so they can never drift.
const kCronFieldShape = /^[0-9*,/-]+$/;
// Semantic bounds per field (Vixie cron): a charset-legal but cron-INVALID
// value ("99 * * * *", "*/0") makes Debian cron reject the ENTIRE file at
// load — silently killing the root sync job while the API reports it
// installed. So every field must parse as real cron syntax within range.
const kCronFieldBounds = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 are both Sunday)
];
const isSafeCronField = (field, { min, max }) => {
  if (!field || field.length > 16 || !kCronFieldShape.test(field)) return false;
  return field.split(",").every((item) => {
    const [base, step, ...stepRest] = item.split("/");
    if (stepRest.length > 0) return false;
    if (step !== undefined && !(/^[0-9]{1,2}$/.test(step) && Number(step) >= 1)) return false;
    if (base === "*") return true;
    const [lo, hi, ...rangeRest] = base.split("-");
    if (rangeRest.length > 0) return false;
    if (!/^[0-9]{1,2}$/.test(lo)) return false;
    const loNum = Number(lo);
    if (loNum < min || loNum > max) return false;
    // Vixie steps require a range or *: "5/2" is not valid cron.
    if (hi === undefined) return step === undefined;
    if (!/^[0-9]{1,2}$/.test(hi)) return false;
    const hiNum = Number(hi);
    return hiNum >= loNum && hiNum <= max;
  });
};
const isSafeCronSchedule = (value) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length > 64) return false;
  const fields = trimmed.split(" ").filter(Boolean);
  return (
    fields.length === 5 &&
    fields.every((field, index) => isSafeCronField(field, kCronFieldBounds[index]))
  );
};

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
  if (!isSafeCronSchedule(normalizedSchedule)) {
    logger.error?.(
      `[alphaclaw] REFUSING to write the system cron file: schedule ${JSON.stringify(normalizedSchedule)} is not a space-separated five-field numeric cron expression`,
    );
    return null;
  }
  // Canonicalize: validation reasons about split fields, so emit exactly
  // those fields — never the raw input's spacing.
  const canonicalSchedule = normalizedSchedule.split(" ").filter(Boolean).join(" ");
  return [
    "SHELL=/bin/bash",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `ALPHACLAW_ROOT_DIR=${rootDir}`,
    `OPENCLAW_HOME=${rootDir}`,
    `OPENCLAW_STATE_DIR=${openclawDir}`,
    `OPENCLAW_CONFIG_PATH=${path.join(openclawDir, "openclaw.json")}`,
    `${canonicalSchedule} root bash "${scriptPath}" >> /var/log/openclaw-hourly-sync.log 2>&1`,
    // /etc/cron.d files without a trailing newline are ignored by cron.
    "",
  ].join("\n");
};

module.exports = { buildSystemCronFile, isSafeCronSchedule, kSafeCronPath };
