module.exports = {
  domain: "autotune",
  title: "Resource Autotune",
  ops: [
    {
      id: "autotune.status",
      title:
        "Machine capacity profile + auto-tuned settings ledger (detected → derived → applied)",
      method: "GET",
      path: "/api/autotune",
      tier: "safe",
      notes:
        "Live USAGE lives at watchdog.resources; this is capacity and what autotune did about it.",
    },
    {
      id: "autotune.settings.update",
      title: "Update autotune settings (enabled toggle, per-knob overrides)",
      method: "PUT",
      path: "/api/autotune/settings",
      tier: "write",
      idempotent: true,
      readOp: "autotune.status",
      restart: "marks",
      params: {
        fields: [
          {
            name: "enabled",
            location: "body",
            type: "boolean",
            required: false,
            description: "Master toggle. Disabling restores built-in defaults.",
          },
          {
            name: "overrides",
            location: "body",
            type: "object",
            required: false,
            description:
              "Per-key merge; null clears a key. Keys: gatewayHeapMb, uvThreadpoolSize, agentConcurrencyCap, openAiCompatBodyLimitMb, localBodyLimitMb, sqliteCacheMb, backupMaxTotalGb. Overrides are clamped to what the machine can actually hold at apply time.",
          },
        ],
        example: '{"overrides":{"gatewayHeapMb":2048}}',
      },
      notes:
        "Gateway-env changes apply on the next gateway restart; the ledger's restartTarget says which restart finishes each row.",
    },
    {
      id: "autotune.reapply",
      title: "Re-detect container resources and reapply tunings",
      method: "POST",
      path: "/api/autotune/reapply",
      tier: "write",
      idempotent: true,
      readOp: "autotune.status",
      restart: "marks",
      hint: "Safe to repeat. Skipped rows (e.g. a JSON5 openclaw.json) return 200 with the reason in the ledger.",
    },
    {
      id: "autotune.resize-ack",
      title: "Acknowledge the container-resize banner",
      method: "PUT",
      path: "/api/autotune/resize-ack",
      tier: "write",
      idempotent: true,
    },
  ],
};
