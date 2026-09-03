module.exports = {
  domain: "admin",
  title: "Agent Admin",
  ops: [
    {
      id: "admin.manifest",
      title: "Operation catalog",
      method: "GET",
      path: "/api/admin/manifest",
      tier: "safe",
    },
    {
      id: "admin.audit",
      title: "Agent-admin audit log",
      method: "GET",
      path: "/api/admin/audit",
      tier: "safe",
      params: {
        fields: [
          {
            name: "op",
            location: "query",
            type: "string",
            required: false,
            description: "Filter to a single operation id (e.g. env.update).",
          },
          {
            name: "tier",
            location: "query",
            type: "string",
            required: false,
            description: "Filter by resolved tier: safe|write|restart|dangerous|denied.",
          },
          {
            name: "code",
            location: "query",
            type: "string",
            required: false,
            description:
              "Filter by a denied/confirm outcome code (e.g. denied, op_not_in_manifest, confirm_required). Successful outcome rows carry no code — filter those by status instead.",
          },
          {
            name: "since",
            location: "query",
            type: "string",
            required: false,
            description: "Only rows at/after this timestamp.",
          },
          {
            name: "limit",
            location: "query",
            type: "number",
            required: false,
            description: "Max rows to return; capped at 200.",
          },
          {
            name: "summary",
            location: "query",
            type: "string",
            required: false,
            description: "Pass 1 to aggregate counts instead of returning rows.",
          },
        ],
        example: "GET /api/admin/audit?tier=dangerous&since=2026-08-01T00:00:00Z&limit=50",
      },
    },
    // Pending confirm codes are the second factor for dangerous-tier ops; the
    // agent reading them would collapse the confirm dance into one actor.
    {
      id: "admin.confirms",
      title: "Read pending confirm codes (human-only)",
      method: "GET",
      path: "/api/admin/confirms",
      tier: "denied",
      hint: "Operators read pending confirm codes in the dashboard.",
    },
    {
      id: "admin.token-rotate",
      title: "Rotate the agent-admin token (human-only)",
      method: "POST",
      path: "/api/admin/token/rotate",
      tier: "denied",
      hint: "The agent may not govern its own credential; operators rotate it in the dashboard.",
    },
    // Scoped undo (E6/U4.7) is DEFERRED to a follow-up: a correct replay-
    // through-server-write-paths implementation requires refactoring the
    // load-bearing PUT /api/env handler (flagged by spec + eng reviews). The
    // admin route handlers stay dormant behind `if (undoService)` until then;
    // no undo op ships in the manifest so there is no manifest/route mismatch.
  ],
};
