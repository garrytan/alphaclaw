const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

// Immutable installs are shared across test processes and runs. Only the
// lock owner may publish or replace an invalid entry; consumers never see
// partial trees. Staging is on the cache filesystem, so publication is atomic.
const verified = new Map();
const pending = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = (dir) => {
  try {
    const stat = fs.statSync(dir);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
  } catch { return null; }
};
const ownerAlive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};

// A per-version SQLite transaction is a kernel-backed cross-process lock.
// Process death releases it automatically; unlike stale mkdir locks, recovery
// cannot mistake a newly acquired owner for the dead predecessor. Keep this
// small lock file permanently: unlinking a held file would split ownership.
const acquire = async (lockPath, { timeoutMs, pollMs }) => {
  const db = new DatabaseSync(lockPath);
  const started = Date.now();
  let held = false;
  try {
    db.exec("PRAGMA busy_timeout = 0");
    for (;;) {
      try {
        db.exec("BEGIN EXCLUSIVE");
        held = true;
        return {
          owns: () => held,
          release: () => {
            if (!held) return;
            held = false;
            try { db.exec("ROLLBACK"); } finally { db.close(); }
          },
        };
      } catch (error) {
        if (!/database (?:is )?(?:locked|busy)/i.test(error.message)) throw error;
        if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for install cache ownership: ${lockPath}`);
        await sleep(pollMs);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
};

const populateImmutableCache = ({ cacheRoot, key, validate, populate, timeoutMs = 10 * 60_000, pollMs = 100 }) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(key)) throw new Error("Invalid install cache key");
  const cacheDir = path.resolve(cacheRoot, key);
  if (pending.has(cacheDir)) return pending.get(cacheDir);
  const task = (async () => {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const lockRoot = path.join(cacheRoot, ".locks");
    fs.mkdirSync(lockRoot, { recursive: true });
    const hold = await acquire(path.join(lockRoot, `${key}.sqlite`), { timeoutMs, pollMs });
    let staging;
    try {
      const signature = identity(cacheDir);
      if (signature && (verified.get(cacheDir) === signature || await validate(cacheDir))) {
        verified.set(cacheDir, signature);
        return { cacheDir, fromCache: true };
      }
      // An interrupted population is never a completed entry. Remove only
      // this key's old staging trees, while holding exclusive ownership.
      for (const entry of fs.readdirSync(cacheRoot)) {
        const prefix = `.${key}-staging-`;
        if (!entry.startsWith(prefix)) continue;
        const pid = Number(entry.slice(prefix.length).split("-")[0]);
        if (Number.isInteger(pid) && !ownerAlive(pid)) fs.rmSync(path.join(cacheRoot, entry), { recursive: true, force: true });
      }
      staging = fs.mkdtempSync(path.join(cacheRoot, `.${key}-staging-${process.pid}-`));
      await populate(staging);
      if (!await validate(staging)) throw new Error(`Staged install ${key} failed verification`);
      if (!hold.owns()) throw new Error(`Install cache ownership expired before publishing ${key}`);
      if (signature) fs.rmSync(cacheDir, { recursive: true, force: true });
      try {
        fs.renameSync(staging, cacheDir);
      } catch (error) {
        // Never copy into, remove, or overwrite another publisher's winner.
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !await validate(cacheDir)) throw error;
        verified.set(cacheDir, identity(cacheDir));
        return { cacheDir, fromCache: true };
      }
      staging = null;
      verified.set(cacheDir, identity(cacheDir));
      return { cacheDir, fromCache: false };
    } finally {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
      hold.release();
    }
  })();
  pending.set(cacheDir, task);
  task.finally(() => pending.delete(cacheDir)).catch(() => {});
  return task;
};

module.exports = { populateImmutableCache };
