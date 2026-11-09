const fs = require("fs");
const path = require("path");
const { kOpenclawArchiveReadCacheDir } = require("./constants");

// OpenClaw 2026.10.9 reads a compressed session archive
// (<id>.jsonl.reset.<ts>.zst, .deleted.) by writing a full decompressed copy
// to <OpenClaw temp root>/session-archive-read-cache and reading that
// (materializeSessionArchiveForRead, src/config/sessions/archive-compression.ts).
// One copy per archive, kept 24 h, with no size cap. The temp root is the
// hard-coded /tmp/openclaw whenever that directory is safe; TMPDIR only names
// the fallback, and no env var or config key moves it or caps the cache. A
// box with a few hundred archives holds GBs of copies there, and Render
// replaces the whole instance at 2 GB of /tmp (Nov 9: 2.69 GB in 65 s).
//
// So before every gateway launch, with no gateway serving, AlphaClaw makes
// /tmp/openclaw/session-archive-read-cache a symlink to a 0700 dir on the data
// volume. OpenClaw checks the ownership and mode of /tmp/openclaw only, and
// its mkdir, write, rename and sweep all go through the link. The cache is
// derived data: an old real directory there is removed, not moved. If
// /tmp/openclaw is not a real directory this user owns, OpenClaw falls back
// to <TMPDIR>/openclaw-<uid> itself and nothing here touches it.

const kCacheDirName = "session-archive-read-cache";
const kDefaultTmpRoot = "/tmp/openclaw";
// A copy OpenClaw was writing when its process died stays as
// <name>.jsonl.<pid>.<uuid>.tmp and nothing removes it: OpenClaw's own sweep
// keeps .tmp files for 24 h like the rest. The age floor keeps the prelaunch
// sweep away from a CLI process writing one right now.
const kOrphanTempPattern = /\.jsonl\.\d+\.[0-9a-f-]{36}\.tmp$/;
const kOrphanMinAgeMs = 10 * 60 * 1000;
// An old cache directory is renamed to this before it is removed; one a
// failed removal left behind goes on the next launch.
const kRemovingPattern = /^\.session-archive-read-cache-removing-\d+$/;

const resolveOpenclawTmpRoot = (env = process.env) =>
  String(env.ALPHACLAW_OPENCLAW_TMP_ROOT || "").trim() || kDefaultTmpRoot;

const lstatOrNull = (fsImpl, target) => {
  try {
    return fsImpl.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const ownedPrivateDir = (stat, uid) =>
  Boolean(stat?.isDirectory()) && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o022) === 0;

const sizeOf = (fsImpl, target) => {
  const stat = fsImpl.lstatSync(target);
  if (!stat.isDirectory()) return stat.blocks * 512;
  let bytes = stat.blocks * 512;
  for (const name of fsImpl.readdirSync(target)) bytes += sizeOf(fsImpl, path.join(target, name));
  return bytes;
};

const removeOrphanTempFiles = ({ fsImpl, dir, uid, nowMs }) => {
  let removed = 0;
  let freedBytes = 0;
  let names = [];
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return { removed, freedBytes };
  }
  for (const name of names) {
    if (!kOrphanTempPattern.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fsImpl.lstatSync(file);
      if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || nowMs - stat.mtimeMs < kOrphanMinAgeMs) continue;
      fsImpl.unlinkSync(file);
      removed += 1;
      freedBytes += stat.blocks * 512;
    } catch {}
  }
  return { removed, freedBytes };
};

// Returns { status, ... } and logs one line whenever it changed something or
// could not; a launch never fails because of it.
const relocateOpenclawArchiveReadCache = ({
  env = process.env,
  tmpRoot = resolveOpenclawTmpRoot(env),
  targetDir = kOpenclawArchiveReadCacheDir,
  fsImpl = fs,
  uid = process.getuid?.(),
  nowMs = Date.now(),
  platform = process.platform,
  logger = console,
} = {}) => {
  if (platform === "win32") return { status: "skipped", reason: "windows" };
  const link = path.join(tmpRoot, kCacheDirName);
  try {
    let rootStat = lstatOrNull(fsImpl, tmpRoot);
    if (!rootStat) {
      fsImpl.mkdirSync(tmpRoot, { mode: 0o700 });
      rootStat = fsImpl.lstatSync(tmpRoot);
    }
    if (!ownedPrivateDir(rootStat, uid)) {
      return { status: "skipped", reason: "tmp_root_not_private" };
    }
    for (const name of fsImpl.readdirSync(tmpRoot)) {
      if (!kRemovingPattern.test(name)) continue;
      const leftover = path.join(tmpRoot, name);
      const stat = fsImpl.lstatSync(leftover);
      if (stat.isDirectory() && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid)) fsImpl.rmSync(leftover, { recursive: true, force: true });
    }
    fsImpl.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const targetStat = fsImpl.lstatSync(targetDir);
    if (!targetStat.isDirectory() || (uid !== undefined && targetStat.uid !== uid)) {
      logger.warn?.(`[alphaclaw] OpenClaw archive read cache stays in ${link}: ${targetDir} is not a directory this user owns`);
      return { status: "skipped", reason: "target_not_private" };
    }
    if ((targetStat.mode & 0o777) !== 0o700) fsImpl.chmodSync(targetDir, 0o700);
    const orphans = removeOrphanTempFiles({ fsImpl, dir: targetDir, uid, nowMs });
    if (orphans.removed) {
      logger.log?.(`[alphaclaw] OpenClaw archive read cache: removed ${orphans.removed} unfinished copy file(s), ${Math.round(orphans.freedBytes / 1024 / 1024)} MB freed`);
    }
    const linkStat = lstatOrNull(fsImpl, link);
    if (linkStat?.isSymbolicLink() && fsImpl.readlinkSync(link) === targetDir) {
      return { status: "linked", changed: false, orphansRemoved: orphans.removed };
    }
    let clearedBytes = 0;
    let replacedLink = null;
    if (linkStat?.isSymbolicLink()) {
      replacedLink = fsImpl.readlinkSync(link);
      fsImpl.unlinkSync(link);
    } else if (linkStat?.isDirectory()) {
      const aside = path.join(tmpRoot, `.${kCacheDirName}-removing-${nowMs}`);
      fsImpl.renameSync(link, aside);
      try { clearedBytes = sizeOf(fsImpl, aside); } catch {}
      fsImpl.rmSync(aside, { recursive: true, force: true });
    } else if (linkStat) {
      logger.warn?.(`[alphaclaw] OpenClaw archive read cache stays where it is: ${link} is not a directory or a symlink`);
      return { status: "skipped", reason: "unexpected_entry" };
    }
    fsImpl.symlinkSync(targetDir, link, "dir");
    const detail = replacedLink
      ? ` (it pointed at ${replacedLink})`
      : clearedBytes
        ? ` (removed ${Math.round(clearedBytes / 1024 / 1024)} MB of copies from ${link})`
        : "";
    logger.log?.(`[alphaclaw] OpenClaw archive read cache now on the data volume: ${link} -> ${targetDir}${detail}`);
    return { status: "linked", changed: true, clearedBytes, replacedLink, orphansRemoved: orphans.removed };
  } catch (error) {
    logger.warn?.(`[alphaclaw] OpenClaw archive read cache could not be moved off ${tmpRoot}: ${error?.code || error?.message || error}`);
    return { status: "failed", error: error?.code || String(error?.message || error) };
  }
};

module.exports = {
  relocateOpenclawArchiveReadCache,
  resolveOpenclawTmpRoot,
  kOpenclawArchiveReadCacheName: kCacheDirName,
};
