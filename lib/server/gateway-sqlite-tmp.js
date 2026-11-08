const fs = require("fs");
const path = require("path");
const { kGatewaySqliteTmpDir } = require("./constants");

// Where SQLite puts its temp files in the gateway and every openclaw CLI
// spawn. SQLite's unix VFS picks the first usable dir from SQLITE_TMPDIR,
// TMPDIR, /var/tmp, /usr/tmp, /tmp; a VACUUM writes a copy of the whole
// database there and large sorts and index builds spill there, so a
// multi-GB agent database spills GBs onto the container's own disk. With
// neither variable set the gateway gets a private dir on the data volume
// instead. A deployment that sets either one keeps it: SQLite already falls
// back from SQLITE_TMPDIR to TMPDIR, so AlphaClaw adds nothing.
// Windows SQLite reads TMP/TEMP instead; the variable is set there too and
// is simply unused.

const kOperatorKeys = Object.freeze(["SQLITE_TMPDIR", "TMPDIR"]);
// SQLite names its temp files etilqs_<hex> (plus a journal for a temp
// database) and unlinks them right after opening, so a named one in the dir is
// left over from a process that died mid-open. The age floor keeps the sweep
// away from that instant anyway.
const kSqliteTempNamePattern = /^etilqs_[0-9a-f]+(?:-journal|-wal|-shm)?$/;
const kSweepMinAgeMs = 10 * 60 * 1000;

// gatewayEnv() also runs inside CLI commands whose stdout is JSON, so the
// only line this writes goes to stderr, once.
let refusalLogged = false;

const isSet = (env, key) => String(env[key] ?? "").trim() !== "";

// Create the dir at 0700 (tightened when it already exists). Anything that is
// not a real directory owned by this user is refused: SQLite then uses its
// own default and nothing is written through a symlink.
const ensurePrivateDir = (dir, { fsImpl, uid }) => {
  fsImpl.mkdirSync(path.dirname(dir), { recursive: true });
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fsImpl.lstatSync(dir);
  if (!stat.isDirectory()) return false;
  if (uid !== undefined && stat.uid !== uid) return false;
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) fsImpl.chmodSync(dir, 0o700);
  return true;
};

// Mutates and returns env (the caller's own child-env object).
const applyGatewaySqliteTmpDir = (
  env,
  { dir = kGatewaySqliteTmpDir, fsImpl = fs, logger = console, uid = process.getuid?.() } = {},
) => {
  if (kOperatorKeys.some((key) => isSet(env, key))) return env;
  let usable = false;
  try {
    usable = ensurePrivateDir(dir, { fsImpl, uid });
  } catch {}
  if (!usable) {
    if (!refusalLogged) {
      refusalLogged = true;
      logger.warn?.(`[alphaclaw] gateway SQLite temp dir ${dir} is not a private directory this user owns; SQLite keeps its default temp location`);
    }
    return env;
  }
  env.SQLITE_TMPDIR = dir;
  return env;
};

// Before a gateway launch with no gateway serving (boot included): remove
// stale SQLite temp files from AlphaClaw's own dir. Only regular files with
// SQLite's temp-file name, owned by this user and older than the floor; never
// a directory, a symlink or anything outside the dir. One log line when
// something was removed or failed.
const sweepGatewaySqliteTmpDir = ({
  dir = kGatewaySqliteTmpDir,
  nowMs = Date.now(),
  uid = process.getuid?.(),
  fsImpl = fs,
  logger = console,
} = {}) => {
  const result = { removed: 0, freedBytes: 0, failed: 0 };
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!kSqliteTempNamePattern.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fsImpl.lstatSync(file);
      if (!stat.isFile()) continue;
      if (uid !== undefined && stat.uid !== uid) continue;
      if (nowMs - stat.mtimeMs < kSweepMinAgeMs) continue;
      fsImpl.unlinkSync(file);
      result.removed += 1;
      result.freedBytes += stat.blocks * 512;
    } catch {
      result.failed += 1;
    }
  }
  if (result.removed || result.failed) {
    const failed = result.failed ? `, ${result.failed} failed` : "";
    logger.log?.(
      `[alphaclaw] gateway SQLite temp sweep: removed ${result.removed} stale file(s), ${Math.round(result.freedBytes / 1024 / 1024)} MB freed${failed}`,
    );
  }
  return result;
};


module.exports = {
  applyGatewaySqliteTmpDir,
  sweepGatewaySqliteTmpDir,
  kSqliteTempNamePattern,
};
