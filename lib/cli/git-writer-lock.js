const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Cooperative writer lock for the managed .openclaw checkout (issue #140).
//
// Every AlphaClaw git-sync takes an exclusive flock(2) on ONE fixed file,
// `<git common dir>/alphaclaw-writer.lock`, and holds it from preflight to
// the live-tree fast-forward. Other writers on the box (cron scripts, hooks,
// a second tool) cooperate by locking the same file with flock(1):
//
//   LOCK="$(cd "$OPENCLAW_STATE_DIR" && cd "$(git rev-parse --git-common-dir)" && pwd)/alphaclaw-writer.lock"
//   flock -o -x -w 120 "$LOCK" <their git commands>
//
// The path is deliberately not configurable: the scheduled run only sees
// .env (system-cron.js), which the agent can write, so an override would
// either split cron and the server onto two locks or let the agent choose
// where root creates a file.
//
// The lock lives on an open file description Node owns. Node opens fds
// close-on-exec, so git children, hooks and anything they background never
// inherit it; it is released when the fd closes or the process exits. The
// flock(1) child only performs the flock(2) call on the fd it is handed in
// stdio slot 3 and exits; the lock stays with the shared description.
//
// Nesting: a wrapper that already holds the lock on a fd it passes down
// exports ALPHACLAW_GIT_LOCK_FD=<n>. The fd is used only when fstat(n) is the
// lock file itself (dev + inode); flocking it again is immediate when the
// wrapper holds it and a real wait when it does not, so a forged value can
// never skip the lock.
const kWriterLockFileName = "alphaclaw-writer.lock";
const kHolderFileName = `${kWriterLockFileName}.holder`;
const kFlockTimeoutExit = 75;

const resolveWriterLockPath = ({ git, openclawDir }) => {
  const commonDir = String(git(["rev-parse", "--git-common-dir"])).trim();
  if (!commonDir) return "";
  return path.join(path.resolve(openclawDir, commonDir), kWriterLockFileName);
};

const flockFd = ({ fd, waitSeconds, spawnSyncImpl, flockBin }) => {
  const result = spawnSyncImpl(
    flockBin,
    ["-x", "-w", String(waitSeconds), "-E", String(kFlockTimeoutExit), "3"],
    { stdio: ["ignore", "ignore", "pipe", fd] },
  );
  if (result.error) return { status: "unavailable", detail: String(result.error.code || result.error.message) };
  if (result.status === 0) return { status: "acquired" };
  if (result.status === kFlockTimeoutExit) return { status: "timeout" };
  return { status: "unavailable", detail: String(result.stderr || `flock exited ${result.status}`).trim() };
};

const inheritedLockFd = ({ env, lockPath, fsModule }) => {
  const raw = String(env.ALPHACLAW_GIT_LOCK_FD || "").trim();
  if (!/^[0-9]{1,4}$/.test(raw)) return null;
  const fd = Number(raw);
  if (fd < 3) return null;
  try {
    const held = fsModule.fstatSync(fd);
    const lockStat = fsModule.statSync(lockPath);
    return held.dev === lockStat.dev && held.ino === lockStat.ino ? fd : null;
  } catch {
    return null;
  }
};

const readLockHolder = ({ lockPath, fsModule = fs }) => {
  try {
    const holder = JSON.parse(fsModule.readFileSync(`${lockPath}.holder`, "utf8"));
    const pid = Number(holder?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    let alive = false;
    try {
      alive = fsModule.existsSync(`/proc/${pid}`);
    } catch {}
    return {
      pid,
      trigger: String(holder.trigger || ""),
      startedAt: String(holder.startedAt || ""),
      alive,
    };
  } catch {
    return null;
  }
};

const writeLockHolder = ({ lockPath, fsModule, trigger, now }) => {
  try {
    const flags = fsModule.constants.O_WRONLY | fsModule.constants.O_CREAT |
      fsModule.constants.O_TRUNC | (fsModule.constants.O_NOFOLLOW || 0);
    const fd = fsModule.openSync(`${lockPath}.holder`, flags, 0o600);
    try {
      fsModule.writeSync(fd, JSON.stringify({
        pid: process.pid,
        trigger,
        startedAt: new Date(now).toISOString(),
      }));
    } finally {
      fsModule.closeSync(fd);
    }
  } catch {}
};

// Returns { status: acquired|timeout|unavailable, lockPath, release(),
// waitedMs, holder?, detail? }. `unavailable` means no usable flock binary or
// lock file: the caller runs unlocked and reports it.
const acquireWriterLock = ({
  lockPath,
  waitSeconds,
  trigger = "caller",
  env = process.env,
  fsModule = fs,
  spawnSyncImpl = spawnSync,
  flockBin = "flock",
  nowFn = Date.now,
  recordHolder = true,
}) => {
  const startedAt = nowFn();
  const done = (status, extra = {}) => ({
    status,
    lockPath,
    waitedMs: nowFn() - startedAt,
    release: () => {},
    ...extra,
  });
  const wait = Math.max(0, Math.floor(Number(waitSeconds) || 0));
  const inherited = inheritedLockFd({ env, lockPath, fsModule });
  let fd = inherited;
  if (fd === null) {
    try {
      fd = fsModule.openSync(lockPath, "a", 0o600);
    } catch (error) {
      return done("unavailable", { detail: String(error.code || error.message) });
    }
  }
  const ownsFd = fd !== inherited;
  const closeOwned = () => {
    if (!ownsFd) return;
    try {
      fsModule.closeSync(fd);
    } catch {}
  };
  const result = flockFd({ fd, waitSeconds: wait, spawnSyncImpl, flockBin });
  if (result.status !== "acquired") {
    closeOwned();
    return done(result.status, {
      detail: result.detail,
      holder: result.status === "timeout" ? readLockHolder({ lockPath, fsModule }) : null,
    });
  }
  const writesHolder = recordHolder && inherited === null;
  if (writesHolder) writeLockHolder({ lockPath, fsModule, trigger, now: nowFn() });
  let released = false;
  return done("acquired", {
    nested: inherited !== null,
    release: () => {
      if (released) return;
      released = true;
      if (writesHolder) {
        try {
          fsModule.rmSync(`${lockPath}.holder`, { force: true });
        } catch {}
      }
      closeOwned();
    },
  });
};

module.exports = {
  kWriterLockFileName,
  kHolderFileName,
  resolveWriterLockPath,
  acquireWriterLock,
  readLockHolder,
};
