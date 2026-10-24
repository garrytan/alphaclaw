// What a running `openclaw doctor --fix` is doing, in plain words, for the
// boot card and the Retry upgrade card (ALPH-23). OpenClaw 2026.10.6 prints
// nothing while it makes its verified recovery copy (6 of the 12 minutes on a
// 16 GB state) and nothing while it backs up each agent database, so the
// phase comes from the few lines it does print, and the progress inside the
// two silent phases from the bytes those copies have written so far.
//
// Phases only move forward:
//   capture  start → the copy under <stateDir>.update-captures/doctor-<uuid>/
//   backup   "doctor.database-preflight" / the capture's end → every database's
//            <db>.pre-startup-migration-<uuid>.bak (staged in .sqlite-publish-*)
//   migrate  "Saved pre-migration SQLite backup" or the first
//            "agent database schema migration pending" (one per agent)
//   checks   "cli.bootstrap.legacy-state-migrations <ms>" → Doctor's own checks
const fs = require("fs");
const path = require("path");
const { kCaptureSuffix, measureDatabaseFamilies } = require("./openclaw-capture-preflight");

const kDoctorPhases = Object.freeze(["capture", "backup", "migrate", "checks"]);
const kPhaseMarkers = [
  ["backup", /startup trace: doctor\.maintenance\.preserve-original-state \d|startup trace: doctor\.database-preflight|Pre-repair state retained|capture (?:was|is) unavailable/],
  ["migrate", /Saved pre-migration SQLite backup|agent database schema migration pending/],
  ["checks", /startup trace: cli\.bootstrap\.legacy-state-migrations \d/],
];
const kMigrationLine = /agent database schema migration pending/;
const kBackupMarker = ".pre-startup-migration-";
const kPublishDirPrefix = ".sqlite-publish-";
// A run's own copy is created after it starts; an older one (an interrupted
// run's, never reclaimed) is not this run's progress.
const kOwnCopySlackMs = 5_000;
const kPartialLineCapBytes = 4096;

const createDoctorPhaseTracker = () => {
  let phase = "capture";
  let migrated = 0;
  let partial = "";
  const onLine = (line) => {
    for (const [next, pattern] of kPhaseMarkers) {
      if (kDoctorPhases.indexOf(next) > kDoctorPhases.indexOf(phase) && pattern.test(line)) phase = next;
    }
    if (phase === "migrate" && kMigrationLine.test(line)) migrated += 1;
  };
  return {
    onOutput: (chunkText) => {
      const lines = `${partial}${String(chunkText ?? "")}`.split("\n");
      partial = lines.pop().slice(-kPartialLineCapBytes);
      for (const line of lines) onLine(line);
    },
    snapshot: () => ({ phase, migrated }),
  };
};

const fileBytes = (filePath, fsModule) => {
  try {
    const stat = fsModule.lstatSync(filePath);
    return stat.isFile() ? Number(stat.size) || 0 : 0;
  } catch {
    return 0;
  }
};

const treeBytes = (root, fsModule) => {
  let total = 0;
  let entries = [];
  try {
    entries = fsModule.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    total += entry.isDirectory() ? treeBytes(target, fsModule) : fileBytes(target, fsModule);
  }
  return total;
};

const isOwnCopy = (target, startedAtMs, fsModule) => {
  try {
    return fsModule.statSync(target).mtimeMs >= startedAtMs - kOwnCopySlackMs;
  } catch {
    return false;
  }
};

const captureBytes = ({ stateDir, startedAtMs, fsModule }) => {
  let root;
  try {
    root = fsModule.realpathSync(stateDir) + kCaptureSuffix;
  } catch {
    return 0;
  }
  let names = [];
  try {
    names = fsModule.readdirSync(root).filter((name) => name.startsWith("doctor-"));
  } catch {
    return 0;
  }
  return names
    .map((name) => path.join(root, name))
    .filter((target) => isOwnCopy(target, startedAtMs, fsModule))
    .reduce((sum, target) => sum + treeBytes(target, fsModule), 0);
};

const backupBytes = ({ databaseFiles, startedAtMs, fsModule }) => {
  let total = 0;
  for (const directory of new Set(databaseFiles.map((file) => path.dirname(file)))) {
    let names = [];
    try {
      names = fsModule.readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const target = path.join(directory, name);
      if (name.includes(kBackupMarker) && name.endsWith(".bak") && isOwnCopy(target, startedAtMs, fsModule)) {
        total += fileBytes(target, fsModule);
      } else if (name.startsWith(kPublishDirPrefix)) {
        total += treeBytes(target, fsModule);
      }
    }
  }
  return total;
};

const formatBytes = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const formatPart = (done, total) =>
  done >= 1e9 ? `${(done / 1e9).toFixed(1)} of ${formatBytes(total)}` : `${formatBytes(done)} of ${formatBytes(total)}`;

const describeDoctorProgress = ({ phase, migrated = 0, doneBytes = 0, totalBytes = 0, agentDatabases = 0 }) => {
  const ofTotal = totalBytes > 0 && doneBytes > 0
    ? `: ${formatPart(Math.min(doneBytes, totalBytes), totalBytes)}`
    : "";
  if (phase === "capture") return ofTotal ? `Making a recovery copy${ofTotal}` : "Preparing OpenClaw's data upgrade";
  if (phase === "backup") return `Backing up each database${ofTotal}`;
  if (phase === "migrate") {
    return agentDatabases > 0
      ? `Migrating agent databases: ${Math.min(migrated, agentDatabases)} of ${agentDatabases}`
      : "Migrating agent databases";
  }
  return "Checking sessions and transcripts";
};

// ({ phase, migrated, startedAtMs }) → { phase, words, doneBytes, totalBytes }.
// Reads only sizes and directory listings; never opens a database.
const createDoctorProgressReader = ({ stateDir, listStateDbFiles, fsModule = fs }) => ({ phase, migrated = 0, startedAtMs }) => {
  const databaseFiles = listStateDbFiles() || [];
  const totalBytes = measureDatabaseFamilies(databaseFiles, fsModule).reduce((sum, family) => sum + family.bytes, 0);
  const doneBytes = phase === "capture"
    ? captureBytes({ stateDir: stateDir(), startedAtMs, fsModule })
    : phase === "backup"
      ? backupBytes({ databaseFiles, startedAtMs, fsModule })
      : 0;
  const agentDatabases = databaseFiles.filter((file) => file.split(path.sep).includes("agents")).length;
  return {
    phase,
    words: describeDoctorProgress({ phase, migrated, doneBytes, totalBytes, agentDatabases }),
    doneBytes,
    totalBytes,
  };
};

module.exports = {
  kDoctorPhases,
  createDoctorPhaseTracker,
  createDoctorProgressReader,
  describeDoctorProgress,
};
