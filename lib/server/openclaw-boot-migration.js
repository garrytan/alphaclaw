const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { kOpenclawBootMigrationTimeoutMs } = require("./constants");

// The pinned OpenClaw only changes when a new AlphaClaw is deployed. Upstream
// defers legacy repairs and database migrations to `openclaw doctor --fix`
// ("After replacing OpenClaw manually, run openclaw doctor --fix before
// starting it"), so the first boot of a new pin runs it once, before the
// gateway starts. The record names the version doctor last completed for:
//   <managedDir>/openclaw-boot-migration.json  { completedForVersion, at }
// A doctor that fails is reported and the gateway starts anyway: an invalid
// config then exits the gateway, and the watchdog's crash classifier and
// medic own that path (they never needed a held gateway to explain it).
const kBootMigrationFileName = "openclaw-boot-migration.json";

const readCompletedForVersion = ({ managedDir, fsModule = fs }) => {
  try {
    const record = JSON.parse(fsModule.readFileSync(path.join(managedDir, kBootMigrationFileName), "utf8"));
    return typeof record?.completedForVersion === "string" ? record.completedForVersion : null;
  } catch {
    return null;
  }
};

const writeCompletedForVersion = ({ managedDir, version, fsModule = fs, nowFn = Date.now }) =>
  writeFileAtomic(
    path.join(managedDir, kBootMigrationFileName),
    `${JSON.stringify({ completedForVersion: version, at: nowFn() }, null, 2)}\n`,
    { fsModule },
  );

const runBootMigration = async ({
  managedDir,
  openclawDir,
  installedVersion,
  runDoctorFix,
  operation = null,
  notify = null,
  timeoutMs = kOpenclawBootMigrationTimeoutMs,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  if (!installedVersion) return { status: "skipped", reason: "version_unknown" };
  if (!fsModule.existsSync(path.join(openclawDir, "openclaw.json"))) return { status: "skipped", reason: "no_config" };
  const completedForVersion = readCompletedForVersion({ managedDir, fsModule });
  if (completedForVersion === installedVersion) return { status: "ok", ran: false };
  logger.log?.(
    `[alphaclaw] OpenClaw ${completedForVersion ? `${completedForVersion} → ` : ""}${installedVersion}: running doctor --fix before the gateway starts`,
  );
  const result = await runDoctorFix({ timeoutMs, operation });
  if (result?.ok) {
    writeCompletedForVersion({ managedDir, version: installedVersion, fsModule, nowFn });
    logger.log?.(`[alphaclaw] doctor --fix completed for OpenClaw ${installedVersion}`);
    return { status: "ok", ran: true };
  }
  const reason = result?.timedOut ? "timed out" : result?.code || "failed";
  logger.warn?.(`[alphaclaw] doctor --fix for OpenClaw ${installedVersion} did not complete (${reason}); starting the gateway anyway`);
  try {
    await notify?.(
      `⚠️ OpenClaw ${installedVersion}: \`openclaw doctor --fix\` after the version change did not complete (${reason}). The gateway is starting anyway; if it fails, the watchdog repairs and reports it.`,
      { eventType: "health", id: `boot-migration-failed-${installedVersion}` },
    );
  } catch {}
  return { status: "failed", ran: true, reason };
};

module.exports = {
  kBootMigrationFileName,
  readCompletedForVersion,
  writeCompletedForVersion,
  runBootMigration,
};
