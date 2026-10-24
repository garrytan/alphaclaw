import { formatBytes, formatDurationLongMs, formatLocaleDateTime } from "../../lib/format.js";

export const kUpgradeStatusKey = "/api/openclaw/upgrade-status";

// Coarse file age ("3h ago", "2d ago"): a backup's age is a judgement call
// for the operator, not a stopwatch.
const ageText = (ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  const minutes = Math.floor(Math.max(0, value) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const kScopeCopy = {
  pre_upgrade: (verified) => `taken before this upgrade, under OpenClaw ${verified.openclawVersion || "an older version"}`,
  current: () => "a copy of the current, upgraded state",
  after_upgrade_attempt: () => "taken after the upgrade attempt, so it holds the partly upgraded state",
};

// One line about backups, honest about what AlphaClaw knows: "verified"
// only for the archive OpenClaw itself verified; anything else says
// "verification unknown".
export const describeBackupLine = (backup = null) => {
  if (!backup || typeof backup !== "object") return null;
  const verified = backup.verified;
  const newest = backup.newest;
  const verifiedLine = verified
    ? [`Newest verified backup: ${verified.name}`, ageText(verified.ageMs), (kScopeCopy[verified.scope] || kScopeCopy.current)(verified)].filter(Boolean).join(" · ")
    : null;
  const newestLine =
    newest && newest.name !== verified?.name
      ? [`Newest backup: ${newest.name}`, ageText(newest.ageMs), "verification unknown"].filter(Boolean).join(" · ")
      : null;
  if (newestLine && verifiedLine) return `${newestLine}. ${verifiedLine}`;
  return newestLine || verifiedLine || "No backups in the backups folder yet.";
};

export const describeRetryDowntime = (retry = null) => {
  const ms = Number(retry?.lastSuccessDurationMs);
  const expected = Number(retry?.disk?.expectedMinutes);
  return Number.isFinite(ms) && ms > 0
    ? `The gateway stops while OpenClaw's doctor --fix runs, then starts again. The last successful run took ${formatDurationLongMs(ms)}.`
    : Number.isFinite(expected) && expected > 0
      ? `The gateway stops while OpenClaw's doctor --fix runs, then starts again. For this much state expect about ${expected} min; progress shows here while it runs.`
      : "The gateway stops while OpenClaw's doctor --fix runs, then starts again. How long it takes depends on the size of OpenClaw's state; progress shows here while it runs.";
};

export const describeUnchanged = (retry = null) => {
  if (!retry?.unchanged) return null;
  const when = formatLocaleDateTime(retry.unchangedSince, { fallback: null });
  return `Nothing has changed since this failed${when ? ` (${when})` : ""}, so OpenClaw will most likely refuse it again.`;
};

// "02775 → 03775": octal modes as the proposal carries them.
export const describeModeChange = (dir = {}) => `${dir.oldMode} → ${dir.newMode}`;

export const describeCaptureSize = (proposal = {}) => {
  const bytes = Number(proposal?.captureBytes);
  return Number.isFinite(bytes) && bytes > 0 ? formatBytes(bytes) : "a copy of OpenClaw's databases";
};

// The admin-only standing row in Backups: the preflight verdict.
export const buildSnapshotRowModel = (status = null) => {
  const preflight = status?.preflight;
  if (!preflight) return null;
  if (preflight.captureAvailable === true) {
    return { tone: "success", label: "On", sentence: "The next Doctor run can keep a pre-repair safety snapshot.", canEnable: false, manualFix: null };
  }
  if (preflight.captureAvailable === null) {
    return { tone: "neutral", label: "Not checked", sentence: preflight.sentence || "AlphaClaw can't check this on this platform.", canEnable: false, manualFix: null };
  }
  return {
    tone: "warning",
    label: "Off",
    sentence: preflight.sentence || "OpenClaw can't keep a safety snapshot here.",
    canEnable: preflight.fixable?.canFix === true,
    manualFix: preflight.manualFix || null,
  };
};
