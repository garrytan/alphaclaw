// Disk use of the box by folder (ALPH-40): the volumes, the state directory's
// top-level folders, the temporary copies each feature leaves behind, and,
// on request, which processes hold files open under a path (deleted files
// included, since their space is only freed when the last holder closes them).
//
// Bounds: one size census (lib/server/disk-space/growers.js: lstat only,
// never following a symlink or leaving the root's device) over the state
// directory and the copy folders, stopped at 200,000 entries or 3 s and
// cached 5 minutes, single-flight. The open-files scan reads at most 4,096
// pids and 100,000 descriptors within 750 ms and returns 100 processes with
// 20 paths each; it is cached 5 s per path. Nothing here deletes anything.
const fs = require("fs");
const path = require("path");
const { readDiskVolumes } = require("../disk-space/sampler");
const { runCensus } = require("../disk-space/growers");
const { listSnapshotDirectories } = require("../openclaw-snapshot-sweep");
const { planRetention, getLastRetentionSweep } = require("../copy-retention");

const kCensusMaxEntries = 200_000;
const kCensusMaxMs = 3_000;
const kCensusCacheMs = 5 * 60_000;
const kMaxTopLevel = 100;
const kMaxGroupItems = 50;
const kMaxDirectoryNames = 2_000;
const kOpenScanMaxPids = 4_096;
const kOpenScanMaxFds = 100_000;
const kOpenScanMaxMs = 750;
const kOpenCacheMs = 5_000;
const kMaxOpenProcesses = 100;
const kMaxPathsPerProcess = 20;
const kMaxPathChars = 300;
const kMaxOpenUnderChars = 512;
const kDeletedSuffix = " (deleted)";
const kConfigBackupPattern = /^openclaw\.json\.(bak(\.\d+)?|pre-doctor(-\d+)?\.bak|medic-.+\.bak|last-good\.quarantined-.+)$/;
const kPackageBackupPattern = /^\.openclaw\.(package|shim)-backup-/;

const toIso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const clip = (text) => (text.length > kMaxPathChars ? text.slice(0, kMaxPathChars - 1) + "…" : text);

const parseOpenUnder = (raw) => {
  if (raw == null || raw === "") return { value: null };
  if (typeof raw !== "string" || raw.length > kMaxOpenUnderChars || raw.includes("\0") || !path.isAbsolute(raw)) {
    return { error: "openUnder is an absolute path of at most " + kMaxOpenUnderChars + " characters" };
  }
  return { value: path.resolve(raw) };
};

const listNames = (dir, fsModule) => {
  try {
    return fsModule.readdirSync(dir).slice(0, kMaxDirectoryNames);
  } catch {
    return null;
  }
};

const createDiskReader = ({
  resolveStateDir,
  backupsDir,
  resolveEnv = () => process.env,
  readVolumes = readDiskVolumes,
  census = runCensus,
  listSnapshots = listSnapshotDirectories,
  planCopyRetention = planRetention,
  getLastSweep = getLastRetentionSweep,
  fsModule = fs,
  procRoot = "/proc",
  nowFn = Date.now,
} = {}) => {
  let censusCache = null;
  const openCache = new Map();

  const realpath = (target) => {
    try { return fsModule.realpathSync(target); } catch { return path.resolve(target); }
  };

  // Each feature's copies: a name, what makes them, and the folders or files.
  const locateGroups = (stateDir, env) => {
    const parent = path.dirname(stateDir);
    const captureStore = stateDir + ".update-captures";
    const statePath = (name) => path.join(stateDir, name);
    let snapshots = [];
    try { snapshots = listSnapshots({ env }).map(({ directory }) => directory); } catch {}
    return [
      { id: "openclaw_snapshot_copies", title: "OpenClaw SQLite read-only snapshot copies", kind: "dirs", items: snapshots },
      { id: "openclaw_update_captures", title: "OpenClaw Doctor and update state captures", kind: "dirs", items: (listNames(captureStore, fsModule) || []).map((name) => path.join(captureStore, name)) },
      { id: "openclaw_package_backups", title: "OpenClaw package and shim backups", kind: "dirs", items: (listNames(parent, fsModule) || []).filter((name) => kPackageBackupPattern.test(name)).map((name) => path.join(parent, name)) },
      { id: "config_backups", title: "openclaw.json backups (Doctor, medic, rotation)", kind: "files", items: (listNames(stateDir, fsModule) || []).filter((name) => kConfigBackupPattern.test(name)).map(statePath) },
      { id: "alphaclaw_backups", title: "Back up now archives", kind: "mixed", items: backupsDir ? (listNames(backupsDir, fsModule) || []).map((name) => path.join(backupsDir, name)) : [] },
    ];
  };

  const collect = async () => {
    const startedAtMs = nowFn();
    const env = resolveEnv() || process.env;
    const stateDir = realpath(resolveStateDir());
    const groups = locateGroups(stateDir, env);
    const items = groups.flatMap((group) => group.items.map((item) => {
      let stat = null;
      try { stat = fsModule.lstatSync(item); } catch {}
      return { group, item, stat };
    })).filter(({ stat }) => stat && !stat.isSymbolicLink());
    const dirRoots = items.filter(({ stat }) => stat.isDirectory()).map(({ item }) => item);
    let result = null;
    try {
      result = await census({ roots: [stateDir, ...dirRoots], maxEntries: kCensusMaxEntries, maxMs: kCensusMaxMs, maxDirs: kCensusMaxEntries });
    } catch {}
    const bytesOf = new Map((result?.dirs || []).map((entry) => [entry.path, entry.bytes]));
    const stateRoot = (result?.roots || []).find((root) => root.path === stateDir);
    const topLevel = (result?.dirs || [])
      .filter((entry) => entry.root === stateDir && entry.depth === 1)
      .map((entry) => ({ name: path.basename(entry.path), bytes: entry.bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    const stateBytes = bytesOf.get(stateDir) ?? null;
    const dirBytes = topLevel.reduce((sum, entry) => sum + entry.bytes, 0);

    let plan = null;
    try { plan = planCopyRetention({ backupsDir, stateDir, env }); } catch {}
    const verdicts = new Map();
    const retentionOf = new Map();
    for (const family of plan?.families || []) {
      for (const entry of family.entries) verdicts.set(entry.path, entry.reason ? entry.verdict + ":" + entry.reason : entry.verdict);
      retentionOf.set(family.id, { keep: plan.policy.keep, days: plan.policy.days, due: family.entries.filter((entry) => entry.verdict === "due").length });
    }
    const byGroup = new Map(groups.map((group) => [group.id, []]));
    for (const { group, item, stat } of items) {
      const bytes = stat.isDirectory() ? bytesOf.get(item) ?? null : Number(stat.blocks) > 0 ? Number(stat.blocks) * 512 : Number(stat.size) || 0;
      const entry = { name: path.basename(item), directory: stat.isDirectory(), bytes, modifiedAt: toIso(stat.mtimeMs), mtimeMs: stat.mtimeMs };
      if (retentionOf.has(group.id)) entry.retention = verdicts.get(item) ?? "not_managed:name";
      byGroup.get(group.id).push(entry);
    }
    return {
      atMs: startedAtMs,
      census: {
        at: toIso(startedAtMs),
        durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
        status: !result ? "failed" : result.truncated ? "partial" : "ok",
        reason: result?.truncatedReason ?? null,
        entries: result?.entryCount ?? 0,
      },
      stateDir: {
        path: stateDir,
        status: stateRoot?.status ?? "unknown",
        bytes: stateBytes,
        topLevelFilesBytes: stateBytes === null ? null : Math.max(0, stateBytes - dirBytes),
        total: topLevel.length,
        entries: topLevel.slice(0, kMaxTopLevel),
      },
      temp: groups.map((group) => {
        const entries = byGroup.get(group.id).sort((a, b) => b.mtimeMs - a.mtimeMs);
        const known = entries.filter((entry) => entry.bytes !== null);
        return {
          id: group.id,
          title: group.title,
          count: entries.length,
          bytes: known.reduce((sum, entry) => sum + entry.bytes, 0),
          unmeasured: entries.length - known.length,
          newestAt: entries[0]?.modifiedAt ?? null,
          oldestAt: entries[entries.length - 1]?.modifiedAt ?? null,
          ...(retentionOf.has(group.id) ? { retention: retentionOf.get(group.id) } : {}),
          items: entries.slice(0, kMaxGroupItems).map(({ mtimeMs, ...entry }) => entry),
        };
      }),
    };
  };

  const readCensus = () => {
    const now = nowFn();
    if (censusCache && now >= censusCache.atMs && now - censusCache.atMs < kCensusCacheMs) return censusCache.promise;
    const promise = collect();
    censusCache = { atMs: now, promise };
    promise.catch(() => { if (censusCache?.promise === promise) censusCache = null; });
    return promise;
  };

  // Who holds files open under prefix, from /proc/<pid>/fd. A deleted file's
  // link reads "<path> (deleted)"; its size comes from stat through the fd.
  const scanOpenFiles = (prefix) => {
    const startedAtMs = nowFn();
    const within = (target) => target === prefix || target.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
    let pids;
    try {
      pids = fsModule.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
    } catch {
      return { under: prefix, status: "unavailable", reason: "no_proc", processes: [] };
    }
    let reason = null;
    if (pids.length > kOpenScanMaxPids) {
      reason = "pid_cap";
      pids = pids.slice(0, kOpenScanMaxPids);
    }
    let fdCount = 0;
    let denied = 0;
    const processes = [];
    for (const pid of pids) {
      if (reason === null && nowFn() - startedAtMs > kOpenScanMaxMs) reason = "time_budget";
      if (reason === "time_budget" || reason === "fd_cap") break;
      const fdDir = path.join(procRoot, pid, "fd");
      let fds;
      try {
        fds = fsModule.readdirSync(fdDir);
      } catch {
        denied += 1;
        continue;
      }
      const holder = { pid: Number(pid), comm: null, files: 0, deleted: 0, deletedBytes: 0, paths: [] };
      const seen = new Set();
      for (const fd of fds) {
        fdCount += 1;
        if (fdCount > kOpenScanMaxFds) { reason = "fd_cap"; break; }
        let target;
        try { target = fsModule.readlinkSync(path.join(fdDir, fd)); } catch { continue; }
        const deleted = target.endsWith(kDeletedSuffix);
        const filePath = deleted ? target.slice(0, -kDeletedSuffix.length) : target;
        if (!filePath.startsWith("/") || !within(filePath)) continue;
        holder.files += 1;
        if (deleted) {
          holder.deleted += 1;
          try { holder.deletedBytes += Number(fsModule.statSync(path.join(fdDir, fd)).size) || 0; } catch {}
        }
        if (!seen.has(target) && holder.paths.length < kMaxPathsPerProcess) {
          seen.add(target);
          holder.paths.push({ path: clip(filePath), deleted });
        }
      }
      if (holder.files === 0) continue;
      try { holder.comm = String(fsModule.readFileSync(path.join(procRoot, pid, "comm"), "utf8")).trim().slice(0, 64); } catch {}
      processes.push(holder);
    }
    processes.sort((a, b) => b.deletedBytes - a.deletedBytes || b.files - a.files);
    return {
      under: prefix,
      status: reason ? "partial" : "ok",
      reason,
      unreadableProcesses: denied,
      deletedBytes: processes.reduce((sum, entry) => sum + entry.deletedBytes, 0),
      total: processes.length,
      processes: processes.slice(0, kMaxOpenProcesses),
    };
  };

  const readOpenFiles = (prefix) => {
    const now = nowFn();
    const cached = openCache.get(prefix);
    if (cached && now >= cached.atMs && now - cached.atMs < kOpenCacheMs) return cached.value;
    const value = scanOpenFiles(prefix);
    openCache.clear();
    openCache.set(prefix, { atMs: now, value });
    return value;
  };

  const read = async ({ openUnder = null } = {}) => {
    const env = resolveEnv() || process.env;
    let volumes = [];
    try { volumes = readVolumes({ stateDir: resolveStateDir(), env }); } catch {}
    const { atMs, ...usage } = await readCensus();
    let sweep = null;
    try { sweep = getLastSweep(); } catch {}
    return {
      ok: true,
      volumes: volumes.map(({ dev, ...volume }) => volume),
      ...usage,
      temp: usage.temp.map((group) => (group.retention ? {
        ...group,
        retention: {
          ...group.retention,
          lastSweep: sweep ? { at: sweep.at, removed: sweep.byFamily?.[group.id]?.removed ?? 0, freedBytes: sweep.byFamily?.[group.id]?.freedBytes ?? 0, held: sweep.held, failed: sweep.failed } : null,
        },
      } : group)),
      openFiles: openUnder ? readOpenFiles(openUnder) : null,
    };
  };

  return { read };
};

module.exports = { createDiskReader, parseOpenUnder };
