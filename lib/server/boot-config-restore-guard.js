const fs = require("node:fs");
const path = require("node:path");
const { readDirectoryNamesBounded } = require("./utils/bounded-directory");

const kMaxAuthorityFileBytes = 1024 * 1024;
const kMaxAuthorityBytes = 8 * 1024 * 1024;
const kMaxRunEntries = 256;

const assessBootConfigRestore = ({ openclawDir, fsModule = fs, now = Date.now }) => {
  const deadline = now() + 1000;
  let totalBytes = 0;
  const readRecord = (file, { missingAllowed = false } = {}) => {
    if (now() >= deadline) throw new Error("authority deadline");
    let fd;
    try {
      fd = fsModule.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (missingAllowed && error.code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = fsModule.fstatSync(fd);
      totalBytes += stat.size;
      if (!stat.isFile() || stat.size > kMaxAuthorityFileBytes || totalBytes > kMaxAuthorityBytes) throw new Error("authority size");
      const bytes = Buffer.alloc(stat.size + 1);
      const length = fsModule.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fsModule.fstatSync(fd);
      const current = fsModule.lstatSync(file);
      if (length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs ||
          !current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size ||
          current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs || now() >= deadline) throw new Error("authority changed");
      const record = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid authority");
      return record;
    } finally {
      fsModule.closeSync(fd);
    }
  };
  try {
    const managed = path.join(openclawDir, ".alphaclaw");
    const state = readRecord(path.join(managed, "openclaw-channel-state.json"), { missingAllowed: true });
    if (state?.corrupted) throw new Error("corrupt authority");
    if (state?.gatewayHold || state?.recoveryReview || state?.lastUpdateRun?.state === "restart_expected") {
      return { allowed: false, reason: "recovery_pending" };
    }
    let names;
    const runs = path.join(managed, "runs");
    try {
      const stat = fsModule.lstatSync(runs);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid runs directory");
      names = readDirectoryNamesBounded(runs, { fsModule, maxEntries: kMaxRunEntries });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const run = readRecord(path.join(runs, name));
      if (typeof run.state !== "string") throw new Error("unknown run state");
      if (run.recoveryReview?.active || (["running", "restart_expected"].includes(run.state) && run.recoveryIntent?.approved)) {
        return { allowed: false, reason: "recovery_pending" };
      }
    }
    if (now() >= deadline) throw new Error("authority deadline");
    return { allowed: true, reason: "unprotected" };
  } catch {
    return { allowed: false, reason: "recovery_authority_unverified" };
  }
};

module.exports = { assessBootConfigRestore };
