// Read-only answer to "would the next openclaw doctor --fix keep a
// pre-repair safety snapshot?", ported from OpenClaw 2026.10.4's own checks so
// the dashboard can say it BEFORE a Doctor runs. Never changes anything and
// never gates a Doctor run (snapshot policy: a capture is best-effort
// manual-recovery evidence; AlphaClaw only reports it).
//
// What Doctor does (dist, 2026.10.4):
//   update-recovery-baseline-capture-*.mjs
//     store = realpath(stateDir) + ".update-captures"
//     ensurePrivateSnapshotRepositoryRoot(store)        → mode rules below
//     createUpdateDatabaseBackup(...)                   → space rule below
//   local-repository-*.mjs assertTrustedStagingRoot / assertTrustedPosixStagingAncestors
//     root (realpath of the store): a real directory, owned by the process
//       uid, not group/other-writable (created 0700 when missing)
//     every ancestor up to "/": a real directory, owned by the process uid
//       or root, and either not group/other-writable or sticky with the
//       child it holds owned by the process uid — else
//       "SQLite staging ancestor must not allow another user to replace its
//       child: <ancestor>"
//   update-database-backup-*.mjs checkDatabaseBackupSpace
//     the capture filesystem needs 2·bytes + 3·largest + 64 MiB, where bytes
//     sums every SQLite family (db + -wal/-shm/-journal) and largest is the
//     biggest family; a source on another filesystem additionally needs
//     its bytes + largest + 64 MiB there.
// A failure prints "Original state capture was unavailable: <message>" and
// Doctor continues. The container tier keeps this port honest against the
// pinned binary (#144 layout: 2775 root:node /data → unavailable, +t →
// available); a pin bump that changes the rule fails there.
const fs = require("fs");
const path = require("path");

const kCaptureSuffix = ".update-captures";
const kSpaceReserveBytes = 64 * 1024 * 1024;
const kStickyBit = 0o1000;
const kGroupOtherWrite = 0o022;
const kSqliteSidecars = ["", "-wal", "-shm", "-journal"];

const kFailingRules = Object.freeze({
  ancestorReplaceable: "ancestor_replaceable",
  ancestorForeignOwner: "ancestor_foreign_owner",
  notDirectory: "not_directory",
  captureRootUnsafe: "capture_root_unsafe",
  captureRootUncreatable: "capture_root_uncreatable",
  space: "space",
  unsupported: "unsupported_platform",
});

// fixable.reason vocabulary: sticky_bit (Enable snapshots can fix it),
// not_owner (the directory belongs to another user, so chmod +t needs root),
// foreign_owner / child_not_owned / capture_root (needs chown or chmod beyond
// the sticky bit — a manual fix), space, unsupported, none (nothing to fix).
const kFixReasons = Object.freeze({
  none: "none",
  sticky: "sticky_bit",
  notOwner: "not_owner",
  foreignOwner: "foreign_owner",
  childNotOwned: "child_not_owned",
  captureRoot: "capture_root",
  space: "space",
  unsupported: "unsupported",
});

const resolveViaExistingAncestor = (target, fsModule) => {
  const suffix = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fsModule.realpathSync(current), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
};

const identityOf = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  uid: Number(stat.uid),
  gid: Number(stat.gid),
  mode: Number(stat.mode) & 0o7777,
  directory: typeof stat.isDirectory === "function" ? stat.isDirectory() : false,
  symlink: typeof stat.isSymbolicLink === "function" ? stat.isSymbolicLink() : false,
});

// The ported rule over already-read identities, so Enable snapshots can run
// it again against freshly opened handles with simulated modes. ancestors
// are ordered from the capture root's parent up to "/".
const evaluateStagingChain = ({ root, ancestors, uid }) => {
  if (root.exists) {
    if (!root.identity.directory || root.identity.symlink) {
      return { ok: false, failingPath: root.path, failingRule: kFailingRules.notDirectory };
    }
    if (root.identity.uid !== uid || (root.identity.mode & kGroupOtherWrite) !== 0) {
      return { ok: false, failingPath: root.path, failingRule: kFailingRules.captureRootUnsafe };
    }
  }
  let child = root.exists ? root.identity : { uid };
  for (const ancestor of ancestors) {
    const { identity } = ancestor;
    if (!identity.directory || identity.symlink) {
      return { ok: false, failingPath: ancestor.path, failingRule: kFailingRules.notDirectory };
    }
    const writableByOthers = (identity.mode & kGroupOtherWrite) !== 0;
    const ownerTrusted = identity.uid === uid || identity.uid === 0;
    const stickyProtectsChild = (identity.mode & kStickyBit) !== 0 && ownerTrusted && Number(child.uid) === uid;
    if (!ownerTrusted) {
      return { ok: false, failingPath: ancestor.path, failingRule: kFailingRules.ancestorForeignOwner };
    }
    if (writableByOthers && !stickyProtectsChild) {
      return { ok: false, failingPath: ancestor.path, failingRule: kFailingRules.ancestorReplaceable };
    }
    child = identity;
  }
  return { ok: true, failingPath: null, failingRule: null };
};

// Which ancestors the sticky bit alone would fix, and whether that is enough:
// a sticky bit only protects a child the process uid owns, and AlphaClaw can
// set it only on a directory it owns (or as root).
const planStickyFix = ({ root, ancestors, uid }) => {
  const targets = [];
  let child = root.exists ? root.identity : { uid };
  for (const ancestor of ancestors) {
    const { identity } = ancestor;
    const writableByOthers = (identity.mode & kGroupOtherWrite) !== 0;
    if (writableByOthers && (identity.mode & kStickyBit) === 0) {
      if (Number(child.uid) !== uid) return { targets: [], reason: kFixReasons.childNotOwned, path: ancestor.path };
      if (identity.uid !== uid && identity.uid !== 0) return { targets: [], reason: kFixReasons.foreignOwner, path: ancestor.path };
      if (uid !== 0 && identity.uid !== uid) return { targets: [], reason: kFixReasons.notOwner, path: ancestor.path };
      targets.push({ path: ancestor.path, ...identity, newMode: identity.mode | kStickyBit });
    }
    child = identity;
  }
  const simulated = evaluateStagingChain({
    root,
    uid,
    ancestors: ancestors.map((ancestor) => {
      const target = targets.find((entry) => entry.path === ancestor.path);
      return target ? { ...ancestor, identity: { ...ancestor.identity, mode: target.newMode } } : ancestor;
    }),
  });
  if (!simulated.ok) {
    const reason = simulated.failingRule === kFailingRules.captureRootUnsafe ? kFixReasons.captureRoot : kFixReasons.foreignOwner;
    return { targets: [], reason, path: simulated.failingPath };
  }
  return { targets, reason: targets.length ? kFixReasons.sticky : kFixReasons.none };
};

const readStagingChain = ({ captureRoot, fsModule }) => {
  let rootPath = captureRoot;
  let rootStat = null;
  try {
    rootPath = fsModule.realpathSync(captureRoot);
    rootStat = fsModule.lstatSync(rootPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const root = rootStat
    ? { path: rootPath, exists: true, identity: identityOf(rootStat) }
    : { path: captureRoot, exists: false, identity: null };
  const ancestors = [];
  let current = path.dirname(root.path);
  for (;;) {
    ancestors.push({ path: current, identity: identityOf(fsModule.lstatSync(current)) });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root, ancestors };
};

const fileSize = (filePath, fsModule) => {
  try {
    const stat = fsModule.lstatSync(filePath);
    return stat.isFile() ? Number(stat.size) || 0 : 0;
  } catch {
    return 0;
  }
};

// One family per SQLite database: the file plus its sidecars, as upstream's
// measureUpdateStateFiles counts them.
const measureDatabaseFamilies = (databaseFiles, fsModule) =>
  databaseFiles
    .map((databasePath) => ({
      path: databasePath,
      bytes: kSqliteSidecars.reduce((sum, suffix) => sum + fileSize(databasePath + suffix, fsModule), 0),
    }))
    .filter((family) => family.bytes > 0);

// statfs and stat need a path that exists. resolveViaExistingAncestor keeps
// the missing tail (the capture root is not created until the first capture),
// so measure at the nearest existing directory instead: before ALPH-23 the
// free space of every box without a capture root read as unmeasured.
const nearestExisting = (target, fsModule) => {
  let current = resolveViaExistingAncestor(target, fsModule);
  for (;;) {
    if (fsModule.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
};

const availableBytesNear = (target, { fsModule, statfs }) => {
  try {
    const stats = statfs(nearestExisting(target, fsModule));
    const available = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(available) ? available : null;
  } catch {
    return null;
  }
};

const deviceOf = (target, fsModule) => {
  try {
    return String(fsModule.statSync(nearestExisting(target, fsModule)).dev);
  } catch {
    return null;
  }
};

// The capture filesystem's need, plus the separate-device rollback check when
// a database lives on another filesystem. An unmeasurable filesystem is not a
// refusal (upstream warns and attempts the capture).
const evaluateSpace = ({ captureRoot, families, fsModule, statfs }) => {
  const bytes = families.reduce((sum, family) => sum + family.bytes, 0);
  const largest = families.reduce((max, family) => Math.max(max, family.bytes), 0);
  const neededBytes = bytes === 0 ? 0 : 2 * bytes + 3 * largest + kSpaceReserveBytes;
  const freeBytes = availableBytesNear(captureRoot, { fsModule, statfs });
  const result = { bytes, neededBytes, freeBytes, ok: true, failingPath: null };
  if (freeBytes != null && freeBytes < neededBytes) return { ...result, ok: false, failingPath: captureRoot };
  const captureDevice = deviceOf(captureRoot, fsModule);
  const sources = new Map();
  for (const family of families) {
    const directory = path.dirname(family.path);
    const device = deviceOf(directory, fsModule);
    if (device && device === captureDevice) continue;
    const key = device || directory;
    const source = sources.get(key) || { directory, bytes: 0, largest: 0 };
    source.bytes += family.bytes;
    source.largest = Math.max(source.largest, family.bytes);
    sources.set(key, source);
  }
  for (const source of sources.values()) {
    const sourceFree = availableBytesNear(source.directory, { fsModule, statfs });
    if (sourceFree != null && sourceFree < source.bytes + source.largest + kSpaceReserveBytes) {
      return { ...result, ok: false, failingPath: source.directory };
    }
  }
  return result;
};

// { captureAvailable, failingPath, failingRule, fixable: { canFix, reason },
//   freeBytes, neededBytes, ... }. captureAvailable is null where the port
// cannot judge (Windows/macOS ACLs, no process uid).
const evaluateCapturePreflight = ({
  stateDir,
  databaseFiles = [],
  fsModule = fs,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  platform = process.platform,
  statfs = (target) => fsModule.statfsSync(target),
} = {}) => {
  let symlinked = false;
  try {
    symlinked = fsModule.lstatSync(stateDir).isSymbolicLink();
  } catch {}
  const realStateDir = resolveViaExistingAncestor(stateDir, fsModule);
  const captureRoot = realStateDir + kCaptureSuffix;
  const families = measureDatabaseFamilies(databaseFiles, fsModule);
  const space = evaluateSpace({ captureRoot, families, fsModule, statfs });
  const base = {
    stateDir,
    realStateDir,
    symlinked,
    captureRoot,
    uid: uid ?? null,
    freeBytes: space.freeBytes,
    neededBytes: space.neededBytes,
    captureBytes: space.bytes,
    // Enable snapshots keeps room for two retained captures beside one run's
    // working space: every later Doctor (boot, repair, medic, retry) copies
    // the databases again, and an incomplete capture is never retired.
    enableRequiredBytes: space.bytes === 0 ? 0 : 2 * space.bytes + space.neededBytes,
    stickyTargets: [],
  };
  const verdict = (fields) => ({ ...base, ...fields });
  if (platform === "win32" || platform === "darwin" || uid === undefined) {
    return verdict({
      captureAvailable: null,
      failingPath: null,
      failingRule: kFailingRules.unsupported,
      fixable: { canFix: false, reason: kFixReasons.unsupported },
    });
  }
  let chain;
  try {
    chain = readStagingChain({ captureRoot, fsModule });
  } catch (error) {
    return verdict({
      captureAvailable: false,
      failingPath: error?.path || captureRoot,
      failingRule: kFailingRules.notDirectory,
      fixable: { canFix: false, reason: kFixReasons.foreignOwner },
    });
  }
  const chainVerdict = evaluateStagingChain({ ...chain, uid });
  if (!chainVerdict.ok) {
    const plan = planStickyFix({ ...chain, uid });
    const spaceBlocksFix =
      plan.reason === kFixReasons.sticky &&
      (!space.ok || (space.freeBytes != null && space.freeBytes < base.enableRequiredBytes));
    return verdict({
      captureAvailable: false,
      failingPath: chainVerdict.failingPath,
      failingRule: chainVerdict.failingRule,
      fixable: spaceBlocksFix
        ? { canFix: false, reason: kFixReasons.space }
        : {
            canFix: plan.reason === kFixReasons.sticky,
            reason: plan.reason,
            ...(plan.path && plan.path !== chainVerdict.failingPath ? { path: plan.path } : {}),
          },
      stickyTargets: plan.reason === kFixReasons.sticky ? plan.targets : [],
    });
  }
  if (!chain.root.exists) {
    const parent = chain.ancestors[0]?.path;
    try {
      fsModule.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      return verdict({
        captureAvailable: false,
        failingPath: parent,
        failingRule: kFailingRules.captureRootUncreatable,
        fixable: { canFix: false, reason: kFixReasons.notOwner },
      });
    }
  }
  if (!space.ok) {
    return verdict({
      captureAvailable: false,
      failingPath: space.failingPath,
      failingRule: kFailingRules.space,
      fixable: { canFix: false, reason: kFixReasons.space },
    });
  }
  return verdict({
    captureAvailable: true,
    failingPath: null,
    failingRule: null,
    fixable: { canFix: false, reason: kFixReasons.none },
  });
};

module.exports = {
  kCaptureSuffix,
  kFailingRules,
  kFixReasons,
  kSpaceReserveBytes,
  kStickyBit,
  evaluateCapturePreflight,
  measureDatabaseFamilies,
  evaluateStagingChain,
  identityOf,
  readStagingChain,
};
