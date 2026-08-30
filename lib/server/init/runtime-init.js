const initializeServerRuntime = ({
  fs,
  constants,
  ensureOpenclawStartupEnv,
  startEnvWatcher,
  cleanupStaleImportTempDirs,
  migrateManagedInternalFiles,
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
  // NOTE: the issue-#23 stray exec-approvals reaper used to run here. It now
  // runs inside ensureManagedExecDefaults (the boot sequence's first step,
  // still before any gateway launch) because a correct reap decision needs
  // the async era hint — the sync table-existence check that lived here
  // misfired on every pinned-version box (renaming the LIVE approvals file).
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
