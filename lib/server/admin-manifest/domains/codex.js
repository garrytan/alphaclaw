module.exports = {
  domain: "codex",
  title: "Codex OAuth",
  ops: [
    {
      id: "codex.status",
      title: "Codex CLI OAuth connection status",
      method: "GET",
      path: "/api/codex/status",
      tier: "safe",
    },
    {
      id: "codex.exchange",
      title: "Exchange a Codex OAuth authorization code",
      method: "POST",
      path: "/api/codex/exchange",
      tier: "write",
      idempotent: false,
      readOp: "codex.status",
      params: {
        fields: [
          {
            name: "code",
            location: "body",
            type: "string",
            required: true,
            description:
              "The OAuth authorization/redirect input from the Codex login flow. Secret-bearing — pipe via --data-stdin.",
          },
        ],
        example: '{"code": "<authorization-code-or-redirect-url>"}',
      },
      notes:
        "The browser-based Codex login is human-initiated; the agent can complete the exchange but cannot start the interactive flow.",
    },
    {
      id: "codex.disconnect",
      title: "Disconnect Codex OAuth",
      method: "POST",
      path: "/api/codex/disconnect",
      tier: "write",
      idempotent: true,
      readOp: "codex.status",
    },
  ],
};
