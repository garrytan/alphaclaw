// Pure matchers over a pending replacement record (runVerifiedRelaunch's
// deferred verifier). No watchdog state: callers pass the record.

const describePendingReplacement = (pending) =>
  pending
    ? {
        pid: pending.launcherPid ?? null,
        source: pending.source,
        intent: pending.intent,
        since: pending.requestedAtMs
          ? new Date(pending.requestedAtMs).toISOString()
          : null,
        deadline: pending.deadlineMs
          ? new Date(pending.deadlineMs).toISOString()
          : null,
      }
    : null;
const observePendingIdentity = (pending, { rootPid = null, workerPid = null, generation = null } = {}) => {
  pending.identityObservedAt = Date.now();
  if (rootPid != null) pending.launcherPid = rootPid;
  if (workerPid != null) pending.workerPid = workerPid;
  if (generation != null) pending.generation = generation;
};
// An exit belongs to the pending child when it names the launcher/worker
// pid or the launch generation. A legacy payload without a pid is the
// managed child by definition (the only child the legacy shape knows).
const pendingMatchesExit = (pending, { pid, workerPid = null, generation = null }) =>
  pid == null ||
  (pending.launcherPid != null &&
    (pid === pending.launcherPid || workerPid === pending.launcherPid)) ||
  (pending.workerPid != null &&
    (pid === pending.workerPid || workerPid === pending.workerPid)) ||
  (generation != null &&
    pending.generation != null &&
    generation === pending.generation);
// A MANAGED launch payload matches by exact generation once ours is known,
// by generation > watermark only while it is not yet known (a handler that
// fired during the launch call, before the result filled it in), or by
// launcher pid. Watermark-before-exact would let a foreign launch (boot,
// the restart route) with a higher generation pass as ours.
// Null-leniency — both sides without a generation — exists for the legacy
// shim + legacy payload pair; production always carries generations.
const pendingMatchesLaunch = (pending, { pid, rootPid, generation, supervision }) => {
  if (supervision === "adopted" || supervision === "detached") return false;
  if (generation != null && pending.generation != null) {
    return generation === pending.generation;
  }
  if (
    generation != null &&
    pending.generationWatermark != null &&
    generation > pending.generationWatermark
  ) {
    return true;
  }
  const launcher = rootPid ?? pid ?? null;
  if (launcher != null && pending.launcherPid != null) {
    return launcher === pending.launcherPid;
  }
  return (
    generation == null &&
    pending.generation == null &&
    pending.generationWatermark == null
  );
};

module.exports = {
  describePendingReplacement,
  observePendingIdentity,
  pendingMatchesExit,
  pendingMatchesLaunch,
};
