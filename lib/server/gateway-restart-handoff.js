// Verified restart-handoff consume for externally supervised gateways
// (OpenClaw 2026.8.1-beta.1+). When OPENCLAW_SUPERVISOR_MODE=external is set,
// a gateway that wants a restart — INCLUDING restarts AlphaClaw did not
// initiate (config-write restarts, /restart command, SIGUSR1, plugin changes)
// — persists a 60s-TTL SQLite handoff row and exits 0, deferring the relaunch
// to its supervisor. The supervisor consumes the row via the hidden CLI
// `openclaw gateway restart-handoff consume --expected-pid <pid> --json`
// (verified in openclaw@2026.8.1-beta.3 dist/gateway-cli-*.js +
// dist/restart-handoff-*.js): stdout carries {ok:true, protocol:
// "openclaw.gateway.restart-handoff", protocolVersion:1, status:
// "accepted"|"none"|"rejected", reason?, handoff?:{pid, source, reason,
// restartKind, supervisorMode, ...}} and the exit code is 0 even for
// none/rejected (1 = store-unavailable, 2 = invalid-expected-pid). Full
// contract: docs/designs/openclaw-context-contract.md (lifecycle appendix).
//
// The consume is DESTRUCTIVE — the row is deleted on accept — so results are
// cached per PID and every caller (watchdog exit handler, managed lifecycle
// paths) shares the one consume: whichever caller runs first owns the CLI
// invocation, the rest read the cached result. A PID is never consumed twice
// within the protocol TTL.
const { parseJsonValueFromNoisyOutput } = require("./utils/json");

const kRestartHandoffConsumeTimeoutMs = 5 * 1000;
// Small bound on remembered PIDs: one gateway generation is live at a time,
// so a handful of entries covers any realistic exit/relaunch churn.
const kRestartHandoffCacheMaxEntries = 8;
// Cached results expire with the upstream row TTL (60s): a recycled PID from
// a much later gateway generation must trigger a fresh consume, not replay a
// stale verdict.
const kRestartHandoffCacheTtlMs = 60 * 1000;
const kRestartHandoffProtocol = "openclaw.gateway.restart-handoff";
const kRestartHandoffStatuses = new Set(["accepted", "none", "rejected"]);

// pid -> { promise, result, createdAt }
const consumeCache = new Map();

const kErrorResult = Object.freeze({ status: "error", reason: null, handoff: null });

// The CLI can interleave log noise (deprecation warnings, plugin chatter)
// with the JSON payload — the shared noisy-output scanner skips
// valid-but-wrong JSON in the noise via the protocol-marker predicate.
const parseConsumeStdout = (stdout) => {
  const parsed = parseJsonValueFromNoisyOutput(stdout, {
    validate: (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.protocol === kRestartHandoffProtocol,
  });
  return parsed && kRestartHandoffStatuses.has(parsed.status) ? parsed : null;
};

const runConsume = async ({ clawCmd, pid, timeoutMs }) => {
  try {
    const result = await clawCmd(
      `gateway restart-handoff consume --expected-pid ${pid} --json`,
      { quiet: true, timeoutMs },
    );
    // Exit 0 covers accepted/none/rejected; a non-ok result (store
    // unavailable, invalid pid, timeout, missing CLI) is an error — the
    // caller falls back to its normal exit classification.
    const parsed = result?.ok ? parseConsumeStdout(result.stdout) : null;
    if (!parsed) return kErrorResult;
    return {
      status: parsed.status,
      reason: parsed.reason ?? null,
      handoff:
        parsed.handoff && typeof parsed.handoff === "object"
          ? parsed.handoff
          : null,
    };
  } catch {
    return kErrorResult;
  }
};

const consumeRestartHandoff = async ({
  clawCmd,
  pid,
  timeoutMs = kRestartHandoffConsumeTimeoutMs,
} = {}) => {
  const safePid = Number(pid);
  if (
    typeof clawCmd !== "function" ||
    !Number.isSafeInteger(safePid) ||
    safePid <= 0
  ) {
    return kErrorResult;
  }
  const cached = consumeCache.get(safePid);
  if (cached && Date.now() - cached.createdAt <= kRestartHandoffCacheTtlMs) {
    return cached.promise;
  }
  const entry = { promise: null, result: null, createdAt: Date.now() };
  entry.promise = runConsume({ clawCmd, pid: safePid, timeoutMs }).then(
    (result) => {
      entry.result = result;
      return result;
    },
  );
  consumeCache.set(safePid, entry);
  while (consumeCache.size > kRestartHandoffCacheMaxEntries) {
    consumeCache.delete(consumeCache.keys().next().value);
  }
  return entry.promise;
};

// Non-consuming cache read for diagnostic call sites (managed restart paths):
// returns the settled result for a PID, or null when nothing was consumed
// (never spawns the CLI).
const peekRestartHandoff = (pid) => {
  const cached = consumeCache.get(Number(pid));
  if (!cached || Date.now() - cached.createdAt > kRestartHandoffCacheTtlMs) {
    return null;
  }
  return cached.result;
};

module.exports = {
  consumeRestartHandoff,
  peekRestartHandoff,
};
