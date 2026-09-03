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
      "AlphaClaw has no fresh observation of the gateway. Refresh, or check that AlphaClaw itself is healthy.",
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
      "The gateway is launching — usually under 30 seconds. Health is confirmed before it reports Running.",
  },
  flapping: {
    label: "Unstable",
    dot: kDot("red", "steady"),
    glossary:
      "The gateway is up right now but has crashed recently. Repair investigates; Roll back if a new build caused it.",
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
      "The gateway is healthy but channel autostart was suppressed after crashes. Resume channels when ready.",
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

// Exactly one primary per state (bound here, rendered by the client verbatim).
const actionsForState = (state, { operationActive, inStabilizationWindow }) => {
  const restartDisabled = operationActive
    ? { disabledReason: "Another operation is in progress" }
    : {};
  switch (state) {
    case "not_onboarded":
      return [action("setup", "primary")];
    case "booting":
      return [];
    case "boot_failed":
      return [action("retry", "primary"), action("view_logs", "secondary")];
    case "unknown":
      return [action("refresh", "primary"), action("view_logs", "secondary")];
    case "config_error":
      return [
        action("view_config_error", "primary"),
        // Repair (doctor --fix) is the one action that force-clears the
        // EX_CONFIG latch (issue #21 bug 9) — the Watchdog tab always had it;
        // the gateway card in exactly this state did not.
        action("repair", "secondary", restartDisabled),
        action("retry", "secondary", restartDisabled),
        action("view_logs", "secondary"),
      ];
    case "down":
      return [
        action("retry", "primary", restartDisabled),
        action("repair", "secondary", restartDisabled),
        action("view_logs", "secondary"),
      ];
    case "starting":
      return [action("view_logs", "secondary")];
    case "flapping":
      return [
        action("repair", "primary", restartDisabled),
        action("view_logs", "secondary"),
        ...(inStabilizationWindow ? [action("roll_back", "danger")] : []),
      ];
    case "degraded":
      return [
        action("view_logs", "primary"),
        action("restart", "secondary", restartDisabled),
      ];
    case "safe_mode":
      return [action("resume_channels", "primary")];
    case "running":
    default:
      return [action("restart", "primary", restartDisabled)];
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
  now = Date.now(),
}) => {
  const wd = watchdog || null;
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
};
