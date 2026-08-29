// The dashboard URL embeds the gateway token in its #token= fragment — a
// live credential. The agent gets the tokenless path plus a presence marker.
const redactDashboardUrl = (body) => {
  if (!body || typeof body !== "object" || typeof body.url !== "string") {
    return body;
  }
  if (!/[#?&]token=/.test(body.url)) return body;
  return { ...body, url: "/openclaw", dashboardToken: "••• (set)" };
};

module.exports = {
  domain: "system",
  title: "System & Gateway",
  ops: [
    {
      id: "system.status",
      title: "AlphaClaw status (gateway, channels, versions, config snapshot)",
      method: "GET",
      path: "/api/status",
      tier: "safe",
    },
    {
      id: "system.status-events",
      title: "Live status event stream (SSE, status + watchdog + doctor)",
      method: "GET",
      path: "/api/events/status",
      tier: "safe",
      streaming: true,
      notes: "Server-sent events every 2s; close the connection when done.",
    },
    {
      id: "system.sync-cron.read",
      title: "Read hourly git-sync cron status",
      method: "GET",
      path: "/api/sync-cron",
      tier: "safe",
    },
    {
      id: "system.sync-cron.update",
      title: "Enable/disable or reschedule the hourly git-sync cron",
      method: "PUT",
      path: "/api/sync-cron",
      tier: "write",
      idempotent: true,
      readOp: "system.sync-cron.read",
      params: {
        fields: [
          {
            name: "enabled",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Install (true) or remove (false) the system cron entry. Omitted keeps the current value. Non-boolean is rejected (400).",
          },
          {
            name: "schedule",
            location: "body",
            type: "string",
            required: false,
            description:
              "5-field cron expression; anything else is rejected (400). Omitted keeps the current schedule.",
          },
        ],
        example: '{"enabled":true,"schedule":"0 * * * *"}',
      },
    },
    {
      id: "system.config",
      title: "Read AlphaClaw config (feature flags)",
      method: "GET",
      path: "/api/alphaclaw/config",
      tier: "safe",
    },
    {
      id: "system.features.openai-compat-api",
      title: "Enable/disable the OpenAI-compatible API feature",
      method: "PUT",
      path: "/api/alphaclaw/config/features/openai-compat-api",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "system.config",
      params: {
        fields: [
          {
            name: "enabled",
            location: "body",
            type: "boolean",
            required: true,
            description:
              "Feature flag value; non-boolean is rejected (400). Enabling may rewrite gateway proxy config and mark restart-required.",
          },
        ],
        example: '{"enabled":true}',
      },
    },
    // Route ships with the agent-admin dashboard toggle; authored ahead so the
    // deny is explicit the moment it lands.
    {
      id: "system.features.agent-admin",
      title: "Toggle the agent-admin feature flag (operator-only)",
      method: "PUT",
      path: "/api/alphaclaw/config/features/agent-admin",
      tier: "denied",
      hint: "The agent may not govern its own agent-admin flag; an operator toggles it in the dashboard.",
    },
    {
      id: "system.version",
      title: "AlphaClaw version status (installed vs latest)",
      method: "GET",
      path: "/api/alphaclaw/version",
      tier: "safe",
      params: {
        fields: [
          {
            name: "refresh",
            location: "query",
            type: "string",
            required: false,
            description: "Pass 1 to bypass the cache and re-check the latest release.",
          },
        ],
        example: "GET /api/alphaclaw/version?refresh=1",
      },
    },
    {
      id: "system.release-notes",
      title: "AlphaClaw release notes from GitHub",
      method: "GET",
      path: "/api/alphaclaw/release-notes",
      tier: "safe",
      params: {
        fields: [
          {
            name: "tag",
            location: "query",
            type: "string",
            required: false,
            description:
              "Release tag to fetch; omitted fetches the latest release. Malformed tags are rejected (400).",
          },
        ],
        example: "GET /api/alphaclaw/release-notes?tag=v0.9.35",
      },
    },
    {
      id: "system.update",
      title: "Update AlphaClaw to the latest release",
      method: "POST",
      path: "/api/alphaclaw/update",
      tier: "dangerous",
      restart: "restarts",
      idempotent: false,
      readOp: "system.version",
      hint: "Update restarts the AlphaClaw server — the agent's own session drops.",
      notes: "409 while an OpenClaw version change is in progress; retry after it finishes.",
    },
    {
      id: "system.gateway-status",
      title: "Raw gateway status (openclaw status output)",
      method: "GET",
      path: "/api/gateway-status",
      tier: "safe",
    },
    {
      id: "system.gateway-dashboard",
      title: "Gateway dashboard link (token redacted)",
      method: "GET",
      path: "/api/gateway/dashboard",
      tier: "safe",
      redactResponse: redactDashboardUrl,
      notes: "The agent gets the tokenless URL; operators get the tokened link in the Setup UI.",
    },
    {
      id: "system.restart-status",
      title: "Restart-required and restart-in-progress state",
      method: "GET",
      path: "/api/restart-status",
      tier: "safe",
    },
    {
      id: "system.restart-status.dismiss",
      title: "Dismiss the restart-required flag without restarting",
      method: "POST",
      path: "/api/restart-status/dismiss",
      tier: "write",
      idempotent: true,
      readOp: "system.restart-status",
      notes: "Clears the flag only; pending config changes still need a restart to apply.",
    },
    {
      id: "system.gateway-restart",
      title: "Restart the OpenClaw gateway",
      method: "POST",
      path: "/api/gateway/restart",
      tier: "dangerous",
      restart: "restarts",
      idempotent: false,
      readOp: "system.restart-status",
      hint: "Restart drops the agent's own session mid-flight; confirm with the user first.",
    },
    // Self-loop surfaces: the agent messaging itself (or replaying its own
    // transcripts) creates feedback loops and impersonation risk.
    {
      id: "system.agent-sessions",
      title: "List agent sessions (labels, channels, reply targets)",
      method: "GET",
      path: "/api/agent/sessions",
      tier: "safe",
    },
    {
      id: "system.agent-message",
      title: "Send a message into an agent session (human-only)",
      method: "POST",
      path: "/api/agent/message",
      tier: "denied",
      hint: "Self-loop: talk to the user directly instead of messaging agent sessions.",
    },
    {
      id: "system.chat-history",
      title: "Read a session's chat transcript (human-only)",
      method: "GET",
      path: "/api/chat/history",
      tier: "denied",
      hint: "Self-loop: talk to the user directly instead of reading session transcripts.",
    },
  ],
};
