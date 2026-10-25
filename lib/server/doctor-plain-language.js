// One plain sentence per known OpenClaw Doctor cause, failure reason and
// preflight rule, for the upgrade alert, the Backups row and the notices. The
// raw upstream text always stays available behind a disclosure; an unknown
// string never becomes the headline sentence.
const { kFailingRules, kFixReasons } = require("./openclaw-capture-preflight");

// Upstream "Original state capture was unavailable: <cause>" messages
// (2026.10.x dist), matched on the cause text Doctor printed.
const kCaptureCauseCatalog = [
  {
    pattern: /SQLite staging ancestor must not allow another user to replace its child:\s*(\S+)/i,
    rule: kFailingRules.ancestorReplaceable,
    sentence: (match) => match[1] + " lets other users replace the folders inside it, so OpenClaw won't stage a snapshot there.",
  },
  {
    pattern: /SQLite staging ancestor must be a real directory:\s*(\S+)/i,
    rule: kFailingRules.notDirectory,
    sentence: (match) => match[1] + " is not a real directory, so OpenClaw won't stage a snapshot under it.",
  },
  {
    pattern: /Private SQLite staging root must be owned by the current user and not writable by other users:\s*(\S+)/i,
    rule: kFailingRules.captureRootUnsafe,
    sentence: (match) => "The snapshot folder " + match[1] + " is shared with other users, so OpenClaw won't use it.",
  },
  {
    pattern: /needs (\d[\d.,]*\s*[KMGT]?i?B) near (\S+), but only (\d[\d.,]*\s*[KMGT]?i?B) is available/i,
    rule: kFailingRules.space,
    sentence: (match) => "There isn't enough free space for a snapshot: it needs " + match[1] + " near " + match[2].replace(/[.,]$/, "") + " and only " + match[3] + " is free.",
    path: (match) => match[2].replace(/[.,]$/, ""),
  },
  {
    pattern: /No snapshot location has enough measured free space/i,
    rule: kFailingRules.space,
    sentence: () => "There isn't enough free space on the data volume for a snapshot.",
  },
  {
    pattern: /EACCES|permission denied/i,
    rule: kFailingRules.captureRootUncreatable,
    sentence: () => "OpenClaw wasn't allowed to create its snapshot folder.",
  },
];

// -> { rule, path, sentence } for a Doctor capture cause; rule/path are null
// for a cause the catalog does not know (the sentence then says so plainly).
const describeCaptureCause = (cause) => {
  const text = String(cause || "").trim();
  for (const entry of kCaptureCauseCatalog) {
    const match = text.match(entry.pattern);
    if (match) {
      return {
        rule: entry.rule,
        path: entry.path ? entry.path(match) : match[1] ? match[1].replace(/[.,]$/, "") : null,
        sentence: entry.sentence(match),
      };
    }
  }
  return { rule: null, path: null, sentence: text ? "OpenClaw couldn't take a snapshot for a reason AlphaClaw doesn't recognize." : "OpenClaw didn't say why it couldn't take a snapshot." };
};

const kFailingCheckPattern = /^Failing check\s+([^:]+):?/i;

// Doctor failure reasons (doctor-outcome.js summarizeDoctorResult).
const describeDoctorFailure = ({ reason, detail = null, bridgeVersion = null } = {}) => {
  switch (reason) {
    case "atomic_replace_refused":
      return "OpenClaw can't safely rewrite files through the symlinked state folder.";
    case "upgrade_window_refused":
      return "This data is older than OpenClaw's July 2026 upgrade support window, so this OpenClaw can't migrate it" + (bridgeVersion ? " (OpenClaw " + bridgeVersion + " still can)." : ".");
    case "failing_check": {
      const name = String(detail || "").match(kFailingCheckPattern)?.[1]?.trim();
      return name ? "One of OpenClaw's upgrade checks failed: " + name + "." : "One of OpenClaw's upgrade checks failed.";
    }
    case "workspace_moved":
      return "The workspace folder's real location changed, and OpenClaw needs a confirmation before it rebinds its saved records.";
    case "timed_out":
      return "The data upgrade ran past its time limit and was stopped.";
    case "cancelled":
      return "The data upgrade was cancelled before it finished.";
    case "disk_full":
      return "The data volume ran out of space during the upgrade.";
    case "insufficient_disk":
      return detail || "AlphaClaw didn't start the data upgrade because the volume doesn't have room to back up OpenClaw's databases.";
    case "state_busy":
      return "Another OpenClaw process was holding the state database.";
    case "doctor_restored_stale_config":
      return "OpenClaw tried to restore an old configuration, and AlphaClaw reverted it.";
    default:
      return "OpenClaw's data upgrade stopped with an error it didn't explain.";
  }
};

// Preflight rule -> the sentence the Backups row shows.
const describePreflightRule = ({ failingRule, failingPath, freeBytes = null, neededBytes = null, formatBytes = (n) => String(n) + " bytes" } = {}) => {
  switch (failingRule) {
    case kFailingRules.ancestorReplaceable:
      return failingPath + " lets other users replace the folders inside it, so OpenClaw won't stage a snapshot there.";
    case kFailingRules.ancestorForeignOwner:
      return failingPath + " belongs to another user, so OpenClaw won't stage a snapshot under it.";
    case kFailingRules.notDirectory:
      return failingPath + " is not a real directory, so OpenClaw won't stage a snapshot under it.";
    case kFailingRules.captureRootUnsafe:
      return "The snapshot folder " + failingPath + " is shared with other users, so OpenClaw won't use it.";
    case kFailingRules.captureRootUncreatable:
      return "AlphaClaw's user can't create the snapshot folder inside " + failingPath + ".";
    case kFailingRules.space:
      return freeBytes != null && neededBytes != null
        ? "A snapshot needs " + formatBytes(neededBytes) + " free near " + failingPath + ", and " + formatBytes(freeBytes) + " is free."
        : "There isn't enough free space near " + failingPath + " for a snapshot.";
    case kFailingRules.unsupported:
      return "AlphaClaw can't check snapshot permissions on this platform.";
    default:
      return null;
  }
};

// The exact manual fix when Enable snapshots can't do it.
const describeManualFix = ({ fixable, failingPath } = {}) => {
  const target = fixable?.path || failingPath;
  switch (fixable?.reason) {
    case kFixReasons.notOwner:
      return "Run chmod +t " + target + " as root on the host (AlphaClaw's user doesn't own it).";
    case kFixReasons.foreignOwner:
      return "Give " + target + " to root or to AlphaClaw's user (chown), or move the data volume so no other user owns a folder above it.";
    case kFixReasons.childNotOwned:
      return "Give the folder inside " + target + " to AlphaClaw's user (chown), then set the sticky bit on " + target + ".";
    case kFixReasons.captureRoot:
      return "Make " + target + " private to AlphaClaw's user (chmod go-w), or remove it so OpenClaw recreates it.";
    case kFixReasons.space:
      return "Free space on the data volume; a snapshot copies OpenClaw's databases.";
    default:
      return null;
  }
};

module.exports = {
  describeCaptureCause,
  describeDoctorFailure,
  describeManualFix,
  describePreflightRule,
};
