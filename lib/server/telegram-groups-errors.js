// The one Telegram group rules error table (GST-1975 d10/d11). Every failure
// of the /api/telegram/groups* and /api/telegram/blocked-senders routes is an
// RFC 9457 problem body with a real HTTP status, one of these codes, its fix,
// its retry guidance and what already happened (sideEffects: none, partial or
// complete). Each anchor is a heading in
// lib/setup/skills/alphaclaw-admin/telegram.md, following relay/errors.js.
const kTelegramGroupErrors = Object.freeze({
  invalid_group_id: {
    status: 400,
    title: "The group id is not a Telegram group id",
    fix: "Use the group's numeric chat id, for example -1001234567890 (supergroups start with -100).",
    retry: "none",
  },
  invalid_input: {
    status: 400,
    title: "The request is missing a field or has a bad value",
    fix: "The detail names the field. Modes are approved, trusted, silent and blocked; people are numeric Telegram user ids.",
    retry: "none",
  },
  humans_only: {
    status: 403,
    title: "Only a signed-in person can change Telegram group rules",
    fix: "Ask your owner to change it in AlphaClaw.",
    retry: "none",
  },
  telegram_not_configured: {
    status: 409,
    title: "Telegram is not set up on this box",
    fix: "Connect a Telegram bot first (Channels page).",
    retry: "none",
  },
  revision_required: {
    status: 428,
    title: "The change needs the group's current revision",
    fix: "Read GET /api/telegram/groups and send the group's revision in an If-Match header.",
    retry: "after reading the revision",
  },
  revision_mismatch: {
    status: 412,
    title: "The group's rules changed since you read them",
    fix: "Read the groups again, check the new rules, and send the change with the new revision.",
    retry: "after reading the revision",
  },
  owner_required: {
    status: 422,
    title: "The owner's Telegram ids are not known, so the save could leave the owner out",
    fix: "Set commands.ownerAllowFrom (or the bot's DM allowFrom) in openclaw.json to the owner's Telegram user ids, then save again.",
    retry: "after the owner ids are set",
  },
  owner_protected: {
    status: 422,
    title: "The owner cannot be blocked",
    fix: "Remove the owner's id from the list. The owner is always allowed.",
    retry: "none",
  },
  empty_groups: {
    status: 422,
    title: "The save would leave the Telegram groups list empty",
    fix: "Keep at least one group entry. An empty list lets OpenClaw admit any group an allowed sender writes in, so group entries are set to Silent instead of being removed.",
    retry: "none",
  },
  account_policy: {
    status: 422,
    title: "The bot's group policy is not allowlist",
    fix: "Set groupPolicy to \"allowlist\" for this Telegram account in openclaw.json, so only listed groups are admitted, then save again.",
    retry: "after the policy is fixed",
  },
  custom_config: {
    status: 409,
    title: "This group's rules were set outside AlphaClaw",
    fix: "Ask your owner to change it in AlphaClaw: review the group's current rules, then save again with convert:true to replace the custom rules. The old rules are backed up.",
    retry: "with convert set",
  },
  topic_override: {
    status: 409,
    title: "A forum topic in this group overrides who may talk there",
    fix: "Send the change again with \"normalizeTopics\": true to remove the topics' enabled, groupPolicy and allowFrom overrides, so the group's mode applies to every topic.",
    retry: "with normalizeTopics set",
  },
  message_tool_replies: {
    status: 409,
    title: "Group replies go through the message tool, which can post into other chats",
    fix: "Set tools.message.crossContext.allowWithinProvider to false in openclaw.json (or set messages.groupChat.visibleReplies to automatic), then approve the group again.",
    retry: "after the setting is changed",
  },
  config_invalid: {
    status: 422,
    title: "OpenClaw rejected the new group rules",
    fix: "Nothing was saved. The detail quotes OpenClaw's validation error.",
    retry: "none",
  },
  validator_unavailable: {
    status: 503,
    title: "OpenClaw's config check could not run, so nothing was saved",
    fix: "Check that the openclaw command works on the box (openclaw config validate), then save again.",
    retry: "after 10 seconds",
  },
  config_unreadable: {
    status: 503,
    title: "AlphaClaw cannot read openclaw.json, so it will not rewrite it",
    fix: "Fix the file so it is plain JSON (the detail names the problem), then save again.",
    retry: "after the file is fixed",
  },
  rules_unreadable: {
    status: 503,
    title: "AlphaClaw cannot read its Telegram group rules file, so it will not show or change the rules",
    fix: "Nothing was saved and the block list was left as it is. Fix telegram/group-rules.json under AlphaClaw's root so it is a JSON object (the detail names the problem), then try again.",
    retry: "after the file is fixed",
  },
  config_busy: {
    status: 503,
    title: "Another change to openclaw.json was in progress",
    fix: "Nothing was saved. Send the same request again.",
    retry: "after 2 seconds",
  },
  leave_failed: {
    status: 502,
    title: "The group is blocked, but the bot could not leave it",
    fix: "The group is silent and stays silent. Send the same request again to retry leaving; the join watcher also leaves it if the bot is added again.",
    retry: "safe to retry",
  },
  internal_error: {
    status: 500,
    title: "AlphaClaw could not complete the change",
    fix: "The detail names the error. Read the groups again to see what was saved before retrying.",
    retry: "after reading the groups",
  },
});

class TelegramGroupsError extends Error {
  constructor(code, detail = "", { sideEffects = "none", extra = null } = {}) {
    const entry = kTelegramGroupErrors[code] || kTelegramGroupErrors.internal_error;
    super(detail ? String(detail) : entry.title);
    this.name = "TelegramGroupsError";
    this.code = kTelegramGroupErrors[code] ? code : "internal_error";
    this.status = entry.status;
    this.sideEffects = sideEffects;
    this.extra = extra;
  }
}

const kDocBase = "https://github.com/garrytan/alphaclaw/blob/main/lib/setup/skills/alphaclaw-admin/telegram.md#";

const toTelegramGroupsError = (error) => {
  if (error instanceof TelegramGroupsError) return error;
  if (error?.code === "OPENCLAW_CONFIG_UNREADABLE") return new TelegramGroupsError("config_unreadable", error.message);
  if (error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" || error?.code === "ELOCKTIMEOUT") {
    return new TelegramGroupsError("config_busy", error.message);
  }
  return new TelegramGroupsError("internal_error", error?.message || String(error));
};

const sendTelegramGroupsProblem = (res, error) => {
  const problem = toTelegramGroupsError(error);
  const entry = kTelegramGroupErrors[problem.code];
  res
    .status(problem.status)
    .type("application/problem+json")
    .json({
      type: kDocBase + problem.code,
      title: entry.title,
      status: problem.status,
      detail: problem.message,
      code: problem.code,
      fix: entry.fix,
      retry: entry.retry,
      sideEffects: problem.sideEffects,
      ...(problem.extra || {}),
    });
};

module.exports = { kTelegramGroupErrors, TelegramGroupsError, toTelegramGroupsError, sendTelegramGroupsProblem };
