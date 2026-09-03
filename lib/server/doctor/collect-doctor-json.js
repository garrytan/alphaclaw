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
//   - Known accepted nuance (documented, deferred): a joiner may receive
//     results from a spawn started before its trigger; no freshness barrier
//     in v1.
const createDoctorJsonCollector = ({
  runLintJson,
  classify,
  availability = null,
  source = "collector",
} = {}) => {
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

  const collect = async ({ timeoutMs = null } = {}) => {
    if (!inFlight) {
      inFlight = runOnce().finally(() => {
        inFlight = null;
      });
    }
    const shared = inFlight;
    if (!Number.isFinite(timeoutMs) || timeoutMs === null) {
      return (await shared).stdout;
    }
    // Personal budget race: the caller proceeds without a doctor hint; the
    // shared spawn keeps running for longer-budget joiners and still feeds
    // the availability tracker on settle.
    let timer = null;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ stdout: null }), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      const winner = await Promise.race([shared, expired]);
      return winner.stdout;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return { collect };
};

module.exports = { createDoctorJsonCollector };
