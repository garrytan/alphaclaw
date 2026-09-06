// Keep-the-newest-N retention for a family of sibling files.
//
//   pruneFilesMatching({ fsModule, dir, pattern, keep, rank })
//
// Every entry of `dir` whose basename matches `pattern` is a member; the
// members are ordered by `rank` ascending (lower rank = kept first; default
// 0 for all) and then by mtime descending, and everything past the first
// `keep` is unlinked. Best-effort by design: a missing directory, an
// unstat-able entry or a failed unlink is swallowed — retention is
// housekeeping and must never turn the write that triggered it into a
// failure. Returns the basenames removed.
//
// One helper for every "<file>.<kind>-<stamp>.bak keep 3" family (the config
// gate's pre-fix / pre-restore snapshots, doctor-guard's pre-doctor copies,
// the config-gate key-path diffs) so retention semantics cannot drift between
// modules.

const path = require("path");

const pruneFilesMatching = ({
  fsModule,
  dir,
  pattern,
  keep,
  rank = () => 0,
} = {}) => {
  const removed = [];
  if (!fsModule || !dir || !(pattern instanceof RegExp)) return removed;
  const keepCount = Number.isInteger(keep) && keep >= 0 ? keep : 0;
  let entries;
  try {
    entries = fsModule
      .readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fsModule.statSync(path.join(dir, name)).mtimeMs;
        } catch {}
        let order = 0;
        try {
          order = Number(rank(name)) || 0;
        } catch {}
        return { name, mtimeMs, order };
      })
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return b.mtimeMs - a.mtimeMs;
      });
  } catch {
    return removed;
  }
  for (const extra of entries.slice(keepCount)) {
    try {
      fsModule.unlinkSync(path.join(dir, extra.name));
      removed.push(extra.name);
    } catch {}
  }
  return removed;
};

module.exports = { pruneFilesMatching };
