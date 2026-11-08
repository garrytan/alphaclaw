// Which OpenClaw Doctor capture is the copy from before an OpenClaw upgrade
// (ALPH-69). OpenClaw's Doctor seals a full state capture
// (<state>.update-captures/doctor-<uuid>) on every run outside an update: on
// each container start and on every repair. Its manifest names no OpenClaw
// version, so the retention sweep (copy-retention.js) cannot tell the copy
// that is the way back to the previous version from a repair copy. This
// record tells it, in <managedDir>/openclaw-update-captures.json:
//
//   trackingSince         when AlphaClaw started placing captures; anything
//                         sealed before it keeps the plain keep/days rule
//   lastHealthyVersion    the OpenClaw version of the last verified healthy
//                         start (a managed launch that answered /readyz ready
//                         and was still current), read when that launch
//                         spawned
//   lastHealthyAt         when that start was verified; every verified healthy
//                         start moves it, on the same version too
//   sameVersionCaptureAt  when Doctor last reported a capture while the
//                         installed OpenClaw was still lastHealthyVersion (a
//                         copy of that version's own state)
//   preUpgradeCapture     { name, fromVersion, toVersion, at, source, settled }
//
// The rule. Every capture of the last healthy version's own state was sealed
// no later than the later of lastHealthyAt and sameVersionCaptureAt, and every
// capture sealed after that moment belongs to the version change in progress.
// So the copy from before the change is the EARLIEST capture sealed after that
// moment (by manifest seal time, the order the sweep uses). It is never simply
// the capture a Doctor line names or the newest one: a missed Doctor line, or
// repairs of a new version that has never started cleanly, only add later
// captures, and those already hold the new version's state.
//
// When it is chosen. A Doctor line seen while the installed OpenClaw differs
// from lastHealthyVersion holds that earliest capture; if AlphaClaw saw no
// such line, the next verified healthy start on the new version does (looking
// only at captures sealed before that launch spawned). Once per change: while
// the held copy is unsettled and was taken from lastHealthyVersion it is never
// replaced, and a further version change before any healthy start (A -> B
// fails -> C) only moves its toVersion to C, because the box never left A's
// state cleanly. settled turns true at the next verified healthy start. If no
// capture was sealed after that moment, nothing new is held and the previous
// held copy stays. If the captures cannot be listed, nothing changes
// (lastHealthyVersion does not move and nothing is settled), so the next
// healthy start tries again.
//
// Downgrade A->B->A: the change B->A holds its own copy (B's state), which
// releases the A-state copy taken before B. That one is then an ordinary
// capture under the keep count: A has just proven itself on this state, and
// the only way back to B, the version just left, is the B-state copy, which
// is never removed until a later change replaces it.
//
// A failed write keeps the change in memory, marks the record unsaved and is
// retried on every sweep; meanwhile the sweep removes only captures sealed
// before the record began, under the plain keep/days rule. A record file that
// is not valid JSON (or not a record) is replaced by a new one at the next
// healthy start. A record file that exists but cannot be read for any other
// reason (EIO, EACCES, ...) is never overwritten and the failure is never
// cached: every capture is kept and the read is retried next time.
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

// { status: "none" | "ok" | "unreadable" | "read_failed", record }
// unreadable: the file holds no valid record and may be replaced.
// read_failed: the file could not be read; it is never replaced.
const readCaptureRecord = ({ managedDir, fsModule = fs }) => {
  let text;
  try {
    text = readRegularFileBounded(path.join(managedDir, kRecordFileName), { fsModule, maxBytes: kRecordMaxBytes });
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "none" : "read_failed", record: null };
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

// listCaptures: () => [{ name, mtimeMs }] of the managed captures, mtimeMs
// being the manifest's seal time; it throws when the store can't be read.
const createUpdateCaptureTracker = ({
  managedDir,
  getInstalledVersion = () => null,
  listCaptures = null,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  let loaded = null;
  let unsaved = false;

  const load = () => {
    if (loaded) return loaded;
    const result = readCaptureRecord({ managedDir, fsModule });
    if (result.status === "read_failed") {
      logger.warn?.("[alphaclaw] update captures: could not read the record; keeping every capture and reading it again next time");
      return result;
    }
    loaded = result;
    return loaded;
  };

  const save = () => {
    try {
      writeFileAtomic(path.join(managedDir, kRecordFileName), JSON.stringify(loaded.record, null, 2) + "\n", { fsModule });
      if (unsaved) logger.log?.("[alphaclaw] update captures: saved the record after an earlier failed write");
      unsaved = false;
    } catch (error) {
      if (!unsaved) logger.warn?.(`[alphaclaw] update captures: could not save the record (${error.code || error.message}); only captures sealed before the record began are removed until it saves`);
      unsaved = true;
    }
  };

  // The held copy that still stands for the change away from lastHealthyVersion.
  const heldForCurrentChange = (record) => {
    const pre = record.preUpgradeCapture;
    return pre && !pre.settled && pre.fromVersion === record.lastHealthyVersion ? pre : null;
  };

  // A -> B never started cleanly and C is installed: same copy, new target.
  const retarget = (pre, toVersion) => {
    if (pre.toVersion === toVersion) return false;
    logger.log?.(
      `[alphaclaw] update captures: keeping ${pre.name} as the copy from before OpenClaw ${pre.fromVersion} -> ${toVersion}` +
        ` (${pre.toVersion} never started cleanly)`,
    );
    pre.toVersion = toVersion;
    return true;
  };

  // The earliest capture sealed after the last healthy version's own state
  // (and before "before" when given); undefined when the listing failed.
  const firstCaptureOfChange = (record, before = null) => {
    let entries;
    try {
      if (typeof listCaptures !== "function") throw new Error("no capture listing");
      entries = listCaptures();
    } catch (error) {
      logger.warn?.(`[alphaclaw] update captures: could not list the captures (${error.code || error.message}); the record is left as it is until the next try`);
      return undefined;
    }
    const boundary = Math.max(record.trackingSince, record.lastHealthyAt ?? -Infinity, record.sameVersionCaptureAt ?? -Infinity);
    let earliest = null;
    for (const entry of entries) {
      if (!(entry.mtimeMs > boundary)) continue;
      if (Number.isFinite(before) && entry.mtimeMs >= before) continue;
      if (!earliest || entry.mtimeMs < earliest.mtimeMs) earliest = entry;
    }
    return earliest;
  };

  const promote = ({ name, fromVersion, toVersion, source }) => {
    const previous = loaded.record.preUpgradeCapture;
    loaded.record.preUpgradeCapture = { name, fromVersion, toVersion, at: nowFn(), source, settled: false };
    logger.log?.(
      `[alphaclaw] update captures: keeping ${name} as the copy from before OpenClaw ${fromVersion} -> ${toVersion}` +
        (previous && previous.name !== name ? `; ${previous.name} is no longer held for the ${previous.fromVersion} -> ${previous.toVersion} change` : ""),
    );
  };

  const noteDoctorCapture = ({ manifestPath, installedVersion }) => {
    const name = captureNameFromManifest(manifestPath);
    if (!name) return { promoted: false, reason: "unrecognized_path" };
    const { status, record } = load();
    if (status !== "ok") return { promoted: false, reason: status === "none" ? "no_record" : "record_" + status };
    const fromVersion = record.lastHealthyVersion;
    if (!isVersion(installedVersion) || !fromVersion) return { promoted: false, reason: "version_unknown" };
    if (fromVersion === installedVersion) {
      record.sameVersionCaptureAt = Math.max(nowFn(), record.sameVersionCaptureAt ?? -Infinity);
      save();
      return { promoted: false, reason: "same_version" };
    }
    const held = heldForCurrentChange(record);
    if (held) {
      if (retarget(held, installedVersion)) save();
      return { promoted: false, reason: "already_recorded" };
    }
    const earliest = firstCaptureOfChange(record);
    if (earliest === undefined) return { promoted: false, reason: "listing_failed" };
    if (!earliest) return { promoted: false, reason: "no_capture_after_healthy_start" };
    promote({ name: earliest.name, fromVersion, toVersion: installedVersion, source: "doctor" });
    save();
    return { promoted: true, name: earliest.name };
  };

  const noteHealthyStart = ({ openclawVersion, launchedAt = null }) => {
    if (!isVersion(openclawVersion)) return { changed: false, reason: "version_unknown" };
    const { status, record } = load();
    if (status === "read_failed") return { changed: false, reason: "record_read_failed" };
    if (status !== "ok") {
      if (status === "unreadable") logger.warn?.("[alphaclaw] update captures: the record was unreadable; starting a new one");
      loaded = {
        status: "ok",
        record: { trackingSince: nowFn(), lastHealthyVersion: openclawVersion, lastHealthyAt: nowFn(), preUpgradeCapture: null },
      };
      save();
      return { changed: true };
    }
    const fromVersion = record.lastHealthyVersion;
    const versionChanged = fromVersion !== openclawVersion;
    if (fromVersion && versionChanged) {
      const held = heldForCurrentChange(record);
      if (held) {
        retarget(held, openclawVersion);
      } else {
        const earliest = firstCaptureOfChange(record, launchedAt);
        if (earliest === undefined) {
          if (unsaved) save();
          return { changed: false, reason: "listing_failed" };
        }
        if (earliest) promote({ name: earliest.name, fromVersion, toVersion: openclawVersion, source: "healthy_start" });
      }
    }
    const settling = !!record.preUpgradeCapture && !record.preUpgradeCapture.settled;
    record.lastHealthyVersion = openclawVersion;
    record.lastHealthyAt = nowFn();
    if (settling) record.preUpgradeCapture.settled = true;
    save();
    return { changed: versionChanged || settling };
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
