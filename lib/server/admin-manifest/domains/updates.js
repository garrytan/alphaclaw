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
      id: "updates.capabilities",
      title: "Installed OpenClaw capability probes (feature flags, cached)",
      method: "GET",
      path: "/api/openclaw/capabilities",
      tier: "safe",
      notes: "Feature-detects the installed OpenClaw and caches the result; the first call after a boot may take a few seconds.",
    },
  ],
};
