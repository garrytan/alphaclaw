// AlphaClaw self-version stamp + boot banner (issue #76, plan A8).
//
// Every boot of the AlphaClaw process leaves one small record of WHICH
// AlphaClaw booted, so a restart loop or a post-deploy incident can be read
// off the volume without guessing from log timestamps:
//
//   <managedDir>/alphaclaw-version.json
//   {
//     "version": "0.9.77",          // package.json version of this boot
//     "commit": "abc123" | null,    // '#<ref>' of the git dependency spec;
//                                   // null for npm installs (no fragment)
//     "firstBootAt": <ms>,          // first boot of THIS version
//     "lastBootAt": <ms>,           // this boot
//     "bootCount": 14,              // boots of THIS version (resets on change)
//     "previous": {                 // the version that ran before this one,
//       "version", "commit",        // carried unchanged across repeats of the
//       "lastBootAt"                // current version; null on the very first
//     } | null                      // boot of a box
//   }
//
// Identity is the VERSION: a different commit under the same version (a git
// deploy re-pinned to another ref) is recorded but does not count as a
// change, because the boot report's `firstBootOfVersion` and the pause /
// pinned-incident rules downstream key on the installed version.
//
// Diagnostics posture (lenient): a missing or unreadable file is the
// first-boot state plus ONE warning; a failed write warns and never blocks
// boot. The record is written through writeFileAtomic so a crash mid-write
// can never leave a torn stamp for the next boot to trip over. The banner is
// the first `[alphaclaw]` line of a boot log and is the only console output
// this module formats — bin/alphaclaw.js prints it.
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");

const kSelfVersionFileName = "alphaclaw-version.json";
const kLogPrefix = "[self-version]";
// A git ref (branch, tag, SHA, refs/heads/x) as npm accepts it after '#'.
// Anything else in the fragment — `semver:^1.0`, spaces, shell metacharacters
// — is not a commit and must not reach a log line verbatim.
const kGitRefPattern = /^[A-Za-z0-9._/-]+$/;

// '#<ref>' fragment of a dependency spec → the ref; null when the spec has no
// fragment (npm ranges, `latest`, `file:` paths) or the fragment is not a ref.
const parseCommitFromSpec = (spec) => {
  const value = String(spec ?? "").trim();
  const hash = value.indexOf("#");
  if (hash === -1) return null;
  const fragment = value.slice(hash + 1).trim();
  if (fragment === "" || !kGitRefPattern.test(fragment)) return null;
  return fragment;
};

const stampPath = (managedDir) => {
  if (typeof managedDir !== "string" || managedDir === "") {
    throw new TypeError("alphaclaw-self-version: managedDir is required");
  }
  return path.join(managedDir, kSelfVersionFileName);
};

const toMs = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const toCommit = (value) => (typeof value === "string" && value !== "" ? value : null);
const toVersion = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

const normalizePrevious = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const version = toVersion(raw.version);
  if (version === null) return null;
  return { version, commit: toCommit(raw.commit), lastBootAt: toMs(raw.lastBootAt) };
};

// A record is usable when it names a version; every other field is normalized
// leniently (a hand-edited or partially written file still yields a stamp).
const normalizeRecord = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const version = toVersion(raw.version);
  if (version === null) return null;
  return {
    version,
    commit: toCommit(raw.commit),
    firstBootAt: toMs(raw.firstBootAt),
    lastBootAt: toMs(raw.lastBootAt),
    bootCount: Number.isInteger(raw.bootCount) && raw.bootCount >= 0 ? raw.bootCount : 0,
    previous: normalizePrevious(raw.previous),
  };
};

const warnUnreadable = (logger, filePath, reason) => {
  logger.warn(
    `${kLogPrefix} ${filePath} is unreadable (${reason?.message || reason}) — treating this as the first boot of this version`,
  );
};

// { record | null, origin: "file" | "missing" | "unreadable" }. Missing is
// silent (a fresh box); unreadable warns exactly once per call.
const readStamp = ({ fsModule, managedDir, logger }) => {
  const filePath = stampPath(managedDir);
  let raw;
  try {
    raw = fsModule.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { record: null, origin: "missing" };
    warnUnreadable(logger, filePath, error);
    return { record: null, origin: "unreadable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnUnreadable(logger, filePath, error);
    return { record: null, origin: "unreadable" };
  }
  const record = normalizeRecord(parsed);
  if (record === null) {
    warnUnreadable(logger, filePath, new Error("no version field"));
    return { record: null, origin: "unreadable" };
  }
  return { record, origin: "file" };
};

// The stamp on disk, or null. Never throws: a missing file is null without a
// warning, a corrupt one is null with one warning naming the path.
const readSelfVersionStamp = ({ fsModule = fs, managedDir, logger = console } = {}) =>
  readStamp({ fsModule, managedDir, logger }).record;

// Called once per boot (bin phase, start path only). Returns
//   { changed, previousVersion, record }
// where `changed` is "this is the first boot of `version` on this box" (true
// on the very first boot and after every version change, false on a repeat)
// and `previousVersion` is the version the on-disk stamp named before this
// boot (null when there was none). `record` is what was written.
const stampSelfVersionAtBoot = ({
  version,
  spec = null,
  nowFn = Date.now,
  fsModule = fs,
  managedDir,
  logger = console,
} = {}) => {
  const filePath = stampPath(managedDir);
  const currentVersion = toVersion(version);
  if (currentVersion === null) {
    throw new TypeError("stampSelfVersionAtBoot: version is required");
  }
  const now = nowFn();
  const commit = parseCommitFromSpec(spec);
  const { record: existing } = readStamp({ fsModule, managedDir, logger });
  const previousVersion = existing?.version ?? null;
  const changed = previousVersion !== currentVersion;

  let record;
  if (existing && !changed) {
    record = {
      version: currentVersion,
      commit,
      firstBootAt: existing.firstBootAt ?? now,
      lastBootAt: now,
      bootCount: existing.bootCount + 1,
      previous: existing.previous,
    };
  } else {
    record = {
      version: currentVersion,
      commit,
      firstBootAt: now,
      lastBootAt: now,
      bootCount: 1,
      previous: existing
        ? { version: existing.version, commit: existing.commit, lastBootAt: existing.lastBootAt }
        : null,
    };
  }

  try {
    writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`, { fsModule });
  } catch (error) {
    // The stamp is evidence, not a gate: a full disk must not stop the boot
    // that would let an operator see the problem.
    logger.warn(`${kLogPrefix} could not write ${filePath} (${error?.message || error})`);
  }

  return { changed, previousVersion, record };
};

// The first line of a boot log:
//   [alphaclaw] AlphaClaw 0.9.77 (commit abc123; previous 0.9.76) root=/data node=v22.23.2
// `commit n/a` for npm installs, `previous none` on the first boot of a box.
const formatBootBanner = (record, { rootDir, nodeVersion = process.version } = {}) => {
  const version = record?.version ?? "unknown";
  const commit = record?.commit ?? "n/a";
  const previous = record?.previous?.version ?? "none";
  return `[alphaclaw] AlphaClaw ${version} (commit ${commit}; previous ${previous}) root=${rootDir} node=${nodeVersion}`;
};

module.exports = {
  kSelfVersionFileName,
  parseCommitFromSpec,
  readSelfVersionStamp,
  stampSelfVersionAtBoot,
  formatBootBanner,
};
