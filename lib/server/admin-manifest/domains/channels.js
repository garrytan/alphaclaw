module.exports = {
  domain: "channels",
  title: "Channel Accounts",
  ops: [
    {
      id: "channels.accounts-list",
      title: "List configured channel accounts (tokens masked)",
      method: "GET",
      path: "/api/channels/accounts",
      tier: "safe",
      notes: "Token values are masked server-side; only env key names are exposed.",
    },
    // Plaintext bot-token read: never enters the agent transcript.
    {
      id: "channels.account-token",
      title: "Read a channel account token in plaintext (denied)",
      method: "GET",
      path: "/api/channels/accounts/token",
      tier: "denied",
      hint: "Tokens are set via env vars, read never.",
    },
    {
      id: "channels.account-add",
      title: "Add a channel account (binds to an agent, reboots gateway)",
      method: "POST",
      path: "/api/channels/accounts",
      tier: "restart",
      restart: "marks",
      idempotent: false,
      readOp: "channels.accounts-list",
      params: {
        fields: [
          {
            name: "provider",
            location: "body",
            type: "string",
            required: true,
            description:
              "One of telegram|discord|slack|whatsapp. Discord and WhatsApp allow a single account; a second add is rejected.",
          },
          {
            name: "agentId",
            location: "body",
            type: "string",
            required: true,
            description: "Agent to bind the account to. Unknown agent ids are rejected (404).",
          },
          {
            name: "token",
            location: "body",
            type: "string",
            required: false,
            description:
              "Bot token, stored as an env var (never in config). Required for every provider except whatsapp (QR login instead).",
          },
          {
            name: "appToken",
            location: "body",
            type: "string",
            required: false,
            description: "Slack app-level token; required when provider is slack.",
          },
          {
            name: "name",
            location: "body",
            type: "string",
            required: false,
            description: "Display label; defaults to the provider label.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Lowercase letters, numbers, hyphens. Defaults to \"default\" only when no accounts exist yet; required (and must be unique, else 409) otherwise.",
          },
        ],
        example:
          '{"provider":"telegram","agentId":"main","token":"123456:ABC-token","name":"Support Bot"}',
      },
      hint: "Pipe token-bearing bodies via --data-stdin so secrets stay out of process args.",
      notes:
        "Synchronous variant: reboots the gateway as its final step, so the agent's own session may drop — prefer the jobs variant.",
    },
    {
      id: "channels.account-add-job",
      title: "Add a channel account as a background job (202 + SSE progress)",
      method: "POST",
      path: "/api/channels/accounts/jobs",
      tier: "restart",
      restart: "marks",
      idempotent: false,
      readOp: "channels.accounts-list",
      async: {
        statusOp: "channels.operation-events",
        idField: "operationId",
        terminalStates: ["completed", "failed"],
      },
      params: {
        fields: [
          {
            name: "provider",
            location: "body",
            type: "string",
            required: true,
            description:
              "One of telegram|discord|slack|whatsapp. Discord and WhatsApp allow a single account; a second add is rejected.",
          },
          {
            name: "agentId",
            location: "body",
            type: "string",
            required: true,
            description: "Agent to bind the account to. Unknown agent ids are rejected (404).",
          },
          {
            name: "token",
            location: "body",
            type: "string",
            required: false,
            description:
              "Bot token, stored as an env var (never in config). Required for every provider except whatsapp (QR login instead).",
          },
          {
            name: "appToken",
            location: "body",
            type: "string",
            required: false,
            description: "Slack app-level token; required when provider is slack.",
          },
          {
            name: "name",
            location: "body",
            type: "string",
            required: false,
            description: "Display label; defaults to the provider label.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Lowercase letters, numbers, hyphens. Defaults to \"default\" only when no accounts exist yet; required (and must be unique, else 409) otherwise.",
          },
        ],
        example:
          '{"provider":"slack","agentId":"main","token":"xoxb-...","appToken":"xapp-...","name":"Ops Bot"}',
      },
      hint: "Pipe token-bearing bodies via --data-stdin so secrets stay out of process args.",
      notes:
        "Returns 202 with operationId + streamUrl; only one account creation may run at a time.",
    },
    {
      id: "channels.operation-events",
      title: "Stream progress events for a background operation (SSE)",
      method: "GET",
      path: "/api/operations/:operationId/events",
      tier: "safe",
      streaming: true,
      params: {
        fields: [
          {
            name: "operationId",
            location: "path",
            type: "string",
            required: true,
            description:
              "Operation id from a 202 response (e.g. channels.account-add-job). Unknown or expired ids return 404.",
          },
        ],
        example: "GET /api/operations/op-1234/events",
      },
      notes: "SSE stream: phase events, then a terminal completed/failed event.",
    },
    {
      id: "channels.account-update",
      title: "Update a channel account (name, agent binding, token rotation)",
      method: "PUT",
      path: "/api/channels/accounts",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "channels.accounts-list",
      params: {
        fields: [
          {
            name: "provider",
            location: "body",
            type: "string",
            required: true,
            description: "One of telegram|discord|slack|whatsapp. Unknown accounts are rejected (404).",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: 'Account to update; defaults to "default".',
          },
          {
            name: "name",
            location: "body",
            type: "string",
            required: true,
            description: "Display label — required on every update, not just when renaming.",
          },
          {
            name: "agentId",
            location: "body",
            type: "string",
            required: true,
            description:
              "Agent the account is bound to — required on every update; unknown agent ids are rejected.",
          },
          {
            name: "token",
            location: "body",
            type: "string",
            required: false,
            description: "New bot token; omit to keep the current one. Rotation marks restart-required.",
          },
          {
            name: "appToken",
            location: "body",
            type: "string",
            required: false,
            description: "New Slack app-level token; omit to keep the current one.",
          },
        ],
        example: '{"provider":"telegram","accountId":"default","name":"Support Bot","agentId":"main"}',
      },
      hint: "Pipe token-bearing bodies via --data-stdin so secrets stay out of process args.",
      notes: "Marks restart-required only when a token actually changed.",
    },
    {
      id: "channels.account-login",
      title: "Run channel login (WhatsApp QR pairing)",
      method: "POST",
      path: "/api/channels/accounts/login",
      tier: "restart",
      restart: "marks",
      idempotent: false,
      readOp: "channels.login-status",
      params: {
        fields: [
          {
            name: "provider",
            location: "body",
            type: "string",
            required: true,
            description: 'Only "whatsapp" is supported; other providers are rejected (400).',
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: 'Account to log in; defaults to "default".',
          },
        ],
        example: '{"provider":"whatsapp","accountId":"default"}',
      },
      notes:
        "Runs the CLI login with a ~12s window and returns its stdout/stderr; completed=false means pairing did not finish in time.",
    },
    {
      id: "channels.login-status",
      title: "Read channel login status",
      method: "GET",
      path: "/api/channels/accounts/login-status",
      tier: "safe",
      params: {
        fields: [
          {
            name: "provider",
            location: "query",
            type: "string",
            required: true,
            description: 'Only "whatsapp" is supported; other providers are rejected (400).',
          },
          {
            name: "accountId",
            location: "query",
            type: "string",
            required: false,
            description: 'Account to check; defaults to "default".',
          },
        ],
        example: "GET /api/channels/accounts/login-status?provider=whatsapp",
      },
    },
    {
      id: "channels.account-remove",
      title: "Remove a channel account",
      method: "DELETE",
      path: "/api/channels/accounts",
      tier: "restart",
      restart: "marks",
      idempotent: false,
      readOp: "channels.accounts-list",
      params: {
        fields: [
          {
            name: "provider",
            location: "body",
            type: "string",
            required: true,
            description: "One of telegram|discord|slack|whatsapp. Unknown accounts are rejected (404).",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: 'Account to remove; defaults to "default".',
          },
        ],
        example: '{"provider":"telegram","accountId":"default"}',
      },
      notes: "Also removes the account's env-stored token and bindings.",
    },
  ],
};
