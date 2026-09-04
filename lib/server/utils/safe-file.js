const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Lock waits spin the event loop (sync callers), so the default is short: a
// legitimately long holder (doctor --fix under the config lock) surfaces as an
// honest ELOCKTIMEOUT instead of a multi-second stall for every other request.
const kDefaultLockTimeoutMs = 1000;
const kLockRetryDelayMs = 50;
const kStaleLockMs = 30_000;

// Durable, torn-free write:
//
//   write temp ──▶ fsync(temp) ──▶ rename(temp → target) ──▶ fsync(dir)
//        │              │                  │                     │
//   fails: no temp  fails: temp        fails: temp           best-effort —
//   left behind     unlinked, throw    unlinked, throw       data is already
//                   (target intact)    (target intact)       installed
//
// The directory fsync comes AFTER the rename: it is the rename (the directory
// entry) that needs to reach disk. Readers never observe a torn file because
// the rename is atomic; `durable: false` skips both fsyncs for hot writers
// whose loss on power failure is acceptable. Injected fsModule mocks without
// openSync/fsyncSync simply skip the fsyncs; mocks without renameSync fall
// back to a plain write.
//
// `mode` (opt-in; callers that omit it keep umask-default permissions): the
// temp file is created with exclusive-create ("wx") on a randomized suffix so
// the mode lands on a provably FRESH inode — the rename then installs those
// permissions even over a pre-existing looser file. (unlink-then-write would
// not guarantee a fresh inode against a racing symlink.) Caveat: the
// no-renameSync fallback writes in place, where a mode cannot tighten an
// already-existing inode — acceptable, that branch only serves mock fs.
const fsyncPathSync = (fsModule, targetPath) => {
  if (
    typeof fsModule.openSync !== "function" ||
    typeof fsModule.fsyncSync !== "function" ||
    typeof fsModule.closeSync !== "function"
  ) {
    return;
  }
  const fd = fsModule.openSync(targetPath, "r");
  try {
    fsModule.fsyncSync(fd);
  } finally {
    fsModule.closeSync(fd);
  }
};

const writeFileAtomic = (
  filePath,
  content,
  { fsModule = fs, mode, durable = true } = {},
) => {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  if (typeof fsModule.renameSync !== "function") {
    if (mode === undefined) {
      fsModule.writeFileSync(filePath, content);
    } else {
      fsModule.writeFileSync(filePath, content, { mode });
    }
    return filePath;
  }
  let tempPath;
  if (mode === undefined) {
    tempPath = `${filePath}.${process.pid}.tmp`;
    fsModule.writeFileSync(tempPath, content);
  } else {
    for (let attempt = 0; ; attempt += 1) {
      tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        fsModule.writeFileSync(tempPath, content, { mode, flag: "wx" });
        break;
      } catch (error) {
        if (error?.code === "EEXIST" && attempt < 5) continue;
        throw error;
      }
    }
  }
  const discardTemp = () => {
    try {
      fsModule.unlinkSync(tempPath);
    } catch {}
  };
  if (durable) {
    try {
      fsyncPathSync(fsModule, tempPath);
    } catch (error) {
      discardTemp();
      throw error;
    }
  }
  try {
    fsModule.renameSync(tempPath, filePath);
  } catch (error) {
    discardTemp();
    throw error;
  }
  if (durable) {
    // Best-effort: the data is installed; a directory fsync failure (odd fs,
    // Windows) only weakens crash durability, it never means a torn file.
    try {
      fsyncPathSync(fsModule, path.dirname(filePath));
    } catch {}
  }
  return filePath;
};

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Lock record. `start` is the holder's kernel start time (clock ticks from
// /proc/<pid>/stat field 22) so a recycled PID is never mistaken for the
// original holder; null where /proc is unavailable (macOS, mock fs).
const readProcStartTicks = (pid, fsModule) => {
  if (typeof fsModule.readFileSync !== "function") return null;
  try {
    const stat = String(fsModule.readFileSync(`/proc/${pid}/stat`, "utf8"));
    // The comm field can contain spaces and parentheses; fields resume after
    // the LAST ")". Field 3 (state) is rest[0], so field 22 is rest[19].
    const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
};

const buildLockRecord = (fsModule) =>
  JSON.stringify({
    pid: process.pid,
    token: crypto.randomBytes(8).toString("hex"),
    startedAt: Date.now(),
    start: readProcStartTicks(process.pid, fsModule),
  });

// Accept legacy bare-pid lock contents written by older AlphaClaw versions.
const parseLockRecord = (raw) => {
  const text = String(raw ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  const pid = Number.parseInt(text, 10);
  return Number.isFinite(pid) && pid > 0 ? { pid } : {};
};

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

// A holder is alive when its pid exists AND (where /proc is available on both
// sides) its start time matches the record — otherwise the pid was recycled.
const isHolderAlive = (record, fsModule) => {
  if (!isPidAlive(record.pid)) return false;
  if (record.start != null) {
    const current = readProcStartTicks(record.pid, fsModule);
    if (current != null && current !== record.start) return false;
  }
  return true;
};

const readLockRecord = (lockPath, fsModule) => {
  if (typeof fsModule.readFileSync !== "function") return {};
  try {
    return parseLockRecord(fsModule.readFileSync(lockPath, "utf8"));
  } catch {
    return {};
  }
};

// Stale-lock handling with a single winner. A lock older than kStaleLockMs
// whose holder is dead (or unknown) is broken by RENAMING it to a private
// claim path and unlinking that — two waiters cannot both "break" the same
// lock and both acquire (the old stat-then-unlink let the second waiter
// unlink the FIRST waiter's fresh lock). A live long-running holder is never
// broken; the waiter keeps waiting and times out honestly instead.
// Returns true when the caller should retry the acquire immediately.
const tryBreakStaleLock = (lockPath, fsModule) => {
  if (typeof fsModule.statSync !== "function") return false;
  let age;
  try {
    age = Date.now() - fsModule.statSync(lockPath).mtimeMs;
  } catch {
    return true; // lock vanished — retry the acquire
  }
  if (age <= kStaleLockMs) return false;
  const record = readLockRecord(lockPath, fsModule);
  if (record.pid && isHolderAlive(record, fsModule)) return false;
  if (typeof fsModule.renameSync !== "function") {
    try {
      fsModule.unlinkSync(lockPath);
    } catch {}
    return true;
  }
  const claimPath = `${lockPath}.stale.${process.pid}.${Date.now().toString(36)}`;
  try {
    fsModule.renameSync(lockPath, claimPath);
  } catch {
    return true; // another waiter claimed it — retry the acquire
  }
  try {
    fsModule.unlinkSync(claimPath);
  } catch {}
  return true;
};

const lockTimeoutError = (filePath, lockPath, fsModule) => {
  const record = readLockRecord(lockPath, fsModule);
  const holder = record.pid ? `pid ${record.pid}` : "an unknown holder";
  let ageNote = "";
  try {
    ageNote = ` for ${Math.round(Date.now() - fsModule.statSync(lockPath).mtimeMs)}ms`;
  } catch {}
  console.warn(
    `[safe-file] lock timeout on ${filePath}: held by ${holder}${ageNote}`,
  );
  const timeoutError = new Error(`Timed out waiting for lock on ${filePath}`);
  timeoutError.code = "ELOCKTIMEOUT";
  timeoutError.holderPid = record.pid || null;
  return timeoutError;
};

// Advisory lockfile (`<file>.lock`, O_EXCL) shared by the server and the CLI
// for the registry/config write paths, which are synchronous end-to-end.
// (The async variant was removed in the fix wave: it never had a production
// caller and duplicated this loop.)
const withFileLockSync = (
  filePath,
  fn,
  { fsModule = fs, timeoutMs = kDefaultLockTimeoutMs } = {},
) => {
  // Injected fsModule mocks without openSync can't lock; run unserialized.
  if (typeof fsModule.openSync !== "function") return fn();
  const lockPath = `${filePath}.lock`;
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fsModule.openSync(lockPath, "wx");
      try {
        fsModule.writeSync(fd, buildLockRecord(fsModule));
      } finally {
        fsModule.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (tryBreakStaleLock(lockPath, fsModule)) continue;
      if (Date.now() >= deadline) {
        throw lockTimeoutError(filePath, lockPath, fsModule);
      }
      sleepSync(kLockRetryDelayMs);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fsModule.unlinkSync(lockPath);
    } catch {}
  }
};

module.exports = {
  writeFileAtomic,
  withFileLockSync,
  kDefaultLockTimeoutMs,
  kStaleLockMs,
};
