// Env keys that must come from the REAL deployment environment only — never
// honored from the agent-writable .env file. Enforcement has TWO sites that
// must stay in lockstep (the incident class this guards: v0.9.59/v0.9.63
// closed agent env escalations):
//   1. bin/alphaclaw.js section 5 — the BOOT-time .env load into process.env
//      (the only path that matters for module-load-read constants like
//      GATEWAY_RESTART_READY_TIMEOUT).
//   2. lib/server/env.js reloadEnv — the RUNTIME re-apply path.
// This module is a leaf (zero requires) so bin can load it before lib/server.
const kDeploymentOnlyEnvKeys = [
  // Gateway-env allowlist hatches: honoring these from .env would let the
  // agent self-grant broader gateway-child env inheritance.
  "ALPHACLAW_GATEWAY_ENV_UNRESTRICTED",
  "ALPHACLAW_GATEWAY_ENV_PASSTHROUGH",
  // Restart-hardening knob: the agent must not be able to shrink the ready
  // budget (forcing every restart on a slow box to fail at the clamp floor).
  "GATEWAY_RESTART_READY_TIMEOUT",
  // Watchdog cadence knobs: an agent that can write .env must not be able to
  // slow the watchdog's probes to the clamp ceiling (self-blinding).
  "WATCHDOG_CHECK_INTERVAL",
  "WATCHDOG_DEGRADED_CHECK_INTERVAL",
  "WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL",
  // Sustained-failure gate: from .env the agent could raise the repair
  // threshold to the ceiling and keep its own wedged gateway from being
  // repaired (self-blinding, same class as the cadence knobs).
  "WATCHDOG_DEGRADED_REPAIR_THRESHOLD",
  // State-DB quiet-period kill switch: honoring it from .env would let the
  // agent disable the barrier that keeps its own state-db traffic from
  // wedging the quiesced pre-update backup (issue #54).
  "OPENCLAW_STATE_DB_QUIET",
  // Gateway prelaunch hook path: an executable run before every gateway
  // launch — from .env the agent could point it at any file it can write and
  // run arbitrary code with AlphaClaw's privileges on the next restart.
  "ALPHACLAW_GATEWAY_PRELAUNCH_HOOK",
  // Runtime installed-tree reconcile kill switch (issue #76 B1.2): from .env
  // the agent could switch off the one repair that re-activates the recorded
  // build under it — leaving its own diverged tree in place indefinitely.
  "OPENCLAW_RUNTIME_RECONCILE",
  // Boot launch-compatibility gate kill switch (issue #76 C1 belt / C2): from
  // .env the agent could switch off the check that keeps a binary from
  // launching (and `doctor --fix`ing) against a state database it cannot
  // read — the exact #76 mutation the gate exists to prevent.
  "OPENCLAW_LAUNCH_COMPAT_GATE",
  // Crash-cause ladder kill switch (issue #76 B1 / CEO 1.3): from .env the
  // agent could switch off the structural repair + pause and put the watchdog
  // back on blind relaunches of a binary that cannot read its own database.
  "OPENCLAW_CRASH_CAUSE_LADDER",
  // Control UI mount kill switch (control-ui-mount.js): `legacy` makes boot
  // REMOVE gateway.controlUi.basePath and the proxy strip the /openclaw
  // prefix again. From .env the agent could flip the dashboard back into the
  // broken root-mounted state under a running proxy (self-blinding), and the
  // proxy routes snapshot the mode at module load while reloadEnv would feed
  // the config writer a different value — a split brain by construction.
  "ALPHACLAW_CONTROL_UI_MOUNT",
];

module.exports = { kDeploymentOnlyEnvKeys };
