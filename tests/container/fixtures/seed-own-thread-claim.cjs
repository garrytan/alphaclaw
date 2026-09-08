// Test-only preload, copied into the container B volume. It plants the RC1
// incident before AlphaClaw's real pidfile guard runs; /proc is never mocked.
const fs = require("node:fs");
const path = require("node:path");

const seedOwnThreadClaim = () => {
  if (process.argv[2] !== "start" || !process.argv[1]) return;
  let entrypoint;
  try { entrypoint = fs.realpathSync(process.argv[1]); } catch { return; }
  if (path.basename(entrypoint) !== "alphaclaw.js") return;

  const armedPath = path.join(__dirname, "armed.json");
  const claimedPath = path.join(__dirname, "claimed.json");
  // NODE_OPTIONS is inherited by child CLIs and container restarts. Exactly
  // one matching start process may seed the fixture; every later load is inert.
  try { fs.renameSync(armedPath, claimedPath); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const { claimAt } = JSON.parse(fs.readFileSync(claimedPath, "utf8"));
  if (!Number.isSafeInteger(claimAt) || claimAt <= 0 || claimAt >= Date.now()) {
    throw new Error("TID fixture requires an old legacy claim timestamp");
  }
  const serverPid = process.pid;
  const threadIds = fs.readdirSync("/proc/self/task")
    .map(Number)
    .filter((tid) => Number.isSafeInteger(tid) && tid > 0)
    .sort((a, b) => a - b);
  const threadId = threadIds.find((tid) => tid !== serverPid);
  if (!threadId) throw new Error("TID fixture requires a real nonleader Node thread");
  const status = fs.readFileSync(`/proc/self/task/${threadId}/status`, "utf8");
  const tgid = Number(status.match(/^Tgid:\s+(\d+)$/m)?.[1]);
  const observedTid = Number(status.match(/^Pid:\s+(\d+)$/m)?.[1]);
  if (tgid !== serverPid || observedTid !== threadId || threadId === serverPid) {
    throw new Error("TID fixture did not observe its own live nonleader thread");
  }
  process.kill(threadId, 0);
  const rootDir = process.env.ALPHACLAW_ROOT_DIR;
  if (!rootDir || !path.isAbsolute(rootDir)) throw new Error("TID fixture requires an absolute AlphaClaw root");
  const claimPath = path.join(rootDir, ".openclaw", ".alphaclaw", "alphaclaw-server.pid");
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });
  fs.writeFileSync(claimPath, JSON.stringify({ pid: threadId, at: claimAt }));
  fs.writeFileSync(path.join(__dirname, "witness.json"), JSON.stringify({
    serverPid, threadId, tgid, threadIds, claimAt, status,
  }, null, 2));
};

seedOwnThreadClaim();
