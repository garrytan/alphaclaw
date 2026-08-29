// Team (named operators) management. The unauthenticated GET /api/team/login-info
// endpoint is deliberately unmanifested (see kUnmanifestedRoutes in index.js).
module.exports = {
  domain: "team",
  title: "Team",
  ops: [
    {
      id: "team.status",
      title: "Team mode status (enabled, operator count, identity probe)",
      method: "GET",
      path: "/api/team",
      tier: "safe",
    },
    {
      id: "team.update",
      title: "Enable/disable team mode (gateway auth-mode transition)",
      method: "PUT",
      path: "/api/team",
      tier: "dangerous",
      restart: "restarts",
      idempotent: true,
      readOp: "team.status",
      params: {
        fields: [
          {
            name: "enabled",
            location: "body",
            type: "boolean",
            required: true,
            description:
              "true switches the gateway to trusted-proxy (team) auth, false back to token auth. Non-boolean is 400; a transition already in flight is 409.",
          },
        ],
        example: '{"enabled": true}',
      },
      hint: "The auth-mode transition restarts the gateway — the agent's own session may drop mid-call.",
      notes: "On a failed post-restart probe the previous auth config is auto-restored (`restored: true`).",
    },
    {
      id: "team.operators.read",
      title: "List team operators",
      method: "GET",
      path: "/api/team/operators",
      tier: "safe",
    },
    {
      id: "team.operators.update",
      title: "Replace the full operator roster",
      method: "PUT",
      path: "/api/team/operators",
      tier: "write",
      idempotent: true,
      readOp: "team.operators.read",
      params: {
        fields: [
          {
            name: "operators",
            location: "body",
            type: "array<{id, name}>",
            required: true,
            description:
              "The FULL roster — omitting a current operator REMOVES them. Ids: letters, digits, . _ @ + - (max 128 chars), unique; max 50 operators. An empty list is rejected (400) while team mode is enabled.",
          },
        ],
        example: '{"operators":[{"id":"alice@example.com","name":"Alice"},{"id":"bob","name":"Bob"}]}',
      },
    },
  ],
};
