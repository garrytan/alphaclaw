const fs = require("fs");
const path = require("path");

const kDefaultLockTimeoutMs = 5000;
const kLockRetryDelayMs = 50;
const kStaleLockMs = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Write via temp file + rename so readers never observe a torn file.
// Injected fsModule mocks that lack renameSync fall back to a plain write.
const writeFileAtomic = (filePath, content, { fsModule = fs } = {}) => {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  if (typeof fsModule.renameSync !== "function") {
    fsModule.writeFileSync(filePath, content);
    return filePath;
  }
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fsModule.writeFileSync(tempPath, content);
  try {
    fsModule.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fsModule.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
  return filePath;
};

// Advisory lockfile (`<file>.lock`, O_EXCL) shared by the server and the CLI.
// A lock older than kStaleLockMs is treated as abandoned and broken.
const withFileLock = async (
  filePath,
  fn,
  { fsModule = fs, timeoutMs = kDefaultLockTimeoutMs } = {},
) => {
  const lockPath = `${filePath}.lock`;
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fsModule.openSync(lockPath, "wx");
      try {
        fsModule.writeSync(fd, String(process.pid));
      } finally {
        fsModule.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fsModule.statSync(lockPath).mtimeMs;
        if (age > kStaleLockMs) {
          fsModule.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        const timeoutError = new Error(
          `Timed out waiting for lock on ${filePath}`,
        );
        timeoutError.code = "ELOCKTIMEOUT";
        throw timeoutError;
      }
      await sleep(kLockRetryDelayMs);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fsModule.unlinkSync(lockPath);
    } catch {}
  }
};

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Sync variant for the registry/config write paths, which are synchronous
// end-to-end (server routes and the CLI). Same lockfile protocol as
// withFileLock, so sync and async holders exclude each other.
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
        fsModule.writeSync(fd, String(process.pid));
      } finally {
        fsModule.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fsModule.statSync(lockPath).mtimeMs;
        if (age > kStaleLockMs) {
          fsModule.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        const timeoutError = new Error(
          `Timed out waiting for lock on ${filePath}`,
        );
        timeoutError.code = "ELOCKTIMEOUT";
        throw timeoutError;
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
  withFileLock,
  withFileLockSync,
};
