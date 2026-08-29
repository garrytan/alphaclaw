const {
  kWatchdogCheckIntervalMs,
  kWatchdogDegradedCheckIntervalMs,
  kWatchdogStartupFailureThreshold,
  kWatchdogMaxRepairAttempts,
  kWatchdogCrashLoopWindowMs,
  kWatchdogCrashLoopThreshold,
  kOpenclawDegradedRollbackMs,
} = require("./constants");
const { isSupervisorModeActive } = require("./gateway");
const { consumeRestartHandoff } = require("./gateway-restart-handoff");

const kHealthStartupGraceMs = 30 * 1000;
const kBootstrapHealthCheckMs = 5 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kExpectedRestartWindowMs = 15 * 1000;
const kGatewayHealthTimeoutMs = 5 * 1000;
// OpenClaw 2026.7.1+ exits with EX_CONFIG (78, sysexits.h) on fatal
// configuration errors. The contract is "do not restart until the config is
// fixed" — restarting blindly recreates the restart storm the gateway is
// trying to prevent.
const kOpenclawConfigErrorExitCode = 78;
// 2026.8.1 overloads exit 78 with a BENIGN case (healthy-incumbent
// step-aside, see isHealthyIncumbentStepAsideExit below). Step-aside exits
// happen at boot — the losing process exits within seconds of its own spawn —
// so the classification additionally requires the exit to land inside this
// window of the launch (2× kHealthStartupGraceMs) plus a healthy /health
// probe of the incumbent.
const kStepAsideStartupWindowMs = 60 * 1000;
const kStepAsideHealthProbeAttempts = 2;

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

const stderrTailText = (stderrTail) =>
  (Array.isArray(stderrTail) ? stderrTail : [])
    .map((entry) => String(entry || ""))
    .join("\n")
    .toLowerCase();

const isDuplicateGatewayLaunchExit = ({ code, stderrTail = [] } = {}) => {
  if (code !== 1) return false;
  const stderrText = stderrTailText(stderrTail);
  if (!stderrText) return false;
  return (
    stderrText.includes("another gateway instance is already listening") ||
    (stderrText.includes("port") && stderrText.includes("already in use"))
  );
};

// OpenClaw 2026.8.1 overloads EX_CONFIG with a BENIGN case: a NEW gateway
// process that loses the startup lock (or hits EADDRINUSE) probes the
// incumbent's /healthz and, when the incumbent is healthy, deliberately exits
// 78 so a systemd RestartPreventExitStatus=78 unit stops looping — a
// step-aside, not a config error. Signature verified in
// openclaw@2026.8.1-beta.3 dist (SupervisedGatewayLockError): "gateway
// already running under systemd; existing gateway is healthy, exiting with
// code 78 to prevent a systemd Restart=always loop"
// (docs/gateway/gateway-lock.md, "Operational notes"). Both phrases must
// match — the sibling probe-timeout error ("did not become healthy") and the
// Tailscale :443 exit-78 use different wording and must keep latching.
const isHealthyIncumbentStepAsideExit = ({ code, stderrTail = [] } = {}) => {
  if (code !== kOpenclawConfigErrorExitCode) return false;
  const stderrText = stderrTailText(stderrTail);
  if (!stderrText) return false;
  return (
    stderrText.includes("existing gateway is healthy") &&
    stderrText.includes("exiting with code 78")
  );
};

const createWatchdog = ({
  clawCmd,
  launchGatewayProcess,
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
  // Restart-handoff consume (both injectable for tests). The default gate
  // reads the same feature gates lib/server.js installs into gateway.js via
  // setGatewayFeatureGates, so stable installs (gate closed) never spawn the
  // hidden consume CLI; fail-closed when gates are absent or throwing.
  supervisorModeActive = isSupervisorModeActive,
  consumeRestartHandoffImpl = consumeRestartHandoff,
}) => {
  const state = {
    lifecycle: "stopped",
    health: "unknown",
    uptimeStartedAt: null,
    lastHealthCheckAt: null,
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
    // Explicit stop() latch (distinct from lifecycle === "stopped", which is
    // also the never-started initial state): after stop(), gateway exit
    // events and backoff wakeups must not re-arm probes or relaunch.
    stopRequested: false,
    expectedRestartUntilMs: 0,
    pendingRecoveryNoticeSource: "",
    awaitingAutoRepairRecovery: false,
    startupConsecutiveHealthFailures: 0,
    configurationErrorActive: false,
    safeMode: false,
    suppressedChannels: [],
    safeModeNotifiedKey: "",
    managedOperationActive: false,
    degradedSince: null,
    // One-shot latch: once a rollback is requested, health ticks and repeat
    // exits must not re-request it (duplicate markers + notifications) while
    // the 1s-delayed restart is landing.
    channelRollbackRequested: false,
  };
  let healthTimer = null;
  let bootstrapHealthTimer = null;
  let degradedHealthTimer = null;
  // Two exit classifications resolve ASYNCHRONOUSLY: the exit-78 step-aside
  // health probe and the restart-handoff consume. The token pins each pending
  // resolution to the exit that started it — any newer lifecycle event
  // (launch, another exit, expected restart, managed operation, start/stop)
  // advances the token and the stale result is discarded. A requested channel
  // rollback also discards: rollback owns recovery (same doctrine as the
  // auto-repair suppression in runHealthCheck).
  let pendingExitProbeToken = 0;
  const advancePendingExitProbeToken = () => {
    pendingExitProbeToken += 1;
    return pendingExitProbeToken;
  };
  const pendingExitProbeStale = (token) =>
    token !== pendingExitProbeToken ||
    state.stopRequested ||
    state.managedOperationActive ||
    state.channelRollbackRequested;

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
  const channelRollbackEligible = () => {
    const info = channelInfo();
    return info && !info.isPin && info.inStabilizationWindow ? info : null;
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
    advancePendingExitProbeToken();
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
    state.expectedRestartInProgress = true;
    state.expectedRestartUntilMs = Date.now() + safeDuration;
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
            "🟡 Gateway is in safe mode — channel autostart suppressed by its crash-loop breaker",
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
          withViewLogsSuffix("🟢 Gateway safe mode cleared — channels resumed"),
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
      const result = await clawCmd(
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
      state.operationInProgress = false;
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
        await notifyOncePerIncident(
          "gateway_healthy_again",
          [
            "🐺 *AlphaClaw Watchdog*",
            withViewLogsSuffix("🟢 Gateway healthy again"),
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
      !state.crashRecoveryActive;
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
        logEvent(
          "restart",
          "exit_event",
          "backoff",
          { backoffMs, recentCrashes },
          correlationId,
        );
        await sleepImpl(backoffMs);
        // Re-check after the sleep: the watchdog may have been stopped, a
        // repair/relaunch may have taken over, or the gateway may already be
        // back up (launch is idempotent but skipping avoids a redundant lock
        // round-trip).
        if (state.stopRequested) return;
        if (state.operationInProgress) return;
        if (state.lifecycle === "running" && state.health === "healthy") return;
      }
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
      state.operationInProgress = false;
    }
  };

  // Step-aside exits happen at boot: the losing process probes the incumbent
  // and exits within seconds of its own spawn. Prefer the per-child spawn
  // timestamp carried on the exit event; fall back to the last recorded
  // launch. No reference at all fails the window (fail-safe toward the
  // config-error latch).
  const withinStepAsideStartupWindow = (launchedAt) => {
    const referenceAt = Number(launchedAt) || state.gatewayStartedAt || 0;
    return (
      referenceAt > 0 && Date.now() - referenceAt <= kStepAsideStartupWindowMs
    );
  };

  // Deferred exit-78 resolution: the step-aside stderr signature and startup
  // window already matched; the third signal is a healthy /health probe of
  // the incumbent (a signature alone could be a stale or dying incumbent).
  // All three signals → treat like the duplicate-launch branch. Probe
  // unhealthy, unreachable, or throwing → the EXISTING config-error flow,
  // unchanged.
  const resolveStepAsideExit = async ({
    code,
    signal,
    stderrTail,
    correlationId,
    probeToken,
  }) => {
    let healthy = false;
    try {
      for (
        let attempt = 0;
        attempt < kStepAsideHealthProbeAttempts && !healthy;
        attempt += 1
      ) {
        const probe = await probeGatewayHealth();
        healthy = probe?.ok === true;
      }
    } catch {
      healthy = false;
    }
    if (pendingExitProbeStale(probeToken)) return;
    if (!healthy) {
      handleConfigErrorExit({ code, signal, stderrTail, correlationId });
      return;
    }
    // Healthy incumbent verified: the exited process was redundant by design
    // and the incumbent keeps the port — mirror the duplicate-launch branch
    // (no latch, no rollback, no notification).
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
        stepAside: true,
        code: code ?? null,
        signal: signal ?? null,
        stderrTail,
      },
      correlationId,
    );
  };

  // Deferred clean-exit resolution (external supervision, 2026.8.1+): consume
  // the gateway's restart-handoff row for the exited PID. `accepted` proves
  // this exit was a restart REQUEST (config-write restart, /restart, SIGUSR1,
  // plugin change) — expected-restart handling plus a prompt relaunch, no
  // crash accounting or backoff. none/rejected/error → the existing crash
  // classification, unchanged.
  const resolveSupervisedCleanExit = async ({
    code,
    signal,
    stderrTail,
    pid,
    correlationId,
    probeToken,
  }) => {
    let consumed = null;
    try {
      consumed = await consumeRestartHandoffImpl({ clawCmd, pid });
    } catch {
      consumed = { status: "error", reason: null, handoff: null };
    }
    if (pendingExitProbeStale(probeToken)) return;
    if (consumed?.status === "accepted") {
      state.lifecycle = "restarting";
      state.health = "unknown";
      state.uptimeStartedAt = null;
      state.crashRecoveryActive = false;
      markExpectedRestartWindow();
      startBootstrapHealthChecks();
      logEvent(
        "restart",
        "handoff",
        "ok",
        {
          source: consumed.handoff?.source ?? null,
          reason: consumed.handoff?.reason ?? null,
          restartKind: consumed.handoff?.restartKind ?? null,
          pid: consumed.handoff?.pid ?? pid ?? null,
          code: code ?? null,
          signal: signal ?? null,
        },
        correlationId,
      );
      // Unlike expectedExit (where the managed restart path relaunches), the
      // gateway deferred its OWN restart to us — relaunch promptly.
      await restartAfterCrash(correlationId);
      return;
    }
    if (consumed?.status === "rejected") {
      // Info only: a rejected row (pid-mismatch/expired) is not this exit's.
      console.log(
        `[watchdog] gateway restart handoff rejected (${consumed.reason || "unknown"}); classifying exit normally`,
      );
    }
    handleCrashExit({ code, signal, stderrTail, correlationId });
  };

  const handleConfigErrorExit = ({
    code,
    signal,
    stderrTail,
    correlationId,
  }) => {
    // Version skew usually shows up exactly here (a new build rejecting the
    // existing config). For a non-pin build still in its stabilization
    // window, roll back instead of latching — the latch would otherwise
    // silently defeat channel rollback (the exit never reaches crash
    // accounting).
    const configChannelInfo = channelRollbackEligible();
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
    void notifyOncePerIncident(
      "gateway_config_error",
      [
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix("🔴 Gateway configuration invalid"),
        "OpenClaw stopped with `EX_CONFIG`; automatic restart is paused.",
      ].join("\n"),
      correlationId,
      "config_error",
    );
  };

  const handleCrashExit = ({ code, signal, stderrTail, correlationId }) => {
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
              ? "🔴 Crash loop detected, auto-repairing..."
              : "🔴 Crash loop detected",
          ),
          `Crashes: ${state.crashTimestamps.length} in the last ${Math.floor(kWatchdogCrashLoopWindowMs / 1000)}s`,
          `Last exit code: ${code ?? "unknown"}`,
          ...(state.autoRepair
            ? []
            : ["Auto-restart paused; manual action required."]),
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

  const onGatewayExit = ({
    code,
    signal,
    expectedExit = false,
    stderrTail = [],
    pid = null,
    launchedAt = null,
  } = {}) => {
    // A stopped watchdog (shutdown drain, deliberate stop) must not react to
    // the gateway exit it caused — re-arming health probes or logging restart
    // events mid-drain. Boot-time crashes are unaffected: stopRequested is
    // only ever set by stop().
    if (state.stopRequested) return;
    // Every exit supersedes any pending async classification from an earlier
    // exit; the token captured here guards this exit's own deferrals.
    const probeToken = advancePendingExitProbeToken();
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
    // A clean exit AlphaClaw did NOT initiate: under external supervision
    // (2026.8.1+, supervisorMode gate open) this can be the gateway's own
    // restart request — the handoff row proves it. Only this gated case goes
    // async; with the gate closed the crash classification below stays
    // synchronous and the consume CLI is never spawned.
    if (code === 0 && supervisorModeActive()) {
      void resolveSupervisedCleanExit({
        code,
        signal,
        stderrTail,
        pid: pid ?? state.gatewayPid,
        correlationId,
        probeToken,
      });
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

    if (code === kOpenclawConfigErrorExitCode) {
      // 2026.8.1 overloads exit 78: a healthy-incumbent step-aside must not
      // latch or roll back. Signature + startup window match here; the third
      // signal (healthy incumbent probe) resolves asynchronously — any signal
      // missing keeps the synchronous config-error flow below. A requested
      // rollback always wins (rollback owns recovery), so the probe is not
      // even started once the rollback latch is set.
      if (
        !state.channelRollbackRequested &&
        isHealthyIncumbentStepAsideExit({ code, stderrTail }) &&
        withinStepAsideStartupWindow(launchedAt)
      ) {
        void resolveStepAsideExit({
          code,
          signal,
          stderrTail,
          correlationId,
          probeToken,
        });
        return;
      }
      handleConfigErrorExit({ code, signal, stderrTail, correlationId });
      return;
    }

    handleCrashExit({ code, signal, stderrTail, correlationId });
  };

  const onGatewayLaunch = ({ startedAt = Date.now(), pid = null } = {}) => {
    advancePendingExitProbeToken();
    clearDegradedHealthCheckTimer();
    state.configurationErrorActive = false;
    state.lifecycle = "running";
    state.health = "unknown";
    state.startupConsecutiveHealthFailures = 0;
    state.crashRecoveryActive = false;
    clearExpectedRestartWindow();
    state.uptimeStartedAt = startedAt;
    state.gatewayStartedAt = startedAt;
    state.gatewayPid = pid;
    startBootstrapHealthChecks();
  };

  const onExpectedRestart = () => {
    advancePendingExitProbeToken();
    clearDegradedHealthCheckTimer();
    clearSafeModeState();
    state.lifecycle = "restarting";
    state.health = "unknown";
    state.uptimeStartedAt = null;
    state.startupConsecutiveHealthFailures = 0;
    state.crashRecoveryActive = false;
    markExpectedRestartWindow();
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

  const start = () => {
    if (healthTimer || bootstrapHealthTimer) return;
    advancePendingExitProbeToken();
    clearDegradedHealthCheckTimer();
    state.stopRequested = false;
    state.lifecycle = "running";
    state.health = "unknown";
    state.startupConsecutiveHealthFailures = 0;
    state.gatewayStartedAt = Date.now();
    startBootstrapHealthChecks();
  };

  const stop = () => {
    state.stopRequested = true;
    advancePendingExitProbeToken();
    clearDegradedHealthCheckTimer();
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
    return {
      lifecycle: state.lifecycle,
      health: state.health,
      uptimeMs: state.uptimeStartedAt ? Date.now() - state.uptimeStartedAt : 0,
      uptimeStartedAt: state.uptimeStartedAt
        ? new Date(state.uptimeStartedAt).toISOString()
        : null,
      lastHealthCheckAt: state.lastHealthCheckAt,
      repairAttempts: state.repairAttempts,
      autoRepair: state.autoRepair,
      crashCountInWindow: state.crashTimestamps.length,
      crashLoopThreshold: kWatchdogCrashLoopThreshold,
      crashLoopWindowMs: kWatchdogCrashLoopWindowMs,
      operationInProgress: state.operationInProgress,
      gatewayPid: state.gatewayPid,
      safeMode: state.safeMode,
      suppressedChannels: [...state.suppressedChannels],
      degradedSince: state.degradedSince
        ? new Date(state.degradedSince).toISOString()
        : null,
    };
  };

  return {
    getStatus,
    getSettings,
    updateSettings,
    triggerRepair,
    resumeChannels,
    onExpectedRestart,
    onGatewayExit,
    onGatewayLaunch,
    beginManagedOperation,
    endManagedOperation,
    latchManualIntervention,
    // exported for tests
    probeGatewayHealth,
    probeGatewayReadiness,
    start,
    stop,
  };
};

module.exports = { createWatchdog };
