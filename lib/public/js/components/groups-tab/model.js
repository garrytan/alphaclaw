// The Groups page's pure model (GST-1975 PR 2): which section a group sits
// in, what a problem body tells the owner, what a test verdict means and how
// a rule reads. No Preact here, so every branch is unit-tested.

export const kModeOptions = [
  { value: "approved", label: "Approved" },
  { value: "trusted", label: "Trusted people" },
  { value: "silent", label: "Silent" },
  { value: "blocked", label: "Blocked" },
];

export const kModeLabels = {
  waiting: "Waiting for you",
  approved: "Approved",
  trusted: "Trusted people",
  silent: "Silent",
  blocked: "Blocked",
  custom: "Custom",
};

const kSettableModes = new Set(kModeOptions.map((option) => option.value));

// Trusted people get their own section beside Approved: the two modes differ
// in who is heard at all, which is the first thing the owner looks for.
export const kGroupSections = [
  {
    id: "waiting",
    title: "Waiting for you",
    caption: "Your agent was added to these groups and stays silent in them until you pick a rule.",
  },
  {
    id: "custom",
    title: "Custom",
    caption: "These groups have rules AlphaClaw did not write. They keep working as they are. Pick a mode to replace them; the old rules are backed up first.",
  },
  {
    id: "approved",
    title: "Approved",
    caption: "Everyone in the group can talk to your agent. Only you and people trusted with actions can make it use tools.",
  },
  {
    id: "trusted",
    title: "Trusted people",
    caption: "Only you and the people listed are heard. Everyone else in the group is ignored.",
  },
  {
    id: "silent",
    title: "Silent",
    caption: "Your agent stays in these groups and answers nobody.",
  },
  {
    id: "blocked",
    title: "Blocked",
    caption: "Your agent left these groups, ignores them, and leaves again if someone adds it back.",
  },
];

export const groupName = (group) => String(group?.title || "").trim() || String(group?.groupId || "");

const sortKey = (group) => groupName(group).toLowerCase() + "\u0000" + String(group?.groupId || "");

// A mode the page does not know (a newer server) reads as Custom, so it is
// shown with its rules and never edited blind.
export const sectionIdForGroup = (group) => {
  const mode = group?.mode;
  if (mode === "waiting" || kSettableModes.has(mode)) return mode;
  return "custom";
};

export const sortGroupsIntoSections = (groups = []) => {
  const buckets = new Map(kGroupSections.map((section) => [section.id, []]));
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group?.groupId) continue;
    buckets.get(sectionIdForGroup(group)).push(group);
  }
  const lastJoin = (group) => Date.parse(group?.seen?.lastJoinAt || group?.seen?.firstSeenAt || "") || 0;
  buckets.get("waiting").sort((a, b) => lastJoin(b) - lastJoin(a) || sortKey(a).localeCompare(sortKey(b)));
  for (const id of ["custom", "approved", "trusted", "silent", "blocked"]) buckets.get(id).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return kGroupSections
    .map((section) => ({ ...section, groups: buckets.get(section.id) }))
    .filter((section) => section.groups.length > 0);
};

const plural = (count, one, many = one + "s") => count + " " + (count === 1 ? one : many);

export const buildGroupsHeadline = ({ data = null, problem = null } = {}) => {
  if (problem?.code === "rules_unreadable") return "AlphaClaw cannot read its Telegram group rules file, so nothing can be shown or saved.";
  if (!data) return problem ? "The Telegram groups could not be loaded." : "Loading…";
  if (data.configured === false) return "Telegram is not set up on this box.";
  const groups = Array.isArray(data.groups) ? data.groups : [];
  if (!groups.length) return "Your agent has not been added to any Telegram group yet.";
  const waiting = groups.filter((group) => group.mode === "waiting").length;
  if (waiting) return plural(waiting, "group") + (waiting === 1 ? " waits" : " wait") + " for you to pick a rule.";
  const custom = groups.filter((group) => sectionIdForGroup(group) === "custom").length;
  if (custom) return plural(custom, "group") + (custom === 1 ? " has" : " have") + " rules set outside AlphaClaw.";
  return "Every Telegram group your agent is in has a rule.";
};

export const countByMode = (groups = []) => {
  const counts = {};
  for (const group of Array.isArray(groups) ? groups : []) {
    const id = sectionIdForGroup(group);
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
};

// What a request that would save a mode sends. Trusted people only belong to
// the two modes that hear people; Custom rules are replaced only with convert.
export const buildPolicyBody = ({ group, mode, trusted = null, normalizeTopics = false, dryRun = false }) => {
  const body = { mode };
  if (mode === "approved" || mode === "trusted") {
    body.trusted = (trusted ?? group?.trusted ?? []).map((person) => ({
      id: String(person.id),
      scope: person.scope === "actions" ? "actions" : "conversation",
      ...(person.label ? { label: person.label } : {}),
    }));
  }
  if (group?.title) body.title = group.title;
  if (sectionIdForGroup(group) === "custom") body.convert = true;
  if (normalizeTopics) body.normalizeTopics = true;
  if (dryRun) body.dryRun = true;
  return body;
};

const kUserIdPattern = /^\d{1,20}$/;
export const kMaxLabelChars = 120;

// Checks a person typed into an add form. Returns { person } or { error }.
export const parsePersonInput = ({ id = "", label = "", owners = [] } = {}) => {
  const cleanId = String(id || "").trim();
  if (!cleanId) return { error: "Enter the person's numeric Telegram user id." };
  if (!kUserIdPattern.test(cleanId)) return { error: "A Telegram user id is digits only, for example 100000001. Usernames do not work here." };
  if ((owners || []).map(String).includes(cleanId)) return { error: "That is an owner. Owners are always heard and can never be blocked." };
  const cleanLabel = String(label || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, kMaxLabelChars);
  return { person: { id: cleanId, ...(cleanLabel ? { label: cleanLabel } : {}) } };
};

export const upsertTrusted = (list = [], person) => {
  const rest = (list || []).filter((entry) => String(entry.id) !== String(person.id));
  return [...rest, { scope: "conversation", ...person }].sort((a, b) => String(a.id).localeCompare(String(b.id)));
};

export const removeTrusted = (list = [], id) => (list || []).filter((entry) => String(entry.id) !== String(id));

export const setTrustedScope = (list = [], id, scope) =>
  (list || []).map((entry) => (String(entry.id) === String(id) ? { ...entry, scope } : entry));

// The block list is saved whole: the next list is what PUT receives.
export const nextBlockedList = (list = [], { add = null, removeId = null } = {}) => {
  const current = (list || []).map((entry) => ({ id: String(entry.id), ...(entry.label ? { label: entry.label } : {}) }));
  const kept = current.filter((entry) => entry.id !== String(removeId ?? "") && entry.id !== String(add?.id ?? ""));
  return add ? [...kept, add] : kept;
};

export const personName = (person) => String(person?.label || "").trim() || "Telegram user " + String(person?.id ?? "");

// ── Problem bodies ──────────────────────────────────────────────

// Fixes that name an API step the page does for the owner.
const kUiFix = {
  revision_required: "Reload the page and make the change again.",
  revision_mismatch: "Someone changed this group since the page loaded. The page now shows the new rules; check them and make the change again.",
  custom_config: "Pick a mode and confirm replacing the custom rules. The old rules are backed up first.",
  topic_override: "Preview the change again with the topic overrides removed, so the group's mode applies to every topic.",
  leave_failed: "The group is silent and stays silent. Press Try leaving again; the join watcher also leaves it if your agent is added back.",
  humans_only: "Sign in to AlphaClaw as a person to change group rules.",
};

const kRetryCopy = { none: "Sending the same change again will not help.", "safe to retry": "Safe to try again." };

const sentence = (text) => {
  const value = String(text || "").trim();
  if (!value) return "";
  const capital = value[0].toUpperCase() + value.slice(1);
  return /[.!?]$/.test(capital) ? capital : capital + ".";
};

// A retry that names an API step ("with convert set") is replaced by the
// page's own fix for that code.
export const describeRetry = (retry, code = null) => {
  if (!retry) return "";
  if (kUiFix[code] && /^(with |after reading)/.test(retry)) return "";
  if (kRetryCopy[retry]) return kRetryCopy[retry];
  if (/^(after|with) /.test(retry)) return "Try again " + retry + ".";
  return sentence(retry);
};

export const describeSideEffects = (problem, { action = "" } = {}) => {
  const effects = problem?.sideEffects;
  if (effects === "none") return "Nothing was changed.";
  if (effects === "complete") return "The change was saved.";
  if (effects !== "partial") return "";
  if (problem.code === "leave_failed") return "Part of the change was saved: the group is blocked and silent, but your agent is still a member.";
  if (action === "blocked") return "Part of the change was saved: the block is recorded, so AlphaClaw's group guard already ignores the group, but OpenClaw's config was not updated. Send the same change again to finish it.";
  return "Part of the change was saved before it failed. Reload the page to see what was saved before you try again.";
};

// The fields an error card shows, from a problem body or a plain error.
export const describeProblem = (problemOrError, { action = "" } = {}) => {
  const problem = problemOrError?.problem || problemOrError || {};
  const code = problem.code || null;
  const title = String(problem.title || problemOrError?.message || "Something went wrong");
  const detail = problem.detail && problem.detail !== title ? String(problem.detail) : "";
  return {
    code,
    status: problem.status || null,
    title,
    detail,
    fix: kUiFix[code] || String(problem.fix || ""),
    retry: describeRetry(problem.retry, code),
    sideEffects: describeSideEffects(problem, { action }),
    partial: problem.sideEffects === "partial",
    tone: problem.sideEffects === "partial" ? "warn" : "bad",
  };
};

// rules_unreadable: telegram/group-rules.json under AlphaClaw's root is not a
// JSON object, so the server refuses every read and write until it is fixed.
export const describeRulesUnreadable = (problem = {}) => ({
  title: "Fix AlphaClaw's group rules file to use this page",
  detail: String(problem.detail || ""),
  steps: [
    "Open telegram/group-rules.json in AlphaClaw's root directory (ALPHACLAW_ROOT_DIR, ~/.alphaclaw by default). The detail above names the exact path and the problem.",
    "Fix it so the whole file is one JSON object, for example {\"version\":1,\"groups\":{},\"blockedSenders\":[]}: groups must be an object and blockedSenders a list. To go back to the last rules AlphaClaw saved, copy telegram/group-rules.last-good.json over it.",
    "If you cannot fix it, move it aside (for example rename it to group-rules.json.broken). AlphaClaw then starts from empty rules: the block list it held is gone, so blocked people are heard again until you block them again, and groups this page had set show as Custom until you pick their mode again. Backups of earlier group rules stay in telegram/group-rules-backups/.",
    "Reload this page.",
  ],
});

// ── Group guard ─────────────────────────────────────────────────

const kGuardReasons = {
  missing: "openclaw.json has no entry for AlphaClaw's group guard plugin yet, for example because Telegram was added after the gateway started. Restart the gateway so AlphaClaw adds it.",
  foreign: "The group-guard entry in openclaw.json is not AlphaClaw's, so AlphaClaw's guard is not the one that would run.",
  disabled: "AlphaClaw's group guard plugin is switched off in openclaw.json: its entry, its conversation access, its load path or the plugins allow and deny lists.",
};

export const describeGroupGuard = (groupGuard) => {
  if (!groupGuard || groupGuard.enforced !== false) return null;
  return {
    title: "Blocks are not enforced",
    reason: kGuardReasons[groupGuard.reason] || "The gateway does not report the group guard plugin as running.",
    effect: "People on your block list are still heard wherever a group's rule lets them in. Blocked and silent groups stay off through OpenClaw's own config.",
  };
};

// ── Test verdicts ───────────────────────────────────────────────

export const kRoleLabels = {
  owner: "Owner",
  trusted_actions: "Trusted with actions",
  trusted_conversation: "Trusted to talk",
  group_allow_from: "In the group's allowFrom",
  tools_by_sender: "Has a per-person tool rule",
  account_group_allow_from: "In the bot's groupAllowFrom",
  blocked: "Blocked person",
  asked: "Asked about",
  anyone_else: "Anyone else",
};

const kReplyCopy = {
  always: { word: "Replies", detail: "to every message", tone: "ok" },
  when_mentioned: { word: "Replies", detail: "when mentioned", tone: "ok" },
  never: { word: "Ignored", detail: "", tone: "neutral" },
};

const kActionsCopy = { all: "every tool", limited: "some tools", none: "no tools" };

export const kReasonCopy = {
  "group-chat-not-allowed": "OpenClaw does not admit this group.",
  "group-disabled": "The group is turned off (Silent or Blocked).",
  "group-policy-disabled": "Group messages are turned off for this bot.",
  "group-override-unauthorized": "Not on this group's list of people who are heard.",
  "group-policy-allowlist-unauthorized": "Not on the list of people who are heard.",
  "group-policy-allowlist-empty": "Nobody is on the list of people who are heard.",
  blocked_sender: "On your block list.",
  blocked_group: "The group is blocked.",
  guard_not_enforced: "On your block list, but the group guard is not running, so the block does not apply.",
};

const kGuardSkippedCopy = {
  blocked_sender: kReasonCopy.guard_not_enforced,
  blocked_group: "The group is blocked, but the group guard is not running, so this turn is not dropped.",
};

export const kLayerLabels = {
  "openclaw.group": "OpenClaw group policy",
  "telegram.ingress": "Telegram channel access",
  "alphaclaw.group-guard": "AlphaClaw group guard",
  "openclaw.tools": "OpenClaw tool policy",
  "box.plugins": "Other plugins on this box",
};

const describeReason = (reason) => (reason ? kReasonCopy[reason] || reason : "");

const describeLayer = (layer) => {
  const label = kLayerLabels[layer.layer] || String(layer.layer || "Unknown check");
  if (layer.enforced === false) {
    const detail = kGuardSkippedCopy[layer.wouldDrop] || describeReason(layer.reason || "guard_not_enforced");
    return { label, tone: "warn", verdict: "not enforced", detail, source: layer.source || "" };
  }
  if (layer.allowed === false) return { label, tone: "neutral", verdict: "stops here", detail: describeReason(layer.reason), source: layer.source || "" };
  const detail = layer.layer === "openclaw.tools" && layer.actions ? "Allows " + (kActionsCopy[layer.actions] || layer.actions) + "." : "";
  return { label, tone: "ok", verdict: "passes", detail, source: layer.source || "" };
};

const isNotModelled = (layer) => layer?.layer === "box.plugins" || layer?.source === "not modelled";

export const describeSender = (sender = {}, { notModelled = [] } = {}) => {
  const layers = Array.isArray(sender.layers) ? sender.layers : [];
  const plugins = [...new Set([...layers.filter(isNotModelled).flatMap((layer) => layer.plugins || []), ...(notModelled || [])])];
  const reply = kReplyCopy[sender.reply] || { word: String(sender.reply || "Unknown"), detail: "", tone: "neutral" };
  const skippedGuard = layers.find((layer) => layer.layer === "alphaclaw.group-guard" && layer.enforced === false);
  const guardSkipped = Boolean(skippedGuard);
  return {
    key: sender.id ?? "anyone-else",
    name: sender.id ? String(sender.label || "").trim() : sender.label || "Anyone else",
    id: sender.id || null,
    roles: (sender.roles || []).filter((role) => role !== "anyone_else").map((role) => kRoleLabels[role] || role),
    reply: { ...reply, tone: guardSkipped && sender.reply !== "never" ? "warn" : reply.tone },
    actions: sender.reply === "never" ? "" : kActionsCopy[sender.actions] || String(sender.actions || ""),
    reason: describeReason(sender.reason) || (guardSkipped ? kGuardSkippedCopy[skippedGuard.wouldDrop] || kReasonCopy.guard_not_enforced : ""),
    modelled: layers.filter((layer) => !isNotModelled(layer)).map(describeLayer),
    notModelled: plugins,
    guardSkipped,
  };
};

// ── Rules ───────────────────────────────────────────────────────

const describeTools = (value) => {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const deny = Array.isArray(value.deny) ? value.deny : [];
  const allow = Array.isArray(value.allow) ? value.allow : [];
  if (!deny.length && !allow.length && Object.keys(value).length === 0) return "every tool";
  if (deny.includes("*") && !allow.length) return "no tools";
  return JSON.stringify(value);
};

// One line per owned key, in a fixed order, for previews and Custom groups.
export const describeRules = (rules) => {
  if (!rules || typeof rules !== "object") return [];
  const lines = [];
  if (rules.enabled !== undefined) lines.push({ key: "enabled", value: rules.enabled === false ? "false (nobody is heard)" : String(rules.enabled) });
  if (rules.groupPolicy !== undefined) {
    const meaning = { open: " (every member is heard)", allowlist: " (only listed people are heard)", disabled: " (nobody is heard)" }[rules.groupPolicy] || "";
    lines.push({ key: "groupPolicy", value: String(rules.groupPolicy) + meaning });
  }
  if (rules.allowFrom !== undefined) lines.push({ key: "allowFrom", value: Array.isArray(rules.allowFrom) && rules.allowFrom.length ? rules.allowFrom.join(", ") : "nobody" });
  if (rules.tools !== undefined) lines.push({ key: "tools", value: describeTools(rules.tools) });
  if (rules.toolsBySender && typeof rules.toolsBySender === "object") {
    for (const [who, value] of Object.entries(rules.toolsBySender)) {
      lines.push({ key: "toolsBySender " + (who === "*" ? "everyone else" : who.replace(/^id:/, "")), value: describeTools(value) });
    }
  }
  return lines;
};

export const describeTopicOverride = (override = {}) => {
  const keys = Array.isArray(override.keys) ? override.keys : [];
  return {
    threadId: String(override.threadId ?? ""),
    settings: keys.map((key) => key + " " + JSON.stringify(override[key])).join(", "),
  };
};

export const confirmCopyForMode = ({ group, mode }) => {
  const name = groupName(group);
  const converting = sectionIdForGroup(group) === "custom";
  const base = {
    approved: { title: "Approve " + name + "?", confirmLabel: "Approve group", tone: "primary", message: "Everyone in the group can talk to your agent. Only you and people trusted with actions can make it use tools." },
    trusted: { title: "Hear only trusted people in " + name + "?", confirmLabel: "Save trusted people", tone: "primary", message: "Only you and the people listed are heard. Everyone else in the group is ignored." },
    silent: { title: "Silence " + name + "?", confirmLabel: "Silence group", tone: "warning", message: "Your agent stays in the group and answers nobody, you included." },
    blocked: { title: "Block " + name + " and leave it?", confirmLabel: "Block and leave", tone: "danger", message: "Your agent leaves the group now, ignores it, and leaves again if someone adds it back." },
  }[mode] || { title: "Change " + name + "?", confirmLabel: "Save", tone: "primary", message: "" };
  if (!converting) return { ...base, converting };
  return {
    ...base,
    converting,
    confirmLabel: "Replace rules",
    tone: mode === "blocked" ? "danger" : "warning",
    message: base.message + " This replaces the group's custom rules (enabled, groupPolicy, allowFrom, tools and toolsBySender). The old rules are backed up in telegram/group-rules-backups/ under AlphaClaw's root first.",
  };
};
