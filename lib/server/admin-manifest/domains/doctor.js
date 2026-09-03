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
      title: "Update Drift Doctor settings (scheduled scans toggle, scan caps)",
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
            required: false,
            description:
              "Opt-in scheduled Drift Doctor scans (spends the operator's LLM tokens; throttled to one scan per 6h).",
          },
          {
            name: "scan.maxFiles",
            location: "body",
            type: "number",
            required: false,
            description:
              "Workspace scan file-count cap (integer 1000-500000, or null to reset to the built-in default).",
          },
          {
            name: "scan.maxFileMb",
            location: "body",
            type: "number",
            required: false,
            description:
              "Per-file size cap in MB (integer 1-100, or null to reset to the built-in default).",
          },
        ],
        example: '{"autoRunEnabled": true, "scan": {"maxFiles": 300000}}',
      },
      notes:
        "Partial bodies: at least one recognized field required (empty {} is a 400). Persisted in alphaclaw.json (doctor.autoRun.enabled, doctor.scan); auto-run takes effect on the next 15-min tick, scan caps trigger an immediate background re-scan — no restart. GET returns {configured, effective} per cap.",
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
      notes:
        "workspaceManifest is retained only on the most recent runs (retention keeps the newest two manifest-bearing runs plus the latest completed run); older runs return workspaceManifest: null.",
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
            required: true,
            description:
              "Agent session to run the fix in (from agent.sessions); required — omitted or unknown keys are a 400.",
          },
          {
            name: "replyChannel",
            location: "body",
            type: "string",
            required: false,
            description:
              "Advisory (back-compat): the server derives the delivery channel from sessionKey. Must be paired with replyTo (a half-specified pair is a 400).",
          },
          {
            name: "replyTo",
            location: "body",
            type: "string",
            required: false,
            description:
              "Advisory (back-compat): server-derived from sessionKey. Formats: telegram = bare chat id or groupId:topicId; discord/slack DMs = user:<id>, channels = channel:<id>.",
          },
        ],
        example:
          '{"sessionKey":"agent:main:telegram:direct:1050","prompt":"Free up disk space under logs/ first"}',
      },
      notes:
        "202 when queued; card must be open — 409 if a fix is already in progress or the card is dismissed/fixed; unknown sessionKey is a 400 (validated against the live session list). The reply target derives server-side from sessionKey; the response carries delivery {attached, replyChannel, replyTo, replyAccountId} ('attached' means delivery params were sent with the dispatch, not that the message was delivered).",
    },
  ],
};
