const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { parseCronExpression, nextCronRunMs } = require("../../lib/server/box-status/cron-expression");
const { createScheduleRegistry } = require("../../lib/server/box-status/schedule-registry");
const { createScheduleReader, parseCrontab, kCronListCommand } = require("../../lib/server/box-status/schedules");
const { registerBoxRoutes } = require("../../lib/server/routes/box");

const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

describe("cron expression reader", () => {
  it("finds the next run strictly after now, in local time", () => {
    const now = local(2026, 10, 25, 10, 17);
    expect(nextCronRunMs(parseCronExpression("17 * * * *"), now)).toBe(local(2026, 10, 25, 11, 17));
    expect(nextCronRunMs(parseCronExpression("*/15 9-17 * * 1-5"), local(2026, 10, 23, 17, 50))).toBe(local(2026, 10, 26, 9, 0));
    expect(nextCronRunMs(parseCronExpression("@hourly"), now)).toBe(local(2026, 10, 25, 11, 0));
    expect(nextCronRunMs(parseCronExpression("0 4 * jan,oct sun"), now)).toBe(local(2027, 1, 3, 4, 0));
  });

  it("matches either day field when both are restricted, like Vixie cron", () => {
    expect(nextCronRunMs(parseCronExpression("0 0 1 * 1"), local(2026, 10, 25, 12, 0))).toBe(local(2026, 10, 26, 0, 0));
  });

  it("lists @reboot and unsupported syntax without a next run", () => {
    expect(parseCronExpression("@reboot")).toEqual({ ok: false, reboot: true });
    for (const bad of ["0 0 L * *", "61 * * * *", "* * * *", "0 0 * * * *", "*/0 * * * *", ""]) {
      expect(parseCronExpression(bad).ok).toBe(false);
      expect(nextCronRunMs(parseCronExpression(bad), 0)).toBeNull();
    }
  });
});

describe("schedule registry", () => {
  it("records runs of sync, async and failing work without changing their results", async () => {
    let now = 1_000_000;
    const registry = createScheduleRegistry({ nowFn: () => now });
    registry.define("a", { title: "A", schedule: "every 60 s", intervalMs: 60_000 });
    registry.setActive("a", true);
    expect(registry.list()[0]).toMatchObject({ active: true, runs: 0, lastRunAt: null, nextRunAt: new Date(1_060_000).toISOString() });

    now += 5_000;
    expect(registry.track("a", () => 7, (value) => ({ outcome: "ok", detail: "got " + value }))).toBe(7);
    expect(registry.list()[0]).toMatchObject({ runs: 1, lastOutcome: "ok", lastDetail: "got 7", running: false, nextRunAt: new Date(1_065_000).toISOString() });

    await expect(registry.track("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(registry.list()[0]).toMatchObject({ runs: 2, lastOutcome: "failed", lastDetail: "boom" });

    expect(() => registry.track("a", () => { throw new Error("sync boom"); })).toThrow("sync boom");
    await expect(registry.track("a", async () => "x", () => { throw new Error("bad describe"); })).resolves.toBe("x");
    expect(registry.list()[0]).toMatchObject({ runs: 4, lastOutcome: "ok" });

    registry.setActive("a", false);
    expect(registry.list()[0]).toMatchObject({ active: false, nextRunAt: null });
  });

  it("ignores runs of an undefined id", () => {
    const registry = createScheduleRegistry();
    expect(registry.track("missing", () => 1)).toBe(1);
    expect(registry.list()).toEqual([]);
  });
});

describe("schedule reader", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "box-schedules-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const makeProc = (entries) => {
    const procRoot = fs.mkdtempSync(path.join(root, "proc-"));
    for (const [pid, comm, cmdline = comm] of entries) {
      fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
      fs.writeFileSync(path.join(procRoot, String(pid), "comm"), comm + "\n");
      fs.writeFileSync(path.join(procRoot, String(pid), "cmdline"), cmdline.split(" ").join("\0"));
    }
    return procRoot;
  };

  const cronList = {
    total: 2,
    jobs: [
      { id: "job-1", name: "digest", agentId: "main", enabled: true, schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" }, lastRunAtMs: 1_700_000_000_000, lastRunStatus: "error", lastRunError: "401 from https://x?token=s3cr3t-value-123", nextRunAtMs: 1_700_086_400_000 },
      { id: "job-2", name: "off", enabled: false, schedule: { kind: "every", everyMs: 900_000 }, nextRunAtMs: 1_700_000_900_000 },
    ],
  };

  const createReader = (overrides = {}) => {
    const cronDir = path.join(root, "cron.d");
    fs.mkdirSync(cronDir, { recursive: true });
    fs.writeFileSync(path.join(cronDir, "openclaw-hourly-sync"), "SHELL=/bin/sh\n# comment\n17 * * * * root /usr/bin/sync --token s3cr3t-value-123\n@reboot root /bin/true\n");
    fs.writeFileSync(path.join(cronDir, "bad.name"), "* * * * * root /bin/false\n");
    fs.writeFileSync(path.join(root, "crontab"), "0 3 * * 0 root /usr/sbin/weekly\n");
    const registry = createScheduleRegistry({ nowFn: () => local(2026, 10, 25, 10, 0) });
    registry.define("watchdog.health", { title: "Health", schedule: "every 120 s", intervalMs: 120_000 });
    registry.setActive("watchdog.health", true);
    const clawCmd = vi.fn(async () => ({ ok: true, stdout: JSON.stringify(cronList) }));
    const execFileCmd = vi.fn(async () => { throw Object.assign(new Error("exit 1"), { stderr: "no crontab for node" }); });
    return {
      clawCmd,
      execFileCmd,
      reader: createScheduleReader({
        clawCmd,
        execFileCmd,
        registry,
        env: { SYNC_TOKEN: "s3cr3t-value-123" },
        procRoot: makeProc([[12, "node"], [40, "busybox", "busybox crond -f"]]),
        systemCrontabPath: path.join(root, "crontab"),
        cronDir,
        readGitSyncSchedule: () => ({ enabled: true, schedule: "17 * * * *" }),
        readGitSyncStatus: () => ({ at: "2026-10-25T09:17:03.000Z", outcome: "pushed", code: "pushed", trigger: "cron" }),
        nowFn: () => local(2026, 10, 25, 10, 0),
        ...overrides,
      }),
    };
  };

  it("lists OpenClaw cron jobs, AlphaClaw timers, git sync and system cron with secrets redacted", async () => {
    const { reader, clawCmd } = createReader();
    const body = await reader.read();
    expect(clawCmd).toHaveBeenCalledWith(kCronListCommand, expect.objectContaining({ quiet: true, timeoutMs: 20_000 }));
    expect(body.openclaw).toMatchObject({ status: "ok", total: 2 });
    expect(body.openclaw.jobs[0]).toMatchObject({ id: "job-1", agentId: "main", enabled: true, schedule: "cron 0 8 * * * (UTC)", lastOutcome: "error", lastRunAt: new Date(1_700_000_000_000).toISOString() });
    expect(body.openclaw.jobs[0].lastError).not.toContain("s3cr3t-value-123");
    expect(body.openclaw.jobs[1]).toMatchObject({ enabled: false, schedule: "every 900 s", nextRunAt: null });

    expect(body.alphaclaw.map((entry) => entry.id)).toEqual(["watchdog.health", "git_sync"]);
    expect(body.alphaclaw[1]).toMatchObject({ active: true, lastRunAt: "2026-10-25T09:17:03.000Z", lastOutcome: "pushed", lastDetail: "pushed (cron)", nextRunAt: new Date(local(2026, 10, 25, 10, 17)).toISOString() });

    expect(body.system.cronDaemon).toEqual({ status: "running", pid: 40, name: "busybox" });
    expect(body.system.crontab).toEqual({ status: "ok", reason: null });
    expect(body.system.files.map((file) => path.basename(file.path))).toEqual(["crontab", "openclaw-hourly-sync"]);
    expect(body.system.entries).toHaveLength(3);
    const sync = body.system.entries.find((entry) => entry.schedule === "17 * * * *");
    expect(sync).toMatchObject({ user: "root", line: 3, nextRunAt: new Date(local(2026, 10, 25, 10, 17)).toISOString() });
    expect(sync.command).toContain("/usr/bin/sync");
    expect(sync.command).not.toContain("s3cr3t-value-123");
    expect(body.system.entries.find((entry) => entry.schedule === "@reboot")).toMatchObject({ nextRunAt: null, note: "runs at boot" });
    expect(JSON.stringify(body)).not.toContain("s3cr3t-value-123");
  });

  it("says why OpenClaw's jobs are missing and caches the CLI for 60 s", async () => {
    let now = local(2026, 10, 25, 10, 0);
    const clawCmd = vi.fn(async () => ({ ok: false, stdout: "", stderr: "gateway closed" }));
    const { reader } = createReader({ clawCmd, nowFn: () => now });
    expect((await reader.read()).openclaw).toEqual({ status: "unavailable", reason: "gateway_unreachable", total: 0, jobs: [] });
    now += 30_000;
    await reader.read();
    expect(clawCmd).toHaveBeenCalledTimes(1);
    now += 31_000;
    await reader.read();
    expect(clawCmd).toHaveBeenCalledTimes(2);

    clawCmd.mockResolvedValue({ ok: true, stdout: "not json" });
    now += 61_000;
    expect((await reader.read()).openclaw.reason).toBe("unreadable_answer");
    expect((await createReader({ clawCmd: null }).reader.read()).openclaw.reason).toBe("no_cli");
  });

  it("reports a missing crontab binary, no cron daemon and no git sync", async () => {
    const execFileCmd = vi.fn(async () => { throw Object.assign(new Error("spawn crontab ENOENT"), { code: "ENOENT" }); });
    const { reader } = createReader({
      execFileCmd,
      procRoot: makeProc([[9, "node"]]),
      readGitSyncSchedule: () => { throw new Error("ENOENT"); },
      readGitSyncStatus: () => null,
    });
    const body = await reader.read();
    expect(body.system.crontab).toEqual({ status: "unavailable", reason: "crontab_not_installed" });
    expect(body.system.cronDaemon).toEqual({ status: "not_running" });
    expect(body.alphaclaw.map((entry) => entry.id)).toEqual(["watchdog.health"]);
  });

  it("redacts the value after a secret-named flag in a cron command", () => {
    const [entry] = parseCrontab("*/5 * * * * root /usr/bin/job --token plain-words-1 --password=plain-words-2 --verbose\n", { source: "x", withUser: true, secrets: [], nowMs: 0 });
    expect(entry.command).toContain("--verbose");
    expect(entry.command).not.toContain("plain-words-1");
    expect(entry.command).not.toContain("plain-words-2");
  });

  it("parses a user crontab without a user column", () => {
    expect(parseCrontab("FOO=bar\n5 4 * * * /bin/job arg\n", { source: "crontab", withUser: false, secrets: [], nowMs: 0 })).toEqual([
      expect.objectContaining({ source: "crontab", line: 2, schedule: "5 4 * * *", user: null, command: "/bin/job arg", note: null }),
    ]);
  });
});

describe("GET /api/box/schedules", () => {
  it("answers the reader's list behind requireAuth", async () => {
    const app = express();
    const requireAuth = vi.fn((req, res, next) => next());
    const scheduleReader = { read: vi.fn(async () => ({ ok: true, openclaw: { status: "ok" }, alphaclaw: [], system: { entries: [] } })) };
    registerBoxRoutes({ app, requireAuth, processTable: null, readRestartStatus: () => null, scheduleReader });
    const res = await request(app).get("/api/box/schedules");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, openclaw: { status: "ok" } });
    expect(requireAuth).toHaveBeenCalled();
    const unknown = await request(app).get("/api/box/nope");
    expect(unknown.body.views).toContain("schedules");
  });
});
