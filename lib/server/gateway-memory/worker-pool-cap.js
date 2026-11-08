const fs = require("node:fs");
const path = require("node:path");

// OpenClaw before 2026.10.10 sizes two worker pools from os.availableParallelism():
// each session-transcript lane gets min(8, ceil((P-1)/2)) workers and the SQLite
// broker min(8, max(2, P/8)) carriers. The history and search lanes never
// idle-retire on an active box, so a 32-CPU host keeps ~20 extra V8 isolates
// whose heaps fill toward their 512 MiB caps for the life of the gateway.
// openclaw#169110 (in 2026.10.10) fixed both at 2. P=5 reproduces exactly that
// sizing, and only those two computations see it: every other caller (agent
// concurrency defaults, shared compute permits, pool defaults) keeps the real
// count. The pinned bundle keeps the sizing in worker-pool-sizing-*.mjs, which
// is how the callers are recognized; a bundle laid out differently is left as is.
const kFixedInVersion = [2026, 10, 10];
const kSizingParallelism = 5;
const kBrokerCaller = /^\s*at (?:[\w$]+\.)?resolveSqliteBrokerWorkerCount \(/;
const kComputeLimitCaller = /^\s*at (?:[\w$]+\.)?resolveWorkerComputeLimit \(/;
const kSizingModuleTopLevel = /^\s*at (?:file:\/\/)?\S*\/worker-pool-sizing-[^/\s]*\.m?js:\d+:\d+$/;

const readOpenclawVersion = (entry, fsModule = fs) => {
  let dir = path.dirname(fsModule.realpathSync(entry));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = JSON.parse(fsModule.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg?.name === "openclaw") return String(pkg.version || "");
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const sizesWorkerPoolsFromCpuCount = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== kFixedInVersion[i]) return parts[i] < kFixedInVersion[i];
  }
  return false;
};

const isPoolSizingCall = (stack) => {
  const frames = String(stack || "").split("\n").slice(2);
  if (kBrokerCaller.test(frames[0] || "")) return true;
  return kComputeLimitCaller.test(frames[0] || "") && kSizingModuleTopLevel.test(frames[1] || "");
};

const capLegacyWorkerPoolSizing = ({
  entry = process.argv[1],
  osModule = require("node:os"),
  syncBuiltinESMExports = require("node:module").syncBuiltinESMExports,
  fsModule = fs,
} = {}) => {
  const version = readOpenclawVersion(entry, fsModule);
  if (!sizesWorkerPoolsFromCpuCount(version)) return null;
  const original = osModule.availableParallelism;
  if (original() <= kSizingParallelism) return null;
  osModule.availableParallelism = function availableParallelism() {
    const count = original.call(this);
    if (count <= kSizingParallelism) return count;
    const limit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 4;
      const { stack } = new Error();
      return isPoolSizingCall(stack) ? kSizingParallelism : count;
    } catch {
      return count;
    } finally {
      Error.stackTraceLimit = limit;
    }
  };
  syncBuiltinESMExports();
  return { version, parallelism: kSizingParallelism };
};

module.exports = {
  capLegacyWorkerPoolSizing,
  isPoolSizingCall,
  kSizingParallelism,
  readOpenclawVersion,
  sizesWorkerPoolsFromCpuCount,
};
