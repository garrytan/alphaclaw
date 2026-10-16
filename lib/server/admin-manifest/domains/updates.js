// OpenClaw runtime settings surface (routes/openclaw-settings.js). The
// OpenClaw version itself is pinned in AlphaClaw's package.json; there is no
// in-app version switching. Every route here answers the structured
// {ok, code, message, hint} envelope.

module.exports = {
  domain: "updates",
  title: "OpenClaw Runtime",
  ops: [
    {
      id: "updates.features",
      title: "Version-gated OpenClaw feature map",
      method: "GET",
      path: "/api/openclaw/features",
      tier: "safe",
      envelope: "structured",
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
      id: "updates.backup.status",
      title: "Back up now: running flag and the last result",
      method: "GET",
      path: "/api/openclaw/backup",
      tier: "safe",
      envelope: "structured",
    },
    {
      id: "updates.backup",
      title: "Back up now (OpenClaw's own `openclaw backup create --verify`)",
      method: "POST",
      path: "/api/openclaw/backup",
      tier: "write",
      envelope: "structured",
      idempotent: false,
      readOp: "updates.backup.status",
      hint: "Runs in the background; poll updates.backup.status until running is false.",
      notes: "Returns 202 {started:true}, or 409 backup_in_progress. The gateway keeps running.",
    },
    {
      id: "updates.upgrade-status",
      title: "OpenClaw data upgrade alert (did the pinned version's doctor --fix finish?)",
      method: "GET",
      path: "/api/openclaw/upgrade-status",
      tier: "safe",
      notes: "Non-admin callers (the agent actor included) get the member view: headline, sentence and memberLine, no paths or preflight.",
    },
    {
      id: "updates.upgrade-status.dismiss",
      title: "Dismiss the admin-only 'upgrade ran without a safety snapshot' notice",
      method: "POST",
      path: "/api/openclaw/upgrade-status/dismiss",
      tier: "write",
      idempotent: true,
      readOp: "updates.upgrade-status",
      params: {
        fields: [
          { name: "key", location: "body", type: "string", required: true, description: "The alert's dismissKey (16 hex chars)." },
        ],
        example: '{"key":"0123456789abcdef"}',
      },
    },
    {
      id: "updates.snapshots.proposal",
      title: "What Enable snapshots would change (read-only)",
      method: "GET",
      path: "/api/openclaw/snapshots/proposal",
      tier: "safe",
    },
    {
      id: "updates.snapshots.enable",
      title: "Enable snapshots: chmod +t the directories OpenClaw's capture check refuses",
      method: "POST",
      path: "/api/openclaw/snapshots/enable",
      tier: "dangerous",
      idempotent: false,
      readOp: "updates.snapshots.proposal",
      hint: "Changes directory permissions on the data volume; show the user the proposal's exact paths and modes first.",
      params: {
        fields: [
          { name: "proposalId", location: "body", type: "string", required: true, description: "From updates.snapshots.proposal; a changed directory refuses with proposal_stale." },
        ],
        example: '{"proposalId":"0123456789abcdef0123456789abcdef"}',
      },
    },
    {
      id: "updates.doctor-output",
      title: "The newest openclaw doctor --fix run's output (redacted, last 256 KB)",
      method: "GET",
      path: "/api/openclaw/doctor-output",
      tier: "safe",
    },
    {
      id: "updates.upgrade-retry",
      title: "Retry OpenClaw's data upgrade (stops the gateway, runs doctor --fix, starts it again)",
      method: "POST",
      path: "/api/openclaw/boot-migration/retry",
      tier: "dangerous",
      restart: "restarts",
      idempotent: false,
      readOp: "system.restart-status",
      hint: "The gateway is down for the whole Doctor run (minutes); confirm with the user first.",
      notes: "202 + operationId. 409 codes: operation_in_progress, upgrade_complete, upgrade_window_refused, unchanged_since_failure (resend with confirmUnchanged:true to retry anyway).",
      params: {
        fields: [
          { name: "confirmUnchanged", location: "body", type: "boolean", required: false, description: "Retry even though nothing changed since the remembered failure." },
        ],
        example: '{"confirmUnchanged":false}',
      },
    },
    {
      id: "updates.capabilities",
      title: "Installed OpenClaw capability probes (feature flags, cached)",
      method: "GET",
      path: "/api/openclaw/capabilities",
      tier: "safe",
      notes: "Feature-detects the installed OpenClaw and caches the result; the first call after a boot may take a few seconds.",
    },
  ],
};
