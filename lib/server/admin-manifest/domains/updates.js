// OpenClaw release-channel + update-run surface (routes/openclaw-channel.js).
// Every route here answers the structured {ok, code, message, hint} envelope.
module.exports = {
  domain: "updates",
  title: "OpenClaw Updates",
  ops: [
    {
      id: "updates.channel",
      title: "Channel state (release channel, installed/applied version, blocklist)",
      method: "GET",
      path: "/api/openclaw/channel",
      tier: "safe",
      envelope: "structured",
    },
    {
      id: "updates.catalog",
      title: "Version catalog annotated with current/last-known-good/blocked",
      method: "GET",
      path: "/api/openclaw/catalog",
      tier: "safe",
      envelope: "structured",
      params: {
        fields: [
          {
            name: "refresh",
            location: "query",
            type: "string",
            required: false,
            description: 'Pass "1" to bypass the cache and re-fetch from npm/GitHub.',
          },
        ],
        example: "GET /api/openclaw/catalog?refresh=1",
      },
    },
    {
      id: "updates.features",
      title: "Version-gated OpenClaw feature map",
      method: "GET",
      path: "/api/openclaw/features",
      tier: "safe",
      envelope: "structured",
    },
    {
      id: "updates.release-channel.set",
      title: "Select the OpenClaw release channel (stable/beta/dev)",
      method: "PUT",
      path: "/api/alphaclaw/config/updates/openclaw-release-channel",
      tier: "write",
      envelope: "structured",
      idempotent: true,
      readOp: "updates.channel",
      params: {
        fields: [
          {
            name: "releaseChannel",
            location: "body",
            type: "string",
            required: true,
            description:
              "One of stable | beta | dev; anything else is a 400. Selection only — nothing installs or activates until an explicit apply.",
          },
        ],
        example: '{"releaseChannel":"beta"}',
      },
      notes: "Deliberately does NOT mark restart-required; the running build is unchanged.",
    },
    {
      id: "updates.overseer.read",
      title: "Read upgrade-overseer setting + availability",
      method: "GET",
      path: "/api/openclaw/overseer",
      tier: "safe",
      envelope: "structured",
    },
    {
      id: "updates.overseer.update",
      title: "Enable/disable the upgrade overseer",
      method: "PUT",
      path: "/api/openclaw/overseer",
      tier: "write",
      envelope: "structured",
      idempotent: true,
      readOp: "updates.overseer.read",
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
    },
    {
      id: "updates.medic.read",
      title: "Read startup-medic setting + AI availability",
      method: "GET",
      path: "/api/openclaw/medic",
      tier: "safe",
    },
    {
      id: "updates.medic.update",
      title: "Enable/disable the startup medic (auto-repair on boot)",
      method: "PUT",
      path: "/api/openclaw/medic",
      tier: "write",
      idempotent: true,
      readOp: "updates.medic.read",
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
    },
    {
      id: "updates.repair",
      title: "Repair the current OpenClaw install (reinstall + reactivate)",
      method: "POST",
      path: "/api/openclaw/repair",
      tier: "dangerous",
      envelope: "structured",
      restart: "restarts",
      idempotent: false,
      readOp: "updates.channel",
      async: {
        statusOp: "updates.run-detail",
        idField: "operationId",
        terminalStates: ["noop", "failed", "interrupted", "activated", "activation_failed"],
      },
      hint: "Use when the installed build is broken.",
      notes: "Fast failures return synchronously; otherwise 202 with operationId + SSE events URL.",
    },
    {
      id: "updates.backup-sqlite",
      title: "Run a verified SQLite backup",
      method: "POST",
      path: "/api/openclaw/backup-sqlite",
      tier: "write",
      envelope: "structured",
      idempotent: false,
      readOp: "updates.features",
      notes:
        "503 feature_unsupported on OpenClaw older than 2026.8.1-beta.1; check updates.features first.",
    },
    {
      id: "updates.runs",
      title: "List update runs (summaries, steps omitted)",
      method: "GET",
      path: "/api/openclaw/runs",
      tier: "safe",
      envelope: "structured",
    },
    {
      id: "updates.run-detail",
      title: "Read one update run (full record incl. steps)",
      method: "GET",
      path: "/api/openclaw/runs/:operationId",
      tier: "safe",
      envelope: "structured",
      params: {
        fields: [
          {
            name: "operationId",
            location: "path",
            type: "string",
            required: true,
            description: "Operation UUID returned by apply; malformed ids are a 400.",
          },
        ],
        example: "GET /api/openclaw/runs/2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d",
      },
    },
    {
      id: "updates.run-log",
      title: "Read one update run's durable log",
      method: "GET",
      path: "/api/openclaw/runs/:operationId/log",
      tier: "safe",
      envelope: "structured",
      params: {
        fields: [
          {
            name: "operationId",
            location: "path",
            type: "string",
            required: true,
            description: "Operation UUID returned by apply; malformed ids are a 400.",
          },
          {
            name: "tail",
            location: "query",
            type: "number",
            required: false,
            description:
              "Serve only the last N bytes (capped at 1MB) — use it; dev logs can be multi-MB.",
          },
        ],
        example: "GET /api/openclaw/runs/2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d/log?tail=65536",
      },
      notes: "Success responses are text/plain, not JSON; errors keep the structured envelope.",
    },
    {
      id: "updates.apply",
      title: "Install + activate an OpenClaw build",
      method: "POST",
      path: "/api/openclaw/apply",
      tier: "dangerous",
      envelope: "structured",
      restart: "restarts",
      idempotent: false,
      readOp: "updates.channel",
      async: {
        statusOp: "updates.run-detail",
        idField: "operationId",
        terminalStates: ["noop", "failed", "interrupted", "activated", "activation_failed"],
      },
      params: {
        fields: [
          {
            name: "channel",
            location: "body",
            type: "string",
            required: true,
            description: "One of stable | beta | dev; anything else is a 400.",
          },
          {
            name: "version",
            location: "body",
            type: "string",
            required: false,
            description:
              "Required for stable/beta: a catalog-listed semver for THAT channel (a beta version is not applyable as stable).",
          },
          {
            name: "sha",
            location: "body",
            type: "string",
            required: false,
            description:
              "Required for dev unless devHead: a 7-40 char lowercase hex commit that is in the current dev commit list.",
          },
          {
            name: "devHead",
            location: "body",
            type: "boolean",
            required: false,
            description:
              'dev channel only: build the current HEAD instead of a pinned sha. Strict boolean — the string "false" would otherwise start a 30-minute build.',
          },
        ],
        example: '{"channel":"beta","version":"2026.8.1-beta.2"}',
      },
      hint:
        "State restart_expected means the relaunch is imminent.",
      notes: "Fast failures return synchronously; otherwise 202 with operationId + SSE events URL.",
    },
    {
      id: "updates.rollback",
      title: "Request rollback to the last-known-good build",
      method: "POST",
      path: "/api/openclaw/rollback",
      tier: "dangerous",
      envelope: "structured",
      readOp: "updates.channel",
      params: {
        fields: [
          {
            name: "confirmDataRisk",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Explicit consent to roll the CODE back even though the newer build migrated the state DBs (the rollback target may not read them). Only meaningful after a 409 rollback_requires_confirmation.",
          },
        ],
        example: '{"confirmDataRisk":true}',
      },
      hint:
        "Writes a rollback marker; the watchdog reverts and relaunches the gateway — the agent's own session may drop.",
      notes:
        "When the applied run migrated the DBs (or a gateway hold is set), the first attempt is a 409 rollback_requires_confirmation whose backupFile field names the verified pre-update backup to restore first; resend with confirmDataRisk: true to proceed anyway.",
    },
    {
      id: "updates.reconcile-retry",
      title: "Retry the held settings migration",
      method: "POST",
      path: "/api/openclaw/reconcile/retry",
      tier: "dangerous",
      envelope: "structured",
      readOp: "updates.channel",
      params: {
        fields: [
          {
            name: "stripBlamedKeys",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Explicit consent to remove the exact config keys the gateway's validator blamed (protected security paths are never removable). A pre-migration backup exists before any removal.",
          },
        ],
        example: '{"stripBlamedKeys":true}',
      },
      hint:
        "Only while updates.channel reports a gatewayHold; success relaunches the gateway (your session may drop).",
      notes:
        "409 codes: apply_in_progress (a channel update is running), reconcile_not_needed (no hold and the gateway is up — the doctor never touches a live gateway's DBs), reconcile_still_held (message carries the hold reason), reconcile_skipped (reconciler declined; hold and latch untouched). While held, POST /api/gateway/restart refuses with 409 gateway_held — recover through this op instead.",
    },
    {
      id: "updates.mark-good",
      title: "Mark the running build as last-known-good",
      method: "POST",
      path: "/api/openclaw/mark-good",
      tier: "dangerous",
      envelope: "structured",
      idempotent: true,
      readOp: "updates.channel",
      hint: "Overwrites the rollback target — a later rollback lands on THIS build.",
    },
    {
      id: "updates.blocklist.clear",
      title: "Clear the version blocklist (one id or all)",
      method: "POST",
      path: "/api/openclaw/blocklist/clear",
      tier: "dangerous",
      envelope: "structured",
      idempotent: true,
      readOp: "updates.channel",
      params: {
        fields: [
          {
            name: "id",
            location: "body",
            type: "string",
            required: false,
            description:
              "Version/sha to unblock (max 64 chars); omit or null to clear the whole blocklist.",
          },
        ],
        example: '{"id":"2026.8.1-beta.1"}',
      },
      hint: "Cleared builds — which previously failed here — become applyable again.",
    },
  ],
};
