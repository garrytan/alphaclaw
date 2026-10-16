// "Enable snapshots": the one permission change AlphaClaw makes so OpenClaw's
// Doctor can keep its pre-repair capture — chmod +t on exactly the ancestor
// directories the ported staging rule (openclaw-capture-preflight.js) names.
// Admin-only and confirm-gated (admin manifest: dangerous); it never runs on
// its own.
//
//   proposal  built from a fresh preflight: each directory's canonical path,
//             device/inode, owner and old/new mode (old | S_ISVTX — group and
//             other bits are never touched), plus the per-run capture size
//             and retention the confirm shows. proposalId hashes all of it.
//   execute   rebuilds the proposal and refuses unless it hashes the same;
//             opens every directory O_DIRECTORY|O_NOFOLLOW and re-checks the
//             identity and mode on the handle (a substituted symlink or a
//             changed directory refuses); requires the process uid to own the
//             directory (or root); re-runs the ported rule with the new modes
//             on those identities; refuses when free space cannot hold two
//             captures plus one run's working space; then fchmods through the
//             verified handles. A failure on directory N restores 1..N-1
//             through the same handles, but only where the mode is still the
//             one this operation wrote, and reports the path and errno with
//             every directory's mode as re-read from its handle.
// Every change and rollback is logged with the old and new mode.
const crypto = require("crypto");
const fs = require("fs");
const {
  evaluateCapturePreflight,
  evaluateStagingChain,
  identityOf,
  readStagingChain,
} = require("./openclaw-capture-preflight");

// OpenClaw retires a sealed standalone Doctor capture after 30 days
// (STANDALONE_DOCTOR_CAPTURE_RETENTION_MS); an incomplete one stays until it
// is removed by hand.
const kCaptureRetentionDays = 30;

const octal = (mode) => "0" + (Number(mode) & 0o7777).toString(8);

const buildSnapshotEnableProposal = (preflight) => {
  if (preflight?.captureAvailable === true) {
    return { ok: false, code: "already_available", error: "OpenClaw can already take a safety snapshot here." };
  }
  if (!preflight?.fixable?.canFix || !preflight.stickyTargets?.length) {
    return {
      ok: false,
      code: "not_fixable",
      reason: preflight?.fixable?.reason || "unsupported",
      failingPath: preflight?.failingPath || null,
      failingRule: preflight?.failingRule || null,
      error: "Setting the sticky bit would not let OpenClaw take a snapshot here.",
    };
  }
  if (preflight.freeBytes != null && preflight.freeBytes < preflight.enableRequiredBytes) {
    return {
      ok: false,
      code: "insufficient_space",
      freeBytes: preflight.freeBytes,
      enableRequiredBytes: preflight.enableRequiredBytes,
      error: "The data volume does not have room for two snapshots plus one Doctor run.",
    };
  }
  const dirs = preflight.stickyTargets.map((target) => ({
    path: target.path,
    dev: target.dev,
    ino: target.ino,
    uid: target.uid,
    gid: target.gid,
    oldMode: octal(target.mode),
    newMode: octal(target.newMode),
  }));
  const proposalId = crypto
    .createHash("sha256")
    .update(JSON.stringify({ captureRoot: preflight.captureRoot, dirs }))
    .digest("hex")
    .slice(0, 32);
  return {
    ok: true,
    proposalId,
    dirs,
    captureRoot: preflight.captureRoot,
    captureBytes: preflight.captureBytes,
    retentionDays: kCaptureRetentionDays,
    freeBytes: preflight.freeBytes,
    enableRequiredBytes: preflight.enableRequiredBytes,
  };
};

const applySnapshotEnable = ({
  proposalId,
  stateDir,
  databaseFiles = [],
  fsModule = fs,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  evaluate = (options) => evaluateCapturePreflight(options),
  logger = console,
} = {}) => {
  const preflight = evaluate({ stateDir, databaseFiles, fsModule, uid });
  const proposal = buildSnapshotEnableProposal(preflight);
  if (!proposal.ok) return { ...proposal, changed: [] };
  if (proposal.proposalId !== proposalId) {
    return {
      ok: false,
      code: "proposal_stale",
      error: "The folders or their permissions changed since this was proposed. Review the new proposal.",
      proposal,
      changed: [],
    };
  }
  const handles = [];
  const closeAll = () => {
    for (const handle of handles) {
      try {
        fsModule.closeSync(handle.fd);
      } catch {}
    }
  };
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    for (const dir of proposal.dirs) {
      let fd;
      try {
        fd = fsModule.openSync(dir.path, flags);
      } catch (error) {
        return { ok: false, code: "identity_changed", path: dir.path, errno: error?.code || null, error: "Couldn't open " + dir.path + " as a real directory.", changed: [] };
      }
      const identity = identityOf(fsModule.fstatSync(fd));
      handles.push({ dir, fd, identity });
      if (!identity.directory || identity.dev !== dir.dev || identity.ino !== dir.ino || identity.uid !== dir.uid || octal(identity.mode) !== dir.oldMode) {
        return { ok: false, code: "identity_changed", path: dir.path, error: dir.path + " changed since it was checked.", changed: [] };
      }
      if (uid !== 0 && identity.uid !== uid) {
        return { ok: false, code: "not_owner", path: dir.path, error: "AlphaClaw does not own " + dir.path + ", so it cannot change it.", changed: [] };
      }
    }
    const chain = readStagingChain({ captureRoot: proposal.captureRoot, fsModule });
    const simulated = evaluateStagingChain({
      root: chain.root,
      uid,
      ancestors: chain.ancestors.map((ancestor) => {
        const handle = handles.find((entry) => entry.dir.path === ancestor.path);
        return handle ? { ...ancestor, identity: { ...handle.identity, mode: Number.parseInt(handle.dir.newMode, 8) } } : ancestor;
      }),
    });
    if (!simulated.ok) {
      return { ok: false, code: "simulation_failed", path: simulated.failingPath, failingRule: simulated.failingRule, error: "OpenClaw would still refuse " + simulated.failingPath + " after the change.", changed: [] };
    }
    const changed = [];
    for (const handle of handles) {
      const newMode = Number.parseInt(handle.dir.newMode, 8);
      try {
        fsModule.fchmodSync(handle.fd, newMode);
        changed.push(handle);
        logger.log?.("[alphaclaw] snapshots: chmod +t " + handle.dir.path + " mode " + handle.dir.oldMode + " → " + handle.dir.newMode);
      } catch (error) {
        const rolledBack = [];
        const rollbackFailed = [];
        for (const done of changed.reverse()) {
          try {
            const current = octal(fsModule.fstatSync(done.fd).mode);
            if (current !== done.dir.newMode) {
              rollbackFailed.push({ path: done.dir.path, mode: current, reason: "changed_by_someone_else" });
              continue;
            }
            fsModule.fchmodSync(done.fd, Number.parseInt(done.dir.oldMode, 8));
            rolledBack.push({ path: done.dir.path, mode: done.dir.oldMode });
            logger.log?.("[alphaclaw] snapshots: rolled back " + done.dir.path + " mode " + done.dir.newMode + " → " + done.dir.oldMode);
          } catch (rollbackError) {
            rollbackFailed.push({ path: done.dir.path, reason: rollbackError?.code || "error" });
          }
        }
        const modes = handles.map((entry) => {
          try {
            return { path: entry.dir.path, mode: octal(fsModule.fstatSync(entry.fd).mode) };
          } catch {
            return { path: entry.dir.path, mode: null };
          }
        });
        logger.warn?.("[alphaclaw] snapshots: chmod +t " + handle.dir.path + " failed (" + (error?.code || error?.message) + "); " + rolledBack.length + " rolled back, " + rollbackFailed.length + " not");
        return {
          ok: false,
          code: "chmod_failed",
          path: handle.dir.path,
          errno: error?.code || null,
          error: "Couldn't change " + handle.dir.path + " (" + (error?.code || "error") + ").",
          changed: modes.filter((entry, index) => entry.mode !== handles[index].dir.oldMode),
          rolledBack,
          rollbackFailed,
          modes,
        };
      }
    }
    const after = evaluate({ stateDir, databaseFiles, fsModule, uid });
    return {
      ok: true,
      changed: changed.map((handle) => ({ path: handle.dir.path, oldMode: handle.dir.oldMode, newMode: handle.dir.newMode })),
      captureAvailable: after.captureAvailable,
      preflight: after,
    };
  } finally {
    closeAll();
  }
};

module.exports = {
  kCaptureRetentionDays,
  applySnapshotEnable,
  buildSnapshotEnableProposal,
};
