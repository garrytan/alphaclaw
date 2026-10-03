const fs = require("fs");
const path = require("path");
const { kGatewayStateStaleMs } = require("./constants");

// One derived, user-facing gateway state. The underlying model is four
// orthogonal axes — availability (TCP + health), operation-in-flight,
// supervision (managed/adopted/detached), restart-required — reconciled by a
// pure reducer into a single headline. Internal enum names NEVER render: the
// catalog below is the single source for public labels, dot semantics, and
// glossary copy (UI popovers and notifications both read it).
//
// Precedence (deterministic; the design doc carries the full table):
//   not_onboarded / booting / boot_failed gate first,
//   then unknown (stale inputs) > config_error > down > flapping
//   > degraded > safe_mode > starting > running.
// An active operation rides along as a structured badge; it never changes
// the headline (a repair over an Unstable gateway shows both).
//
const kDot = (color, motion) => ({ color, motion });

const kSupervisionModes = new Set(["managed", "adopted", "detached"]);

const kGatewayStateCatalog = {
  not_onboarded: {
    label: "Not set up yet",
    dot: kDot("gray", "steady"),
    glossary: "AlphaClaw has not been onboarded. Run the setup wizard.",
  },
  booting: {
    label: "AlphaClaw starting",
    dot: kDot("cyan", "pulse"),
    glossary:
      "AlphaClaw is running its boot sequence (channel sync, gateway launch). Normally under a minute.",
  },
  boot_failed: {
    label: "Startup failed",
    dot: kDot("red", "steady"),
    glossary:
      "The boot sequence hit an error. Inspect Restart options, or check the logs for the failing step.",
  },
  unknown: {
    label: "Status unavailable",
    dot: kDot("gray", "hollow"),
    glossary:
      "AlphaClaw has no fresh observation of the gateway. Refresh, or check that AlphaClaw itself is healthy. Restart is still available.",
  },
  config_error: {
    label: "Configuration error",
    dot: kDot("red", "steady"),
    glossary:
      "OpenClaw rejected its configuration (exit 78). Fix the config, then retry — automatic restarts are paused.",
  },
  down: {
    label: "Down",
    dot: kDot("red", "steady"),
    glossary:
      "The gateway is not running and no restart is in progress. Inspect Restart or Repair options.",
  },
  starting: {
    label: "Starting",
    dot: kDot("cyan", "pulse"),
    glossary:
      "The gateway is launching — usually under 30 seconds. Health is confirmed before it reports Running. Restart is available if the launch stalls.",
  },
  flapping: {
    label: "Unstable",
    dot: kDot("red", "steady"),
    glossary:
      "The gateway is up right now but has crashed recently. Repair investigates; Restart relaunches without diagnosis.",
  },
  degraded: {
    label: "Running with issues",
    dot: kDot("yellow", "steady"),
    glossary:
      "The port answers but health checks are failing. Check the logs; a restart often clears it.",
  },
  safe_mode: {
    label: "Channels paused",
    dot: kDot("yellow", "steady"),
    glossary:
      "The gateway is healthy but channel autostart was suppressed after crashes. Resume channels when ready. Restart relaunches the gateway but does not resume paused channels.",
  },
  running: {
    label: "Running",
    dot: kDot("green", "steady"),
    glossary: "The gateway is up and passing health checks.",
  },
};

const kActionDefs = {
  setup: { id: "setup", label: "Set up", description: "Open the setup wizard." },
  restart: {
    id: "restart",
    label: "Restart",
    description: "Restart the OpenClaw gateway. Usually under a minute.",
  },
  repair: {
    id: "repair",
    label: "Repair",
    description:
      "Run OpenClaw's doctor with fixes applied, then relaunch the gateway.",
  },
  view_logs: {
    id: "view_logs",
    label: "View logs",
    description: "Open the gateway log tail.",
  },
  view_config_error: {
    id: "view_config_error",
    label: "View config error",
    description: "Show what OpenClaw rejected in the configuration.",
  },
  resume_channels: {
    id: "resume_channels",
    label: "Resume channels",
    description: "Start the suppressed channels again.",
  },
  refresh: {
    id: "refresh",
    label: "Refresh",
    description: "Probe the gateway again right now.",
  },
};

const action = (id, kind, extra = {}) => ({
  ...kActionDefs[id],
  kind,
  ...extra,
});

// Operator copy for the scoped auto-repair pause (issue #76 B1.3 / Stage 3):
// the `down` reason while a pause is latched and the repair route's 409. A
// paused box names a build that provably cannot use the files on disk — the
// remedy is an AlphaClaw release that pins a compatible OpenClaw, a backup
// restore, or the explicit one-shot resume (POST /api/watchdog/repair
// { force: true }).
const kAutoRepairPauseCopy = {
  downReason: (pause = {}) =>
    `Automatic repair is paused — ${pause.corroborated === false ? "suspected cause" : "cause"} ${String(
      pause.cause || "unknown",
    )} on OpenClaw ${pause.installedVersion || "unknown"}: the build cannot use the files on disk, so relaunching it would not help. Resume once with a forced Repair, deploy an AlphaClaw release that pins a compatible OpenClaw, or restore a backup.`,
  repairRefusal:
    "Automatic repair is paused for a build that cannot use the files on disk — a plain repair would relaunch it. Resend with force: true to resume for one attempt.",
  hint:
    'POST /api/watchdog/repair with {"force": true} resumes automatic repair once (the same cause re-pauses if it fails again); `alphaclaw diagnose` shows the evidence.',
};
// Operator copy once kWatchdogMaxRepairAttempts is reached (TODOS F015): the
// `down` reason says what actually stopped (Doctor), not "everything".
const kRepairAttemptsExhaustedCopy = {
  downReason: ({ repairAttempts, repairAttemptLimit } = {}) =>
    `Doctor repair failed ${repairAttempts ?? "?"}/${repairAttemptLimit ?? "?"} times — automatic Doctor repair has stopped; crash relaunches continue with backoff. Use Repair to run Doctor again.`,
};
const repairAttemptsExhausted = (watchdog) =>
  Number.isInteger(watchdog?.repairAttempts) &&
  Number.isInteger(watchdog?.repairAttemptLimit) &&
  watchdog.repairAttemptLimit > 0 &&
  watchdog.repairAttempts >= watchdog.repairAttemptLimit;

// Disabled-reason copy for the lifecycle actions (Restart / Retry / Repair).
// Exported so the client-facing strings have one home and tests can pin them.
const kLifecycleActionBlockReasons = {
  operation: "Another operation is in progress",
  relaunch: "A relaunch is already in progress",
};

const getGatewayRecoveryAction = (reason = "") => {
  const code = String(reason).toLowerCase();
  let row = ["refresh_status", "Refresh status", "Reconnect to AlphaClaw or sign in again, then refresh status. Cached eligibility never authorizes a restart; no request will be replayed."];
  if (/operation|busy|relaunch|booting/.test(code)) row = ["observe_operation", "View current operation", "Observe the current operation. No new repair or restart was queued. After it finishes, inspect fresh status and deliberately try again."];
  else if (/pause|stopped/.test(code)) row = ["review_pause", "Review stopped or paused state", "Inspection does not enable automatic repair or start a stopped gateway. A fresh explicit confirmation is required for a manual attempt."];
  else if (/setup|not_onboarded/.test(code)) row = ["complete_setup", "Complete setup", "Complete the existing setup wizard, then return to inspect current gateway status. This does not queue a restart."];
  return { id: row[0], label: row[1], description: row[2] };
};

const projectGatewayRecovery = ({ state, operationActive, operation, relaunchActive, stopped = false, paused = false }) => {
  const reasonCode = state === "unknown" ? "status_unavailable"
    : operationActive || relaunchActive || state === "booting" ? "operation_in_progress"
      : state === "not_onboarded" ? "not_onboarded"
        : stopped ? "stopped" : paused ? "auto_repair_paused" : null;
  const resolution = reasonCode === "status_unavailable" ? "diagnose"
    : reasonCode === "operation_in_progress" ? "operation"
      : reasonCode === "not_onboarded" ? "setup" : null;
  return {
    disposition: resolution === "operation" ? "attach" : resolution ? "inspect" : "execute",
    resolution, reasonCode, reason: reasonCode ? getGatewayRecoveryAction(reasonCode).description : null,
    nextAction: reasonCode ? getGatewayRecoveryAction(reasonCode) : null,
    additionalReasons: [stopped ? "stopped" : null, paused ? "auto_repair_paused" : null]
      .filter((code) => code && code !== reasonCode)
      .map((code) => ({ code, ...getGatewayRecoveryAction(code) })),
    operationId: operation?.operationId || null,
    stopped, paused,
  };
};

// At most one primary per state (bound here, rendered by the client verbatim).
const actionsForState = (
  state,
  {
    operationActive,
    relaunchActive = false,
    operation = null,
    stopped = false,
    paused = false,
  },
) => {
  const recovery = projectGatewayRecovery({ state, operationActive, operation, relaunchActive, stopped, paused });
  const controls = [action("repair", state === "flapping" || state === "config_error" ? "primary" : "secondary", recovery), action("restart", state === "running" || state === "down" ? "primary" : "secondary", recovery)];
  const extras = state === "not_onboarded" ? [action("setup", "primary")]
    : state === "unknown" ? [action("refresh", "primary"), action("view_logs", "secondary")]
    : state === "safe_mode" ? [action("resume_channels", "primary")]
      : ["down", "config_error", "boot_failed", "starting", "flapping", "degraded"].includes(state) ? [action("view_logs", "secondary")] : [];
  return [...controls, ...extras];
};

const formatWindowMinutes = (windowMs) =>
  Math.max(1, Math.round((windowMs || 300000) / 60000));

const reasonForState = (state, { watchdog, bootPhase, tcp, now }) => {
  switch (state) {
    case "booting":
      return "AlphaClaw is starting its services.";
    case "boot_failed":
      return bootPhase?.error
        ? `Startup failed: ${bootPhase.error}`
        : "Startup failed.";
    case "unknown": {
      const ageS = tcp?.observedAt
        ? Math.round((now - tcp.observedAt) / 1000)
        : null;
      return ageS
        ? `Last confirmed ${tcp.running ? "running" : "down"} ${ageS}s ago — reconnecting.`
        : "No gateway observation yet — reconnecting.";
    }
    case "config_error":
      return "OpenClaw rejected its configuration and stopped (exit 78). Automatic restarts are paused.";
    case "down":
      // Stage 3 (#76 B1.3 / F015): a latched auto-repair pause or an exhausted
      // Doctor budget names WHY nothing is coming, before the generic copy.
      if (watchdog?.autoRepairPaused) {
        return kAutoRepairPauseCopy.downReason(watchdog.autoRepairPaused);
      }
      if (repairAttemptsExhausted(watchdog)) {
        return kRepairAttemptsExhaustedCopy.downReason(watchdog);
      }
      return watchdog?.lifecycle === "crash_loop"
        ? "Crashed repeatedly — automatic restarts are paused."
        : "The gateway is not running.";
    case "starting":
      if (watchdog?.incumbentConflict?.kind === "owner_lease_held" && !watchdog?.replacementPending) {
        return "Waiting for the previous gateway's ownership lease to clear — AlphaClaw will retry automatically.";
      }
      return "Waiting for the gateway to come up — usually under 30s.";
    case "flapping": {
      const count = watchdog?.crashCountInWindow || 0;
      const mins = formatWindowMinutes(watchdog?.crashLoopWindowMs);
      return `${count} restart${count === 1 ? "" : "s"} detected in the last ${mins} min — currently up.`;
    }
    case "degraded": {
      // Readiness-only degradation: /health is green, /readyz is not. Name the
      // failing components so the operator does not go hunting for a dead
      // process (the watchdog never repairs on readiness alone).
      if (watchdog?.readiness === "not_ready") {
        const components = watchdog?.readinessReason
          ? ` (${watchdog.readinessReason})`
          : "";
        return `The port answers and /health is green, but readiness checks are failing${components}.`;
      }
      return "The port answers but health checks are failing.";
    }
    case "safe_mode": {
      const suppressed = watchdog?.suppressedChannels || [];
      return suppressed.length
        ? `Channels paused after crashes: ${suppressed.join(", ")}.`
        : "Channels paused after crashes.";
    }
    case "running": {
      // #87 (decision 11.2): a transitional readiness — the gateway itself
      // reports starting|draining on /readyz — is up but not an incident and
      // not degraded; say so instead of a bare green "Running". Gated on the
      // readiness axis too: after a fail-open (readiness "unknown") the
      // stale phase label must not keep the card on "still starting".
      if (watchdog?.readiness !== "not_ready") return "";
      if (watchdog?.readinessStatus === "starting") {
        return "Up — channels still starting.";
      }
      if (watchdog?.readinessStatus === "draining") return "Up — draining.";
      return "";
    }
    default:
      return "";
  }
};

const reduceGatewayState = ({
  configExists,
  tcp = { running: null, observedAt: 0 },
  watchdog = null,
  operation = null,
  bootPhase = { phase: "ready", error: null },
  now = Date.now(),
}) => {
  const wd = watchdog || null;
  const ownerLeaseRetryPending =
    wd?.incumbentConflict?.kind === "owner_lease_held" &&
    wd?.lifecycle === "running" &&
    !!wd?.degradedRetry &&
    !wd?.autoRepairPaused;
  // A watchdog-owned relaunch in flight: a relaunch/repair/medic operation
  // (`operationInProgress`), the exit-78 config-change auto-retry (lifecycle
  // "restarting"), or a crash relaunch still inside its backoff sleep
  // (`backoff.active`). They hold the lifecycle lock only until spawn (or not
  // at all), so the operation badge cannot be trusted to disable Restart for
  // them. A bare "crashed" lifecycle with no backoff and no operation means
  // the relaunch was SKIPPED (lock held by a non-relaunching op, or stop
  // requested) — nothing is coming, so Restart must stay live. Applied ONLY
  // to the TCP-down `starting` pick: every motivating case is a launch that
  // has not bound the port yet. With the port up, a stale "restarting"
  // (an externally driven restart past its expected window that never
  // reported a launch) must not lock the degraded/Unstable card out of its
  // only remedy.
  const relaunchInFlight =
    ownerLeaseRetryPending ||
    !!wd?.replacementPending ||
    wd?.lifecycle === "restarting" ||
    wd?.operationInProgress === true ||
    (wd?.lifecycle === "crashed" && wd?.backoff?.active === true);
  // Supervision axis (three-valued). "adopted" is claimed ONLY when the
  // watchdog says so — it means a serving identity was discovered for a
  // gateway AlphaClaw did not launch (health + memory monitored, no exit
  // events). Otherwise `gatewayPid` keeps today's semantics: set by a launch
  // → managed; null → detached. `supervisionMode` echoes the watchdog's own
  // mode when it reports one so the UI can show the raw axis beside the
  // derived headline; older watchdog statuses without the field fall back to
  // the derived value.
  const supervision = !wd
    ? null
    : wd.supervisionMode === "adopted"
      ? "adopted"
      : wd.gatewayPid
        ? "managed"
        : "detached";
  const supervisionMode = !wd
    ? null
    : kSupervisionModes.has(wd.supervisionMode)
      ? wd.supervisionMode
      : supervision;
  const servingPid = wd ? (wd.servingPid ?? null) : null;
  // Passthrough (stable ISO strings, safe for the SSE dedupe): the card shows
  // "replacement pending (pid N, since …)" while a relaunched child is not yet
  // proven to be the process answering the port.
  const replacementPending =
    wd?.replacementPending && typeof wd.replacementPending === "object"
      ? wd.replacementPending
      : null;

  const pick = (state) => {
    const entry = kGatewayStateCatalog[state];
    const result = {
      state,
      label: entry.label,
      dot: entry.dot,
      glossary: entry.glossary,
      reason: reasonForState(state, { watchdog: wd, bootPhase, tcp, now }),
      actions: actionsForState(state, {
        operationActive: !!operation,
        relaunchActive: state === "starting" && relaunchInFlight,
        operation,
        stopped: wd?.lifecycle === "stopped" || wd?.stopRequested === true,
        paused: !!wd?.autoRepairPaused || wd?.enabled === false,
      }),
      operation: operation || null,
      supervision,
      supervisionMode,
      servingPid,
      replacementPending,
      detail: null,
    };
    // Evidence honesty: probe-inferred crash counts are estimates when the
    // gateway runs outside AlphaClaw's supervision. Adopted gateways were
    // started elsewhere too — no exit events reach the watchdog, so the
    // hedge applies to both non-managed modes.
    if (
      (supervision === "detached" || supervision === "adopted") &&
      (state === "flapping" || state === "down") &&
      (wd?.crashCountInWindow || 0) > 0
    ) {
      result.detail =
        "estimated — gateway runs outside AlphaClaw's supervision";
    }
    return result;
  };

  // Gates.
  if (!configExists) return pick("not_onboarded");
  if (bootPhase?.phase === "failed") return pick("boot_failed");
  if (bootPhase?.phase === "starting_gateway") return pick("booting");

  // Stale or absent liveness observation: be honest rather than guess.
  if (
    tcp.running === null ||
    !tcp.observedAt ||
    now - tcp.observedAt > kGatewayStateStaleMs
  ) {
    return pick("unknown");
  }

  if (wd?.lifecycle === "configuration_error") return pick("config_error");

  if (!tcp.running) {
    const launchInProgress =
      !!operation ||
      ownerLeaseRetryPending ||
      !!replacementPending ||
      wd?.lifecycle === "restarting" ||
      // The watchdog's own recovery (crash relaunch, repair) IS a launch in
      // progress: "Down — no restart in progress. Retry." would invite the
      // user to start a route restart racing the in-flight relaunch. A latched
      // auto-repair pause (#76 B1.3) is the exception: nothing relaunches a
      // paused build, so a bare "crashed" is row 5 (`down`) with the pause's
      // own reason copy, never a "Starting" that never ends.
      wd?.operationInProgress === true ||
      (wd?.lifecycle === "crashed" && !wd?.autoRepairPaused) ||
      bootPhase?.phase === "starting_gateway";
    return pick(launchInProgress ? "starting" : "down");
  }

  // Port is up from here on.
  const crashedRecently =
    (wd?.crashCountInWindow || 0) > 0 || wd?.lifecycle === "crash_loop";
  if (crashedRecently) return pick("flapping");
  if (wd?.health === "degraded" || wd?.health === "unhealthy") {
    return pick("degraded");
  }
  if (wd?.safeMode) return pick("safe_mode");
  // A green /health while a launched replacement is not yet proven to be the
  // process answering the port is liveness only (the watchdog's identity
  // gate): the answer may be an incumbent's, so the card stays "Starting"
  // until the replacement is verified.
  if (wd && (wd.health === "unknown" || replacementPending)) return pick("starting");
  return pick("running");
};

// gateway-state.json annotations (issue #76 A3/A4). Both ride beside the
// headline so the file names WHY as well as WHAT: `cause` is the crash
// classifier's last verdict (getStatus().lastExit.cause — null once the
// gateway recovers), `versionMismatch` the watchdog's latched
// { expected, running, source, detectedAt } | null. A 0.9.76 reader drops
// both through its own whitelist (rollback posture, plan 1.4).
const nonEmptyString = (value) =>
  typeof value === "string" && value !== "" ? value : null;
const normalizeCause = (value) => nonEmptyString(value);
const normalizeVersionMismatch = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    expected: nonEmptyString(value.expected),
    running: nonEmptyString(value.running),
    source: nonEmptyString(value.source),
    detectedAt: nonEmptyString(value.detectedAt),
  };
};
const sameAnnotation = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Temporal truth: `since` survives process restarts when the state carries
// over, and every transition is persisted so a reconnecting UI never invents
// a fresh uptime for an old condition. The annotations persist on THEIR own
// changes too (a cause arriving with no headline change still lands on disk).
const createGatewayStateTracker = ({
  persistPath,
  now = () => Date.now(),
  bootId = String(process.pid),
} = {}) => {
  let previous = null; // { state, since, cause, versionMismatch }

  const restore = () => {
    if (previous) return;
    if (persistPath) {
      try {
        const raw = JSON.parse(fs.readFileSync(persistPath, "utf8"));
        if (raw && typeof raw.state === "string" && Number.isFinite(raw.since)) {
          // Whitelist: state + since (the pre-#76 shape) plus the two
          // annotations; anything else in the file is dropped.
          previous = {
            state: raw.state,
            since: raw.since,
            cause: normalizeCause(raw.cause),
            versionMismatch: normalizeVersionMismatch(raw.versionMismatch),
          };
        }
      } catch {
        // Missing/corrupt state file: start fresh below.
      }
    }
    previous = previous || { state: null, since: 0, cause: null, versionMismatch: null };
  };

  const persist = () => {
    if (!persistPath) return;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tmpPath = `${persistPath}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ ...previous, bootId }),
        "utf8",
      );
      fs.renameSync(tmpPath, persistPath);
    } catch {
      // State persistence is best-effort; the reducer stays correct without it.
    }
  };

  let bootIdPersisted = false;
  const track = (reduced) => {
    restore();
    if (previous.state !== reduced.state) {
      // The annotations carry through the replace: a transition does not
      // forget the cause/mismatch that explains it.
      previous = {
        state: reduced.state,
        since: now(),
        cause: previous.cause,
        versionMismatch: previous.versionMismatch,
      };
      persist();
      bootIdPersisted = true;
    } else if (persistPath && !bootIdPersisted) {
      // Refresh bootId once per process without moving since — NOT on every
      // track, which would be a sync write+rename on every 2s status tick.
      persist();
      bootIdPersisted = true;
    }
    return { ...reduced, since: previous.since };
  };

  // Annotation setters: persist ONLY on a change (they ride the same 2s
  // status tick as track(), so an unchanged value must never write).
  const setCause = (cause) => {
    restore();
    const next = normalizeCause(cause);
    if (sameAnnotation(previous.cause, next)) return previous.cause;
    previous = { ...previous, cause: next };
    persist();
    bootIdPersisted = true;
    return previous.cause;
  };

  const setVersionMismatch = (versionMismatch) => {
    restore();
    const next = normalizeVersionMismatch(versionMismatch);
    if (sameAnnotation(previous.versionMismatch, next)) return previous.versionMismatch;
    previous = { ...previous, versionMismatch: next };
    persist();
    bootIdPersisted = true;
    return previous.versionMismatch;
  };

  return { track, setCause, setVersionMismatch };
};

module.exports = {
  reduceGatewayState,
  createGatewayStateTracker,
  kGatewayStateCatalog,
  // Exported for the notification action-vocabulary parity test (E5, TODOS.md
  // "Notification remediation-action parity"): alert copy naming a
  // remediation must use these labels.
  actionsForState,
  getGatewayRecoveryAction,
  projectGatewayRecovery,
  kLifecycleActionBlockReasons,
  kAutoRepairPauseCopy,
  kRepairAttemptsExhaustedCopy,
};
