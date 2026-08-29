module.exports = {
  domain: "autotune",
  title: "Resource Autotune",
  ops: [
    {
      id: "autotune.status",
      title: "Machine profile + autotune ledger (detected → derived → applied)",
      method: "GET",
      path: "/api/autotune",
      tier: "safe",
      notes: "Capacity + tunings; live usage is watchdog.resources.",
    },
    {
      id: "autotune.settings.update",
      title: "Update autotune settings (toggle + overrides)",
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
              "Per-key merge; null clears. Keys: gatewayHeapMb, uvThreadpoolSize, agentConcurrencyCap, openAiCompatBodyLimitMb, localBodyLimitMb, sqliteCacheMb, backupMaxTotalGb. Clamped to the live machine at apply time.",
          },
        ],
        example: '{"overrides":{"gatewayHeapMb":2048}}',
      },
      notes: "The ledger's restartTarget says which restart finishes each row.",
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
      hint: "Idempotent; skipped rows return 200 with the reason in the ledger.",
    },
    {
      id: "autotune.resize-ack",
      title: "Acknowledge the resize banner",
      method: "PUT",
      path: "/api/autotune/resize-ack",
      tier: "write",
      idempotent: true,
    },
  ],
};
