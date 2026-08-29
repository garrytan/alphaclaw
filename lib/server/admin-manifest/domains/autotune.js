module.exports = {
  domain: "autotune",
  title: "Resource Autotune",
  ops: [
    {
      id: "autotune.status",
      title: "Machine profile + autotune ledger",
      method: "GET",
      path: "/api/autotune",
      tier: "safe",
    },
    {
      id: "autotune.settings.update",
      title: "Update autotune settings",
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
              "Per-key merge; null clears; machine-clamped. Keys: gatewayHeapMb, uvThreadpoolSize, agentConcurrencyCap, openAiCompatBodyLimitMb, localBodyLimitMb, sqliteCacheMb, backupMaxTotalGb.",
          },
        ],
        example: '{"overrides":{"gatewayHeapMb":2048}}',
      },
      notes: "Each row's restartTarget names the finishing restart.",
    },
    {
      id: "autotune.reapply",
      title: "Re-detect resources and reapply tunings",
      method: "POST",
      path: "/api/autotune/reapply",
      tier: "write",
      idempotent: true,
      readOp: "autotune.status",
      restart: "marks",
      hint: "Skipped rows return 200 with the reason in the ledger.",
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
