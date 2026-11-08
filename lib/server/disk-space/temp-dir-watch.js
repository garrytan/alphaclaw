const fs = require("fs");
const os = require("os");
const path = require("path");
const constants = require("../constants");
const { resolveOpenclawCompileCacheDir } = require("../openclaw-runtime-env");
const { redactCommandLine } = require("../utils/redact");
const { formatBytes, formatDuration, flattenPath } = require("./notice");

// /tmp safety net. Render replaces the whole instance when its /tmp (its own
// 2 GB mount) passes the limit, and the processes that fill it are agent
// commands and cron scripts that hard-code /tmp, which no environment
// variable can redirect (Nov 8: a cron job extracted two 1,072 MB
// `git archive` copies into /tmp/xrs and finished 37 s before the kill).
//
// Every 2 s the watchdog reads /tmp with one statfs, a single syscall. A
// writer like that cron job crosses the last 500 MB before the limit in
// seconds, so a 30 s sample would usually land after the kill. Below the
// alert line that is all it does. At the alert line (about 1.47 GB) it sizes
// the top-level entries (a bounded du), finds who holds what open from
// /proc/*/fd, cwd and maps, and tells the owner once per episode. At the
// eviction line (about 1.73 GB, on by default on Render only)
// it evicts, in the same sample, the oldest large entries that no process
// holds open until /tmp is back under the alert line. Inside a directory a
// process still uses (a job's cwd, a file being written) it looks one level
// deeper, up to four levels, for subtrees nobody holds: a finished copy next
// to the one still being written can go.
//
// statfs is trusted only when /tmp is its own mount no larger than 8 GB (a
// sized tmpfs or a quota'd volume, as on Render). Anywhere else statfs
// describes a whole shared disk: on Render the watch then sizes /tmp with the
// bounded du every 30 s instead, and elsewhere it stays idle.
//
// Evict means move, with delete as the fallback. A rename into
// <data dir>/tmp/evicted-<ts>/ is instant on the same filesystem. Across
// mounts a move is a copy, and the space is freed only once the copy is
// done, so an entry is copied only when it is at most 256 MB (a few seconds
// of copying) and the data volume keeps 2 GB free after it; anything else is
// deleted. Never evicted: anything a process holds open or has as its cwd or
// a mapped file (checked again right before each eviction), sockets, FIFOs,
// symlinks, pid and lock files and any directory holding one, AlphaClaw's and
// OpenClaw's own temp entries, tmux sockets, the Node compile cache and
// AlphaClaw's own TMPDIR. If any process's open files cannot be read, nothing
// is evicted. Deleted files that a process still holds open take space no
// eviction can free; the alert names their holders.
const kGiB = 1024 ** 3;
const kMiB = 1024 ** 2;
const kTmpPath = "/tmp";
const kStatfsMaxSizeBytes = 8 * kGiB;
const kClearFraction = 0.8;
const kClearSamples = 2;
const kEvictMinBytes = kMiB;
const kEvictMaxDepth = 4;
const kMoveMaxBytes = 256 * kMiB;
const kMoveFreeReserveBytes = 2 * kGiB;
const kMeasureMaxEntries = 200_000;
const kMeasureMaxMs = 5_000;
const kTopEntries = 3;
// A failed alert is retried at most once a minute while the episode lasts.
const kAlertRetryMs = 60_000;
const kMaxCommandChars = 100;
// After a pass that cannot get /tmp under the alert line, the size walk and
// the /proc scan rerun at most this often, unless usage moves by more than
// kBackoffChangeBytes or comes back over the eviction line.
const kHighBackoffMs = 30_000;
const kBackoffChangeBytes = 100 * kMiB;
// A process that exits mid-scan; any other failed read leaves the scan
// incomplete, and an incomplete scan evicts nothing.
const kProcessGoneCodes = new Set(["ENOENT", "ESRCH"]);
const kProtectedNamePattern = /^(?:alphaclaw|\.?openclaw|oc-br-|tmux-|node-compile-cache|v8-compile-cache|systemd-private-|hsperfdata_|\.X11-unix|\.ICE-unix|\.XIM-unix|\.font-unix|\.Test-unix)/;
const kSensitiveNamePattern = /(?:\.pid|\.lock|\.lck|\.sock|\.socket)$|^lock$/i;

const isRender = (env) => Boolean(env?.RENDER || env?.RENDER_SERVICE_ID);

const resolveTmpEvictEnabled = (env = process.env, setting = constants.kTmpEvictSetting) => {
  if (/^(?:on|true|1|yes)$/.test(setting)) return true;
  if (/^(?:off|false|0|no)$/.test(setting)) return false;
  return isRender(env);
};

const readTmpStatfs = (tmpPath) => {
  const stat = fs.statSync(tmpPath);
  const parent = fs.statSync(path.dirname(tmpPath));
  const statfs = fs.statfsSync(tmpPath);
  const blockSize = Number(statfs.bsize);
  return {
    ownMount: stat.dev !== parent.dev,
    sizeBytes: Number(statfs.blocks) * blockSize,
    usedBytes: (Number(statfs.blocks) - Number(statfs.bfree)) * blockSize,
  };
};

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const typeOf = (stat) => (stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "special");

// Allocated bytes and newest mtime per top-level entry, lstat only, never
// leaving /tmp's device. A directory holding a socket, FIFO, pid or lock file
// is marked sensitive, and so is one holding a mount (another device). A walk
// stopped by its budget is marked truncated; the entry it stopped inside, and
// one with a subdirectory it could not read, is marked partial.
const measureTmpEntries = async (tmpPath, { maxEntries = kMeasureMaxEntries, maxMs = kMeasureMaxMs, nowFn = Date.now } = {}) => {
  const startedAtMs = nowFn();
  const rootStat = await fs.promises.lstat(tmpPath);
  let seen = 0;
  let truncated = false;
  const overBudget = () => {
    if (!truncated && (seen >= maxEntries || nowFn() - startedAtMs >= maxMs)) truncated = true;
    return truncated;
  };
  const walk = async (target, stat, acc) => {
    seen += 1;
    if (seen % 2_000 === 0) await yieldToLoop();
    acc.bytes += stat.blocks * 512;
    acc.newestMtimeMs = Math.max(acc.newestMtimeMs, stat.mtimeMs);
    const type = typeOf(stat);
    if (type === "special" || kSensitiveNamePattern.test(path.basename(target))) acc.sensitive = true;
    if (type !== "dir") return;
    let names = [];
    try {
      names = await fs.promises.readdir(target);
    } catch (error) {
      if (error?.code !== "ENOENT") acc.partial = true;
      return;
    }
    for (const name of names) {
      if (overBudget()) return;
      const child = path.join(target, name);
      let childStat;
      try {
        childStat = await fs.promises.lstat(child);
      } catch (error) {
        if (error?.code !== "ENOENT") acc.partial = true;
        continue;
      }
      if (childStat.dev !== rootStat.dev) {
        acc.sensitive = true;
        continue;
      }
      await walk(child, childStat, acc);
    }
  };
  const entries = [];
  for (const name of await fs.promises.readdir(tmpPath)) {
    if (overBudget()) break;
    const entryPath = path.join(tmpPath, name);
    let stat;
    try { stat = await fs.promises.lstat(entryPath); } catch { continue; }
    const acc = { bytes: 0, newestMtimeMs: 0, sensitive: stat.dev !== rootStat.dev, partial: false };
    await walk(entryPath, stat, acc);
    entries.push({ name, path: entryPath, type: typeOf(stat), ...acc, partial: acc.partial || truncated });
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  return { entries, totalBytes: rootStat.blocks * 512 + entries.reduce((sum, entry) => sum + entry.bytes, 0), truncated };
};

const readCommand = (procDir) => {
  try {
    const argv = fs.readFileSync(path.join(procDir, "cmdline"), "utf8").split("\0").filter(Boolean);
    if (argv.length) return redactCommandLine(argv.join(" ")).replace(/\s+/g, " ").slice(0, kMaxCommandChars);
  } catch {}
  try { return fs.readFileSync(path.join(procDir, "comm"), "utf8").trim(); } catch { return null; }
};

// Every process that holds something under tmpPath: an open file (a deleted
// one with its allocated size), its cwd or a mapped file. complete is false
// when some process's fds could not be read, and null comes back without a
// readable /proc.
const scanTmpHolders = (tmpPath, { procRoot = "/proc" } = {}) => {
  let pids;
  try {
    pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const under = (target) => target === tmpPath || target.startsWith(tmpPath + "/");
  const holders = [];
  let complete = true;
  for (const pid of pids) {
    const dir = path.join(procRoot, pid);
    let fds;
    try {
      fds = fs.readdirSync(path.join(dir, "fd"));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") complete = false;
      continue;
    }
    const found = new Map();
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(path.join(dir, "fd", fd));
      } catch (error) {
        if (!kProcessGoneCodes.has(error?.code)) complete = false;
        continue;
      }
      const deleted = target.endsWith(" (deleted)");
      const held = deleted ? target.slice(0, -" (deleted)".length) : target;
      if (!under(held) || found.has(held)) continue;
      let bytes = null;
      if (deleted) {
        try { bytes = fs.statSync(path.join(dir, "fd", fd)).blocks * 512; } catch {}
      }
      found.set(held, { kind: deleted ? "deleted" : "open", bytes });
    }
    try {
      const cwd = fs.readlinkSync(path.join(dir, "cwd"));
      if (under(cwd) && !found.has(cwd)) found.set(cwd, { kind: "cwd", bytes: null });
    } catch (error) {
      if (!kProcessGoneCodes.has(error?.code)) complete = false;
    }
    try {
      for (const line of fs.readFileSync(path.join(dir, "maps"), "utf8").split("\n")) {
        const mapped = line.split(/\s+/).slice(5).join(" ").replace(/ \(deleted\)$/, "");
        if (mapped && under(mapped) && !found.has(mapped)) found.set(mapped, { kind: "map", bytes: null });
      }
    } catch (error) {
      if (!kProcessGoneCodes.has(error?.code)) complete = false;
    }
    if (!found.size) continue;
    const command = readCommand(dir);
    for (const [held, info] of found) holders.push({ pid: Number(pid), command, path: held, ...info });
  }
  return { holders, complete };
};

const holdersOf = (entryPath, holders) =>
  holders.filter((holder) => holder.path === entryPath || holder.path.startsWith(entryPath + "/"));

const uniquePids = (holders) => [...new Map(holders.map((holder) => [holder.pid, holder])).values()];

const describeHolder = (holder) => `pid ${holder.pid}${holder.command ? ` (\`${flattenPath(holder.command)}\`)` : ""}`;

const createTmpWatch = ({
  env = process.env,
  tmpPath = kTmpPath,
  alertBytes: configuredAlertBytes = constants.kTmpAlertBytes,
  evictBytes = constants.kTmpEvictBytes,
  evictEnabled = resolveTmpEvictEnabled(env),
  intervalMs = constants.kTmpWatchIntervalMs,
  duIntervalMs = constants.kTmpWatchDuIntervalMs,
  evictRoot = path.join(constants.kRootDir, "tmp"),
  protectedPaths = [resolveOpenclawCompileCacheDir(env), os.tmpdir(), constants.kRootDir],
  readStatfs = readTmpStatfs,
  measure = (root) => measureTmpEntries(root),
  scanHolders = (root) => scanTmpHolders(root),
  readFreeBytes = (dir) => {
    const statfs = fs.statfsSync(dir);
    return Number(statfs.bavail) * Number(statfs.bsize);
  },
  renameEntry = (from, to) => fs.renameSync(from, to),
  nowFn = Date.now,
  logEvent = () => {},
  notify = async () => ({ ok: false }),
  withViewLogsSuffix = (line) => line,
  createCorrelationId = () => "",
} = {}) => {
  const alertBytes = Math.min(configuredAlertBytes, evictBytes);
  const isProtected = (entry) =>
    entry.type === "symlink" || entry.type === "special" || entry.sensitive || entry.partial ||
    kProtectedNamePattern.test(entry.name) || kSensitiveNamePattern.test(entry.name) ||
    protectedPaths.filter(Boolean).some((kept) => {
      const resolved = path.resolve(kept);
      return resolved === entry.path || resolved.startsWith(entry.path + "/");
    });

  let state = "ok";
  let episodeId = null;
  let episodeOpenedAtMs = null;
  let notified = false;
  let lastAlertAttemptMs = -Infinity;
  let alertInFlight = false;
  let backoff = null;
  let shortfallNotified = false;
  let evictSkipLogged = false;
  let clearStreak = 0;
  let last = null;
  let timer = null;
  let stopped = true;
  let tickInFlight = null;

  const log = (status, details) => {
    try { logEvent("disk", "tmp-watch", status, { path: tmpPath, episodeId, ...details }, createCorrelationId()); } catch {}
  };
  const send = async (lines) => {
    try {
      const result = await notify(["🐺 *AlphaClaw Watchdog*", withViewLogsSuffix(lines[0]), ...lines.slice(1)].join("\n"), createCorrelationId());
      return Boolean(result?.ok || result?.skipped);
    } catch {
      return false;
    }
  };

  const readUsage = async () => {
    const statfs = readStatfs(tmpPath);
    if (statfs.ownMount && statfs.sizeBytes > 0 && statfs.sizeBytes <= kStatfsMaxSizeBytes) {
      return { source: "statfs", usedBytes: statfs.usedBytes, sizeBytes: statfs.sizeBytes, measured: null };
    }
    if (!isRender(env)) return null;
    const measured = await measure(tmpPath);
    return { source: "du", usedBytes: measured.totalBytes, sizeBytes: null, measured };
  };

  const topEntries = (measured, scan) => {
    const deleted = new Map();
    for (const holder of scan?.holders ?? []) {
      if (holder.kind !== "deleted" || deleted.has(holder.path)) continue;
      deleted.set(holder.path, { path: holder.path, bytes: holder.bytes ?? 0, deleted: true, holders: [holder] });
    }
    return [
      ...measured.entries.map((entry) => ({ ...entry, deleted: false, holders: uniquePids(holdersOf(entry.path, scan?.holders ?? [])) })),
      ...deleted.values(),
    ].sort((a, b) => b.bytes - a.bytes).slice(0, kTopEntries);
  };

  const alertLines = (usage, top, truncated) => {
    const limit = usage.sizeBytes ? ` of ${formatBytes(usage.sizeBytes)}` : "";
    const lines = [`🟡 /tmp is filling up: ${truncated ? "at least " : ""}${formatBytes(usage.usedBytes)} used${limit}`];
    lines.push(isRender(env)
      ? "Render replaces the whole instance when /tmp passes 2 GB, so the gateway and every channel go offline until the new instance has booted."
      : "When /tmp is full, programs that write temporary files there start failing.");
    lines.push(evictEnabled
      ? `At ${formatBytes(evictBytes)} the watchdog moves or deletes the oldest large /tmp entries that no process has open, until /tmp is under ${formatBytes(alertBytes)}.`
      : "The watchdog deletes nothing in /tmp on this box.");
    if (top.length) {
      lines.push("Largest entries in /tmp:");
      for (const entry of top) {
        const size = formatBytes(entry.bytes);
        const where = `\`${flattenPath(entry.path)}\``;
        if (entry.deleted) {
          lines.push(`• ${where} ${size}, deleted but still held open by ${describeHolder(entry.holders[0])}: only that process can free it`);
        } else if (entry.holders.length) {
          lines.push(`• ${where} ${size}, in use by ${entry.holders.slice(0, 2).map(describeHolder).join(" and ")}`);
        } else {
          lines.push(`• ${where} ${size}, no process has it open`);
        }
      }
    }
    lines.push("Point scripts and cron jobs at the data volume ($TMPDIR) instead of a hard-coded /tmp.");
    return lines;
  };

  // Right before a move or delete: every path component from /tmp down to
  // the entry must still be a real directory or file on /tmp's device, and
  // the entry's real path must stay under /tmp's. A parent swapped for a
  // symlink after the scan is refused. A window remains between this check
  // and the rename or rm (both act on paths), and rm never follows symlinks.
  const pathStillInTmp = (entryPath) => {
    try {
      const rootDev = fs.statSync(tmpPath).dev;
      let current = tmpPath;
      for (const part of path.relative(tmpPath, entryPath).split(path.sep)) {
        current = path.join(current, part);
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || stat.dev !== rootDev) return false;
      }
      return fs.realpathSync(entryPath).startsWith(fs.realpathSync(tmpPath) + path.sep);
    } catch {
      return false;
    }
  };

  const evictEntry = (entry, stamp) => {
    const dest = path.join(evictRoot, `evicted-${stamp}`, path.relative(tmpPath, entry.path));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      renameEntry(entry.path, dest);
      return { action: "moved", movedTo: dest };
    } catch (error) {
      if (error?.code === "EXDEV" && entry.bytes <= kMoveMaxBytes) {
        let free = 0;
        try { free = readFreeBytes(evictRoot); } catch {}
        if (free >= entry.bytes + kMoveFreeReserveBytes) {
          try {
            fs.cpSync(entry.path, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
            fs.rmSync(entry.path, { recursive: true, force: true });
            return { action: "moved", movedTo: dest };
          } catch {
            try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
          }
        }
      }
    }
    fs.rmSync(entry.path, { recursive: true, force: true });
    for (let dir = path.dirname(dest); dir.startsWith(evictRoot + path.sep); dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir); } catch { break; }
    }
    return { action: "deleted", movedTo: null };
  };

  const evictPass = async (usage, measured, scan, atMs) => {
    if (!scan?.complete) {
      if (!evictSkipLogged) {
        evictSkipLogged = true;
        log("warning", { kind: "tmp_evict_skipped", reason: scan ? "open_files_unreadable" : "proc_unreadable", usedBytes: usage.usedBytes });
      }
      return false;
    }
    const collect = async (entries, depth) => {
      const found = [];
      for (const entry of entries) {
        if (entry.bytes < kEvictMinBytes || isProtected(entry)) continue;
        if (!holdersOf(entry.path, scan.holders).length) {
          found.push(entry);
          continue;
        }
        if (entry.type !== "dir" || depth >= kEvictMaxDepth) continue;
        let inner;
        try { inner = await measure(entry.path); } catch { continue; }
        found.push(...await collect(inner.entries, depth + 1));
      }
      return found;
    };
    const candidates = (await collect(measured.entries, 1)).sort((a, b) => a.newestMtimeMs - b.newestMtimeMs);
    const stamp = new Date(atMs).toISOString().replace(/[:.]/g, "-");
    const evicted = [];
    let projected = usage.usedBytes;
    for (const entry of candidates) {
      if (projected < alertBytes) break;
      const fresh = scanHolders(tmpPath);
      if (!fresh?.complete || holdersOf(entry.path, fresh.holders).length) continue;
      if (!pathStillInTmp(entry.path)) {
        log("warning", { kind: "tmp_evict_refused", entry: entry.path, reason: "path_changed", usedBytes: usage.usedBytes });
        continue;
      }
      let outcome;
      try {
        outcome = evictEntry(entry, stamp);
      } catch {
        log("warning", { kind: "tmp_evict_failed", entry: entry.path, bytes: entry.bytes });
        continue;
      }
      projected -= entry.bytes;
      const ageMs = Math.max(0, atMs - entry.newestMtimeMs);
      evicted.push({ ...entry, ...outcome, ageMs });
      log("warning", { kind: "tmp_evicted", entry: entry.path, bytes: entry.bytes, ageMs, action: outcome.action, movedTo: outcome.movedTo, usedBytes: usage.usedBytes });
    }
    if (!evicted.length) {
      if (!evictSkipLogged) {
        evictSkipLogged = true;
        log("warning", { kind: "tmp_evict_skipped", reason: "nothing_evictable", usedBytes: usage.usedBytes });
      }
      return false;
    }
    const short = projected >= alertBytes;
    if (short && shortfallNotified) return false;
    if (short) shortfallNotified = true;
    let after = null;
    try { after = (await readUsage())?.usedBytes ?? null; } catch {}
    void send([
      `🧹 Freed ${formatBytes(evicted.reduce((sum, entry) => sum + entry.bytes, 0))} in /tmp before it reached the limit`,
      ...evicted.map((entry) => entry.action === "moved"
        ? `• moved \`${flattenPath(entry.path)}\` (${formatBytes(entry.bytes)}, last written ${formatDuration(entry.ageMs)} ago) to \`${flattenPath(entry.movedTo)}\``
        : `• deleted \`${flattenPath(entry.path)}\` (${formatBytes(entry.bytes)}, last written ${formatDuration(entry.ageMs)} ago)`),
      ...(after === null ? [] : [`/tmp now holds ${formatBytes(after)}.`]),
      ...(short ? [`That is not enough to get /tmp under ${formatBytes(alertBytes)}: the rest is held open or protected. The watchdog keeps checking, at most every 30 s, and does not message about this again until /tmp recovers.`] : []),
      "A job that still needed these files will fail; that is cheaper than losing the instance.",
    ]);
    return !short;
  };

  const runTick = async () => {
    const usage = await readUsage();
    const atMs = nowFn();
    if (!usage) {
      last = { atMs, source: "none", usedBytes: null, sizeBytes: null };
      return;
    }
    last = { atMs, source: usage.source, usedBytes: usage.usedBytes, sizeBytes: usage.sizeBytes };
    if (usage.usedBytes < alertBytes) {
      backoff = null;
      if (state === "ok") return;
      clearStreak = usage.usedBytes < kClearFraction * alertBytes ? clearStreak + 1 : 0;
      if (clearStreak < kClearSamples) return;
      log("info", { kind: "tmp_recovered", durationMs: atMs - episodeOpenedAtMs, notified, usedBytes: usage.usedBytes });
      state = "ok";
      episodeId = null;
      episodeOpenedAtMs = null;
      clearStreak = 0;
      shortfallNotified = false;
      return;
    }
    clearStreak = 0;
    if (backoff) {
      if (usage.usedBytes < evictBytes) backoff.belowEvict = true;
      const changed = Math.abs(usage.usedBytes - backoff.usedBytes) > kBackoffChangeBytes;
      const backOverEvict = backoff.belowEvict && usage.usedBytes >= evictBytes;
      if (atMs < backoff.untilMs && !changed && !backOverEvict) return;
      backoff = null;
    }
    const measured = usage.measured ?? await measure(tmpPath);
    const scan = scanHolders(tmpPath);
    const top = topEntries(measured, scan);
    if (state === "ok") {
      state = "high";
      episodeId = `tmp-${atMs}`;
      episodeOpenedAtMs = atMs;
      notified = false;
      evictSkipLogged = false;
      log("warning", {
        kind: "tmp_high", source: usage.source, usedBytes: usage.usedBytes, sizeBytes: usage.sizeBytes, alertBytes, evictBytes, evictEnabled,
        truncated: measured.truncated,
        top: top.map((entry) => ({ path: entry.path, bytes: entry.bytes, deleted: entry.deleted, holders: entry.holders.map(({ pid, command }) => ({ pid, command })) })),
      });
    }
    if (!notified && !alertInFlight && atMs - lastAlertAttemptMs >= kAlertRetryMs) {
      lastAlertAttemptMs = atMs;
      alertInFlight = true;
      const alertEpisodeId = episodeId;
      void send(alertLines(usage, top, measured.truncated)).then((ok) => {
        alertInFlight = false;
        if (episodeId === alertEpisodeId) notified = ok;
      });
    }
    const underAlert = evictEnabled && usage.usedBytes >= evictBytes && await evictPass(usage, measured, scan, atMs);
    if (!underAlert) backoff = { untilMs: atMs + kHighBackoffMs, usedBytes: usage.usedBytes, belowEvict: usage.usedBytes < evictBytes };
  };

  const tick = () => {
    if (tickInFlight) return tickInFlight;
    tickInFlight = runTick().catch(() => {}).finally(() => { tickInFlight = null; });
    return tickInFlight;
  };

  const schedule = () => {
    if (stopped) return;
    const delay = last?.source === "du" ? duIntervalMs : intervalMs;
    timer = setTimeout(() => { void tick().then(schedule); }, delay);
    timer.unref?.();
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    void tick().then(schedule);
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const getSnapshot = () => ({
    path: tmpPath,
    state,
    episodeId,
    source: last?.source ?? null,
    usedBytes: last?.usedBytes ?? null,
    sizeBytes: last?.sizeBytes ?? null,
    alertBytes,
    evictBytes,
    evictEnabled,
    sampledAt: last ? new Date(last.atMs).toISOString() : null,
  });

  return { start, stop, tick, getSnapshot };
};

module.exports = {
  createTmpWatch,
  measureTmpEntries,
  scanTmpHolders,
  resolveTmpEvictEnabled,
  isRender,
};
