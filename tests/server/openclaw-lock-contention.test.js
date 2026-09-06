// Read-only lock-contention diagnostics (replaces the destructive stale-lock
// sweep after the openclaw 2026.9.1-beta.1 tarball showed the coordinator is
// an exclusive SQLite transaction held by a LIVE process — never a stale file).
const {
  kStateContentionPattern,
  kGatewayProcessPattern,
  kGatewayServingCmdlinePattern,
  kGatewayOwnershipConflictPattern,
  classifyOwnershipConflict,
  parseProcStat,
  readProcStartTicks,
  readProcParentPid,
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

  // C12: /proc lists pids ascending, so the default 12-entry cap over every
  // openclaw-ish process drops the NEWEST pids — the just-spawned gateway a
  // restart verdict needs. `match` narrows before the cap; `limit` lifts it.
  describe("14 openclaw-ish processes with the gateways at the highest pids", () => {
    const table = {};
    // 12 lower-pid one-shot CLI children (doctor/status/tools under the
    // openclaw package) fill the default cap on a busy host.
    for (let i = 0; i < 12; i += 1) {
      table[String(100 + i)] = {
        cmdline: `node\0/app/node_modules/openclaw/dist/entry.js\0doctor\0--json\0`,
      };
    }
    table["5000"] = { cmdline: "openclaw\0gateway\0--force\0" };
    table["5001"] = { cmdline: "node\0/app/node_modules/openclaw/dist/entry.js\0gateway\0run\0" };
    const isGatewayArgv = (argv) => /(^|\s)gateway(\s|$)/.test(argv.join(" "));

    it("the default (human evidence) scan stays capped at 12 and misses both gateways", () => {
      const live = listLiveOpenclawProcesses({ ...fakeProc(table), selfPid: 1 });
      expect(live).toHaveLength(12);
      expect(live.map((p) => p.pid)).not.toContain(5000);
      expect(live.map((p) => p.pid)).not.toContain(5001);
    });

    it("`match` filters BEFORE the cap so the gateway pids are found under the default cap", () => {
      const live = listLiveOpenclawProcesses({
        ...fakeProc(table),
        selfPid: 1,
        match: isGatewayArgv,
      });
      expect(live.map((p) => p.pid).sort()).toEqual([5000, 5001]);
    });

    it("`limit: Infinity` lifts the cap; a junk limit falls back to the default", () => {
      expect(
        listLiveOpenclawProcesses({ ...fakeProc(table), selfPid: 1, limit: Infinity }),
      ).toHaveLength(14);
      expect(
        listLiveOpenclawProcesses({ ...fakeProc(table), selfPid: 1, limit: "all" }),
      ).toHaveLength(12);
      expect(
        listLiveOpenclawProcesses({ ...fakeProc(table), selfPid: 1, limit: 3 }),
      ).toHaveLength(3);
    });
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

  // Issue #54 lease-failure texts, verified against the 2026.9.1-beta.1 dist.
  it("matches every state-lease failure text (LOST / TIMEOUT / STORAGE_FAILED / lock wait)", () => {
    const fixtures = [
      "SQLite transaction lock wait failed",
      "Error: lease migration.legacy-audit/filesystem-sqlite-boundary was lost",
      "OPENCLAW_STATE_LEASE_LOST",
      "timed out waiting for lease migration.legacy-audit/filesystem-sqlite-boundary",
      "OPENCLAW_STATE_LEASE_TIMEOUT: acquire gave up after 5000ms",
      "failed to acquire lease migration.legacy-audit/filesystem-sqlite-boundary",
      "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
      // Verbatim from the real CLIs (2026.8.2 and 2026.9.1-beta.1, captured
      // live): the label is four words, so a one-token label slot misses it.
      "timed out waiting for legacy audit migration lease migration.legacy-audit/filesystem-sqlite-boundary",
      "failed to acquire legacy audit migration lease migration.legacy-audit/filesystem-sqlite-boundary",
      "legacy audit migration lease migration.legacy-audit/filesystem-sqlite-boundary was lost",
    ];
    for (const text of fixtures) {
      expect(looksLikeLockContention(text), text).toBe(true);
      expect(kStateContentionPattern.test(text), text).toBe(true);
    }
  });

  it("does not over-match unrelated acquire/lost wording without the <scope>/<key> token", () => {
    for (const text of [
      "failed to acquire the network interface",
      "connection was lost",
      "timed out waiting for the gateway to answer",
      "ENOENT: no such file or directory, lstat '/data/x.lock'",
      // URLs and file paths carry a slash too; only a lease token counts
      // (a false verdict would retry inside the quiesce and make the failure
      // reuse-eligible).
      "timed out waiting for https://registry.npmjs.org/openclaw",
      "failed to acquire artifact /tmp/openclaw-prepare-x/pkg.tgz",
      "download of /data/backups/openclaw/x.tar.gz was lost",
    ]) {
      expect(looksLikeLockContention(text), text).toBe(false);
    }
  });

  it("exports ONE combined pattern that both consumers share (case-insensitive)", () => {
    expect(kStateContentionPattern).toBeInstanceOf(RegExp);
    expect(kStateContentionPattern.flags).toContain("i");
    expect(kStateContentionPattern.test("sqlite TRANSACTION LOCK WAIT FAILED")).toBe(true);
    expect(kStateContentionPattern.test("Another OpenClaw Process Owns State-Lifecycle")).toBe(true);
  });
});

describe("gateway process patterns (evidence vs serving)", () => {
  const kServing = [
    "openclaw gateway run",
    "node /app/node_modules/openclaw/dist/entry.js gateway run --dev",
    "openclaw gateway --force",
    "/opt/x/openclaw-gateway",
  ];
  const kCliVerbs = [
    "openclaw gateway status",
    "openclaw gateway stop --force",
    "openclaw gateway restart",
    "openclaw gateway call health",
    "openclaw gateway --help",
  ];

  it("the EVIDENCE pattern matches every gateway-ish process, CLI verbs included (unchanged after the move from gateway.js)", () => {
    expect(kGatewayProcessPattern.source).toBe("(^|\\s)gateway(\\s|$)|openclaw-gateway");
    for (const cmdline of [...kServing, ...kCliVerbs]) {
      expect(kGatewayProcessPattern.test(cmdline), cmdline).toBe(true);
    }
    expect(kGatewayProcessPattern.test("openclaw doctor --json")).toBe(false);
    expect(kGatewayProcessPattern.test("node /app/bin/alphaclaw.js start")).toBe(false);
  });

  it("the SERVING pattern accepts only processes that can own the port and rejects the CLI verbs", () => {
    for (const cmdline of kServing) {
      expect(kGatewayServingCmdlinePattern.test(cmdline), cmdline).toBe(true);
    }
    for (const cmdline of kCliVerbs) {
      expect(kGatewayServingCmdlinePattern.test(cmdline), cmdline).toBe(false);
    }
    expect(kGatewayServingCmdlinePattern.test("openclaw doctor --fix --yes")).toBe(false);
  });
});

describe("classifyOwnershipConflict (exit-1 wording of a losing gateway contender)", () => {
  // Wording table verified against the 2026.7.1-2 and 2026.9.1-beta.1 tarballs.
  const rows = [
    {
      text: "another gateway instance is already listening on ws://127.0.0.1:18789",
      kind: "gateway_conflict",
      holderPid: null,
      holderRole: null,
    },
    {
      text: "gateway already running (pid 4321); lock timeout after 5000ms",
      kind: "gateway_conflict",
      holderPid: 4321,
      holderRole: null,
    },
    {
      text: "failed to acquire gateway lock at /tmp/openclaw-gateway.lock",
      kind: "gateway_conflict",
      holderPid: null,
      holderRole: null,
    },
    {
      text: "another OpenClaw process owns state-lifecycle: retry later",
      kind: "gateway_conflict",
      holderPid: null,
      holderRole: null,
    },
    {
      text: "gateway already running under external; existing gateway did not become healthy after 30000ms",
      kind: "gateway_conflict",
      holderPid: null,
      holderRole: null,
    },
    {
      text: "state directory is locked by agent-embedded (pid 777)",
      kind: "state_writer_conflict",
      holderPid: 777,
      holderRole: "agent-embedded",
    },
    {
      text: "another embedded OpenClaw state writer is active (pid 9)",
      kind: "state_writer_conflict",
      holderPid: 9,
      holderRole: null,
    },
    {
      text: "failed to acquire gateway state ownership",
      kind: "state_writer_conflict",
      holderPid: null,
      holderRole: null,
    },
  ];

  it.each(rows)("$text → $kind", ({ text, kind, holderPid, holderRole }) => {
    expect(kGatewayOwnershipConflictPattern.test(text)).toBe(true);
    expect(classifyOwnershipConflict(text)).toEqual({ kind, holderPid, holderRole });
  });

  it("is case-insensitive and reads the wording out of a multi-line stderr tail", () => {
    const tail = [
      "[gateway] starting",
      "Error: STATE DIRECTORY IS LOCKED BY Migration-Runner (PID 55)",
    ].join("\n");
    expect(classifyOwnershipConflict(tail)).toEqual({
      kind: "state_writer_conflict",
      holderPid: 55,
      holderRole: "Migration-Runner",
    });
  });

  it("returns null for anything else (a crash, EADDRINUSE, the state-lease texts, empty input)", () => {
    for (const text of [
      "TypeError: cannot read properties of undefined",
      "bind: address already in use",
      "OPENCLAW_STATE_LEASE_LOST",
      "Gateway listening on ws://127.0.0.1:18789",
      "",
      null,
      undefined,
    ]) {
      expect(classifyOwnershipConflict(text), String(text)).toBeNull();
      expect(kGatewayOwnershipConflictPattern.test(String(text ?? "")), String(text)).toBe(false);
    }
  });
});

describe("readProcStartTicks / readProcParentPid (/proc/<pid>/stat field 22 and 4)", () => {
  // Real shape (this sandbox): `91393 (bash) S 872 91393 91393 0 -1 4194304 …`
  // — 17 more fields between ppid and starttime, so starttime is index 19
  // after the last ")".
  const statLine = (pid, comm, ppid, startTicks) =>
    `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 623 1997 0 0 0 0 0 0 20 0 1 0 ${startTicks} 4558848 825 18446744073709551615 94524456087552 0\n`;
  const fakeFs = (table) => ({
    readFileSync: (target) => {
      const match = /^\/proc\/(\d+)\/stat$/.exec(String(target));
      const entry = match ? table[match[1]] : undefined;
      if (entry === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entry;
    },
  });

  it("parses start ticks and the parent pid, including a comm with spaces and parentheses", () => {
    const fsModule = fakeFs({
      57: statLine(57, "openclaw", 1, 8239873),
      58: statLine(58, "node (gateway) run", 57, 8239901),
      59: "garbage without a paren",
    });
    expect(readProcStartTicks(57, { fsModule })).toBe(8239873);
    expect(readProcParentPid(57, { fsModule })).toBe(1);
    // The comm is split AFTER the last ")": inner parens and spaces do not
    // shift the field indexes.
    expect(readProcStartTicks(58, { fsModule })).toBe(8239901);
    expect(readProcParentPid(58, { fsModule })).toBe(57);
    expect(parseProcStat(statLine(58, "node (gateway) run", 57, 8239901))).toEqual({
      parentPid: 57,
      startTicks: 8239901,
    });
    expect(readProcStartTicks(59, { fsModule })).toBeNull();
    expect(parseProcStat("")).toBeNull();
  });

  it("returns null (never throws) for an exited pid, junk pids, or a non-Linux fs", () => {
    const fsModule = fakeFs({});
    expect(readProcStartTicks(12345, { fsModule })).toBeNull();
    expect(readProcParentPid(12345, { fsModule })).toBeNull();
    for (const pid of [0, -1, 1.5, "57", null, undefined]) {
      expect(readProcStartTicks(pid, { fsModule }), String(pid)).toBeNull();
    }
    expect(
      readProcStartTicks(1, {
        fsModule: {
          readFileSync: () => {
            throw new Error("EPERM");
          },
        },
      }),
    ).toBeNull();
  });

  it("reads the live /proc for this very process (start ticks and the real parent)", () => {
    if (process.platform !== "linux") return;
    expect(readProcStartTicks(process.pid)).toEqual(expect.any(Number));
    expect(readProcParentPid(process.pid)).toBe(process.ppid);
  });
});

describe("pidAlive (probe-death evidence)", () => {
  it("is true when signal 0 succeeds or is refused with EPERM (alive, not ours), false on ESRCH or a non-pid", () => {
    const { pidAlive } = require("../../lib/server/openclaw-lock-contention");
    expect(pidAlive(process.pid)).toBe(true);
    const throwing = (code) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(pidAlive(123, { kill: throwing("ESRCH") })).toBe(false);
    expect(pidAlive(123, { kill: throwing("EPERM") })).toBe(true);
    expect(pidAlive(123, { kill: throwing("EINVAL") })).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(null)).toBe(false);
    expect(pidAlive("4242", { kill: () => undefined })).toBe(true);
  });
});
