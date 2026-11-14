const { kGuestNotesDefaults, kGroupKeyPattern } = require("./constants");

// alphaclaw.json "guestNotes": one entry per group, off by default.
//   { groups: { "<channel>:<chat id>": { enabled, dailyCap?, liveCap? } },
//     scratchRoot: "/data/wmexec/m" | null, retentionDays? }
// Anything malformed is dropped, so a hand edit can never switch a group on
// by accident. A cap outside its bounds falls back to the default.
const kCapBounds = Object.freeze({ dailyCap: [1, 200], liveCap: [1, 2000], retentionDays: [7, 365] });

const boundedInt = (value, [min, max], fallback) =>
  Number.isInteger(value) && value >= min && value <= max ? value : fallback;

const normalizeGuestNotesGroup = (group = {}) => {
  const base = group && typeof group === "object" && !Array.isArray(group) ? group : {};
  const out = { enabled: base.enabled === true };
  if (Number.isInteger(base.dailyCap) && boundedInt(base.dailyCap, kCapBounds.dailyCap, null) !== null) out.dailyCap = base.dailyCap;
  if (Number.isInteger(base.liveCap) && boundedInt(base.liveCap, kCapBounds.liveCap, null) !== null) out.liveCap = base.liveCap;
  return out;
};

const normalizeGuestNotesConfig = (raw = {}) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const groups = {};
  const rawGroups = base.groups && typeof base.groups === "object" && !Array.isArray(base.groups) ? base.groups : {};
  for (const [key, value] of Object.entries(rawGroups)) {
    if (kGroupKeyPattern.test(key)) groups[key] = normalizeGuestNotesGroup(value);
  }
  const scratchRoot =
    typeof base.scratchRoot === "string" && base.scratchRoot.startsWith("/") && !base.scratchRoot.split("/").includes("..")
      ? base.scratchRoot.replace(/\/+$/, "") || null
      : null;
  return {
    groups,
    scratchRoot,
    retentionDays: boundedInt(base.retentionDays, kCapBounds.retentionDays, kGuestNotesDefaults.retentionDays),
  };
};

const groupSettings = (config, groupKey) => {
  const group = config?.groups?.[groupKey] || { enabled: false };
  return {
    enabled: group.enabled === true,
    dailyCap: group.dailyCap ?? kGuestNotesDefaults.dailyCap,
    liveCap: group.liveCap ?? kGuestNotesDefaults.liveCap,
  };
};

module.exports = { normalizeGuestNotesConfig, normalizeGuestNotesGroup, groupSettings, kCapBounds };
