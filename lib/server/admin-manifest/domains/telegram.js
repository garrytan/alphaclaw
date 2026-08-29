// Telegram workspace + forum-topic management. Topic CRUD/restore/verify/bulk
// and the discovery sweep keep the existing "no confirmation needed" carve-out
// (write tier): topics are cheap, recoverable registry rows. Group configure
// rewrites openclaw.json (restart tier); workspace reset destroys registry
// entries (dangerous).
module.exports = {
  domain: "telegram",
  title: "Telegram",
  ops: [
    {
      id: "telegram.bot",
      title: "Verify bot token (getMe)",
      method: "GET",
      path: "/api/telegram/bot",
      tier: "safe",
      params: {
        fields: [
          {
            name: "accountId",
            location: "query",
            type: "string",
            required: false,
            description:
              "Channel account whose bot token to probe; unknown accounts fall back to the default token.",
          },
        ],
        example: "GET /api/telegram/bot?accountId=default",
      },
    },
    {
      id: "telegram.group-verify",
      title: "Verify a group (bot membership, admin rights, forum topics enabled)",
      method: "POST",
      path: "/api/telegram/groups/verify",
      tier: "safe",
      idempotent: true,
      params: {
        fields: [
          {
            name: "groupId",
            location: "body",
            type: "string",
            required: true,
            description:
              "Telegram chat id (accepts `chatId` alias); 400 when missing.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Bot account to verify with; defaults to the default token.",
          },
        ],
        example: '{"groupId":"-1001234567890"}',
      },
      notes:
        "Non-mutating probe (POST only for body transport); also returns a suggestedUserId from group admins.",
    },
    {
      id: "telegram.group-topics",
      title: "List a group's topics from the registry",
      method: "GET",
      path: "/api/telegram/groups/:groupId/topics",
      tier: "safe",
      params: {
        fields: [
          {
            name: "groupId",
            location: "path",
            type: "string",
            required: true,
            description:
              "Telegram group/chat id; unknown groups return an empty topics map, not 404.",
          },
        ],
        example: "GET /api/telegram/groups/-1001234567890/topics",
      },
    },
    {
      id: "telegram.topics-list",
      title: "Flat topic listing (all groups, incl. stale/deleted) + discovery status",
      method: "GET",
      path: "/api/telegram/topics",
      tier: "safe",
    },
    {
      id: "telegram.discovery-status",
      title: "Topic-discovery poller status",
      method: "GET",
      path: "/api/telegram/discovery/status",
      tier: "safe",
      notes: "503 when the discovery service is unavailable.",
    },
    {
      id: "telegram.discovery-sweep",
      title: "Run a topic-discovery sweep now",
      method: "POST",
      path: "/api/telegram/discovery/sweep",
      tier: "write",
      idempotent: false,
      readOp: "telegram.discovery-status",
      notes:
        "Write tier under the topics no-confirmation carve-out; 503 when the discovery service is unavailable.",
    },
    {
      id: "telegram.topic-create",
      title: "Create a forum topic (Telegram API + registry)",
      method: "POST",
      path: "/api/telegram/groups/:groupId/topics",
      tier: "write",
      idempotent: false,
      readOp: "telegram.group-topics",
      params: {
        fields: [
          {
            name: "groupId",
            location: "path",
            type: "string",
            required: true,
            description: "Forum group to create the topic in.",
          },
          {
            name: "name",
            location: "body",
            type: "string",
            required: true,
            description: "Topic name; 400 when missing/blank.",
          },
          {
            name: "iconColor",
            location: "body",
            type: "number",
            required: false,
            description: "Telegram icon color integer; non-numeric values are ignored.",
          },
          {
            name: "systemInstructions",
            location: "body",
            type: "string",
            required: false,
            description:
              "Per-topic system prompt stored in the registry (alias: systemPrompt).",
          },
          {
            name: "agentId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Route this topic to a specific agent; empty string clears routing; omit to leave unset.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Bot account that owns the group; defaults to default.",
          },
        ],
        example:
          '{"name":"ops","systemInstructions":"You handle ops.","agentId":"ops-agent"}',
      },
      notes:
        "Prefer the dedicated CLI verbs `alphaclaw telegram topic add/create`; write tier via the topics no-confirmation carve-out.",
    },
    {
      id: "telegram.topic-bulk-create",
      title: "Bulk-create forum topics",
      method: "POST",
      path: "/api/telegram/groups/:groupId/topics/bulk",
      tier: "write",
      idempotent: false,
      readOp: "telegram.group-topics",
      params: {
        fields: [
          {
            name: "groupId",
            location: "path",
            type: "string",
            required: true,
            description: "Forum group to create the topics in.",
          },
          {
            name: "topics",
            location: "body",
            type: "array<{name, iconColor?, systemInstructions?, agentId?}>",
            required: true,
            description:
              "Created one by one; failures are reported per row and the rest still land — check each results[].ok.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Bot account that owns the group; defaults to default.",
          },
        ],
        example:
          '{"topics":[{"name":"ops"},{"name":"research","agentId":"researcher"}]}',
      },
      notes:
        "Partial success is normal; prefer `alphaclaw telegram topic add/create` for single topics.",
    },
    {
      id: "telegram.topic-delete",
      title: "Delete a forum topic (Telegram + registry tombstone)",
      method: "DELETE",
      path: "/api/telegram/groups/:groupId/topics/:topicId",
      tier: "write",
      idempotent: true,
      readOp: "telegram.group-topics",
      params: {
        fields: [
          {
            name: "groupId",
            location: "path",
            type: "string",
            required: true,
            description: "Group the topic belongs to.",
          },
          {
            name: "topicId",
            location: "path",
            type: "number",
            required: true,
            description: "Forum thread id to delete.",
          },
          {
            name: "accountId",
            location: "query",
            type: "string",
            required: false,
            description: "Bot account that owns the group; defaults to default.",
          },
        ],
        example: "DELETE /api/telegram/groups/-1001234567890/topics/42",
      },
      notes:
        "Already-gone topics still succeed (removedFromRegistryOnly: true); tombstoned so discovery cannot resurrect them.",
    },
    {
      id: "telegram.topic-restore",
      title: "Restore a tombstoned topic so discovery may see it again",
      method: "POST",
      path: "/api/telegram/groups/:groupId/topics/:topicId/restore",
      tier: "write",
      idempotent: true,
      readOp: "telegram.topics-list",
      params: {
        fields: [
          {
            name: "groupId",
            location: "path",
            type: "string",
            required: true,
            description: "Group the tombstoned topic belongs to.",
          },
          {
            name: "topicId",
            location: "path",
            type: "number",
            required: true,
            description: "Forum thread id to un-tombstone.",
          },
        ],
        example: "POST /api/telegram/groups/-1001234567890/topics/42/restore",
      },
      notes:
        "Registry-only — does not recreate the Telegram topic; write tier via the topics carve-out.",
    },
    {
      id: "telegram.topic-verify",
      title: "Probe a topic's existence (marks registry row stale/fresh)",
      method: "POST",
      path: "/api/telegram/groups/:groupId/topics/:topicId/verify",
      tier: "write",
      idempotent: true,
      readOp: "telegram.group-topics",
      params: {
        fields: [
          {
            name: "groupId",
            location: "path",
            type: "string",
            required: true,
            description: "Group the topic belongs to.",
          },
          {
            name: "topicId",
            location: "path",
            type: "number",
            required: true,
            description: "Forum thread id to probe; 400 when non-numeric.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Bot account that owns the group; defaults to default.",
          },
        ],
        example: "POST /api/telegram/groups/-1001234567890/topics/42/verify",
      },
      notes:
        "Sends a typing chat action; transient/auth failures return 502 without touching staleness.",
    },
    {
      id: "telegram.topic-update",
      title: "Update a topic (rename, system instructions, agent routing)",
      method: "PUT",
      path: "/api/telegram/groups/:groupId/topics/:topicId",
      tier: "write",
      idempotent: true,
      readOp: "telegram.group-topics",
      params: {
        fields: [
          {
            name: "groupId",
            location: "path",
            type: "string",
            required: true,
            description: "Group the topic belongs to.",
          },
          {
            name: "topicId",
            location: "path",
            type: "number",
            required: true,
            description: "Forum thread id; 400 when non-numeric.",
          },
          {
            name: "name",
            location: "body",
            type: "string",
            required: true,
            description:
              "Required even when only changing instructions/routing; 400 when blank. Renames in Telegram only if changed.",
          },
          {
            name: "systemInstructions",
            location: "body",
            type: "string",
            required: false,
            description:
              "Replaces the stored per-topic prompt (alias: systemPrompt); omit to leave untouched.",
          },
          {
            name: "agentId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Set agent routing; empty string clears it; omit to leave untouched.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Bot account that owns the group; defaults to default.",
          },
        ],
        example: '{"name":"ops","agentId":"ops-agent"}',
      },
      notes:
        "A rename that hits a missing topic marks the registry row stale (lazy stale).",
    },
    {
      id: "telegram.group-configure",
      title: "Configure openclaw.json for a group (allow-list, mention gating)",
      method: "POST",
      path: "/api/telegram/groups/:groupId/configure",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "telegram.workspace",
      params: {
        fields: [
          {
            name: "groupId",
            location: "path",
            type: "string",
            required: true,
            description: "Telegram group to wire into channels.telegram.",
          },
          {
            name: "userId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Telegram user id allowed to command the bot; when omitted, resolved from group admins (creator preferred).",
          },
          {
            name: "groupName",
            location: "body",
            type: "string",
            required: false,
            description: "Display name stored in the local topic registry.",
          },
          {
            name: "requireMention",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Require an @-mention for the bot to respond in the group (default false).",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Bot account that owns the group; defaults to default.",
          },
        ],
        example: '{"requireMention":true,"groupName":"Ops HQ"}',
      },
      notes: "Rewrites channels.telegram group config; marks restart-required.",
    },
    {
      id: "telegram.topic-registry",
      title: "Read the full raw topic registry",
      method: "GET",
      path: "/api/telegram/topic-registry",
      tier: "safe",
    },
    {
      id: "telegram.workspace",
      title: "Workspace overview (configured groups, topics, concurrency)",
      method: "GET",
      path: "/api/telegram/workspace",
      tier: "safe",
      params: {
        fields: [
          {
            name: "accountId",
            location: "query",
            type: "string",
            required: false,
            description: "Bot account to inspect; defaults to default.",
          },
        ],
        example: "GET /api/telegram/workspace?accountId=default",
      },
      notes:
        "Self-heals a missing groupAllowFrom by re-resolving group admins — a read with a repair side effect.",
    },
    {
      id: "telegram.workspace-reset",
      title: "Reset Telegram workspace (group config + registry entries)",
      method: "POST",
      path: "/api/telegram/workspace/reset",
      tier: "dangerous",
      idempotent: false,
      readOp: "telegram.workspace",
      params: {
        fields: [
          {
            name: "mode",
            location: "body",
            type: "string",
            required: false,
            description:
              '"keep" (default) preserves tombstones so deleted topics stay dead; "rediscover" clears them so the next sweep may resurrect topics.',
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Bot account whose workspace to reset; defaults to default.",
          },
        ],
        example: '{"mode":"keep"}',
      },
      hint:
        "Destroys the account's registry group entries and clears channels.telegram group config — topics stay in Telegram but AlphaClaw forgets them.",
    },
  ],
};
