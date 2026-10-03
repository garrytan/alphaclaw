const fs = require("fs");
const path = require("path");
const constants = require("./constants");
const { createServerPidfile, formatServerPidDecision } = require("./server-pidfile");
const { retireReleaseChannelAtBoot } = require("./openclaw-channel-retirement");
const { createBootReportWriter, buildBinPhaseReport, kPidfileSkipReason } = require("./boot-report");
const { getProcessBootId } = require("./boot-id");
const { readSelfVersionStamp } = require("./alphaclaw-self-version");
const { readContainerStartTicks, readContainerStartMs } = require("./openclaw-lock-contention");
const { resolveSelfDependency } = require("./self-dependency");
const { readRegularFileBounded } = require("./utils/bounded-file");

// A VPS respawn handoff briefly overlaps its predecessor: give a dying
// process this long to exit before judging its claim live.
const kConcurrentGraceMs = 3000;
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
};

const readPackageField = (packageJsonPath, read, fsModule) => {
  try {
    return read(JSON.parse(readRegularFileBounded(packageJsonPath, { fsModule }))) || null;
  } catch {
    return null;
  }
};

// The bin phase of every `alphaclaw start` (bin/alphaclaw.js), before
// lib/server.js loads: the single-instance judgement, the one-time retirement
// of the old in-app version switch, and the bin half of boot-report.json.
// Synchronous and fail-open except for the one refusal the caller acts on:
//   { action: "none" | "skipped_concurrent", livePid?, corroborated?, pidDecision }
// A corroborated live owner (its pidfile names a live pid whose kernel start
// time matches the record) means a second server would run lib/server.js's
// module-init side effects against the live databases before dying on
// EADDRINUSE (fix wave F004) — the caller refuses to start.
const runBootInstanceGuard = ({
  managedDir = constants.kOpenclawManagedDir,
  rootDir = constants.kRootDir,
  openclawDir = constants.OPENCLAW_DIR,
  packageRoot = constants.kNpmPackageRoot,
  selfVersion = null,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
  pidfile = createServerPidfile({ managedDir, fsModule, logger }),
} = {}) => {
  const log = (message) => logger.log?.(`[alphaclaw] ${message}`);
  const declaredPin = readPackageField(path.join(packageRoot, "package.json"), (pkg) => pkg?.dependencies?.openclaw, fsModule);
  const readInstalled = () => {
    const installDir = resolveSelfDependency({ fsImpl: fsModule }).installDir;
    return installDir
      ? readPackageField(path.join(installDir, "node_modules", "openclaw", "package.json"), (pkg) => pkg?.version, fsModule)
      : null;
  };
  let result = { action: "none", warnings: [], pidDecision: null, retirement: null };
  try {
    const deadline = Date.now() + kConcurrentGraceMs;
    let pidDecision = pidfile.describeServerPidDecision();
    while (pidDecision.evidence && Date.now() < deadline) {
      sleepSync(300);
      pidDecision = pidfile.describeServerPidDecision();
    }
    log(`pidfile: ${formatServerPidDecision(pidDecision)}`);
    const converged = pidfile.convergeLegacyServerPidClaim(pidDecision);
    if (converged?.converged) {
      log(`pidfile: legacy claim for pid ${pidDecision.pid} converged to format 2 (observedTicks=${converged.record.observedTicks})`);
    }
    result.pidDecision = pidDecision;
    if (pidDecision.evidence) {
      const corroborated = pidDecision.evidence.corroborated === true;
      result = {
        ...result,
        action: "skipped_concurrent",
        // The persisted bootSync.reason vocabulary (boot-report.json).
        reason: corroborated ? "live_server_corroborated" : "live_server_unverified",
        livePid: pidDecision.evidence.pid,
        corroborated,
      };
    } else {
      // Claim NOW, not at server start: the window between this guard and
      // lib/server.js is exactly where a simultaneous second start would race.
      pidfile.writeServerPid();
      result.retirement = retireReleaseChannelAtBoot({ managedDir, rootDir, pinVersion: declaredPin, fsModule, nowFn, logger });
    }
  } catch (error) {
    result.warnings.push(`boot guard failed: ${error?.message || error}`);
    log(`boot guard failed (fail-open): ${error?.message || error}`);
  }
  try {
    const bootReport = createBootReportWriter({ managedDir, bootId: getProcessBootId(), logger });
    const installedAtBoot = readInstalled();
    const stamp = selfVersion?.record?.version
      ? selfVersion
      : null;
    const recorded = stamp ? null : readSelfVersionStamp({ fsModule, managedDir, logger });
    const report = buildBinPhaseReport({
      bootId: bootReport.bootId || getProcessBootId(),
      at: nowFn(),
      alphaclaw: stamp
        ? { version: stamp.record.version, commit: stamp.record.commit ?? null, previousVersion: stamp.previousVersion ?? null, firstBootOfVersion: stamp.changed === true }
        : recorded
          ? { version: recorded.version, commit: recorded.commit, previousVersion: recorded.previous?.version ?? null, firstBootOfVersion: recorded.bootCount === 1 }
          : null,
      container: { pid1StartTicks: readContainerStartTicks({ fsModule }), startMs: readContainerStartMs({ fsModule }) },
      pidDecision: result.pidDecision,
      openclaw: {
        stateDir: process.env.OPENCLAW_STATE_DIR || openclawDir,
        declaredPin,
        installedAtBoot,
        installedDiverged: declaredPin && installedAtBoot ? installedAtBoot !== declaredPin : null,
        retiredChannel: result.retirement?.previous ?? null,
      },
      bootSync: result,
    });
    if (result.action === "skipped_concurrent" && result.corroborated) bootReport.writeRefusedBinPhase(report, kPidfileSkipReason);
    else bootReport.writeBinPhase(report);
  } catch (error) {
    log(`boot report not written (${error?.message || error})`);
  }
  return result;
};

module.exports = { runBootInstanceGuard };
