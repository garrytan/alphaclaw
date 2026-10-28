const fs = require("fs");
const { readMigrationRecord, patchLastDoctorReport } = require("./openclaw-boot-migration");
const { measureRetainedCapture } = require("./doctor-report");
const {
  formatUnconfiguredAgentDatabasesLine,
  readUnconfiguredAgentDatabases,
} = require("./agent-database-registry");

// Once per boot, when the gateway first serves: facts about this boot's
// Doctor run that cost file-system reads, kept off the path to serving.
//   - the recovery copy's size, when this boot's run retained one;
//   - the registered agent databases no configured agent owns.
// Logged, added to the run's lastOutcome.report and the boot report.
// Never throws; never changes OpenClaw's state.
const reportDoctorFactsAfterServing = ({
  openclawDir,
  managedDir,
  processStartedAtMs,
  readConfig,
  mergeBootReport = null,
  env = process.env,
  fsModule = fs,
  logger = console,
  readRegistry = readUnconfiguredAgentDatabases,
}) => {
  const facts = {};
  try {
    const last = readMigrationRecord({ managedDir, fsModule }).lastOutcome;
    const thisBoot = last?.source === "boot" && Number(last.at) >= processStartedAtMs;
    if (thisBoot && last.report?.captureManifest) {
      const captureBytes = measureRetainedCapture({ manifestPath: last.report.captureManifest, stateDir: openclawDir, env, fsModule });
      facts.doctorRecoveryCopyBytes = captureBytes;
      if (captureBytes !== null) {
        patchLastDoctorReport({ managedDir, at: last.at, patch: { captureBytes }, fsModule });
        logger.log?.("[alphaclaw] doctor --fix recovery copy kept: " + (captureBytes / 1e9).toFixed(2) + " GB");
      }
    }
  } catch (error) {
    logger.warn?.("[alphaclaw] could not measure the doctor --fix recovery copy: " + error.message);
  }
  try {
    const registry = readRegistry({ openclawDir, config: readConfig(), fsModule });
    if (registry.available) {
      facts.unconfiguredAgentDatabases = registry.databases.map(({ agentId, bytes, missing }) => ({ agentId, bytes, missing }));
      if (registry.databases.length) logger.log?.(formatUnconfiguredAgentDatabasesLine(registry));
    }
  } catch (error) {
    logger.warn?.("[alphaclaw] could not read the agent database registry: " + error.message);
  }
  try {
    if (Object.keys(facts).length) mergeBootReport?.(facts);
  } catch {}
  return facts;
};

module.exports = { reportDoctorFactsAfterServing };
