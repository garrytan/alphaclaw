const fs = require("fs");
const path = require("path");
const { kGatewayStateStaleMs } = require("./constants");

// One derived, user-facing gateway state. The underlying model is four
// orthogonal axes — availability (TCP + health), operation-in-flight,
// supervision (managed/detached), restart-required — reconciled by a pure
// reducer into a single headline. Internal enum names NEVER render: the
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
// Invariant: every onboarded state except `booting` offers a restart-class
// action (Restart or Retry). Repair, Resume channels and Refresh are the
// RECOMMENDED move in their states, never the ONLY one — an operator must be
// able to relaunch the gateway from the card without running doctor first.
// `booting` is exempt on purpose: boot IS the launch, and a restart queued
// behind the boot hold would only recycle a gateway that just came up
// (boot_failed carries Retry for the failure case). Four things can block the
// offered action, always WITH a reason (precedence in this order): another
// lifecycle operation holding the lock (the badge already explains the wait);
// a watchdog-owned relaunch in flight (those release the lock at spawn, so
// the lifecycle is the only honest signal); an unreadable hold state; or a
// reconciler gateway hold after a failed settings migration (the Upgrade page
// owns the remedy; Repair is blocked too — doctor --fix would rewrite the
// held config). The route re-validates the hold/apply blockers once it holds
// the lock, so the card and the server never disagree for longer than one
// status tick.

const kDot = (color, motion) => ({ color, motion });

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
      "The boot sequence hit an error. Retry, or check the logs for the failing step.",
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
      "The gateway is not running and no restart is in progress. Retry, or run Repair.",
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
      "The gateway is up right now but has crashed recently. Repair investigates; Restart relaunches without diagnosis; Roll back if a new build caused it.",
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
  retry: {
    id: "retry",
    label: "Retry",
    description: "Try starting the gateway again.",
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
  roll_back: {
    id: "roll_back",
    label: "Roll back",
    needsConfirm: true,
    description:
      "Return to the last known-good OpenClaw build. AlphaClaw restarts to apply it.",
  },
};

const action = (id, kind, extra = {}) => ({
  ...kActionDefs[id],
  kind,
  ...extra,
});

// Operator copy for the reconciler gateway hold (issue #20). ONE home for the
// card's disabled reason, the restart/repair route refusals, and their hint —
// the card copy is generic on purpose (a hold's remedy — retry migration,
// strip blamed keys with consent, manual recovery — is chosen on the Upgrade
// page), while the route refusals may name the concrete first move.
const kGatewayHoldCopy = {
  disabledReason:
    "Gateway held after a failed settings migration — resolve it on the Upgrade page.",
  restartRefusal:
    "The gateway is held after a failed settings migration — use Retry migration on the Upgrade page instead of restarting.",
  repairRefusal:
    "The gateway is held after a failed settings migration — use Retry migration on the Upgrade page instead of repairing.",
  hint: "Resolve the settings migration on the Upgrade page.",
  // Fail-closed sibling: a hold state that cannot be READ is treated like a
  // hold (the alternative — launching on a config that may be held — is the
  // exact hazard the hold exists to prevent).
  unreadableDisabledReason:
    "Gateway hold state could not be read — restart refused until the release-channel state file is readable.",
  unreadableRefusal:
    "AlphaClaw could not read the gateway hold state — refusing to relaunch until the release-channel state file is readable.",
  unreadableHint:
    "Check the release-channel state file under .openclaw/.alphaclaw/ and the server log.",
};

// Disabled-reason copy for the lifecycle actions (Restart / Retry / Repair).
// Exported so the client-facing strings have one home and tests can pin them.
const kLifecycleActionBlockReasons = {
  operation: "Another operation is in progress",
  relaunch: "A relaunch is already in progress",
  gatewayHeld: kGatewayHoldCopy.disabledReason,
  gatewayHoldUnreadable: kGatewayHoldCopy.unreadableDisabledReason,
};

// At most one primary per state (bound here, rendered by the client verbatim).
const actionsForState = (
  state,
  {
    operationActive,
    inStabilizationWindow,
    gatewayHeld = false,
    gatewayHoldUnreadable = false,
    relaunchActive = false,
  },
) => {
  // Precedence is explicit: a live leased operation outranks everything (the
  // badge is already explaining the wait); then a watchdog-owned relaunch in
  // flight (crash relaunch / medic / exit-78 auto-retry — they release the
  // lock at spawn or never take it, so only the lifecycle tells the truth);
  // then an unreadable hold; then a hold. Each returns once it clears.
  const blocked = operationActive
    ? { disabledReason: kLifecycleActionBlockReasons.operation }
    : relaunchActive
      ? { disabledReason: kLifecycleActionBlockReasons.relaunch }
      : gatewayHoldUnreadable
        ? { disabledReason: kLifecycleActionBlockReasons.gatewayHoldUnreadable }
        : gatewayHeld
          ? { disabledReason: kLifecycleActionBlockReasons.gatewayHeld }
          : {};
  switch (state) {
    case "not_onboarded":
      return [action("setup", "primary")];
    case "booting":
      // Deliberately empty: boot IS the launch. A restart queued behind the
      // boot hold would land after boot and recycle a gateway that just came
      // up; if boot fails, boot_failed carries Retry.
      return [];
    case "boot_failed":
      return [
        action("retry", "primary", blocked),
        action("view_logs", "secondary"),
      ];
    case "unknown":
      return [
        action("refresh", "primary"),
        action("restart", "secondary", blocked),
        action("view_logs", "secondary"),
      ];
    case "config_error":
      return [
        action("view_config_error", "primary"),
        // Repair (doctor --fix) is the one action that force-clears the
        // EX_CONFIG latch (issue #21 bug 9) — the Watchdog tab always had it;
        // the gateway card in exactly this state did not.
        action("repair", "secondary", blocked),
        action("retry", "secondary", blocked),
        action("view_logs", "secondary"),
      ];
    case "down":
      return [
        action("retry", "primary", blocked),
        action("repair", "secondary", blocked),
        action("view_logs", "secondary"),
      ];
    case "starting":
      // Disabled (with reason) while a leased operation owns the launch OR a
      // watchdog relaunch is in flight (crash_restart releases the lock right
      // after spawn and the exit-78 auto-retry never takes it, so a user
      // restart here would stop the child that was just spawned); enabled
      // once the launch is simply waiting on its first health check.
      return [
        action("view_logs", "secondary"),
        action("restart", "secondary", blocked),
      ];
    case "flapping":
      // Repair is the recommended move, not the only one: a plain Restart
      // must stay reachable (a repair-only card left operators with no way
      // to relaunch an Unstable gateway without running doctor first).
      return [
        action("repair", "primary", blocked),
        action("restart", "secondary", blocked),
        action("view_logs", "secondary"),
        ...(inStabilizationWindow ? [action("roll_back", "danger")] : []),
      ];
    case "degraded":
      return [
        action("view_logs", "primary"),
        action("restart", "secondary", blocked),
      ];
    case "safe_mode":
      return [
        action("resume_channels", "primary"),
        action("restart", "secondary", blocked),
      ];
    case "running":
    default:
      return [action("restart", "primary", blocked)];
  }
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
      return watchdog?.lifecycle === "crash_loop"
        ? "Crashed repeatedly — automatic restarts are paused."
        : "The gateway is not running.";
    case "starting":
      return "Waiting for the gateway to come up — usually under 30s.";
    case "flapping": {
      const count = watchdog?.crashCountInWindow || 0;
      const mins = formatWindowMinutes(watchdog?.crashLoopWindowMs);
      return `${count} restart${count === 1 ? "" : "s"} detected in the last ${mins} min — currently up.`;
    }
    case "degraded":
      return "The port answers but health checks are failing.";
    case "safe_mode": {
      const suppressed = watchdog?.suppressedChannels || [];
      return suppressed.length
        ? `Channels paused after crashes: ${suppressed.join(", ")}.`
        : "Channels paused after crashes.";
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
  inStabilizationWindow = false,
  // Reconciler gateway hold (issue #20): the route refuses restarts while it
  // is set, so the card must say so up front instead of 409ing on click. An
  // unreadable/corrupted hold state is refused too (fail closed).
  gatewayHeld = false,
  gatewayHoldUnreadable = false,
  now = Date.now(),
}) => {
  const wd = watchdog || null;
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
    wd?.lifecycle === "restarting" ||
    wd?.operationInProgress === true ||
    (wd?.lifecycle === "crashed" && wd?.backoff?.active === true);
  const supervision = wd ? (wd.gatewayPid ? "managed" : "detached") : null;

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
        inStabilizationWindow,
        gatewayHeld: !!gatewayHeld,
        gatewayHoldUnreadable: !!gatewayHoldUnreadable,
        relaunchActive: state === "starting" && relaunchInFlight,
      }),
      operation: operation || null,
      supervision,
      detail: null,
    };
    // Evidence honesty: probe-inferred crash counts are estimates when the
    // gateway runs outside AlphaClaw's supervision.
    if (
      supervision === "detached" &&
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
      wd?.lifecycle === "restarting" ||
      // The watchdog's own recovery (crash relaunch, repair) IS a launch in
      // progress: "Down — no restart in progress. Retry." would invite the
      // user to start a route restart racing the in-flight relaunch.
      wd?.operationInProgress === true ||
      wd?.lifecycle === "crashed" ||
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
  if (wd && wd.health === "unknown") return pick("starting");
  return pick("running");
};

// Temporal truth: `since` survives process restarts when the state carries
// over, and every transition is persisted so a reconnecting UI never invents
// a fresh uptime for an old condition.
const createGatewayStateTracker = ({
  persistPath,
  now = () => Date.now(),
  bootId = String(process.pid),
} = {}) => {
  let previous = null; // { state, since }

  const restore = () => {
    if (previous) return;
    if (persistPath) {
      try {
        const raw = JSON.parse(fs.readFileSync(persistPath, "utf8"));
        if (raw && typeof raw.state === "string" && Number.isFinite(raw.since)) {
          previous = { state: raw.state, since: raw.since };
        }
      } catch {
        // Missing/corrupt state file: start fresh below.
      }
    }
    previous = previous || { state: null, since: 0 };
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
      previous = { state: reduced.state, since: now() };
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

  return { track };
};

module.exports = {
  reduceGatewayState,
  createGatewayStateTracker,
  kGatewayStateCatalog,
  // Exported for the notification action-vocabulary parity test (E5, TODOS.md
  // "Notification remediation-action parity"): alert copy naming a
  // remediation must use these labels.
  actionsForState,
  kLifecycleActionBlockReasons,
  kGatewayHoldCopy,
};
