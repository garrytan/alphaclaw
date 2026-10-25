const fs = require("fs");
const path = require("path");

// Bounded size census of the directories most likely to fill a volume: each
// root, and every directory one and two levels under it. Allocated bytes
// (st.blocks * 512), lstat only (symlinks are never followed), never leaving
// the root's device. The walk is async, yields to the event loop, and stops
// at a dirent or wall-clock budget; a stopped census is marked truncated and
// its numbers are estimates.
const kCensusMaxEntries = 200_000;
const kCensusMaxMs = 5_000;
const kCensusMaxDepth = 2;
const kCensusMaxDirs = 500;
const kLstatBatch = 64;
const kYieldEvery = 2_000;
// An ancestor is dropped from a ranking when one of its listed descendants
// accounts for at least this share of its number: the deeper directory says
// the same thing more precisely.
const kSpecificShare = 0.8;

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const runCensus = async ({
  roots = [],
  maxEntries = kCensusMaxEntries,
  maxMs = kCensusMaxMs,
  maxDirs = kCensusMaxDirs,
  nowFn = Date.now,
  fsp = fs.promises,
} = {}) => {
  const startedAtMs = nowFn();
  const totals = new Map();
  const rootInfo = [];
  let entryCount = 0;
  let truncatedReason = null;
  const overBudget = () => {
    if (truncatedReason) return true;
    if (entryCount >= maxEntries) truncatedReason = "entries";
    else if (nowFn() - startedAtMs >= maxMs) truncatedReason = "time";
    return truncatedReason !== null;
  };

  for (const root of [...new Set(roots.filter(Boolean).map((entry) => path.resolve(entry)))]) {
    let rootStat;
    try {
      rootStat = await fsp.lstat(root);
    } catch {
      rootInfo.push({ path: root, dev: null, status: "missing" });
      continue;
    }
    if (!rootStat.isDirectory()) {
      rootInfo.push({ path: root, dev: null, status: "not_directory" });
      continue;
    }
    rootInfo.push({ path: root, dev: rootStat.dev, status: "ok" });
    const record = (dirPath, depth) => {
      if (!totals.has(dirPath)) totals.set(dirPath, { path: dirPath, root, rootDev: rootStat.dev, depth, bytes: 0 });
    };
    const add = (owners, bytes) => { for (const owner of owners) totals.get(owner).bytes += bytes; };
    record(root, 0);
    add([root], rootStat.blocks * 512);
    const stack = [{ dir: root, depth: 0, owners: [root] }];
    while (stack.length && !overBudget()) {
      const { dir, depth, owners } = stack.pop();
      let handle;
      try {
        handle = await fsp.opendir(dir);
      } catch {
        continue;
      }
      const children = [];
      try {
        for await (const dirent of handle) {
          entryCount += 1;
          if (dirent.isSymbolicLink()) continue;
          children.push(dirent);
          if (entryCount % kYieldEvery === 0) await yieldToLoop();
          if (overBudget()) break;
        }
      } catch {}
      try { await handle.close(); } catch {}
      for (let index = 0; index < children.length; index += kLstatBatch) {
        if (index > 0 && overBudget()) break;
        const batch = children.slice(index, index + kLstatBatch);
        const stats = await Promise.all(batch.map((dirent) =>
          fsp.lstat(path.join(dir, dirent.name)).catch(() => null)));
        batch.forEach((dirent, offset) => {
          const stat = stats[offset];
          if (!stat || stat.isSymbolicLink() || stat.dev !== rootStat.dev) return;
          const childPath = path.join(dir, dirent.name);
          if (stat.isDirectory()) {
            const childDepth = depth + 1;
            const childOwners = childDepth <= kCensusMaxDepth ? [...owners, childPath] : owners;
            if (childDepth <= kCensusMaxDepth) record(childPath, childDepth);
            add(childOwners, stat.blocks * 512);
            stack.push({ dir: childPath, depth: childDepth, owners: childOwners });
          } else {
            add(owners, stat.blocks * 512);
          }
        });
      }
    }
  }

  const dirs = [...totals.values()].sort((a, b) => b.bytes - a.bytes).slice(0, maxDirs);
  return {
    atMs: startedAtMs,
    durationMs: nowFn() - startedAtMs,
    truncated: truncatedReason !== null,
    truncatedReason,
    entryCount,
    roots: rootInfo,
    dirs,
  };
};

const isDescendant = (child, parent) => child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const mostSpecific = (ranked, valueOf) => ranked.filter((entry) =>
  !ranked.some((other) => isDescendant(other.path, entry.path) && valueOf(other) >= valueOf(entry) * kSpecificShare));

// Top directories by growth against the oldest earlier census, or the
// largest directories when there is no earlier census. dev narrows the
// ranking to the alerting volume (null = every root).
const rankGrowers = ({ latest, baseline = null, dev = null, limit = 5 } = {}) => {
  if (!latest || !Array.isArray(latest.dirs)) return null;
  const onVolume = latest.dirs.filter((entry) => dev === null || entry.rootDev === dev);
  const truncated = Boolean(latest.truncated || baseline?.truncated);
  if (baseline && Array.isArray(baseline.dirs) && baseline.atMs < latest.atMs) {
    const before = new Map(baseline.dirs.map((entry) => [entry.path, entry.bytes]));
    const grown = onVolume
      .map((entry) => ({ path: entry.path, bytes: entry.bytes, growthBytes: entry.bytes - (before.get(entry.path) ?? 0) }))
      .filter((entry) => entry.growthBytes > 0)
      .sort((a, b) => b.growthBytes - a.growthBytes);
    return {
      basis: "growth",
      atMs: latest.atMs,
      windowMs: latest.atMs - baseline.atMs,
      truncated,
      entries: mostSpecific(grown, (entry) => entry.growthBytes).slice(0, limit),
    };
  }
  const largest = onVolume.map((entry) => ({ path: entry.path, bytes: entry.bytes })).sort((a, b) => b.bytes - a.bytes);
  return {
    basis: "largest",
    atMs: latest.atMs,
    windowMs: null,
    truncated,
    entries: mostSpecific(largest, (entry) => entry.bytes).slice(0, limit),
  };
};

module.exports = { runCensus, rankGrowers, kCensusMaxEntries, kCensusMaxMs };
