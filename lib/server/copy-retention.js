// Retention for the copies that otherwise pile up forever (ALPH-40): Back up
// now archives (OpenClaw's `backup create` output in AlphaClaw's backups
// dir) and OpenClaw's Doctor and update state captures
// (<state>.update-captures), plus the relay backups written beside each
// archive (<timestamp>-relay-backup, relay/backup.js). Archives and relay
// backups keep the newest `keep` and anything younger than `days`; the rest
// goes, one item at a time, on the watchdog's periodic sweep (the same
// 30-minute timer as the snapshot sweep).
//
// Captures keep only the newest `captureKeep` (no days floor): each is a
// full copy of the state (about 5 GB on a busy box) taken right before an
// upgrade, so the newest is the one way back to the version just replaced,
// and a days floor kept one or two older ones beside it on any box that
// upgrades weekly. Instead of age, captures wait for proof the upgrade
// worked: none is removed until this process has seen a managed gateway
// launch answer /readyz ready (noteHealthyGatewayBoot, from
// restart-required-launch-clear.js) on the OpenClaw version installed now,
// after the newest capture was sealed. The newest capture is never removed.
//
// Only what the feature itself made is ever a candidate, so an operator's own
// files and folders survive whatever they are called:
// - an archive must be a regular file named like OpenClaw's own archives
//   (<timestamp>-openclaw-backup.tar.gz) and owned by this user;
// - a capture must be a directory owned by this user, carry OpenClaw's
//   private capture marker with its exact content, and be sealed
//   (manifest.json present, no manifest.json.partial). Its age is the
//   manifest's mtime, written when OpenClaw sealed it.
// Nothing any process holds open is removed (read from /proc right before
// the delete; without /proc nothing is removed). Members past 500 are left
// for the next sweep. Like the snapshot sweep it runs under the operator box
// lock (step `sweep-delete`) when one is configured, without waiting: while
// another operator holds it the sweep is skipped and the next one retries.
//
// Deployment env, read per sweep: ALPHACLAW_BACKUP_RETENTION_KEEP (default 3,
// 1-100) and ALPHACLAW_BACKUP_RETENTION_DAYS (default 7, 1-3650) for archives
// and relay backups, ALPHACLAW_UPDATE_CAPTURE_KEEP (default 1, 1-100) for
// captures.
const fs = require("fs");
const path = require("path");
const { readOpenPaths, isHeld } = require("./openclaw-snapshot-sweep");
const { getBoxLock } = require("./box-lock");
const { kRelayBackupMarker, kRelayBackupNamePattern } = require("./relay/backup");
const { describeExecutingBuild } = require("./openclaw-build");
const { resolveSelfDependency } = require("./self-dependency");

const kDefaultKeep = 3;
const kDefaultDays = 7;
const kDefaultCaptureKeep = 1;
const kMaxMembers = 500;
const kArchivePattern = /^\d{4}-\d{2}-\d{2}T[0-9.+\-Z]+-openclaw-backup\.tar\.gz$/;
const kCaptureNamePattern = /^[A-Za-z0-9_-]{1,128}$/;
const kCaptureMarker = ".openclaw-private-update-capture";
const kCaptureMarkerContent = "openclaw-private-update-capture-v1\n";
const kDayMs = 24 * 60 * 60 * 1000;

const readSetting = (raw, fallback, max) => {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) return fallback;
  const value = Number(text);
  return value >= 1 && value <= max ? value : fallback;
};

const resolveRetentionPolicy = (env = process.env) => ({
  keep: readSetting(env.ALPHACLAW_BACKUP_RETENTION_KEEP, kDefaultKeep, 100),
  days: readSetting(env.ALPHACLAW_BACKUP_RETENTION_DAYS, kDefaultDays, 3650),
});

const resolveCaptureKeep = (env = process.env) => readSetting(env.ALPHACLAW_UPDATE_CAPTURE_KEEP, kDefaultCaptureKeep, 100);

const readInstalledOpenclawVersion = () => {
  try {
    return describeExecutingBuild({ installDir: resolveSelfDependency({ fsImpl: fs }).installDir })?.version ?? null;
  } catch {
    return null;
  }
};

// The latest managed gateway launch this process saw answer /readyz ready,
// with the OpenClaw version installed at that moment.
let healthyBoot = null;
const noteHealthyGatewayBoot = ({ version, readyAtMs }) => {
  healthyBoot = version && Number.isFinite(readyAtMs) ? { version, readyAtMs } : null;
};
const getHealthyGatewayBoot = () => healthyBoot;

// Whether captures may be removed: open, or why not.
const resolveCaptureGate = ({ newest, boot, installedVersion }) => {
  if (!boot) return "waiting_for_healthy_boot";
  if (!installedVersion || boot.version !== installedVersion) return "waiting_for_boot_on_installed_version";
  if (newest && boot.readyAtMs <= newest.mtimeMs) return "waiting_for_boot_after_newest_capture";
  return "open";
};

const ownedBy = (stat, uid) => uid === undefined || stat.uid === uid;

// { ageMs, bytes } for an archive this feature made, or { reason } why not.
const inspectArchive = (filePath, uid, fsModule) => {
  const stat = fsModule.lstatSync(filePath);
  if (!stat.isFile()) return { reason: "not_a_file" };
  if (!ownedBy(stat, uid)) return { reason: "other_owner" };
  return { mtimeMs: stat.mtimeMs, bytes: Number(stat.blocks) > 0 ? Number(stat.blocks) * 512 : Number(stat.size) || 0 };
};

const inspectCapture = (directory, uid, fsModule) => {
  const stat = fsModule.lstatSync(directory);
  if (!stat.isDirectory()) return { reason: "not_a_directory" };
  if (!ownedBy(stat, uid)) return { reason: "other_owner" };
  const markerPath = path.join(directory, kCaptureMarker);
  let marker;
  try { marker = fsModule.lstatSync(markerPath); } catch { return { reason: "no_marker" }; }
  if (!marker.isFile() || marker.size !== kCaptureMarkerContent.length) return { reason: "no_marker" };
  if (fsModule.readFileSync(markerPath, "utf8") !== kCaptureMarkerContent) return { reason: "no_marker" };
  try {
    fsModule.lstatSync(path.join(directory, "manifest.json.partial"));
    return { reason: "unsealed" };
  } catch {}
  let manifest;
  try { manifest = fsModule.lstatSync(path.join(directory, "manifest.json")); } catch { return { reason: "unsealed" }; }
  if (!manifest.isFile()) return { reason: "unsealed" };
  return { mtimeMs: manifest.mtimeMs, bytes: null };
};

// A relay backup (relay/backup.js) is a directory beside the archive whose
// manifest carries the relay backup marker; its age is the manifest's mtime.
const inspectRelayBackup = (directory, uid, fsModule) => {
  const stat = fsModule.lstatSync(directory);
  if (!stat.isDirectory()) return { reason: "not_a_directory" };
  if (!ownedBy(stat, uid)) return { reason: "other_owner" };
  const manifestPath = path.join(directory, "manifest.json");
  let manifest;
  try { manifest = fsModule.lstatSync(manifestPath); } catch { return { reason: "no_marker" }; }
  if (!manifest.isFile() || manifest.size > 64 * 1024) return { reason: "no_marker" };
  let marker = null;
  try { marker = JSON.parse(fsModule.readFileSync(manifestPath, "utf8"))?.marker; } catch {}
  if (marker !== kRelayBackupMarker) return { reason: "no_marker" };
  return { mtimeMs: manifest.mtimeMs, bytes: null };
};

const kFamilies = Object.freeze({
  backups: { id: "alphaclaw_backups", namePattern: kArchivePattern, inspect: inspectArchive },
  relayBackups: { id: "relay_backups", namePattern: kRelayBackupNamePattern, inspect: inspectRelayBackup },
  captures: { id: "openclaw_update_captures", namePattern: kCaptureNamePattern, inspect: inspectCapture },
});

// Read-only plan for one family: every entry with its verdict, given by
// verdictOf(index, entry, managed) over the managed entries newest first.
// verdict: due | kept_newest | kept_recent | kept_until_healthy_boot |
// not_managed (+ reason).
const planFamily = ({ family, dir, nowMs, uid, fsModule, verdictOf }) => {
  let names;
  try {
    names = fsModule.readdirSync(dir);
  } catch {
    return { dir, present: false, entries: [], truncated: false };
  }
  const managed = [];
  const entries = [];
  for (const name of names.filter((entry) => family.namePattern.test(entry)).slice(0, kMaxMembers)) {
    const fullPath = path.join(dir, name);
    let info;
    try { info = family.inspect(fullPath, uid, fsModule); } catch { info = { reason: "unreadable" }; }
    if (info.reason) entries.push({ name, path: fullPath, verdict: "not_managed", reason: info.reason });
    else managed.push({ name, path: fullPath, mtimeMs: info.mtimeMs, bytes: info.bytes });
  }
  managed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  managed.forEach((entry, index) => entries.push({ ...entry, verdict: verdictOf(index, entry, managed), reason: null }));
  return { dir, present: true, entries, truncated: names.length > kMaxMembers };
};

const planRetention = ({
  backupsDir,
  stateDir,
  env = process.env,
  nowMs = Date.now(),
  uid = process.getuid?.(),
  fsModule = fs,
  boot = getHealthyGatewayBoot(),
  readInstalledVersion = readInstalledOpenclawVersion,
} = {}) => {
  const policy = { ...resolveRetentionPolicy(env), captureKeep: resolveCaptureKeep(env) };
  const keepNewestOrRecent = (index, entry) =>
    index < policy.keep ? "kept_newest" : nowMs - entry.mtimeMs < policy.days * kDayMs ? "kept_recent" : "due";
  const planCopies = (family) => ({
    ...planFamily({ family, dir: backupsDir, nowMs, uid, fsModule, verdictOf: keepNewestOrRecent }),
    id: family.id,
    keep: policy.keep,
    days: policy.days,
  });
  const families = backupsDir ? [planCopies(kFamilies.backups), planCopies(kFamilies.relayBackups)] : [];
  if (stateDir) {
    let realState;
    try { realState = fsModule.realpathSync(stateDir); } catch { realState = path.resolve(stateDir); }
    let gate = null;
    const plan = planFamily({
      family: kFamilies.captures,
      dir: realState + ".update-captures",
      nowMs,
      uid,
      fsModule,
      verdictOf: (index, entry, sorted) => {
        if (index === 0 || index < policy.captureKeep) return "kept_newest";
        gate ??= resolveCaptureGate({ newest: sorted[0], boot, installedVersion: readInstalledVersion() });
        return gate === "open" ? "due" : "kept_until_healthy_boot";
      },
    });
    families.push({ ...plan, id: kFamilies.captures.id, keep: policy.captureKeep, days: null, gate });
  }
  return { policy, families };
};

const measureTree = (target, fsModule) => {
  let bytes = 0;
  const stack = [target];
  let seen = 0;
  while (stack.length && seen < 100_000) {
    const current = stack.pop();
    seen += 1;
    let stat;
    try { stat = fsModule.lstatSync(current); } catch { continue; }
    bytes += Number(stat.blocks) > 0 ? Number(stat.blocks) * 512 : 0;
    if (stat.isDirectory()) {
      try { for (const name of fsModule.readdirSync(current)) stack.push(path.join(current, name)); } catch {}
    }
  }
  return bytes;
};

const formatBytes = (bytes) => (bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + " GB" : Math.round(bytes / 1e6) + " MB");

let lastSweep = null;

const sweepRetainedCopiesNow = ({
  backupsDir,
  stateDir,
  env = process.env,
  nowMs = Date.now(),
  uid = process.getuid?.(),
  boot = getHealthyGatewayBoot(),
  readInstalledVersion = readInstalledOpenclawVersion,
  procRoot = "/proc",
  fsModule = fs,
  readOpen = readOpenPaths,
  logger = console,
} = {}) => {
  const plan = planRetention({ backupsDir, stateDir, env, nowMs, uid, fsModule, boot, readInstalledVersion });
  const due = plan.families.flatMap((family) => family.entries.filter((entry) => entry.verdict === "due").map((entry) => ({ family: family.id, ...entry })));
  const result = { at: new Date(nowMs).toISOString(), policy: plan.policy, due: due.length, removed: 0, freedBytes: 0, held: 0, failed: 0, unverified: 0, byFamily: {} };
  for (const family of plan.families) result.byFamily[family.id] = { removed: 0, freedBytes: 0 };
  const openPaths = due.length > 0 ? readOpen(procRoot) : null;
  for (const entry of due) {
    if (!openPaths) {
      result.unverified += 1;
      continue;
    }
    if (isHeld(entry.path, openPaths)) {
      result.held += 1;
      continue;
    }
    try {
      const bytes = entry.bytes ?? measureTree(entry.path, fsModule);
      fsModule.rmSync(entry.path, { recursive: true, force: true });
      if (entry.family === kFamilies.captures.id) {
        logger.log(`[alphaclaw] retention sweep: removed OpenClaw update capture ${entry.name} (${formatBytes(bytes)}, ${bytes} bytes)`);
      }
      result.removed += 1;
      result.freedBytes += bytes;
      result.byFamily[entry.family].removed += 1;
      result.byFamily[entry.family].freedBytes += bytes;
    } catch {
      result.failed += 1;
    }
  }
  lastSweep = result;
  if (due.length > 0) {
    logger.log(
      "[alphaclaw] retention sweep: keep newest " + plan.policy.keep + " and anything under " + plan.policy.days + " days; " +
      due.length + " due, removed " + result.removed + " (" + formatBytes(result.freedBytes) + "), " +
      result.held + " held open, " + result.failed + " failed, " + result.unverified + " unchecked without /proc; " +
      "update captures keep newest " + plan.policy.captureKeep + " after a healthy gateway boot",
    );
  }
  return result;
};

const sweepRetainedCopies = (options = {}) => {
  const locked = getBoxLock().tryWithBoxLockSync(
    { step: "sweep-delete", by: "retention-sweep" },
    () => sweepRetainedCopiesNow(options),
  );
  if (locked.ran) return locked.value;
  (options.logger || console).log(`[alphaclaw] retention sweep: skipped: ${locked.error.message}`);
  return { skipped: locked.error.code };
};

const getLastRetentionSweep = () => lastSweep;

module.exports = {
  planRetention,
  resolveRetentionPolicy,
  resolveCaptureKeep,
  noteHealthyGatewayBoot,
  getHealthyGatewayBoot,
  sweepRetainedCopies,
  getLastRetentionSweep,
  kCaptureMarker,
  kCaptureMarkerContent,
};
