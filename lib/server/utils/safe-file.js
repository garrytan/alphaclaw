const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseProcStat } = require("../openclaw-lock-contention");

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
//   fails: temp     fails: temp        fails: temp           best-effort —
//   unlinked, throw unlinked, throw    unlinked, throw       data is already
//   (target intact) (target intact)    (target intact)       installed
//
// The temp file is always created exclusively ("wx"), and `created` records
// whether this call made it, so a failure unlinks only a temp file this call
// created. Content that is not a string or Buffer is refused before any temp
// name is tried: `writeFileSync` would throw it before its open, with no
// `syscall`, and that error must not read as a failed write of our own file.
// After that, `writeFileSync` either fails to open (`syscall: "open"`, nothing
// created) or fails after the open (ENOSPC part way), leaving a partial temp
// file of ours that is unlinked before the write's error is rethrown, and
// an existing file at the temp path (EEXIST: another writer's, or a leftover
// from an earlier process with the same pid, common in containers) is never
// written or unlinked: the write moves on to a randomized name, up to five
// times, then throws the EEXIST.
//
// The directory fsync comes AFTER the rename: it is the rename (the directory
// entry) that needs to reach disk. Readers never observe a torn file because
// the rename is atomic; `durable: false` skips both fsyncs for hot writers
// whose loss on power failure is acceptable. Injected fsModule mocks without
// openSync/fsyncSync simply skip the fsyncs; mocks without renameSync fall
// back to a plain write.
//
// Permissions: the rename installs the temp file's inode, so the temp file
// carries the final mode. An explicit `mode` wins. Without one, a replace
// keeps the target's permission bits (read through a symlink, the way the
// target's own stat sees them), and only a new file gets the umask default,
// so a 0600 file never comes back 0644 because a caller named no mode
// (GST-2299). A stat that fails for any reason but ENOENT fails the write
// before anything is created. The bits are set with chmod on the temp file
// after it is written, so the umask can neither loosen nor strip them. As
// root, a replace also gives the temp file the target's owner and group
// before the rename, so a file another account owns does not become root's;
// the chown is best-effort (a root-squashed mount refuses it and the file is
// still written). With a mode named, the temp file is created exclusively
// ("wx") on a randomized suffix, so the mode lands on a provably FRESH inode
// and the rename installs it even over a looser existing file
// (unlink-then-write would not guarantee a fresh inode against a racing
// symlink). Caveat: the no-renameSync fallback writes in place, where a mode
// cannot tighten an existing inode; that branch only serves mock fs.
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

const statExistingTarget = (fsModule, filePath) => {
  if (typeof fsModule.statSync !== "function") return null;
  try {
    const stats = fsModule.statSync(filePath);
    return typeof stats?.mode === "number" ? stats : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const isRunningAsRoot = () =>
  typeof process.geteuid === "function" && process.geteuid() === 0;

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
  if (typeof content !== "string" && !ArrayBuffer.isView(content)) {
    throw Object.assign(
      new TypeError(
        'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.',
      ),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  }
  const existing = statExistingTarget(fsModule, filePath);
  const finalMode = mode ?? (existing ? existing.mode & 0o7777 : undefined);
  let tempPath;
  let created = false;
  const discardTemp = () => {
    if (!created) return;
    try {
      fsModule.unlinkSync(tempPath);
    } catch {}
  };
  for (let attempt = 0; ; attempt += 1) {
    tempPath =
      mode === undefined && attempt === 0
        ? `${filePath}.${process.pid}.tmp`
        : `${filePath}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fsModule.writeFileSync(
        tempPath,
        content,
        mode === undefined ? { flag: "wx" } : { mode, flag: "wx" },
      );
      created = true;
      break;
    } catch (error) {
      if (error?.code === "EEXIST") {
        if (attempt < 5) continue;
        throw error;
      }
      created = error?.syscall !== "open";
      discardTemp();
      throw error;
    }
  }
  try {
    if (existing && isRunningAsRoot() && typeof fsModule.chownSync === "function") {
      try {
        fsModule.chownSync(tempPath, existing.uid, existing.gid);
      } catch {}
    }
    if (finalMode !== undefined && typeof fsModule.chmodSync === "function") {
      fsModule.chmodSync(tempPath, finalMode);
    }
    if (durable) fsyncPathSync(fsModule, tempPath);
  } catch (error) {
    discardTemp();
    throw error;
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

// writeFileAtomic for generated files: when the file already holds exactly
// these bytes nothing is written (no temp file, no rename), so its inode and
// mtime stay and a repository AlphaClaw does not sync sees no change. Returns
// whether it wrote.
const writeFileAtomicIfChanged = (filePath, content, options = {}) => {
  const fsModule = options.fsModule || fs;
  try {
    const current = fsModule.readFileSync(filePath);
    if (Buffer.from(current).equals(Buffer.from(content))) return false;
  } catch {}
  writeFileAtomic(filePath, content, options);
  return true;
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
    return parseProcStat(fsModule.readFileSync(`/proc/${pid}/stat`, "utf8"))?.startTicks ?? null;
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
  writeFileAtomicIfChanged,
  withFileLockSync,
  readProcStartTicks,
  kDefaultLockTimeoutMs,
  kStaleLockMs,
};
