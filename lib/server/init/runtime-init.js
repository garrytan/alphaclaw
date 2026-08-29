const initializeServerRuntime = ({
  fs,
  constants,
  ensureOpenclawStartupEnv,
  startEnvWatcher,
  cleanupStaleImportTempDirs,
  migrateManagedInternalFiles,
  reapStrayLegacyExecApprovals = null,
}) => {
  ensureOpenclawStartupEnv?.({ fsModule: fs });
  startEnvWatcher();
  // Signal handling moved to the server lifecycle orchestrator
  // (init/server-lifecycle.js) — one graceful shutdown path.
  cleanupStaleImportTempDirs();
  migrateManagedInternalFiles({
    fs,
    openclawDir: constants.OPENCLAW_DIR,
  });
  // Issue #23: a stray legacy exec-approvals.json hard-breaks a SQLite-era
  // gateway; rename it out of the way before anything can launch the gateway.
  reapStrayLegacyExecApprovals?.({
    fsModule: fs,
    openclawDir: constants.OPENCLAW_DIR,
  });
};

const initializeServerDatabases = ({
  constants,
  initAuthDb,
  initWebhooksDb,
  initWatchdogDb,
  initUsageDb,
  initDoctorDb,
}) => {
  initAuthDb({
    rootDir: constants.kRootDir,
  });
  initWebhooksDb({
    rootDir: constants.kRootDir,
    pruneDays: constants.kWebhookPruneDays,
  });
  initWatchdogDb({
    rootDir: constants.kRootDir,
    pruneDays: constants.kWatchdogLogRetentionDays,
  });
  initUsageDb({
    rootDir: constants.kRootDir,
  });
  initDoctorDb({
    rootDir: constants.kRootDir,
  });
};

module.exports = {
  initializeServerRuntime,
  initializeServerDatabases,
};
