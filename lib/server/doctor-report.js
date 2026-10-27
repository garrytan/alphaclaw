const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { kContributionStepPrefix } = require("./doctor-progress");
const { kCaptureSuffix } = require("./openclaw-capture-preflight");
const { expandDisplayHome } = require("./doctor-outcome");

// What one `openclaw doctor --fix` run did and where its time went: kept on
// the migration record's lastOutcome.report and printed as one summary line.
// Durations come from OpenClaw's startup trace (doctor-fix-runner sets
// OPENCLAW_GATEWAY_STARTUP_TRACE on the Doctor child). They are durations
// only, never proof a step succeeded. Nested steps are listed under their
// parent and never added up; the total is AlphaClaw's own wall clock, and
// what the top-level steps do not cover is reported as unattributed. A fact
// with no positive evidence is null ("unknown"), never "unchanged".
//
// The 2026.10.8 nesting (doctor-health chunk):
//   maintenance.begin ⊃ maintenance.preserve-original-state (the recovery copy)
//   config-flow       ⊃ cli.bootstrap.legacy-state-migrations
//   contributions     ⊃ contribution.doctor:<check>
const kTopLevelSteps = Object.freeze([
  ["doctor.maintenance.begin", "maintenance.begin"],
  ["doctor.database-preflight", "database-preflight"],
  ["doctor.config-flow", "config-flow"],
  ["doctor.contributions", "contributions"],
  ["doctor.maintenance-ready", "maintenance-ready"],
  ["doctor.maintenance.finish", "maintenance.finish"],
  ["doctor.maintenance.release", "maintenance.release"],
]);
const kNestedSteps = Object.freeze([
  ["doctor.maintenance.preserve-original-state", "maintenance.begin", "recovery-copy"],
  ["cli.bootstrap.legacy-state-migrations", "config-flow", "legacy-state-migrations"],
]);
const kSlowestChecks = 5;
const kCaptureWalkMaxEntries = 200_000;

const roundMs = (ms) => Math.round(Number(ms) || 0);

// SHA-256 of openclaw.json's raw bytes, read in memory right before and
// right after the run (null when unreadable). Only "the file was rewritten"
// follows from two of these, not whether the effective settings changed.
const readConfigFingerprint = ({ openclawDir, fsModule = fs }) => {
  try {
    return crypto.createHash("sha256").update(fsModule.readFileSync(path.join(openclawDir, "openclaw.json"))).digest("hex");
  } catch {
    return null;
  }
};

// Bytes of the recovery copy Doctor named in its manifest line, only when
// that directory is a direct doctor-* child of <realpath(stateDir)>
// .update-captures; a bounded walk that never follows a symlink (null past
// the cap or on any doubt).
const measureRetainedCapture = ({ manifestPath, stateDir, env = null, fsModule = fs }) => {
  if (!manifestPath || !stateDir) return null;
  let captureDir;
  let captureRoot;
  try {
    captureDir = fsModule.realpathSync(path.dirname(expandDisplayHome(manifestPath, env)));
    captureRoot = fsModule.realpathSync(stateDir) + kCaptureSuffix;
  } catch {
    return null;
  }
  if (path.dirname(captureDir) !== captureRoot || !path.basename(captureDir).startsWith("doctor-")) return null;
  let total = 0;
  let entries = 0;
  const pending = [captureDir];
  while (pending.length) {
    const dir = pending.pop();
    let children;
    try {
      children = fsModule.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const child of children) {
      entries += 1;
      if (entries > kCaptureWalkMaxEntries) return null;
      const target = path.join(dir, child.name);
      if (child.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!child.isFile()) continue;
      try {
        total += Number(fsModule.lstatSync(target).size) || 0;
      } catch {
        return null;
      }
    }
  }
  return total;
};

// traced: the phase tracker's report() ({ steps, changes, migrated }).
const buildDoctorReport = ({ traced, totalMs, configBefore = null, configAfter = null, captureBytes = null }) => {
  const steps = traced?.steps || new Map();
  const top = kTopLevelSteps
    .filter(([name]) => steps.has(name))
    .map(([name, label]) => ({
      step: label,
      ms: roundMs(steps.get(name)),
      nested: kNestedSteps
        .filter(([nestedName, parent]) => parent === label && steps.has(nestedName))
        .map(([nestedName, , nestedLabel]) => ({ step: nestedLabel, ms: roundMs(steps.get(nestedName)) })),
    }));
  const slowestChecks = [...steps]
    .filter(([name]) => name.startsWith(kContributionStepPrefix))
    .map(([name, ms]) => ({ check: name.slice(kContributionStepPrefix.length), ms: roundMs(ms) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, kSlowestChecks);
  const covered = top.reduce((sum, entry) => sum + entry.ms, 0);
  return {
    totalMs: roundMs(totalMs),
    traced: top.length > 0,
    steps: top,
    unattributedMs: top.length ? Math.max(0, roundMs(totalMs) - covered) : null,
    slowestChecks,
    changes: traced?.changes || [],
    changeCount: traced?.changeCount ?? (traced?.changes || []).length,
    configFileRewritten: configBefore && configAfter ? configBefore !== configAfter : null,
    captureBytes,
    migrationsLogged: traced?.migrated || 0,
  };
};

const formatSeconds = (ms) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + "s";
const formatGigabytes = (bytes) => (bytes / 1e9).toFixed(bytes < 1e9 ? 2 : 1) + "GB";

const formatDoctorReportLine = (report, { source }) => {
  const steps = report.steps
    .map((entry) => entry.step + "=" + formatSeconds(entry.ms) + entry.nested.map((sub) => "(" + sub.step + "=" + formatSeconds(sub.ms) + ")").join(""))
    .join(" ");
  const checks = report.slowestChecks.map((entry) => entry.check + "=" + formatSeconds(entry.ms)).join(",");
  const config = report.configFileRewritten === null ? "unknown" : report.configFileRewritten ? "rewritten" : "same-bytes";
  return [
    "[alphaclaw] doctor --fix summary source=" + source + " total=" + formatSeconds(report.totalMs),
    report.traced ? steps : "steps=untraced",
    report.unattributedMs === null ? null : "unattributed=" + formatSeconds(report.unattributedMs),
    checks ? "slowestChecks=" + checks : null,
    "recoveryCopy=" + (report.captureBytes === null ? "unknown" : formatGigabytes(report.captureBytes)),
    "configFile=" + config,
    "migrations=" + report.migrationsLogged,
    "changes=" + report.changeCount,
  ].filter(Boolean).join(" ");
};

module.exports = {
  buildDoctorReport,
  formatDoctorReportLine,
  measureRetainedCapture,
  readConfigFingerprint,
};
