// Every scheduled thing on the box in one list (ALPH-40): OpenClaw's cron
// jobs (read through the gateway's cron.list, never OpenClaw's database), the
// user's crontab, /etc/crontab and /etc/cron.d, and AlphaClaw's own timers
// (the schedule registry plus the git sync cron line). Each entry carries its
// schedule, last run, last outcome and next run where they can be known; a
// crontab line has no run record, so its last run is null.
//
// Bounds: one cron.list page (200 jobs) with a 20 s CLI budget, crontab -l
// with 5 s and 256 KB, at most 64 cron.d files of 64 KB each, 300 system
// entries, command lines redacted and cut to 300 characters. The OpenClaw part
// is cached for 60 s (it spawns the CLI), the rest for 15 s.
const fs = require("fs");
const path = require("path");
const { collectSecretArgValues, collectSecretValues, redactLine } = require("../utils/redact");
const { parseCronExpression, nextCronRunMs } = require("./cron-expression");

const kCronListCommand = "gateway call cron.list --params '{\"includeDisabled\":true,\"limit\":200,\"compact\":true}' --json";
const kCronListTimeoutMs = 20_000;
const kOpenclawCacheMs = 60_000;
const kCacheMs = 15_000;
const kCrontabTimeoutMs = 5_000;
const kMaxCrontabBytes = 256 * 1024;
const kMaxCronFiles = 64;
const kMaxCronFileBytes = 64 * 1024;
const kMaxSystemEntries = 300;
const kMaxCommandChars = 300;
const kCronDaemonNames = new Set(["cron", "crond", "busybox", "supercronic", "fcron", "dcron"]);

const toIso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

const describeOpenclawSchedule = (job) => {
  const schedule = job.schedule || {};
  if (schedule.kind === "cron") return "cron " + String(schedule.expr || "") + (schedule.tz ? " (" + schedule.tz + ")" : "");
  if (schedule.kind === "every") return "every " + Math.round(Number(schedule.everyMs) / 1000) + " s";
  if (schedule.kind === "at") return "once at " + String(schedule.at || "");
  return String(job.scheduleKind || "unknown");
};

const projectOpenclawJob = (job, secrets) => ({
  id: String(job.id || "").slice(0, 128),
  name: String(job.displayName || job.name || "").slice(0, 128),
  agentId: job.effectiveAgentId ?? job.agentId ?? null,
  enabled: job.enabled !== false,
  schedule: describeOpenclawSchedule(job).slice(0, 120),
  lastRunAt: toIso(job.lastRunAtMs),
  lastOutcome: job.lastRunStatus ?? null,
  lastError: job.lastRunError ? redactLine(String(job.lastRunError), { secrets, maxLength: 200 }) : null,
  nextRunAt: job.enabled === false ? null : toIso(job.nextRunAtMs),
  running: Number.isFinite(job.runningAtMs),
  autoDisabled: job.autoDisabled === true,
});

// crontab text -> entries. System files carry a user field after the schedule.
const parseCrontab = (text, { source, withUser, secrets, nowMs }) => {
  const entries = [];
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;
    const tokens = line.split(/\s+/);
    const macro = tokens[0].startsWith("@");
    const scheduleParts = macro ? 1 : 5;
    if (tokens.length <= scheduleParts + (withUser ? 1 : 0)) continue;
    const schedule = tokens.slice(0, scheduleParts).join(" ");
    const user = withUser ? tokens[scheduleParts] : null;
    const command = tokens.slice(scheduleParts + (withUser ? 1 : 0)).join(" ");
    const parsed = parseCronExpression(schedule);
    entries.push({
      source,
      line: index + 1,
      schedule,
      user,
      command: redactLine(command, { secrets: [...secrets, ...collectSecretArgValues(command.split(/\s+/))], maxLength: kMaxCommandChars }),
      nextRunAt: toIso(nextCronRunMs(parsed, nowMs)),
      note: parsed.ok ? null : parsed.reboot ? "runs at boot" : "unsupported schedule",
    });
  }
  return entries;
};

const readSmallFile = (filePath, fsModule) => {
  const stat = fsModule.lstatSync(filePath);
  if (!stat.isFile()) return null;
  if (stat.size > kMaxCronFileBytes) return null;
  return fsModule.readFileSync(filePath, "utf8");
};

const findCronDaemon = (procRoot, fsModule) => {
  let names;
  try { names = fsModule.readdirSync(procRoot); } catch { return { status: "unknown" }; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let comm;
    try { comm = String(fsModule.readFileSync(path.join(procRoot, name, "comm"), "utf8")).trim(); } catch { continue; }
    if (!kCronDaemonNames.has(comm)) continue;
    if (comm === "busybox") {
      try {
        const argv = String(fsModule.readFileSync(path.join(procRoot, name, "cmdline"), "utf8")).split("\0");
        if (!argv.some((arg) => /crond$/.test(arg))) continue;
      } catch { continue; }
    }
    return { status: "running", pid: Number(name), name: comm };
  }
  return { status: "not_running" };
};

const createScheduleReader = ({
  clawCmd = null,
  execFileCmd = null,
  registry,
  readEnvFile = () => [],
  // () => { enabled, schedule } from <state>/cron/system-sync.json, or null.
  readGitSyncSchedule = () => null,
  // () => the git-sync-status.json record, or null.
  readGitSyncStatus = () => null,
  fsModule = fs,
  procRoot = "/proc",
  systemCrontabPath = "/etc/crontab",
  cronDir = "/etc/cron.d",
  env = process.env,
  nowFn = Date.now,
} = {}) => {
  let openclawCache = null;
  let cache = null;

  const readOpenclawJobs = async (secrets) => {
    const now = nowFn();
    if (openclawCache && now - openclawCache.atMs < kOpenclawCacheMs && now >= openclawCache.atMs) return openclawCache.value;
    let value;
    if (typeof clawCmd !== "function") {
      value = { status: "unavailable", reason: "no_cli", total: 0, jobs: [] };
    } else {
      const result = await clawCmd(kCronListCommand, { quiet: true, timeoutMs: kCronListTimeoutMs });
      let body = null;
      try { body = JSON.parse(String(result?.stdout || "")); } catch {}
      const jobs = Array.isArray(body?.jobs) ? body.jobs : null;
      value = !result?.ok || !jobs
        ? { status: "unavailable", reason: result?.ok ? "unreadable_answer" : "gateway_unreachable", total: 0, jobs: [] }
        : {
          status: "ok",
          reason: null,
          total: Number.isSafeInteger(body.total) ? body.total : jobs.length,
          jobs: jobs.filter((job) => job && typeof job === "object").map((job) => projectOpenclawJob(job, secrets)),
        };
    }
    openclawCache = { atMs: now, value };
    return value;
  };

  const readUserCrontab = async (secrets, nowMs) => {
    if (typeof execFileCmd !== "function") return { status: "unavailable", reason: "no_exec", entries: [] };
    try {
      const text = await execFileCmd("crontab", ["-l"], { timeout: kCrontabTimeoutMs, maxBuffer: kMaxCrontabBytes });
      return { status: "ok", entries: parseCrontab(text, { source: "crontab", withUser: false, secrets, nowMs }) };
    } catch (error) {
      if (/no crontab for/i.test(String(error?.stderr || ""))) return { status: "ok", entries: [] };
      return { status: "unavailable", reason: error?.code === "ENOENT" ? "crontab_not_installed" : "crontab_failed", entries: [] };
    }
  };

  const readSystemCron = (secrets, nowMs) => {
    const files = [];
    const entries = [];
    const add = (filePath) => {
      let text = null;
      try { text = readSmallFile(filePath, fsModule); } catch { return; }
      if (text === null) {
        files.push({ path: filePath, status: "skipped" });
        return;
      }
      files.push({ path: filePath, status: "ok" });
      entries.push(...parseCrontab(text, { source: filePath, withUser: true, secrets, nowMs }));
    };
    add(systemCrontabPath);
    let names = [];
    try { names = fsModule.readdirSync(cronDir).filter((name) => /^[A-Za-z0-9_-]+$/.test(name)).sort(); } catch {}
    for (const name of names.slice(0, kMaxCronFiles)) add(path.join(cronDir, name));
    return { files, entries, filesTruncated: names.length > kMaxCronFiles };
  };

  const describeGitSync = (nowMs) => {
    let config = null;
    let status = null;
    try { config = readGitSyncSchedule(); } catch {}
    try { status = readGitSyncStatus(); } catch {}
    if (!config && !status) return null;
    const enabled = config ? config.enabled !== false : null;
    const parsed = parseCronExpression(config?.schedule);
    return {
      id: "git_sync",
      title: "Workspace git sync (system cron)",
      schedule: config?.schedule ? "cron " + config.schedule : "unknown",
      active: enabled === true,
      running: false,
      runs: null,
      lastRunAt: typeof status?.at === "string" ? status.at : null,
      lastFinishedAt: null,
      lastOutcome: status?.outcome ?? null,
      lastDetail: status?.code ? String(status.code).slice(0, 64) + (status.trigger ? " (" + String(status.trigger).slice(0, 32) + ")" : "") : null,
      nextRunAt: enabled === true ? toIso(nextCronRunMs(parsed, nowMs)) : null,
    };
  };

  const collect = async () => {
    const nowMs = nowFn();
    const envFileVars = (() => { try { return readEnvFile() || []; } catch { return []; } })();
    const secrets = collectSecretValues({ env, envFileVars });
    const [openclaw, crontab] = await Promise.all([readOpenclawJobs(secrets), readUserCrontab(secrets, nowMs)]);
    const system = readSystemCron(secrets, nowMs);
    const systemEntries = [...crontab.entries, ...system.entries];
    const gitSync = describeGitSync(nowMs);
    return {
      ok: true,
      atMs: nowMs,
      openclaw,
      alphaclaw: [...registry.list(), ...(gitSync ? [gitSync] : [])],
      system: {
        cronDaemon: findCronDaemon(procRoot, fsModule),
        crontab: { status: crontab.status, reason: crontab.reason ?? null },
        files: system.files,
        filesTruncated: system.filesTruncated,
        total: systemEntries.length,
        entries: systemEntries.slice(0, kMaxSystemEntries),
      },
    };
  };

  const read = () => {
    const now = nowFn();
    if (cache && now >= cache.atMs && now - cache.atMs < kCacheMs) return cache.promise;
    const promise = collect();
    cache = { atMs: now, promise };
    promise.catch(() => { if (cache?.promise === promise) cache = null; });
    return promise;
  };

  return { read };
};

module.exports = { createScheduleReader, parseCrontab, kCronListCommand };
