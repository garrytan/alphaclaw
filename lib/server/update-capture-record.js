// Which OpenClaw Doctor capture is the copy from before an OpenClaw upgrade
// (ALPH-69). OpenClaw's Doctor seals a full state capture
// (<state>.update-captures/doctor-<uuid>) on every run outside an update: on
// each container start and on every repair. Its manifest names no OpenClaw
// version, so the retention sweep (copy-retention.js) cannot tell the copy
// that is the way back to the previous version from a repair copy. This
// record tells it, in <managedDir>/openclaw-update-captures.json:
//
//   trackingSince       when AlphaClaw started placing captures; anything
//                       sealed before it keeps the plain keep/days rule
//   lastHealthyVersion  the OpenClaw version of the last verified healthy
//                       start (a managed launch that answered /readyz ready
//                       and was still current), read when that launch spawned
//   preUpgradeCapture   { name, fromVersion, toVersion, at, source, settled }
//
// A Doctor run that reports "Pre-repair state retained at …" while the
// installed version differs from lastHealthyVersion records that capture by
// name, once per change: later captures of the same change (repairs before or
// after the new version first starts) are not promoted. settled turns true
// at the next healthy start, so the same from->to pair seen again after a
// rollback is a new change. A healthy start that moves lastHealthyVersion
// without having seen a capture for that change (a Doctor run AlphaClaw did
// not watch) records the newest capture sealed before that launch spawned.
//
// Downgrade A->B->A: the change B->A records its own copy (B's state), which
// releases the A-state copy taken before B. That one is then an ordinary
// capture under the keep count: A has just proven itself on this state, and
// the only way back to B, the version just left, is the B-state copy, which
// is never removed until a later change replaces it.
//
// A failed write keeps the change in memory, marks the record unsaved (the
// sweep then removes no capture) and is retried on every sweep.
const fs = require("fs");
const path = require("path");
const { readRegularFileBounded } = require("./utils/bounded-file");
const { writeFileAtomic } = require("./utils/safe-file");

const kRecordFileName = "openclaw-update-captures.json";
const kRecordMaxBytes = 64 * 1024;
const kCaptureNamePattern = /^[A-Za-z0-9_-]{1,128}$/;
const kVersionPattern = /^[A-Za-z0-9._+-]{1,64}$/;

const isVersion = (value) => typeof value === "string" && kVersionPattern.test(value);

const isValidRecord = (record) => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (!Number.isFinite(record.trackingSince)) return false;
  if (record.lastHealthyVersion !== null && !isVersion(record.lastHealthyVersion)) return false;
  const pre = record.preUpgradeCapture;
  if (pre === null) return true;
  return !!pre && typeof pre === "object" && kCaptureNamePattern.test(String(pre.name)) &&
    isVersion(pre.fromVersion) && isVersion(pre.toVersion) && typeof pre.settled === "boolean";
};

// { status: "none" | "ok" | "unreadable", record }
const readCaptureRecord = ({ managedDir, fsModule = fs }) => {
  let text;
  try {
    text = readRegularFileBounded(path.join(managedDir, kRecordFileName), { fsModule, maxBytes: kRecordMaxBytes });
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "none" : "unreadable", record: null };
  }
  let record;
  try { record = JSON.parse(text); } catch { return { status: "unreadable", record: null }; }
  return isValidRecord(record) ? { status: "ok", record } : { status: "unreadable", record: null };
};

// The capture directory's name from the manifest path Doctor printed
// (<root>.update-captures/<name>/manifest.json, possibly ~/ shortened).
const captureNameFromManifest = (manifestPath) => {
  const directory = path.dirname(String(manifestPath || ""));
  const name = path.basename(directory);
  if (!kCaptureNamePattern.test(name) || !path.basename(path.dirname(directory)).endsWith(".update-captures")) return null;
  return name;
};

const createUpdateCaptureTracker = ({
  managedDir,
  getInstalledVersion = () => null,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  let loaded = null;
  let unsaved = false;

  const load = () => {
    if (!loaded) loaded = readCaptureRecord({ managedDir, fsModule });
    return loaded;
  };

  const save = () => {
    try {
      writeFileAtomic(path.join(managedDir, kRecordFileName), JSON.stringify(loaded.record, null, 2) + "\n", { fsModule });
      if (unsaved) logger.log?.("[alphaclaw] update captures: saved the record after an earlier failed write");
      unsaved = false;
    } catch (error) {
      if (!unsaved) logger.warn?.(`[alphaclaw] update captures: could not save the record (${error.code || error.message}); no capture is removed until it saves`);
      unsaved = true;
    }
  };

  const promote = ({ name, fromVersion, toVersion, source }) => {
    const previous = loaded.record.preUpgradeCapture;
    loaded.record.preUpgradeCapture = { name, fromVersion, toVersion, at: nowFn(), source, settled: false };
    logger.log?.(
      `[alphaclaw] update captures: keeping ${name} as the copy from before OpenClaw ${fromVersion} -> ${toVersion}` +
        (previous && previous.name !== name ? `; ${previous.name} is no longer held for the ${previous.fromVersion} -> ${previous.toVersion} change` : ""),
    );
  };

  const isRecordedFor = (pre, fromVersion, toVersion) =>
    !!pre && !pre.settled && pre.fromVersion === fromVersion && pre.toVersion === toVersion;

  const noteDoctorCapture = ({ manifestPath, installedVersion }) => {
    const name = captureNameFromManifest(manifestPath);
    if (!name) return { promoted: false, reason: "unrecognized_path" };
    const { status, record } = load();
    if (status !== "ok") return { promoted: false, reason: status === "none" ? "no_record" : "record_unreadable" };
    const fromVersion = record.lastHealthyVersion;
    if (!isVersion(installedVersion) || !fromVersion) return { promoted: false, reason: "version_unknown" };
    if (fromVersion === installedVersion) return { promoted: false, reason: "same_version" };
    if (isRecordedFor(record.preUpgradeCapture, fromVersion, installedVersion)) return { promoted: false, reason: "already_recorded" };
    promote({ name, fromVersion, toVersion: installedVersion, source: "doctor" });
    save();
    return { promoted: true, name };
  };

  // listCaptures: () => [{ name, mtimeMs }] of the managed captures.
  const noteHealthyStart = ({ openclawVersion, launchedAt = null, listCaptures = () => [] }) => {
    if (!isVersion(openclawVersion)) return { changed: false, reason: "version_unknown" };
    const { status, record } = load();
    if (status !== "ok") {
      if (status === "unreadable") logger.warn?.("[alphaclaw] update captures: the record was unreadable; starting a new one");
      loaded = {
        status: "ok",
        record: { trackingSince: nowFn(), lastHealthyVersion: openclawVersion, lastHealthyAt: nowFn(), preUpgradeCapture: null },
      };
      save();
      return { changed: true };
    }
    let changed = false;
    const fromVersion = record.lastHealthyVersion;
    if (fromVersion !== openclawVersion) {
      if (fromVersion && !isRecordedFor(record.preUpgradeCapture, fromVersion, openclawVersion)) {
        let newest = null;
        try {
          for (const entry of listCaptures()) {
            if (Number.isFinite(launchedAt) && entry.mtimeMs >= launchedAt) continue;
            if (!newest || entry.mtimeMs > newest.mtimeMs) newest = entry;
          }
        } catch {}
        if (newest) promote({ name: newest.name, fromVersion, toVersion: openclawVersion, source: "healthy_start" });
      }
      record.lastHealthyVersion = openclawVersion;
      record.lastHealthyAt = nowFn();
      changed = true;
    }
    if (record.preUpgradeCapture && !record.preUpgradeCapture.settled) {
      record.preUpgradeCapture.settled = true;
      changed = true;
    }
    if (changed || unsaved) save();
    return { changed };
  };

  // What the sweep and the disk view plan with. flush retries a failed write.
  const getState = ({ flush = false } = {}) => {
    const { status, record } = load();
    if (flush && unsaved) save();
    let installedVersion = null;
    try { installedVersion = getInstalledVersion() || null; } catch {}
    return {
      status: unsaved ? "unsaved" : status,
      record: record ? structuredClone(record) : null,
      installedVersion: isVersion(installedVersion) ? installedVersion : null,
    };
  };

  return { noteDoctorCapture, noteHealthyStart, getState };
};

module.exports = {
  createUpdateCaptureTracker,
  readCaptureRecord,
  captureNameFromManifest,
  kRecordFileName,
};
