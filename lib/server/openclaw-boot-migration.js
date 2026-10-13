const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { redactLine, collectSecretValues, stripAnsi } = require("./utils/redact");
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
// OpenClaw 2026.10.2 no longer migrates state that predates its July 2026
// upgrade support window: doctor --fix refuses (exit 1, "Doctor stopped
// because a state migration refused to continue") and names the bridge
// release that still can — "Plugin install index <path> predates the July
// 2026 upgrade support window and was left unchanged. Run openclaw doctor
// --fix on 2026.9.5 with a pre-update backup before upgrading again",
// "Session field \"room\" predates July 2026 and is no longer supported.
// Preserve the original state, install OpenClaw 2026.9.5 and run …",
// "Config contains retired pre-July-2026 settings … Install OpenClaw 2026.9.7
// …"; every variant links #upgrading-very-old-versions. Doctor prints the
// refusal word-wrapped inside a box, so matching runs on the de-boxed tail.
const kUpgradeSupportWindowPattern = /predates (?:the )?July 2026|pre-July-2026|upgrading-very-old-versions/i;
const kBridgeVersionPattern = /(?:install OpenClaw|doctor --fix on) (\d{4}\.\d+\.\d+)/i;
// AlphaClaw v0.9.88–v0.9.97 pinned OpenClaw 2026.9.5, the bridge release
// OpenClaw names for most pre-window state.
const kDefaultBridgeVersion = "2026.9.5";
const kNoticeDetailMaxChars = 300;

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
  const output = stripAnsi(String(result?.stdout || ""));
  const flatOutput = output.replace(/[│\s]+/g, " ");
  const failingCheckLine = output.split("\n").find((line) => line.startsWith("Failing check "));
  const detail = failingCheckLine
    ? redactLine(failingCheckLine, { secrets: collectSecretValues({ env: process.env }), maxLength: kNoticeDetailMaxChars })
    : String(result?.lastOutputLine || "").slice(0, kNoticeDetailMaxChars);
  const quotedDetail = detail ? ` OpenClaw said: "${detail}"` : "";
  let message;
  if (kUpgradeSupportWindowPattern.test(flatOutput) || kUpgradeSupportWindowPattern.test(detail)) {
    const bridgeVersion = flatOutput.match(kBridgeVersionPattern)?.[1] || kDefaultBridgeVersion;
    const bridgeStep = bridgeVersion === kDefaultBridgeVersion
      ? `deploy an AlphaClaw release pinned to OpenClaw ${kDefaultBridgeVersion} (v0.9.88–v0.9.97) and let its boot \`openclaw doctor --fix\` complete`
      : `run \`openclaw doctor --fix\` with OpenClaw ${bridgeVersion} against this state directory`;
    message =
      `⚠️ OpenClaw ${installedVersion}: \`openclaw doctor --fix\` refused to migrate state that predates OpenClaw's July 2026 upgrade support window (${reason}). ` +
      `Back up the state directory, ${bridgeStep}, then redeploy this release. ` +
      `The gateway is starting anyway, but no repair on OpenClaw ${installedVersion} can migrate that state.${quotedDetail}`;
  } else {
    message =
      `⚠️ OpenClaw ${installedVersion}: \`openclaw doctor --fix\` after the version change did not complete (${reason}). ` +
      `The gateway is starting anyway; if it fails, the watchdog repairs and reports it.${quotedDetail}`;
  }
  try {
    await notify?.(message, { eventType: "health", id: `boot-migration-failed-${installedVersion}` });
  } catch {}
  return { status: "failed", ran: true, reason };
};

module.exports = {
  kBootMigrationFileName,
  readCompletedForVersion,
  writeCompletedForVersion,
  runBootMigration,
};
