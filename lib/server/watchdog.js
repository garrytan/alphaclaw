const {
  kWatchdogCheckIntervalMs,
  kGatewayTcpWatchIntervalMs,
  kWatchdogConnectedHealthCadenceMs,
  kGatewayTcpTransitionDebounceMs,
  kWatchdogDegradedCheckIntervalMs,
  kWatchdogStartupFailureThreshold,
  kWatchdogMaxRepairAttempts,
  kWatchdogCrashLoopWindowMs,
  kWatchdogCrashLoopThreshold,
  kOpenclawDegradedRollbackMs,
  kOpenclawStabilizationWindowMs,
  kGatewayLifecycleLeaseMs,
} = require("./constants");
const { deriveWatchdogPhase } = require("./watchdog-phase");

const kHealthStartupGraceMs = 30 * 1000;
const kBootstrapHealthCheckMs = 5 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// OpenClaw 2026.8 adds a 30s control-plane restart cooldown: a restart requested
// during the cooldown is SCHEDULED after it expires, not rejected, so a restart can
// land up to ~30s late. Widen the health-suppression window past that so a
// cooldown-delayed restart is never misread as a failed one (the ready timeout is
// already 120s). Was 15s.
const kExpectedRestartWindowMs = 50 * 1000;
const kGatewayHealthTimeoutMs = 5 * 1000;
// OpenClaw 2026.7.1+ exits with EX_CONFIG (78, sysexits.h) on fatal
// configuration errors. The contract is "do not restart until the config is
// fixed" — restarting blindly recreates the restart storm the gateway is
// trying to prevent.
const kOpenclawConfigErrorExitCode = 78;
// Startup-medic ceiling per EX_CONFIG incident: one deterministic pass plus
// one after-a-fix retry. Anything past that latches the legacy pause.
const kWatchdogMedicMaxAttempts = 2;
// Cross-incident brake: a gateway that reaches "listening" and then exits 78
// (config-reload rejection) resets medicAttempts on every launch, so without
// a window cap a listen-then-die flapper would re-arm the medic — and its
// LLM spend and backup churn — forever.
const kWatchdogMedicRunWindowMs = 60 * 60 * 1000;
const kWatchdogMedicMaxRunsPerWindow = 5;

const shellEscapeArg = (value) => {
  const safeValue = String(value || "");
  return `'${safeValue.replace(/'/g, `'\\''`)}'`;
};

const isTruthy = (value) =>
  ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );

const isDuplicateGatewayLaunchExit = ({ code, stderrTail = [] } = {}) => {
  if (code !== 1) return false;
  const stderrText = (Array.isArray(stderrTail) ? stderrTail : [])
    .map((entry) => String(entry || ""))
    .join("\n")
    .toLowerCase();
  if (!stderrText) return false;
  return (
    stderrText.includes("another gateway instance is already listening") ||
    (stderrText.includes("port") && stderrText.includes("already in use"))
  );
};

const createWatchdog = ({
  clawCmd,
  // Rate-limit-aware variant for gateway control-plane bursts (e.g. resuming many
  // suppressed channels). Defaults to clawCmd so existing callers/tests are unchanged.
  clawCmdWithRetry = clawCmd,
  launchGatewayProcess,
  probeGatewayTcp = null,
  gatewayLifecycleLock = null,
  insertWatchdogEvent,
  notifier,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  resolveSetupUrl,
  resolveGatewayHealthUrl = () => "",
  resolveGatewayReadyzUrl = () => "",
  // Release-channel integration (all optional; defaults keep legacy behavior):
  // { getInfo(), requestRollback({reason, exitCode}), onHealthy(), onUnhealthy() }
  releaseChannelHooks = null,
  // Injectable for tests (crash-restart backoff timing).
  sleepImpl = sleep,
  // Streaming runner for `doctor --fix` (spawn-based, 10min ceiling, no
  // maxBuffer). Default null falls back to clawCmd with a raised timeout —
  // the old 15s default killed real repairs mid-flight and parked the
  // watchdog on "manual action required".
  repairRunner = null,
  // Gateway startup medic (lib/server/gateway-medic.js): automatic EX_CONFIG
  // repair, consulted before the exit-78 latch. Optional — null keeps the
  // legacy latch-and-notify behavior.
  configMedic = null,
  // One medic run must finish well inside the lifecycle-lock lease (the run
  // is followed by a relaunch under the same hold). Injectable for tests.
  medicRunBudgetMs = kGatewayLifecycleLeaseMs - 2 * 60 * 1000,
  // How long an exit-78 medic queues behind a live lifecycle holder before
  // latching (issue #20: the boot lock made the medic skip entirely and the
  // box crash-looped; boots/restarts release within seconds). Injectable.
  medicLockWaitMs = 60_000,
}) => {
  const state = {
    lifecycle: "stopped",
    health: "unknown",
    uptimeStartedAt: null,
    lastHealthCheckAt: null,
    lastHealthCheckAtMs: 0,
    statusClientsConnected: false,
    repairAttempts: 0,
    crashTimestamps: [],
    autoRepair: isTruthy(process.env.WATCHDOG_AUTO_REPAIR),
    notificationsDisabled: isTruthy(
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED,
    ),
    operationInProgress: false,
    gatewayStartedAt: null,
    gatewayPid: null,
    crashRecoveryActive: false,
    expectedRestartInProgress: false,
    healthConfirmedSinceLaunch: false,
    // Explicit stop() latch (distinct from lifecycle === "stopped", which is
    // also the never-started initial state): after stop(), gateway exit
    // events and backoff wakeups must not re-arm probes or relaunch.
    stopRequested: false,
    expectedRestartUntilMs: 0,
    pendingRecoveryNoticeSource: "",
    awaitingAutoRepairRecovery: false,
    startupConsecutiveHealthFailures: 0,
    configurationErrorActive: false,
    // Medic runs per EX_CONFIG incident: attempt 2 only happens when a fix
    // relaunched the gateway and it exited 78 again; reset on a real launch.
    medicAttempts: 0,
    // Rolling window of actual medic run start times (cross-incident brake).
    medicRunTimestamps: [],
    safeMode: false,
    suppressedChannels: [],
    safeModeNotifiedKey: "",
    eventLoopDegraded: false,
    readyzFailing: [],
    readinessDegradedKey: "",
    managedOperationActive: false,
    degradedSince: null,
    // Operator-facing "why" capture (display-only; never consulted by the
    // escalation ladder): last failed probe reason, last unexpected gateway
    // exit, and the live crash-relaunch backoff window.
    degradedReason: null,
    lastExit: null,
    backoffUntilMs: 0,
    backoffAttempt: 0,
    // One-shot latch: once a rollback is requested, health ticks and repeat
    // exits must not re-request it (duplicate markers + notifications) while
    // the 1s-delayed restart is landing.
    channelRollbackRequested: false,
  };
  let healthTimer = null;
  let bootstrapHealthTimer = null;
  let degradedHealthTimer = null;
  let tcpWatchTimer = null;
  let tcpTransitionDebounceTimer = null;

  const channelInfo = () => {
    try {
      return releaseChannelHooks?.getInfo?.() || null;
    } catch {
      return null;
    }
  };
  // Rollback is only automatic for a non-pin build inside its stabilization
  // window; long-accepted versions get a notification + CTA instead, so an
  // unrelated crash loop can never blocklist a known-good build.
  // Single home for the eligibility predicate — the exit-78 branch applies it
  // to an already-taken snapshot, every other path reads live info.
  const rollbackEligibleFrom = (info) =>
    info && !info.isPin && info.inStabilizationWindow ? info : null;
  const channelRollbackEligible = () => rollbackEligibleFrom(channelInfo());
  // getStatus() rides the 2s SSE tick for every connected client; the channel
  // store's mtime-cached reads still stat the disk, so status reads go through
  // a short-TTL memo. Enforcement paths keep calling channelRollbackEligible()
  // directly (always fresh) — the UI chip may lag it by at most 5s.
  let rollbackEligibleMemo = { at: 0, info: null };
  const kRollbackEligibleMemoTtlMs = 5000;
  const memoizedRollbackEligible = () => {
    const now = Date.now();
    if (now - rollbackEligibleMemo.at > kRollbackEligibleMemoTtlMs) {
      rollbackEligibleMemo = { at: now, info: channelRollbackEligible() };
    }
    return rollbackEligibleMemo.info;
  };
  const requestChannelRollback = (payload) => {
    try {
      const result = releaseChannelHooks?.requestRollback?.(payload) || null;
      if (result?.ok) state.channelRollbackRequested = true;
      return result;
    } catch {
      return null;
    }
  };
  // A rollback request is "handled" when the marker is on disk (restart
  // imminent) or when the hook itself latched on a marker-write failure —
  // anything else (e.g. state raced back to the pin) falls through to the
  // legacy watchdog behavior instead of leaving the gateway dead.
  const channelRollbackHandled = (result) =>
    Boolean(result?.ok || result?.code === "rollback_marker_write_failed");
  // Managed operations (version swaps) intentionally bounce the gateway with
  // arbitrary exit codes; crash accounting must not count them, or three quick
  // switches would fake a crash loop.
  const beginManagedOperation = () => {
    state.managedOperationActive = true;
  };
  const endManagedOperation = () => {
    state.managedOperationActive = false;
  };
  // Used by the release-channel system when a rollback marker cannot be
  // written (e.g. disk full): restarting without a marker would re-apply the
  // broken build in a loop, so pause automatic restarts instead.
  const latchManualIntervention = () => {
    state.configurationErrorActive = true;
    state.lifecycle = "configuration_error";
    state.health = "unhealthy";
  };
  // Inverse of latchManualIntervention, for the operator's reconcile-retry
  // flow (issue #20): the hold is cleared, the gateway is about to relaunch.
  const clearManualInterventionLatch = () => {
    state.configurationErrorActive = false;
    if (state.lifecycle === "configuration_error") {
      state.lifecycle = "stopped";
      state.health = "unknown";
    }
  };
  let activeIncidentKey = "";
  let sentIncidentNotifications = new Set();

  const openIncident = (incidentKey = "gateway") => {
    const normalizedKey = String(incidentKey || "gateway");
    if (activeIncidentKey === normalizedKey) return;
    activeIncidentKey = normalizedKey;
    sentIncidentNotifications = new Set();
  };

  const closeIncident = () => {
    activeIncidentKey = "";
    sentIncidentNotifications = new Set();
  };

  const clearDegradedHealthCheckTimer = () => {
    if (!degradedHealthTimer) return;
    clearTimeout(degradedHealthTimer);
    degradedHealthTimer = null;
  };

  const scheduleDegradedHealthCheck = () => {
    if (degradedHealthTimer) return;
    if (state.configurationErrorActive) return;
    if (state.health !== "degraded" || state.lifecycle !== "running") return;
    degradedHealthTimer = setTimeout(async () => {
      degradedHealthTimer = null;
      if (state.health !== "degraded" || state.lifecycle !== "running") return;
      await runHealthCheck({
        source: "degraded_retry",
        allowAutoRepair: false,
      });
      if (state.health === "degraded" && state.lifecycle === "running") {
        scheduleDegradedHealthCheck();
      }
    }, kWatchdogDegradedCheckIntervalMs);
    if (typeof degradedHealthTimer.unref === "function")
      degradedHealthTimer.unref();
  };

  const clearExpectedRestartWindow = () => {
    state.expectedRestartInProgress = false;
    state.expectedRestartUntilMs = 0;
  };

  const markExpectedRestartWindow = (durationMs = kExpectedRestartWindowMs) => {
    const safeDuration = Math.max(
      5000,
      Number(durationMs) || kExpectedRestartWindowMs,
    );
    // Never SHRINK an active window: the expected-exit event during a route
    // restart would otherwise replace the operation's lease with the 15s
    // default — 8x shorter than the 120s ready budget.
    state.expectedRestartInProgress = true;
    state.expectedRestartUntilMs = Math.max(
      state.expectedRestartUntilMs,
      Date.now() + safeDuration,
    );
  };

  const startRegularHealthChecks = () => {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      void runHealthCheck();
    }, kWatchdogCheckIntervalMs);
    if (typeof healthTimer.unref === "function") healthTimer.unref();
  };

  const startBootstrapHealthChecks = () => {
    if (bootstrapHealthTimer) return;
    const runBootstrapCheck = async () => {
      const healthy = await runHealthCheck();
      // Bootstrap checks are only for the "initializing" phase. As soon as we
      // either become healthy or transition into any non-unknown state
      // (degraded/unhealthy/etc.), stop 5s polling and fall back to normal
      // interval checks to avoid noisy health-check spam.
      if (healthy || state.health !== "unknown") {
        if (bootstrapHealthTimer) {
          clearTimeout(bootstrapHealthTimer);
          bootstrapHealthTimer = null;
        }
        startRegularHealthChecks();
        return;
      }
      bootstrapHealthTimer = setTimeout(() => {
        void runBootstrapCheck();
      }, kBootstrapHealthCheckMs);
      if (typeof bootstrapHealthTimer.unref === "function") {
        bootstrapHealthTimer.unref();
      }
    };
    void runBootstrapCheck();
  };

  const trimCrashWindow = () => {
    const threshold = Date.now() - kWatchdogCrashLoopWindowMs;
    state.crashTimestamps = state.crashTimestamps.filter(
      (ts) => ts >= threshold,
    );
  };

  const createCorrelationId = () =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const logEvent = (
    eventType,
    source,
    status,
    details = null,
    correlationId = "",
  ) => {
    try {
      insertWatchdogEvent({
        eventType,
        source,
        status,
        details,
        correlationId,
      });
    } catch (err) {
      console.error(`[watchdog] failed to log event: ${err.message}`);
    }
  };

  const notify = async (message, correlationId = "", eventType = "info") => {
    if (state.notificationsDisabled) {
      return { ok: false, skipped: true, reason: "notifications_disabled" };
    }
    if (!notifier?.notify) return { ok: false, reason: "notifier_unavailable" };
    const result = await notifier.notify(message, { eventType });
    logEvent(
      "notification",
      "watchdog",
      result.ok ? "ok" : "failed",
      result,
      correlationId,
    );
    return result;
  };

  const notifyOncePerIncident = async (
    notificationKey,
    message,
    correlationId = "",
    eventType = "info",
  ) => {
    const key = String(notificationKey || "").trim();
    if (!key) return notify(message, correlationId, eventType);
    if (sentIncidentNotifications.has(key)) {
      return {
        ok: false,
        skipped: true,
        reason: "incident_notification_already_sent",
      };
    }
    const result = await notify(message, correlationId, eventType);
    if (result?.ok || result?.skipped) {
      sentIncidentNotifications.add(key);
    }
    return result;
  };

  const getWatchdogSetupUrl = () => {
    try {
      const base =
        typeof resolveSetupUrl === "function"
          ? String(resolveSetupUrl() || "")
          : "";
      if (base) return `${base.replace(/\/+$/, "")}/#/watchdog`;
      const fallbackPort =
        Number.parseInt(String(process.env.PORT || "3000"), 10) || 3000;
      return `http://localhost:${fallbackPort}/#/watchdog`;
    } catch {
      return "";
    }
  };

  const withViewLogsSuffix = (line) => {
    const setupUrl = getWatchdogSetupUrl();
    if (!setupUrl) return line;
    return `${line} - [View logs](${setupUrl})`;
  };

  const asInlineCode = (value) =>
    `\`${String(value || "").replace(/`/g, "")}\``;

  const notifyAutoRepairOutcome = async ({
    source,
    correlationId,
    ok,
    verifiedHealthy = null,
    attempts = 0,
  }) => {
    if (source === "manual") return;
    openIncident("gateway_recovery");
    const title = ok
      ? verifiedHealthy
        ? "🟢 Auto-repair complete, gateway healthy"
        : "🟡 Auto-repair started, awaiting health check"
      : "🔴 Auto-repair failed";
    const notificationKey = ok
      ? verifiedHealthy
        ? "auto_repair_complete"
        : "auto_repair_awaiting_health"
      : "auto_repair_failed";
    await notifyOncePerIncident(
      notificationKey,
      [
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix(title),
        `Trigger: ${asInlineCode(source)}`,
        ...(attempts > 0 ? [`Attempt count: ${attempts}`] : []),
      ].join("\n"),
      correlationId,
      ok && verifiedHealthy ? "recovery" : "crash",
    );
  };

  const getSettings = () => ({
    autoRepair: state.autoRepair,
    notificationsEnabled: !state.notificationsDisabled,
  });

  const probeGatewayHealth = async () => {
    const healthUrl = String(resolveGatewayHealthUrl() || "").trim();
    if (!healthUrl) {
      return {
        ok: false,
        reason: "gateway health URL unavailable",
      };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), kGatewayHealthTimeoutMs);
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const rawBody = await response.text();
      let parsedBody = null;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {}
      if (!response.ok) {
        return {
          ok: false,
          reason:
            parsedBody?.error ||
            `gateway health returned HTTP ${response.status}`,
        };
      }
      if (parsedBody?.ok === false) {
        return {
          ok: false,
          reason: parsedBody?.error || "gateway unhealthy",
        };
      }
      return {
        ok: true,
        details: parsedBody,
      };
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? `gateway health timed out after ${kGatewayHealthTimeoutMs}ms`
          : error?.message || "gateway health request failed";
      return {
        ok: false,
        reason: message,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // OpenClaw 2026.7.1+ can boot into control-plane-safe mode after its own
  // crash-loop breaker trips: /health stays green while channel autostart is
  // suppressed. /readyz reports the suppressed channels.
  const probeGatewayReadiness = async () => {
    const readyzUrl = String(resolveGatewayReadyzUrl() || "").trim();
    if (!readyzUrl) {
      return { ok: false, reason: "gateway readyz URL unavailable" };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      kGatewayHealthTimeoutMs,
    );
    try {
      const response = await fetch(readyzUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const rawBody = await response.text();
      let parsedBody = null;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {}
      if (!response.ok || !parsedBody || typeof parsedBody !== "object") {
        return {
          ok: false,
          reason: `gateway readyz returned HTTP ${response.status}`,
        };
      }
      return {
        ok: true,
        ready: parsedBody.ready !== false,
        failing: Array.isArray(parsedBody.failing) ? parsedBody.failing : [],
        suppressed: Array.isArray(parsedBody.suppressed)
          ? parsedBody.suppressed.map((entry) => String(entry || "")).filter(Boolean)
          : [],
        // OpenClaw 2026.8 authenticated/local /readyz adds an eventLoop block; a
        // `degraded` flag means the gateway is up but wedged (a better "stuck"
        // signal than the health timer). Absent on older gateways => false.
        eventLoopDegraded: Boolean(
          parsedBody.eventLoop && parsedBody.eventLoop.degraded,
        ),
      };
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? `gateway readyz timed out after ${kGatewayHealthTimeoutMs}ms`
          : error?.message || "gateway readyz request failed";
      return { ok: false, reason: message };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const clearSafeModeState = () => {
    state.safeMode = false;
    state.suppressedChannels = [];
    state.safeModeNotifiedKey = "";
  };

  const evaluateChannelSuppression = async (source, correlationId) => {
    const readiness = await probeGatewayReadiness();
    if (!readiness.ok) return;
    // Surface "gateway up but degraded" signals (event loop wedged, or providers/
    // channels reported failing on /readyz) so the Watchdog UI can show that a green
    // /health does not mean fully healthy. Read-only: does not drive restart/rollback.
    state.eventLoopDegraded = readiness.eventLoopDegraded === true;
    state.readyzFailing = Array.isArray(readiness.failing)
      ? readiness.failing.map((entry) => String(entry || "")).filter(Boolean)
      : [];
    // 1.8: green /health + degraded readiness → health reads "degraded" so
    // the UI never shows a plain green dot over a wedged event loop or failing
    // components. Deliberately does NOT set degradedSince or call onUnhealthy —
    // readiness degradation only re-checks; it never drives repair/rollback.
    const readinessDegraded =
      state.eventLoopDegraded || state.readyzFailing.length > 0;
    if (readinessDegraded) {
      if (state.health === "healthy") {
        state.health = "degraded";
        scheduleDegradedHealthCheck();
      }
      const degradedKey = [
        state.eventLoopDegraded ? "eventLoop" : "",
        ...state.readyzFailing,
      ]
        .filter(Boolean)
        .sort()
        .join(",");
      if (state.readinessDegradedKey !== degradedKey) {
        state.readinessDegradedKey = degradedKey;
        logEvent(
          "readiness_degraded",
          source,
          "failed",
          {
            eventLoopDegraded: state.eventLoopDegraded,
            failing: state.readyzFailing,
          },
          correlationId,
        );
        // One ADVISORY doctor --json on the transition: beta gateways START
        // degraded (instead of refusing) when SecretRefs fail — shape-detect
        // that so the event log names the cause. Warn-only, never restarts.
        try {
          const doctor = await clawCmd("doctor --json", {
            quiet: true,
            timeoutMs: 20000,
          });
          const doctorText = String(doctor?.stdout || "");
          if (
            /secret/i.test(doctorText) &&
            /(fail|degrad|unavailable|missing|error)/i.test(doctorText)
          ) {
            logEvent(
              "readiness_degraded",
              source,
              "failed",
              { hint: "doctor reports secret-runtime degradation" },
              correlationId,
            );
          }
        } catch {}
      }
    } else if (state.readinessDegradedKey) {
      state.readinessDegradedKey = "";
      logEvent(
        "readiness_degraded",
        source,
        "ok",
        { recovered: true },
        correlationId,
      );
    }
    const suppressed = readiness.suppressed;
    if (suppressed.length > 0) {
      const notifiedKey = suppressed.slice().sort().join(",");
      const changed = state.safeModeNotifiedKey !== notifiedKey;
      state.safeMode = true;
      state.suppressedChannels = suppressed;
      if (!changed) return;
      state.safeModeNotifiedKey = notifiedKey;
      logEvent(
        "safe_mode",
        source,
        "failed",
        { suppressed, failing: readiness.failing },
        correlationId,
      );
      await notify(
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix(
            "🟡 Gateway channels paused — autostart suppressed by its crash-loop breaker",
          ),
          `Suppressed channels: ${suppressed.join(", ")}`,
          "The gateway is up but these channels are not delivering messages. Resume them from the Watchdog tab once the crash cause is fixed.",
        ].join("\n"),
        correlationId,
        "crash",
      );
      return;
    }
    if (state.safeMode) {
      clearSafeModeState();
      logEvent("safe_mode", source, "ok", { recovered: true }, correlationId);
      await notify(
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix("🟢 Gateway channels resumed — pause cleared"),
        ].join("\n"),
        correlationId,
        "recovery",
      );
    }
  };

  const resumeChannels = async () => {
    const correlationId = createCorrelationId();
    const channels = [...state.suppressedChannels];
    if (channels.length === 0) {
      return { ok: false, skipped: true, reason: "no_suppressed_channels" };
    }
    const results = [];
    for (const channel of channels) {
      const params = JSON.stringify({ channel });
      // Resuming several suppressed channels at once can trip the gateway's
      // 30/min control-plane rate limit; honor retryAfterMs instead of failing.
      const result = await clawCmdWithRetry(
        `gateway call channels.start --params ${shellEscapeArg(params)}`,
        { quiet: true },
      );
      const ok = !!result?.ok;
      results.push({ channel, ok, stderr: ok ? undefined : result?.stderr });
      logEvent(
        "safe_mode_resume",
        "manual",
        ok ? "ok" : "failed",
        { channel, stderr: result?.stderr || null },
        correlationId,
      );
    }
    await runHealthCheck({
      source: "resume_channels",
      allowAutoRepair: false,
      allowDuringOperation: true,
    });
    return { ok: results.every((entry) => entry.ok), results };
  };

  const updateSettings = ({ autoRepair, notificationsEnabled } = {}) => {
    const hasAutoRepair = typeof autoRepair === "boolean";
    const hasNotificationsEnabled = typeof notificationsEnabled === "boolean";
    if (!hasAutoRepair && !hasNotificationsEnabled) {
      throw new Error(
        "Expected autoRepair and/or notificationsEnabled boolean",
      );
    }
    const envVars = readEnvFile();
    if (hasAutoRepair) {
      const existingIdx = envVars.findIndex(
        (item) => item.key === "WATCHDOG_AUTO_REPAIR",
      );
      const nextValue = autoRepair ? "true" : "false";
      if (existingIdx >= 0) {
        envVars[existingIdx] = { ...envVars[existingIdx], value: nextValue };
      } else {
        envVars.push({ key: "WATCHDOG_AUTO_REPAIR", value: nextValue });
      }
    }
    if (hasNotificationsEnabled) {
      const existingIdx = envVars.findIndex(
        (item) => item.key === "WATCHDOG_NOTIFICATIONS_DISABLED",
      );
      const nextValue = notificationsEnabled ? "false" : "true";
      if (existingIdx >= 0) {
        envVars[existingIdx] = { ...envVars[existingIdx], value: nextValue };
      } else {
        envVars.push({
          key: "WATCHDOG_NOTIFICATIONS_DISABLED",
          value: nextValue,
        });
      }
    }
    writeEnvFile(envVars);
    reloadEnv();
    state.autoRepair = isTruthy(process.env.WATCHDOG_AUTO_REPAIR);
    state.notificationsDisabled = isTruthy(
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED,
    );
    return getSettings();
  };

  const runRepair = async ({ source, correlationId, force = false }) => {
    if (state.configurationErrorActive && !force) {
      return { ok: false, skipped: true, reason: "configuration_error" };
    }
    if (!force && !state.autoRepair) {
      return { ok: false, skipped: true, reason: "auto_repair_disabled" };
    }
    if (!force && state.awaitingAutoRepairRecovery) {
      return { ok: false, skipped: true, reason: "awaiting_health_recovery" };
    }
    if (state.operationInProgress) {
      return { ok: false, skipped: true, reason: "operation_in_progress" };
    }
    // Serialize with route restarts / channel applies / boot: background
    // recovery SKIPS when another lifecycle operation holds the lock — a
    // repair must never run doctor mutations or launch a gateway under a
    // live restart.
    const releaseLifecycleLock = gatewayLifecycleLock
      ? gatewayLifecycleLock.tryAcquire("repair")
      : null;
    if (gatewayLifecycleLock && !releaseLifecycleLock) {
      logEvent(
        "repair",
        source,
        "skipped",
        { reason: "lifecycle_operation_in_progress" },
        correlationId,
      );
      return { ok: false, skipped: true, reason: "operation_in_progress" };
    }
    if (force) {
      state.configurationErrorActive = false;
    }

    state.operationInProgress = true;
    try {
      const kRepairTimeoutMs = 10 * 60 * 1000;
      const result = repairRunner
        ? await repairRunner({ correlationId })
        : await clawCmd("doctor --fix --yes", {
            quiet: true,
            timeoutMs: kRepairTimeoutMs,
          });
      if (state.configurationErrorActive && !force) {
        return { ok: false, skipped: true, reason: "configuration_error" };
      }
      const ok = !!result?.ok;
      logEvent("repair", source, ok ? "ok" : "failed", result, correlationId);
      if (ok) {
        let launchedGateway = false;
        try {
          const child = await launchGatewayProcess();
          launchedGateway = !!child;
          if (launchedGateway) {
            logEvent(
              "restart",
              "repair",
              "ok",
              { pid: child.pid },
              correlationId,
            );
          } else {
            logEvent(
              "restart",
              "repair",
              "failed",
              { reason: "launchGatewayProcess returned no child" },
              correlationId,
            );
          }
        } catch (err) {
          logEvent(
            "restart",
            "repair",
            "failed",
            { error: err.message },
            correlationId,
          );
        }
        state.health = "unknown";
        state.lifecycle = "running";
        state.repairAttempts = 0;
        state.crashTimestamps = [];
        state.awaitingAutoRepairRecovery = false;
        const verifiedHealthy = await runHealthCheck({
          allowDuringOperation: true,
          source: "repair_verify",
          allowAutoRepair: false,
        });
        await notifyAutoRepairOutcome({
          source,
          correlationId,
          ok: true,
          verifiedHealthy,
          attempts: state.repairAttempts,
        });
        if (!verifiedHealthy && source !== "manual") {
          state.pendingRecoveryNoticeSource = source;
          state.awaitingAutoRepairRecovery = true;
        } else {
          state.pendingRecoveryNoticeSource = "";
          state.awaitingAutoRepairRecovery = false;
        }
        return { ok: true, verifiedHealthy, launchedGateway, result };
      }

      state.repairAttempts += 1;
      state.health = "unhealthy";
      await notifyAutoRepairOutcome({
        source,
        correlationId,
        ok: false,
        attempts: state.repairAttempts,
      });
      if (state.repairAttempts >= kWatchdogMaxRepairAttempts) {
        await notify(
          [
            "🐺 *AlphaClaw Watchdog*",
            "🔴 Auto-repair failed repeatedly",
            `Attempts: ${state.repairAttempts}`,
            withViewLogsSuffix("Auto-repair paused until manual action."),
          ].join("\n"),
          correlationId,
          "crash",
        );
      }
      return { ok: false, result };
    } finally {
      releaseLifecycleLock?.();
      state.operationInProgress = false;
      // Re-probe immediately at operation end — reality changed (or didn't);
      // never leave a stale lifecycle (e.g. crash_loop) standing for up to
      // 120s while the gateway is already back. Resync only: letting this
      // probe start another repair would chain repair → probe → repair
      // without a timer gap while the gateway is down.
      void runHealthCheck({
        source: "operation_end",
        allowDuringOperation: true,
        allowAutoRepair: false,
      });
    }
  };

  const runHealthCheck = async ({
    allowDuringOperation = false,
    source = "health_timer",
    allowAutoRepair = true,
  } = {}) => {
    if (state.configurationErrorActive) return false;
    if (
      state.expectedRestartInProgress &&
      Date.now() >= state.expectedRestartUntilMs
    ) {
      clearExpectedRestartWindow();
    }
    if (state.operationInProgress && !allowDuringOperation) return false;
    const gatewayStartedAtAtStart = state.gatewayStartedAt;
    const correlationId = createCorrelationId();
    state.lastHealthCheckAt = new Date().toISOString();
    state.lastHealthCheckAtMs = Date.now();
    const parsed = await probeGatewayHealth();
    // The gateway may exit with EX_CONFIG while a probe is in flight. Keep the
    // latched configuration-error state from being overwritten by that result.
    if (state.configurationErrorActive) return false;
    const staleAfterRestart =
      gatewayStartedAtAtStart != null &&
      state.gatewayStartedAt != null &&
      state.gatewayStartedAt !== gatewayStartedAtAtStart;
    const restartWindowActive =
      state.expectedRestartInProgress &&
      Date.now() < state.expectedRestartUntilMs;
    if (staleAfterRestart) {
      return false;
    }
    if (parsed.ok) {
      // Mid-restart "up" is not recovery: with prepare-before-stop the OLD
      // gateway still answers probes before the stop lands, and one healthy
      // probe here used to wipe the entire suppression window (then the stop
      // made the watchdog see an "unexpected" outage and start a competing
      // doctor-repair + launch under the live restart). The window ends via
      // onExpectedRestartSettled (always called when the operation ends) or
      // lease expiry — not via a probe that may be seeing the old process.
      if (restartWindowActive && state.lifecycle === "restarting") {
        logEvent(
          "health_check",
          source,
          "ok",
          { ok: true, midRestart: true, expectedRestartActive: true },
          correlationId,
        );
        return true;
      }
      const wasUnhealthy = state.health !== "healthy";
      const recoveredFromCrashLoop = state.lifecycle === "crash_loop";
      const shouldNotifyRecovery =
        !!activeIncidentKey ||
        recoveredFromCrashLoop ||
        !!state.pendingRecoveryNoticeSource ||
        state.awaitingAutoRepairRecovery;
      state.startupConsecutiveHealthFailures = 0;
      clearDegradedHealthCheckTimer();
      clearExpectedRestartWindow();
      state.health = "healthy";
      state.lifecycle = "running";
      state.degradedSince = null;
      state.degradedReason = null;
      state.lastExit = null;
      state.backoffUntilMs = 0;
      state.backoffAttempt = 0;
      state.healthConfirmedSinceLaunch = true;
      // A healthy build may legitimately need a rollback for a LATER incident.
      state.channelRollbackRequested = false;
      if (!state.uptimeStartedAt || wasUnhealthy)
        state.uptimeStartedAt = Date.now();
      state.repairAttempts = 0;
      state.crashRecoveryActive = false;
      state.awaitingAutoRepairRecovery = false;
      if (shouldNotifyRecovery) {
        logEvent(
          "recovery",
          source,
          "ok",
          [
            {
              previousLifecycle: recoveredFromCrashLoop
                ? "crash_loop"
                : null,
              previousRecoverySource: state.pendingRecoveryNoticeSource || null,
              health: "healthy",
            },
          ][0],
          correlationId,
        );
        // Recovery names the resolving action so the alert thread reads as a
        // closed incident, not a mystery flip back to green.
        const resolvedBy = state.pendingRecoveryNoticeSource
          ? "Recovered after automatic repair."
          : recoveredFromCrashLoop
            ? "The instability cleared — the gateway stayed up."
            : null;
        await notifyOncePerIncident(
          "gateway_healthy_again",
          [
            "🐺 *AlphaClaw Watchdog*",
            withViewLogsSuffix("🟢 Gateway running again"),
            ...(resolvedBy ? [resolvedBy] : []),
          ].join("\n"),
          correlationId,
          "recovery",
        );
      }
      state.pendingRecoveryNoticeSource = "";
      closeIncident();
      logEvent(
        "health_check",
        source,
        "ok",
        parsed.details || { ok: true },
        correlationId,
      );
      await evaluateChannelSuppression(source, correlationId);
      try {
        releaseChannelHooks?.onHealthy?.();
      } catch {}
      return true;
    }
    if (restartWindowActive) {
      state.startupConsecutiveHealthFailures = 0;
      clearDegradedHealthCheckTimer();
      logEvent(
        "health_check",
        source,
        "ok",
        {
          reason: parsed.reason,
          details: parsed.details || null,
          skipped: true,
          expectedRestartActive: true,
          expectedRestartUntilMs: state.expectedRestartUntilMs,
        },
        correlationId,
      );
      return false;
    }

    const withinStartupGrace =
      !!state.gatewayStartedAt &&
      Date.now() - state.gatewayStartedAt < kHealthStartupGraceMs &&
      state.lifecycle === "running" &&
      !state.crashRecoveryActive &&
      // Grace exists for slow cold boots. Once THIS launch has answered one
      // health probe, it has provably booted — later failures are real and
      // must not hide behind the boot window.
      !state.healthConfirmedSinceLaunch;
    if (withinStartupGrace) {
      state.startupConsecutiveHealthFailures = 0;
      clearDegradedHealthCheckTimer();
      logEvent(
        "health_check",
        source,
        "ok",
        {
          reason: parsed.reason,
          details: parsed.details || null,
          skipped: true,
          startupGraceActive: true,
          startupGraceMs: kHealthStartupGraceMs,
        },
        correlationId,
      );
      return false;
    }

    if (state.health === "unknown" && state.lifecycle === "running") {
      state.startupConsecutiveHealthFailures += 1;
      if (
        state.startupConsecutiveHealthFailures <
        kWatchdogStartupFailureThreshold
      ) {
        logEvent(
          "health_check",
          source,
          "ok",
          {
            reason: parsed.reason,
            details: parsed.details || null,
            skipped: true,
            startupFailureRetryActive: true,
            startupConsecutiveFailures: state.startupConsecutiveHealthFailures,
            startupFailureThreshold: kWatchdogStartupFailureThreshold,
          },
          correlationId,
        );
        return false;
      }
    } else {
      state.startupConsecutiveHealthFailures = 0;
    }

    state.health = "degraded";
    state.degradedReason = String(parsed.reason || "").slice(0, 200) || null;
    scheduleDegradedHealthCheck();
    if (!state.degradedSince) state.degradedSince = Date.now();
    try {
      releaseChannelHooks?.onUnhealthy?.();
    } catch {}
    logEvent(
      "health_check",
      source,
      "failed",
      { reason: parsed.reason, details: parsed.details || null },
      correlationId,
    );
    const degradedChannelInfo = channelRollbackEligible();
    if (degradedChannelInfo) {
      let rollbackFellThrough = false;
      if (
        !state.channelRollbackRequested &&
        Date.now() - state.degradedSince >= kOpenclawDegradedRollbackMs
      ) {
        logEvent(
          "channel_rollback",
          source,
          "requested",
          {
            reason: "degraded",
            degradedMs: Date.now() - state.degradedSince,
          },
          correlationId,
        );
        const result = requestChannelRollback({
          reason: "degraded",
          exitCode: null,
        });
        rollbackFellThrough = !channelRollbackHandled(result);
      }
      // While an unaccepted non-pin build stabilizes, rollback owns recovery:
      // unattended `doctor --fix` must not mutate state under a build we may be
      // about to abandon (openclaw#107226).
      if (!rollbackFellThrough) return false;
    }
    if (!state.autoRepair || !allowAutoRepair) return false;
    if (state.awaitingAutoRepairRecovery) return false;
    await runRepair({ source, correlationId });
    return false;
  };

  const restartAfterCrash = async (correlationId) => {
    if (state.operationInProgress) return;
    // Exponential backoff on repeat crashes: a gateway that dies instantly
    // must not hot-loop relaunch (each relaunch drags the plugin preflight
    // with it). min(30s, 1s * 2^recentCrashes) from the crash window. The
    // backoff does NOT hold operationInProgress — a crash-loop repair firing
    // mid-backoff takes precedence and this relaunch bails on the re-check.
    // Managed operations keep their own 10s relaunch cadence (no doubling).
    if (!state.managedOperationActive) {
      trimCrashWindow();
      const recentCrashes = state.crashTimestamps.length;
      if (recentCrashes > 1) {
        const backoffMs = Math.min(30000, 1000 * 2 ** (recentCrashes - 1));
        state.backoffUntilMs = Date.now() + backoffMs;
        state.backoffAttempt = recentCrashes;
        logEvent(
          "restart",
          "exit_event",
          "backoff",
          { backoffMs, recentCrashes },
          correlationId,
        );
        await sleepImpl(backoffMs);
        state.backoffUntilMs = 0;
        // Re-check after the sleep: the watchdog may have been stopped, a
        // repair/relaunch may have taken over, or the gateway may already be
        // back up (launch is idempotent but skipping avoids a redundant lock
        // round-trip).
        if (state.stopRequested) return;
        if (state.operationInProgress) return;
        if (state.lifecycle === "running" && state.health === "healthy") return;
      }
    }
    // Serialize with route restarts / applies / boot AFTER the backoff, so an
    // operation that started during the sleep is honored: recovery is its
    // job, and a competing launch is exactly what the lock exists to prevent.
    const releaseLifecycleLock = gatewayLifecycleLock
      ? gatewayLifecycleLock.tryAcquire("crash_restart")
      : null;
    if (gatewayLifecycleLock && !releaseLifecycleLock) {
      logEvent(
        "restart",
        "exit_event",
        "skipped",
        { reason: "lifecycle_operation_in_progress" },
        correlationId,
      );
      return;
    }
    state.operationInProgress = true;
    try {
      const child = await launchGatewayProcess();
      if (child) {
        logEvent(
          "restart",
          "exit_event",
          "ok",
          { pid: child.pid },
          correlationId,
        );
      } else {
        logEvent(
          "restart",
          "exit_event",
          "failed",
          { reason: "launchGatewayProcess returned no child" },
          correlationId,
        );
      }
    } catch (err) {
      logEvent(
        "restart",
        "exit_event",
        "failed",
        { error: err.message },
        correlationId,
      );
    } finally {
      releaseLifecycleLock?.();
      state.operationInProgress = false;
      // Resync only (see runRepair) — must not chain into another repair.
      void runHealthCheck({
        source: "operation_end",
        allowDuringOperation: true,
        allowAutoRepair: false,
      });
    }
  };

  // Model output is derived from UNTRUSTED gateway stderr; before it rides a
  // trusted-looking watchdog notification, strip anything that could carry a
  // social-engineering payload (links, markdown link syntax) and label it as
  // machine-generated.
  const sanitizeModelDiagnosis = (diagnosis) => {
    const text = String(diagnosis || "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\bhttps?:\/\/\S+/gi, "[link removed]")
      .replace(/\s+/g, " ")
      .trim();
    return text ? `Model-suggested diagnosis (unverified): ${text}` : null;
  };

  const notifyConfigErrorLatched = async ({ correlationId, diagnosis = null }) => {
    const diagnosisLine = sanitizeModelDiagnosis(diagnosis);
    return notifyOncePerIncident(
      "gateway_config_error",
      [
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix("🔴 Gateway configuration error"),
        "OpenClaw stopped with `EX_CONFIG`; automatic gateway restart is paused until the config is fixed.",
        ...(diagnosisLine ? [diagnosisLine] : []),
      ].join("\n"),
      correlationId,
      "config_error",
    );
  };

  const runConfigMedic = async ({
    exitCode,
    stderrTail,
    correlationId,
    allowDoctorFix,
    attempt,
  }) => {
    // Serialize with route restarts / applies / boot exactly like runRepair:
    // the medic mutates openclaw.json and ends in a relaunch. A held lock is
    // usually TRANSIENT — issue #20's boot-time exit-78 hit exactly this
    // skip because the boot sequence still held the lock, so the medic never
    // ran and the box crash-looped. Queue behind the active holder for a
    // bounded window before giving up; a boot/restart releases within
    // seconds, and a wedged holder is bounded by the lock lease.
    let releaseLifecycleLock = gatewayLifecycleLock
      ? gatewayLifecycleLock.tryAcquire("medic")
      : null;
    let queuedBehindHolder = false;
    if (gatewayLifecycleLock && !releaseLifecycleLock) {
      queuedBehindHolder = true;
      let waitTimedOut = false;
      releaseLifecycleLock = await Promise.race([
        Promise.resolve()
          .then(() => gatewayLifecycleLock.acquire("medic"))
          .then((release) => {
            if (!waitTimedOut) return release;
            // The wait already gave up — never strand the lock.
            try {
              release?.();
            } catch {}
            return null;
          })
          .catch(() => null),
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            waitTimedOut = true;
            resolve(null);
          }, medicLockWaitMs);
          timer.unref?.();
        }),
      ]);
    }
    if (gatewayLifecycleLock && !releaseLifecycleLock) {
      // A skip is not a medic run — refund the attempt so two lock-contended
      // exits can't exhaust the cap without the medic ever executing.
      state.medicAttempts = Math.max(0, state.medicAttempts - 1);
      logEvent(
        "medic",
        "exit_event",
        "skipped",
        { reason: "lifecycle_operation_in_progress", attempt },
        correlationId,
      );
      try {
        await notifyConfigErrorLatched({ correlationId });
      } catch {}
      return;
    }
    if (queuedBehindHolder) {
      // The queued wait can resolve up to medicLockWaitMs after the exit-78
      // observation — long enough for the prior holder (boot, a route
      // restart) to have already repaired the config and relaunched. Acting
      // on the stale observation would mutate openclaw.json under a live
      // gateway, so probe liveness first and stand down when it answers.
      let supersededByLiveGateway = false;
      try {
        supersededByLiveGateway = (await probeGatewayHealth()).ok === true;
      } catch {}
      if (supersededByLiveGateway) {
        // A superseded skip is not a medic run — refund the attempt.
        state.medicAttempts = Math.max(0, state.medicAttempts - 1);
        logEvent(
          "medic",
          "exit_event",
          "skipped",
          { reason: "medic_superseded", attempt },
          correlationId,
        );
        releaseLifecycleLock?.();
        return;
      }
    }
    const holdStartedAt = Date.now();
    state.medicRunTimestamps.push(Date.now());
    state.operationInProgress = true;
    try {
      let outcome;
      try {
        // Race against the run budget: a hung medic (stalled provider,
        // runaway doctor) must latch, not hold the lifecycle lock past its
        // lease and hand a force-released gateway to a competing operation.
        const budgetExpired = new Promise((resolve) => {
          const timer = setTimeout(
            () =>
              resolve({
                fixed: false,
                tier: "timeout",
                error: "medic exceeded its run budget",
              }),
            medicRunBudgetMs,
          );
          if (typeof timer.unref === "function") timer.unref();
        });
        outcome = await Promise.race([
          configMedic.run({
            exitCode,
            stderrTail,
            allowDoctorFix,
            attempt,
            budgetMs: medicRunBudgetMs,
          }),
          budgetExpired,
        ]);
      } catch (error) {
        outcome = { fixed: false, tier: "error", error: error.message };
      }
      logEvent(
        "medic",
        "exit_event",
        outcome.fixed ? "ok" : "failed",
        {
          attempt,
          tier: outcome.tier || null,
          model: outcome.model || null,
          actions: outcome.actions || null,
          backup: outcome.backup || null,
          diagnosis: outcome.diagnosis || null,
          error: outcome.error || null,
        },
        correlationId,
      );
      if (!outcome.fixed) {
        await notifyConfigErrorLatched({
          correlationId,
          diagnosis: outcome.diagnosis || null,
        });
        return;
      }
      // Lease check comes BEFORE the recovery notification: on expiry no
      // relaunch happens, and a "Restarting the gateway." message would
      // contradict the latch that follows.
      if (Date.now() - holdStartedAt >= kGatewayLifecycleLeaseMs) {
        // The lock's lease expired mid-run and may have been force-released
        // to another operation — that operation owns the gateway now; a
        // launch here would race it.
        logEvent(
          "restart",
          "medic",
          "skipped",
          { reason: "lease_expired" },
          correlationId,
        );
        state.configurationErrorActive = true;
        state.lifecycle = "configuration_error";
        await notifyConfigErrorLatched({
          correlationId,
          diagnosis: outcome.diagnosis || null,
        });
        return;
      }
      state.configurationErrorActive = false;
      state.lifecycle = "restarting";
      state.health = "unknown";
      const diagnosisLine = sanitizeModelDiagnosis(outcome.diagnosis);
      await notify(
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix("🩹 Gateway config auto-repaired"),
          `Fix: ${(outcome.actions || []).join("; ") || outcome.tier}${
            outcome.model ? ` (chosen by ${outcome.model})` : ""
          }.`,
          ...(diagnosisLine ? [diagnosisLine] : []),
          ...(outcome.backup ? [`Backup: ${outcome.backup}`] : []),
          "Restarting the gateway.",
        ].join("\n"),
        correlationId,
        "recovery",
      );
      let child = null;
      try {
        child = await launchGatewayProcess();
      } catch (error) {
        logEvent(
          "restart",
          "medic",
          "failed",
          { error: error.message },
          correlationId,
        );
      }
      if (child) {
        logEvent("restart", "medic", "ok", { pid: child.pid }, correlationId);
      } else {
        state.configurationErrorActive = true;
        state.lifecycle = "configuration_error";
        await notifyConfigErrorLatched({
          correlationId,
          diagnosis: outcome.diagnosis || null,
        });
      }
    } finally {
      releaseLifecycleLock?.();
      state.operationInProgress = false;
    }
  };

  const onGatewayExit = ({
    code,
    signal,
    expectedExit = false,
    stderrTail = [],
  } = {}) => {
    // A stopped watchdog (shutdown drain, deliberate stop) must not react to
    // the gateway exit it caused — re-arming health probes or logging restart
    // events mid-drain. Boot-time crashes are unaffected: stopRequested is
    // only ever set by stop().
    if (state.stopRequested) return;
    const correlationId = createCorrelationId();
    clearDegradedHealthCheckTimer();
    clearSafeModeState();
    state.degradedSince = null;
    if (state.managedOperationActive) {
      state.lifecycle = "restarting";
      state.health = "unknown";
      state.uptimeStartedAt = null;
      state.crashRecoveryActive = false;
      logEvent(
        "restart",
        "exit_event",
        "ok",
        { managedOperation: true, code: code ?? null, signal: signal ?? null },
        correlationId,
      );
      // Only crash ACCOUNTING is suspended: a dev build can take 30+ minutes
      // and the OOM killer loves pnpm — the agent must still come back up.
      // Small backoff: with the crash-loop brake bypassed by design, a
      // fast-failing gateway would otherwise relaunch in a tight loop for the
      // entire build.
      setTimeout(() => {
        if (state.managedOperationActive) void restartAfterCrash(correlationId);
      }, 10_000).unref?.();
      return;
    }
    if (expectedExit && (code == null || code === 0)) {
      state.lifecycle = "restarting";
      state.health = "unknown";
      state.uptimeStartedAt = null;
      state.crashRecoveryActive = false;
      markExpectedRestartWindow();
      startBootstrapHealthChecks();
      logEvent(
        "restart",
        "exit_event",
        "ok",
        { expectedExit: true, code: code ?? null, signal: signal ?? null },
        correlationId,
      );
      return;
    }
    if (isDuplicateGatewayLaunchExit({ code, stderrTail })) {
      state.lifecycle = "running";
      state.health = "unknown";
      state.crashRecoveryActive = false;
      state.startupConsecutiveHealthFailures = 0;
      if (!state.uptimeStartedAt) {
        state.uptimeStartedAt = Date.now();
      }
      startBootstrapHealthChecks();
      logEvent(
        "restart",
        "exit_event",
        "ok",
        {
          duplicateLaunch: true,
          code: code ?? null,
          signal: signal ?? null,
          stderrTail,
        },
        correlationId,
      );
      return;
    }

    // Unexpected exit (config error or crash): record it for the status
    // surface. Managed, expected, and duplicate-launch exits returned above.
    state.lastExit = {
      code: code ?? null,
      signal: signal ?? null,
      at: new Date().toISOString(),
    };

    if (code === kOpenclawConfigErrorExitCode) {
      // Version skew usually shows up exactly here (a new build rejecting the
      // existing config). For a non-pin build still in its stabilization
      // window, roll back instead of latching — the latch would otherwise
      // silently defeat channel rollback (the exit never reaches crash
      // accounting below).
      // Doctor gating fails CLOSED when the channel state cannot be read: an
      // unreadable state could be hiding a live stabilization window, and
      // unattended doctor --fix must never mutate state under a build we may
      // be about to abandon (openclaw#107226). No hooks at all = legacy mode
      // with no windows = doctor allowed.
      let configChannelInfoUnreadable = false;
      let configChannelSnapshot = null;
      if (releaseChannelHooks?.getInfo) {
        try {
          configChannelSnapshot = releaseChannelHooks.getInfo() || null;
        } catch {
          configChannelSnapshot = null;
        }
        configChannelInfoUnreadable = configChannelSnapshot === null;
      }
      const configChannelInfo = rollbackEligibleFrom(configChannelSnapshot);
      if (configChannelInfo) {
        state.lifecycle = "crashed";
        state.health = "unhealthy";
        state.uptimeStartedAt = null;
        state.crashRecoveryActive = false;
        if (state.channelRollbackRequested) return;
        logEvent(
          "channel_rollback",
          "exit_event",
          "requested",
          { reason: "config_error", code, signal: signal ?? null },
          correlationId,
        );
        const result = requestChannelRollback({
          reason: "config_error",
          exitCode: code,
        });
        if (channelRollbackHandled(result)) return;
        // Unhandled (e.g. nothing to roll back after a state race): fall
        // through to the legacy EX_CONFIG latch below rather than leaving the
        // gateway crashed with neither a restart nor a latch.
      }
      state.configurationErrorActive = true;
      state.lifecycle = "configuration_error";
      state.health = "unhealthy";
      state.uptimeStartedAt = null;
      state.crashRecoveryActive = false;
      state.startupConsecutiveHealthFailures = 0;
      logEvent(
        "config_error",
        "exit_event",
        "failed",
        { code, signal: signal ?? null, stderrTail },
        correlationId,
      );
      // Startup medic: bounded automatic repair (managed-key strip, doctor,
      // AI-chosen whitelisted remedy) before the restart-paused latch. It
      // relaunches on success; only when it gives up does the incident latch
      // with the legacy notification. doctor --fix stays suppressed whenever
      // rollback was eligible but unhandled (stabilization window may still
      // be live — openclaw#107226).
      const medicRateLimited = (() => {
        const now = Date.now();
        state.medicRunTimestamps = state.medicRunTimestamps.filter(
          (ts) => now - ts < kWatchdogMedicRunWindowMs,
        );
        return (
          state.medicRunTimestamps.length >= kWatchdogMedicMaxRunsPerWindow
        );
      })();
      if (
        configMedic?.isEnabled?.() &&
        !medicRateLimited &&
        state.medicAttempts < kWatchdogMedicMaxAttempts
      ) {
        state.medicAttempts += 1;
        void runConfigMedic({
          exitCode: code,
          stderrTail,
          correlationId,
          allowDoctorFix: !configChannelInfo && !configChannelInfoUnreadable,
          attempt: state.medicAttempts,
        });
        return;
      }
      if (medicRateLimited && configMedic?.isEnabled?.()) {
        logEvent(
          "medic",
          "exit_event",
          "skipped",
          {
            reason: "rate_limited",
            runsInWindow: state.medicRunTimestamps.length,
            windowMs: kWatchdogMedicRunWindowMs,
          },
          correlationId,
        );
      }
      void notifyConfigErrorLatched({ correlationId });
      return;
    }

    state.lifecycle = "crashed";
    state.health = "unhealthy";
    state.uptimeStartedAt = null;
    state.crashRecoveryActive = true;
    state.crashTimestamps.push(Date.now());
    trimCrashWindow();
    logEvent(
      "crash",
      "exit_event",
      "failed",
      { code: code ?? null, signal: signal ?? null, stderrTail },
      correlationId,
    );

    if (state.crashTimestamps.length >= kWatchdogCrashLoopThreshold) {
      state.lifecycle = "crash_loop";
      openIncident("gateway_recovery");
      logEvent(
        "crash_loop",
        "exit_event",
        "failed",
        {
          crashesInWindow: state.crashTimestamps.length,
          windowMs: kWatchdogCrashLoopWindowMs,
        },
        correlationId,
      );
      const crashLoopChannelInfo = channelRollbackEligible();
      if (crashLoopChannelInfo) {
        if (state.channelRollbackRequested) return;
        logEvent(
          "channel_rollback",
          "exit_event",
          "requested",
          { reason: "crash_loop", code: code ?? null },
          correlationId,
        );
        const result = requestChannelRollback({
          reason: "crash_loop",
          exitCode: code ?? null,
        });
        if (channelRollbackHandled(result)) return;
        // Unhandled: fall through to the legacy crash-loop notification/repair.
      }
      void notifyOncePerIncident(
        "crash_loop_detected",
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix(
            state.autoRepair
              ? "🔴 Gateway unstable — crash loop detected, auto-repairing..."
              : "🔴 Gateway unstable — crash loop detected",
          ),
          `Crashes: ${state.crashTimestamps.length} in the last ${Math.floor(kWatchdogCrashLoopWindowMs / 1000)}s`,
          `Last exit code: ${code ?? "unknown"}`,
          ...(state.autoRepair
            ? []
            : ["Automatic gateway restart paused; manual action required."]),
        ].join("\n"),
        correlationId,
        "crash",
      );
      if (state.autoRepair) {
        void runRepair({
          source: "crash_loop",
          correlationId,
        }).then((result) => {
          // A crash-loop repair racing an in-flight relaunch is skipped with
          // operation_in_progress — keep retrying on a short cadence (bounded)
          // instead of silently dropping the repair the notification promised.
          const scheduleRetry = (attempt) => {
            if (attempt > 5) return;
            const retryTimer = setTimeout(() => {
              void runRepair({ source: "crash_loop_retry", correlationId }).then(
                (retryResult) => {
                  if (
                    retryResult?.skipped &&
                    retryResult?.reason === "operation_in_progress"
                  ) {
                    scheduleRetry(attempt + 1);
                  }
                },
              );
            }, 2000);
            if (typeof retryTimer.unref === "function") retryTimer.unref();
          };
          if (result?.skipped && result?.reason === "operation_in_progress") {
            scheduleRetry(1);
          }
        });
        return;
      }
      return;
    }

    void restartAfterCrash(correlationId);
  };

  const onGatewayLaunch = ({ startedAt = Date.now(), pid = null } = {}) => {
    clearDegradedHealthCheckTimer();
    state.configurationErrorActive = false;
    state.medicAttempts = 0;
    state.lifecycle = "running";
    state.health = "unknown";
    state.startupConsecutiveHealthFailures = 0;
    state.crashRecoveryActive = false;
    clearExpectedRestartWindow();
    state.uptimeStartedAt = startedAt;
    state.gatewayStartedAt = startedAt;
    state.healthConfirmedSinceLaunch = false;
    state.gatewayPid = pid;
    startBootstrapHealthChecks();
  };

  // Suppression follows the caller's operation lease when provided (a manual
  // restart's ready budget), not a fixed window 8x shorter than the budget.
  // The expected-restart window is bounded by the operation LEASE (a worst-
  // case ceiling), but a settled operation must close it immediately: with a
  // dead gateway no successful probe will ever arrive to clear it, and a
  // 10-minute suppression window would hide the death from detection,
  // notifications, and repair.
  const onExpectedRestartSettled = () => {
    clearExpectedRestartWindow();
    void runHealthCheck({
      source: "operation_end",
      allowDuringOperation: true,
      allowAutoRepair: false,
    }).then((healthy) => {
      if (!healthy && state.lifecycle === "restarting") {
        // The operation is over and the gateway did NOT come back healthy.
        // Left as "restarting", the reducer reads launch-in-progress and the
        // card pulses "Starting" forever with no Retry — demote to stopped so
        // it reports Down with real remediation actions.
        state.lifecycle = "stopped";
        state.uptimeStartedAt = null;
      }
    });
  };

  const onExpectedRestart = ({ expiresAt = 0 } = {}) => {
    clearDegradedHealthCheckTimer();
    clearSafeModeState();
    state.lifecycle = "restarting";
    state.health = "unknown";
    state.uptimeStartedAt = null;
    state.startupConsecutiveHealthFailures = 0;
    state.crashRecoveryActive = false;
    const leaseMs = expiresAt > Date.now() ? expiresAt - Date.now() : undefined;
    markExpectedRestartWindow(leaseMs);
    startBootstrapHealthChecks();
  };

  const triggerRepair = async () => {
    const correlationId = createCorrelationId();
    return runRepair({
      source: "manual",
      correlationId,
      force: true,
    });
  };

  // External lifecycle operations (manual restarts via the route) land in the
  // incident ledger so history shows what ran, when, and how it ended.
  const recordOperationEvent = ({ kind, status, details = {} } = {}) => {
    try {
      logEvent("operation", String(kind || "operation"), String(status || "ok"), details, createCorrelationId());
    } catch {}
  };

  const setStatusClientsConnected = (connected) => {
    state.statusClientsConnected = !!connected;
  };

  // Debounced immediate re-probe when the shared TCP probe sees the port
  // flip up<->down — reality changed; don't wait out the health timer.
  const onGatewayTcpTransition = () => {
    if (tcpTransitionDebounceTimer) return;
    tcpTransitionDebounceTimer = setTimeout(() => {
      tcpTransitionDebounceTimer = null;
      void runHealthCheck({ source: "tcp_transition" });
    }, kGatewayTcpTransitionDebounceMs);
    tcpTransitionDebounceTimer.unref?.();
  };

  // Always-on liveness watcher: keeps tcp observations fresh (and transition
  // events firing) even with no browser connected, and tightens the health
  // cadence to ~30s while someone is watching.
  const startTcpWatcher = () => {
    if (tcpWatchTimer || typeof probeGatewayTcp !== "function") return;
    tcpWatchTimer = setInterval(async () => {
      try {
        await probeGatewayTcp();
      } catch {}
      if (
        state.statusClientsConnected &&
        Date.now() - state.lastHealthCheckAtMs >=
          kWatchdogConnectedHealthCadenceMs
      ) {
        void runHealthCheck({ source: "fast_cadence" });
      }
    }, kGatewayTcpWatchIntervalMs);
    tcpWatchTimer.unref?.();
  };

  const stopTcpWatcher = () => {
    if (tcpWatchTimer) {
      clearInterval(tcpWatchTimer);
      tcpWatchTimer = null;
    }
    if (tcpTransitionDebounceTimer) {
      clearTimeout(tcpTransitionDebounceTimer);
      tcpTransitionDebounceTimer = null;
    }
  };

  const start = () => {
    if (healthTimer || bootstrapHealthTimer) return;
    clearDegradedHealthCheckTimer();
    state.stopRequested = false;
    // Boot calls start() AFTER the reconcile step: when the reconciler held
    // the gateway (latchManualIntervention), "running" here would make the
    // reducer present a plain down-with-Retry card that steers the operator
    // into restarting onto the rejected config. Timers still start — the
    // health/repair paths already no-op on the latch.
    if (!state.configurationErrorActive) {
      state.lifecycle = "running";
      state.health = "unknown";
    }
    state.startupConsecutiveHealthFailures = 0;
    state.gatewayStartedAt = Date.now();
    state.healthConfirmedSinceLaunch = false;
    startBootstrapHealthChecks();
    startTcpWatcher();
  };

  const stop = () => {
    state.stopRequested = true;
    clearDegradedHealthCheckTimer();
    stopTcpWatcher();
    if (bootstrapHealthTimer) {
      clearTimeout(bootstrapHealthTimer);
      bootstrapHealthTimer = null;
    }
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    state.lifecycle = "stopped";
    state.uptimeStartedAt = null;
    state.startupConsecutiveHealthFailures = 0;
    state.awaitingAutoRepairRecovery = false;
    state.pendingRecoveryNoticeSource = "";
    clearSafeModeState();
    closeIncident();
  };

  const getStatus = () => {
    trimCrashWindow();
    const now = Date.now();
    // Every additional field below is an in-memory read or pure arithmetic —
    // getStatus() rides the 2s SSE tick, so no DB/fs/network here (the one
    // channel-store lookup goes through the 5s memo above).
    const rollbackInfo = memoizedRollbackEligible();
    const stabilizationUntil =
      rollbackInfo &&
      Number(rollbackInfo.acceptedAt) > 0 &&
      rollbackInfo.applied?.acceptedSource !== "manual"
        ? new Date(
            Number(rollbackInfo.acceptedAt) + kOpenclawStabilizationWindowMs,
          ).toISOString()
        : null;
    return {
      lifecycle: state.lifecycle,
      health: state.health,
      uptimeMs: state.uptimeStartedAt ? now - state.uptimeStartedAt : 0,
      uptimeStartedAt: state.uptimeStartedAt
        ? new Date(state.uptimeStartedAt).toISOString()
        : null,
      lastHealthCheckAt: state.lastHealthCheckAt,
      repairAttempts: state.repairAttempts,
      repairAttemptLimit: kWatchdogMaxRepairAttempts,
      autoRepair: state.autoRepair,
      crashCountInWindow: state.crashTimestamps.length,
      crashLoopThreshold: kWatchdogCrashLoopThreshold,
      crashLoopWindowMs: kWatchdogCrashLoopWindowMs,
      operationInProgress: state.operationInProgress,
      gatewayPid: state.gatewayPid,
      safeMode: state.safeMode,
      suppressedChannels: [...state.suppressedChannels],
      eventLoopDegraded: state.eventLoopDegraded,
      readyzFailing: [...state.readyzFailing],
      degradedSince: state.degradedSince
        ? new Date(state.degradedSince).toISOString()
        : null,
      degradedReason: state.degradedReason,
      lastExit: state.lastExit,
      startupGraceUntil:
        state.gatewayStartedAt &&
        now - state.gatewayStartedAt < kHealthStartupGraceMs
          ? new Date(state.gatewayStartedAt + kHealthStartupGraceMs).toISOString()
          : null,
      expectedRestartUntil:
        state.expectedRestartInProgress && state.expectedRestartUntilMs > now
          ? new Date(state.expectedRestartUntilMs).toISOString()
          : null,
      backoff: {
        active: state.backoffUntilMs > now,
        untilMs: state.backoffUntilMs > now ? state.backoffUntilMs : null,
        attempt: state.backoffAttempt || 0,
      },
      rollbackDeadlineAt:
        rollbackInfo && state.degradedSince
          ? new Date(
              state.degradedSince + kOpenclawDegradedRollbackMs,
            ).toISOString()
          : null,
      stabilization: { active: !!rollbackInfo, until: stabilizationUntil },
      doctorFixSuppressed: !!rollbackInfo,
      doctorFixSuppressedReason: rollbackInfo ? "stabilization_window" : null,
      awaitingAutoRepairRecovery: state.awaitingAutoRepairRecovery,
      phase: deriveWatchdogPhase(
        {
          lifecycle: state.lifecycle,
          health: state.health,
          configurationErrorActive: state.configurationErrorActive,
          managedOperationActive: state.managedOperationActive,
          expectedRestartInProgress: state.expectedRestartInProgress,
          expectedRestartUntilMs: state.expectedRestartUntilMs,
          safeMode: state.safeMode,
          channelRollbackRequested: state.channelRollbackRequested,
          crashRecoveryActive: state.crashRecoveryActive,
          gatewayStartedAt: state.gatewayStartedAt,
          startupGraceMs: kHealthStartupGraceMs,
          awaitingAutoRepairRecovery: state.awaitingAutoRepairRecovery,
          operationInProgress: state.operationInProgress,
          rollbackEligible: !!rollbackInfo,
        },
        now,
      ),
      serverNow: now,
    };
  };

  return {
    getStatus,
    getSettings,
    updateSettings,
    triggerRepair,
    resumeChannels,
    onExpectedRestart,
    onExpectedRestartSettled,
    onGatewayTcpTransition,
    setStatusClientsConnected,
    recordOperationEvent,
    onGatewayExit,
    onGatewayLaunch,
    beginManagedOperation,
    endManagedOperation,
    latchManualIntervention,
    clearManualInterventionLatch,
    // exported for tests
    probeGatewayHealth,
    probeGatewayReadiness,
    start,
    stop,
  };
};

module.exports = { createWatchdog };
