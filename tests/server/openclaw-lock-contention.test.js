// Read-only lock-contention diagnostics (replaces the destructive stale-lock
// sweep after the openclaw 2026.9.1-beta.1 tarball showed the coordinator is
// an exclusive SQLite transaction held by a LIVE process — never a stale file).
const {
  describeLockContention,
  listLiveOpenclawProcesses,
  listLockDirs,
  looksLikeLockContention,
  isOpenclawArgv,
  parseProcCmdline,
} = require("../../lib/server/openclaw-lock-contention");

const fakeProc = (table) => ({
  fsModule: {
    readdirSync: (p) =>
      p === "/proc" ? [...Object.keys(table), "self", "cpuinfo"] : [],
  },
  readCmdline: (pid) => table[String(pid)]?.cmdline ?? null,
  isZombie: (pid) => table[String(pid)]?.zombie === true,
});

describe("isOpenclawArgv (mirrors upstream isOpenClawArgv)", () => {
  it("recognizes the CLI, node-launched entry scripts, and the gateway binary", () => {
    expect(isOpenclawArgv(["openclaw", "gateway", "run"])).toBe(true);
    expect(isOpenclawArgv(["/usr/local/bin/openclaw", "doctor", "--fix"])).toBe(true);
    expect(
      isOpenclawArgv(["node", "/app/node_modules/openclaw/dist/entry.js", "gateway", "run"]),
    ).toBe(true);
    expect(isOpenclawArgv(["/opt/x/openclaw-gateway"])).toBe(true);
  });
  it("does not classify alphaclaw itself or unrelated node processes", () => {
    expect(isOpenclawArgv(["node", "/app/bin/alphaclaw.js", "start"])).toBe(false);
    expect(isOpenclawArgv(["node", "/srv/other/index.js"])).toBe(false);
    expect(isOpenclawArgv(["/usr/sbin/crond", "-n"])).toBe(false);
    expect(isOpenclawArgv([])).toBe(false);
  });
  it("parses NUL-separated /proc cmdline", () => {
    expect(parseProcCmdline("openclaw\0gateway\0run\0")).toEqual(["openclaw", "gateway", "run"]);
  });
});

describe("listLiveOpenclawProcesses", () => {
  it("lists live non-zombie openclaw-ish processes, skipping self, kernel threads, zombies, and non-openclaw", () => {
    const table = {
      1: { cmdline: "node\0/app/bin/alphaclaw.js\0start\0" },
      57: { cmdline: "openclaw\0gateway\0run\0" },
      91: { cmdline: "node\0/app/node_modules/openclaw/dist/entry.js\0doctor\0--fix\0--yes\0" },
      92: { cmdline: "openclaw\0doctor\0--json\0", zombie: true },
      200: { cmdline: "" }, // kernel thread
      300: { cmdline: "/usr/sbin/crond\0-n\0" },
      4242: { cmdline: "openclaw\0status\0" }, // self
    };
    const live = listLiveOpenclawProcesses({ ...fakeProc(table), selfPid: 4242 });
    expect(live.map((p) => p.pid).sort()).toEqual([57, 91]);
    expect(live.find((p) => p.pid === 91).cmdline).toContain("doctor --fix --yes");
  });
  it("returns [] when /proc is unavailable (non-Linux) — never throws", () => {
    expect(
      listLiveOpenclawProcesses({
        fsModule: { readdirSync: () => { throw new Error("ENOENT"); } },
      }),
    ).toEqual([]);
  });
});

describe("describeLockContention", () => {
  it("names the live holder candidates and the lock dirs, and NEVER deletes anything", () => {
    const table = { 57: { cmdline: "openclaw\0gateway\0run\0" } };
    const fsModule = {
      readdirSync: (p) => {
        if (p === "/proc") return ["57"];
        if (p === "/tmp-fake") return ["openclaw-state-locks-0", "other", "openclaw-state-locks"];
        return [];
      },
      rmSync: () => { throw new Error("must never be called"); },
      unlinkSync: () => { throw new Error("must never be called"); },
    };
    const report = describeLockContention({
      site: "restart",
      tmpDir: "/tmp-fake",
      fsModule,
      readCmdline: fakeProc(table).readCmdline,
      isZombie: () => false,
      selfPid: 1,
    });
    expect(report.live).toEqual([{ pid: 57, cmdline: "openclaw gateway run" }]);
    expect(report.lockDirs).toEqual(["openclaw-state-locks-0", "openclaw-state-locks"]);
    expect(report.lines[0]).toContain("pid 57 (openclaw gateway run)");
    expect(report.lines[1]).toContain("must never be deleted while a holder may be live");
  });
  it("says so when no live openclaw process exists (holder already exited — retry should succeed)", () => {
    const report = describeLockContention({
      site: "boot",
      tmpDir: "/nope",
      fsModule: { readdirSync: () => [] },
      readCmdline: () => null,
      isZombie: () => false,
    });
    expect(report.live).toEqual([]);
    expect(report.lines[0]).toContain("no live openclaw processes found");
  });
});

describe("looksLikeLockContention", () => {
  it("matches upstream's contention refusals and SQLite busy signatures", () => {
    expect(looksLikeLockContention("ERROR another OpenClaw process owns state-lifecycle")).toBe(true);
    expect(looksLikeLockContention("failed: another OpenClaw process owns gateway-lifecycle")).toBe(true);
    expect(looksLikeLockContention("SqliteError: database is locked")).toBe(true);
    expect(looksLikeLockContention("bind: address already in use")).toBe(false);
    expect(looksLikeLockContention("")).toBe(false);
  });
});
