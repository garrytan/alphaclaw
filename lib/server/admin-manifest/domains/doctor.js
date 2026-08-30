module.exports = {
  domain: "doctor",
  title: "Doctor",
  ops: [
    {
      id: "doctor.status",
      title: "Doctor status (current/last run, open card counts)",
      method: "GET",
      path: "/api/doctor/status",
      tier: "safe",
    },
    {
      id: "doctor.settings.read",
      title: "Read Drift Doctor settings (scheduled scans)",
      method: "GET",
      path: "/api/doctor/settings",
      tier: "safe",
    },
    {
      id: "doctor.settings.update",
      title: "Update Drift Doctor settings (scheduled scans toggle)",
      method: "PUT",
      path: "/api/doctor/settings",
      tier: "write",
      idempotent: true,
      readOp: "doctor.settings.read",
      params: {
        fields: [
          {
            name: "autoRunEnabled",
            location: "body",
            type: "boolean",
            required: true,
            description:
              "Opt-in scheduled Drift Doctor scans (spends the operator's LLM tokens; throttled to one scan per 6h).",
          },
        ],
        example: '{"autoRunEnabled": true}',
      },
      notes:
        "Persisted in alphaclaw.json (doctor.autoRun.enabled); takes effect on the next 15-min tick, no restart.",
    },
    {
      id: "doctor.run",
      title: "Start a doctor run (openclaw doctor)",
      method: "POST",
      path: "/api/doctor/run",
      tier: "write",
      idempotent: false,
      readOp: "doctor.status",
      notes:
        "202 when a run starts (200 if a recent run is reused); 409 if one is already running — poll doctor.status.",
    },
    {
      id: "doctor.import",
      title: "Import raw doctor CLI output as a run",
      method: "POST",
      path: "/api/doctor/import",
      tier: "write",
      idempotent: false,
      readOp: "doctor.runs",
      params: {
        fields: [
          {
            name: "rawOutput",
            location: "body",
            type: "string",
            required: true,
            description:
              "Raw `openclaw doctor` output to parse into a run + finding cards. Unparseable output is rejected (400).",
          },
        ],
        example: '{"rawOutput":"OpenClaw Doctor\\n[warn] disk usage at 91%..."}',
      },
    },
    {
      id: "doctor.runs",
      title: "List doctor runs",
      method: "GET",
      path: "/api/doctor/runs",
      tier: "safe",
      params: {
        fields: [
          {
            name: "limit",
            location: "query",
            type: "number",
            required: false,
            description: "Max runs to return (newest first).",
          },
        ],
        example: "GET /api/doctor/runs?limit=10",
      },
    },
    {
      id: "doctor.run-detail",
      title: "Get one doctor run",
      method: "GET",
      path: "/api/doctor/runs/:id",
      tier: "safe",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Doctor run id from doctor.runs; 404 if unknown.",
          },
        ],
        example: "GET /api/doctor/runs/run-42",
      },
    },
    {
      id: "doctor.run-cards",
      title: "List finding cards for one doctor run",
      method: "GET",
      path: "/api/doctor/runs/:id/cards",
      tier: "safe",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Doctor run id from doctor.runs; 404 if unknown.",
          },
        ],
        example: "GET /api/doctor/runs/run-42/cards",
      },
    },
    {
      id: "doctor.cards",
      title: "List doctor finding cards",
      method: "GET",
      path: "/api/doctor/cards",
      tier: "safe",
      params: {
        fields: [
          {
            name: "runId",
            location: "query",
            type: "string",
            required: false,
            description: 'Filter to one run id (default "all" — cards across every run).',
          },
        ],
        example: "GET /api/doctor/cards?runId=run-42",
      },
    },
    {
      id: "doctor.card-status",
      title: "Set a doctor card's status (open/dismissed/fixed)",
      method: "POST",
      path: "/api/doctor/cards/:id/status",
      tier: "write",
      // Absolute-value setter: re-sending the same status is a no-op.
      idempotent: true,
      readOp: "doctor.cards",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Card id from doctor.cards; 404 if unknown.",
          },
          {
            name: "status",
            location: "body",
            type: "string",
            required: true,
            description:
              "New status: open, dismissed, or fixed. Anything else is rejected (400).",
          },
        ],
        example: '{"status":"dismissed"}',
      },
    },
    {
      id: "doctor.finding-fix",
      title: "Queue an agent fix for a doctor finding",
      method: "POST",
      path: "/api/doctor/findings/:id/fix",
      tier: "write",
      idempotent: false,
      readOp: "doctor.cards",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Card id of the finding to fix; 404 if unknown.",
          },
          {
            name: "prompt",
            location: "body",
            type: "string",
            required: false,
            description: "Extra instructions passed to the fixing agent session.",
          },
          {
            name: "sessionKey",
            location: "body",
            type: "string",
            required: false,
            description: "Agent session to run the fix in (server default when omitted).",
          },
          {
            name: "replyChannel",
            location: "body",
            type: "string",
            required: false,
            description: "Channel to report the fix outcome to.",
          },
          {
            name: "replyTo",
            location: "body",
            type: "string",
            required: false,
            description: "Recipient/thread for the outcome report.",
          },
        ],
        example: '{"prompt":"Free up disk space under logs/ first"}',
      },
      notes:
        "202 when queued; card must be open — 409 if a fix is already in progress or the card is dismissed/fixed.",
    },
  ],
};
