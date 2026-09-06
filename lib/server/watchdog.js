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
  kGatewayRestartReadyTimeoutMs,
  kWatchdogDegradedRepairThreshold,
  kOpenclawManagedDir,
  OPENCLAW_DIR,
} = require("./constants");
const {
  isSupervisorModeActive,
  kGatewayLaunchOutcomes,
  isCallerAbortError,
} = require("./gateway");
// Exit-1 ownership-conflict wording and /proc start ticks (the pid-reuse
// guard) live beside the gateway's own process scan in ONE stamped module.
const lockContention = require("./openclaw-lock-contention");
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
// degradedReason value narrating a launch the prelaunch hook aborted
// (onPrelaunchHook). Not a phase: the 15-value phase enum is unchanged.
const kPrelaunchHookFailedReason = "prelaunch_hook_failed";
// degradedReason enum values the repair contract writes (free-text probe
// prose is the other writer). The UI copy map (watchdog-tab/helpers.js
// kDegradedReasonCopy) mirrors this set; a drift test pins both sides so an
// internal enum name never renders.
const kDegradedReasons = Object.freeze({
  READINESS_FAILING: "readiness_failing",
  GATEWAY_CONFLICT_UNHEALTHY: "gateway_conflict_unhealthy",
  STATE_WRITER_CONFLICT: "state_writer_conflict",
  INCUMBENT_UNHEALTHY: "incumbent_unhealthy",
  REPLACEMENT_NOT_READY: "replacement_not_ready",
  PRELAUNCH_HOOK_FAILED: kPrelaunchHookFailedReason,
});
// runRepair skip reasons the crash-loop retry ladder treats as transient
// (retry on a short bounded cadence instead of dropping the promised repair).
const kTransientRepairSkipReasons = new Set([
  "operation_in_progress",
  "replacement_pending",
  "lease_expired",
]);

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
// `doctor --fix` ceiling (streamed runner and clawCmd fallback alike). The
// repair hold is leased at this PLUS the cold-restart budget: a Doctor run
// that hits its ceiling and is followed by a `replace` cold restart must
// still be inside its lease, or it launches into a successor's operation.
const kRepairTimeoutMs = 10 * 60 * 1000;
// Verdicts of the one relaunch primitive (runVerifiedRelaunch below);
// getStatus().lastRepairVerdict carries the repair path's latest.
const kRestartVerdicts = Object.freeze({
  REPLACEMENT_READY: "replacement_ready",
  REPLACEMENT_PENDING: "replacement_pending",
  REPLACEMENT_FAILED: "replacement_failed",
  REPLACEMENT_SUPERSEDED: "replacement_superseded",
  INCUMBENT_ADOPTED: "incumbent_adopted",
  INCUMBENT_UNHEALTHY: "incumbent_unhealthy",
  CHILD_RETAINED: "child_retained",
  LAUNCH_ABORTED: "launch_aborted",
  LAUNCH_FAILED: "launch_failed",
  LEASE_EXPIRED: "lease_expired",
});
// Lifecycle-lock ownership query (gateway-lifecycle-lock.js release.isValid).
// A bare function (legacy mock, no lock wired) is always valid: the fence
// only ever tightens behaviour where the real lock is present.
const holdStillValid = (release) =>
  typeof release?.isValid === "function" ? release.isValid() : true;

const shellEscapeArg = (value) => {
  const safeValue = String(value || "");
  return `'${safeValue.replace(/'/g, `'\\''`)}'`;
};

const {
  isNotificationsDisabled,
  isVerboseEnabled,
  sanitizeNotificationText,
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
  // gateway.getLastGatewayPrelaunchHookOutcome: the outcome of the prelaunch
  // hook that gated the most recent launch attempt ({ status: "ran"|"refused"
  // |"failed", ... } or null). Consulted when a relaunch returns no child on a
  // config-error path, to tell a fail-closed hook abort from EX_CONFIG. Null
  // = read it lazily from the gateway module (production has one instance;
  // tests fresh-require gateway.js, so a load-time binding would go stale).
  getLastGatewayPrelaunchHookOutcome = null,
  // ── Relaunch / identity seams (v0.9.75; all optional, defaults keep the
  // legacy harness construction working) ────────────────────────────────
  // gateway.requestGatewayLaunch — the outcome-shaped relaunch primitive.
  // Default: a shim over launchGatewayProcess (child → launch_requested,
  // null → launch_aborted, throw → launch_failed).
  requestGatewayLaunch = null,
  // gateway.resolveServingIdentity — { rootPid, workerPid, startTicks, pids }
  // | null for a gateway AlphaClaw did not spawn. Null dep = never adopts.
  discoverServingIdentity = null,
  // /proc start ticks of a pid (pid-reuse guard for the serving root).
  readProcStartTicks = lockContention.readProcStartTicks,
  // process.kill(pid, 0) liveness (ESRCH = gone, EPERM = alive but not ours)
  // for the probe-detected death fast path; server.js wires the same module
  // function explicitly, tests inject stubs.
  pidAlive = lockContention.pidAlive,
  // Exit-1 ownership-conflict classifier over the gateway's stderr tail.
  classifyOwnershipConflict = lockContention.classifyOwnershipConflict,
  // Consecutive failed liveness probes of an ESTABLISHED gateway before
  // doctor --fix (deployment-only knob, constants.js).
  degradedRepairThreshold = kWatchdogDegradedRepairThreshold,
  // Cold restart (restartGateway → runGatewayColdStart, #59 verdict) for the
  // repair path's `replace` intent AND the memory mitigation. New name;
  // restartGatewayForMitigation above is the same function under its older
  // name — either is accepted, the new one wins when both are passed.
  restartGatewayColdStart = null,
  // gateway.getLaunchGeneration — the spawn-counter snapshot a pending
  // replacement is watermarked with, so a launch handler firing DURING the
  // launch call is matched (generation > watermark), never missed.
  getLaunchGeneration = null,
}) => {
  const coldRestartGateway =
    restartGatewayColdStart ?? restartGatewayForMitigation ?? null;
  const state = {
    lifecycle: "stopped",
    health: "unknown",
    uptimeStartedAt: null,
    lastHealthCheckAt: null,
    lastHealthCheckAtMs: 0,
    statusClientsConnected: false,
    repairAttempts: 0,
    crashTimestamps: [],
    // State-writer conflict relaunches (backoff ladder) — their own window so
    // crashCountInWindow / the `flapping` headline never rise without a
    // `crash` row to back them (the classification promises "no crash count").
    conflictRelaunchTimestamps: [],
    lastConflictRepairSkipSource: null,
    // Cold-boot budget for an EXTERNAL incumbent that holds the port/state
    // directory but is not healthy yet (ownership conflict, incumbent_unhealthy):
    // repair may not `gateway stop` it before this passes — upstream takes the
    // lock and the port before /health is green, and cold boots run minutes.
    incumbentGraceUntilMs: null,
    // The holder the grace protects (conflict holder pid / unhealthy incumbent
    // root): when it is gone the grace has nothing left to protect.
    incumbentGracePid: null,
    // A `replace` that failed (stop refused, launch failed): the automatic
    // ladder waits for a recovery — unless the incumbent it could not replace
    // is gone (pid evidence), when there is nothing left to wait for.
    failedReplacement: null,
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
    // Last automatic repair refusal logged for a hold (source:reason:detail);
    // consecutive identical refusals do not re-log (see runRepair).
    lastRepairHoldSkipKey: null,
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
    // Last refused/failed gateway prelaunch hook outcome (gateway.js
    // setGatewayPrelaunchHookHandler → onPrelaunchHook): the launch it gated
    // was ABORTED, so this rides getStatus() as the operator-facing "why"
    // until the next real launch or a healthy probe. Display-only.
    prelaunchHook: null,
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
    // Serving identity (v0.9.75): WHICH process answers the port, kept apart
    // from gatewayPid (the child AlphaClaw spawned — the UI's managed
    // signal). servingPid = the worker (a `gateway run` child, or the
    // resolved worker of an adopted supervisor); servingRootPid = the
    // process-tree root the memory sampler walks; servingStartTicks = the
    // root's /proc start ticks (pid-reuse guard); servingSeq = watchdog-local
    // launch counter (probe fence); servingLaunchGeneration = gateway.js's
    // spawn counter for the serving launch (null for an adopted incumbent).
    // Cleared when the root/worker exits or the start ticks stop matching.
    servingPid: null,
    servingRootPid: null,
    servingStartTicks: null,
    servingSeq: 0,
    servingLaunchGeneration: null,
    supervisionMode: "detached",
    // Readiness axis, orthogonal to liveness: what /readyz said on the last
    // green /health. "not_ready" gates recovery / incident close / onHealthy;
    // "unknown" (no readyz URL, transport error, thrown evaluation) fails
    // open for recovery but never certifies a pending replacement.
    readiness: "unknown",
    readinessReason: null,
    // The relaunch obligation runVerifiedRelaunch installs and the deferred
    // verifier resolves (lifecycle diagram above runVerifiedRelaunch).
    pendingReplacement: null,
    // Consecutive failed liveness probes since /health last answered: the
    // sustained-failure gate in front of doctor --fix. Startup failures count
    // too: at the default threshold (3) the 3-strike startup behaviour is
    // unchanged; a higher threshold also gates startup repair (the effective
    // gate is max(startup strikes, threshold)).
    degradedConsecutiveFailures: 0,
    // Latest verdict of the repair path's relaunch (kRestartVerdicts).
    lastRepairVerdict: null,
    // An exit-1 ownership conflict whose holder was NOT healthy: the ladder
    // consults the kind (state-writer contention gets backoff relaunches
    // only — never doctor --fix, never gateway stop). Cleared by a green
    // probe, a launch, or a benign exit classification.
    incumbentConflict: null,
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
  // Rollback is automatic inside ANY open stabilization window — a non-pin
  // build's, or a freshly bumped pin's (state.pinWindow); long-accepted
  // versions get a notification + CTA instead, so an unrelated crash loop can
  // never blocklist a known-good build. getChannelInfo().stabilization is the
  // single home for that predicate (the legacy isPin/inStabilizationWindow
  // pair is tolerated for older info shapes); the exit-78 branch applies it
  // to an already-taken snapshot, every other path reads live info.
  const rollbackEligibleFrom = (info) => {
    if (!info) return null;
    const s = info.stabilization;
    const inWindow = s
      ? Boolean(s.inWindow)
      : !info.isPin && Boolean(info.inStabilizationWindow);
    return inWindow ? info : null;
  };
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
  // A relaunch that returned NO child because the gateway PRELAUNCH HOOK
  // refused/failed is a fail-closed abort, not EX_CONFIG: gateway.js records
  // the outcome before launchGatewayProcess resolves null, and the installed
  // handler (createGatewayPrelaunchHookHandler → onPrelaunchHook) has already
  // narrated it as degradedReason "prelaunch_hook_failed" and notified the
  // operator. Re-latching configuration_error on that path would tell the
  // operator "fix openclaw.json" for a hook problem, send the EX_CONFIG
  // notification, and arm the mtime auto-retry against the wrong cause.
  // Returns the refused/failed outcome that aborted the last launch, or null.
  const readLastPrelaunchHookOutcome = () => {
    try {
      const read =
        typeof getLastGatewayPrelaunchHookOutcome === "function"
          ? getLastGatewayPrelaunchHookOutcome
          : require("./gateway").getLastGatewayPrelaunchHookOutcome;
      return typeof read === "function" ? read() || null : null;
    } catch {
      return null;
    }
  };
  const prelaunchHookAbortedLaunch = () => {
    const outcome = readLastPrelaunchHookOutcome();
    const status = String(outcome?.status || "");
    return status === "refused" || status === "failed" ? outcome : null;
  };
  // What the config-error paths do INSTEAD of the latch for a hook-aborted
  // relaunch: the gateway is down (nothing launched) so lifecycle reads
  // stopped, the hook reason stays/returns on the status surface, and one
  // ledger row names why the config-error path stood down. The handler
  // already ran onPrelaunchHook for this outcome when it is wired, so the
  // narration is refreshed only when the reason is not already showing (no
  // duplicate degraded row).
  const noteLaunchAbortedByPrelaunchHook = (
    outcome,
    { source, correlationId = undefined } = {},
  ) => {
    state.lifecycle = "stopped";
    state.health = "unhealthy";
    state.uptimeStartedAt = null;
    if (state.degradedReason !== kPrelaunchHookFailedReason) {
      onPrelaunchHook(outcome);
    }
    logEvent(
      "config_error",
      source,
      "skipped",
      {
        reason: "prelaunch_hook_aborted_launch",
        hookStatus: String(outcome?.status || ""),
        code: typeof outcome?.code === "string" ? outcome.code : null,
        site: typeof outcome?.site === "string" ? outcome.site : null,
      },
      correlationId,
    );
  };
  // Ledger detail for the relaunch paths that only log "returned no child":
  // name the hook abort when that is the cause (the real reason otherwise
  // appears only in console.error).
  const noChildDetails = () => {
    const outcome = prelaunchHookAbortedLaunch();
    return {
      reason: "launchGatewayProcess returned no child",
      ...(outcome
        ? {
            prelaunchHook: {
              status: String(outcome.status || ""),
              code: typeof outcome.code === "string" ? outcome.code : null,
            },
          }
        : {}),
    };
  };

  // ── Serving identity ────────────────────────────────────────────────────
  // Launch-generation snapshot (gateway.getLaunchGeneration): null when the
  // seam is not wired (legacy harness) — pending-replacement matching then
  // falls back to the launcher pid and, when neither side carries a
  // generation, to null-leniency (see pendingMatchesLaunch).
  const readLaunchGeneration = () => {
    if (typeof getLaunchGeneration !== "function") return null;
    try {
      const value = getLaunchGeneration();
      return Number.isInteger(value) ? value : null;
    } catch {
      return null;
    }
  };
  const readStartTicksSafe = (pid) => {
    if (pid == null || typeof readProcStartTicks !== "function") return null;
    try {
      const ticks = readProcStartTicks(pid);
      return Number.isInteger(ticks) ? ticks : null;
    } catch {
      return null;
    }
  };
  const clearServingIdentity = () => {
    state.servingPid = null;
    state.servingRootPid = null;
    state.servingStartTicks = null;
    state.servingLaunchGeneration = null;
    // gatewayPid keeps the managed signal across a relaunch window; only a
    // lost ADOPTED identity falls back to detached.
    if (state.supervisionMode === "adopted") state.supervisionMode = "detached";
  };
  const isServingProcess = (pid) =>
    pid != null && (pid === state.servingRootPid || pid === state.servingPid);
  // Adopt a discovered incumbent identity as the serving process. `identity`
  // undefined → scan through the injected dep (null dep = no-op); a scan that
  // finds our own managed child (or the identity already recorded) changes
  // nothing — adoption is for a gateway AlphaClaw did NOT spawn. Routed
  // through onGatewayLaunch so the adopted-while-running rule (identity
  // only, no health/counter/incident reset) lives in one place.
  const adoptDiscoveredIdentity = (identity = undefined) => {
    let found = identity;
    if (found === undefined) {
      if (typeof discoverServingIdentity !== "function") return null;
      try {
        found = discoverServingIdentity();
      } catch {
        return null;
      }
    }
    if (!found || found.rootPid == null) return null;
    if (
      found.rootPid === state.servingRootPid ||
      found.rootPid === state.gatewayPid
    ) {
      return found;
    }
    onGatewayLaunch({
      startedAt: Date.now(),
      pid: null,
      rootPid: found.rootPid,
      servingPid: found.workerPid ?? found.rootPid,
      workerPid: found.workerPid ?? null,
      startTicks: found.startTicks ?? null,
      generation: null,
      supervision: "adopted",
    });
    return found;
  };
  // Memory-tick identity check: the serving root's /proc start ticks must
  // still be the ones recorded at launch/adoption — a different value means
  // the pid was reused by a stranger whose RSS must never enter the trend.
  const servingIdentityLost = (pid) => {
    if (pid == null || pid !== state.servingRootPid) return false;
    if (state.servingStartTicks == null) return false;
    const observed = readStartTicksSafe(pid);
    if (observed == null || observed === state.servingStartTicks) return false;
    logEvent(
      "serving_identity_lost",
      "memory-monitor",
      "failed",
      {
        pid,
        expectedStartTicks: state.servingStartTicks,
        observedStartTicks: observed,
      },
      createCorrelationId(),
    );
    dropServingProcess(pid);
    return true;
  };
  // The serving process is gone (pid reused, or death proven by the probe):
  // drop the identity and stop sampling it. Callers own the idle-state
  // bookkeeping that differs per site.
  const dropServingProcess = (pid) => {
    clearServingIdentity();
    memoryMonitoredPid = null;
    try {
      memoryMonitor.noteProcessExited(Date.now(), pid);
    } catch {}
  };
  // Probe-detected death needs PID evidence (a port-down observation alone is
  // startup, drain, a stall or a socket blip): the serving root is gone or
  // its start ticks changed. Only for an ADOPTED identity — a managed child
  // reports its own exit through onGatewayExit moments later, and acting on
  // the probe first would relaunch twice.
  const servingProcessDeathEvidence = () => {
    if (state.supervisionMode !== "adopted") return null;
    const pid = state.servingRootPid;
    if (pid == null) return null;
    let alive = true;
    try {
      alive = pidAlive(pid) !== false;
    } catch {
      alive = true;
    }
    if (!alive) return { pid, kind: "pid_gone" };
    if (state.servingStartTicks != null) {
      const observed = readStartTicksSafe(pid);
      if (observed != null && observed !== state.servingStartTicks) {
        return {
          pid,
          kind: "start_ticks_changed",
          expectedStartTicks: state.servingStartTicks,
          observedStartTicks: observed,
        };
      }
    }
    return null;
  };

  // ── Pending replacement ─────────────────────────────────────────────────
  //
  //   runVerifiedRelaunch(source, intent)
  //     │ hold invalid ──────────────────────────────▶ skipped {lease_expired}   (no mutation)
  //     │ snapshots the launch-generation watermark FIRST; installs pendingReplacement on arm (a launch handler
  //     │ firing during the call is matched by generation > watermark, never missed;
  //     │ an older unresolved pending books failed {replacement_superseded})
  //     ▼
  //   requestGatewayLaunch({ reconcileIncumbent, shouldAbort: () => !hold.isValid() })
  //     ├ launch_requested ──────────────▶ requested {pid, generation, intent}; pending armed
  //     ├ child_retained
  //     │    relaunch_if_absent ────────▶ skipped {child_retained}   (the probe verifies)
  //     │    replace ──────────────────▶ cold restart (below)
  //     ├ incumbent_present
  //     │    replace ──────────────────▶ cold restart: onExpectedRestart → restartGatewayColdStart
  //     │                                ({shouldAbort}) → onExpectedRestartSettled → requested
  //     │                                | failed {incumbent_gateway_still_running | reason}
  //     │    relaunch_if_absent, healthy, identity root ≠ lastExitedGatewayPid
  //     │                               ▶ skipped {incumbent_adopted} + adoptDiscoveredIdentity
  //     │    relaunch_if_absent, healthy, root === lastExitedGatewayPid (draining corpse)
  //     │                               ▶ spawn alongside (reconcileIncumbent: false)
  //     │    relaunch_if_absent, unhealthy ▶ skipped {incumbent_unhealthy}; degraded ladder owns it
  //     ├ launch_aborted ──────────────▶ failed noChildDetails()  (lease_expired → skipped)
  //     └ launch_failed ───────────────▶ failed {error}
  //
  //   pendingReplacement ─▶ onGatewayLaunch (generation > watermark | pid) ─▶ identity observed
  //                      ─▶ green probe: serving-identity snapshot whose ONLY root is our launcher
  //                      ─▶ healthy + ready + observed ─▶ restart/<source>/ok {verified: true}
  //                                                        (ONLY THEN repairAttempts/crashTimestamps reset)
  //                      ├▶ exit of the pending child ──▶ failed {replacement_exited}, then classification
  //                      ├▶ deadline (ready budget) on a later tick ─▶ failed {replacement_not_ready}
  //                      └▶ newer relaunch (exit-driven or forced) ─▶ failed {replacement_superseded}
  //   A pending blocks tick-driven relaunches (repair, probe death) until it resolves.
  const requestLaunch =
    typeof requestGatewayLaunch === "function"
      ? requestGatewayLaunch
      : async () => {
          const shape = (outcome, fields = {}) => ({
            outcome,
            child: null,
            pid: null,
            generation: null,
            serving: null,
            error: null,
            detail: null,
            ...fields,
          });
          try {
            const child = await launchGatewayProcess();
            return child
              ? shape(kGatewayLaunchOutcomes.LAUNCH_REQUESTED, { child, pid: child.pid ?? null })
              : shape(kGatewayLaunchOutcomes.LAUNCH_ABORTED);
          } catch (error) {
            return shape(kGatewayLaunchOutcomes.LAUNCH_FAILED, {
              error,
              detail: String(error?.message || error),
            });
          }
        };
  // Deduped "up but …" probe rows (readinessPending / replacementPending):
  // the first row of a run logs in full, identical repeats are counted in
  // memory, one summary row lands when the key changes or the run ends.
  let pendingProbeRun = null; // { key, source, marker, count, firstAtMs, lastAtMs }
  const flushPendingProbeRun = () => {
    const run = pendingProbeRun;
    pendingProbeRun = null;
    if (!run || run.count <= 1) return;
    logEvent(
      "health_check",
      run.source,
      "ok",
      {
        ...run.marker,
        repeatedProbes: run.count - 1,
        firstAt: new Date(run.firstAtMs).toISOString(),
        lastAt: new Date(run.lastAtMs).toISOString(),
      },
      createCorrelationId(),
    );
  };
  const countPendingProbeRow = ({ key, source, marker, details, correlationId }) => {
    const now = Date.now();
    if (pendingProbeRun && pendingProbeRun.key === key) {
      pendingProbeRun.count += 1;
      pendingProbeRun.lastAtMs = now;
      return;
    }
    flushPendingProbeRun();
    pendingProbeRun = { key, source, marker, count: 1, firstAtMs: now, lastAtMs: now };
    logEvent("health_check", source, "ok", { ...details, ...marker }, correlationId);
  };
  const describePendingReplacement = (pending) =>
    pending
      ? {
          pid: pending.launcherPid ?? null,
          source: pending.source,
          intent: pending.intent,
          since: pending.requestedAtMs
            ? new Date(pending.requestedAtMs).toISOString()
            : null,
          deadline: pending.deadlineMs
            ? new Date(pending.deadlineMs).toISOString()
            : null,
        }
      : null;
  const noteRepairVerdict = (source, verdict) => {
    if (source === "repair") state.lastRepairVerdict = verdict;
  };
  // Creates the obligation with its generation watermark but does NOT take
  // ownership yet: state.pendingReplacement only moves (superseding a prior
  // obligation) inside armPendingReplacement, i.e. when a spawn or cold
  // restart is actually requested. A relaunch that ends in child_retained,
  // incumbent_adopted, launch_aborted, launch_failed or lease_expired replaced
  // nothing, so the earlier in-flight replacement keeps its right to be
  // verified. A launch payload that fired between the watermark and the arm
  // is retro-matched by generation in armPendingReplacement.
  const installPendingReplacement = ({ source, correlationId, intent }) => {
    const pending = {
      source,
      correlationId,
      intent,
      generationWatermark: readLaunchGeneration(),
      launcherPid: null,
      workerPid: null,
      generation: null,
      requestedAtMs: null,
      deadlineMs: null,
      identityObservedAt: null,
      coldRestart: false,
    };
    return pending;
  };
  const clearPendingReplacement = (pending) => {
    if (state.pendingReplacement === pending) state.pendingReplacement = null;
  };
  const armPendingReplacement = (pending, { pid = null, generation = null, coldRestart = false }) => {
    const prior = state.pendingReplacement;
    if (prior && prior !== pending) {
      logEvent(
        "restart",
        prior.source,
        "failed",
        {
          reason: "replacement_superseded",
          pid: prior.launcherPid ?? null,
          generation: prior.generation ?? null,
          supersededBy: pending.source,
        },
        prior.correlationId,
      );
      noteRepairVerdict(prior.source, kRestartVerdicts.REPLACEMENT_SUPERSEDED);
    }
    state.pendingReplacement = pending;
    const now = Date.now();
    if (pid != null) pending.launcherPid = pid;
    if (generation != null) pending.generation = generation;
    pending.requestedAtMs = now;
    pending.deadlineMs = now + kGatewayRestartReadyTimeoutMs;
    pending.coldRestart = coldRestart;
    // A launch notification that landed between the watermark and this arm
    // (the cold-restart path notifies before returning) already moved the
    // serving generation past the watermark: that launch is ours.
    if (
      !pending.identityObservedAt &&
      pending.generationWatermark != null &&
      state.servingLaunchGeneration != null &&
      state.servingLaunchGeneration > pending.generationWatermark &&
      // A known generation must match exactly: a foreign launch (boot, the
      // restart route) between the watermark and this arm is not ours.
      (pending.generation == null || pending.generation === state.servingLaunchGeneration)
    ) {
      if (pending.generation == null) pending.generation = state.servingLaunchGeneration;
      if (pending.launcherPid == null && state.servingRootPid != null) {
        pending.launcherPid = state.servingRootPid;
      }
      observePendingIdentity(pending);
    }
  };
  const observePendingIdentity = (pending, { rootPid = null, workerPid = null, generation = null } = {}) => {
    pending.identityObservedAt = Date.now();
    if (rootPid != null) pending.launcherPid = rootPid;
    if (workerPid != null) pending.workerPid = workerPid;
    if (generation != null) pending.generation = generation;
  };
  const resolvePendingReplacementReady = (pending) => {
    logEvent(
      "restart",
      pending.source,
      "ok",
      {
        pid: state.servingRootPid ?? pending.launcherPid ?? null,
        servingPid: state.servingPid ?? null,
        generation: pending.generation ?? state.servingLaunchGeneration ?? null,
        intent: pending.intent,
        verified: true,
      },
      pending.correlationId,
    );
    clearPendingReplacement(pending);
    flushPendingProbeRun();
    noteRepairVerdict(pending.source, kRestartVerdicts.REPLACEMENT_READY);
    // The replacement is proven: only now do the repair/crash counters reset
    // (a green answer from an unverified process must not clear them).
    state.repairAttempts = 0;
    state.crashTimestamps = [];
    state.awaitingAutoRepairRecovery = false;
    state.failedReplacement = null;
  };
  const failPendingReplacement = (
    pending,
    reason,
    extra = {},
    verdict = kRestartVerdicts.REPLACEMENT_FAILED,
  ) => {
    logEvent(
      "restart",
      pending.source,
      "failed",
      {
        reason,
        pid: pending.launcherPid ?? null,
        generation: pending.generation ?? null,
        intent: pending.intent,
        ...extra,
      },
      pending.correlationId,
    );
    clearPendingReplacement(pending);
    flushPendingProbeRun();
    noteRepairVerdict(pending.source, verdict);
  };
  // An exit belongs to the pending child when it names the launcher/worker
  // pid or the launch generation. A legacy payload without a pid is the
  // managed child by definition (the only child the legacy shape knows).
  const pendingMatchesExit = (pending, { pid, workerPid = null, generation = null }) =>
    pid == null ||
    (pending.launcherPid != null &&
      (pid === pending.launcherPid || workerPid === pending.launcherPid)) ||
    (pending.workerPid != null &&
      (pid === pending.workerPid || workerPid === pending.workerPid)) ||
    (generation != null &&
      pending.generation != null &&
      generation === pending.generation);
  // A MANAGED launch payload matches by exact generation once ours is known,
  // by generation > watermark only while it is not yet known (a handler that
  // fired during the launch call, before the result filled it in), or by
  // launcher pid. Watermark-before-exact would let a foreign launch (boot,
  // the restart route) with a higher generation pass as ours.
  // Null-leniency — both sides without a generation — exists for the legacy
  // shim + legacy payload pair; production always carries generations.
  const pendingMatchesLaunch = (pending, { pid, rootPid, generation, supervision }) => {
    if (supervision === "adopted" || supervision === "detached") return false;
    if (generation != null && pending.generation != null) {
      return generation === pending.generation;
    }
    if (
      generation != null &&
      pending.generationWatermark != null &&
      generation > pending.generationWatermark
    ) {
      return true;
    }
    const launcher = rootPid ?? pid ?? null;
    if (launcher != null && pending.launcherPid != null) {
      return launcher === pending.launcherPid;
    }
    return (
      generation == null &&
      pending.generation == null &&
      pending.generationWatermark == null
    );
  };
  // Every exit path that returns early (stale predecessor, generation fence)
  // and the main classification share this: the pending child's own exit
  // ends its obligation as replacement_exited, whatever else the exit is.
  const failPendingIfExitMatches = ({ pid, workerPid, generation, code, signal, expectedExit, extra = {} }) => {
    const pending = state.pendingReplacement;
    if (!pending || !pendingMatchesExit(pending, { pid, workerPid, generation })) return false;
    failPendingReplacement(pending, "replacement_exited", {
      code: code ?? null,
      signal: signal ?? null,
      expectedExit,
      ...extra,
    });
    return true;
  };
  // Snapshot exclusivity (the gateway's /health carries no instance id): the
  // pending launcher is the ONLY serving-pattern tree root in /proc, so the
  // green answer can only be ours. A foreign root still alive keeps the
  // pending unobserved; the deadline then decides.
  const tryObservePendingIdentityFromSnapshot = (pending) => {
    if (pending.launcherPid == null || typeof discoverServingIdentity !== "function") {
      return false;
    }
    let identity = null;
    try {
      identity = discoverServingIdentity();
    } catch {
      return false;
    }
    if (!identity || identity.rootPid !== pending.launcherPid) return false;
    observePendingIdentity(pending, identity);
    if (state.servingRootPid !== identity.rootPid) {
      // The child we spawned IS the serving tree: record it as its "listening
      // on" sniff would have (no servingSeq bump — not a lifecycle event).
      state.servingRootPid = identity.rootPid;
      state.servingPid = identity.workerPid ?? identity.rootPid;
      state.servingStartTicks =
        identity.startTicks ?? readStartTicksSafe(identity.rootPid);
      state.servingLaunchGeneration = pending.generation ?? null;
      state.supervisionMode = "managed";
      if (state.gatewayPid == null) state.gatewayPid = identity.rootPid;
      memoryMonitoredPid = identity.rootPid;
    }
    return true;
  };
  // A replacement that missed its ready budget: the port may still answer
  // (an incumbent's), but the gateway we asked for is not proven up.
  const markReplacementNotReady = () => {
    state.health = "unhealthy";
    state.degradedReason = kDegradedReasons.REPLACEMENT_NOT_READY;
  };
  // Evaluated AFTER a tick's probe result has been applied, so identity
  // arriving on the deadline tick still wins. Any unresolved pending — observed
  // or not — past its ready budget is replacement_not_ready.
  const evaluatePendingReplacementDeadline = ({ onExpired = null } = {}) => {
    const pending = state.pendingReplacement;
    if (!pending || pending.deadlineMs == null || Date.now() < pending.deadlineMs) {
      return false;
    }
    failPendingReplacement(pending, "replacement_not_ready", {
      identityObserved: !!pending.identityObservedAt,
      readiness: state.readiness,
    });
    onExpired?.();
    return true;
  };
  // What every relaunch site shares once a NEW child is under way: a fresh
  // failure episode for the probe ladder. Lifecycle/health stay the caller's
  // (a crash relaunch keeps "crashed" until the child reports in or a probe
  // answers; the repair path sets running/unknown as it always did; medic and
  // config retry keep their deliberate "restarting").
  const markRelaunchRequested = () => {
    state.readiness = "unknown";
    state.readinessReason = null;
    state.startupConsecutiveHealthFailures = 0;
    state.degradedConsecutiveFailures = 0;
    // Our own child is under way: the external incumbent's cold-boot grace no
    // longer applies (a conflict exit re-arms it if that incumbent still holds).
    state.incumbentGraceUntilMs = null;
    state.incumbentGracePid = null;
    // A state-writer conflict is LATCHED across its own backoff relaunch: the
    // relaunched contender may re-exit outside the 60s startup window (lock
    // timeout wording) or hang on the lock until the pending deadline, and
    // neither Doctor nor a cold restart can release a writer's lock. Cleared
    // by a green probe, an adoption, or a non-conflict crash classification.
    if (state.incumbentConflict?.kind !== "state_writer_conflict") {
      state.incumbentConflict = null;
    }
  };

  // The one relaunch primitive (diagram above). Never throws; `hold` is the
  // caller's lifecycle-lock release fn (or null), re-checked after every
  // await and handed to the spawn/cold-restart fence as shouldAbort.
  const runVerifiedRelaunch = async ({
    source,
    correlationId = "",
    hold = null,
    intent = "relaunch_if_absent",
  }) => {
    const finish = (verdict, extra = {}) => {
      console.log(`[watchdog] relaunch ${source} (${intent}): ${verdict}`);
      noteRepairVerdict(source, verdict);
      return { verdict, intent, ...extra };
    };
    const leaseExpiredSkip = (extra = {}) => {
      logEvent(
        "restart",
        source,
        "skipped",
        {
          reason: "lease_expired",
          intent,
          expired: typeof hold?.isExpired === "function" ? hold.isExpired() : null,
          ...extra,
        },
        correlationId,
      );
      return finish(kRestartVerdicts.LEASE_EXPIRED);
    };
    if (!holdStillValid(hold)) return leaseExpiredSkip();
    const pending = installPendingReplacement({ source, correlationId, intent });
    const shouldAbort = () => !holdStillValid(hold);

    const applyLaunchOutcome = async (launch, { allowIncumbent }) => {
      const outcome = String(launch?.outcome || kGatewayLaunchOutcomes.LAUNCH_FAILED);
      if (outcome === kGatewayLaunchOutcomes.LAUNCH_REQUESTED) {
        armPendingReplacement(pending, {
          pid: launch.pid ?? launch.child?.pid ?? null,
          generation: launch.generation ?? null,
        });
        markRelaunchRequested();
        logEvent(
          "restart",
          source,
          "requested",
          { pid: pending.launcherPid, generation: pending.generation, intent },
          correlationId,
        );
        return finish(kRestartVerdicts.REPLACEMENT_PENDING, {
          pid: pending.launcherPid,
          generation: pending.generation,
          coldRestart: false,
        });
      }
      if (
        outcome === kGatewayLaunchOutcomes.CHILD_RETAINED ||
        outcome === kGatewayLaunchOutcomes.INCUMBENT_PRESENT
      ) {
        if (intent === "replace") return replaceIncumbent(launch);
        if (outcome === kGatewayLaunchOutcomes.CHILD_RETAINED) {
          clearPendingReplacement(pending);
          logEvent(
            "restart",
            source,
            "skipped",
            {
              reason: "child_retained",
              pid: launch.pid ?? null,
              generation: launch.generation ?? null,
              intent,
            },
            correlationId,
          );
          return finish(kRestartVerdicts.CHILD_RETAINED, { pid: launch.pid ?? null });
        }
        return resolveIncumbentPresent(launch, { allowIncumbent });
      }
      clearPendingReplacement(pending);
      if (outcome === kGatewayLaunchOutcomes.LAUNCH_ABORTED) {
        if (launch.detail === "lease_expired") return leaseExpiredSkip({ detail: launch.detail });
        logEvent("restart", source, "failed", noChildDetails(), correlationId);
        return finish(kRestartVerdicts.LAUNCH_ABORTED, { detail: launch.detail ?? null });
      }
      logEvent(
        "restart",
        source,
        "failed",
        { error: String(launch?.error?.message || launch?.detail || "launch failed") },
        correlationId,
      );
      return finish(kRestartVerdicts.LAUNCH_FAILED, { error: launch?.error ?? null });
    };

    // relaunch_if_absent: the port answers and no child of ours is live.
    const resolveIncumbentPresent = async (launch, { allowIncumbent }) => {
      const healthy = await probeIncumbentHealthy();
      if (!holdStillValid(hold)) {
        clearPendingReplacement(pending);
        return leaseExpiredSkip();
      }
      const identity = launch.serving && launch.serving.rootPid != null ? launch.serving : null;
      if (!healthy) {
        clearPendingReplacement(pending);
        state.lifecycle = "running";
        state.health = "degraded";
        state.degradedReason = kDegradedReasons.INCUMBENT_UNHEALTHY;
        if (!state.degradedSince) state.degradedSince = Date.now();
        // Someone ELSE's gateway holds the port and is not green yet: give it
        // a cold-boot budget before repair may stop it. Not for a port with no
        // identifiable owner, and not for the draining corpse of the process
        // that just exited — neither is a booting gateway to protect.
        const externalHolder =
          identity != null && identity.rootPid !== state.lastExitedGatewayPid;
        if (externalHolder) {
          state.incumbentGraceUntilMs = Date.now() + kGatewayRestartReadyTimeoutMs;
          state.incumbentGracePid = identity.rootPid;
        }
        openIncident("gateway_recovery");
        scheduleDegradedHealthCheck();
        logEvent(
          "restart",
          source,
          "skipped",
          { reason: "incumbent_unhealthy", pid: identity?.rootPid ?? null, intent },
          correlationId,
        );
        return finish(kRestartVerdicts.INCUMBENT_UNHEALTHY, {
          pid: identity?.rootPid ?? null,
        });
      }
      // A healthy answer from the process that just exited is a draining
      // corpse, not an incumbent: adopting it would wait out its drain and
      // one backoff cycle. Spawn alongside; the lock decides.
      const corpse =
        allowIncumbent &&
        identity != null &&
        state.lastExitedGatewayPid != null &&
        identity.rootPid === state.lastExitedGatewayPid;
      if (corpse) {
        const spawn = await requestLaunch({ reconcileIncumbent: false, shouldAbort });
        return applyLaunchOutcome(spawn, { allowIncumbent: false });
      }
      clearPendingReplacement(pending);
      adoptDiscoveredIdentity(identity ?? undefined);
      if (state.lifecycle !== "running") {
        // No discoverable identity: today's shape — the port answer alone
        // makes the gateway "running" with servingPid null.
        state.lifecycle = "running";
        state.health = "unknown";
        state.startupConsecutiveHealthFailures = 0;
        state.crashRecoveryActive = false;
        if (!state.uptimeStartedAt) state.uptimeStartedAt = Date.now();
        startBootstrapHealthChecks();
      }
      logEvent(
        "restart",
        source,
        "skipped",
        {
          reason: "incumbent_adopted",
          pid: identity?.rootPid ?? null,
          servingPid: state.servingPid ?? null,
          intent,
        },
        correlationId,
      );
      return finish(kRestartVerdicts.INCUMBENT_ADOPTED, { pid: identity?.rootPid ?? null });
    };

    // replace: the incumbent IS the problem — recycle it through the verified
    // cold-restart path (gateway stop → --force → ready wait → #59 verdict)
    // under the held lock, bracketed exactly like the memory mitigation.
    const replaceIncumbent = async (launch) => {
      if (typeof coldRestartGateway !== "function") {
        clearPendingReplacement(pending);
        logEvent(
          "restart",
          source,
          "failed",
          { reason: "cold_restart_unavailable", intent },
          correlationId,
        );
        return finish(kRestartVerdicts.REPLACEMENT_FAILED, {
          reason: "cold_restart_unavailable",
        });
      }
      // A replacement is for an UNHEALTHY incumbent. Doctor may have run for
      // minutes: the process answering now may have recovered, or be one the
      // operator started meanwhile. Re-probe before `gateway stop` — a healthy
      // incumbent is retained (our child) or adopted (external), never
      // cold-restarted by a repair. "Healthy" here is STABLE: every probe of
      // the run must answer (the ladder needed consecutive failures to get
      // here; a flapper that answers one probe in two is still the problem,
      // and retaining it would run doctor --fix every cycle without ever
      // replacing anything). The draining corpse of the process that just
      // exited is not an incumbent either.
      const identity =
        launch.serving && launch.serving.rootPid != null ? launch.serving : null;
      const corpse =
        identity != null &&
        state.lastExitedGatewayPid != null &&
        identity.rootPid === state.lastExitedGatewayPid;
      const healthyNow = !corpse && (await probeIncumbentStable());
      if (!holdStillValid(hold)) {
        clearPendingReplacement(pending);
        return leaseExpiredSkip({ phase: "incumbent_probe" });
      }
      if (healthyNow) {
        clearPendingReplacement(pending);
        const retained = launch.outcome === kGatewayLaunchOutcomes.CHILD_RETAINED;
        const pid = retained ? (launch.pid ?? null) : (identity?.rootPid ?? null);
        if (!retained) adoptDiscoveredIdentity(identity ?? undefined);
        if (state.lifecycle !== "running") {
          state.lifecycle = "running";
          state.health = "unknown";
          state.startupConsecutiveHealthFailures = 0;
          state.crashRecoveryActive = false;
          if (!state.uptimeStartedAt) state.uptimeStartedAt = Date.now();
          startBootstrapHealthChecks();
        }
        logEvent(
          "restart",
          source,
          "skipped",
          {
            reason: retained ? "child_retained" : "incumbent_adopted",
            recoveredBeforeReplace: true,
            // A healthy port whose owner /proc cannot name (zero or several
            // serving roots): kept — it answers — but nothing was adopted.
            identityAmbiguous: !retained && identity == null,
            pid,
            servingPid: state.servingPid ?? null,
            intent,
          },
          correlationId,
        );
        return finish(
          retained ? kRestartVerdicts.CHILD_RETAINED : kRestartVerdicts.INCUMBENT_ADOPTED,
          { pid, recovered: true },
        );
      }
      // The expected-restart window opens BEFORE the obligation is armed: the
      // handler supersedes any earlier pending (a route restart does the same
      // to ours), so it must not see the one we are about to install.
      onExpectedRestart({
        expiresAt: Date.now() + kGatewayRestartOperationBudgetMs,
      });
      armPendingReplacement(pending, { coldRestart: true });
      logEvent(
        "restart",
        source,
        "requested",
        {
          pid: null,
          generation: null,
          intent,
          coldRestart: true,
          incumbent: launch.outcome,
          incumbentPid: launch.pid ?? null,
        },
        correlationId,
      );
      recordOperationEvent({
        kind: "gateway_restart",
        status: "started",
        details: { trigger: "repair", source },
      });
      state.incumbentConflict = null;
      const incumbentPid = launch.pid ?? identity?.rootPid ?? null;
      try {
        await coldRestartGateway({ shouldAbort });
        recordOperationEvent({
          kind: "gateway_restart",
          status: "ok",
          details: { trigger: "repair", source },
        });
        if (state.pendingReplacement === pending) {
          if (pending.generation == null) pending.generation = readLaunchGeneration();
          // The cold restart's own verdict (port released or pid replaced)
          // is the identity proof when its launch notification did not
          // reach us first.
          if (!pending.identityObservedAt) observePendingIdentity(pending);
        }
        onExpectedRestartSettled();
        return finish(kRestartVerdicts.REPLACEMENT_PENDING, {
          pid: pending.launcherPid,
          generation: pending.generation,
          coldRestart: true,
        });
      } catch (err) {
        onExpectedRestartSettled();
        const aborted = isCallerAbortError(err);
        const reason =
          err?.incumbent === true
            ? String(err.reason || "incumbent_gateway_still_running")
            : aborted
              ? "lease_expired"
              : String(err?.reason || "cold_restart_failed");
        recordOperationEvent({
          kind: "gateway_restart",
          status: "failed",
          details: {
            trigger: "repair",
            source,
            reason,
            error: String(err?.message || err).slice(0, 400),
          },
        });
        clearPendingReplacement(pending);
        if (aborted) return leaseExpiredSkip({ phase: "cold_restart" });
        logEvent(
          "restart",
          source,
          "failed",
          { reason, error: String(err?.message || err).slice(0, 400), intent },
          correlationId,
        );
        state.health = "unhealthy";
        return finish(kRestartVerdicts.REPLACEMENT_FAILED, { reason, pid: incumbentPid });
      }
    };

    const launch = await requestLaunch({ reconcileIncumbent: true, shouldAbort });
    return applyLaunchOutcome(launch, { allowIncumbent: true });
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
      // A corrupted state file reads as "no hold" — that is not evidence.
      if (holdInfo?.stateCorrupted) return false;
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
    // Take the lifecycle lock BEFORE moving the mtime baseline: a retry that
    // skips because another operation holds the lock must stay armed for the
    // next tick (moving the baseline first would spend this edit's one
    // relaunch on a skip). One deduped skipped row per hold.
    const releaseLifecycleLock = gatewayLifecycleLock
      ? gatewayLifecycleLock.tryAcquire("config_retry")
      : null;
    if (gatewayLifecycleLock && !releaseLifecycleLock) {
      const holdId =
        gatewayLifecycleLock.getActiveOperation?.()?.holdId ?? null;
      const skipKey = `config_retry:${holdId ?? "queued"}`;
      if (configRetrySkipKey !== skipKey) {
        configRetrySkipKey = skipKey;
        logEvent("config_error", "config_changed", "skipped", {
          reason: "lifecycle_operation_in_progress",
          mtimeMs: mtime,
        });
      }
      return false;
    }
    configRetrySkipKey = null;
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
        const relaunch = await runVerifiedRelaunch({
          source: "config_changed",
          hold: releaseLifecycleLock,
          intent: "relaunch_if_absent",
        });
        if (relaunch.verdict === kRestartVerdicts.LAUNCH_ABORTED) {
          // No child: the prelaunch hook aborted the relaunch (fail-closed,
          // not a config error — see noteLaunchAbortedByPrelaunchHook) or the
          // launch was cancelled; only the latter re-latches EX_CONFIG.
          const hookOutcome = prelaunchHookAbortedLaunch();
          if (hookOutcome) {
            noteLaunchAbortedByPrelaunchHook(hookOutcome, {
              source: "config_changed",
            });
            return;
          }
          latchConfigError();
          return;
        }
        if (
          relaunch.verdict === kRestartVerdicts.LAUNCH_FAILED ||
          relaunch.verdict === kRestartVerdicts.LEASE_EXPIRED
        ) {
          latchConfigError();
        }
      } finally {
        releaseLifecycleLock?.();
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
  // Dedupe key of the last config-retry skip (one row per lock hold).
  let configRetrySkipKey = null;
  // Dedupe key of the last repair skip caused by an unresolved pending
  // replacement (one row per pending, per source).
  let lastRepairPendingSkipKey = null;
  // One `repair/skipped {incumbent_startup_grace}` row per grace budget.
  let lastIncumbentGraceSkipKey = null;

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
  //
  //   Escalation (sustained-failure gate): every failing probe — startup or steady state —
  //   bumps degradedConsecutiveFailures (reset when /health answers). The loop's OWN ticks
  //   carry allowAutoRepair, so once the count reaches kWatchdogDegradedRepairThreshold
  //   (default 3 = first miss + f(0) + f(1), ~15s) the tick escalates to runRepair in-tick
  //   (doctor --fix → verified replacement; operationInProgress parks the other probe
  //   sources meanwhile) instead of waiting for the 120s health timer; below it the tick
  //   books repair/degraded_retry/skipped {awaiting_sustained_failure}. operation_end and
  //   repair_verify probes never escalate. Readiness-only degradation never counts.
  //
  //     degraded ──tick fails, n <  threshold──▶ skipped row, re-arm f(attempt)
  //              ──tick fails, n >= threshold──▶ runRepair (in-tick) → operation_end resync
  //              ──adopted serving pid proven dead──▶ crash/probe_death → restartAfterCrash
  //                                                   (crash-restart discipline, no Doctor)
  //              ──state-writer conflict holder──▶ backoff relaunch only (never Doctor)
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
        // The loop's own tick may escalate once the failure is sustained
        // (gate inside runHealthCheck) — that is what turns "first miss →
        // degraded" into "repair ~15s later" without the 120s timer.
        await runHealthCheck({
          source: "degraded_retry",
          allowAutoRepair: true,
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

  // WI-6.4 event hygiene: inside an expected-restart window the bootstrap
  // cadence probes every 5s and every failing probe used to write its own
  // identical `health_check ok {skipped, expectedRestartActive}` row — a
  // 10-minute operation lease could add 120 rows saying the same thing. Now
  // the FIRST row of a run of identical failures (same probe reason) is
  // logged as before, identical repeats are only counted in memory, and ONE
  // summary row lands on the transition (window closed, reason changed).
  // In-memory only: never a DB update on the probe path.
  let restartWindowSkipRun = null; // { reason, source, count, firstAtMs, lastAtMs }

  const flushRestartWindowSkipRun = () => {
    const run = restartWindowSkipRun;
    restartWindowSkipRun = null;
    if (!run || run.count <= 1) return;
    logEvent(
      "health_check",
      run.source,
      "ok",
      {
        reason: run.reason,
        skipped: true,
        expectedRestartActive: true,
        // Summary of the identical probes that followed the logged first row.
        repeatedProbes: run.count - 1,
        firstAt: new Date(run.firstAtMs).toISOString(),
        lastAt: new Date(run.lastAtMs).toISOString(),
      },
      createCorrelationId(),
    );
  };

  // Returns true when this failure is an identical repeat (already counted,
  // nothing to log); false when the caller must log it as the run's first row.
  const countRestartWindowSkip = ({ reason, source }) => {
    const key = String(reason || "");
    const now = Date.now();
    if (restartWindowSkipRun && restartWindowSkipRun.reason === key) {
      restartWindowSkipRun.count += 1;
      restartWindowSkipRun.lastAtMs = now;
      return true;
    }
    flushRestartWindowSkipRun();
    restartWindowSkipRun = { reason: key, source, count: 1, firstAtMs: now, lastAtMs: now };
    return false;
  };

  const clearExpectedRestartWindow = () => {
    state.expectedRestartInProgress = false;
    state.expectedRestartUntilMs = 0;
    flushRestartWindowSkipRun();
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
  //      │  serving root's /proc start ticks ≠ recorded → pid REUSED by a
  //      │      stranger: "no_gateway", identity cleared, one
  //      │      serving_identity_lost row (never sample the reused pid)
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
  //   onExpectedRestart ─▶ restartGatewayColdStart() ─▶ settle in FINALLY
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
        // trades a V8 abort for a kernel OOM kill. An operator budget (issue
        // #56) is a policy line, not a physical limit — name the knob.
        const remedy =
          t.capSource === "heap"
            ? deriveHeapOomRemedy()
            : t.capSource === "budget"
              ? `Pressure is against the operator memory budget (${t.effectiveCapMb ?? "?"} MB, watchdog.memory.budgetMb) — the physical limits are not in play. If the gateway legitimately needs more, raise or clear the budget from the Watchdog tab; if this is the diagnosed leak, the pre-OOM auto-restart (when armed) handles it.`
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
    if (typeof coldRestartGateway !== "function") return;
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
        // Same lease fence as the repair path: a hold force-released mid-stop
        // must not spawn `gateway --force` into the successor's operation.
        await coldRestartGateway({
          shouldAbort: () => !holdStillValid(releaseLifecycleLock),
        });
        recordOperationEvent({
          kind: "gateway_restart",
          status: "ok",
          details: {
            trigger: "memory_mitigation",
            ...(holdStillValid(releaseLifecycleLock) ? {} : { leaseExpiredAfterRestart: true }),
          },
        });
      } catch (err) {
        // Refund the budget stamp — a failed restart mitigated nothing, and
        // two transient failures must not disable protection for 24h. The
        // shorter failure cooldown (above) owns anti-thrash instead. The
        // incumbent verdict (gateway.js GatewayIncumbentRestartError: the
        // CLI stop was refused/ignored and the OLD, leaking gateway still
        // answers the port) arrives as a throw carrying incumbent:true and
        // takes exactly this path — the restart never happened — with its
        // reason named on the record and the notification.
        const incumbent = err?.incumbent === true;
        const abortedByLease = isCallerAbortError(err);
        const reason = incumbent
          ? String(err.reason || "incumbent_gateway_still_running")
          : abortedByLease
            ? "lease_expired"
            : null;
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
            ...(reason ? { reason } : {}),
          },
          correlationId,
        );
        recordOperationEvent({
          kind: "gateway_restart",
          status: "failed",
          details: {
            trigger: "memory_mitigation",
            error: String(err?.message || err).slice(0, 400),
            ...(reason ? { reason } : {}),
          },
        });
        await notify(
          [
            "🐺 *AlphaClaw Watchdog*",
            withViewLogsSuffix("🔴 Pre-OOM gateway restart failed"),
            "Trigger: `memory_leak`",
            ...(reason
              ? [
                  `Reason: \`${reason}\``,
                  abortedByLease
                    ? "The mitigation lost its lifecycle-lock lease before the new gateway was up, so it stood down for the operation that took over; the leak was not mitigated — it will be re-evaluated on the next tick."
                    : "The previous gateway is still running (the stop was refused or ignored), so the leak was not mitigated — retry, or stop the gateway manually.",
                ]
              : []),
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
      if (!pid || servingIdentityLost(pid)) {
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

  // Returns the readiness outcome for applyHealthyProbeResult:
  //   { probed: false }                       readyz unavailable / transport error
  //   { probed: true, degraded, reason }      reason names the failing components
  const evaluateChannelSuppression = async (source, correlationId) => {
    const readiness = await probeGatewayReadiness();
    if (!readiness.ok) return { probed: false, degraded: false, reason: null };
    // Surface "gateway up but degraded" signals (event loop wedged, or providers/
    // channels reported failing on /readyz) so the Watchdog UI can show that a green
    // /health does not mean fully healthy. Read-only: does not drive restart/rollback.
    state.eventLoopDegraded = readiness.eventLoopDegraded === true;
    state.readyzFailing = Array.isArray(readiness.failing)
      ? readiness.failing.map((entry) => String(entry || "")).filter(Boolean)
      : [];
    // 1.8: green /health + degraded readiness → health reads "degraded" so
    // the UI never shows a plain green dot over a wedged event loop or failing
    // components. Deliberately does NOT set degradedSince: readiness
    // degradation only re-checks; it never drives repair or the rollback
    // timer. The acceptance hooks are the caller's business —
    // applyHealthyProbeResult step 4 calls onUnhealthy on a not-ready tick
    // (D4) so a green-/health, failing-/readyz build is never promoted.
    const readinessDegraded =
      state.eventLoopDegraded || state.readyzFailing.length > 0;
    const readinessOutcome = {
      probed: true,
      degraded: readinessDegraded,
      reason: readinessDegraded
        ? [...state.readyzFailing, state.eventLoopDegraded ? "event loop" : ""]
            .filter(Boolean)
            .join(", ")
            .slice(0, 200)
        : null,
    };
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
      if (!changed) return readinessOutcome;
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
      return readinessOutcome;
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
    return readinessOutcome;
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
    // kWatchdogMaxRepairAttempts is advisory (TODOS): the notice is the
    // signal, from both failure shapes (Doctor failed / relaunch failed).
    const notifyIfRepairAttemptsExhausted = async () => {
      if (state.repairAttempts < kWatchdogMaxRepairAttempts) return;
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
    };
    if (state.configurationErrorActive && !force) {
      return { ok: false, skipped: true, reason: "configuration_error" };
    }
    if (!force && !state.autoRepair) {
      return { ok: false, skipped: true, reason: "auto_repair_disabled" };
    }
    if (!force && state.awaitingAutoRepairRecovery) {
      return { ok: false, skipped: true, reason: "awaiting_health_recovery" };
    }
    // A latched state-writer conflict (another OpenClaw process holds the
    // state directory) is not a config problem: `doctor --fix` cannot release
    // it and a `replace` cold restart would `gateway stop` a process that is
    // not the holder. The backoff relaunch ladder owns recovery; one ledger
    // row per distinct source keeps the incident legible.
    if (!force && state.incumbentConflict?.kind === "state_writer_conflict") {
      if (state.lastConflictRepairSkipSource !== source) {
        state.lastConflictRepairSkipSource = source;
        logEvent(
          "repair",
          source,
          "skipped",
          {
            reason: "state_writer_conflict",
            holderPid: state.incumbentConflict.holderPid ?? null,
            holderRole: state.incumbentConflict.holderRole ?? null,
          },
          correlationId,
        );
      }
      return { ok: false, skipped: true, reason: "state_writer_conflict" };
    }
    state.lastConflictRepairSkipSource = null;
    // An EXTERNAL incumbent that holds the port/state directory but is not
    // green yet keeps its cold-boot budget: `replace` would `gateway stop` a
    // gateway that is still coming up. Gated here (not only in the ladder) so
    // the crash_loop callers honour it too; a manual repair does not. One
    // ledger row per budget; the grace ends early when the holder is gone.
    if (!force && incumbentGraceActive()) {
      const graceKey = String(state.incumbentGraceUntilMs);
      if (lastIncumbentGraceSkipKey !== graceKey) {
        lastIncumbentGraceSkipKey = graceKey;
        logEvent(
          "repair",
          source,
          "skipped",
          {
            reason: "incumbent_startup_grace",
            until: new Date(state.incumbentGraceUntilMs).toISOString(),
            holderPid: state.incumbentGracePid ?? null,
            failures: state.degradedConsecutiveFailures,
          },
          correlationId,
        );
      }
      return { ok: false, skipped: true, reason: "incumbent_startup_grace" };
    }
    // Fail-closed under a reconciler gateway hold (issue #20): doctor --fix
    // would rewrite the exact config the hold protects and relaunch on it
    // without clearing state.gatewayHold. A manual (forced) repair is NOT the
    // escape hatch here — the Upgrade page's retry / strip-consent flow is.
    // The read itself fails closed too (see maybeRetryAfterConfigChange:
    // channelInfo() maps a read ERROR to null, indistinguishable from "no
    // hold"), so this reads the hooks directly. Placed after the silent
    // gates so a latched/paused watchdog does not write a ledger row per tick.
    if (typeof releaseChannelHooks?.getInfo === "function") {
      let holdInfo = null;
      let unreadable = null;
      try {
        holdInfo = releaseChannelHooks.getInfo() || null;
      } catch (err) {
        // Ledger detail only (admin surface + overseer input): capped, never a
        // raw multi-line dump.
        unreadable = String(err?.message || err).replace(/\s+/g, " ").slice(0, 200);
      }
      if (unreadable == null && holdInfo?.stateCorrupted) {
        unreadable = "state file corrupted";
      }
      const holdReason =
        unreadable != null
          ? "gateway_hold_unreadable"
          : holdInfo?.gatewayHold
            ? "gateway_held"
            : null;
      if (holdReason) {
        // Automatic sources re-enter on every unhealthy tick while the state
        // file stays torn; one ledger row per distinct refusal keeps the
        // incident ledger (and the overseer that reads it) legible. Manual
        // repairs always log — the operator asked.
        const skipKey = `${source}:${holdReason}:${unreadable || ""}`;
        if (source === "manual" || state.lastRepairHoldSkipKey !== skipKey) {
          state.lastRepairHoldSkipKey = skipKey;
          logEvent(
            "repair",
            source,
            "skipped",
            { reason: holdReason, ...(unreadable != null ? { error: unreadable } : {}) },
            correlationId,
          );
        }
        return { ok: false, skipped: true, reason: holdReason };
      }
      state.lastRepairHoldSkipKey = null;
    }
    if (state.operationInProgress) {
      return { ok: false, skipped: true, reason: "operation_in_progress" };
    }
    // A pending replacement past its ready budget must not block repair for
    // the rest of that budget when probes have stopped (crash_loop, config
    // latch): settle it here, before the gate below reads it — and only
    // OUTSIDE an in-flight operation (gate above): a cold-restart replace
    // arms its pending before the stop/preflight and may legitimately still
    // be running when that deadline lapses; failing it from a manual repair
    // would strand the operation's own obligation.
    evaluatePendingReplacementDeadline({ onExpired: markReplacementNotReady });
    // An unresolved pending replacement blocks tick-driven repair: a child
    // we just relaunched (or cold-restarted) is still inside its ready
    // budget, and a Doctor + replace on top of it would recycle a gateway
    // that may be seconds from ready. Only its exit or the deadline ends the
    // obligation; a forced (manual) repair supersedes it instead.
    if (!force && state.pendingReplacement) {
      const pending = state.pendingReplacement;
      const skipKey = `${source}:${pending.source}:${pending.requestedAtMs ?? ""}`;
      if (lastRepairPendingSkipKey !== skipKey) {
        lastRepairPendingSkipKey = skipKey;
        logEvent(
          "repair",
          source,
          "skipped",
          {
            reason: "replacement_pending",
            pendingSource: pending.source,
            pid: pending.launcherPid ?? null,
            generation: pending.generation ?? null,
          },
          correlationId,
        );
      }
      return { ok: false, skipped: true, reason: "replacement_pending" };
    }
    lastRepairPendingSkipKey = null;
    // Serialize with route restarts / channel applies / boot: background
    // recovery SKIPS when another lifecycle operation holds the lock — a
    // repair must never run doctor mutations or launch a gateway under a
    // live restart. Leased at the Doctor ceiling PLUS the cold-restart budget:
    // a `replace` that follows a full-length doctor run must still own the
    // lock (the default lease equalled the Doctor ceiling alone).
    const releaseLifecycleLock = gatewayLifecycleLock
      ? gatewayLifecycleLock.tryAcquire("repair", {
          leaseMs: kRepairTimeoutMs + kGatewayRestartOperationBudgetMs,
        })
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
      const result = repairRunner
        ? await repairRunner({ correlationId })
        : await clawCmd("doctor --fix --yes", {
            quiet: true,
            timeoutMs: kRepairTimeoutMs,
          });
      // The lock may have been force-released while Doctor ran (lease
      // expiry): a successor may own the gateway now, so nothing below may
      // launch or mutate lifecycle/attempt state.
      if (!holdStillValid(releaseLifecycleLock)) {
        logEvent(
          "repair",
          source,
          "skipped",
          { reason: "lease_expired", doctorOk: !!result?.ok },
          correlationId,
        );
        return { ok: false, skipped: true, reason: "lease_expired" };
      }
      if (state.configurationErrorActive && !force) {
        return { ok: false, skipped: true, reason: "configuration_error" };
      }
      const ok = !!result?.ok;
      logEvent("repair", source, ok ? "ok" : "failed", result, correlationId);
      if (ok) {
        // The incumbent IS the problem after a sustained degradation:
        // `replace` recycles a live one through the verified cold-restart
        // path and spawns fresh when nothing answers. No counter reset here —
        // repairAttempts/crashTimestamps/awaitingAutoRepairRecovery reset only
        // when the verifier records replacement_ready.
        const relaunch = await runVerifiedRelaunch({
          source: "repair",
          correlationId,
          hold: releaseLifecycleLock,
          intent: "replace",
        });
        const verdict = relaunch.verdict;
        if (verdict === kRestartVerdicts.LEASE_EXPIRED) {
          return {
            ok: false,
            skipped: true,
            reason: "lease_expired",
            verdict,
            launchedGateway: false,
            result,
          };
        }
        // The incumbent answered the pre-replace probe healthy (it recovered
        // during Doctor, or the operator restarted it): nothing to replace —
        // the verify probe below certifies it like any green tick.
        const retained =
          verdict === kRestartVerdicts.CHILD_RETAINED ||
          verdict === kRestartVerdicts.INCUMBENT_ADOPTED;
        if (verdict !== kRestartVerdicts.REPLACEMENT_PENDING && !retained) {
          // launch_aborted / launch_failed / replacement_failed: Doctor ran
          // but nothing replaced the gateway — an honest failure, never
          // "awaiting health check". Lifecycle stays as the failure left it.
          // Counted like a failed Doctor run, and (automatic sources) the
          // ladder waits for a recovery before another repair: a wedged
          // incumbent that refuses `gateway stop` must not re-run
          // doctor --fix + stop on every failing tick.
          state.health = "unhealthy";
          state.repairAttempts += 1;
          if (source !== "manual") {
            state.pendingRecoveryNoticeSource = source;
            state.awaitingAutoRepairRecovery = true;
            // The ladder lifts this latch itself once the incumbent it could
            // not replace is gone (pidGone).
            state.failedReplacement = {
              pid: relaunch.pid ?? null,
              verdict,
              at: Date.now(),
            };
          }
          await notifyAutoRepairOutcome({
            source,
            correlationId,
            ok: false,
            attempts: state.repairAttempts,
          });
          await notifyIfRepairAttemptsExhausted();
          return {
            ok: false,
            reason: verdict,
            verdict,
            verifiedHealthy: false,
            launchedGateway: false,
            pending: false,
            result,
          };
        }
        // A fresh spawn reads running/unknown until the verify probe (as
        // before); a cold restart's lifecycle belongs to its launch
        // notification and settle probe (restarting → running | stopped); a
        // retained/adopted incumbent keeps whatever the probe said.
        if (!relaunch.coldRestart && !retained) {
          state.health = "unknown";
          state.lifecycle = "running";
        }
        const verify = await runHealthCheck({
          allowDuringOperation: true,
          source: "repair_verify",
          allowAutoRepair: false,
        });
        // Green + ready + identity-clear, and not the mid-restart
        // short-circuit: only that certifies the replacement.
        const verifiedHealthy = !!(
          verify &&
          verify.probeOk &&
          verify.healthy &&
          verify.ready &&
          verify.identityClear &&
          !verify.midRestart
        );
        await notifyAutoRepairOutcome({
          source,
          correlationId,
          ok: true,
          verifiedHealthy,
          attempts: state.repairAttempts,
        });
        // Either way this is the verify-miss latch (a relaunched child not yet
        // proven), not a failed replacement: the lift-by-pid rule must not
        // apply to it.
        state.failedReplacement = null;
        if (!verifiedHealthy && source !== "manual") {
          state.pendingRecoveryNoticeSource = source;
          state.awaitingAutoRepairRecovery = true;
        } else {
          state.pendingRecoveryNoticeSource = "";
          state.awaitingAutoRepairRecovery = false;
        }
        // Read AFTER the verify probe: a replacement the verifier already
        // certified reports replacement_ready, not the pre-probe pending.
        const settledVerdict = state.lastRepairVerdict ?? verdict;
        return {
          ok: true,
          verifiedHealthy,
          launchedGateway: !retained,
          pending: settledVerdict === kRestartVerdicts.REPLACEMENT_PENDING,
          verdict: settledVerdict,
          result,
        };
      }

      state.repairAttempts += 1;
      state.health = "unhealthy";
      await notifyAutoRepairOutcome({
        source,
        correlationId,
        ok: false,
        attempts: state.repairAttempts,
      });
      await notifyIfRepairAttemptsExhausted();
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

  // Structured result for a PASSED liveness probe. Truthiness stays "the
  // liveness probe passed" for every legacy call site (bootstrap loop, settle
  // demotion, resume-channels, …): a failed probe returns false, a passed one
  // returns this object. runRepair reads the fields — verifiedHealthy needs
  // probeOk && healthy && ready && identityClear && !midRestart.
  const probePassed = (fields = {}) => ({
    probeOk: true,
    healthy: state.health === "healthy",
    ready: state.readiness === "ready",
    identityClear:
      !state.pendingReplacement || !!state.pendingReplacement.identityObservedAt,
    midRestart: false,
    verdict: null,
    ...fields,
  });

  // Success branch of runHealthCheck — ordering is the contract:
  //
  //   probe ok ─▶ liveness writes ─▶ evaluateChannelSuppression (try/catch)
  //                    │                     │ threw → readiness "unknown" + one
  //                    │                     │         readiness_probe_error row (fails open)
  //                    ▼                     ▼
  //          readiness ready / unknown   readiness not_ready
  //                    │                     │
  //   identity gate: pendingReplacement unobserved? ─▶ health_check/ok {replacementPending}
  //                    │  (liveness only: no recovery, no incident close, no onHealthy,
  //                    │   no counter reset; deadline evaluated after this result)
  //                    ▼                     ▼
  //   recovery row + notice           health = degraded (readiness), degradedReason
  //   closeIncident()                 readiness_failing; gateway_readiness incident opens
  //   health_check/ok row             when none is open; readiness_degraded/failed row
  //   resetDegradedRetryBackoff()     (evaluateChannelSuppression, on transition);
  //   onHealthy()                     health_check/ok {readinessPending} (deduped);
  //   verify pending → ok {verified}  onUnhealthy(); one "up but not ready" notice;
  //     + counter reset               incident stays open; next tick re-evaluates
  //
  //   Impossible by construction: a recovery notice with health != healthy; onHealthy
  //   with readiness not_ready; restart ok without an observed identity.
  const applyHealthyProbeResult = async ({
    source,
    correlationId,
    parsed,
    servingSeqAtStart,
  }) => {
    const wasUnhealthy = state.health !== "healthy";
    const recoveredFromCrashLoop = state.lifecycle === "crash_loop";
    const shouldNotifyRecovery =
      !!activeIncidentKey ||
      recoveredFromCrashLoop ||
      !!state.pendingRecoveryNoticeSource ||
      state.awaitingAutoRepairRecovery;
    // 1. Liveness: /health answered. These writes describe the PORT (healthy,
    // running, backoff over, conflict released) whoever answers it; recovery,
    // the incident close, onHealthy and the repair/crash counter reset wait
    // for the identity gate (3) below.
    state.startupConsecutiveHealthFailures = 0;
    state.degradedConsecutiveFailures = 0;
    // Keep the retry counter: readiness below can re-degrade (green /health,
    // failing /readyz) and re-arm in this tick.
    clearDegradedHealthCheckTimer({ resetBackoff: false });
    clearExpectedRestartWindow();
    state.health = "healthy";
    state.lifecycle = "running";
    state.degradedSince = null;
    state.degradedReason = null;
    state.lastExit = null;
    state.prelaunchHook = null;
    state.backoffUntilMs = 0;
    state.backoffAttempt = 0;
    state.healthConfirmedSinceLaunch = true;
    state.incumbentConflict = null;
    state.incumbentGraceUntilMs = null;
    state.incumbentGracePid = null;
    state.conflictRelaunchTimestamps = [];
    state.lastConflictRepairSkipSource = null;
    // A healthy build may legitimately need a rollback for a LATER incident.
    state.channelRollbackRequested = false;
    if (!state.uptimeStartedAt || wasUnhealthy)
      state.uptimeStartedAt = Date.now();
    state.crashRecoveryActive = false;
    // 2. Readiness BEFORE recovery: a green /health over a failing /readyz
    // must not announce recovery, close the incident or feed acceptance.
    let readinessOutcome = null;
    let readinessError = null;
    try {
      readinessOutcome = await evaluateChannelSuppression(source, correlationId);
    } catch (err) {
      readinessError = err;
    }
    // A launch, exit or stop landing during the readiness await owns state
    // now — this probe's verdict is stale.
    if (state.servingSeq !== servingSeqAtStart || state.lifecycle !== "running") {
      return probePassed({ identityClear: false });
    }
    if (readinessError) {
      state.readiness = "unknown";
      state.readinessReason = null;
      logEvent(
        "readiness_probe_error",
        source,
        "failed",
        { error: String(readinessError?.message || readinessError).slice(0, 200) },
        correlationId,
      );
    } else if (!readinessOutcome?.probed) {
      state.readiness = "unknown";
      state.readinessReason = null;
    } else {
      state.readiness = readinessOutcome.degraded ? "not_ready" : "ready";
      state.readinessReason = readinessOutcome.degraded
        ? readinessOutcome.reason
        : null;
    }
    // 3. Identity gate: while a replacement is pending and unobserved, this
    // green answer may be an incumbent's — record liveness only.
    const pending = state.pendingReplacement;
    if (pending && !pending.identityObservedAt) {
      tryObservePendingIdentityFromSnapshot(pending);
    }
    if (pending && !pending.identityObservedAt) {
      countPendingProbeRow({
        key: `replacement:${pending.launcherPid ?? "?"}:${pending.generation ?? "?"}`,
        source,
        correlationId,
        marker: {
          replacementPending: true,
          pid: pending.launcherPid ?? null,
          generation: pending.generation ?? null,
        },
        details: parsed.details || { ok: true },
      });
      evaluatePendingReplacementDeadline({ onExpired: markReplacementNotReady });
      return probePassed({
        identityClear: false,
        verdict: state.pendingReplacement
          ? kRestartVerdicts.REPLACEMENT_PENDING
          : kRestartVerdicts.REPLACEMENT_FAILED,
      });
    }
    // 4. Up but not ready: liveness recovered, readiness did not.
    if (state.readiness === "not_ready") {
      if (!activeIncidentKey) openIncident("gateway_readiness");
      const reason = state.readinessReason || "readiness checks failing";
      countPendingProbeRow({
        key: `readiness:${reason}`,
        source,
        correlationId,
        marker: { readinessPending: true, readinessReason: reason },
        details: parsed.details || { ok: true },
      });
      state.degradedReason = kDegradedReasons.READINESS_FAILING;
      // A green /health over a failing /readyz must not be promoted: the
      // acceptance clock hears "unhealthy" (degradedSince stays untouched —
      // readiness alone never arms the rollback timer).
      try {
        releaseChannelHooks?.onUnhealthy?.();
      } catch {}
      // `reason` echoes /readyz component names (gateway/plugin-controlled
      // text): strip link/markup syntax before it reaches the alert channel.
      await notifyOncePerIncident(
        "gateway_not_ready",
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix(
            `🟡 Gateway is up but not ready — ${sanitizeNotificationText(reason).replace(
              /\bhttps?:\/\/\S+/gi,
              "[link removed]",
            )}`,
          ),
        ].join("\n"),
        correlationId,
        "health_check",
        { verbose: true },
      );
      // A pending that expires on a not-ready tick keeps readiness_failing as
      // the reason (the port answers; the components are what is wrong) —
      // the failed row still names replacement_not_ready.
      evaluatePendingReplacementDeadline();
      return probePassed({
        verdict: pending
          ? state.pendingReplacement
            ? kRestartVerdicts.REPLACEMENT_PENDING
            : kRestartVerdicts.REPLACEMENT_FAILED
          : null,
      });
    }
    // 5. Healthy and identity-clear: recovery.
    flushPendingProbeRun();
    if (shouldNotifyRecovery) {
      logEvent(
        "recovery",
        source,
        "ok",
        {
          previousLifecycle: recoveredFromCrashLoop ? "crash_loop" : null,
          previousRecoverySource: state.pendingRecoveryNoticeSource || null,
          health: "healthy",
        },
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
    // The recovery notice latch ends with the recovery (it must not re-fire
    // every tick while a verified-but-not-yet-ready replacement waits);
    // repairAttempts/crashTimestamps wait for replacement_ready below.
    state.awaitingAutoRepairRecovery = false;
    state.failedReplacement = null;
    closeIncident();
    logEvent(
      "health_check",
      source,
      "ok",
      parsed.details || { ok: true },
      correlationId,
    );
    resetDegradedRetryBackoff();
    try {
      releaseChannelHooks?.onHealthy?.();
    } catch {}
    // 6. Deferred replacement verification: identity observed + ready. Only
    // the obligation this tick captured AND still owns is resolved — two
    // concurrent probes (or a probe racing an exit / a newer relaunch) must
    // not book `ok {verified: true}` twice or reset counters for a
    // replacement that already failed or was superseded across the awaits.
    let verdict = null;
    if (pending && state.pendingReplacement === pending) {
      if (state.readiness === "ready") {
        resolvePendingReplacementReady(pending);
        verdict = kRestartVerdicts.REPLACEMENT_READY;
      } else {
        // Readiness unknown (D5): recovery proceeds, the obligation stays
        // open until a ready probe or the deadline.
        verdict = evaluatePendingReplacementDeadline({ onExpired: markReplacementNotReady })
          ? kRestartVerdicts.REPLACEMENT_FAILED
          : kRestartVerdicts.REPLACEMENT_PENDING;
      }
    } else {
      state.repairAttempts = 0;
    }
    return probePassed({ verdict });
  };

  // Probe-detected death of an ADOPTED gateway (pid evidence only — see
  // servingProcessDeathEvidence): no exit event will ever arrive for it, so
  // the probe path books the crash itself and relaunches under the crash-
  // restart discipline. Doctor is never consulted for a dead process.
  const handleProbeDetectedDeath = ({ correlationId, evidence, probeReason }) => {
    const pid = evidence.pid;
    dropServingProcess(pid);
    try {
      memoryIdleState = "no_gateway";
      noteMemoryTrendState("no_gateway");
    } catch {}
    state.lastExitedGatewayPid = pid;
    handleCrashExit({
      code: null,
      signal: null,
      stderrTail: [],
      correlationId,
      source: "probe_death",
      reason: "process_gone",
      evidence: { ...evidence, probeReason: String(probeReason || "").slice(0, 200) },
    });
  };

  // State-writer contention (another embedded OpenClaw writer holds the state
  // directory) is transient and outside the gateway's control: neither
  // Doctor nor `gateway stop` can resolve it. Sustained failure under it gets
  // backoff relaunches only, capped like a crash loop into a latched notice.
  const relaunchAfterStateWriterConflict = async (correlationId) => {
    if (state.operationInProgress || state.pendingReplacement) return;
    if (state.lifecycle !== "running") return;
    const windowStart = Date.now() - kWatchdogCrashLoopWindowMs;
    state.conflictRelaunchTimestamps = state.conflictRelaunchTimestamps.filter(
      (ts) => ts >= windowStart,
    );
    state.conflictRelaunchTimestamps.push(Date.now());
    if (state.conflictRelaunchTimestamps.length >= kWatchdogCrashLoopThreshold) {
      state.lifecycle = "crash_loop";
      state.health = "unhealthy";
      openIncident("gateway_recovery");
      logEvent(
        "crash_loop",
        "state_writer_conflict",
        "failed",
        {
          relaunchesInWindow: state.conflictRelaunchTimestamps.length,
          windowMs: kWatchdogCrashLoopWindowMs,
          holderPid: state.incumbentConflict?.holderPid ?? null,
          holderRole: state.incumbentConflict?.holderRole ?? null,
        },
        correlationId,
      );
      void notifyOncePerIncident(
        "state_writer_conflict_latched",
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix(
            "🔴 Gateway could not start — another OpenClaw process keeps the state directory locked",
          ),
          `Relaunch attempts: ${state.conflictRelaunchTimestamps.length} in the last ${Math.floor(kWatchdogCrashLoopWindowMs / 1000)}s`,
          "Automatic gateway restart paused; manual action required — stop the other OpenClaw process, then use Retry from the Watchdog tab.",
        ].join("\n"),
        correlationId,
        "crash",
      );
      return;
    }
    await restartAfterCrash(correlationId, { source: "state_writer_conflict" });
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
    const servingSeqAtStart = state.servingSeq;
    const correlationId = createCorrelationId();
    state.lastHealthCheckAt = new Date().toISOString();
    state.lastHealthCheckAtMs = Date.now();
    healthProbeSeq += 1;
    const parsed = await probeGatewayHealth();
    // The gateway may exit with EX_CONFIG while a probe is in flight. Keep the
    // latched configuration-error state from being overwritten by that result.
    if (state.configurationErrorActive) return false;
    // A launch that landed mid-probe (gatewayStartedAt moved, or the serving
    // identity changed) owns state: this probe answered for a predecessor.
    const staleAfterRestart =
      (gatewayStartedAtAtStart != null &&
        state.gatewayStartedAt != null &&
        state.gatewayStartedAt !== gatewayStartedAtAtStart) ||
      state.servingSeq !== servingSeqAtStart;
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
      // The result stays truthy (liveness passed) but never certifies a
      // replacement: midRestart is the caller's tell.
      if (restartWindowActive && state.lifecycle === "restarting") {
        logEvent(
          "health_check",
          source,
          "ok",
          { ok: true, midRestart: true, expectedRestartActive: true },
          correlationId,
        );
        return probePassed({
          healthy: false,
          ready: false,
          identityClear: false,
          midRestart: true,
        });
      }
      return applyHealthyProbeResult({
        source,
        correlationId,
        parsed,
        servingSeqAtStart,
      });
    }
    if (restartWindowActive) {
      state.startupConsecutiveHealthFailures = 0;
      clearDegradedHealthCheckTimer();
      // Identical repeat inside the window: counted, not logged (WI-6.4).
      if (countRestartWindowSkip({ reason: parsed.reason, source })) return false;
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

    // Every counted failure — startup or steady state — feeds the sustained-
    // failure gate below; /health answering resets it.
    state.degradedConsecutiveFailures += 1;
    // Probe-detected death (adopted identity, pid evidence): no exit event
    // will come, so book the crash here and relaunch — never Doctor. Skipped
    // while a replacement is already pending (its own deadline decides).
    if (!state.pendingReplacement && state.lifecycle === "running") {
      const evidence = servingProcessDeathEvidence();
      if (evidence) {
        handleProbeDetectedDeath({
          correlationId,
          evidence,
          probeReason: parsed.reason,
        });
        return false;
      }
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
    // /health stopped answering: whatever /readyz said last is stale.
    state.readiness = "unknown";
    state.readinessReason = null;
    // A latched ownership conflict — or an external incumbent inside its
    // cold-boot grace — names the cause better than probe prose; the enum
    // survives until the latch/grace clears (green probe / relaunch).
    if (!state.incumbentConflict && !(state.incumbentGraceUntilMs > Date.now())) {
      state.degradedReason = String(parsed.reason || "").slice(0, 200) || null;
    }
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
        ...(state.degradedConsecutiveFailures > 0
          ? { consecutiveFailures: state.degradedConsecutiveFailures }
          : {}),
      },
      correlationId,
    );
    // A pending replacement past its ready budget while the port is down: the
    // obligation ends here (replacement_not_ready) so the ladder below may
    // escalate instead of being blocked by a dead pending.
    evaluatePendingReplacementDeadline();
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
      // While a build stabilizes inside an open window, rollback owns
      // recovery: unattended `doctor --fix` must not mutate state under a
      // build we may be about to abandon (openclaw#107226).
      if (!rollbackFellThrough) return false;
    }
    // State-writer contention: relaunch with backoff, never Doctor.
    if (
      allowAutoRepair &&
      state.incumbentConflict?.kind === "state_writer_conflict"
    ) {
      void relaunchAfterStateWriterConflict(correlationId);
      return false;
    }
    if (!state.autoRepair || !allowAutoRepair) return false;
    // A failed `replace` latched the ladder until a recovery — but a recovery
    // can never come once the incumbent it could not replace is gone (the
    // operator killed the wedged gateway the notice named). Nothing is left
    // to replace, so a relaunch is safe: lift the latch. Pid evidence only —
    // a TCP "port closed" would also be true for launch_failed/aborted (no
    // pid) and would turn this into a repair per degraded tick.
    const failedReplacement = state.awaitingAutoRepairRecovery ? state.failedReplacement : null;
    if (failedReplacement && pidGone(failedReplacement.pid)) {
      logEvent(
        "repair",
        source,
        "ok",
        {
          latchLifted: true,
          reason: "nothing_left_to_replace",
          pid: failedReplacement.pid ?? null,
          failedVerdict: failedReplacement.verdict ?? null,
        },
        correlationId,
      );
      state.awaitingAutoRepairRecovery = false;
      state.pendingRecoveryNoticeSource = "";
      state.failedReplacement = null;
    }
    if (state.awaitingAutoRepairRecovery) return false;
    // Sustained-failure gate: one transient timeout is not an incident. The
    // degraded ladder re-probes first; Doctor runs only once the failure has
    // held for degradedRepairThreshold consecutive probes.
    if (state.degradedConsecutiveFailures < degradedRepairThreshold) {
      logEvent(
        "repair",
        source,
        "skipped",
        {
          reason: "awaiting_sustained_failure",
          failures: state.degradedConsecutiveFailures,
          threshold: degradedRepairThreshold,
        },
        correlationId,
      );
      return false;
    }
    // (The external incumbent's cold-boot grace is a runRepair gate, so the
    // crash_loop callers honour it too.)
    await runRepair({ source, correlationId });
    return false;
  };

  // "Nothing left to replace/protect": the pid we could not stop (or the
  // holder the grace protects) is gone. Pid evidence only, dep-tolerant (a
  // throwing probe or a null pid means "unknown", never "gone").
  const pidGone = (pid) => {
    if (pid == null) return false;
    try {
      return pidAlive(pid) === false;
    } catch {
      return false;
    }
  };
  // The grace stands only while its holder is alive.
  const incumbentGraceActive = () => {
    if (!state.incumbentGraceUntilMs || Date.now() >= state.incumbentGraceUntilMs) return false;
    if (pidGone(state.incumbentGracePid)) {
      state.incumbentGraceUntilMs = null;
      state.incumbentGracePid = null;
      return false;
    }
    return true;
  };

  const restartAfterCrash = async (
    correlationId,
    { source = "exit_event" } = {},
  ) => {
    if (state.operationInProgress) return;
    // Exponential backoff on repeat crashes: a gateway that dies instantly
    // must not hot-loop relaunch (each relaunch drags the plugin preflight
    // with it). min(30s, 1s * 2^recentCrashes) from the crash window. The
    // backoff does NOT hold operationInProgress — a crash-loop repair firing
    // mid-backoff takes precedence and this relaunch bails on the re-check.
    // Managed operations keep their own 10s relaunch cadence (no doubling).
    if (!state.managedOperationActive) {
      trimCrashWindow();
      // The state-writer ladder counts in its own window (it never feeds
      // crashCountInWindow) but backs off on the same curve.
      const recentCrashes =
        source === "state_writer_conflict"
          ? state.conflictRelaunchTimestamps.length
          : state.crashTimestamps.length;
      if (recentCrashes > 1) {
        const backoffMs = Math.min(30000, 1000 * 2 ** (recentCrashes - 1));
        state.backoffUntilMs = Date.now() + backoffMs;
        state.backoffAttempt = recentCrashes;
        logEvent(
          "restart",
          source,
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
        source,
        "skipped",
        { reason: "lifecycle_operation_in_progress" },
        correlationId,
      );
      return;
    }
    state.operationInProgress = true;
    try {
      // requested → pending replacement; the deferred verifier books `ok`
      // once the new child is proven to be the process answering the port.
      await runVerifiedRelaunch({
        source,
        correlationId,
        hold: releaseLifecycleLock,
        intent: "relaunch_if_absent",
      });
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
      // contradict the latch that follows. Ownership is asked of the lock
      // itself (release.isValid), never inferred from elapsed time against
      // the default constant — an overridden lease is honoured.
      if (!holdStillValid(releaseLifecycleLock)) {
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
      const relaunch = await runVerifiedRelaunch({
        source: "medic",
        correlationId,
        hold: releaseLifecycleLock,
        intent: "relaunch_if_absent",
      });
      // An aborted launch is the prelaunch hook's fail-closed abort (or a
      // shutdown cancel) — not a second EX_CONFIG. The hook path stands down
      // without the latch or its notification (the hook handler already
      // notified); a failed, cancelled or lease-expired launch keeps latching.
      const hookOutcome =
        relaunch.verdict === kRestartVerdicts.LAUNCH_ABORTED
          ? prelaunchHookAbortedLaunch()
          : null;
      if (hookOutcome) {
        noteLaunchAbortedByPrelaunchHook(hookOutcome, {
          source: "medic",
          correlationId,
        });
      } else if (
        relaunch.verdict === kRestartVerdicts.LAUNCH_ABORTED ||
        relaunch.verdict === kRestartVerdicts.LAUNCH_FAILED ||
        relaunch.verdict === kRestartVerdicts.LEASE_EXPIRED
      ) {
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

  // Shared by the deferred exit resolvers (resolveExitAfterIncumbentProbe:
  // step-aside, ownership conflict, supervised clean exit) and by
  // runVerifiedRelaunch's incumbent_present branch — which runs under the
  // held lifecycle lock, so it spends up to kStepAsideHealthProbeAttempts ×
  // kGatewayHealthTimeoutMs inside the hold. Bounded probe attempts against
  // the incumbent's /health; a throwing probe reads as unhealthy (fail-safe
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
  // All-of-N twin of the above: every probe must answer. Used where a single
  // green answer must not stand down a replacement (a flapping incumbent).
  const probeIncumbentStable = async () => {
    try {
      for (
        let attempt = 0;
        attempt < kStepAsideHealthProbeAttempts;
        attempt += 1
      ) {
        const probe = await probeGatewayHealth();
        if (probe?.ok !== true) return false;
      }
      return true;
    } catch {
      return false;
    }
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

  // One benign-exit applier for the three "the incumbent keeps the port"
  // classifications — duplicateLaunch (sync, port/listener wording),
  // stepAside (exit 78 + healthy incumbent probe) and incumbentConflict
  // (exit 1 ownership wording + healthy incumbent probe): no latch, no
  // rollback, no medic run, no crash accounting, no notification. The
  // incumbent's identity is adopted when discoverable (no-op otherwise), so
  // the memory monitor and pid-reuse guard cover it.
  const applyBenignExitClassification = ({
    kind,
    code,
    signal,
    stderrTail,
    correlationId,
    conflict = null,
  }) => {
    state.lifecycle = "running";
    state.health = "unknown";
    state.crashRecoveryActive = false;
    state.startupConsecutiveHealthFailures = 0;
    state.incumbentConflict = null;
    if (!state.uptimeStartedAt) {
      state.uptimeStartedAt = Date.now();
    }
    startBootstrapHealthChecks();
    logEvent(
      "restart",
      "exit_event",
      "ok",
      {
        [kind]: true,
        code: code ?? null,
        signal: signal ?? null,
        stderrTail,
        ...(conflict ? { conflict: describeConflict(conflict) } : {}),
      },
      correlationId,
    );
    adoptDiscoveredIdentity();
  };

  // Ledger/status shape of an ownership conflict: the family plus what the
  // stderr line named about the holder — never the stderr text itself.
  const describeConflict = (conflict) => ({
    kind: conflict.kind,
    holderPid: conflict.holderPid ?? null,
    holderRole: conflict.holderRole ?? null,
  });

  // The incumbent's exit-1 ownership conflict was NOT corroborated by a
  // healthy port: the holder has the state directory but nobody serves.
  // Degraded + incident + ONE notice naming the case (pid/role only — stderr
  // stays in the ledger row); no crash count, no blind relaunch into the
  // conflict. Escalation differs by kind: a gateway holder that stays
  // unhealthy is replaced by repair (`intent: replace` after the sustained
  // gate); a state-writer holder gets backoff relaunches only.
  const applyUnhealthyIncumbentConflict = ({
    conflict,
    code,
    signal,
    stderrTail,
    correlationId,
  }) => {
    const stateWriter = conflict.kind === "state_writer_conflict";
    state.lifecycle = "running";
    state.health = "degraded";
    state.degradedReason = stateWriter
      ? kDegradedReasons.STATE_WRITER_CONFLICT
      : kDegradedReasons.GATEWAY_CONFLICT_UNHEALTHY;
    // onGatewayExit nulled degradedSince before classification; this IS a
    // degradation, so the "Degraded for" clock and the rollback deadline
    // start now, not one probe later.
    if (!state.degradedSince) state.degradedSince = Date.now();
    state.crashRecoveryActive = false;
    state.startupConsecutiveHealthFailures = 0;
    state.incumbentConflict = { ...describeConflict(conflict), at: Date.now() };
    // The holder is coming up (or wedged): a cold-boot budget before repair
    // may `gateway stop` it — upstream takes the lock before /health is green.
    // Re-checked against the holder's liveness on every failing tick.
    state.incumbentGraceUntilMs = Date.now() + kGatewayRestartReadyTimeoutMs;
    state.incumbentGracePid = conflict.holderPid ?? null;
    openIncident("gateway_recovery");
    scheduleDegradedHealthCheck();
    logEvent(
      "restart",
      "exit_event",
      "skipped",
      {
        reason: "incumbent_conflict_unhealthy",
        conflict: describeConflict(conflict),
        code: code ?? null,
        signal: signal ?? null,
        stderrTail,
      },
      correlationId,
    );
    const holder = conflict.holderPid != null ? `pid ${conflict.holderPid}` : "pid unknown";
    // The role is a closed token by construction (classifyOwnershipConflict);
    // sanitize anyway — it is stderr text reaching the alert channel.
    const role = sanitizeNotificationText(conflict.holderRole || "state writer", 40);
    void notifyOncePerIncident(
      stateWriter ? "state_writer_conflict" : "gateway_conflict_unhealthy",
      [
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix(
          stateWriter
            ? `🟡 Another OpenClaw process (${role}, ${holder}) holds the state directory — the gateway will be relaunched once it releases`
            : `🔴 Another gateway (${holder}) holds the state directory but is not healthy — not relaunching into the conflict`,
        ),
      ].join("\n"),
      correlationId,
      "crash",
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

  // The one deferred resolver behind every "corroborate the exit against the
  // incumbent" classification: owns the in-flight flag, the bounded /health
  // probe, the stale-token discard and the settle. Callers supply what a
  // healthy / unhealthy incumbent means for THEIR exit shape.
  const resolveExitAfterIncumbentProbe = async ({
    probeToken,
    onHealthy,
    onUnhealthy,
  }) => {
    state.pendingExitClassification = true;
    try {
      const healthy = await probeIncumbentHealthy();
      if (pendingExitProbeStale(probeToken)) return;
      if (healthy) onHealthy();
      else onUnhealthy();
    } finally {
      settlePendingExitClassification(probeToken);
    }
  };

  // Deferred exit-78 resolution: the step-aside stderr signature and startup
  // window already matched; the third signal is a healthy /health probe of
  // the incumbent (a signature alone could be a stale or dying incumbent).
  // All three signals → treat like the duplicate-launch branch. Probe
  // unhealthy, unreachable, or throwing → the EXISTING config-error flow
  // (rollback snapshot → medic → latch), unchanged.
  const resolveStepAsideExit = ({
    code,
    signal,
    stderrTail,
    correlationId,
    probeToken,
  }) =>
    resolveExitAfterIncumbentProbe({
      probeToken,
      onHealthy: () =>
        applyBenignExitClassification({
          kind: "stepAside",
          code,
          signal,
          stderrTail,
          correlationId,
        }),
      onUnhealthy: () =>
        handleConfigErrorExit({ code, signal, stderrTail, correlationId }),
    });

  // Deferred exit-1 ownership-conflict resolution (gap 4): the losing
  // contender printed lock/ownership wording inside the startup window; a
  // healthy incumbent on the port makes its exit benign (whoever held the
  // lock), no healthy gateway means the holder is the problem.
  const resolveOwnershipConflictExit = ({
    conflict,
    code,
    signal,
    stderrTail,
    correlationId,
    probeToken,
  }) =>
    resolveExitAfterIncumbentProbe({
      probeToken,
      onHealthy: () =>
        applyBenignExitClassification({
          kind: "incumbentConflict",
          conflict,
          code,
          signal,
          stderrTail,
          correlationId,
        }),
      onUnhealthy: () =>
        applyUnhealthyIncumbentConflict({
          conflict,
          code,
          signal,
          stderrTail,
          correlationId,
        }),
    });

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
      await resolveExitAfterIncumbentProbe({
        probeToken,
        onHealthy: () =>
          applyBenignExitClassification({
            kind: "stepAside",
            code,
            signal,
            stderrTail,
            correlationId,
          }),
        onUnhealthy: () =>
          handleCrashExit({ code, signal, stderrTail, correlationId }),
      });
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
    // existing config). For a build still inside an open stabilization
    // window (channel or freshly bumped pin), roll back instead of latching —
    // the latch would otherwise silently defeat channel rollback (the exit
    // never reaches crash accounting).
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

  const handleCrashExit = ({
    code,
    signal,
    stderrTail,
    correlationId,
    // "exit_event" for a managed child's exit; "probe_death" when the probe
    // path proved an adopted serving pid dead (rows and the relaunch source
    // carry it so the ledger names how the death was observed).
    source = "exit_event",
    reason = null,
    evidence = null,
  }) => {
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
      source,
      "failed",
      {
        code: code ?? null,
        signal: signal ?? null,
        stderrTail,
        // The crashed process's identity — the incident tracker uses it to
        // correlate a frozen leak-episode summary to THIS crash instead of
        // trusting the time window alone.
        pid: state.lastExitedGatewayPid ?? null,
        ...(reason ? { reason } : {}),
        ...(evidence ? { evidence } : {}),
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
        source,
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
          // operation_in_progress, a still-unverified replacement with
          // replacement_pending, and a lost lease with lease_expired — all
          // transient (kTransientRepairSkipReasons); keep retrying on a short
          // cadence (bounded) instead of silently dropping the repair the
          // notification promised.
          const scheduleRetry = (attempt) => {
            if (attempt > 5) return;
            const retryTimer = setTimeout(() => {
              void runRepair({
                source: "crash_loop_retry",
                correlationId,
              }).then((retryResult) => {
                if (
                  retryResult?.skipped &&
                  kTransientRepairSkipReasons.has(retryResult?.reason)
                ) {
                  scheduleRetry(attempt + 1);
                }
              });
            }, 2000);
            if (typeof retryTimer.unref === "function") retryTimer.unref();
          };
          if (result?.skipped && kTransientRepairSkipReasons.has(result?.reason)) {
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
    void restartAfterCrash(correlationId, { source });
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
    // The launch generation this child was spawned under (gateway.js spawn
    // counter; null for a legacy payload) — the exit fence below.
    generation = null,
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
      // A pending child stopped by a route restart drains after the successor
      // took gatewayPid: still its exit — end the obligation here too.
      failPendingIfExitMatches({
        pid,
        workerPid,
        generation,
        code,
        signal,
        expectedExit,
        extra: { stalePredecessor: true },
      });
      return;
    }
    // Generation fence: an UNEXPECTED late exit of an older launch (a
    // launcher that died after "listening on" moved the identity to its
    // successor) must not re-arm the crash window or the restart ladder for
    // the gateway that is serving now. Both generations known and the exit's
    // older → record and stop. A relaunch that dies before it ever served
    // carries a generation ≥ the serving one and classifies normally.
    if (
      generation != null &&
      state.servingLaunchGeneration != null &&
      generation < state.servingLaunchGeneration
    ) {
      logEvent(
        "restart",
        "exit_event",
        "ok",
        {
          expectedExit,
          stalePredecessor: true,
          generation,
          currentGeneration: state.servingLaunchGeneration,
          pid,
          currentPid: state.servingRootPid ?? state.gatewayPid ?? null,
          code: code ?? null,
          signal: signal ?? null,
        },
        createCorrelationId(),
      );
      // The fenced exit may be the pending child itself (a foreign launch
      // moved the serving generation past ours): its obligation ends here,
      // or it would block repair until the deadline.
      failPendingIfExitMatches({
        pid,
        workerPid,
        generation,
        code,
        signal,
        expectedExit,
        extra: { stalePredecessor: true },
      });
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
      pid == null ||
      (state.gatewayPid == null && state.servingRootPid == null) ||
      pid === state.gatewayPid ||
      isServingProcess(pid) ||
      isServingProcess(workerPid);
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
    // The serving identity ends with its process (root or worker; a legacy
    // payload without a pid IS the managed child). gatewayPid keeps today's
    // semantics — retained across the relaunch window.
    if (pid == null || isServingProcess(pid) || isServingProcess(workerPid)) {
      clearServingIdentity();
    }
    // Every exit supersedes any pending async classification from an earlier
    // exit; the token captured here guards this exit's own deferrals.
    const probeToken = advancePendingExitProbeToken();
    const correlationId = createCorrelationId();
    clearDegradedHealthCheckTimer();
    clearSafeModeState();
    state.degradedSince = null;
    flushPendingProbeRun();
    // The pending replacement's own child exited: the obligation fails as
    // replacement_exited, then the exit classifies normally below (crash,
    // expected restart, benign — whatever it was).
    failPendingIfExitMatches({ pid, workerPid, generation, code, signal, expectedExit });
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
      // Synchronous by contract (tests pin it): the listener/port wording
      // alone is conclusive — the incumbent answered the bind.
      applyBenignExitClassification({
        kind: "duplicateLaunch",
        code,
        signal,
        stderrTail,
        correlationId,
      });
      return;
    }
    // Exit-1 ownership conflict (gap 4): the state-ownership / gateway-lock
    // wording family a LOSING contender prints — never EADDRINUSE, because
    // upstream acquires ownership before the bind. Inside the startup window
    // the exit is corroborated against the incumbent asynchronously (same
    // protocol as the exit-78 step-aside); a requested rollback owns
    // recovery and skips the probe. Outside the window: today's crash flow.
    if (
      code === 1 &&
      !state.channelRollbackRequested &&
      (withinStepAsideStartupWindow(launchedAt) ||
        state.incumbentConflict?.kind === "state_writer_conflict")
    ) {
      const conflict = classifyConflictSafe(stderrTail);
      if (conflict) {
        void resolveOwnershipConflictExit({
          conflict,
          code,
          signal,
          stderrTail,
          correlationId,
          probeToken,
        });
        return;
      }
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

  // Exit-1 ownership-conflict classification over the stderr tail (dep null
  // or throwing → no classification; the exit takes today's crash flow).
  const classifyConflictSafe = (stderrTail) => {
    if (typeof classifyOwnershipConflict !== "function") return null;
    const text = (Array.isArray(stderrTail) ? stderrTail : [])
      .map((line) => String(line ?? ""))
      .join("\n");
    if (!text) return null;
    try {
      return classifyOwnershipConflict(text) || null;
    } catch {
      return null;
    }
  };

  // Launch notification (gateway.setGatewayLaunchHandler). Payload:
  //   { startedAt, pid, servingPid, rootPid, workerPid, startTicks, generation,
  //     supervision: "managed" | "adopted" | "detached" }
  //   pid        the child AlphaClaw spawned (gatewayPid — the UI's managed
  //              signal); null for adopted/detached
  //   rootPid    process-tree root (launcher/supervisor) → servingRootPid,
  //              the memory sampler's subtree root
  //   servingPid / workerPid   the process answering the port → servingPid
  //   generation gateway.js's spawn counter → servingLaunchGeneration (the
  //              exit fence); null for adopted
  // Fenced and idempotent: a payload whose generation is OLDER than the
  // serving one is a delayed notification from a predecessor and is ignored;
  // a payload for the CURRENT (generation, rootPid) neither bumps servingSeq
  // nor resets state — it may only enrich servingPid with a later-resolved
  // worker. "adopted" while lifecycle is already running updates identity
  // only (an unhealthy incumbent stays visibly unhealthy); every other case
  // is today's full launch reset. A pending replacement is matched here
  // (identity observed) so the next green + ready probe can certify it.
  const onGatewayLaunch = ({
    startedAt = Date.now(),
    pid = null,
    servingPid = null,
    rootPid = null,
    workerPid = null,
    startTicks = null,
    generation = null,
    supervision = "managed",
  } = {}) => {
    const mode =
      supervision === "adopted" || supervision === "detached"
        ? supervision
        : "managed";
    const nextRoot = rootPid ?? pid ?? null;
    const nextServing = workerPid ?? servingPid ?? nextRoot;
    if (
      generation != null &&
      state.servingLaunchGeneration != null &&
      generation < state.servingLaunchGeneration
    ) {
      logEvent(
        "restart",
        "launch_event",
        "skipped",
        {
          reason: "stale_launch_generation",
          generation,
          currentGeneration: state.servingLaunchGeneration,
          pid: nextRoot,
        },
        createCorrelationId(),
      );
      return;
    }
    if (
      nextRoot != null &&
      nextRoot === state.servingRootPid &&
      (mode === "adopted" ? null : generation) === state.servingLaunchGeneration
    ) {
      // Idempotent redelivery (managed: same generation + root; adopted: same
      // root, generation null on both sides); the worker may resolve later
      // than the root.
      if (nextServing != null && nextServing !== state.servingPid) {
        state.servingPid = nextServing;
      }
      return;
    }
    const alreadyRunning = state.lifecycle === "running";
    state.servingSeq += 1;
    state.servingPid = nextServing;
    state.servingRootPid = nextRoot;
    state.servingStartTicks = startTicks ?? readStartTicksSafe(nextRoot);
    state.servingLaunchGeneration = mode === "adopted" ? null : generation;
    state.supervisionMode = mode;
    // Subtree root, not the worker: `gateway run` forks the worker that
    // holds the real heap and the sampler walks the tree from the root.
    memoryMonitoredPid = nextRoot;
    flushPendingProbeRun();
    const pending = state.pendingReplacement;
    if (
      pending &&
      !pending.identityObservedAt &&
      pendingMatchesLaunch(pending, { pid, rootPid: nextRoot, generation, supervision: mode })
    ) {
      observePendingIdentity(pending, {
        rootPid: nextRoot,
        workerPid: workerPid ?? null,
        generation,
      });
    }
    if (mode === "adopted" && alreadyRunning) {
      // Identity only: adoption never resets health, degraded counters or the
      // incident of a gateway that is already being watched.
      if (!state.uptimeStartedAt) state.uptimeStartedAt = startedAt;
      return;
    }
    advancePendingExitProbeToken();
    clearDegradedHealthCheckTimer();
    state.configurationErrorActive = false;
    state.medicAttempts = 0;
    // A real launch happened, so an earlier hook-aborted launch is history.
    clearPrelaunchHookFailure();
    state.lifecycle = "running";
    state.health = "unknown";
    state.readiness = "unknown";
    state.readinessReason = null;
    state.startupConsecutiveHealthFailures = 0;
    state.degradedConsecutiveFailures = 0;
    state.incumbentConflict = null;
    // A managed launch of ours is on the port now: the external incumbent's
    // cold-boot grace no longer applies.
    state.incumbentGraceUntilMs = null;
    state.incumbentGracePid = null;
    state.crashRecoveryActive = false;
    clearExpectedRestartWindow();
    state.uptimeStartedAt = startedAt;
    state.gatewayStartedAt = startedAt;
    state.healthConfirmedSinceLaunch = false;
    // The child AlphaClaw spawned — set only by launches (null for an
    // adopted/detached incumbent), retained across the relaunch window.
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
    advancePendingExitProbeToken();
    clearDegradedHealthCheckTimer();
    clearSafeModeState();
    flushPendingProbeRun();
    // A planned restart (route, mitigation, the repair's own cold restart)
    // stops whatever we relaunched: an open obligation can never be proven
    // now, and left standing it would keep every green probe liveness-only
    // for the rest of its budget. Supersede it; the restart's own launch
    // notification carries the next identity.
    if (state.pendingReplacement) {
      failPendingReplacement(
        state.pendingReplacement,
        "replacement_superseded",
        { supersededBy: "expected_restart" },
        kRestartVerdicts.REPLACEMENT_SUPERSEDED,
      );
    }
    state.lifecycle = "restarting";
    state.health = "unknown";
    state.readiness = "unknown";
    state.readinessReason = null;
    state.uptimeStartedAt = null;
    state.startupConsecutiveHealthFailures = 0;
    state.degradedConsecutiveFailures = 0;
    state.incumbentConflict = null;
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

  // Gateway prelaunch hook outcome (gateway.js setGatewayPrelaunchHookHandler,
  // composed in lib/server.js via createGatewayPrelaunchHookHandler). Shape:
  // { status: "ran"|"refused"|"failed", code, hookPath, message, site,
  //   durationMs, exitCode, signal }.
  //   refused|failed → the launch at `site` was ABORTED (nothing new is
  //                    running): degradedReason names it and ONE
  //                    health_check/failed row opens/appends the degraded
  //                    incident (watchdog-incidents.js classifies exactly that
  //                    row as "open"); the next successful launch or healthy
  //                    probe clears both, and that probe's ok row closes it.
  //   ran            → clears an earlier failure (this launch proceeds).
  // No phase change: the phase enum stays at its 15 values — the phase the
  // latches already derive (stopped / crash_backoff / healthy for a refused
  // light restart of a live gateway) is narrated by the new reason instead.
  // Display-only like every degradedReason: the ladder never reads it.
  const clearPrelaunchHookFailure = () => {
    if (state.degradedReason === kPrelaunchHookFailedReason) {
      state.degradedReason = null;
    }
    state.prelaunchHook = null;
  };

  const onPrelaunchHook = (outcome = {}) => {
    const status = String(outcome?.status || "");
    if (status === "ran") {
      clearPrelaunchHookFailure();
      return;
    }
    if (status !== "refused" && status !== "failed") return;
    const site = String(outcome.site || "launch").slice(0, 60);
    const code = typeof outcome.code === "string" ? outcome.code.slice(0, 80) : null;
    state.prelaunchHook = {
      status,
      code,
      site,
      hookPath: typeof outcome.hookPath === "string" ? outcome.hookPath : null,
      message: String(outcome.message || "").slice(0, 200) || null,
      at: new Date().toISOString(),
    };
    state.degradedReason = kPrelaunchHookFailedReason;
    logEvent(
      "health_check",
      "prelaunch_hook",
      "failed",
      {
        reason: kPrelaunchHookFailedReason,
        launchAborted: true,
        hookStatus: status,
        code,
        site,
        hookPath: state.prelaunchHook.hookPath,
        exitCode: Number.isFinite(outcome.exitCode) ? outcome.exitCode : null,
        signal: typeof outcome.signal === "string" ? outcome.signal : null,
        durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : null,
        message: state.prelaunchHook.message,
      },
      createCorrelationId(),
    );
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
    state.degradedConsecutiveFailures = 0;
    state.readiness = "unknown";
    state.readinessReason = null;
    // Nothing is known about who serves until a launch notification arrives
    // (boot around an incumbent adopts; a managed launch is "managed").
    if (state.servingRootPid == null) state.supervisionMode = "detached";
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
    state.degradedConsecutiveFailures = 0;
    state.awaitingAutoRepairRecovery = false;
    state.failedReplacement = null;
    state.pendingRecoveryNoticeSource = "";
    // A stopped watchdog verifies nothing: the obligation dies with it, and
    // so does the external incumbent's grace.
    state.pendingReplacement = null;
    state.incumbentGraceUntilMs = null;
    state.incumbentGracePid = null;
    flushPendingProbeRun();
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
    const legacyStabilizationEndsAt =
      rollbackInfo &&
      !rollbackInfo.stabilization &&
      Number(rollbackInfo.acceptedAt) > 0 &&
      rollbackInfo.applied?.acceptedSource !== "manual"
        ? Number(rollbackInfo.acceptedAt) + kOpenclawStabilizationWindowMs
        : null;
    const stabilizationEndsAt = rollbackInfo?.stabilization
      ? Number(rollbackInfo.stabilization.endsAt) || null
      : legacyStabilizationEndsAt;
    const stabilizationUntil =
      stabilizationEndsAt > 0 ? new Date(stabilizationEndsAt).toISOString() : null;
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
      // Serving identity + readiness axis (v0.9.75). Stable scalars/ISO only
      // (SSE frame dedupe): who answers the port, how it is supervised, what
      // /readyz said last, and the relaunch obligation still unverified.
      servingPid: state.servingPid,
      servingRootPid: state.servingRootPid,
      supervisionMode: state.supervisionMode,
      readiness: state.readiness,
      readinessReason: state.readinessReason,
      replacementPending: describePendingReplacement(state.pendingReplacement),
      lastRepairVerdict: state.lastRepairVerdict,
      degradedRepairThreshold,
      // Latched exit-1 ownership conflict (kind + what stderr named about the
      // holder) and the external incumbent's cold-boot grace, so the UI can
      // say "blocked by another process" instead of "running doctor repair".
      incumbentConflict: state.incumbentConflict
        ? describeConflict(state.incumbentConflict)
        : null,
      incumbentGraceUntil:
        state.incumbentGraceUntilMs && state.incumbentGraceUntilMs > now
          ? new Date(state.incumbentGraceUntilMs).toISOString()
          : null,
      safeMode: state.safeMode,
      suppressedChannels: [...state.suppressedChannels],
      eventLoopDegraded: state.eventLoopDegraded,
      readyzFailing: [...state.readyzFailing],
      degradedSince: state.degradedSince
        ? new Date(state.degradedSince).toISOString()
        : null,
      degradedReason: state.degradedReason,
      lastExit: state.lastExit,
      // Stable strings/ISO only (frame-dedupe safe), null unless a hook
      // aborted the last launch.
      prelaunchHook: state.prelaunchHook,
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
    onPrelaunchHook,
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

// The handler lib/server.js installs via gateway.setGatewayPrelaunchHookHandler
// — one composition, kept here (not inline in server.js) so it is testable:
//   every outcome  → ledger row (operation kind "prelaunch_hook", status
//                    ran|refused|failed) + watchdog.onPrelaunchHook
//   refused|failed → ONE important-class operator notification (untagged,
//                    never verbose — an aborted launch is exactly what an
//                    operator must hear about), deduped by the outbox on
//                    `prelaunch-hook-<code>-<site>-<hour bucket>`: a boot
//                    loop inside one hour collapses to one notice, while a
//                    fresh incident hours later re-alerts (a delivered outbox
//                    entry never revives, so a time-free id would silence
//                    every later independent failure at that site). `notify`
//                    is the upgradeNotifier.notify shape (message, opts) and
//                    is fire-and-forget here: gateway.js calls the handler
//                    synchronously inside a launch and only logs a throw.
const kPrelaunchHookNotifyBucketMs = 60 * 60 * 1000;
const createGatewayPrelaunchHookHandler = ({
  watchdog,
  notify = null,
  nowFn = Date.now,
} = {}) => {
  if (!watchdog || typeof watchdog.recordOperationEvent !== "function") {
    throw new TypeError("createGatewayPrelaunchHookHandler: watchdog is required");
  }
  return (outcome = {}) => {
    const status = String(outcome?.status || "");
    const code = typeof outcome?.code === "string" ? outcome.code : null;
    const site = String(outcome?.site || "launch");
    watchdog.recordOperationEvent({
      kind: "prelaunch_hook",
      status,
      details: {
        code,
        hookPath: outcome?.hookPath ?? null,
        site,
        durationMs: outcome?.durationMs ?? null,
        exitCode: outcome?.exitCode ?? null,
        signal: outcome?.signal ?? null,
        message: outcome?.message ?? null,
      },
    });
    if (status !== "ran" && typeof notify === "function") {
      const message = [
        "🐺 *AlphaClaw Watchdog*",
        "🔴 Gateway launch aborted by the prelaunch hook",
        `Reason: \`${code || status || "unknown"}\``,
        `Site: ${site}`,
        ...(outcome?.message ? [`Detail: ${String(outcome.message).slice(0, 300)}`] : []),
        "The gateway was not started. Fix the hook (ALPHACLAW_GATEWAY_PRELAUNCH_HOOK), then restart the gateway.",
      ].join("\n");
      try {
        Promise.resolve(
          notify(message, {
            eventType: "prelaunch_hook",
            id: `prelaunch-hook-${code || status}-${site.replace(/\s+/g, "-")}-${Math.floor(
              nowFn() / kPrelaunchHookNotifyBucketMs,
            )}`,
          }),
        ).catch((err) => {
          console.warn(
            `[alphaclaw] prelaunch-hook notification failed: ${String(err?.message || err)}`,
          );
        });
      } catch (err) {
        console.warn(
          `[alphaclaw] prelaunch-hook notification failed: ${String(err?.message || err)}`,
        );
      }
    }
    watchdog.onPrelaunchHook?.(outcome);
  };
};

module.exports = {
  createWatchdog,
  createGatewayPrelaunchHookHandler,
  resolveMemoryMitigationBrake,
  // Relaunch verdict vocabulary (runVerifiedRelaunch / getStatus().lastRepairVerdict).
  kRestartVerdicts,
  kDegradedReasons,
};
