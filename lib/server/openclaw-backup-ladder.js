// Pre-update backup ladder policy (issues #54 / #79; Eng review 2C).
//
// The tables and the pure arithmetic the backup driver (`runBackup` in
// openclaw-channel-sync.js) decides by, in one module so the driver, the
// routes and the tests read ONE copy. Nothing here reads the clock, touches
// the filesystem or spawns a process: every function takes its inputs and
// answers, which is what lets the tests pin the policy as data.
//
//   kQuiescedOutcomePolicy   what the QUIESCED driver does per failure kind
//                            of an in-quiesce upstream `backup create`
//   kLiveRetryPolicy         live-ladder retries per kind (the attempt cap
//                            and the envelope still win)
//   kReuseEligibleKinds      kinds after which consented reuse may be offered
//   contentionRetryVerdict   budget-aware in-quiesce retry math
//   chooseBackupRung         the post-copy fallback: in-quiesce upstream or
//                            hand over to the live ladder
//   predictTransferMs        Codex 16 prediction: bytes / rate + files × cost
//   kDefaultBackupBudget     the constants as the driver's budget table
//   backupBudgetPins         the two envelope relations (Codex 16), evaluated
//                            over a budget table (defaults or effective)
//
// openclaw-channel-sync.js re-exports every name so existing imports keep
// working; new consumers should require this module directly.
const {
  kOpenclawBackupPhaseEnvelopeMs,
  kOpenclawBackupLiveAttempts,
  kOpenclawBackupRetryDelayMs,
  kOpenclawBackupQuiesceTimeoutMs,
  kOpenclawBackupQuiesceStopTimeoutMs,
  kOpenclawBackupQuiesceLockTimeoutMs,
  kOpenclawBackupTimeoutMs,
  kOpenclawBackupContentionRetries,
  kOpenclawBackupContentionBackoffBaseMs,
  kOpenclawBackupPostQuiesceReadyTimeoutMs,
  kOpenclawBackupPostQuiescePollMs,
  kOpenclawBackupPostQuiesceSettleMs,
  kOpenclawBackupOfflineCopyBudgetMs,
  kOpenclawBackupDiagnosisBudgetMs,
  kOpenclawBackupUpstreamMaxBytes,
  kOpenclawBackupDefaultCopyBytesPerSec,
  kOpenclawBackupDefaultUpstreamBytesPerSec,
  kOpenclawBackupPerFileOverheadMs,
  kOpenclawStateDbQuietSlackMs,
  kOpenclawBackupReuseVerifyTimeoutMs,
  kOpenclawBackupUsableCheckReserveMs,
  kOpenclawBackupQuiesceLeaseReserveMs,
  kOpenclawBackupStaleTempDirSlackMs,
  kOpenclawBackupProgressIntervalMs,
  kOpenclawBackupRollbackJournalSelfDeadlockBytes,
  kOpenclawBackupExclusivitySettleMs,
  kOpenclawBackupExclusivitySettlePollMs,
} = require("./constants");

// What the quiesced driver does with each classified failure kind of an
// in-quiesce upstream attempt. `retry` is the budget-aware in-quiesce retry
// (contentionRetryVerdict); `offline_copy` hands over to the AlphaClaw copy
// of the still-paused state; `fallback` relaunches the gateway and hands over
// to the live ladder; `workspace_retry` runs the one-shot
// --no-include-workspace attempt LIVE; everything else is terminal.
//
// `timeout` → `offline_copy` (issue #79; it was `fallback`): an upstream
// attempt that outlives the pause budget is a SPEED verdict on this box, not
// a race. The old fallback relaunched the gateway and replayed the same CLI
// live for another full ceiling, against a gateway writing again. The copy
// is the rung built to fit when the upstream did not (sqlite backup() per DB,
// policy excludes, `gzip -1`, its own budget), and it runs inside the same
// pause; a copy that itself fails at a non-exclusivity stage still hands
// over to the live ladder, so the slow box is never locked out. In the
// copy-first ladder (Stage 4c) this row governs the upstream attempt that
// runs AFTER a failed copy when chooseBackupRung said it fits.
// `vanished_file` stays `fallback`: an exogenous writer raced even the paused
// gateway, and the copy's exclusivity gate would refuse the same writer.
const kQuiescedOutcomePolicy = Object.freeze({
  lock_contention: "retry",
  killed: "offline_copy",
  timeout: "offline_copy",
  vanished_file: "fallback",
  workspace_discovery: "workspace_retry",
  default: "terminal",
});

// Live-ladder retries per kind. The per-kind count is the INTENT; the total
// is still capped by kDefaultBackupBudget.liveAttempts (2 since #79 (f) —
// see the honest-envelope relation below) and by the phase envelope, so
// vanished_file's second retry is reachable only under a tuning override
// that raises the cap. Delays are the budget knobs backupBudget carries
// (retryDelayMs / contentionBackoffBaseMs) so tests can shrink them; the
// values here document production.
const kLiveRetryPolicy = Object.freeze({
  vanished_file: Object.freeze({ retries: 2, delayMs: kOpenclawBackupRetryDelayMs }),
  lock_contention: Object.freeze({
    retries: 1,
    delayMs: kOpenclawBackupContentionBackoffBaseMs,
  }),
  killed: Object.freeze({ retries: 1, delayMs: kOpenclawBackupContentionBackoffBaseMs }),
});

// Failure kinds after which the consented-reuse gate (WI-4.5) may offer a
// verified earlier archive: the transient/retryable classes the LIVE ladder
// (the last fresh rung) can end on, plus the envelope running out before it
// could. Never a broken CLI, a full disk, a verify failure, a phantom
// artifact, or a spawn error — reusing an old backup would paper over a
// box-level problem the operator must fix. `offline_copy_refused` is NOT
// here: since copy-first (Stage 4c) a refused copy hands over to the live
// ladder instead of ending the ladder, so it never reaches the reuse gate on
// its own — AGENTS.md invariant (5) offers reuse only after the FULL fresh
// ladder failed.
const kReuseEligibleKinds = Object.freeze([
  "lock_contention",
  "killed",
  "timeout",
  "vanished_file",
  "window_exhausted",
]);

// The retry must fit: attempt (bounded by how long the failed one took),
// backoff, and a reserve for the offline copy/relaunch that follows.
const kContentionRetryReserveMs = 30 * 1000;
const kContentionRetryMaxAttemptShare = 0.5;
const contentionRetryVerdict = ({
  failedMs,
  backoffMs,
  remainingMs,
  budgetMs,
  retries,
  maxRetries = kOpenclawBackupContentionRetries,
}) => {
  if (retries >= maxRetries) return { retry: false, reason: "retries_exhausted" };
  if (failedMs >= budgetMs * kContentionRetryMaxAttemptShare) {
    return { retry: false, reason: "attempt_too_long" };
  }
  if (remainingMs < failedMs + backoffMs + kContentionRetryReserveMs) {
    return { retry: false, reason: "insufficient_budget" };
  }
  return { retry: true, reason: null };
};

// Codex 16: a rung's predicted wall time is bytes / rate + files × per-file
// overhead. `null` when there is nothing honest to say (unknown bytes, no
// rate) — a caller must treat null as "unknown", never as 0. Rates are
// calibrated from prior runs of the SAME rung and default to the constants.
const predictTransferMs = ({
  bytes,
  files = 0,
  bytesPerSec,
  perFileOverheadMs = kOpenclawBackupPerFileOverheadMs,
} = {}) => {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return null;
  const fileCount = Number.isFinite(files) && files > 0 ? files : 0;
  const overhead = Number.isFinite(perFileOverheadMs) && perFileOverheadMs > 0 ? perFileOverheadMs : 0;
  return Math.round((bytes / bytesPerSec) * 1000 + fileCount * overhead);
};

// The two rungs the quiesced driver can run with the gateway paused.
const kBackupRungs = Object.freeze(["offline_copy", "upstream"]);
// A prediction is a point estimate over a calibration that may be stale; the
// upstream attempt is worth the pause only with this much headroom.
const kUpstreamPredictionSafetyFactor = 1.5;

// Which rung follows a FAILED offline copy while the gateway is still paused
// (the copy itself is unconditional and first — D1a). `upstream` means an
// in-quiesce `backup create` is predicted to fit; `offline_copy` means the
// copy was the only quiesced rung worth running, so the driver hands over to
// the live ladder. Fail-closed at every arm: an unknown prediction (the
// diagnosis walk hit its budget, no calibration — Codex 16 predicts
// "unknown"), an unknown copy-set size, a set over the upstream byte cap
// (upstream cannot exclude) or a prediction that does not fit the remaining
// pause with the safety factor all answer `offline_copy`. Pure; the caller
// records the answer as `run.backup.attemptsDetail[].reason`.
const chooseBackupRung = ({
  diagnosis,
  remainingMs,
  upstreamMaxBytes = kOpenclawBackupUpstreamMaxBytes,
} = {}) => {
  const predicted = diagnosis?.predictedUpstreamMs;
  if (!Number.isFinite(predicted) || predicted < 0) {
    return { rung: "offline_copy", reason: "prediction_unknown" };
  }
  const copySetBytes = diagnosis?.copySetBytes;
  if (!Number.isFinite(copySetBytes) || copySetBytes < 0) {
    return { rung: "offline_copy", reason: "copy_set_unknown" };
  }
  if (copySetBytes > upstreamMaxBytes) {
    return { rung: "offline_copy", reason: "copy_set_too_large" };
  }
  if (!Number.isFinite(remainingMs) || predicted * kUpstreamPredictionSafetyFactor >= remainingMs) {
    return { rung: "offline_copy", reason: "predicted_too_slow" };
  }
  return { rung: "upstream", reason: "predicted_fits" };
};

// The constants as the driver's budget table — ONE mapping from the
// kOpenclawBackup* names to the field names `runBackup` reads, so a tuning
// override (`backupTuning`, spread over this) and the envelope relations
// below talk about the same keys. Frozen: the driver spreads it into its own
// mutable table (it derives stateDbQuietMaxMs from the EFFECTIVE budgets).
const kDefaultBackupBudget = Object.freeze({
  phaseEnvelopeMs: kOpenclawBackupPhaseEnvelopeMs,
  liveAttempts: kOpenclawBackupLiveAttempts,
  retryDelayMs: kOpenclawBackupRetryDelayMs,
  quiesceTimeoutMs: kOpenclawBackupQuiesceTimeoutMs,
  quiesceStopTimeoutMs: kOpenclawBackupQuiesceStopTimeoutMs,
  quiesceLockTimeoutMs: kOpenclawBackupQuiesceLockTimeoutMs,
  cliTimeoutMs: kOpenclawBackupTimeoutMs,
  contentionRetries: kOpenclawBackupContentionRetries,
  contentionBackoffBaseMs: kOpenclawBackupContentionBackoffBaseMs,
  postQuiesceReadyTimeoutMs: kOpenclawBackupPostQuiesceReadyTimeoutMs,
  postQuiescePollMs: kOpenclawBackupPostQuiescePollMs,
  postQuiesceSettleMs: kOpenclawBackupPostQuiesceSettleMs,
  offlineCopyBudgetMs: kOpenclawBackupOfflineCopyBudgetMs,
  diagnosisBudgetMs: kOpenclawBackupDiagnosisBudgetMs,
  upstreamMaxBytes: kOpenclawBackupUpstreamMaxBytes,
  defaultCopyBytesPerSec: kOpenclawBackupDefaultCopyBytesPerSec,
  defaultUpstreamBytesPerSec: kOpenclawBackupDefaultUpstreamBytesPerSec,
  perFileOverheadMs: kOpenclawBackupPerFileOverheadMs,
  stateDbQuietSlackMs: kOpenclawStateDbQuietSlackMs,
  reuseVerifyTimeoutMs: kOpenclawBackupReuseVerifyTimeoutMs,
  usableCheckReserveMs: kOpenclawBackupUsableCheckReserveMs,
  quiesceLeaseReserveMs: kOpenclawBackupQuiesceLeaseReserveMs,
  staleTempDirSlackMs: kOpenclawBackupStaleTempDirSlackMs,
  // #79 (h): the progress ticker's cadence (log line + SSE output + the live
  // step row rewritten in place). Not an envelope term — it costs no budget.
  progressIntervalMs: kOpenclawBackupProgressIntervalMs,
  rollbackJournalSelfDeadlockBytes: kOpenclawBackupRollbackJournalSelfDeadlockBytes,
  exclusivitySettleMs: kOpenclawBackupExclusivitySettleMs,
  exclusivitySettlePollMs: kOpenclawBackupExclusivitySettlePollMs,
});

// The envelope relations (issue #79 (f), Codex 16). The phase envelope is one
// clock for the whole backup step, so each path through the step must fit it
// in the worst case or the step promises coverage the clock cannot deliver:
//
//   quiesced path   diagnosis walk → lock wait → quiesced attempts (fixed
//                   deadline) → offline copy → usable check → relaunch ready
//                   wait → settle, each at its own ceiling, ≤ envelope
//   live ladder     every attempt at the CLI ceiling + the usable-check
//                   reserve a success still needs, ≤ envelope
//
// Evaluated over a budget table (the defaults, or the driver's EFFECTIVE
// table with tuning applied) so a tuning override can be checked with the
// same code the constants test pins. A term that is not a finite number
// cannot be shown to fit, so its pin is `ok: false` and names it.
const kBackupEnvelopePinTerms = Object.freeze({
  quiesced_path_fits_envelope: Object.freeze([
    "diagnosisBudgetMs",
    "quiesceLockTimeoutMs",
    "quiesceTimeoutMs",
    "offlineCopyBudgetMs",
    "usableCheckReserveMs",
    "postQuiesceReadyTimeoutMs",
    "postQuiesceSettleMs",
  ]),
  live_ladder_fits_envelope: Object.freeze(["liveAttempts", "cliTimeoutMs", "usableCheckReserveMs"]),
});
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const backupBudgetPins = (budget = kDefaultBackupBudget) => {
  const table = budget && typeof budget === "object" ? budget : {};
  const envelopeMs = finiteOrNull(table.phaseEnvelopeMs);
  const pick = (names) => Object.fromEntries(names.map((name) => [name, finiteOrNull(table[name])]));
  const missingOf = (terms) => [
    ...Object.entries(terms)
      .filter(([, value]) => value === null)
      .map(([name]) => name),
    ...(envelopeMs === null ? ["phaseEnvelopeMs"] : []),
  ];
  const quiescedTerms = pick(kBackupEnvelopePinTerms.quiesced_path_fits_envelope);
  const quiescedMissing = missingOf(quiescedTerms);
  const quiescedTotalMs =
    quiescedMissing.length > 0
      ? null
      : Object.values(quiescedTerms).reduce((sum, value) => sum + value, 0);
  const liveTerms = pick(kBackupEnvelopePinTerms.live_ladder_fits_envelope);
  const liveMissing = missingOf(liveTerms);
  const liveTotalMs =
    liveMissing.length > 0
      ? null
      : liveTerms.liveAttempts * liveTerms.cliTimeoutMs + liveTerms.usableCheckReserveMs;
  return Object.freeze([
    Object.freeze({
      name: "quiesced_path_fits_envelope",
      relation:
        "diagnosisBudgetMs + quiesceLockTimeoutMs + quiesceTimeoutMs + offlineCopyBudgetMs + usableCheckReserveMs + postQuiesceReadyTimeoutMs + postQuiesceSettleMs ≤ phaseEnvelopeMs",
      terms: Object.freeze(quiescedTerms),
      totalMs: quiescedTotalMs,
      envelopeMs,
      missing: Object.freeze(quiescedMissing),
      ok: quiescedTotalMs !== null && quiescedTotalMs <= envelopeMs,
    }),
    Object.freeze({
      name: "live_ladder_fits_envelope",
      relation: "liveAttempts × cliTimeoutMs + usableCheckReserveMs ≤ phaseEnvelopeMs",
      terms: Object.freeze(liveTerms),
      totalMs: liveTotalMs,
      envelopeMs,
      missing: Object.freeze(liveMissing),
      ok: liveTotalMs !== null && liveTotalMs <= envelopeMs,
    }),
  ]);
};

module.exports = {
  kQuiescedOutcomePolicy,
  kLiveRetryPolicy,
  kReuseEligibleKinds,
  contentionRetryVerdict,
  kContentionRetryReserveMs,
  kContentionRetryMaxAttemptShare,
  predictTransferMs,
  kBackupRungs,
  kUpstreamPredictionSafetyFactor,
  chooseBackupRung,
  kDefaultBackupBudget,
  kBackupEnvelopePinTerms,
  backupBudgetPins,
};
