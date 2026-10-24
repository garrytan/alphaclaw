// Doctor's run time follows the bytes of SQLite state it copies and checks
// (ALPH-23). On OpenClaw 2026.10.6 a 4 GB, a 16 GB and an AlphaClaw-hosted
// 16 GB upgrade each took 46-50 s per GiB, mostly OpenClaw's verified recovery
// capture, the per-database pre-migration backups and integrity checks. That
// work is serial and bound by the disk, so more CPUs do not shorten it.
//
// A ceiling that fires kills Doctor (SIGTERM, then SIGKILL). Killed during the
// capture, the state stays on the old schema (the gateway then exits 78 or
// serves with every agent's sessions unavailable) and the partial capture
// stays on disk; the next Doctor does not reclaim it. So each Doctor ceiling
// is the larger of its fixed floor and the measured state times the rate with
// headroom, capped so a wedged Doctor still ends.
const fs = require("fs");
const { measureDatabaseFamilies } = require("./openclaw-capture-preflight");

const kGibBytes = 1024 ** 3;
const kDoctorMsPerGib = 50 * 1000;
const kDoctorBudgetHeadroom = 3;
const kDoctorTimeoutCapMs = 6 * 60 * 60 * 1000;

const resolveDoctorTimeoutMs = ({ stateBytes = 0, floorMs }) => {
  const scaled = Math.ceil(((Number(stateBytes) || 0) / kGibBytes) * kDoctorMsPerGib * kDoctorBudgetHeadroom);
  return Math.max(floorMs, Math.min(scaled, kDoctorTimeoutCapMs));
};

// (floorMs) → ms, measured on every call: state grows between boots.
// An unmeasurable state keeps the floor (the ceiling before ALPH-23).
const createDoctorTimeoutResolver = ({ listStateDbFiles, fsModule = fs, logger = console }) => (floorMs) => {
  try {
    const stateBytes = measureDatabaseFamilies(listStateDbFiles() || [], fsModule).reduce((sum, family) => sum + family.bytes, 0);
    return resolveDoctorTimeoutMs({ stateBytes, floorMs });
  } catch (error) {
    logger.warn?.(`[alphaclaw] could not measure OpenClaw state for the doctor --fix ceiling: ${error.message}`);
    return floorMs;
  }
};

module.exports = {
  kDoctorBudgetHeadroom,
  kDoctorMsPerGib,
  kDoctorTimeoutCapMs,
  createDoctorTimeoutResolver,
  resolveDoctorTimeoutMs,
};
