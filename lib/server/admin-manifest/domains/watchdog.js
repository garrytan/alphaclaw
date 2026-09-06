const { readWatchdogMemorySettings } = require("../../alphaclaw-config");
const { OPENCLAW_DIR } = require("../../constants");

// Body-aware tier for PUT /api/watchdog/memory: the pre-OOM auto-restart is
// an OPERATOR consent knob. The resolver evaluates the RESULTING effective
// state (enabled && autoRestart), so both `{autoRestart:true}` AND
// `{enabled:true}` while a stored autoRestart:true exists escalate — an agent
// must not be able to re-arm enforcement through the detection toggle.
// Disabling either flag stays a plain write.
const createMemoryUpdateTierResolver = (
  // Test seam: production always reads the live settings.
  readSettings = () => readWatchdogMemorySettings({ openclawDir: OPENCLAW_DIR }),
) => (req) => {
  const body = req?.body || {};
  let current;
  try {
    current = readSettings();
  } catch {
    // Can't verify the resulting state → fail closed to the confirm tier.
    return "dangerous";
  }
  // An existing-but-unreadable config is equally unverifiable: the reader
  // fail-closes to {enabled:false,...} but the WRITE path fail-opens to the
  // defaults ({enabled:true}), so a gate computed here would disagree with
  // the state the write actually merges onto — {autoRestart:true} would arm
  // at plain write tier. Escalate instead.
  if (current?.configUnreadable === true) return "dangerous";
  // Any body that sets autoRestart=true is operator-only UNCONDITIONALLY —
  // not just when the resulting effective state arms. Judging only the
  // resulting state has a split-write TOCTOU: from {enabled:false,
  // autoRestart:false}, concurrent {enabled:true} and {autoRestart:true}
  // writes each look non-arming against the pre-write snapshot, then
  // serialize into an armed switch with neither confirmed. Making the
  // autoRestart:true field itself dangerous closes every path to armed
  // that doesn't pass an operator confirm (the enabled-flip branch below
  // covers the other one: re-enabling detection over a stored true).
  if (body.autoRestart === true) return "dangerous";
  const nextEnabled =
    typeof body.enabled === "boolean" ? body.enabled : current.enabled;
  const nextAutoRestart =
    typeof body.autoRestart === "boolean"
      ? body.autoRestart
      : current.autoRestart;
  const beforeEffective = current.enabled && current.autoRestart;
  const afterEffective = nextEnabled && nextAutoRestart;
  if (!beforeEffective && afterEffective) return "dangerous";
  // Fast-leak profile knobs (issue #56): budgetMb / maxRestartsPerDay decide
  // how SOON and how OFTEN the watchdog restarts the gateway once armed. They
  // are operator-only UNCONDITIONALLY — not just when the resulting state is
  // armed: a disarmed agent could otherwise pre-stage {budgetMb:256,
  // maxRestartsPerDay:24} at write tier and a later operator arm-confirm
  // (whose summary names the op, not the stored profile) would activate a
  // 24-restart/day loop nobody consented to. Same closure as autoRestart:true.
  const touchesProfile =
    Object.prototype.hasOwnProperty.call(body, "budgetMb") ||
    Object.prototype.hasOwnProperty.call(body, "maxRestartsPerDay");
  if (touchesProfile) return "dangerous";
  return "write";
};
const memoryUpdateTierResolver = createMemoryUpdateTierResolver();

module.exports = {
  domain: "watchdog",
  title: "Watchdog",
  ops: [
    {
      id: "watchdog.status",
      title: "Watchdog + gateway health status",
      method: "GET",
      path: "/api/watchdog/status",
      tier: "safe",
    },
    {
      id: "watchdog.events",
      title: "Watchdog event log (includes agent_admin audit rows)",
      method: "GET",
      path: "/api/watchdog/events",
      tier: "safe",
      params: {
        fields: [
          {
            name: "limit",
            location: "query",
            type: "number",
            required: false,
            description: "Max events to return.",
          },
        ],
        example: "GET /api/watchdog/events?limit=50",
      },
    },
    {
      id: "watchdog.logs",
      title: "Recent gateway/process log lines",
      method: "GET",
      path: "/api/watchdog/logs",
      tier: "safe",
    },
    {
      id: "watchdog.resources",
      title:
        "Container resource usage (memory, CPU, disk, processes, event loop) + capacity profile",
      method: "GET",
      path: "/api/watchdog/resources",
      tier: "safe",
    },
    {
      id: "watchdog.settings.read",
      title: "Read watchdog settings",
      method: "GET",
      path: "/api/watchdog/settings",
      tier: "safe",
    },
    {
      id: "watchdog.settings.update",
      title:
        "Update watchdog settings (autoRepair, notificationsEnabled, notificationsVerbose)",
      method: "PUT",
      path: "/api/watchdog/settings",
      tier: "write",
      // Silencing the operator's alert channel is not a routine write: an
      // agent toggling notificationsEnabled/notificationsVerbose escalates to
      // a dangerous-tier confirm. The confirm-code delivery is audit-class
      // (exempt from both toggles), so the gate survives the very setting
      // under attack. autoRepair alone stays write-tier.
      tierResolver: (req) => {
        // Primitive JSON bodies (true, 1, "x") would make the `in` operator
        // throw — fall back to the base tier and let route validation 400.
        const body = req?.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return "write";
        }
        if ("notificationsEnabled" in body || "notificationsVerbose" in body) {
          return "dangerous";
        }
        return "write";
      },
      idempotent: true,
      readOp: "watchdog.settings.read",
      params: {
        fields: [
          {
            name: "autoRepair",
            location: "body",
            type: "boolean",
            required: false,
            description: "Run `openclaw doctor --fix` automatically on crash loops.",
          },
          {
            name: "notificationsEnabled",
            location: "body",
            type: "boolean",
            required: false,
            description: "Watchdog alerts to paired channels.",
          },
          {
            name: "notificationsVerbose",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Verbose ON (default) sends informational notices too; OFF sends only problems, automatic fixes, and anything needing intervention.",
          },
        ],
        example: '{"notificationsEnabled": false}',
      },
      notes: "Persisted as env flags; takes effect immediately, no restart.",
    },
    {
      id: "watchdog.memory.read",
      title: "Read memory-leak monitor settings",
      method: "GET",
      path: "/api/watchdog/memory",
      tier: "safe",
      envelope: "structured",
    },
    {
      id: "watchdog.memory.update",
      title:
        "Update memory-leak monitor settings (enabled, autoRestart, budgetMb, maxRestartsPerDay)",
      method: "PUT",
      path: "/api/watchdog/memory",
      tier: "write",
      tierResolver: memoryUpdateTierResolver,
      envelope: "structured",
      idempotent: true,
      readOp: "watchdog.memory.read",
      params: {
        fields: [
          {
            name: "enabled",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "RSS trend detection (report-only: events, notifications, doctor cards).",
          },
          {
            name: "autoRestart",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Pre-OOM mitigation restart. Operator consent knob: any write whose RESULT arms it (including re-enabling detection while autoRestart is stored true) requires an operator confirm.",
          },
          {
            name: "budgetMb",
            location: "body",
            type: "number",
            required: false,
            description:
              "Operator RSS budget for the gateway process tree in whole MB (256–1048576), or null to derive the cap from heap/container. Critical fires at 90% of the tightest cap; a budget at or below the current RSS is rejected. Always requires an operator confirm (restart lever).",
          },
          {
            name: "maxRestartsPerDay",
            location: "body",
            type: "number",
            required: false,
            description:
              "Auto-restart brake budget per rolling 24h (1–24, default 2); restarts are spaced at least min(6h, 24h / (2 × budget)) apart. Always requires an operator confirm (restart lever).",
          },
        ],
        example: '{"enabled":true}',
      },
      notes:
        "Effective auto-restart is enabled && autoRestart. Arming it escalates to the dangerous tier by resolver; disarming is a plain write. budgetMb / maxRestartsPerDay ALWAYS escalate (they decide how soon and how often the gateway restarts, and a disarmed pre-stage would go live on a later arm). budgetMb accepts JSON null to clear.",
    },
    {
      id: "watchdog.incidents.list",
      title: "Incident history (grouped gateway trouble, newest first)",
      method: "GET",
      path: "/api/watchdog/incidents",
      tier: "safe",
      params: {
        fields: [
          {
            name: "limit",
            location: "query",
            type: "number",
            required: false,
            description: "Max incidents to return (1-50, default 10).",
          },
          {
            name: "before",
            location: "query",
            type: "number",
            required: false,
            description: "Cursor: return incidents with id below this.",
          },
        ],
        example: "GET /api/watchdog/incidents?limit=10",
      },
      notes:
        "List rows are slim (rollup only); full evidence snapshots live on the detail read.",
    },
    {
      id: "watchdog.incidents.detail",
      title: "One incident with its event timeline",
      method: "GET",
      path: "/api/watchdog/incidents/:id",
      tier: "safe",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "number",
            required: true,
            description: "Incident id (strict positive integer).",
          },
        ],
        example: "GET /api/watchdog/incidents/12",
      },
    },
    {
      id: "watchdog.overseer.read",
      title: "Read incident-overseer setting + claude availability",
      method: "GET",
      path: "/api/watchdog/overseer",
      tier: "safe",
      envelope: "structured",
    },
    {
      id: "watchdog.overseer.update",
      title: "Enable/disable the incident overseer",
      method: "PUT",
      path: "/api/watchdog/overseer",
      tier: "write",
      envelope: "structured",
      idempotent: true,
      readOp: "watchdog.overseer.read",
      params: {
        fields: [
          {
            name: "enabled",
            location: "body",
            type: "boolean",
            required: true,
            description: "Strict boolean; strings are a 400.",
          },
        ],
        example: '{"enabled":true}',
      },
      notes:
        "Enabling sends redacted incident evidence (logs, event rows, doctor output) to the Anthropic API on each review. Advisory-only: verdicts never trigger recovery.",
    },
    {
      id: "watchdog.overseer.situation.read",
      title: "Read the latest overseer situation report",
      method: "GET",
      path: "/api/watchdog/overseer/situation",
      tier: "safe",
      envelope: "structured",
      notes:
        "current = latest attempt, lastVerdict = last completed report, nextManualAt = next allowed manual review.",
    },
    {
      id: "watchdog.overseer.review",
      title: "Run an overseer review now (situation report, or a settled incident by id)",
      method: "POST",
      path: "/api/watchdog/overseer/review",
      tier: "write",
      // A settled-incident re-review by id is a plain write. A situation report
      // (no id) reviews the LIVE log — which the gateway's own agent writes —
      // in any state and hands the verdict back to the caller, so an unattended
      // agent needs an operator's confirm code for it.
      tierResolver: (req) => {
        const body = req?.body;
        if (body && typeof body === "object" && !Array.isArray(body) && body.incidentId != null) {
          return "write";
        }
        return "dangerous";
      },
      envelope: "structured",
      idempotent: false,
      params: {
        fields: [
          {
            name: "incidentId",
            location: "body",
            type: "number",
            required: false,
            description:
              "Optional: omit for a situation report (any watchdog state); a settled incident id re-reviews it (open incidents are refused).",
          },
        ],
        example: '{"incidentId":12}',
      },
      hint: "Synchronous and slow (up to minutes); one manual review per 2 minutes. 503 = reviewer unavailable; result.persisted=false = ran but not saved.",
    },
    {
      id: "watchdog.repair",
      title: "Trigger auto-repair (doctor --fix + gateway relaunch)",
      method: "POST",
      path: "/api/watchdog/repair",
      tier: "dangerous",
      hint: "Repair relaunches the gateway — the agent's own session may drop.",
      notes:
        "409 codes: gateway_held (reconciler hold — doctor --fix would rewrite the held config; recover through updates.reconcile-retry), gateway_hold_unreadable (release-channel state unreadable; fail-closed). Other skips return 200 with result.skipped and a reason.",
    },
    {
      id: "watchdog.resume-channels",
      title: "Resume channels suppressed by safe mode",
      method: "POST",
      path: "/api/watchdog/resume-channels",
      tier: "write",
    },
    {
      id: "watchdog.test-notification",
      title: "Send a test watchdog notification",
      method: "POST",
      path: "/api/watchdog/test-notification",
      tier: "write",
      idempotent: false,
    },
    // The interactive terminal is a human debugging surface: it executes
    // terminal input against the box. Never available to the agent actor.
    {
      id: "watchdog.terminal.session",
      title: "Open watchdog terminal session (human-only)",
      method: "POST",
      path: "/api/watchdog/terminal/session",
      tier: "denied",
      hint: "The watchdog terminal is operator-only: Setup UI → Watchdog → Terminal (it streams over the /api/watchdog/terminal/ws WebSocket, not these HTTP ops).",
    },
    {
      id: "watchdog.terminal.input",
      title: "Watchdog terminal input (human-only)",
      method: "POST",
      path: "/api/watchdog/terminal/input",
      tier: "denied",
      hint: "The watchdog terminal is operator-only: Setup UI → Watchdog → Terminal (it streams over the /api/watchdog/terminal/ws WebSocket, not these HTTP ops).",
    },
    {
      id: "watchdog.terminal.output",
      title: "Watchdog terminal output (human-only)",
      method: "GET",
      path: "/api/watchdog/terminal/output",
      tier: "denied",
      hint: "The watchdog terminal is operator-only: Setup UI → Watchdog → Terminal (it streams over the /api/watchdog/terminal/ws WebSocket, not these HTTP ops).",
    },
    {
      id: "watchdog.terminal.close",
      title: "Close watchdog terminal session (human-only)",
      method: "POST",
      path: "/api/watchdog/terminal/close",
      tier: "denied",
      hint: "The watchdog terminal is operator-only: Setup UI → Watchdog → Terminal (it streams over the /api/watchdog/terminal/ws WebSocket, not these HTTP ops).",
    },
  ],
};

// Exported for the tier-resolver unit tests (injected reader).
module.exports.createMemoryUpdateTierResolver = createMemoryUpdateTierResolver;
