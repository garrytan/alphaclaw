const HttpTerminator = require("lil-http-terminator");

// Single owner of process lifecycle: listen (with EADDRINUSE retry), crash
// guards, and ONE graceful shutdown path used by signals, crash guards, and
// self-update restarts alike.
//
//   signal/crash/update ──▶ gracefulExit(code)
//                             │ (reentrancy-guarded; 2nd entry exits hard)
//                             ▼
//        clear keep-alives ─ terminator.terminate() ─ stopGateway()
//              ─ gmailWatch.stop() ─ terminal.dispose() ─ flushLogs()
//                             │ (every step try/catch'd)
//                             ▼
//                  exit(code)   [10s hard deadline regardless]
const kListenRetryAttempts = 5;
const kListenRetryDelayMs = 3000;
const kDrainGraceMs = 3000;
const kShutdownDeadlineMs = 10000;
const kRejectionStormWindowMs = 5 * 60 * 1000;
const kRejectionStormThreshold = 50;

const createServerLifecycle = ({
  server,
  PORT,
  isOnboarded = () => false,
  runOnboardedBootSequence = () => {},
  stopGateway = async () => {},
  stopWatchdog = () => {},
  killGatewayNow = () => {},
  gmailWatchService = null,
  watchdogTerminal = null,
  disposeServices = () => {},
  flushLogs = () => {},
  exitImpl = (code) => process.exit(code),
  logger = console,
  listenRetryDelayMs = kListenRetryDelayMs,
  shutdownDeadlineMs = kShutdownDeadlineMs,
  rejectionStormThreshold = kRejectionStormThreshold,
  rejectionStormWindowMs = kRejectionStormWindowMs,
}) => {
  const state = {
    terminator: null,
    exiting: false,
    exitCode: 0,
    listenAttempts: 0,
    rejectionTimestamps: [],
    rejectionTotal: 0,
  };

  // Behind a platform LB (Render/Railway), keep-alive must outlive the LB's
  // ~60s idle timeout or the LB races a socket the server is closing into a
  // 502; headersTimeout must exceed keepAliveTimeout so header parsing never
  // loses that race. requestTimeout pins Node's default (it bounds receipt of
  // the request, not long-lived responses like SSE) explicitly.
  if (server) {
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.requestTimeout = 300000;
  }

  const drain = async () => {
    const steps = [
      // Watchdog first: otherwise the gateway stop below triggers its
      // expected-exit path, which restarts health probes and logs spurious
      // restart-failed events against the already-cancelled lifecycle lock.
      ["watchdog stop", () => stopWatchdog()],
      ["http terminator", () => state.terminator?.terminate()],
      ["gateway stop", () => stopGateway()],
      ["gmail watch stop", () => gmailWatchService?.stop?.()],
      ["watchdog terminal dispose", () => watchdogTerminal?.disposeSession?.()],
      ["service dispose", () => disposeServices()],
      ["log flush", () => flushLogs()],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (error) {
        logger.error(`[alphaclaw] shutdown step failed (${label}): ${error?.message || error}`);
      }
    }
  };

  const gracefulExit = async (code = 0, reason = "") => {
    if (state.exiting) {
      // Already draining: exit immediately rather than re-entering cleanup.
      // A benign repeated SIGTERM keeps the ORIGINAL exit code (a duplicate
      // signal during a clean shutdown must not flip 0 into a failure).
      // Last-ditch: the drain being abandoned may not have reaped the
      // gateway child yet — an orphan keeping the port makes the successor
      // process treat the OLD version as healthy and skip its own start.
      try {
        killGatewayNow();
      } catch {}
      exitImpl(code === 0 ? state.exitCode : code);
      return;
    }
    state.exiting = true;
    state.exitCode = code;
    if (reason) logger.log(`[alphaclaw] Shutting down: ${reason}`);
    const deadline = setTimeout(() => {
      logger.error("[alphaclaw] Shutdown deadline exceeded — exiting now");
      try {
        killGatewayNow();
      } catch {}
      exitImpl(code || 1);
    }, shutdownDeadlineMs);
    try {
      await drain();
    } finally {
      clearTimeout(deadline);
      exitImpl(code);
    }
  };

  const recordUnhandledRejection = (reason) => {
    const now = Date.now();
    state.rejectionTotal += 1;
    state.rejectionTimestamps.push(now);
    state.rejectionTimestamps = state.rejectionTimestamps.filter(
      (ts) => now - ts <= rejectionStormWindowMs,
    );
    const message = reason?.stack || reason?.message || String(reason);
    logger.error(`[alphaclaw] Unhandled rejection (continuing): ${message}`);
    // A storm keeps rejecting while the drain runs — re-entering gracefulExit
    // here would hit the reentrancy branch and hard-exit mid-drain, skipping
    // gateway reap and log flush. Log-only once an exit is in progress.
    if (!state.exiting && state.rejectionTimestamps.length >= rejectionStormThreshold) {
      // A rejection storm means some subsystem is failing continuously; the
      // process state is suspect. Bounded restart instead of zombie-serving.
      void gracefulExit(1, "unhandled rejection storm");
      return true;
    }
    return false;
  };

  const installCrashGuards = () => {
    // Single-owner guarantee: any earlier boot-time guards (bin/alphaclaw.js
    // installs primitive ones before the server loads) are replaced here.
    for (const event of ["unhandledRejection", "uncaughtException", "SIGTERM", "SIGINT"]) {
      process.removeAllListeners(event);
    }
    process.on("unhandledRejection", (reason) => {
      recordUnhandledRejection(reason);
    });
    process.on("uncaughtException", (error) => {
      logger.error(
        `[alphaclaw] Uncaught exception: ${error?.stack || error?.message || error}`,
      );
      void gracefulExit(1, "uncaught exception");
    });
    process.on("SIGTERM", () => {
      void gracefulExit(0, "SIGTERM");
    });
    process.on("SIGINT", () => {
      void gracefulExit(0, "SIGINT");
    });
  };

  const startListening = () => {
    server.on("error", (error) => {
      if (error?.code === "EADDRINUSE" && state.listenAttempts < kListenRetryAttempts) {
        state.listenAttempts += 1;
        logger.warn(
          `[alphaclaw] Port ${PORT} in use — retry ${state.listenAttempts}/${kListenRetryAttempts} in ${Math.round(listenRetryDelayMs / 1000)}s`,
        );
        setTimeout(() => {
          try {
            server.listen(PORT, "0.0.0.0");
          } catch (listenError) {
            logger.error(`[alphaclaw] Listen retry failed: ${listenError.message}`);
          }
        }, listenRetryDelayMs);
        return;
      }
      // Loud exit — a silent zombie (the old behavior: unhandled 'error'
      // event) is the one unacceptable outcome. The platform restarts us.
      logger.error(`[alphaclaw] Server failed to listen on :${PORT}: ${error?.message || error}`);
      exitImpl(1);
    });
    server.on("listening", () => {
      if (!state.terminator) {
        state.terminator = HttpTerminator({
          server,
          gracefulTerminationTimeout: kDrainGraceMs,
          maxWaitTimeout: shutdownDeadlineMs,
          logger: { ...console, warn: () => {} },
        });
      }
      logger.log(`[alphaclaw] Express listening on :${PORT}`);
      if (isOnboarded()) {
        // Fire-and-forget with an explicit catch: the boot sequence reports
        // its own failures via boot-phase, but a rejection escaping it must
        // never feed the rejection storm brake (or, without crash guards
        // installed, kill the process).
        Promise.resolve(runOnboardedBootSequence()).catch((error) => {
          logger.error(
            `[alphaclaw] Boot sequence error: ${error?.message || error}`,
          );
        });
      } else {
        logger.log("[alphaclaw] Awaiting onboarding via Setup UI");
      }
    });
    server.listen(PORT, "0.0.0.0");
  };

  const getRejectionStats = () => ({
    total: state.rejectionTotal,
    inWindow: state.rejectionTimestamps.length,
  });

  return {
    startListening,
    installCrashGuards,
    gracefulExit,
    drain,
    getRejectionStats,
    // exposed for tests
    __recordUnhandledRejection: recordUnhandledRejection,
  };
};

module.exports = {
  createServerLifecycle,
};
