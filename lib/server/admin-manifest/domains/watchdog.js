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
  const nextEnabled =
    typeof body.enabled === "boolean" ? body.enabled : current.enabled;
  const nextAutoRestart =
    typeof body.autoRestart === "boolean"
      ? body.autoRestart
      : current.autoRestart;
  const beforeEffective = current.enabled && current.autoRestart;
  const afterEffective = nextEnabled && nextAutoRestart;
  if (!beforeEffective && afterEffective) return "dangerous";
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
      title: "Update watchdog settings (autoRepair, notificationsEnabled)",
      method: "PUT",
      path: "/api/watchdog/settings",
      tier: "write",
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
      title: "Update memory-leak monitor settings (enabled, autoRestart)",
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
        ],
        example: '{"enabled":true}',
      },
      notes:
        "Effective auto-restart is enabled && autoRestart. Arming it escalates to the dangerous tier by resolver; disarming is a plain write.",
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
      id: "watchdog.overseer.review",
      title: "Run an overseer review now (settled incidents only)",
      method: "POST",
      path: "/api/watchdog/overseer/review",
      tier: "write",
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
              "Incident to review (defaults to the newest settled one).",
          },
        ],
        example: '{"incidentId":12}',
      },
      hint: "Synchronous and slow (up to minutes); rate-limited to one manual review per 2 minutes. 503 = reviewer infrastructure unavailable.",
    },
    {
      id: "watchdog.repair",
      title: "Trigger auto-repair (doctor --fix + gateway relaunch)",
      method: "POST",
      path: "/api/watchdog/repair",
      tier: "dangerous",
      hint: "Repair relaunches the gateway — the agent's own session may drop.",
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
      hint: "The watchdog terminal is operator-only; use the Setup UI.",
    },
    {
      id: "watchdog.terminal.input",
      title: "Watchdog terminal input (human-only)",
      method: "POST",
      path: "/api/watchdog/terminal/input",
      tier: "denied",
      hint: "The watchdog terminal is operator-only; use the Setup UI.",
    },
    {
      id: "watchdog.terminal.output",
      title: "Watchdog terminal output (human-only)",
      method: "GET",
      path: "/api/watchdog/terminal/output",
      tier: "denied",
      hint: "The watchdog terminal is operator-only; use the Setup UI.",
    },
    {
      id: "watchdog.terminal.close",
      title: "Close watchdog terminal session (human-only)",
      method: "POST",
      path: "/api/watchdog/terminal/close",
      tier: "denied",
      hint: "The watchdog terminal is operator-only; use the Setup UI.",
    },
  ],
};

// Exported for the tier-resolver unit tests (injected reader).
module.exports.createMemoryUpdateTierResolver = createMemoryUpdateTierResolver;
