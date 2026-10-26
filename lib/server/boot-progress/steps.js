// The operator-facing vocabulary of a boot (honest boot status, PR 3).
//
// A boot shows at most four stages. Every internal step of
// bin/alphaclaw.js + lib/server/startup.js maps to EXACTLY ONE of them, in
// boot order, so a stage never reopens: the Codex migration, the plugin
// reconciliation and the channel sync run AFTER Doctor, and they belong to
// "Starting the gateway" (they re-assert AlphaClaw's invariants on what Doctor
// wrote, immediately before the launch), never to Preparing.
//
//   preparing  bin setup (process start → listen), the server start, the
//              restart-operation reconcile, the boot report, the lock
//              contention report, config normalization
//   upgrading  OpenClaw's version-change `doctor --fix` (only when it runs;
//              otherwise the stage is hidden)
//   gateway    native maintenance (Codex migration, plugin reconciliation),
//              autotune, exec defaults, usage tracker, webhook ids, prompt
//              sync, env reload, channel sync, Control UI proxy config, the
//              boot report finalize, the gateway launch (plugin preflight
//              inside it) and OpenClaw's own startup trace up to http.bound
//   channels   the gateway answers and its /readyz says startup-sidecars are
//              still settling (or OpenClaw's trace reached http.bound/ready)

const kBootStages = Object.freeze([
  { id: "preparing", label: "Preparing" },
  { id: "upgrading", label: "Upgrading OpenClaw data", optional: true },
  { id: "gateway", label: "Starting the gateway" },
  { id: "channels", label: "Connecting channels" },
]);
const kStageOrder = Object.freeze(kBootStages.map((stage) => stage.id));
const kStageLabels = Object.freeze(
  Object.fromEntries(kBootStages.map((stage) => [stage.id, stage.label])),
);

const kBootSteps = Object.freeze({
  bin_setup: { stage: "preparing", label: "Setting up the runtime" },
  server_start: { stage: "preparing", label: "Starting the AlphaClaw server" },
  lock_contention: { stage: "preparing", label: "Checking for leftover OpenClaw processes" },
  restart_reconcile: { stage: "preparing", label: "Closing the previous run's records" },
  boot_report: { stage: "preparing", label: "Recording the boot report" },
  config_normalize: { stage: "preparing", label: "Normalizing configuration" },
  doctor: { stage: "upgrading", label: "Running OpenClaw's data upgrade (doctor --fix)" },
  native_maintenance: { stage: "gateway", label: "Migrating Codex settings and reconciling plugins" },
  autotune: { stage: "gateway", label: "Tuning resources" },
  config_ensure: { stage: "gateway", label: "Applying exec, usage and webhook settings" },
  prompt_sync: { stage: "gateway", label: "Syncing prompt files" },
  channel_sync: { stage: "gateway", label: "Syncing channel configuration" },
  proxy_config: { stage: "gateway", label: "Configuring the Control UI proxy" },
  report_finalize: { stage: "gateway", label: "Finalizing the boot report" },
  gateway_launch: { stage: "gateway", label: "Launching the gateway" },
  openclaw_startup: { stage: "gateway", label: "OpenClaw is starting" },
  // The watchdog holds a transient ownership conflict and relaunches once it
  // clears: the previous gateway's heartbeat lapsing, or another OpenClaw
  // process releasing the state database.
  lock_wait: { stage: "gateway", label: "Waiting for OpenClaw's state ownership" },
  readiness: { stage: "channels", label: "Waiting for channels and startup tasks" },
});

// Boot kinds, in precedence order (highest first). The kind is single-valued
// even when one deploy is both: an AlphaClaw release that changes the
// OpenClaw pin is "Upgrading OpenClaw" from the moment its version-change
// Doctor starts (promoted then), else "Updating AlphaClaw" when the bin
// phase's boot report says this is the first boot of this AlphaClaw version,
// else "Restarting". History and estimates group by the FINAL kind.
const kBootKinds = Object.freeze({
  upgrading_openclaw: { rank: 3, label: "Upgrading OpenClaw", headline: "Upgrading OpenClaw" },
  updating_alphaclaw: { rank: 2, label: "Updating AlphaClaw", headline: "Updating AlphaClaw" },
  restarting: { rank: 1, label: "Restarting", headline: "AlphaClaw is restarting" },
});

// OpenClaw's own startup trace, both observed formats (2026.10.2/10.4):
//   "[gateway] startup phase: cli.bootstrap.admission.database-readiness starting total=2888.3ms"
//   "2026-10-16T14:57:20.103+00:00 [gateway] startup phase: process.bootstrap 8082.0ms total=8082.0ms"
// plus the OPENCLAW_GATEWAY_STARTUP_TRACE=1 variant "startup trace: <name> …".
const kStartupTracePattern = /startup (?:phase|trace): ([A-Za-z0-9][A-Za-z0-9._-]{0,120})(?:\s+(starting))?/;

// Plain words for the trace, shown only as detail text. Anything unknown
// degrades to the stage itself ("Starting the gateway" with elapsed time).
const kStartupTraceWords = Object.freeze({
  "entry.run-main-import": "Loading OpenClaw",
  "cli.main.gateway-run-select-environment": "Loading OpenClaw",
  "cli.main.gateway-run-imports": "Loading OpenClaw",
  "cli.main.gateway-run-pre-bootstrap": "Preparing the gateway process",
  "cli.main.gateway-run-bootstrap": "Bootstrapping the gateway",
  "cli.bootstrap.admission.database-readiness": "Opening OpenClaw's databases",
  "gateway.server-start-import": "Loading the gateway server",
  "process.bootstrap": "Loading the gateway server",
  "state.schema-preflight": "Checking the state database",
  "config.auth": "Loading configuration",
  "startup.maintenance": "Running startup maintenance",
  "http.bound": "Gateway is listening",
  ready: "Gateway reports ready",
});
// Trace names that mean the gateway is past its own bootstrap: the stage
// moves on to "Connecting channels".
const kChannelsTraceNames = new Set(["http.bound", "ready"]);

// One line of gateway output → { name, starting, words, channels } | null.
const parseStartupTraceLine = (line) => {
  const match = kStartupTracePattern.exec(String(line || ""));
  if (!match) return null;
  const name = match[1];
  return {
    name,
    starting: match[2] === "starting",
    words: kStartupTraceWords[name] || null,
    channels: kChannelsTraceNames.has(name),
  };
};

const stageIndex = (stageId) => kStageOrder.indexOf(stageId);

module.exports = {
  kBootStages,
  kStageOrder,
  kStageLabels,
  kBootSteps,
  kBootKinds,
  kStartupTraceWords,
  parseStartupTraceLine,
  stageIndex,
};
