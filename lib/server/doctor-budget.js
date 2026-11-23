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
//
// A full `doctor --lint` adds the state term to its floor instead (#488): the
// 50 s per GiB was measured on --fix runs, and a lint also pays a fixed cost
// (starting the CLI, loading plugins, checking each agent's config) that the
// rate leaves out. A 0.72 GiB install's lint took 135 s against a 108 s
// ceiling, so it was killed on every boot.
const fs = require("fs");
const { measureDatabaseFamilies } = require("./openclaw-capture-preflight");

const kGibBytes = 1024 ** 3;
const kDoctorMsPerGib = 50 * 1000;
const kDoctorBudgetHeadroom = 3;
const kDoctorTimeoutCapMs = 6 * 60 * 60 * 1000;

const scaledStateMs = (stateBytes) =>
  Math.ceil(((Number(stateBytes) || 0) / kGibBytes) * kDoctorMsPerGib * kDoctorBudgetHeadroom);

const resolveDoctorTimeoutMs = ({ stateBytes = 0, floorMs }) =>
  Math.max(floorMs, Math.min(scaledStateMs(stateBytes), kDoctorTimeoutCapMs));

const resolveDoctorLintTimeoutMs = ({ stateBytes = 0, floorMs }) =>
  Math.min(floorMs + scaledStateMs(stateBytes), kDoctorTimeoutCapMs);

// (floorMs) → ms, measured on every call: state grows between boots.
// An unmeasurable state keeps the floor (the ceiling before ALPH-23).
const createDoctorTimeoutResolver = ({ listStateDbFiles, fsModule = fs, logger = console, resolve = resolveDoctorTimeoutMs }) => (floorMs) => {
  try {
    const stateBytes = measureDatabaseFamilies(listStateDbFiles() || [], fsModule).reduce((sum, family) => sum + family.bytes, 0);
    return resolve({ stateBytes, floorMs });
  } catch (error) {
    logger.warn?.(`[alphaclaw] could not measure OpenClaw state for the doctor ceiling: ${error.message}`);
    return floorMs;
  }
};

module.exports = {
  kDoctorBudgetHeadroom,
  kDoctorMsPerGib,
  kDoctorTimeoutCapMs,
  createDoctorTimeoutResolver,
  resolveDoctorLintTimeoutMs,
  resolveDoctorTimeoutMs,
};
