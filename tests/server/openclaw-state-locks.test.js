// Stale openclaw state-lifecycle lock sweep (post-incident 2026-09-01).
// DI-style: real temp dirs, injected killFn/nowFn/readCmdline — never the
// real /tmp, never real process signals beyond kill(self, 0).
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  sweepStaleOpenclawStateLocks,
  extractPidFromText,
} = require("../../lib/server/openclaw-state-locks");

const mkTmp = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-locksweep-"));

const writeLock = (dir, name, content) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

const killDead = vi.fn(() => {
  const err = new Error("no such process");
  err.code = "ESRCH";
  throw err;
});
const killAlive = vi.fn(() => true);
const killEperm = vi.fn(() => {
  const err = new Error("not permitted");
  err.code = "EPERM";
  throw err;
});
const killWeird = vi.fn(() => {
  const err = new Error("invalid");
  err.code = "EINVAL";
  throw err;
});

const silentLog = () => {};

describe("sweepStaleOpenclawStateLocks", () => {
  // The global setup disables the sweep for every suite (it deletes files in
  // the real tmpdir when not injected); this suite re-enables it per test.
  beforeEach(() => {
    delete process.env.ALPHACLAW_STATE_LOCK_SWEEP_DISABLED;
  });
  afterEach(() => {
    process.env.ALPHACLAW_STATE_LOCK_SWEEP_DISABLED = "1";
  });

  it("removes a lock whose explicit pid is dead", () => {
    const dir = mkTmp();
    writeLock(dir, "openclaw-state-locks-0", JSON.stringify({ pid: 54321 }));
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      killFn: killDead,
      log: silentLog,
    });
    expect(result.cleared).toHaveLength(1);
    expect(result.cleared[0].reason).toBe("dead_owner");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps a live openclaw/node-owned lock UNCONDITIONALLY, even when old", () => {
    const dir = mkTmp();
    const p = writeLock(
      dir,
      "openclaw-state-locks-0",
      JSON.stringify({ pid: process.pid }),
    );
    // Age it far past every threshold.
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(p, old, old);
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      killFn: killAlive,
      readCmdline: () => "node /app/node_modules/.bin/openclaw gateway run",
      log: silentLog,
    });
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].reason).toBe("live_owner");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("keeps EPERM (exists under another uid) and unknown kill errnos", () => {
    for (const [killFn, reason] of [
      [killEperm, "live_unverified"],
      [killWeird, "kill_unknown"],
    ]) {
      const dir = mkTmp();
      writeLock(dir, "openclaw-state-locks-1", "pid=4242");
      const result = sweepStaleOpenclawStateLocks({
        tmpDir: dir,
        killFn,
        readCmdline: () => null,
        log: silentLog,
      });
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0].reason).toBe(reason);
    }
  });

  it("removes a reused-PID lock (alive but provably-foreign cmdline) — the killed-boot namespace-reset case", () => {
    const dir = mkTmp();
    writeLock(dir, "openclaw-state-locks-0", "pid: 57");
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      killFn: killAlive,
      readCmdline: () => "/usr/sbin/crond -n",
      log: silentLog,
    });
    expect(result.cleared).toHaveLength(1);
    expect(result.cleared[0].reason).toBe("pid_reused");
  });

  it("keeps alive-with-unreadable-cmdline (unknown is never dead)", () => {
    const dir = mkTmp();
    writeLock(dir, "openclaw-state-locks-0", "pid=99");
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      killFn: killAlive,
      readCmdline: () => null,
      log: silentLog,
    });
    expect(result.kept[0].reason).toBe("live_unverified");
  });

  it("never trusts a bare integer as a pid (timestamp-first payloads stay PID-less)", () => {
    // The repo's own lock format is {"pid":..,"at":<epoch-ms>}; a payload
    // where a timestamp comes first must NOT parse as a pid.
    expect(extractPidFromText('{"at":1788279875123}').pid).toBeNull();
    expect(extractPidFromText("1788279875123\n").pid).toBeNull();
    expect(extractPidFromText('{"pid":1234,"at":1788279875123}').pid).toBe(1234);
    expect(extractPidFromText("pid=77").pid).toBe(77);
    // Out-of-range pids are kept, not killed-and-misread.
    const dir = mkTmp();
    writeLock(dir, "openclaw-state-locks-0", 'pid="9999999999"');
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      killFn: killDead,
      log: silentLog,
    });
    expect(result.kept[0].reason).toBe("invalid_pid");
  });

  it("PID-less: young kept; 31-min-old removed ONLY with portReleased", () => {
    const dir = mkTmp();
    const p = writeLock(dir, "openclaw-state-locks-2", "no pid here");
    const now = Date.now();
    // Young: kept regardless.
    let result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      nowFn: () => now,
      portReleased: true,
      log: silentLog,
    });
    expect(result.kept[0].reason).toBe("young_or_unproven");
    // Old but port NOT observed released: kept (a wedged live gateway is not
    // abandoned).
    const old = new Date(now - 31 * 60 * 1000);
    fs.utimesSync(p, old, old);
    result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      nowFn: () => now,
      portReleased: false,
      log: silentLog,
    });
    expect(result.kept[0].reason).toBe("young_or_unproven");
    // Old AND port released: removed.
    result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      nowFn: () => now,
      portReleased: true,
      log: silentLog,
    });
    expect(result.cleared[0].reason).toBe("stale_mtime");
  });

  it("boot site: PID-less locks are abandoned when NO live openclaw process exists (the incident's own case)", () => {
    const dir = mkTmp();
    writeLock(dir, "openclaw-state-locks-0", "");
    // Minutes old — the mtime fallback alone would NOT clear it.
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      site: "boot",
      hasLiveOpenclawProcess: () => false,
      log: silentLog,
    });
    expect(result.cleared).toHaveLength(1);
    expect(result.cleared[0].reason).toBe("boot_no_live_openclaw");
  });

  it("boot site: kept when a live openclaw process exists or the /proc scan is unavailable", () => {
    for (const scan of [() => true, () => null]) {
      const dir = mkTmp();
      writeLock(dir, "openclaw-state-locks-0", "");
      const result = sweepStaleOpenclawStateLocks({
        tmpDir: dir,
        site: "boot",
        hasLiveOpenclawProcess: scan,
        log: silentLog,
      });
      expect(result.kept).toHaveLength(1);
    }
  });

  it("never probes or deletes through symlinks", () => {
    const dir = mkTmp();
    const victimDir = mkTmp();
    const victim = path.join(victimDir, "precious.txt");
    fs.writeFileSync(victim, "do not delete");
    fs.symlinkSync(victimDir, path.join(dir, "openclaw-state-locks-0"));
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      site: "boot",
      hasLiveOpenclawProcess: () => false,
      log: silentLog,
    });
    expect(result.kept[0].reason).toBe("symlink_or_special");
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("keeps foreign-uid entries", () => {
    const dir = mkTmp();
    writeLock(dir, "openclaw-state-locks-0", "pid=1");
    // Inject an fs whose lstat reports another uid.
    const realLstat = fs.lstatSync.bind(fs);
    const fakeFs = Object.create(fs);
    fakeFs.lstatSync = (p) => {
      const stats = realLstat(p);
      return new Proxy(stats, {
        get: (target, prop) =>
          prop === "uid" ? (process.getuid?.() ?? 0) + 1 : target[prop],
      });
    };
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      fsModule: fakeFs,
      killFn: killDead,
      log: silentLog,
    });
    expect(result.kept[0].reason).toBe("foreign_uid");
  });

  it("reaps via quarantine-rename and survives ENOENT races / oversized pid files / malformed JSON", () => {
    const dir = mkTmp();
    // >4KB pid file: only the head is read; explicit pid line inside it wins.
    writeLock(
      dir,
      "openclaw-state-locks-0",
      `pid=31337\n${"x".repeat(10_000)}`,
    );
    // Malformed JSON is safe (falls to the pid-line scan, finds none).
    writeLock(dir, "openclaw-state-locks-1", "{not json at all");
    // ENOENT race: entry listed but gone before lstat.
    const ghost = path.join(dir, "openclaw-state-locks-2");
    fs.writeFileSync(ghost, "");
    const racingFs = Object.create(fs);
    racingFs.lstatSync = (p) => {
      if (p === ghost) {
        fs.rmSync(ghost, { force: true });
        const err = new Error("gone");
        err.code = "ENOENT";
        throw err;
      }
      return fs.lstatSync(p);
    };
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      fsModule: racingFs,
      killFn: killDead,
      log: silentLog,
    });
    expect(result.cleared.map((c) => c.reason)).toEqual(["dead_owner"]);
    expect(result.kept.map((k) => k.reason)).toEqual(["young_or_unproven"]);
    expect(result.errors).toHaveLength(1);
    // No quarantine litter left behind.
    expect(
      fs.readdirSync(dir).filter((n) => n.includes(".reaping.")),
    ).toEqual([]);
  });

  it("emits the belt-disarmed breadcrumb after a failed readiness wait with zero matches", () => {
    const dir = mkTmp();
    const lines = [];
    sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      afterFailedReady: true,
      log: (msg) => lines.push(msg),
    });
    expect(lines.join("\n")).toContain("zero entries matched");
  });

  it("the kill switch skips everything (read per call)", () => {
    const dir = mkTmp();
    writeLock(dir, "openclaw-state-locks-0", JSON.stringify({ pid: 54321 }));
    process.env.ALPHACLAW_STATE_LOCK_SWEEP_DISABLED = "1";
    const result = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      killFn: killDead,
      log: silentLog,
    });
    expect(result.cleared).toEqual([]);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    // Re-enabled (per-call read): the same call now clears.
    delete process.env.ALPHACLAW_STATE_LOCK_SWEEP_DISABLED;
    const rerun = sweepStaleOpenclawStateLocks({
      tmpDir: dir,
      killFn: killDead,
      log: silentLog,
    });
    expect(rerun.cleared).toHaveLength(1);
  });
});
