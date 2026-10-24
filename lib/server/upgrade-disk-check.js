// Before OpenClaw's data upgrade for a new pin starts: is there room for it,
// and does the Doctor time limit cover this much state (ALPH-23)?
//
// Measured on OpenClaw 2026.10.6 (16 GB of 2026.10.4 state): the run grows
// the volume by about twice the state. Its verified recovery copy needs
// 2·bytes + 3·largest database free, or OpenClaw skips it and continues
// without one. Its per-database pre-migration backups need about the state
// again and are never skipped. Below roughly 1.1x the state the backups
// cannot fit: Doctor would fill the disk and fail without migrating anything,
// which is worse than not starting. So:
//   refuse  free < 1.1 × state
//   warn    free < 2 × state            (the run may have no recovery copy)
//   warn    state beyond what the Doctor limit's headroom covers
const { kDoctorBudgetHeadroom, kDoctorMsPerGib, kDoctorTimeoutCapMs } = require("./doctor-budget");

const kGibBytes = 1024 ** 3;
const kRefuseBelowStateRatio = 1.1;
const kWarnBelowStateRatio = 2;
const kCoveredStateBytes = (kDoctorTimeoutCapMs / (kDoctorMsPerGib * kDoctorBudgetHeadroom)) * kGibBytes;

const formatGb = (bytes) => `${(Math.max(0, bytes) / 1e9).toFixed(1)} GB`;

// { stateBytes, freeBytes } from the capture preflight → { verdict, sentences,
// expectedMinutes, stateBytes, freeBytes, neededBytes }. An unmeasured free
// space never refuses (the preflight could not read the filesystem).
const evaluateUpgradeDiskCheck = ({ stateBytes = 0, freeBytes = null } = {}) => {
  const state = Math.max(0, Number(stateBytes) || 0);
  const free = Number.isFinite(Number(freeBytes)) && freeBytes !== null ? Number(freeBytes) : null;
  const base = {
    stateBytes: state,
    freeBytes: free,
    neededBytes: Math.ceil(state * kWarnBelowStateRatio),
    expectedMinutes: Math.max(1, Math.ceil(((state / kGibBytes) * kDoctorMsPerGib) / 60_000)),
  };
  if (state === 0) return { ...base, verdict: "ok", sentences: [] };
  if (free !== null && free < state * kRefuseBelowStateRatio) {
    return {
      ...base,
      verdict: "refuse",
      sentences: [
        `OpenClaw's data upgrade backs up every database before it migrates them, and this volume has ${formatGb(free)} free for ${formatGb(state)} of OpenClaw state. ` +
          `AlphaClaw won't start it: a full disk would stop it halfway. Make at least ${formatGb(base.neededBytes)} free, then use Retry upgrade.`,
      ],
    };
  }
  const sentences = [];
  if (free !== null && free < state * kWarnBelowStateRatio) {
    sentences.push(
      `Only ${formatGb(free)} is free for ${formatGb(state)} of OpenClaw state. The data upgrade needs about ${formatGb(base.neededBytes)}, so OpenClaw will likely skip its recovery copy and the upgrade will have no rollback snapshot.`,
    );
  }
  if (state > kCoveredStateBytes) {
    sentences.push(
      `${formatGb(state)} of OpenClaw state is more than AlphaClaw's ${kDoctorTimeoutCapMs / 3_600_000}-hour Doctor limit is sized for (about ${formatGb(kCoveredStateBytes)}). At the measured rate the data upgrade takes about ${base.expectedMinutes} min, so a slower disk could reach the limit and stop it.`,
    );
  }
  return { ...base, verdict: sentences.length ? "warn" : "ok", sentences };
};

module.exports = {
  kCoveredStateBytes,
  kRefuseBelowStateRatio,
  kWarnBelowStateRatio,
  evaluateUpgradeDiskCheck,
};
