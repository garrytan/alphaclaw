const path = require("path");
const { execFile } = require("child_process");
const { kRootDir } = require("./constants");

// Runs `alphaclaw git-sync --json` for a server caller (issue #140): the
// dashboard Sync button goes through the same engine, writer lock and status
// file as the scheduled run instead of its own `add -A` / commit / push.
//
// The CLI is this package's own bin, run with the server's Node, so the
// engine version always matches the server. The CLI bounds its own work by
// its deadline (25 s for manual/caller triggers); the spawn timeout is only a
// backstop above that.
//
// The child's ALPHACLAW_ROOT_DIR is always the server's configured root, the
// same lexical path the scheduled cron line and the server's status readers
// use. Callers never pass a directory: when the state dir is a symlink, a
// realpath-derived root lands the status file and the writer lock in a second
// tree, so two writers could run at once.
const kBinPath = path.join(__dirname, "..", "..", "bin", "alphaclaw.js");
const kMaxMessageChars = 200;
const kSpawnTimeoutMs = 30_000;

// One line, bounded, and never parseable as a flag.
const normalizeSyncMessage = (message) => {
  const oneLine = String(message || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const safe = oneLine.startsWith("-") ? `sync: ${oneLine}` : oneLine;
  return safe.slice(0, kMaxMessageChars) || "sync changes";
};

const parseGitSyncResult = (stdout) => {
  const lines = String(stdout || "").trim().split("\n").reverse();
  for (const line of lines) {
    if (!line.startsWith('{"gitSync"')) continue;
    try {
      const parsed = JSON.parse(line).gitSync;
      if (parsed && typeof parsed === "object" && parsed.code) return parsed;
    } catch {}
  }
  return null;
};

const runGitSyncCli = ({
  message,
  file = "",
  trigger = "manual",
  rootDir = kRootDir,
  env = process.env,
  execFileImpl = execFile,
  timeoutMs = kSpawnTimeoutMs,
}) =>
  new Promise((resolve) => {
    execFileImpl(
      process.execPath,
      [
        kBinPath,
        "git-sync",
        "--json",
        "--trigger",
        trigger,
        "-m",
        normalizeSyncMessage(message),
        ...(file ? ["-f", file] : []),
      ],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: { ...env, ALPHACLAW_ROOT_DIR: rootDir },
      },
      (error, stdout, stderr) => {
        const parsed = parseGitSyncResult(stdout);
        if (parsed) return resolve(parsed);
        const tail = String(stderr || error?.message || "").trim().split("\n").slice(-1)[0] || "";
        resolve({
          outcome: "failed",
          code: error?.killed ? "deadline_exceeded" : "failed",
          message: error?.killed
            ? "Git sync did not finish in time; the next scheduled sync retries"
            : `Git sync failed${tail ? `: ${tail.replace(/^\[alphaclaw\]\s*/, "").slice(0, 300)}` : ""}`,
          committed: false,
          pushed: false,
          shortHash: "",
          paths: [],
        });
      },
    );
  });

// Routes that save settings and then back them up (models, telegram,
// webhooks) report a sync problem as a `syncWarning` sentence beside their
// own success. A busy writer lock or a spent deadline only defers the push:
// the scheduled sync picks the commit up.
const kDeferredCodes = new Set(["lock_timeout", "deadline_exceeded"]);
const describeCallerSyncWarning = (result) => {
  if (!result || result.outcome === "ok" || result.outcome === "disabled") return null;
  if (kDeferredCodes.has(result.code)) {
    return "Backup push deferred: another git writer was busy or the sync ran out of time; the next scheduled sync pushes it";
  }
  return result.message || "Git sync failed";
};

const createCallerGitSync = ({ runGitSync = runGitSyncCli } = {}) =>
  async ({ message, file = "" }) =>
    describeCallerSyncWarning(await runGitSync({ message, file, trigger: "caller" }));

module.exports = {
  runGitSyncCli,
  normalizeSyncMessage,
  parseGitSyncResult,
  describeCallerSyncWarning,
  createCallerGitSync,
};
