// ONE process-wide, single-flight collector for advisory/evidence doctor
// output. Replaces four independent spawners (medic, watchdog overseer,
// watchdog advisory probe, upgrade overseer) that each ran `doctor --json`
// and, on failure, handed raw stderr to LLM prompts as if it were doctor
// output — the 2026-09-01 incident's red-herring machine.
//
// Contract:
//   - Runs THE verified cross-version invocation (`doctor --lint --json` via
//     the injected runLintJson — bare `--json` is NOT lint mode on the pinned
//     stable and would classify every stable run as broken).
//   - Returns stdout ONLY when the classification is usable ("findings" or
//     the stable's "legacy" shape); otherwise null. NEVER stderr.
//   - Single-flight: concurrent callers coalesce onto one in-flight spawn
//     (out-of-order availability transitions and doctor pile-ups were real
//     review findings). The underlying spawn always runs at the runner's own
//     full budget; each caller races its OWN `timeoutMs` and gets null on
//     personal expiry while the spawn completes and still records
//     availability. (A running child's timeout cannot be enlarged
//     retroactively — so the spawn starts at max budget by construction.)
//   - Freshness: the collector itself has NO freshness barrier — a joiner may
//     receive results from a spawn started before its trigger. Callers that
//     must not attach stale evidence use `collectWithMeta()`, which returns
//     `{ stdout, spawnStartedAtMs }` so they can compare the spawn's start
//     against their own trigger time (the watchdog readiness advisory drops
//     older spawns as `stale_doctor_job`, #87 Y4). `collect()` keeps the
//     plain-string contract for the medic/overseer callers.
//   - Budget expiry is flagged: a caller whose personal `timeoutMs` ran out
//     gets `{ stdout: null, spawnStartedAtMs, budgetExpired: true }` (#87
//     F8) — the spawn it joined is STILL running, so re-calling would only
//     re-join it and wait the budget out again (the watchdog's
//     stale_doctor_job retry skips it as `unusable`). The flag is absent on
//     every settled result.
const createDoctorJsonCollector = ({
  runLintJson,
  classify,
  availability = null,
  source = "collector",
  // Injectable clock: `spawnStartedAtMs` is stamped from this when a spawn
  // is created (tests pin it; production uses the wall clock).
  nowMs = Date.now,
} = {}) => {
  // { promise, spawnStartedAtMs } while a spawn is running; null otherwise.
  let inFlight = null;

  const runOnce = async () => {
    let result;
    try {
      result = await runLintJson();
    } catch (error) {
      const classification = {
        status: "unavailable",
        reason: "spawn_failed",
        detail: String(error?.message || error).slice(0, 300),
      };
      availability?.record(classification, { source });
      return { classification, stdout: null };
    }
    const classification = classify(result);
    availability?.record(classification, { source });
    const usable = classification.status === "usable";
    return { classification, stdout: usable ? result.stdout || null : null };
  };

  // Starts a spawn when none is in flight, otherwise joins the running one.
  // Resolves { stdout, spawnStartedAtMs } — stdout null on classification
  // failure OR on personal-budget expiry (then also `budgetExpired: true`);
  // spawnStartedAtMs always describes the spawn this caller was attached to.
  const collectWithMeta = async ({ timeoutMs = null } = {}) => {
    if (!inFlight) {
      const job = { spawnStartedAtMs: nowMs(), promise: null };
      job.promise = runOnce().finally(() => {
        if (inFlight === job) inFlight = null;
      });
      inFlight = job;
    }
    const { promise: shared, spawnStartedAtMs } = inFlight;
    if (!Number.isFinite(timeoutMs) || timeoutMs === null) {
      return { stdout: (await shared).stdout, spawnStartedAtMs };
    }
    // Personal budget race: the caller proceeds without a doctor hint; the
    // shared spawn keeps running for longer-budget joiners and still feeds
    // the availability tracker on settle.
    let timer = null;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ stdout: null, budgetExpired: true }), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      const winner = await Promise.race([shared, expired]);
      return {
        stdout: winner.stdout,
        spawnStartedAtMs,
        ...(winner.budgetExpired ? { budgetExpired: true } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // String contract (unchanged): usable stdout or null.
  const collect = async (options = {}) =>
    (await collectWithMeta(options)).stdout;

  return { collect, collectWithMeta };
};

module.exports = { createDoctorJsonCollector };
