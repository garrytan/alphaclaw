const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { readCompletedForVersion, writeCompletedForVersion } = require("./openclaw-boot-migration");
const { compareVersionParts } = require("./helpers");

// AlphaClaw used to let an operator switch OpenClaw to a beta/dev build from
// the Upgrade tab: the choice lived in <managedDir>/openclaw-channel-state.json
// and ran through a PATH shim at <managedDir>/bin/openclaw pointing into an
// overlay store (<rootDir>/openclaw-overlay/<version>) or a dev checkout.
// That machinery is gone — the `openclaw` pin in package.json is now the only
// way the version changes. On the first boot of this AlphaClaw such a box
// silently drops back to the pin, and its data may already be newer than the
// pin can open, so the switch is retired ONCE and the operator is told:
//
//   bin phase   retireReleaseChannelAtBoot  removes the shim, moves the old
//               state file aside and records what was running
//   server      deliverRetirementNotice     sends the one-time notice (after
//               phase                       the notifier is up), then removes
//                                           the BETA/DEV Control UI stripe the
//                                           old switch wrote into openclaw.json
const kChannelStateFileName = "openclaw-channel-state.json";
const kRetirementFileName = "openclaw-channel-retired.json";
const kShimDirName = "bin";
const kOverlayStoreDirName = "openclaw-overlay";

const readJson = (fsModule, filePath) => {
  try {
    return JSON.parse(fsModule.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const describeApplied = (state) => {
  const applied = state?.applied;
  if (!applied || typeof applied !== "object") return null;
  const channel = typeof applied.channel === "string" ? applied.channel : null;
  const version = typeof applied.version === "string" ? applied.version : null;
  const sha = typeof applied.sha === "string" ? applied.sha : null;
  if (!channel && !version && !sha) return null;
  return { channel, version, sha };
};

// Only a build NEWER than the pin (any beta/dev pick, or a newer stable from
// the old catalog) can have migrated data the pin cannot open. A stable box
// that ran an older build — every box on the old default — just moves forward.
const ranAheadOfPin = (previous, pinVersion) => {
  if (!previous) return false;
  if (previous.channel !== "stable") return true;
  if (!previous.version || !pinVersion) return false;
  return compareVersionParts(previous.version, pinVersion) > 0;
};

// Synchronous, fail-open: a retirement that cannot complete costs one warning
// and never blocks the boot (the pin still runs; the notice just may not go).
const retireReleaseChannelAtBoot = ({
  managedDir,
  rootDir,
  pinVersion = null,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  const statePath = path.join(managedDir, kChannelStateFileName);
  const shimDir = path.join(managedDir, kShimDirName);
  try {
    fsModule.rmSync(shimDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn?.(`[alphaclaw] could not remove the retired OpenClaw shim ${shimDir}: ${error.message}`);
  }
  if (!fsModule.existsSync(statePath)) return null;
  const state = readJson(fsModule, statePath);
  const previous = describeApplied(state);
  // The old reconciler recorded which version doctor --fix last completed
  // for; carry it over so the boot migration does not re-run doctor for a
  // version it already migrated.
  const completedForVersion = state?.configMigration?.completedForVersion;
  if (typeof completedForVersion === "string" && !readCompletedForVersion({ managedDir, fsModule })) {
    try {
      writeCompletedForVersion({ managedDir, version: completedForVersion, fsModule, nowFn });
    } catch {}
  }
  const overlayDir = path.join(rootDir, kOverlayStoreDirName);
  const record = {
    retiredAt: nowFn(),
    previous,
    pinVersion,
    overlayDir: fsModule.existsSync(overlayDir) ? overlayDir : null,
    needsNotice: ranAheadOfPin(previous, pinVersion),
    notifiedAt: null,
  };
  try {
    writeFileAtomic(path.join(managedDir, kRetirementFileName), `${JSON.stringify(record, null, 2)}\n`, { fsModule });
    fsModule.renameSync(statePath, `${statePath}.retired-${record.retiredAt}`);
  } catch (error) {
    logger.warn?.(`[alphaclaw] could not retire the OpenClaw release-channel state: ${error.message}`);
    return null;
  }
  logger.log?.(
    record.previous
      ? `[alphaclaw] retired the in-app OpenClaw version switch (was ${record.previous.channel || "?"} ${record.previous.version || record.previous.sha || "?"}); running the pinned ${pinVersion || "OpenClaw"}`
      : "[alphaclaw] retired the in-app OpenClaw version switch state",
  );
  return record;
};

const formatRetirementNotice = (record) => {
  const previous = record.previous || {};
  const was = [previous.version || (previous.sha ? previous.sha.slice(0, 12) : null), previous.channel ? `(${previous.channel})` : null]
    .filter(Boolean)
    .join(" ");
  const pin = record.pinVersion || "the pinned version";
  return [
    "🐺 *AlphaClaw*",
    `This box was running OpenClaw ${was || "a non-pinned build"} through the Upgrade tab, which has been removed. AlphaClaw now always runs its pinned OpenClaw ${pin}.`,
    `If the gateway will not start because its data is newer than ${pin}, restore the backup you took before switching, or deploy an AlphaClaw release that pins OpenClaw ${previous.version || "that version"} or newer.`,
    record.overlayDir ? `The old build is no longer used and can be deleted: ${record.overlayDir}` : null,
  ]
    .filter(Boolean)
    .join("\n");
};

// A Control UI stripe exactly like the ones the old switch generated (BETA /
// DEV labels). Nothing writes them anymore; this is how a leftover is told
// apart from an operator's own stripe.
const isRetiredChannelStripe = (stripe) => {
  if (!stripe || typeof stripe !== "object" || Array.isArray(stripe)) return false;
  if (stripe._alphaclawManaged === true) return true;
  if (Object.keys(stripe).length !== 2) return false;
  const { label, color } = stripe;
  if (typeof label !== "string") return false;
  if (color === "amber") return label === "BETA" || label.startsWith("BETA · ");
  if (color === "purple") return label === "DEV" || label.startsWith("DEV · ");
  return false;
};

const deliverRetirementNotice = async ({
  managedDir,
  notify,
  removeRetiredStripe = null,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  const recordPath = path.join(managedDir, kRetirementFileName);
  const record = readJson(fsModule, recordPath);
  if (!record || record.notifiedAt) return { delivered: false };
  try {
    await removeRetiredStripe?.();
  } catch (error) {
    logger.warn?.(`[alphaclaw] could not remove the retired BETA/DEV Control UI stripe: ${error.message}`);
  }
  if (record.needsNotice && typeof notify === "function") {
    await notify(formatRetirementNotice(record), {
      eventType: "warning",
      id: `openclaw-channel-retired-${record.retiredAt}`,
    });
  }
  writeFileAtomic(recordPath, `${JSON.stringify({ ...record, notifiedAt: nowFn() }, null, 2)}\n`, { fsModule });
  return { delivered: record.needsNotice === true };
};

module.exports = {
  kRetirementFileName,
  retireReleaseChannelAtBoot,
  deliverRetirementNotice,
  formatRetirementNotice,
  isRetiredChannelStripe,
};
