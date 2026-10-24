// The upgrade alert's server-side model: what the dashboard says about the
// installed OpenClaw pin's data upgrade, built from the migration record
// (openclaw-boot-migration.js), the read-only capture preflight, the backup
// evidence and the admin's dismissals. Pure: the route reads the inputs.
//
// Rows (one at a time, most urgent first):
//   failed          a deterministic Doctor failure for the pin  → Retry upgrade
//   window_refused  state older than the July 2026 window       → bridge steps
//   interrupted     a transient failure (timeout, busy, ENOSPC) → Retry upgrade now
//   snapshotless    the pin completed, but its newest successful Doctor had
//                   no pre-repair capture (admin only, dismissible per
//                   openclawVersion + failing path + rule)
// A failure row exists only while completedForVersion differs from the
// installed pin: a repair or medic Doctor that fails after the upgrade
// completed is the watchdog's business and never raises it.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sameKey, kDefaultBridgeVersion } = require("./openclaw-boot-migration");
const { writeFileAtomic } = require("./utils/safe-file");
const {
  describeCaptureCause,
  describeDoctorFailure,
  describeManualFix,
  describePreflightRule,
} = require("./doctor-plain-language");

const kDismissalsFileName = "upgrade-alert-dismissals.json";
const kMaxDismissals = 50;
const kMemberLine = "An administrator needs to finish this upgrade.";
const kInterruptedSentence =
  "AlphaClaw retries it automatically the next time the AlphaClaw server starts — the gateway Restart button doesn't rerun it.";

const readDismissals = ({ managedDir, fsModule = fs }) => {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(path.join(managedDir, kDismissalsFileName), "utf8"));
    return Array.isArray(parsed?.keys) ? parsed.keys.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
};

const addDismissal = ({ managedDir, key, fsModule = fs }) => {
  const keys = [...readDismissals({ managedDir, fsModule }).filter((entry) => entry !== key), key].slice(-kMaxDismissals);
  writeFileAtomic(path.join(managedDir, kDismissalsFileName), JSON.stringify({ keys }, null, 2) + "\n", { fsModule });
  return keys;
};

const snapshotDismissKey = ({ openclawVersion, failingPath, failingRule }) =>
  crypto
    .createHash("sha256")
    .update([openclawVersion || "", failingPath || "", failingRule || ""].join("\u0000"))
    .digest("hex")
    .slice(0, 16);

// Backup evidence, honestly labelled: "verified" only for the archive
// OpenClaw itself verified (the persisted receipt) while the file on disk is
// still that archive (same path, size and mtime); everything else in the
// backups folder is "verification unknown" with its file age. A verified
// backup taken under an older OpenClaw is "pre_upgrade" (the one the
// bridge-release procedure needs); one taken under the installed pin is a copy
// of the current state.
const describeBackupEvidence = ({ backupsDir, receipt = null, installedVersion = null, fsModule = fs, nowMs = Date.now() }) => {
  let names = [];
  try {
    names = fsModule.readdirSync(backupsDir);
  } catch {}
  const files = [];
  for (const name of names) {
    try {
      const stat = fsModule.statSync(path.join(backupsDir, name));
      if (stat.isFile()) files.push({ name, path: path.join(backupsDir, name), bytes: Number(stat.size), mtimeMs: Number(stat.mtimeMs) });
    } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const matchesReceipt = (file) =>
    Boolean(receipt) &&
    path.resolve(String(receipt.archivePath)) === file.path &&
    file.bytes === Number(receipt.bytes) &&
    Math.abs(file.mtimeMs - Number(receipt.mtimeMs)) < 1;
  const verifiedFile = files.find(matchesReceipt) || null;
  const verified = verifiedFile
    ? {
        name: verifiedFile.name,
        bytes: verifiedFile.bytes,
        createdAt: Number(receipt.finishedAt) || verifiedFile.mtimeMs,
        ageMs: Math.max(0, nowMs - (Number(receipt.finishedAt) || verifiedFile.mtimeMs)),
        openclawVersion: receipt.openclawVersion || null,
        scope:
          receipt.openclawVersion && installedVersion && receipt.openclawVersion !== installedVersion
            ? "pre_upgrade"
            : receipt.upgradeCompleted
              ? "current"
              : "after_upgrade_attempt",
      }
    : null;
  const newest = files[0]
    ? {
        name: files[0].name,
        bytes: files[0].bytes,
        ageMs: Math.max(0, nowMs - files[0].mtimeMs),
        verification: matchesReceipt(files[0]) ? "verified" : "unknown",
      }
    : null;
  return { count: files.length, newest, verified };
};

const describePreflightForAdmin = (preflight, { formatBytes } = {}) =>
  preflight
    ? {
        captureAvailable: preflight.captureAvailable,
        failingPath: preflight.failingPath,
        failingRule: preflight.failingRule,
        sentence: describePreflightRule({ ...preflight, formatBytes }),
        fixable: preflight.fixable,
        manualFix: preflight.fixable?.canFix ? null : describeManualFix(preflight),
        freeBytes: preflight.freeBytes,
        neededBytes: preflight.neededBytes,
        captureBytes: preflight.captureBytes,
        enableRequiredBytes: preflight.enableRequiredBytes,
        captureRoot: preflight.captureRoot,
        symlinked: preflight.symlinked,
        realStateDir: preflight.realStateDir,
      }
    : null;

const windowRefusalSteps = ({ bridgeVersion, backup }) => [
  "Leave the current state directory untouched.",
  "Restore a backup taken before this upgrade into a separate directory and run openclaw doctor --fix there with OpenClaw " + bridgeVersion + ".",
  "When it completes, stop AlphaClaw, swap the migrated copy in for the state directory and start AlphaClaw again. Anything written after that backup is lost.",
  backup?.verified?.scope === "pre_upgrade"
    ? "AlphaClaw has a verified backup taken under OpenClaw " + backup.verified.openclawVersion + " (" + backup.verified.name + "). Its compatibility with OpenClaw " + bridgeVersion + " is not checked."
    : "AlphaClaw has no verified backup from before this upgrade. Without one, OpenClaw can't migrate this state automatically: https://docs.openclaw.ai/install/updating#upgrading-very-old-versions",
];

const failureRow = ({ failure, failed, currentKey, preflight, backup }) => {
  const kind =
    failure.reason === "upgrade_window_refused"
      ? "window_refused"
      : failure.class === "deterministic"
        ? "failed"
        : "interrupted";
  const plain = describeDoctorFailure({ reason: failure.reason, detail: failure.detail, bridgeVersion: failure.bridgeVersion });
  const snapshotMissing = failure.captureState === "unavailable";
  const capture = snapshotMissing ? describeCaptureCause(failure.captureCause) : null;
  const unchanged = kind === "failed" && Boolean(failed) && sameKey(failed.key, currentKey);
  const canEnable = snapshotMissing && preflight?.fixable?.canFix === true;
  const actions =
    kind === "window_refused"
      ? ["view_logs", "back_up"]
      : [...(canEnable ? ["enable_snapshots"] : []), "retry_upgrade", "view_logs", "back_up"];
  return {
    kind,
    tone: kind === "interrupted" ? "warning" : "error",
    headline: kind === "interrupted" ? "OpenClaw's data upgrade was interrupted" : "OpenClaw's data upgrade didn't finish",
    sentence: kind === "interrupted" ? plain + " " + kInterruptedSentence : plain,
    reason: failure.reason || null,
    detail: failure.detail || null,
    at: failure.at || null,
    source: failure.source || null,
    durationMs: Number.isFinite(Number(failure.durationMs)) ? Number(failure.durationMs) : null,
    unchanged,
    unchangedSince: unchanged ? failed.at || null : null,
    attempts: failed ? Number(failed.attempts) || 1 : null,
    snapshot: capture ? { sentence: "This run had no safety snapshot: " + capture.sentence, cause: failure.captureCause || null } : null,
    manualFix: snapshotMissing && !canEnable && preflight?.captureAvailable === false ? describeManualFix(preflight) : null,
    steps: kind === "window_refused" ? windowRefusalSteps({ bridgeVersion: failure.bridgeVersion || kDefaultBridgeVersion, backup }) : null,
    actions,
  };
};

const snapshotlessRow = ({ observation, installedVersion, preflight, dismissed }) => {
  const capture = describeCaptureCause(observation.captureCause);
  const dismissKey = snapshotDismissKey({ openclawVersion: installedVersion, failingPath: capture.path, failingRule: capture.rule });
  if (dismissed.includes(dismissKey)) return null;
  const enabledForFuture = preflight?.captureAvailable === true;
  const canEnable = !enabledForFuture && preflight?.fixable?.canFix === true;
  return {
    kind: "snapshotless",
    tone: "info",
    headline: "The upgrade ran without a safety snapshot",
    sentence: enabledForFuture
      ? "Snapshots are on for future Doctor runs. This upgrade already ran without one, and turning them on doesn't change that."
      : capture.sentence + " Nothing is broken, but later Doctor runs won't keep a snapshot either until this is fixed.",
    failingPath: capture.path,
    failingRule: capture.rule,
    cause: observation.captureCause || null,
    at: observation.at || null,
    source: observation.source || null,
    enabledForFuture,
    manualFix: !enabledForFuture && !canEnable && preflight?.captureAvailable === false ? describeManualFix(preflight) : null,
    dismissKey,
    actions: [...(canEnable ? ["enable_snapshots"] : []), "dismiss", "back_up"],
  };
};

// Admin-only, while no other row is up: the next data upgrade would be
// refused (not enough room for the backups) or is at risk (no room for the
// recovery copy, or more state than the Doctor limit is sized for).
// upgrade-disk-check.js owns the thresholds and the sentences.
const diskSpaceRow = ({ diskCheck, dismissed }) => {
  const refuse = diskCheck.verdict === "refuse";
  const dismissKey = refuse
    ? null
    : snapshotDismissKey({
        openclawVersion: "disk",
        failingPath: String(Math.round(diskCheck.stateBytes / 1e9)),
        failingRule: String(Math.round(Number(diskCheck.freeBytes) / 5e9)),
      });
  if (dismissKey && dismissed.includes(dismissKey)) return null;
  return {
    kind: "disk_space",
    tone: refuse ? "error" : "warning",
    badgeLabel: refuse ? "Not enough space" : "At risk",
    headline: refuse ? "OpenClaw's next data upgrade can't start" : "OpenClaw's next data upgrade is at risk",
    sentence: diskCheck.sentences.join(" "),
    at: null,
    dismissKey,
    actions: dismissKey ? ["dismiss"] : [],
  };
};

const buildUpgradeStatus = ({
  record = {},
  installedVersion = null,
  currentKey = null,
  preflight = null,
  diskCheck = null,
  backup = null,
  dismissed = [],
  busy = null,
  isAdmin = false,
  formatBytes,
} = {}) => {
  const last = record.lastOutcome && typeof record.lastOutcome === "object" ? record.lastOutcome : null;
  const lastForPin = last && last.openclawVersion === installedVersion ? last : null;
  const completed = Boolean(installedVersion) && record.completedForVersion === installedVersion;
  const failed = record.failed && record.failed.key?.openclawVersion === installedVersion ? record.failed : null;
  let alert = null;
  if (installedVersion && !completed) {
    const failure =
      lastForPin?.status === "failed"
        ? lastForPin
        : failed
          ? { reason: failed.reason, detail: failed.detail, class: "deterministic", at: failed.at, captureState: null }
          : null;
    if (failure) alert = failureRow({ failure, failed, currentKey, preflight, backup });
  }
  if (!alert && completed && isAdmin) {
    const observation =
      record.snapshotless?.openclawVersion === installedVersion
        ? record.snapshotless
        : lastForPin?.status === "ok" && lastForPin.captureState === "unavailable"
          ? lastForPin
          : null;
    if (observation) alert = snapshotlessRow({ observation, installedVersion, preflight, dismissed });
  }
  if (!alert && isAdmin && diskCheck && diskCheck.verdict !== "ok") alert = diskSpaceRow({ diskCheck, dismissed });
  const lastSuccessDurationMs = Number.isFinite(Number(record.lastSuccess?.durationMs))
    ? Number(record.lastSuccess.durationMs)
    : last?.status === "ok" && Number.isFinite(Number(last.durationMs))
      ? Number(last.durationMs)
      : null;
  const retry = {
    available: Boolean(alert) && (alert.kind === "failed" || alert.kind === "interrupted"),
    unchanged: alert?.unchanged === true,
    unchangedSince: alert?.unchangedSince || null,
    lastSuccessDurationMs,
    disk: diskCheck
      ? { verdict: diskCheck.verdict, sentences: diskCheck.sentences, expectedMinutes: diskCheck.expectedMinutes }
      : null,
  };
  if (!isAdmin) {
    return {
      installedVersion,
      alert: alert
        ? { kind: alert.kind, tone: alert.tone, headline: alert.headline, sentence: alert.sentence, memberLine: kMemberLine, at: alert.at, actions: [] }
        : null,
      busy: busy ? { kind: busy.kind, label: busy.label } : null,
    };
  }
  return {
    installedVersion,
    completedForVersion: record.completedForVersion || null,
    alert,
    retry,
    busy: busy ? { kind: busy.kind, label: busy.label } : null,
    preflight: describePreflightForAdmin(preflight, { formatBytes }),
    backup,
  };
};

// Whether Retry upgrade may start, from the same record the alert reads.
// unchanged: the state is exactly what the remembered deterministic failure
// saw, so the retry needs the admin's explicit "retry anyway".
const readRetryEligibility = ({ record = {}, installedVersion = null, currentKey = null, confirmUnchanged = false } = {}) => {
  if (!installedVersion) {
    return { ok: false, code: "version_unknown", error: "AlphaClaw can't tell which OpenClaw is installed." };
  }
  if (record.completedForVersion === installedVersion) {
    return { ok: false, code: "upgrade_complete", error: `OpenClaw's data upgrade to ${installedVersion} already finished.` };
  }
  const last = record.lastOutcome?.openclawVersion === installedVersion ? record.lastOutcome : null;
  const failed = record.failed?.key?.openclawVersion === installedVersion ? record.failed : null;
  const reason = last?.status === "failed" ? last.reason : failed?.reason || null;
  if (reason === "upgrade_window_refused") {
    return {
      ok: false,
      code: "upgrade_window_refused",
      error: "This OpenClaw can't migrate state from before its July 2026 upgrade window, so a retry would fail the same way.",
    };
  }
  const unchanged = Boolean(failed) && sameKey(failed.key, currentKey);
  if (unchanged && confirmUnchanged !== true) {
    return {
      ok: false,
      code: "unchanged_since_failure",
      unchanged: true,
      unchangedSince: failed.at || null,
      error: "Nothing has changed since this upgrade failed, so OpenClaw will most likely refuse it again.",
      hint: "Retry anyway to run it again on the same state.",
    };
  }
  return { ok: true, unchanged };
};

module.exports = {
  kDismissalsFileName,
  readRetryEligibility,
  kMemberLine,
  addDismissal,
  buildUpgradeStatus,
  describeBackupEvidence,
  readDismissals,
  snapshotDismissKey,
};
