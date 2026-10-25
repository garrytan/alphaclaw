// The one owner of `openclaw doctor --lint --json` (ALPH-36).
//
// A full lint copies every SQLite database it checks into OpenClaw's cache
// (on 2026.10.7: the agent database four times; 39 s for 2.5 GB on a fast
// disk). A lint stopped mid-copy leaves the partial copy behind: during one
// of its copy phases no signal lets OpenClaw remove it (SIGTERM, SIGINT and
// SIGHUP, to the process or its group, all left 1.1-1.7 GB). So:
//   - a full lint's ceiling follows the state it copies (the Doctor budget,
//     150 s per GiB, floored at the old 60 s), so it is not killed mid-copy;
//   - full lints are single-flight across every caller, and a settled one is
//     reused for kDoctorLintCooldownMs (kDoctorLintTimeoutCooldownMs after a
//     timeout), so callers never stack multi-GB copies;
//   - `only` runs (`--only <checkId>`, repeatable) are for callers that need a
//     few checks; the checks AlphaClaw selects copy no agent database, so they
//     keep the fixed floor, run single-flight per check set and are not reused;
//   - a run that still times out is stopped with SIGTERM to its group (SIGKILL
//     after the run stream's grace), and only after it has exited are the
//     snapshot copies it left removed (trackSnapshotCopiesOfRun).
const kFullLintKey = "full";

const createDoctorLintRunner = ({
  runStreamed,
  getEnv,
  resolveTimeoutMs,
  trackSnapshotCopies,
  classify,
  recordAvailability = () => {},
  timeoutFloorMs,
  captureBytes,
  cooldownMs,
  timeoutCooldownMs,
  nowMs = Date.now,
  logger = console,
}) => {
  const inFlight = new Map();
  let lastFull = null;

  const spawnLint = async (checks) => {
    const env = getEnv();
    const timeoutMs = checks.length > 0 ? timeoutFloorMs : resolveTimeoutMs(timeoutFloorMs);
    const label = checks.length > 0 ? `doctor --lint --only ${checks.join(",")}` : "doctor --lint";
    const copies = trackSnapshotCopies({ env, trigger: "doctor-lint-timeout" });
    const startedAtMs = nowMs();
    let result;
    try {
      result = await runStreamed({
        command: "openclaw",
        args: ["doctor", "--lint", "--json", ...checks.flatMap((checkId) => ["--only", checkId])],
        env,
        timeoutMs,
        tailBytes: captureBytes,
      });
    } catch (error) {
      const classification = {
        status: "unavailable",
        reason: "spawn_failed",
        detail: String(error?.message || error).slice(0, 300),
      };
      recordAvailability(classification);
      return { ok: false, code: null, stdout: "", truncated: false, timedOut: false, classification, startedAtMs, spawned: false };
    }
    const elapsedS = Math.round((nowMs() - startedAtMs) / 1000);
    if (result.timedOut) {
      logger.warn?.(
        `[alphaclaw] ${label} timed out after ${Math.round(timeoutMs / 1000)}s and was stopped; removing the snapshot copies it left once it has exited`,
      );
      copies.sweepAfterKill();
    } else if (checks.length === 0) {
      logger.log?.(`[alphaclaw] ${label} finished in ${elapsedS}s (ceiling ${Math.round(timeoutMs / 1000)}s)`);
    }
    const shaped = {
      ok: !!result.ok,
      code: result.code,
      stdout: result.tail || "",
      timedOut: !!result.timedOut,
      truncated: Buffer.byteLength(result.tail || "", "utf8") >= captureBytes,
      error: result.error || null,
    };
    const classification = classify(shaped);
    recordAvailability(classification);
    return { ...shaped, classification, startedAtMs, timeoutMs, spawned: true };
  };

  const run = ({ only = [] } = {}) => {
    const checks = [...new Set(only.map(String))].sort();
    const key = checks.length > 0 ? checks.join(" ") : kFullLintKey;
    if (inFlight.has(key)) return inFlight.get(key);
    if (key === kFullLintKey && lastFull) {
      const holdMs = lastFull.result.timedOut ? timeoutCooldownMs : cooldownMs;
      if (nowMs() - lastFull.settledAtMs < holdMs) return Promise.resolve({ ...lastFull.result, reused: true });
    }
    const job = spawnLint(checks)
      .then((result) => {
        if (key === kFullLintKey && result.spawned) lastFull = { result, settledAtMs: nowMs() };
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };

  return { run };
};

module.exports = { createDoctorLintRunner };
