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
      // F068: the handler restarts the gateway itself (restartGateway after the
      // config write) — it does not just mark restart-required.
      restart: "restarts",
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
      // F068: the handler restarts the gateway itself (restartGateway after the
      // config write) — it does not just mark restart-required.
      restart: "restarts",
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
      // F068: the handler restarts the gateway itself (restartGateway after the
      // config write) — it does not just mark restart-required.
      restart: "restarts",
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
    {
      id: "channels.buzz.setup-status",
      title: "Buzz (Matrix relay) setup wizard state",
      method: "GET",
      path: "/api/channels/buzz/setup",
      tier: "safe",
    },
    {
      id: "channels.buzz.install",
      title: "Install the Buzz relay plugin",
      method: "POST",
      path: "/api/channels/buzz/setup/install",
      tier: "restart",
      restart: "marks",
      idempotent: false,
      readOp: "channels.buzz.setup-status",
      notes:
        "Installs an external OpenClaw plugin and mutates gateway config. 502 on install failure; re-read state to see progress.",
    },
    {
      id: "channels.buzz.configure",
      title: "Configure the Buzz relay endpoint",
      method: "POST",
      path: "/api/channels/buzz/setup/configure",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "channels.buzz.setup-status",
      params: {
        fields: [
          {
            name: "relayUrl",
            location: "body",
            type: "string",
            required: true,
            description: "The Buzz relay base URL. Invalid input is a 400.",
          },
          {
            name: "name",
            location: "body",
            type: "string",
            required: false,
            description: 'Display label for the channel. Defaults to "Buzz".',
          },
        ],
        example: '{"relayUrl":"https://relay.example.com","name":"Buzz"}',
      },
    },
    {
      id: "channels.buzz.probe",
      title: "Probe the Buzz relay (connection test, no mutation)",
      method: "POST",
      path: "/api/channels/buzz/setup/probe",
      tier: "safe",
      readOp: "channels.buzz.setup-status",
    },
    {
      id: "channels.buzz.rooms",
      title: "Select Buzz rooms + default outbound room",
      method: "POST",
      path: "/api/channels/buzz/setup/rooms",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "channels.buzz.setup-status",
      params: {
        fields: [
          {
            name: "groups",
            location: "body",
            type: "array<{id}>",
            required: true,
            description:
              "Rooms to relay, addressed by UUID (copy from the room's settings). Empty is a 400 no_rooms.",
          },
          {
            name: "defaultTo",
            location: "body",
            type: "string",
            required: false,
            description:
              "UUID of the default outbound room; must be one of the selected rooms.",
          },
        ],
        example: '{"groups":[{"id":"..."}],"defaultTo":"..."}',
      },
    },
    {
      id: "channels.buzz.cancel",
      title: "Cancel/reset the Buzz setup wizard",
      method: "POST",
      path: "/api/channels/buzz/setup/cancel",
      tier: "write",
      idempotent: true,
      readOp: "channels.buzz.setup-status",
    },
  ],
};
