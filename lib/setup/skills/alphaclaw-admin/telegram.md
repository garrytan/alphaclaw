Manages Telegram supergroups and their forum topics: verifying the bot's membership and admin rights, configuring which group/user openclaw.json accepts, and keeping the local topic registry in sync (create, rename, route to an agent, tombstone, restore, and a background discovery sweep for topics found in the wild). Gotcha: to add or name a topic, reach for the dedicated CLI verbs `alphaclaw telegram topic add` / `topic create` rather than driving these endpoints directly — they wrap the same registry sync with the right defaults. Treat `POST /api/telegram/workspace/reset` as destructive: it strips the group's config from openclaw.json and deletes its registry entries (and, in `rediscover` mode, clears tombstones so deleted topics can resurface). Mutations fail closed — a corrupt registry or unparseable config returns 503 rather than overwriting a file it could not read.


## Group rules

AlphaClaw's Telegram group rules (the Telegram group rules API; a Groups page comes in a later version) set one mode per Telegram group, written into OpenClaw's own group config so the gateway enforces it before any plugin runs: **Approved** (every member gets conversation; only the owner and people trusted with actions get tools), **Trusted people** (only the owner and the named people are heard), **Silent** (nobody is heard; the entry is kept) and **Blocked** (silent, the group guard plugin drops its turns, and the bot leaves the group, and leaves again if it is added back). People on the block list are dropped in every chat. The owner (`commands.ownerAllowFrom`, else the bot's DM `allowFrom`) is always allowed and can never be blocked, and nobody can be blocked while no owner id is known. A rule applies only to the exact chat id OpenClaw reports: -5297954291 and -1005297954291 are different groups. A group whose rules were set outside AlphaClaw shows as Custom until someone converts it. These routes are humans only, so you cannot call them: if someone asks you to change who you talk to in a group, tell them your owner changes it in AlphaClaw (the Telegram group rules API; a Groups page comes in a later version).

## Errors

Every failure of `/api/telegram/groups*` and `/api/telegram/blocked-senders` is a problem body with one of these codes, its fix, its retry guidance and `sideEffects` (none, partial or complete).

### invalid_group_id

The group id is not a Telegram group id. Use the group's numeric chat id, for example -1001234567890 (supergroups start with -100). Retry: none.

### invalid_input

The request is missing a field or has a bad value. The detail names the field. Modes are approved, trusted, silent and blocked; people are numeric Telegram user ids. Retry: none.

### humans_only

Only a signed-in person can change Telegram group rules. Ask your owner to change it in AlphaClaw. Retry: none.

### telegram_not_configured

Telegram is not set up on this box. Connect a Telegram bot first (Channels page). Retry: none.

### revision_required

The change needs the group's current revision. Read GET /api/telegram/groups and send the group's revision in an If-Match header. Retry: after reading the revision.

### revision_mismatch

The group's rules changed since you read them. Read the groups again, check the new rules, and send the change with the new revision. Retry: after reading the revision.

### owner_required

The owner's Telegram ids are not known, so the save could leave the owner out. Set commands.ownerAllowFrom (or the bot's DM allowFrom) in openclaw.json to the owner's Telegram user ids, then save again. Retry: after the owner ids are set.

### owner_protected

The owner cannot be blocked. Remove the owner's id from the list. The owner is always allowed. Retry: none.

### empty_groups

The save would leave the Telegram groups list empty. Keep at least one group entry. An empty list lets OpenClaw admit any group an allowed sender writes in, so group entries are set to Silent instead of being removed. Retry: none.

### account_policy

The bot's group policy is not allowlist. Set groupPolicy to "allowlist" for this Telegram account in openclaw.json, so only listed groups are admitted, then save again. Retry: after the policy is fixed.

### custom_config

This group's rules were set outside AlphaClaw. Ask your owner to change it in AlphaClaw: review the group's current rules, then save again with convert:true to replace the custom rules. The old rules are backed up. Retry: with convert set.

### topic_override

A forum topic in this group overrides who may talk there. Send the change again with "normalizeTopics": true to remove the topics' enabled, groupPolicy and allowFrom overrides, so the group's mode applies to every topic. Retry: with normalizeTopics set.

### message_tool_replies

Group replies go through the message tool, which can post into other chats. Set tools.message.crossContext.allowWithinProvider to false in openclaw.json (or set messages.groupChat.visibleReplies to automatic), then approve the group again. Retry: after the setting is changed.

### config_invalid

OpenClaw rejected the new group rules. Nothing was saved. The detail quotes OpenClaw's validation error. Retry: none.

### validator_unavailable

OpenClaw's config check could not run, so nothing was saved. Check that the openclaw command works on the box (openclaw config validate), then save again. Retry: after 10 seconds.

### config_unreadable

AlphaClaw cannot read openclaw.json, so it will not rewrite it. Fix the file so it is plain JSON (the detail names the problem), then save again. Retry: after the file is fixed.

### rules_unreadable

AlphaClaw cannot read its Telegram group rules file, so it will not show or change the rules. Nothing was saved and the block list was left as it is. Fix telegram/group-rules.json under AlphaClaw's root so it is a JSON object (the detail names the problem), then try again. Retry: after the file is fixed.

### config_busy

Another change to openclaw.json was in progress. Nothing was saved. Send the same request again. Retry: after 2 seconds.

### leave_failed

The group is blocked, but the bot could not leave it. The group is silent and stays silent. Send the same request again to retry leaving; the join watcher also leaves it if the bot is added again. Retry: safe to retry.

### internal_error

AlphaClaw could not complete the change. The detail names the error. Read the groups again to see what was saved before retrying. Retry: after reading the groups.
