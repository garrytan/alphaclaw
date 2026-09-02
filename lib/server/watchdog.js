const fs = require("fs");
const path = require("path");
const {
  kWatchdogCheckIntervalMs,
  kGatewayTcpWatchIntervalMs,
  kWatchdogConnectedHealthCadenceMs,
  kGatewayTcpTransitionDebounceMs,
  kWatchdogDegradedCheckIntervalMs,
  kWatchdogDegradedCheckMaxIntervalMs,
  kWatchdogStartupFailureThreshold,
  kWatchdogMaxRepairAttempts,
  kWatchdogCrashLoopWindowMs,
  kWatchdogCrashLoopThreshold,
  kOpenclawDegradedRollbackMs,
  kOpenclawStabilizationWindowMs,
  kGatewayLifecycleLeaseMs,
  kGatewayRestartOperationBudgetMs,
  kOpenclawManagedDir,
  OPENCLAW_DIR,
} = require("./constants");
const { isSupervisorModeActive } = require("./gateway");
const { consumeRestartHandoff } = require("./gateway-restart-handoff");
// Memory fast-leak profile bounds/defaults — ONE owner (alphaclaw-config);
// the watchdog re-clamps only to guard an injected/legacy settings shape.
const {
  kWatchdogMemoryBounds,
  kDefaultAlphaclawConfig,
} = require("./alphaclaw-config");
const { resolveOpenclawConfigPath } = require("./openclaw-config");
const { deriveWatchdogPhase } = require("./watchdog-phase");
const {
  createGatewayMemoryMonitor,
  buildIdleMemoryTrendSnapshot,
} = require("./gateway-memory-monitor");

const kHealthStartupGraceMs = 30 * 1000;
const kBootstrapHealthCheckMs = 5 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// OpenClaw 2026.8 adds a 30s control-plane restart cooldown: a restart requested
// during the cooldown is SCHEDULED after it expires, not rejected, so a restart can
// land up to ~30s late. Widen the health-suppression window past that so a
// cooldown-delayed restart is never misread as a failed one (the restart ready
// budget is far larger still — env-tunable, 300s default). Was 15s.
const kExpectedRestartWindowMs = 50 * 1000;
const kGatewayHealthTimeoutMs = 5 * 1000;
// Degraded-retry backoff exponent guard: 2s floor × 2^8 = 512s already exceeds
// the 120s cap ceiling, so the clamp never changes a real delay — it only keeps
// 2**n from reaching Infinity on very long episodes.
const kDegradedRetryMaxExponent = 8;
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
// Accepted-handoff relaunch brake: an accepted restart handoff is an
// expected restart (no crash accounting, prompt relaunch), so a 2026.8.1
// gateway stuck in a restart-request loop — every boot writes a handoff row
// and exits 0 — would relaunch promptly FOREVER with the crash-loop brake
// bypassed and no notification. Cap accepted-handoff relaunches per window;
// past the cap the exit takes the normal crash flow (accounting, backoff,
// crash-loop notification).
const kWatchdogHandoffRelaunchWindowMs = 60 * 60 * 1000;
const kWatchdogHandoffMaxRelaunchesPerWindow = 5;
// Gateway memory monitor: one RSS sample per minute feeds the pure trend
// detector (gateway-memory-monitor.js). Mitigation policy (all of it lives
// HERE — the detector never restarts anything): critical held ≥2 evals,
// opt-in via watchdog.memory.autoRestart, braked to watchdog.memory.
// maxRestartsPerDay restarts per rolling 24h (default 2) spaced at least
// min(6h, 24h / (2 × maxRestartsPerDay)) apart — so the default keeps the
// original 2/24h, ≥6h posture and a diagnosed fast leak (issue #56: ~10
// MB/min, critical every few hours) can be given a larger budget without
// disabling the brake. The brake is PERSISTED (fast-pressure path can
// re-latch minutes after a parent restart; an in-memory brake would reset).
const kWatchdogMemorySampleIntervalMs = 60 * 1000;
const kMemoryMitigationCriticalEvals = 2;
const kMemoryMitigationWindowMs = 24 * 60 * 60 * 1000;
const kMemoryMitigationDefaultMaxPerWindow =
  kDefaultAlphaclawConfig.watchdog.memory.maxRestartsPerDay;
const kMemoryMitigationMaxIntervalMs = 6 * 60 * 60 * 1000;
const kMb = 1024 * 1024;
// Brake shape for a given per-day budget (pure; exported below for tests).
const resolveMemoryMitigationBrake = (maxRestartsPerDay) => {
  const maxPerWindow =
    Number.isInteger(maxRestartsPerDay) &&
    maxRestartsPerDay >= kWatchdogMemoryBounds.maxRestartsPerDay.min &&
    maxRestartsPerDay <= kWatchdogMemoryBounds.maxRestartsPerDay.max
      ? maxRestartsPerDay
      : kMemoryMitigationDefaultMaxPerWindow;
  return {
    maxPerWindow,
    minIntervalMs: Math.min(
      kMemoryMitigationMaxIntervalMs,
      Math.floor(kMemoryMitigationWindowMs / (2 * maxPerWindow)),
    ),
  };
};
// Operator RSS budget (MB) → bytes for the detector's cap; null = derived cap.
const resolveMemoryBudgetBytes = (budgetMb) =>
  Number.isFinite(budgetMb) && budgetMb > 0 ? budgetMb * kMb : null;
// A FAILED restart never consumes the maxRestartsPerDay success budget (that would let
// two transient spawn failures disable protection for a day while RSS keeps
// climbing) — it gets this shorter anti-thrash cooldown instead.
const kMemoryMitigationFailureCooldownMs = 15 * 60 * 1000;
const kMemoryMitigationStateFileName = "memory-mitigation-state.json";
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

const {
  isNotificationsDisabled,
  isVerboseEnabled,
} = require("./notification-policy");

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
// Tailscale :443 exit-78 use different wording and must keep latching (and,
// with the startup medic enabled, a false-positive here would cost a medic
// run + notification against a healthy incumbent).
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
  // Rate-limit-aware variant for gateway control-plane bursts (e.g. resuming many
  // suppressed channels). Defaults to clawCmd so existing callers/tests are unchanged.
  clawCmdWithRetry = clawCmd,
  // Advisory doctor output for the readiness-degraded transition hint:
  // usable doctor JSON or null (the shared single-flight collector — never
  // raw stderr, never a crashed CLI's noise). Defaults to a clawCmd-backed
  // shim so existing tests keep driving it through clawCmdImpl.
  collectAdvisoryDoctorJson = null,
  launchGatewayProcess,
  probeGatewayTcp = null,
  gatewayLifecycleLock = null,
  insertWatchdogEvent,
  notifier,
  readEnvFile,
  writeEnvFile,
  // Locked read-modify-write over the env file (lib/server/env.js
  // updateEnvFile). Optional: tests that stub readEnvFile/writeEnvFile get an
  // unlocked fallback with identical semantics; production wiring passes the
  // real one so two concurrent per-field settings PUTs can't lose an update.
  updateEnvFile = null,
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
  // Read-only consult (claude-code-local): a one-line rescue-session link
  // appended to incident-class notifications when the session is already
  // running. Never blocks or throws into the notify path; the dedup seam
  // (sentIncidentNotifications) is untouched.
  getRescueSessionLine = null,
  // One medic run must finish well inside the lifecycle-lock lease (the run
  // is followed by a relaunch under the same hold). Injectable for tests.
  medicRunBudgetMs = kGatewayLifecycleLeaseMs - 2 * 60 * 1000,
  // Restart-handoff consume (both injectable for tests). The default gate
  // mirrors the supervisor-mode env the gateway child gets (default ON with
  // an off|none escape hatch — see openclaw-runtime-env.js): an
  // escape-hatched gateway writes no handoff rows, so the consume CLI is
  // never spawned for it.
  supervisorModeActive = isSupervisorModeActive,
  consumeRestartHandoffImpl = consumeRestartHandoff,
  // Regenerates SKILL.md/TOOLS.md so a live container resize reaches the
  // agent's prompt artifacts without waiting for the next boot. Optional.
  doSyncPromptFiles = null,
  // How long an exit-78 medic queues behind a live lifecycle holder before
  // latching (issue #20: the boot lock made the medic skip entirely and the
  // box crash-looped; boots/restarts release within seconds). Injectable.
  medicLockWaitMs = 60_000,
  // openclaw.json mtime read for the EX_CONFIG latch auto-retry (issue #21
  // bug 9): null = file missing/unreadable, treated as "unchanged".
  readConfigMtimeMs = () => {
    try {
      return fs.statSync(
        resolveOpenclawConfigPath({ openclawDir: OPENCLAW_DIR }),
      ).mtimeMs;
    } catch {
      return null;
    }
  },
  // Gateway memory monitor (RSS trend detection + opt-in pre-OOM mitigation).
  // Everything injectable for tests; the null defaults lazily compose the
  // real readers (system-resources / machine-profile / autotune / config).
  readMemorySample = null,
  memorySampleIntervalMs = kWatchdogMemorySampleIntervalMs,
  readMemorySettings = null,
  memoryMonitorConfig = undefined,
  // Reload-wrapped restartGateway from lib/server.js. NO restart primitive
  // self-locks (serialization is caller-owned, routes/system.js pattern) —
  // the watchdog tryAcquires the lifecycle lock before calling this.
  restartGatewayForMitigation = null,
  // Server-level restart interlocks the manual-restart route also honors
  // (channel apply in progress, reconciler gateway hold). Returns a reason
  // string when a mitigation restart must not fire, null when clear.
  isMitigationRestartBlocked = null,
  memoryMitigationStatePath = null,
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
    // No notifications mirror: notification-policy.js reads the env live
    // (reloadEnv keeps it fresh) — a state copy is a second, divergeable
    // authority for the same toggle.
    operationInProgress: false,
    gatewayStartedAt: null,
    gatewayPid: null,
    lastExitedGatewayPid: null,
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
    // EX_CONFIG auto-retry baselines (issue #21 bug 9): openclaw.json's mtime
    // when the latch was set, and the last mtime a retry already fired for —
    // together they bound the retry to exactly once per distinct config edit.
    configErrorConfigMtimeMs: null,
    configRetryLastMtimeMs: null,
    // Medic runs per EX_CONFIG incident: attempt 2 only happens when a fix
    // relaunched the gateway and it exited 78 again; reset on a real launch.
    medicAttempts: 0,
    // Rolling window of actual medic run start times (cross-incident brake).
    medicRunTimestamps: [],
    // Rolling window of accepted-handoff relaunch times (restart-request
    // loop brake — see resolveSupervisedCleanExit). Like medicRunTimestamps,
    // deliberately NOT reset on launch: each loop iteration is a real launch.
    handoffRelaunchTimestamps: [],
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
    // True while an exit classification is resolving ASYNCHRONOUSLY (exit-78
    // step-aside probe, restart-handoff consume): lifecycle/health still show
    // the pre-exit state during that window, so readiness gates must not
    // dispatch against them. Cleared on settle and by any newer lifecycle
    // event (advancePendingExitProbeToken).
    pendingExitClassification: false,
  };
  let healthTimer = null;
  let bootstrapHealthTimer = null;
  let degradedHealthTimer = null;
  // Degraded-retry backoff (state machine above scheduleDegradedHealthCheck).
  // `attempt` = COMPLETED retries this episode, so the armed timer's delay is
  // always f(attempt); `delayMs`/`dueAtMs` describe that armed timer.
  let degradedRetryAttempt = 0;
  let degradedRetryDelayMs = null;
  let degradedRetryDueAtMs = null;
  let degradedRetryInFlight = false;
  // Bumped by runHealthCheck iff it actually probes (beside the
  // lastHealthCheckAtMs stamp). The degraded-retry tick compares it before
  // and after to tell a skipped tick from a real probe — a monotonic count,
  // unlike the timestamp, cannot collide when two probes land in one ms.
  let healthProbeSeq = 0;
  let tcpWatchTimer = null;
  let tcpTransitionDebounceTimer = null;
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
    // The newer event owns state: a still-pending classification from an
    // older exit is moot (its resolver will observe a stale token).
    state.pendingExitClassification = false;
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
  // Forward recovery (issue #21 bug 10): the PIN itself cannot boot —
  // rollbackEligibleFrom() excluded it — usually because a one-way migration
  // already moved the state past it. Last resort before the latch: ask the
  // channel layer to move FORWARD to the blocklisted newer build that owns
  // the migrated state (one-shot, persisted; a restart is already scheduled
  // when it returns ok).
  const tryForwardRecovery = ({ exitCode = null, correlationId } = {}) => {
    try {
      if (!releaseChannelHooks?.requestForwardRecovery) return false;
      const info = channelInfo();
      if (!info?.isPin) return false;
      const result =
        releaseChannelHooks.requestForwardRecovery({ exitCode }) || null;
      logEvent(
        "forward_recovery",
        "exit_event",
        result?.ok ? "requested" : "skipped",
        {
          exitCode: exitCode ?? null,
          ...(result?.ok ? {} : { code: result?.code || null }),
        },
        correlationId,
      );
      if (result?.ok) {
        state.configurationErrorActive = false;
        state.lifecycle = "restarting";
        state.health = "unknown";
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };
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
  // Single home for setting the EX_CONFIG latch (issue #21 bug 9): every
  // latch site records openclaw.json's current mtime as the auto-retry
  // baseline, so a later config edit — by an operator, the medic, or a boot
  // restore — re-arms exactly one relaunch attempt. Deliberately NOT
  // persisted: a process restart relaunches the gateway anyway, and a
  // still-broken config re-latches within seconds, while a persisted latch
  // could block a fixed gateway after restart.
  const latchConfigError = () => {
    state.configurationErrorActive = true;
    state.lifecycle = "configuration_error";
    state.health = "unhealthy";
    try {
      state.configErrorConfigMtimeMs = readConfigMtimeMs();
    } catch {
      state.configErrorConfigMtimeMs = null;
    }
  };
  // Used by the release-channel system when a rollback marker cannot be
  // written (e.g. disk full): restarting without a marker would re-apply the
  // broken build in a loop, so pause automatic restarts instead.
  const latchManualIntervention = () => {
    latchConfigError();
  };
  // EX_CONFIG auto-retry (issue #21 bug 9): while latched, the health timer
  // keeps ticking but bails — instead of bailing blind, watch openclaw.json's
  // mtime. A distinct new mtime (operator edit, medic fix, boot restore)
  // clears the latch and relaunches ONCE; another exit 78 re-latches with the
  // new baseline, so this can never loop. A missing file reads as null =
  // "unchanged" until it reappears with a fresh mtime.
  const maybeRetryAfterConfigChange = () => {
    if (!state.configurationErrorActive) return false;
    if (state.operationInProgress) return false;
    // A reconciler gateway hold outranks the mtime auto-retry: the reconcile
    // flow itself edits openclaw.json (strips, doctor), and a blind relaunch
    // would race the doctor run the hold exists to protect. Recovery from a
    // hold goes through reconcile-retry, which validates before launching.
    // Fail CLOSED on the hold read itself — channelInfo() maps a read ERROR
    // to null, indistinguishable from "no hold", so a transient state-file
    // read error on the 2s tick plus a changed mtime would re-arm a blind
    // relaunch of the exact config the hold rejected. An error skips the
    // retry this tick; the next tick re-checks.
    if (typeof releaseChannelHooks?.getInfo === "function") {
      let holdInfo = null;
      try {
        holdInfo = releaseChannelHooks.getInfo() || null;
      } catch {
        return false;
      }
      if (holdInfo?.gatewayHold) return false;
    }
    let mtime = null;
    try {
      mtime = readConfigMtimeMs();
    } catch {
      return false;
    }
    if (mtime == null) return false;
    if (
      state.configErrorConfigMtimeMs != null &&
      mtime === state.configErrorConfigMtimeMs
    ) {
      return false;
    }
    if (
      state.configRetryLastMtimeMs != null &&
      mtime === state.configRetryLastMtimeMs
    ) {
      return false;
    }
    state.configRetryLastMtimeMs = mtime;
    state.configurationErrorActive = false;
    state.lifecycle = "restarting";
    state.health = "unknown";
    logEvent("config_error", "config_changed", "retry", { mtimeMs: mtime });
    // Informational: the outcome notifies either way (running-again or a
    // fresh config-error latch). The outbox id is keyed to the LATCH episode
    // (the mtime captured when the error latched), not the edit — an
    // operator's editor autosaving during one latch produces one notice, not
    // one per save (adversarial review F3).
    void notify(
      [
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix(
          "🟡 Config change detected — retrying gateway start",
        ),
      ].join("\n"),
      "",
      "recovery",
      {
        verbose: true,
        id: `config-retry-${state.configErrorConfigMtimeMs ?? "unlatched"}`,
      },
    );
    void (async () => {
      try {
        const child = await launchGatewayProcess();
        if (!child) latchConfigError();
      } catch {
        latchConfigError();
      }
    })();
    return true;
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

  const computeDegradedRetryDelayMs = () =>
    Math.min(
      kWatchdogDegradedCheckIntervalMs *
        2 ** Math.min(degradedRetryAttempt, kDegradedRetryMaxExponent),
      kWatchdogDegradedCheckMaxIntervalMs,
    );

  // The one predicate for "the degraded-retry loop may arm (or keep) a
  // timer": degraded, running, and not under the config-error latch. Used by
  // scheduleDegradedHealthCheck's guard, the tick's stale-fire and re-arm
  // checks, and the degrade site's "will a retry be pending" promise.
  const canArmDegradedRetry = () =>
    state.health === "degraded" &&
    state.lifecycle === "running" &&
    !state.configurationErrorActive;

  // "The loop owns the cadence": a timer is armed OR a tick is mid-probe. The
  // two are distinct — another probe source (ok path, exit) can clear the
  // handle under an in-flight tick, and that tick still owns the cadence
  // until it settles.
  const isDegradedRetryLoopActive = () =>
    !!degradedHealthTimer || degradedRetryInFlight;

  // What a failed-probe row promises as "next retry in Ns". Inside the loop's
  // own tick the counter was already bumped at fire, so f(attempt) is the
  // delay the callback re-arms next. From any other source (a fresh
  // degradation, or a tcp_transition / health_timer failure landing while a
  // timer is armed) the pending retry is the armed timer, so report its
  // REMAINING time — on a fresh degradation that is exactly the delay just
  // armed.
  const nextDegradedRetryDelayMs = () =>
    degradedRetryInFlight
      ? computeDegradedRetryDelayMs()
      : Math.max(0, (degradedRetryDueAtMs ?? Date.now()) - Date.now());

  // Does NOT touch degradedRetryInFlight — the retry callback's finally owns it.
  const resetDegradedRetryBackoff = () => {
    degradedRetryAttempt = 0;
    degradedRetryDelayMs = null;
    degradedRetryDueAtMs = null;
  };

  const clearDegradedHealthCheckTimer = ({ resetBackoff = true } = {}) => {
    // Reset BEFORE the handle guard: mid-tick the ok path has already nulled
    // the handle while the counter still stands, and a clear landing there
    // (restart, exit, stop) must still end the episode.
    if (resetBackoff) resetDegradedRetryBackoff();
    if (!degradedHealthTimer) return;
    clearTimeout(degradedHealthTimer);
    degradedHealthTimer = null;
  };

  // Degraded-retry loop — one episode of exponential backoff:
  //
  //   healthy ──probe fails──▶ degraded   attempt=0, arm f(0)=5s
  //                              │ fires → attempt=1 → probe → still degraded → arm f(1)=10s
  //                              │ fires → attempt=2 → probe → arm f(2)=20s
  //                              │ fires → attempt=3 → probe → arm f(3)=30s   (cap)
  //                              └ fires → attempt=4 → probe → arm 30s …      (holds at cap)
  //
  //   f(n) = min(kWatchdogDegradedCheckIntervalMs · 2^min(n, kDegradedRetryMaxExponent),
  //              kWatchdogDegradedCheckMaxIntervalMs)   (the exponent guard never moves a
  //              real delay — 2s · 2^8 already clears the 120s cap ceiling)
  //
  //   Exits and resets:
  //     recovery         probe ok → clear({ resetBackoff: false }) → evaluateChannelSuppression
  //                      (green /health + failing /readyz re-degrades and re-arms f(attempt) in
  //                      the SAME tick, keeping the counter) → reset only if still healthy
  //     launch / expected restart / gateway exit / start() / stop()
  //                      clearDegradedHealthCheckTimer() → clear + reset
  //     stale fire       callback wakes with health ≠ degraded or lifecycle ≠ running (repair
  //                      failure → "unhealthy", config medic → "unknown"): no probe, handle
  //                      nulled, reset. Re-degrading BEFORE the stale fire continues the armed
  //                      timer and its counter — same incident.
  //     skipped tick     runHealthCheck returned before probing (operation in progress, pending
  //                      exit classification, config latch): not a retry, so the fire-time
  //                      increment is undone and f(attempt) re-arms unchanged.
  //
  //   The handle stays non-null through a FAILING tick; a recovering tick (ok path) or an
  //   exit/restart from another source can null it mid-probe, which is why isDegradedRetryLoopActive
  //   also reads degradedRetryInFlight. That (handle OR in-flight) is what startTcpWatcher's
  //   fast_cadence gate and getStatus().degradedRetry read as "the loop owns the cadence".
  const scheduleDegradedHealthCheck = () => {
    if (degradedHealthTimer) return;
    if (!canArmDegradedRetry()) return;
    const delayMs = computeDegradedRetryDelayMs();
    degradedRetryDelayMs = delayMs;
    degradedRetryDueAtMs = Date.now() + delayMs;
    degradedHealthTimer = setTimeout(async () => {
      // Hold the handle through the tick: it doubles as "the degraded loop
      // owns the cadence" for the fast_cadence gate and for getStatus, and a
      // tick can run tens of seconds (the readiness path awaits /readyz and,
      // once per transition, an advisory doctor --json) — nulling before the
      // await would open a hole. The finally compares against THIS handle:
      // a mid-tick clear + re-arm from another probe source (a tcp_transition
      // recovery followed by this probe's own failure result) legitimately
      // arms a NEW timer whose handle must not be wiped.
      const armedHandle = degradedHealthTimer;
      if (!canArmDegradedRetry()) {
        degradedHealthTimer = null;
        resetDegradedRetryBackoff();
        return;
      }
      degradedRetryAttempt += 1;
      degradedRetryInFlight = true;
      // runHealthCheck bumps healthProbeSeq iff it actually probes — its
      // early returns (config-error latch, pending exit classification, an
      // operation in progress) all come before the bump. A tick that never
      // probed is not a retry: the finally un-counts it, so a long repair
      // cannot walk the counter to the cap without a single probe. The
      // increment stays at fire time so the degrade-site row inside a REAL
      // tick still sees f(attempt). A monotonic count (not the
      // lastHealthCheckAtMs timestamp) so two probes landing in the same
      // millisecond cannot be mistaken for a skipped tick.
      const seqBefore = healthProbeSeq;
      try {
        await runHealthCheck({
          source: "degraded_retry",
          allowAutoRepair: false,
        });
      } catch (err) {
        // A throw anywhere inside the probe must not skip the re-arm below —
        // an unhandled rejection here would silently end the loop.
        console.error(
          `[watchdog] degraded retry probe threw: ${err?.message || err}`,
        );
      } finally {
        degradedRetryInFlight = false;
        if (healthProbeSeq === seqBefore && degradedRetryAttempt > 0) {
          degradedRetryAttempt -= 1;
        }
        if (degradedHealthTimer === armedHandle) degradedHealthTimer = null;
      }
      if (canArmDegradedRetry()) {
        scheduleDegradedHealthCheck();
      }
    }, delayMs);
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

  // Live container resize (platform vertical scaling, no reboot): the health
  // tick piggybacks a cheap capacity re-read — machine-profile compares two
  // cgroup values, never the watchdog reading files itself. On a change the
  // profile refreshes, non-restart knobs re-apply, and the operator is told
  // which restart finishes the job. tryAcquire skip-if-busy: a retune must
  // never queue behind (or deadlock with) a running lifecycle operation — the
  // next tick retries.
  let resizeCheckInFlight = false;
  // Two-tick debounce ON THE VALUE, not a boolean: a transient cgroup read
  // failure (EMFILE under load) reads as a capacity change; two DIFFERENT
  // transient misreads must not confirm each other. The confirming tick has
  // to observe the SAME changed capacity the arming tick pinned — and a
  // degraded read (cgroup limit was readable, now isn't) never arms at all.
  let pendingResizeCapacity = null;
  const checkContainerResize = async () => {
    if (resizeCheckInFlight) return;
    try {
      const {
        getMachineProfile,
        readCurrentCapacity,
        capacityOf,
        sameCapacity,
      } = require("./machine-profile");
      const profile = getMachineProfile();
      const fresh = readCurrentCapacity();
      if (fresh.degraded && profile?.memory?.source !== "host") {
        // The memoized limit is cgroup-sourced but this read fell back to
        // host values — a transient failure, not a resize.
        pendingResizeCapacity = null;
        return;
      }
      if (sameCapacity(fresh, capacityOf(profile))) {
        pendingResizeCapacity = null;
        return;
      }
      if (
        !pendingResizeCapacity ||
        !sameCapacity(fresh, pendingResizeCapacity)
      ) {
        pendingResizeCapacity = fresh; // arm (or re-arm on a different reading)
        return;
      }
      pendingResizeCapacity = null;
    } catch {
      return;
    }
    resizeCheckInFlight = true;
    const releaseLifecycleLock = gatewayLifecycleLock
      ? gatewayLifecycleLock.tryAcquire("autotune_resize")
      : null;
    if (gatewayLifecycleLock && !releaseLifecycleLock) {
      resizeCheckInFlight = false;
      return;
    }
    try {
      const { applyResourceAutotune } = require("./autotune");
      await applyResourceAutotune({
        trigger: "resize",
        refreshProfile: true,
        deps: {
          emitWatchdogEvent: ({ eventType = "autotune", message } = {}) =>
            logEvent(eventType, "autotune", "info", { message }),
          notify: (message, opts) => void notify(message, "", "autotune", opts),
          markRestartRequired: (reason) => {
            try {
              const {
                writeRestartRequiredFlag,
              } = require("./restart-required-flag");
              writeRestartRequiredFlag({ reason, source: "autotune" });
            } catch {}
          },
          syncPromptFiles: doSyncPromptFiles || null,
        },
      });
    } catch (err) {
      console.error(`[watchdog] autotune resize retune failed: ${err.message}`);
    } finally {
      releaseLifecycleLock?.();
      resizeCheckInFlight = false;
    }
  };

  // ---------------------------------------------------------------------
  // Gateway memory monitor — RSS trend detection + opt-in pre-OOM mitigation.
  //
  //   60s tick ──▶ settings (fail-closed fallback: read error forces
  //      │         autoRestart OFF, detection keeps last state)
  //      │  disabled → idle "disabled" snapshot   no pid → "no_gateway"
  //      ▼
  //   readMemorySample(pid) ──▶ monitor.addSample ──▶ monitor.evaluate
  //      │      transitions: latched / escalated_critical / cleared
  //      ▼      (events + per-episode notification dedupe live HERE —
  //   mitigation gate            the detector stays pure)
  //      ├─ !effectiveAutoRestart or criticalEvalStreak < 2 ──▶ done
  //      ├─ stabilization window (rollback owns recovery) ──▶ skip
  //      ├─ managed op / safe mode / crash recovery / expected restart ─▶ skip
  //      ├─ persisted rate brake (maxRestartsPerDay per 24h, spaced) ─▶ skip + one notice
  //      ├─ gatewayLifecycleLock.tryAcquire skip-if-busy ─▶ retry next tick
  //      ▼
  //   onExpectedRestart ─▶ restartGatewayForMitigation() ─▶ settle in FINALLY
  //   (a failed restart settles the window immediately — the settle probe
  //   and normal crash machinery own recovery, never hidden as "expected")
  // ---------------------------------------------------------------------
  const memoryMonitor = createGatewayMemoryMonitor({
    config: memoryMonitorConfig,
  });
  let memoryTimer = null;
  let memoryTickInFlight = false;
  let memoryIdleState = null; // "disabled" | "no_gateway" | null (monitor owns)
  let memoryTrendStateSeen = null;
  let memoryTrendSinceMs = null;
  let memoryLastGoodSettings = {
    enabled: true,
    autoRestart: false,
    effectiveAutoRestart: false,
    budgetMb: null,
    maxRestartsPerDay: kMemoryMitigationDefaultMaxPerWindow,
  };
  // What the last tick ACTUALLY enforced (includes the fail-closed override
  // on a broken settings read) — the status surface must never claim an
  // auto-restart that the enforcement path would refuse.
  let memoryEffectiveSettings = { ...memoryLastGoodSettings };
  // Per-episode notification dedupe (`${episodeId}:${kind}`), watchdog-owned:
  // notifyOncePerIncident's set resets on unrelated incident cycles and would
  // re-notify a live episode. Entries are dropped when their episode clears.
  const memoryNotifiedKeys = new Set();
  let memoryMitigationTimestamps = null; // lazy-loaded from the persisted brake
  let memoryMitigationLastFailureAtMs = 0; // in-memory anti-thrash cooldown
  // The memory tick's OWN pid tracking, nulled on a monitored exit: the OS
  // can reuse a pid before relaunch, and a foreign process's RSS must never
  // blend into the gateway's trend. Deliberately separate from
  // state.gatewayPid, which status/supervision surfaces keep across the
  // crash-relaunch window (an AlphaClaw-relaunched gateway is not "detached").
  let memoryMonitoredPid = null;

  const resolveMemoryMitigationStatePath = () =>
    memoryMitigationStatePath ||
    path.join(kOpenclawManagedDir, kMemoryMitigationStateFileName);

  const loadMemoryMitigationTimestamps = () => {
    if (memoryMitigationTimestamps) return memoryMitigationTimestamps;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(resolveMemoryMitigationStatePath(), "utf8"),
      );
      // Sanitize, don't trust: the min-interval check reads the LAST entry,
      // so unsorted stamps under-brake; a future-dated stamp (clock rollback,
      // hand-edited file) would brake forever. Finite, not-future, sorted.
      const nowMs = Date.now();
      memoryMitigationTimestamps = Array.isArray(parsed?.restarts)
        ? parsed.restarts
            .filter((t) => Number.isFinite(t) && t <= nowMs)
            .sort((a, b) => a - b)
        : [];
    } catch {
      memoryMitigationTimestamps = [];
    }
    return memoryMitigationTimestamps;
  };

  // Ledger pattern: the in-memory copy keeps serving if the disk write fails.
  // Atomic (tmp + rename): the brake is enforcement state — a crash mid-write
  // must never leave a truncated file that parses as "no history" and
  // re-opens the 2-per-24h budget.
  const persistMemoryMitigationTimestamps = () => {
    try {
      const statePath = resolveMemoryMitigationStatePath();
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmpPath = `${statePath}.tmp`;
      fs.writeFileSync(
        tmpPath,
        `${JSON.stringify({ restarts: memoryMitigationTimestamps })}\n`,
      );
      fs.renameSync(tmpPath, statePath);
    } catch {}
  };

  const readMemorySettingsSafe = () => {
    try {
      const settings = readMemorySettings
        ? readMemorySettings()
        : require("./alphaclaw-config").readWatchdogMemorySettings({
            openclawDir: OPENCLAW_DIR,
          });
      if (settings && typeof settings === "object") {
        memoryLastGoodSettings = {
          enabled: settings.enabled === true,
          autoRestart: settings.autoRestart === true,
          effectiveAutoRestart: settings.effectiveAutoRestart === true,
          // Fast-leak profile (issue #56); the config reader already bounds
          // both, this only guards an injected/legacy settings shape.
          budgetMb:
            Number.isFinite(settings.budgetMb) && settings.budgetMb > 0
              ? settings.budgetMb
              : null,
          maxRestartsPerDay: resolveMemoryMitigationBrake(
            settings.maxRestartsPerDay,
          ).maxPerWindow,
        };
        memoryEffectiveSettings = memoryLastGoodSettings;
        return memoryLastGoodSettings;
      }
    } catch {}
    // Fail closed on the enforcement half only: detection keeps its last
    // known state, autoRestart is forced off until a clean read.
    memoryEffectiveSettings = {
      ...memoryLastGoodSettings,
      autoRestart: false,
      effectiveAutoRestart: false,
    };
    return memoryEffectiveSettings;
  };

  const readMemorySampleSafe = (pid) => {
    try {
      if (typeof readMemorySample === "function") {
        return readMemorySample(pid) || {};
      }
      const { getProcessTreeUsage, parseCgroupMemory } = require("./system-resources");
      const { getMachineProfile } = require("./machine-profile");
      const { getActiveGatewayHeapMb } = require("./autotune");
      const cgroup = parseCgroupMemory();
      return {
        // Subtree, not just the launcher pid: OpenClaw's `gateway run` forks a
        // worker child that holds the real heap (the launcher stays flat), so
        // a launcher-only read would never see the leak.
        rssBytes: getProcessTreeUsage(pid)?.rssBytes ?? null,
        cgroupUsedBytes: cgroup?.usedBytes ?? null,
        containerLimitBytes: getMachineProfile()?.memory?.limitBytes ?? null,
        activeHeapMb: getActiveGatewayHeapMb(),
      };
    } catch {
      return {};
    }
  };

  // Cached-snapshot read for every consumer (resources payload, doctor
  // getter, incident close sample) — never recomputes. Idle states keep the
  // frozen lastEpisodeSummary visible (a post-crash close must still see the
  // episode that killed the predecessor).
  const getMemoryTrend = () => {
    if (memoryIdleState) {
      return {
        ...buildIdleMemoryTrendSnapshot(memoryIdleState),
        lastEpisodeSummary: memoryMonitor.getTrend().lastEpisodeSummary,
      };
    }
    return memoryMonitor.getTrend();
  };

  const noteMemoryTrendState = (nextState) => {
    if (nextState !== memoryTrendStateSeen) {
      memoryTrendStateSeen = nextState;
      memoryTrendSinceMs = Date.now();
    }
  };

  const notifyMemoryOncePerEpisode = async (
    episodeId,
    kind,
    message,
    correlationId,
  ) => {
    const key = `${episodeId || "none"}:${kind}`;
    if (memoryNotifiedKeys.has(key)) return;
    const result = await notify(message, correlationId, "memory");
    if (result?.ok || result?.skipped) memoryNotifiedKeys.add(key);
  };

  // ≥90 minutes reads better in hours (1 decimal); below that, minutes.
  const kMemoryEtaHoursThresholdMins = 90;
  const formatMemoryEta = (iso) => {
    const ts = Date.parse(String(iso || ""));
    if (!Number.isFinite(ts)) return "";
    const mins = Math.max(1, Math.round((ts - Date.now()) / 60000));
    if (mins < kMemoryEtaHoursThresholdMins) return `in ~${mins}m`;
    const hoursOneDecimal = Math.round((mins / 60) * 10) / 10;
    return `in ~${hoursOneDecimal}h`;
  };

  const buildMemoryStatsLine = ({ rssMb, effectiveCapMb, slopeMbPerHour }) => {
    const cap = effectiveCapMb ? ` of ${effectiveCapMb}MB effective cap` : "";
    const slope =
      slopeMbPerHour != null ? ` (+${slopeMbPerHour} MB/h)` : "";
    return `RSS: ${rssMb ?? "?"}MB${cap}${slope}`;
  };

  const handleMemoryTransitions = async (transitions, correlationId) => {
    for (const t of transitions) {
      // A shutdown drain mid-loop (each iteration awaits a notify) must not
      // keep emitting events/notifications for a watchdog that is stopping.
      if (state.stopRequested) return;
      if (t.type === "latched") {
        logEvent(
          "memory",
          "memory-monitor",
          "warning",
          {
            kind: "leak_suspected",
            via: t.via,
            episodeId: t.episodeId,
            rssMb: t.rssMb,
            slopeMbPerHour: t.slopeMbPerHour,
            effectiveCapMb: t.effectiveCapMb,
            capSource: t.capSource,
            projectedExhaustionAt: t.projectedExhaustionAt,
          },
          correlationId,
        );
        const eta = formatMemoryEta(t.projectedExhaustionAt);
        const headline = eta
          ? `🟡 Gateway memory rising steadily — projected to reach its limit ${eta}`
          : t.capSource === "none"
            ? "🟡 Gateway memory rising steadily (no memory cap known)"
            : "🟡 Gateway memory rising steadily";
        await notifyMemoryOncePerEpisode(
          t.episodeId,
          "latched",
          [
            "🐺 *AlphaClaw Watchdog*",
            withViewLogsSuffix(headline),
            "Trigger: `memory_leak`",
            buildMemoryStatsLine(t),
            "Run a Drift Doctor scan for a guided diagnosis — the finding card lands on the next scan.",
          ].join("\n"),
          correlationId,
        );
      } else if (t.type === "escalated_critical") {
        logEvent(
          "memory",
          "memory-monitor",
          "warning",
          {
            kind: "leak_critical",
            episodeId: t.episodeId,
            rssMb: t.rssMb,
            effectiveCapMb: t.effectiveCapMb,
            projectedExhaustionAt: t.projectedExhaustionAt,
          },
          correlationId,
        );
        const eta = formatMemoryEta(t.projectedExhaustionAt);
        // Heap-raise advice ONLY when the pressure is actually against the
        // heap-derived cap: for container-sourced pressure (co-residents,
        // plugin isolates, native memory) a bigger heap fixes nothing and
        // trades a V8 abort for a kernel OOM kill.
        const remedy =
          t.capSource === "heap"
            ? deriveHeapOomRemedy()
            : "Pressure is against the container limit — raising the gateway heap will not help. Reduce co-resident load or restart the gateway from the Watchdog tab.";
        await notifyMemoryOncePerEpisode(
          t.episodeId,
          "critical",
          [
            "🐺 *AlphaClaw Watchdog*",
            withViewLogsSuffix(
              `🔴 Gateway memory critical${eta ? ` — projected exhaustion ${eta}` : ""}`,
            ),
            "Trigger: `memory_leak`",
            buildMemoryStatsLine(t),
            remedy,
          ].join("\n"),
          correlationId,
        );
      } else if (t.type === "cleared") {
        logEvent(
          "memory",
          "memory-monitor",
          "info",
          {
            kind: "leak_cleared",
            episodeId: t.episodeId,
            durationMs: t.durationMs,
            peakRssMb: t.peakRssMb,
            mitigationCount: t.mitigationCount,
          },
          correlationId,
        );
        for (const key of [...memoryNotifiedKeys]) {
          if (key.startsWith(`${t.episodeId}:`)) memoryNotifiedKeys.delete(key);
        }
      }
    }
  };

  // Every veto the enforcement path honors, in ONE place: checked before the
  // brake AND re-checked after the awaited notify (red team: a shutdown
  // drain, safe-mode latch, fresh crash, or disarm PUT landing during that
  // multi-second window must still stop the restart).
  const memoryMitigationVetoReason = (settings) => {
    if (state.stopRequested) return "watchdog_stopping";
    if (!settings.effectiveAutoRestart) return "auto_restart_off";
    // Rollback owns recovery inside a stabilization window; a mitigation
    // restart would race it (same doctrine as doctor-fix suppression).
    if (memoizedRollbackEligible()) return "stabilization_window";
    if (
      state.managedOperationActive ||
      state.operationInProgress ||
      state.safeMode ||
      state.crashRecoveryActive ||
      state.expectedRestartInProgress
    ) {
      return "busy_state";
    }
    // Server-level interlocks the manual-restart route also 409s on
    // (channel apply mutating the same build/process, reconciler hold).
    try {
      const blocked = isMitigationRestartBlocked?.();
      if (blocked) return String(blocked);
    } catch {
      return "interlock_check_failed"; // fail closed on the enforcement half
    }
    return null;
  };

  const maybeRunMemoryMitigation = async (
    snapshot,
    settings,
    correlationId,
    { freshEvidence = true } = {},
  ) => {
    if (
      snapshot.state !== "critical" ||
      snapshot.criticalEvalStreak < kMemoryMitigationCriticalEvals
    ) {
      return;
    }
    if (typeof restartGatewayForMitigation !== "function") return;
    // A restart is evidence-backed or it doesn't happen: a held verdict from
    // a read-miss tick (detector doctrine: "a read-miss tick would otherwise
    // confirm itself") detects, but never enforces.
    if (!freshEvidence) return;
    if (memoryMitigationVetoReason(settings) !== null) return;
    const now = Date.now();
    if (
      memoryMitigationLastFailureAtMs &&
      now - memoryMitigationLastFailureAtMs < kMemoryMitigationFailureCooldownMs
    ) {
      return; // failed-restart anti-thrash cooldown, never the 24h budget
    }
    const stamps = loadMemoryMitigationTimestamps().filter(
      (t) => now - t < kMemoryMitigationWindowMs,
    );
    memoryMitigationTimestamps = stamps;
    const brake = resolveMemoryMitigationBrake(settings.maxRestartsPerDay);
    const braked =
      stamps.length >= brake.maxPerWindow ||
      (stamps.length > 0 &&
        now - stamps[stamps.length - 1] < brake.minIntervalMs);
    if (braked) {
      logEvent(
        "memory",
        "memory-monitor",
        "warning",
        {
          kind: "mitigation_skipped",
          reason: "rate_brake",
          episodeId: snapshot.episodeId,
          restartsInWindow: stamps.length,
          maxRestartsPerDay: brake.maxPerWindow,
          minIntervalMs: brake.minIntervalMs,
        },
        correlationId,
      );
      await notifyMemoryOncePerEpisode(
        snapshot.episodeId,
        "brake",
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix(
            "🔴 Gateway memory critical — auto-restart brake engaged",
          ),
          "Trigger: `memory_leak`",
          "Restarting again would only delay the next exhaustion — the leak needs a diagnosis. Run a Drift Doctor scan and use \"Ask agent to fix\".",
        ].join("\n"),
        correlationId,
      );
      return;
    }
    const releaseLifecycleLock = gatewayLifecycleLock
      ? gatewayLifecycleLock.tryAcquire("memory_mitigation", {
          // Restart-class hold: the full cold start (preflight + stop + the
          // configurable ready wait) must fit inside the lease, or a
          // force-release mid-restart lets a competing launch land.
          leaseMs: kGatewayRestartOperationBudgetMs,
        })
      : null;
    // Skip-if-busy, never queue: the next tick retries.
    if (gatewayLifecycleLock && !releaseLifecycleLock) return;
    const refundBrakeStamp = () => {
      memoryMitigationTimestamps = memoryMitigationTimestamps.filter(
        (t) => t !== now,
      );
      persistMemoryMitigationTimestamps();
    };
    // EVERYTHING after a successful acquire runs under this try/finally: a
    // throwing notifier or event sink between acquire and restart must never
    // leave the lifecycle lock held forever (it gates all gateway lifecycle
    // work). Settle is guarded — never clear an expected-restart window this
    // path didn't arm.
    let expectedRestartArmed = false;
    try {
      memoryMitigationTimestamps.push(now);
      persistMemoryMitigationTimestamps();
      logEvent(
        "memory",
        "memory-monitor",
        "warning",
        {
          kind: "mitigation_restart",
          episodeId: snapshot.episodeId,
          rssMb: snapshot.rssMb,
          effectiveCapMb: snapshot.effectiveCapMb,
        },
        correlationId,
      );
      await notifyMemoryOncePerEpisode(
        snapshot.episodeId,
        "mitigation",
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix(
            "🟡 Restarting gateway before it runs out of memory",
          ),
          "Trigger: `memory_leak`",
          buildMemoryStatsLine(snapshot),
        ].join("\n"),
        correlationId,
      );
      // TOCTOU re-check: the notify above can take seconds. Re-read the
      // gates (fresh settings read too — a disarm PUT counts) and refund the
      // brake stamp on veto: no restart happened, the budget wasn't spent.
      const freshSettings = readMemorySettingsSafe();
      const vetoReason = memoryMitigationVetoReason(freshSettings);
      if (vetoReason !== null) {
        refundBrakeStamp();
        // Refund the notification dedupe too: the message announced a
        // restart that never happened — the retry that restarts must notify.
        memoryNotifiedKeys.delete(
          `${snapshot.episodeId || "none"}:mitigation`,
        );
        logEvent(
          "memory",
          "memory-monitor",
          "warning",
          {
            kind: "mitigation_skipped",
            reason: vetoReason,
            episodeId: snapshot.episodeId,
          },
          correlationId,
        );
        return;
      }
      // Same TOCTOU window for the brake: an operator who LOWERED
      // maxRestartsPerDay during the notify await must not be honored one
      // restart late. Re-derive against the stamps that predate this attempt.
      const freshBrake = resolveMemoryMitigationBrake(
        freshSettings.maxRestartsPerDay,
      );
      const priorStamps = memoryMitigationTimestamps.filter((t) => t !== now);
      const rebraked =
        priorStamps.length >= freshBrake.maxPerWindow ||
        (priorStamps.length > 0 &&
          now - priorStamps[priorStamps.length - 1] < freshBrake.minIntervalMs);
      if (rebraked) {
        refundBrakeStamp();
        memoryNotifiedKeys.delete(
          `${snapshot.episodeId || "none"}:mitigation`,
        );
        logEvent(
          "memory",
          "memory-monitor",
          "warning",
          {
            kind: "mitigation_skipped",
            reason: "rate_brake",
            recheck: true,
            episodeId: snapshot.episodeId,
            restartsInWindow: priorStamps.length,
            maxRestartsPerDay: freshBrake.maxPerWindow,
            minIntervalMs: freshBrake.minIntervalMs,
          },
          correlationId,
        );
        return;
      }
      memoryMonitor.noteMitigation();
      recordOperationEvent({
        kind: "gateway_restart",
        status: "started",
        details: {
          trigger: "memory_mitigation",
          episodeId: snapshot.episodeId,
        },
      });
      onExpectedRestart({
        // Suppression must cover the whole operation budget (which tracks the
        // configurable ready wait), not the fixed default lease — a mitigation
        // restart still legitimately waiting must not be re-classified.
        expiresAt: Date.now() + kGatewayRestartOperationBudgetMs,
      });
      expectedRestartArmed = true;
      try {
        await restartGatewayForMitigation();
        recordOperationEvent({
          kind: "gateway_restart",
          status: "ok",
          details: { trigger: "memory_mitigation" },
        });
      } catch (err) {
        // Refund the budget stamp — a failed restart mitigated nothing, and
        // two transient failures must not disable protection for 24h. The
        // shorter failure cooldown (above) owns anti-thrash instead.
        refundBrakeStamp();
        memoryMitigationLastFailureAtMs = now;
        logEvent(
          "memory",
          "memory-monitor",
          "failed",
          {
            kind: "mitigation_restart_failed",
            episodeId: snapshot.episodeId,
            message: String(err?.message || err),
          },
          correlationId,
        );
        recordOperationEvent({
          kind: "gateway_restart",
          status: "failed",
          details: { trigger: "memory_mitigation" },
        });
        await notify(
          [
            "🐺 *AlphaClaw Watchdog*",
            withViewLogsSuffix("🔴 Pre-OOM gateway restart failed"),
            "Trigger: `memory_leak`",
          ].join("\n"),
          correlationId,
          "crash",
        );
      }
    } catch (err) {
      // An unexpected throw before the restart attempt (notifier, event
      // sink): the budget wasn't spent on anything — refund and rethrow to
      // the tick's own catch.
      refundBrakeStamp();
      throw err;
    } finally {
      // Settle when armed (mitigation success = restart resolved AND the
      // settle probe confirms healthy; a FAILED restart must never stay
      // hidden inside an expected-restart window). Release ALWAYS.
      if (expectedRestartArmed) onExpectedRestartSettled();
      releaseLifecycleLock?.();
    }
  };

  const checkMemoryTrend = async () => {
    if (memoryTickInFlight) return;
    // A stopping watchdog must not start new detection work (stop() clears
    // the interval, but a straggler invocation can still be in flight).
    if (state.stopRequested) return;
    memoryTickInFlight = true;
    try {
      const settings = readMemorySettingsSafe();
      if (!settings.enabled) {
        // Transition edge only: freeze any live episode (honest reason) and
        // drop the sample buffers, so a later re-enable starts detection
        // from scratch instead of advancing a stale critical episode straight
        // into the mitigation gate off one fresh sample.
        if (memoryIdleState !== "disabled") {
          try {
            memoryMonitor.noteDetectionDisabled(Date.now());
          } catch {}
        }
        memoryIdleState = "disabled";
        noteMemoryTrendState("disabled");
        return;
      }
      const pid = memoryMonitoredPid;
      if (!pid) {
        memoryIdleState = "no_gateway";
        noteMemoryTrendState("no_gateway");
        return;
      }
      memoryIdleState = null;
      const nowMs = Date.now();
      const sample = readMemorySampleSafe(pid);
      memoryMonitor.addSample({
        atMs: nowMs,
        pid,
        rssBytes: sample.rssBytes ?? null,
        cgroupUsedBytes: sample.cgroupUsedBytes ?? null,
        containerLimitBytes: sample.containerLimitBytes ?? null,
        activeHeapMb: sample.activeHeapMb ?? null,
        budgetBytes: resolveMemoryBudgetBytes(settings.budgetMb),
      });
      const { snapshot, transitions } = memoryMonitor.evaluate(nowMs);
      noteMemoryTrendState(snapshot.state);
      const correlationId = transitions.length ? createCorrelationId() : "";
      if (transitions.length) {
        await handleMemoryTransitions(transitions, correlationId);
      }
      await maybeRunMemoryMitigation(
        snapshot,
        settings,
        correlationId || createCorrelationId(),
        // Same MISS predicate the monitor's addSample uses (0/NaN included):
        // the held critical verdict keeps detecting, but enforcement demands
        // this tick's own evidence.
        {
          freshEvidence:
            Number.isFinite(sample.rssBytes) && sample.rssBytes > 0,
        },
      );
    } catch (err) {
      // A tick throw must never kill the interval.
      console.error(`[watchdog] memory trend check failed: ${err.message}`);
    } finally {
      memoryTickInFlight = false;
    }
  };

  const startMemoryMonitor = () => {
    if (memoryTimer) return;
    memoryTimer = setInterval(() => {
      void checkMemoryTrend();
    }, memorySampleIntervalMs);
    if (typeof memoryTimer.unref === "function") memoryTimer.unref();
    // Immediate first tick: setInterval's first fire is a full interval out,
    // which would leave status.memory claiming "no_gateway" for up to 60s
    // after start() even with a live pid.
    void checkMemoryTrend();
  };

  const stopMemoryMonitor = () => {
    if (memoryTimer) {
      clearInterval(memoryTimer);
      memoryTimer = null;
    }
  };

  const startRegularHealthChecks = () => {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      void runHealthCheck();
      void checkContainerResize();
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

  // opts.verbose tags informational notices (suppressed in "Important only"
  // mode — classification rules in notification-policy.js). Suppressions log
  // a `skipped` event row, never a spurious `failed`.
  //
  // Incident-class notifications carry the rescue-session link (when one is
  // already running — a cold spawn takes ~15-30s, so the open notification
  // typically goes out without it and no follow-up is sent; escalation and
  // outcome notifications are the realistic carriers).
  const kRescueLineEventTypes = new Set([
    "crash",
    "crash_loop",
    "health_check",
    "config_error",
    "safe_mode",
    "channel_rollback",
  ]);

  const notify = async (
    message,
    correlationId = "",
    eventType = "info",
    opts = {},
  ) => {
    const { verbose = false, audit = false, id, operationId } = opts;
    // Audit-class notices are exempt from the operator toggles at every layer
    // (notification-policy.js) — the local short-circuit must not re-gate them.
    if (!audit && isNotificationsDisabled()) {
      return { ok: false, skipped: true, reason: "notifications_disabled" };
    }
    if (!notifier?.notify) return { ok: false, reason: "notifier_unavailable" };
    let outgoing = message;
    if (
      typeof getRescueSessionLine === "function" &&
      kRescueLineEventTypes.has(eventType)
    ) {
      try {
        const line = getRescueSessionLine();
        if (line) outgoing = `${message}\n${line}`;
      } catch {}
    }
    // Forward the WHOLE delivery envelope: dropping id/operationId here cost
    // the resize-path autotune notices their outbox dedupe ids (pre-landing
    // review, multi-specialist finding).
    const result = await notifier.notify(outgoing, {
      eventType,
      verbose,
      audit,
      ...(id ? { id } : {}),
      ...(operationId ? { operationId } : {}),
    });
    logEvent(
      "notification",
      "watchdog",
      result.ok ? "ok" : result.skipped ? "skipped" : "failed",
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
    opts = {},
  ) => {
    const key = String(notificationKey || "").trim();
    if (!key) return notify(message, correlationId, eventType, opts);
    if (sentIncidentNotifications.has(key)) {
      return {
        ok: false,
        skipped: true,
        reason: "incident_notification_already_sent",
      };
    }
    const result = await notify(message, correlationId, eventType, opts);
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

  // Exit copy covers all three shapes (codex-eng #7): numeric code, signal
  // name, or neither (rare handler edge) — never "exit undefined".
  const describeExit = (code, signal) =>
    code !== null && code !== undefined
      ? `exit ${code}`
      : signal
        ? `signal ${signal}`
        : "unexpectedly";

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
    notificationsEnabled: !isNotificationsDisabled(),
    notificationsVerbose: isVerboseEnabled(),
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
    const timeoutId = setTimeout(
      () => controller.abort(),
      kGatewayHealthTimeoutMs,
    );
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
          ? parsedBody.suppressed
              .map((entry) => String(entry || ""))
              .filter(Boolean)
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
        // One ADVISORY doctor run on the transition: beta gateways START
        // degraded (instead of refusing) when SecretRefs fail — shape-detect
        // that so the event log names the cause. Warn-only, never restarts.
        // A broken/timed-out doctor contributes NOTHING (null) instead of
        // crash noise; gateway health classification is untouched either way.
        try {
          const doctorText = String(
            (collectAdvisoryDoctorJson
              ? await collectAdvisoryDoctorJson()
              : (
                  await clawCmd("doctor --json", {
                    quiet: true,
                    timeoutMs: 20000,
                  })
                )?.stdout) || "",
          );
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
        { verbose: true },
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

  const updateSettings = ({
    autoRepair,
    notificationsEnabled,
    notificationsVerbose,
  } = {}) => {
    const hasAutoRepair = typeof autoRepair === "boolean";
    const hasNotificationsEnabled = typeof notificationsEnabled === "boolean";
    const hasNotificationsVerbose = typeof notificationsVerbose === "boolean";
    // A present-but-non-boolean field must 400 even when a sibling field is
    // valid — never silently drop a mistyped toggle from a mixed payload.
    const badField =
      (autoRepair !== undefined && !hasAutoRepair) ||
      (notificationsEnabled !== undefined && !hasNotificationsEnabled) ||
      (notificationsVerbose !== undefined && !hasNotificationsVerbose);
    if (
      badField ||
      (!hasAutoRepair && !hasNotificationsEnabled && !hasNotificationsVerbose)
    ) {
      throw new Error(
        "Expected autoRepair, notificationsEnabled, and/or notificationsVerbose boolean",
      );
    }
    const setEnvVar = (envVars, key, value) => {
      const existingIdx = envVars.findIndex((item) => item.key === key);
      if (existingIdx >= 0) {
        envVars[existingIdx] = { ...envVars[existingIdx], value };
      } else {
        envVars.push({ key, value });
      }
    };
    const mutate = (envVars) => {
      if (hasAutoRepair) {
        setEnvVar(
          envVars,
          "WATCHDOG_AUTO_REPAIR",
          autoRepair ? "true" : "false",
        );
      }
      if (hasNotificationsEnabled) {
        // Inverted persistence: the env flag is the DISABLED switch.
        setEnvVar(
          envVars,
          "WATCHDOG_NOTIFICATIONS_DISABLED",
          notificationsEnabled ? "false" : "true",
        );
      }
      if (hasNotificationsVerbose) {
        // Inverted persistence: the env flag is the QUIET switch (absent =
        // verbose ON, the default — see notification-policy.js).
        setEnvVar(
          envVars,
          "WATCHDOG_NOTIFICATIONS_QUIET",
          notificationsVerbose ? "false" : "true",
        );
      }
      return envVars;
    };
    // Locked read-modify-write when the real env module is wired: two
    // concurrent per-field PUTs must not lose a toggle change. The fallback
    // (tests stubbing readEnvFile/writeEnvFile) keeps the legacy semantics.
    if (typeof updateEnvFile === "function") {
      updateEnvFile(mutate);
    } else {
      writeEnvFile(mutate(readEnvFile()));
    }
    reloadEnv();
    state.autoRepair = isTruthy(process.env.WATCHDOG_AUTO_REPAIR);
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
    if (state.configurationErrorActive) {
      // Latched: nothing probes, but a config edit re-arms one relaunch.
      maybeRetryAfterConfigChange();
      return false;
    }
    // While an async exit resolver is classifying the last exit (handoff
    // consume ≤5s + step-aside probes), lifecycle/health still read the
    // pre-exit state; a health tick here could mark degraded or start
    // rollback/auto-repair paths racing the resolver. The resolver owns the
    // next transition — the flag clears on settle and on any newer lifecycle
    // event (advancePendingExitProbeToken).
    if (state.pendingExitClassification) return false;
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
    healthProbeSeq += 1;
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
      // Keep the retry counter: evaluateChannelSuppression below can
      // re-degrade (green /health, failing /readyz) and re-arm in this tick.
      clearDegradedHealthCheckTimer({ resetBackoff: false });
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
              previousLifecycle: recoveredFromCrashLoop ? "crash_loop" : null,
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
          { verbose: true },
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
      // Only a confirmed recovery ends the episode: readiness may have just
      // re-degraded and re-armed, and a green /health over a failing /readyz
      // must keep backing off instead of resetting to 5s every tick.
      if (state.health === "healthy") resetDegradedRetryBackoff();
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
    // Only promise a retry that WILL be armed — the incidents UI renders this
    // field as "next retry in Ns". The loop refuses to arm outside lifecycle
    // "running" (restarting past its window, crash_loop) or under the
    // config-error latch, and the in-flight tick's own re-arm applies the same
    // test: a crash exit landing mid-probe clears the handle and flips
    // lifecycle, so when that probe's failure reaches this site neither the
    // schedule above nor the callback will arm anything.
    const degradedRetryArmed =
      !!degradedHealthTimer ||
      (degradedRetryInFlight && canArmDegradedRetry());
    if (!state.degradedSince) state.degradedSince = Date.now();
    try {
      releaseChannelHooks?.onUnhealthy?.();
    } catch {}
    logEvent(
      "health_check",
      source,
      "failed",
      {
        reason: parsed.reason,
        details: parsed.details || null,
        // The retry pending after this row: f(attempt) inside the loop's own
        // tick, otherwise the armed timer's remaining time (see
        // nextDegradedRetryDelayMs).
        degradedRetry: degradedRetryArmed
          ? {
              attempt: degradedRetryAttempt,
              nextDelayMs: nextDegradedRetryDelayMs(),
            }
          : null,
      },
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

  // openclaw >= 2026.9.1-beta.1 exits EX_CONFIG for pending STATE migrations
  // too (state db / agent db / offline media), not just config errors — the
  // medic's remove-blamed-keys tier cannot fix those, and telling the
  // operator "fix the config" points them at the wrong thing. Visibility
  // only: the migration gate / forward-recovery machinery owns the remedy.
  const kStateMigrationRefusalPattern =
    /requires state database schema migration|state database schema migration pending|startup migrations did not complete cleanly|requires migration before writing|media library requires migration/i;
  const detectStateMigrationRefusal = (stderrTail = []) => {
    const text = (Array.isArray(stderrTail) ? stderrTail : [])
      .map((line) => String(line ?? ""))
      .join("\n");
    const match = kStateMigrationRefusalPattern.exec(text);
    return match ? match[0] : null;
  };

  const notifyConfigErrorLatched = async ({
    correlationId,
    diagnosis = null,
    stderrTail = [],
  }) => {
    const diagnosisLine = sanitizeModelDiagnosis(diagnosis);
    const migrationRefusal = detectStateMigrationRefusal(stderrTail);
    return notifyOncePerIncident(
      "gateway_config_error",
      [
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix("🔴 Gateway configuration error"),
        migrationRefusal
          ? `OpenClaw stopped with \`EX_CONFIG\` because a state migration is pending ("${migrationRefusal}") — this is a database migration, not a config mistake. The update pipeline's migration gate owns the repair; automatic gateway restart is paused meanwhile.`
          : "OpenClaw stopped with `EX_CONFIG`; automatic gateway restart is paused until the config is fixed.",
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
    // Launch-generation marker at the exit-78 observation: if ANY gateway
    // launch lands while the medic queues for the lock below, the observation
    // is stale and the medic must stand down (see the supersede check).
    const observedLaunchGeneration = state.gatewayStartedAt;
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
        await notifyConfigErrorLatched({ correlationId, stderrTail });
      } catch {}
      return;
    }
    if (queuedBehindHolder) {
      // The queued wait can resolve up to medicLockWaitMs after the exit-78
      // observation — long enough for the prior holder (boot, a route
      // restart) to have already repaired the config and relaunched. Acting
      // on the stale observation would mutate openclaw.json and doctor state
      // under a gateway that now owns the DBs. A health probe cannot decide
      // this: a just-relaunched gateway still WARMING probes not-ok and would
      // read as dead. The launch generation can — any launch while queued
      // (onGatewayLaunch moved gatewayStartedAt) supersedes the observation,
      // warming or not, while a genuinely-down gateway (no launch happened)
      // keeps the marker unchanged and the medic proceeds.
      if (state.gatewayStartedAt !== observedLaunchGeneration) {
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
        // The medic gave up — before latching for good, a pin exiting 78 may
        // still be able to move FORWARD (issue #21 bug 10).
        if (tryForwardRecovery({ exitCode, correlationId })) return;
        await notifyConfigErrorLatched({
          correlationId,
          diagnosis: outcome.diagnosis || null,
          stderrTail,
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
        latchConfigError();
        await notifyConfigErrorLatched({
          correlationId,
          diagnosis: outcome.diagnosis || null,
          stderrTail,
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
        latchConfigError();
        await notifyConfigErrorLatched({
          correlationId,
          diagnosis: outcome.diagnosis || null,
          stderrTail,
        });
      }
    } finally {
      releaseLifecycleLock?.();
      state.operationInProgress = false;
    }
  };

  // Step-aside exits happen at boot: the losing process probes the incumbent
  // and exits within seconds of its own spawn. Prefer the per-child spawn
  // timestamp carried on the exit event; fall back to the last recorded
  // launch. No reference at all fails the window (fail-safe toward the
  // config-error flow below, medic included).
  const withinStepAsideStartupWindow = (launchedAt) => {
    const referenceAt = Number(launchedAt) || state.gatewayStartedAt || 0;
    return (
      referenceAt > 0 && Date.now() - referenceAt <= kStepAsideStartupWindowMs
    );
  };

  // Shared by both async exit resolvers: bounded probe attempts against the
  // incumbent's /health; a throwing probe reads as unhealthy (fail-safe
  // toward the existing config-error/crash flows).
  const probeIncumbentHealthy = async () => {
    try {
      for (
        let attempt = 0;
        attempt < kStepAsideHealthProbeAttempts;
        attempt += 1
      ) {
        const probe = await probeGatewayHealth();
        if (probe?.ok === true) return true;
      }
    } catch {}
    return false;
  };

  // OOM classification (autotune): two distinct failure shapes with OPPOSITE
  // remediations — a V8 heap abort wants a bigger heap (when the box has
  // headroom), a kernel/container OOM kill (exit 137 / SIGKILL) means the box
  // itself is out of memory and raising the heap makes it WORSE. The
  // remediation command is machine-derived and omitted when no headroom
  // exists. Fire-and-forget: classification never delays crash handling, and
  // notifyOncePerIncident keeps a crash loop from spamming the channel.
  // Only the unexpected-exit resolvers (handleConfigErrorExit /
  // handleCrashExit) schedule it — benign step-aside, accepted-handoff,
  // expected, managed, and duplicate-launch exits are never OOM-classified.
  const kHeapOomPattern = /JavaScript heap out of memory|Reached heap limit/i;
  // Shared remedy derivation (OOM classifier + the memory monitor's critical
  // notification) so the two paths can't drift: suggest a heap raise only
  // when the autotune ceiling leaves room; at the ceiling, raising the heap
  // trades a V8 abort for a kernel OOM kill.
  const deriveHeapOomRemedy = () => {
    let remedy =
      "Enable resource autotune (Watchdog tab) so the gateway heap is sized to this machine.";
    try {
      const {
        getActiveGatewayHeapMb,
        maxGatewayHeapMbFor,
      } = require("./autotune");
      const { getMachineProfile } = require("./machine-profile");
      const active = getActiveGatewayHeapMb();
      const memMb = Math.round(
        (getMachineProfile()?.memory?.limitBytes || 0) / (1024 * 1024),
      );
      if (active != null && memMb > 0) {
        // Same ceiling autotune enforces on overrides — a suggestion
        // above it would be clamped back on apply.
        const ceiling = maxGatewayHeapMbFor(memMb);
        const suggested = Math.min(Math.round(active * 1.25), ceiling);
        remedy =
          suggested > active
            ? `Raise the gateway heap: \`alphaclaw admin PUT /api/autotune/settings --data '{"overrides":{"gatewayHeapMb":${suggested}}}'\` (or set it on the Autotune card in the Watchdog tab), then restart the gateway.`
            : `This container is at its memory limit (${memMb}MB) — raising the heap would trade a V8 abort for a kernel OOM kill. Upgrade the container's memory plan.`;
      }
    } catch {}
    return remedy;
  };
  const classifyOomExit = async ({
    code,
    signal,
    stderrTail = [],
    correlationId = "",
  } = {}) => {
    try {
      const tailText = (stderrTail || []).join("\n");
      if (kHeapOomPattern.test(tailText)) {
        const remedy = deriveHeapOomRemedy();
        logEvent(
          "autotune",
          "oom_classifier",
          "info",
          { kind: "heap_oom", code: code ?? null, signal: signal ?? null },
          correlationId,
        );
        await notifyOncePerIncident(
          "autotune_heap_oom",
          `Gateway ran out of JavaScript heap and crashed. ${remedy}`,
          correlationId,
          "autotune",
        );
        return;
      }
      if (code === 137 || signal === "SIGKILL") {
        logEvent(
          "autotune",
          "oom_classifier",
          "info",
          { kind: "container_oom", code: code ?? null, signal: signal ?? null },
          correlationId,
        );
        // Exit 137/SIGKILL is strong but not conclusive OOM evidence (an
        // operator kill -9 or a platform eviction looks identical) — say so.
        await notifyOncePerIncident(
          "autotune_container_oom",
          "Gateway was force-killed (exit 137/SIGKILL) — commonly the kernel OOM killer when the BOX runs out of memory. If memory pressure is the cause, reduce concurrent load or upgrade the container's memory plan; raising the gateway heap will not help.",
          correlationId,
          "autotune",
        );
      }
    } catch (err) {
      console.error(`[watchdog] oom classification failed: ${err.message}`);
    }
  };

  // Healthy incumbent verified: the exited process was redundant by design
  // and the incumbent keeps the port — mirror the duplicate-launch branch
  // (no latch, no rollback, no medic run, no crash accounting, no
  // notification).
  const applyStepAsideClassification = ({
    code,
    signal,
    stderrTail,
    correlationId,
  }) => {
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

  // Only the resolver whose exit still owns classification may clear the
  // in-flight flag: a newer event that advanced the token already cleared it
  // (and may have re-set it for its OWN deferral).
  const settlePendingExitClassification = (probeToken) => {
    if (probeToken === pendingExitProbeToken) {
      state.pendingExitClassification = false;
    }
  };

  // Deferred exit-78 resolution: the step-aside stderr signature and startup
  // window already matched; the third signal is a healthy /health probe of
  // the incumbent (a signature alone could be a stale or dying incumbent).
  // All three signals → treat like the duplicate-launch branch. Probe
  // unhealthy, unreachable, or throwing → the EXISTING config-error flow
  // (rollback snapshot → medic → latch), unchanged.
  const resolveStepAsideExit = async ({
    code,
    signal,
    stderrTail,
    correlationId,
    probeToken,
  }) => {
    state.pendingExitClassification = true;
    try {
      const healthy = await probeIncumbentHealthy();
      if (pendingExitProbeStale(probeToken)) return;
      if (!healthy) {
        handleConfigErrorExit({ code, signal, stderrTail, correlationId });
        return;
      }
      applyStepAsideClassification({ code, signal, stderrTail, correlationId });
    } finally {
      settlePendingExitClassification(probeToken);
    }
  };

  // Deferred clean-exit resolution (external supervision, 2026.8.1+): consume
  // the gateway's restart-handoff row for the exited PID. `accepted` proves
  // this exit was a restart REQUEST (config-write restart, /restart, SIGUSR1,
  // plugin change) — expected-restart handling plus a prompt relaunch, no
  // crash accounting or backoff. none/rejected/error → probe the incumbent
  // before falling back to the existing crash classification (see below).
  const resolveSupervisedCleanExit = async ({
    code,
    signal,
    stderrTail,
    pid,
    correlationId,
    probeToken,
  }) => {
    state.pendingExitClassification = true;
    try {
      let consumed = null;
      try {
        consumed = await consumeRestartHandoffImpl({ clawCmd, pid });
      } catch {
        consumed = { status: "error", reason: null, handoff: null };
      }
      if (pendingExitProbeStale(probeToken)) return;
      if (consumed?.status === "accepted") {
        // Brake before the fast path: a gateway that requests a restart on
        // every boot proves "accepted" each time, and each pass here skips
        // crash accounting — so the crash-loop brake would never engage.
        // Past the window cap, classify like any other crash (accounting,
        // backoff, crash-loop notification).
        const now = Date.now();
        state.handoffRelaunchTimestamps =
          state.handoffRelaunchTimestamps.filter(
            (ts) => now - ts < kWatchdogHandoffRelaunchWindowMs,
          );
        if (
          state.handoffRelaunchTimestamps.length >=
          kWatchdogHandoffMaxRelaunchesPerWindow
        ) {
          logEvent(
            "restart",
            "handoff",
            "skipped",
            {
              reason: "rate_limited",
              relaunchesInWindow: state.handoffRelaunchTimestamps.length,
              windowMs: kWatchdogHandoffRelaunchWindowMs,
              code: code ?? null,
              signal: signal ?? null,
            },
            correlationId,
          );
          handleCrashExit({ code, signal, stderrTail, correlationId });
          return;
        }
        state.handoffRelaunchTimestamps.push(now);
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
        // Unlike expectedExit (where the managed restart path relaunches),
        // the gateway deferred its OWN restart to us — relaunch promptly.
        await restartAfterCrash(correlationId);
        return;
      }
      if (consumed?.status === "rejected") {
        // Info only: a rejected row (pid-mismatch/expired) is not this exit's.
        console.log(
          `[watchdog] gateway restart handoff rejected (${consumed.reason || "unknown"}); classifying exit normally`,
        );
      }
      // A missing handoff row does NOT prove a crash: a beta newcomer that
      // finds a healthy incumbent yields with a plain exit 0 and NO handoff
      // row (the "existing gateway is healthy, leaving it in control" line
      // goes to stdout via log.info — verified in openclaw@2026.8.1-beta.3
      // dist run-*.js — so no stderr signature is available either). A
      // healthy incumbent probe disambiguates: a genuine clean-exit crash
      // leaves no healthy listener behind.
      const healthy = await probeIncumbentHealthy();
      if (pendingExitProbeStale(probeToken)) return;
      if (healthy) {
        applyStepAsideClassification({
          code,
          signal,
          stderrTail,
          correlationId,
        });
        return;
      }
      handleCrashExit({ code, signal, stderrTail, correlationId });
    } finally {
      settlePendingExitClassification(probeToken);
    }
  };

  const handleConfigErrorExit = ({
    code,
    signal,
    stderrTail,
    correlationId,
  }) => {
    // Scheduled AFTER this handler's synchronous config_error logEvent so the
    // classifier's event lands INSIDE the incident those events open (the
    // incident tracker stamps events to the active incident).
    setImmediate(() => {
      void classifyOomExit({ code, signal, stderrTail, correlationId });
    });
    // Unexpected exit: record it for the status surface. Managed, expected,
    // duplicate-launch, step-aside, and accepted-handoff exits never reach
    // this handler (they are benign by classification).
    state.lastExit = {
      code: code ?? null,
      signal: signal ?? null,
      at: new Date().toISOString(),
    };
    // Version skew usually shows up exactly here (a new build rejecting the
    // existing config). For a non-pin build still in its stabilization
    // window, roll back instead of latching — the latch would otherwise
    // silently defeat channel rollback (the exit never reaches crash
    // accounting).
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
    latchConfigError();
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
      return state.medicRunTimestamps.length >= kWatchdogMedicMaxRunsPerWindow;
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
    // Last resort before the latch: a pin exiting 78 may only be able to
    // move FORWARD (issue #21 bug 10).
    if (tryForwardRecovery({ exitCode: code, correlationId })) return;
    void notifyConfigErrorLatched({ correlationId, stderrTail });
  };

  const handleCrashExit = ({ code, signal, stderrTail, correlationId }) => {
    // Scheduled AFTER this handler's synchronous crash logEvent so the
    // classifier's event lands INSIDE the incident those events open (the
    // incident tracker stamps events to the active incident).
    setImmediate(() => {
      void classifyOomExit({ code, signal, stderrTail, correlationId });
    });
    // Unexpected exit: record it for the status surface. Managed, expected,
    // duplicate-launch, step-aside, and accepted-handoff exits never reach
    // this handler (they are benign by classification).
    state.lastExit = {
      code: code ?? null,
      signal: signal ?? null,
      at: new Date().toISOString(),
    };
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
      {
        code: code ?? null,
        signal: signal ?? null,
        stderrTail,
        // The crashed process's identity — the incident tracker uses it to
        // correlate a frozen leak-episode summary to THIS crash instead of
        // trusting the time window alone.
        pid: state.lastExitedGatewayPid ?? null,
      },
      correlationId,
    );
    // Open the incident at the FIRST unexpected exit: the down notice below
    // dedupes on it, and recovery (shouldNotifyRecovery keys off an open
    // incident) becomes symmetric — the operator who hears "went down" also
    // hears "running again" (the latter classified verbose). Same-key
    // openIncident calls are no-ops, so the crash-loop branch's own open
    // cannot reset the sent-keys seam.
    openIncident("gateway_recovery");

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
      // A crash-looping PIN with a blocklisted newer overlay that owns the
      // migrated state can only move forward (issue #21 bug 10).
      if (tryForwardRecovery({ exitCode: code ?? null, correlationId })) return;
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
          `Last exit: ${describeExit(code, signal)}`,
          ...(state.autoRepair
            ? []
            : [
                // E5 (TODOS.md "Notification remediation-action parity"):
                // name the remediation with the Watchdog
                // card's own action vocabulary — a crash-looping gateway with
                // restarts paused is the `down` state, whose primary action is
                // Retry with Repair secondary (gateway-state.js catalog; the
                // parity test asserts these literals against the catalog).
                "Automatic gateway restart paused; manual action required — use Retry (or Repair) from the Watchdog tab.",
              ]),
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
              void runRepair({
                source: "crash_loop_retry",
                correlationId,
              }).then((retryResult) => {
                if (
                  retryResult?.skipped &&
                  retryResult?.reason === "operation_in_progress"
                ) {
                  scheduleRetry(attempt + 1);
                }
              });
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

    // Below the crash-loop early returns: restart IS the selected action
    // here, so the copy can say so — but non-committally ("will retry"), a
    // selected branch is not a completed action. Once per incident; the
    // backoff retries inside restartAfterCrash stay silent.
    void notifyOncePerIncident(
      "gateway_went_down",
      [
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix(
          `🔴 Gateway went down (${describeExit(code, signal)}) — AlphaClaw will retry automatically`,
        ),
      ].join("\n"),
      correlationId,
      "crash",
    );
    void restartAfterCrash(correlationId);
  };

  const onGatewayExit = ({
    code,
    signal,
    expectedExit = false,
    stderrTail = [],
    pid = null,
    // Adopted cold-restart supervisor (issue #56): the real gateway's pid,
    // which is what the restart-handoff row is keyed by, and the shape flag.
    workerPid = null,
    supervisor = false,
    launchedAt = null,
  } = {}) => {
    // A stopped watchdog (shutdown drain, deliberate stop) must not react to
    // the gateway exit it caused — re-arming health probes or logging restart
    // events mid-drain. Boot-time crashes are unaffected: stopRequested is
    // only ever set by stop().
    if (state.stopRequested) return;
    // Stale predecessor (issue #56): a cold restart marks the OLD supervisor
    // expected, forgets it, and adopts the NEW one — but the old gateway can
    // drain for minutes and its launcher exits long after onGatewayLaunch
    // moved state.gatewayPid to the successor. Booking that late exit as the
    // live gateway's "restarting" would arm an expected-restart window over a
    // healthy process and blind detection until a probe clears it. Record it
    // and stop; the successor's lifecycle is untouched.
    if (
      expectedExit &&
      pid != null &&
      state.gatewayPid != null &&
      pid !== state.gatewayPid
    ) {
      logEvent(
        "restart",
        "exit_event",
        "ok",
        {
          expectedExit: true,
          stalePredecessor: true,
          pid,
          currentPid: state.gatewayPid,
          code: code ?? null,
          signal: signal ?? null,
        },
        createCorrelationId(),
      );
      return;
    }
    // The exiting process's identity, for crash-event details (episode
    // correlation) — captured before any classification path runs.
    state.lastExitedGatewayPid = pid ?? state.gatewayPid ?? null;
    // Freeze a live leak episode NOW, not on the replacement pid's first
    // sample (up to one 60s tick later): an incident that closes inside that
    // window must still carry the episode that killed the predecessor. Also
    // drop the dead episode's notification-dedupe keys (they can never fire
    // again; pid-change episodes otherwise never emit the `cleared`
    // transition that prunes them). Guarded by pid: a duplicate-launch or
    // step-aside exit (the incumbent keeps running) must not freeze a live
    // episode on the surviving process.
    const monitoredExit =
      pid == null || state.gatewayPid == null || pid === state.gatewayPid;
    if (monitoredExit) {
      try {
        const liveEpisodeId = memoryMonitor.getTrend().episodeId;
        memoryMonitor.noteProcessExited(Date.now(), pid);
        if (liveEpisodeId) {
          for (const key of [...memoryNotifiedKeys]) {
            if (key.startsWith(`${liveEpisodeId}:`))
              memoryNotifiedKeys.delete(key);
          }
        }
        // Both status surfaces flip together: without this, the 2s SSE keeps
        // claiming the pre-exit trend for up to 60s (until the next tick)
        // while the resources payload already says no_gateway.
        memoryIdleState = "no_gateway";
        noteMemoryTrendState("no_gateway");
      } catch {}
      // Stop sampling the dead pid (memory tick only — state.gatewayPid stays
      // for status/supervision/classification across the relaunch window).
      memoryMonitoredPid = null;
    }
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
    // openclaw >= 2026.9.1-beta.1 exits 130 (SIGINT) / 143 (SIGTERM) on
    // forwarded signals instead of dying BY the signal (code null) or exiting
    // 1 — an alphaclaw-initiated stop/restart must not be booked as a crash.
    // Only honored under expectedExit; an unexpected 130/143 (external kill)
    // still runs crash accounting. SIGKILL escalation still lands in
    // code == null.
    // Adopted supervisor (issue #56): the OpenClaw launcher forwards our
    // SIGTERM, then hard-kills a gateway still draining at 2s and exits 1 —
    // so an EXPECTED stop of that shape legitimately lands as code 1.
    if (
      expectedExit &&
      (code == null ||
        code === 0 ||
        code === 130 ||
        code === 143 ||
        (supervisor && code === 1))
    ) {
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
    // (2026.8.1+, supervisor mode on by default) this can be the gateway's
    // own restart request — the handoff row proves it. Only this gated case
    // goes async; with supervisor mode escape-hatched off the crash
    // classification below stays synchronous and the consume CLI is never
    // spawned.
    if (code === 0 && supervisorModeActive()) {
      void resolveSupervisedCleanExit({
        code,
        signal,
        stderrTail,
        // The handoff row carries the GATEWAY's pid; for an adopted
        // supervisor that is the resolved worker pid, not the launcher's.
        pid: workerPid ?? pid ?? state.gatewayPid,
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
      // latch, roll back, or spend a medic run (a false-positive config
      // classification would cost an unnecessary medic run + notification).
      // Signature + startup window match here; the third signal (healthy
      // incumbent probe) resolves asynchronously — any signal missing keeps
      // the synchronous config-error flow below (rollback snapshot → medic →
      // latch). A requested rollback always wins (rollback owns recovery),
      // so the probe is not even started once the rollback latch is set.
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
    memoryMonitoredPid = pid;
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
    advancePendingExitProbeToken();
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
      logEvent(
        "operation",
        String(kind || "operation"),
        String(status || "ok"),
        details,
        createCorrelationId(),
      );
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
  // cadence to ~30s while someone is watching. fast_cadence is suppressed
  // while the degraded loop is armed OR in flight (its 30s cap would
  // otherwise trip the stamp gap and open a second probe path carrying
  // allowAutoRepair) — an in-flight tick whose handle another probe source
  // cleared still owns the cadence until it settles; degraded states WITHOUT
  // the loop (lifecycle restarting / crash_loop) keep it as their sub-120s
  // probe.
  const startTcpWatcher = () => {
    if (tcpWatchTimer || typeof probeGatewayTcp !== "function") return;
    tcpWatchTimer = setInterval(async () => {
      try {
        await probeGatewayTcp();
      } catch {}
      if (
        !isDegradedRetryLoopActive() &&
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
    advancePendingExitProbeToken();
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
    startMemoryMonitor();
  };

  const stop = () => {
    state.stopRequested = true;
    advancePendingExitProbeToken();
    clearDegradedHealthCheckTimer();
    stopTcpWatcher();
    stopMemoryMonitor();
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
      pendingExitClassification: state.pendingExitClassification,
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
          ? new Date(
              state.gatewayStartedAt + kHealthStartupGraceMs,
            ).toISOString()
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
      // Degraded-retry loop — distinct from `backoff` (crash-relaunch
      // backoff). null unless the loop is armed or its probe is in flight.
      // `nextDelayMs` intentionally reports the delay the armed (or, while
      // inFlight, just-fired) timer was scheduled with — a value stable
      // across reads so the 2s SSE projection does not churn; the event rows
      // carry time-to-next-retry instead.
      degradedRetry: isDegradedRetryLoopActive()
        ? {
            attempt: degradedRetryAttempt,
            nextDelayMs: degradedRetryDelayMs,
            dueAt: degradedRetryDueAtMs
              ? new Date(degradedRetryDueAtMs).toISOString()
              : null,
            inFlight: degradedRetryInFlight,
          }
        : null,
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
      // Latched enum + ISO + boolean ONLY (the 2s SSE frame-dedupe projection
      // must never see an always-changing numeric). Full trend numerics ride
      // GET /api/watchdog/resources instead.
      memory: {
        trendState: memoryTrendStateSeen || memoryIdleState || "no_gateway",
        trendSince: memoryTrendSinceMs
          ? new Date(memoryTrendSinceMs).toISOString()
          : null,
        autoRestartEnabled: memoryEffectiveSettings.effectiveAutoRestart,
      },
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

  // Single readiness owner for expensive dispatches (doctor LLM runs and
  // card fixes): only the watchdog sees managed update operations, pending
  // async exit classification, and safe mode alongside lifecycle/health.
  // lib/server.js delegates getGatewayReadiness here. A medic run is covered
  // twice over: it holds operationInProgress for its whole run and only ever
  // starts from lifecycle "configuration_error" (blocked below). Reasons are
  // operator-facing (surfaced as 503 bodies and Run-button tooltips).
  const isReadyForDispatch = () => {
    if (state.managedOperationActive) {
      return {
        ok: false,
        reason: "an OpenClaw update operation is in progress",
      };
    }
    if (state.pendingExitClassification) {
      return { ok: false, reason: "a gateway exit is being classified" };
    }
    if (state.operationInProgress) {
      return {
        ok: false,
        reason: "a gateway lifecycle operation is in progress",
      };
    }
    if (state.safeMode) {
      return { ok: false, reason: "gateway is in safe mode" };
    }
    if (!["running", "initializing"].includes(state.lifecycle)) {
      return { ok: false, reason: `gateway lifecycle is ${state.lifecycle}` };
    }
    if (state.health === "unhealthy") {
      return { ok: false, reason: "gateway is unhealthy" };
    }
    if (state.health === "degraded") {
      return {
        ok: false,
        reason: "gateway health is degraded (failing health probes)",
      };
    }
    return { ok: true, reason: "" };
  };

  return {
    getStatus,
    isReadyForDispatch,
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
    checkContainerResize,
    clearManualInterventionLatch,
    getMemoryTrend,
    // Shared heap-raise remedy (OOM classifier + memory notifications + the
    // doctor's leak-card fixPrompt all consume this ONE derivation).
    deriveHeapOomRemedy,
    // exported for tests (checkMemoryTrend mirrors checkContainerResize:
    // tests drive ticks directly instead of waiting out the interval)
    checkMemoryTrend,
    runHealthCheck,
    probeGatewayHealth,
    probeGatewayReadiness,
    start,
    stop,
  };
};

module.exports = { createWatchdog, resolveMemoryMitigationBrake };
