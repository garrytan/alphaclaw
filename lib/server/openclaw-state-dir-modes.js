// The permission fixes OpenClaw needs on its state dir and the folders above
// it, run before every Doctor (doctor-fix-runner.js) and every gateway launch
// (gateway.js prepareGatewayLaunch):
//
//   setgid   OpenClaw 2026.11.5's Doctor refuses to create directories under
//            a setgid state dir (a fresh one under a 2775 /data, the #144
//            layout): "Failed migrating daemon runtime pins: FsSafeError:
//            created directory admission failed". The bit is cleared on the
//            state dir only.
//   temp     OpenClaw 2026.11.10 reads nothing, its config included, without
//            a temp root whose every ancestor is either not group/world-
//            writable or sticky (tmp-openclaw-dir assertSafeTempAncestors).
//            Its private fallback root is <state>/tmp/openclaw-<uid>, so the
//            walk starts at <state>/tmp (the state dir when there is none
//            yet, or when it is a symlink, whose target is left alone) and
//            goes up to /. <state>/tmp and the state dir are
//            AlphaClaw's own, so a failing one loses group and world write
//            (OpenClaw's own advice for a private ancestor); a shared folder
//            above them, like a 2775 /data, gets the sticky bit.
//
// Only folders the process uid owns are changed. Each change goes through a
// handle, never a path: the folder is lstat'ed (a symlink is left alone),
// opened O_RDONLY|O_DIRECTORY|O_NOFOLLOW, and the handle's fstat must match
// the lstat's device, inode, owner and mode, and on Linux the handle must
// still sit at that path (/proc/self/fd), or the folder is left alone with
// one log line. The new mode is computed from the handle's mode and set with
// fchmod, so a folder swapped for a symlink between the check and the change
// is never the one changed (the pattern openclaw-snapshot-enable.js uses).
// Nothing here throws.
const fs = require("fs");
const path = require("path");

const kDirFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

const octal = (mode) => "0" + (Number(mode) & 0o7777).toString(8);

const failsTempRule = (mode) => (mode & 0o022) !== 0 && (mode & 0o1000) === 0;

const isInside = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// Applies decide(mode) → new mode | null to one folder through a verified
// handle. Returns { path, oldMode, newMode } when it changed the folder.
const chmodDirThroughHandle = ({ dir, decide, uid, fsModule, platform, logger, label }) => {
  let named;
  try {
    named = fsModule.lstatSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (named.isSymbolicLink() || !named.isDirectory() || named.uid !== uid) return null;
  if (decide(named.mode & 0o7777) == null) return null;
  let fd;
  try {
    fd = fsModule.openSync(dir, kDirFlags);
  } catch (error) {
    logger.warn?.(`[alphaclaw] ${label}: left ${dir} alone: it could not be opened as a real directory (${error?.code || error?.message})`);
    return null;
  }
  try {
    const opened = fsModule.fstatSync(fd);
    const sameFolder =
      opened.isDirectory() && opened.dev === named.dev && opened.ino === named.ino && opened.uid === named.uid && opened.mode === named.mode;
    const samePath = platform !== "linux" || fsModule.readlinkSync(`/proc/self/fd/${fd}`) === dir;
    if (!sameFolder || !samePath) {
      logger.warn?.(`[alphaclaw] ${label}: left ${dir} alone: it changed between the check and the change`);
      return null;
    }
    const oldMode = opened.mode & 0o7777;
    const newMode = decide(oldMode);
    if (newMode == null || newMode === oldMode) return null;
    fsModule.fchmodSync(fd, newMode);
    return { path: dir, oldMode: octal(oldMode), newMode: octal(newMode) };
  } finally {
    try {
      fsModule.closeSync(fd);
    } catch {}
  }
};

const prepareOpenclawStateDirModes = ({
  openclawDir,
  label = "gateway launch",
  fsModule = fs,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  platform = process.platform,
  logger = console,
} = {}) => {
  if (uid === null || platform === "win32") return [];
  let stateDir;
  try {
    stateDir = fsModule.realpathSync(openclawDir);
  } catch (error) {
    if (error?.code !== "ENOENT") logger.warn?.(`[alphaclaw] ${label}: could not resolve the OpenClaw state dir: ${error.message}`);
    return [];
  }
  const changed = [];
  try {
    const cleared = chmodDirThroughHandle({
      dir: stateDir,
      decide: (mode) => (mode & 0o2000 ? mode & ~0o2000 : null),
      uid,
      fsModule,
      platform,
      logger,
      label,
    });
    if (cleared) {
      changed.push(cleared);
      logger.log?.(`[alphaclaw] ${label}: cleared the setgid bit on the OpenClaw state dir (${cleared.oldMode} → ${cleared.newMode}), which OpenClaw 2026.11.5's Doctor refuses to create directories under`);
    }
  } catch (error) {
    logger.warn?.(`[alphaclaw] ${label}: could not check the OpenClaw state dir's setgid bit: ${error.message}`);
  }
  try {
    const tmpDir = path.join(stateDir, "tmp");
    let start = stateDir;
    try {
      const tmp = fsModule.lstatSync(tmpDir);
      if (tmp.isDirectory() && !tmp.isSymbolicLink()) start = tmpDir;
    } catch {}
    for (let dir = start; ; dir = path.dirname(dir)) {
      const ownFolder = isInside(dir, stateDir);
      const result = chmodDirThroughHandle({
        dir,
        decide: (mode) => (failsTempRule(mode) ? (ownFolder ? mode & ~0o022 : mode | 0o1000) : null),
        uid,
        fsModule,
        platform,
        logger,
        label,
      });
      if (result) {
        changed.push(result);
        logger.log?.(
          ownFolder
            ? `[alphaclaw] ${label}: removed group and world write from ${dir} (${result.oldMode} → ${result.newMode}), which OpenClaw 2026.11.10 needs before it uses a temp directory under the state dir`
            : `[alphaclaw] ${label}: set the sticky bit on ${dir} (${result.oldMode} → ${result.newMode}), which OpenClaw 2026.11.10 needs before it uses a temp directory under the state dir`,
        );
      }
      if (path.dirname(dir) === dir) break;
    }
  } catch (error) {
    logger.warn?.(`[alphaclaw] ${label}: could not check the OpenClaw state dir's folders for OpenClaw's temp-root rule: ${error.message}`);
  }
  return changed;
};

module.exports = { prepareOpenclawStateDirModes };
