// One boot id per OS process.
//
// Several persisted records need to answer "was this written by the process
// that is running now?": the restart-operation record (a `running` record from
// another boot can never complete), boot-report.json (the server phase merges
// only into the report THIS process's bin phase wrote) and
// configMigration.lastRestore (undo only a restore this boot performed). They
// must all compare against ONE value, so it lives here and is memoized on
// first use. The `${pid}:${startMs}` shape is what restart-required-state.js
// has persisted since the operation record was introduced; keeping it means
// records already on disk stay comparable.
//
// Not process.pid alone: a container restart reuses low pids, so a record
// from the previous PID 7 must still read as foreign to the new PID 7.

let memoizedBootId = null;

// `nowFn` is a seam for tests that want a known value; it is consulted only
// on the first call of a process (or after resetProcessBootIdForTests).
const getProcessBootId = ({ nowFn = Date.now } = {}) => {
  if (memoizedBootId === null) {
    memoizedBootId = `${process.pid}:${nowFn()}`;
  }
  return memoizedBootId;
};

// Test seam only: production code never resets the id mid-process — every
// record written after a reset would read as foreign to the ones before it.
const resetProcessBootIdForTests = () => {
  memoizedBootId = null;
};

module.exports = {
  getProcessBootId,
  resetProcessBootIdForTests,
};
