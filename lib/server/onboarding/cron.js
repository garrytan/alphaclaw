const path = require("path");
const { writeFileAtomic } = require("../utils/safe-file");
const { kSetupDir, kRootDir } = require("../constants");
const { buildManagedPaths } = require("../internal-files-migration");
const { shouldSkipSystemCronInstall } = require("../../cli/git-runtime");
const { buildSystemCronFile } = require("../../cli/system-cron");

const kHourlyGitSyncTemplatePath = path.join(kSetupDir, "hourly-git-sync.sh");
const kSystemCronPath = "/etc/cron.d/openclaw-hourly-sync";
const kSystemCronConfigDir = "cron";
const kSystemCronConfigFile = "system-sync.json";
const kDefaultSystemCronSchedule = "0 * * * *";

const installHourlyGitSyncScript = ({ fs, openclawDir }) => {
  try {
    const { internalDir, hourlyGitSyncPath } = buildManagedPaths({ openclawDir });
    const hourlyGitSyncScript = fs.readFileSync(kHourlyGitSyncTemplatePath, "utf8");
    fs.mkdirSync(internalDir, { recursive: true });
    fs.writeFileSync(hourlyGitSyncPath, hourlyGitSyncScript, { mode: 0o755 });
    console.log("[onboard] Installed deterministic hourly git sync script");
  } catch (e) {
    console.error("[onboard] Hourly git sync script install error:", e.message);
  }
};

const installHourlyGitSyncCron = async ({ fs, openclawDir }) => {
  try {
    const { hourlyGitSyncPath } = buildManagedPaths({ openclawDir });
    const configDir = `${openclawDir}/${kSystemCronConfigDir}`;
    const configPath = `${configDir}/${kSystemCronConfigFile}`;
    const config = { enabled: true, schedule: kDefaultSystemCronSchedule };
    fs.mkdirSync(configDir, { recursive: true });
    writeFileAtomic(configPath, JSON.stringify(config, null, 2), { fsModule: fs });

    if (shouldSkipSystemCronInstall()) {
      console.log(
        "[onboard] System cron install skipped by ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL",
      );
      return false;
    }

    const cronContent = buildSystemCronFile({
      schedule: config.schedule,
      scriptPath: hourlyGitSyncPath,
      rootDir: kRootDir,
      openclawDir,
    });
    if (!cronContent) return false;
    // Atomic like the other two /etc/cron.d writers (fix wave F079): a
    // truncated root cron file is a silent no-op sync forever.
    writeFileAtomic(kSystemCronPath, cronContent, { fsModule: fs, mode: 0o644 });
    console.log(`[onboard] Installed system cron job at ${kSystemCronPath} (${configPath})`);
    return true;
  } catch (e) {
    console.error("[onboard] System cron install error:", e.message);
    return false;
  }
};

module.exports = { installHourlyGitSyncScript, installHourlyGitSyncCron };
