// Operator box lock (box-lock.js) against the real flock(1) binary and a real
// operator-style holder (tests/fixtures/box-lock.sh, the convention AlphaClaw
// honors): waits then proceeds, refuses after the bounded wait, never touches
// the holder or the lock file, is released when AlphaClaw dies, and writes
// the operators' owner record and log lines.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const {
  createBoxLock,
  resolveBoxLockConfig,
  formatAcquireRecord,
  formatReleaseRecord,
  formatLogLine,
  parseOwnerRecord,
  parseLogLine,
  boxLockErrorBody,
} = require("../../lib/server/box-lock");

const kScript = path.join(__dirname, "..", "fixtures", "box-lock.sh");
const kModule = path.join(__dirname, "..", "..", "lib", "server", "box-lock.js");
const hasFlock = spawnSync("flock", ["--version"]).status === 0;
if (!hasFlock) console.warn("[box-lock.test] flock (util-linux) is not installed: the real-lock cases are skipped");

const kTempDirs = [];
const kChildren = [];
afterEach(() => {
  while (kChildren.length) {
    const child = kChildren.pop();
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  while (kTempDirs.length) fs.rmSync(kTempDirs.pop(), { recursive: true, force: true });
});

const setup = ({ waitSeconds = 5, flockBin } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-box-lock-"));
  kTempDirs.push(dir);
  const lockPath = path.join(dir, "box.lock");
  const config = resolveBoxLockConfig(
    { ALPHACLAW_BOX_LOCK_PATH: lockPath, ALPHACLAW_BOX_LOCK_WAIT_SECONDS: String(waitSeconds) },
    { logger: { warn: () => {}, error: () => {} } },
  );
  const events = [];
  const logger = { log: () => {}, warn: () => {}, error: () => {} };
  const boxLock = createBoxLock({ config, recordEvent: (row) => events.push(row), logger, ...(flockBin ? { flockBin } : {}) });
  const ownerPath = path.join(dir, "box.owner");
  const logPath = path.join(dir, "box.log");
  const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n") : []);
  const readOwner = () => JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  return { dir, lockPath, ownerPath, logPath, config, boxLock, events, readLog, readOwner };
};

const env = (lockPath) => ({ ...process.env, BOX_LOCK: lockPath, BOX_LOCK_BY: "ops-session" });

// The operator holds the lock for a while: resolves once its owner record
// names it, with the child (whose exit says the holder was never signalled).
const holdAsOperator = async (lockPath, { seconds = 30, owner = "OPS-7", step = "db-migrate" } = {}) => {
  const child = spawn("bash", [kScript, "run", owner, step, "--", "sleep", String(seconds)], {
    env: env(lockPath),
    stdio: "ignore",
  });
  kChildren.push(child);
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const ownerPath = lockPath.replace(/\.lock$/, ".owner");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(fs.readFileSync(ownerPath, "utf8")).started_at) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { child, exited };
};

const operatorRun = (lockPath, args) =>
  spawnSync("bash", [kScript, "run", "OPS-9", "probe", ...args], { env: env(lockPath), encoding: "utf8" });

describe("box lock configuration and records", () => {
  it("is off unless ALPHACLAW_BOX_LOCK_PATH is set, and derives the owner and log paths", () => {
    expect(resolveBoxLockConfig({})).toBeNull();
    expect(resolveBoxLockConfig({ ALPHACLAW_BOX_LOCK_PATH: "/srv/ops/box.lock" })).toEqual({
      lockPath: "/srv/ops/box.lock",
      ownerPath: "/srv/ops/box.owner",
      logPath: "/srv/ops/box.log",
      owner: "alphaclaw",
      waitMs: 120_000,
      error: null,
    });
    expect(
      resolveBoxLockConfig({
        ALPHACLAW_BOX_LOCK_PATH: "/srv/ops/guard",
        ALPHACLAW_BOX_LOCK_OWNER: "claw box#1",
        ALPHACLAW_BOX_LOCK_OWNER_PATH: "/srv/ops/who.json",
      }),
    ).toMatchObject({ ownerPath: "/srv/ops/who.json", logPath: "/srv/ops/guard.log", owner: "claw_box_1" });
  });

  it("clamps the wait to 0-900 s and falls back to 120 s on a non-number, saying so", () => {
    const warn = vi.fn();
    const logger = { warn, error: vi.fn() };
    expect(resolveBoxLockConfig({ ALPHACLAW_BOX_LOCK_PATH: "/x.lock", ALPHACLAW_BOX_LOCK_WAIT_SECONDS: "0" }, { logger }).waitMs).toBe(0);
    expect(resolveBoxLockConfig({ ALPHACLAW_BOX_LOCK_PATH: "/x.lock", ALPHACLAW_BOX_LOCK_WAIT_SECONDS: "5000" }, { logger }).waitMs).toBe(900_000);
    expect(resolveBoxLockConfig({ ALPHACLAW_BOX_LOCK_PATH: "/x.lock", ALPHACLAW_BOX_LOCK_WAIT_SECONDS: "soon" }, { logger }).waitMs).toBe(120_000);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      "[alphaclaw] ALPHACLAW_BOX_LOCK_WAIT_SECONDS=5000 clamped to 900s (valid range 0-900)",
      "[alphaclaw] ALPHACLAW_BOX_LOCK_WAIT_SECONDS=soon is not a whole number of seconds — falling back to 120s (valid range 0-900)",
    ]);
  });

  it("refuses every locked operation when a path is relative, instead of guessing", async () => {
    const config = resolveBoxLockConfig({ ALPHACLAW_BOX_LOCK_PATH: "box.lock" }, { logger: { error: () => {} } });
    expect(config.error).toContain("must be absolute");
    const boxLock = createBoxLock({ config, logger: { log() {}, warn() {}, error() {} }, recordEvent: () => {} });
    const fn = vi.fn();
    await expect(boxLock.withBoxLock({ step: "envars-write" }, fn)).rejects.toMatchObject({ code: "box_lock_unavailable", statusCode: 503 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("writes the operators' formats and reads theirs tolerantly (unknown keys ignored, by optional)", () => {
    const atMs = Date.parse("2026-10-25T20:29:51.123Z");
    expect(formatAcquireRecord({ owner: "alphaclaw", step: "gateway-restart", atMs, pid: 42, host: "box", by: "api:restart" })).toBe(
      '{"owner":"alphaclaw","step":"gateway-restart","started_at":"2026-10-25T20:29:51Z","pid":42,"host":"box","by":"api:restart"}',
    );
    expect(formatReleaseRecord({ owner: "alphaclaw", step: "gateway-restart", atMs, rc: 1, by: "api:restart" })).toBe(
      '{"owner":"alphaclaw","step":"gateway-restart","finished_at":"2026-10-25T20:29:51Z","rc":1,"by":"api:restart"}',
    );
    expect(formatLogLine({ event: "acquire", owner: "alphaclaw", step: "git-sync", atMs, pid: 42, by: "git-sync:scheduled" })).toBe(
      "2026-10-25T20:29:51Z acquire alphaclaw git-sync pid=42 by=git-sync:scheduled",
    );
    expect(formatLogLine({ event: "release", owner: "alphaclaw", step: "git-sync", atMs, rc: 0, by: "git-sync:scheduled" })).toBe(
      "2026-10-25T20:29:51Z release alphaclaw git-sync rc=0 by=git-sync:scheduled",
    );
    expect(parseLogLine("2026-10-25T20:29:51Z acquire OPS-24 config-retest pid=396131")).toEqual({
      at: "2026-10-25T20:29:51Z", event: "acquire", owner: "OPS-24", step: "config-retest", pid: 396131, rc: null, by: null,
    });
    expect(parseLogLine("2026-10-25T20:30:00Z release OPS-24 config-retest rc=0 by=sess-1 extra=yes")).toMatchObject({ event: "release", rc: 0, by: "sess-1" });
    expect(parseLogLine("garbage")).toBeNull();
    expect(parseOwnerRecord('{"owner":"OPS-24","step":"s","started_at":"2026-10-25T20:29:51Z","pid":7,"future":1}\n')).toMatchObject({
      owner: "OPS-24", started_at: "2026-10-25T20:29:51Z", pid: 7, by: null,
    });
    expect(parseOwnerRecord("not json")).toBeNull();
  });
});

describe.runIf(hasFlock)("box lock with the real flock binary", () => {
  it("waits while an operator holds the lock, names the holder, then proceeds once it is released, with the operator's records intact around its own", async () => {
    const h = setup({ waitSeconds: 10 });
    const lockIno = fs.statSync((fs.writeFileSync(h.lockPath, "", { flag: "a" }), h.lockPath)).ino;
    const holder = await holdAsOperator(h.lockPath, { seconds: 1 });
    const onWait = vi.fn();
    const ran = vi.fn(async () => {
      // While AlphaClaw holds it, the operator's script gets rc 75 and the
      // label names AlphaClaw.
      const busy = operatorRun(h.lockPath, ["--", "true"]);
      expect(busy.status).toBe(75);
      expect(busy.stdout).toContain('box_lock_busy: {"owner":"alphaclaw","step":"gateway-restart"');
      return "done";
    });
    const startedAt = Date.now();
    await expect(h.boxLock.withBoxLock({ step: "gateway-restart", by: "api:restart", onWait }, ran)).resolves.toBe("done");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({
      holder: expect.objectContaining({ owner: "OPS-7", step: "db-migrate", by: "ops-session", started_at: expect.stringMatching(/Z$/) }),
    }));
    expect(await holder.exited).toEqual({ code: 0, signal: null });
    const log = h.readLog();
    expect(log).toHaveLength(4);
    expect(log[0]).toMatch(/^\S+Z acquire OPS-7 db-migrate pid=\d+ by=ops-session$/);
    expect(log[1]).toMatch(/^\S+Z release OPS-7 db-migrate rc=0 by=ops-session$/);
    expect(log[2]).toMatch(new RegExp("^\\S+Z acquire alphaclaw gateway-restart pid=" + process.pid + " by=api:restart$"));
    expect(log[3]).toMatch(/^\S+Z release alphaclaw gateway-restart rc=0 by=api:restart$/);
    expect(h.readOwner()).toEqual({ owner: "alphaclaw", step: "gateway-restart", finished_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/), rc: 0, by: "api:restart" });
    expect(fs.existsSync(h.ownerPath + ".tmp")).toBe(false);
    const lockStat = fs.statSync(h.lockPath);
    expect(lockStat.size).toBe(0);
    expect(lockStat.ino).toBe(lockIno);
    expect(h.events.map((row) => row.details.kind)).toEqual(["waiting", "acquired_after_wait"]);
  });

  it("refuses with 409 box_locked after the bounded wait and never touches the holder, its record or the lock file", async () => {
    const h = setup({ waitSeconds: 1 });
    const holder = await holdAsOperator(h.lockPath, { seconds: 30 });
    const ownerBefore = fs.readFileSync(h.ownerPath, "utf8");
    const lockIno = fs.statSync(h.lockPath).ino;
    const fn = vi.fn();
    let error;
    try {
      await h.boxLock.withBoxLock({ step: "envars-write", by: "api:env" }, fn);
    } catch (caught) {
      error = caught;
    }
    expect(fn).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: "box_locked", statusCode: 409 });
    expect(error.message).toMatch(/^The box lock is held by OPS-7 \(db-migrate\) since \S+Z, so AlphaClaw did not start saving Envars after waiting 1s\.$/);
    expect(boxLockErrorBody(error)).toMatchObject({
      ok: false,
      code: "box_locked",
      boxLock: { step: "envars-write", holder: { owner: "OPS-7", step: "db-migrate" }, since: expect.stringMatching(/Z$/) },
    });
    expect(holder.child.exitCode).toBeNull();
    expect(holder.child.signalCode).toBeNull();
    expect(fs.readFileSync(h.ownerPath, "utf8")).toBe(ownerBefore);
    expect(h.readLog()).toHaveLength(1);
    expect(fs.statSync(h.lockPath)).toMatchObject({ size: 0, ino: lockIno });
    expect(h.events.map((row) => row.details.kind)).toEqual(["waiting", "refused"]);
    // waitMs 0 (?boxLockWait=0 / a watchdog caller) refuses at once.
    const quick = Date.now();
    await expect(h.boxLock.withBoxLock({ step: "git-sync", waitMs: 0, background: true }, fn)).rejects.toMatchObject({ code: "box_locked" });
    await expect(h.boxLock.withBoxLock({ step: "git-sync", waitMs: 0, background: true }, fn)).rejects.toMatchObject({ code: "box_locked" });
    expect(Date.now() - quick).toBeLessThan(1000);
    // A background caller's deferrals are one event per holder, not per tick.
    expect(h.events.filter((row) => row.details.kind === "deferred")).toHaveLength(1);
  });

  it("is released when AlphaClaw's process dies (SIGKILL): no stale lock, the stale owner record is only a label", async () => {
    const h = setup();
    const child = spawn(process.execPath, ["-e", [
      "const { createBoxLock, resolveBoxLockConfig } = require(" + JSON.stringify(kModule) + ");",
      "const lock = createBoxLock({ config: resolveBoxLockConfig({ ALPHACLAW_BOX_LOCK_PATH: " + JSON.stringify(h.lockPath) + " }), recordEvent: () => {}, logger: { log() {}, warn() {}, error() {} } });",
      "lock.acquireSync({ step: 'doctor-fix', by: 'watchdog:repair_health_timer' });",
      "process.stdout.write('held\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n")], { stdio: ["ignore", "pipe", "inherit"] });
    kChildren.push(child);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    expect(operatorRun(h.lockPath, ["--", "true"]).status).toBe(75);
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect(h.readOwner()).toMatchObject({ owner: "alphaclaw", step: "doctor-fix", started_at: expect.any(String), pid: child.pid });
    const status = await h.boxLock.readStatus();
    expect(status).toMatchObject({ enabled: true, state: "free", holder: null, last: { step: "doctor-fix", pid: child.pid } });
    expect(operatorRun(h.lockPath, ["--", "true"]).status).toBe(0);
  });

  it("reports held/free with AlphaClaw's own holds and waits and the log's tail, without writing records for its probe", async () => {
    const h = setup({ waitSeconds: 10 });
    expect(await h.boxLock.readStatus()).toMatchObject({ state: "free", holder: null, heldByAlphaclaw: [], waits: [], recent: [] });
    expect(fs.existsSync(h.logPath)).toBe(false);
    const holder = await holdAsOperator(h.lockPath, { seconds: 1 });
    expect(await h.boxLock.readStatus()).toMatchObject({ state: "held", holder: { owner: "OPS-7", step: "db-migrate" } });
    let during = null;
    const pending = h.boxLock.withBoxLock(
      { step: "gateway-restart", by: "api:restart", opId: "op-1", onWait: () => { during = h.boxLock.readStatus(); } },
      async () => h.boxLock.readStatus(),
    );
    const inside = await pending;
    expect(await during).toMatchObject({ state: "held", waits: [{ step: "gateway-restart", by: "api:restart", opId: "op-1", holder: { owner: "OPS-7" } }] });
    expect(inside).toMatchObject({ state: "held", heldByAlphaclaw: [{ step: "gateway-restart", opId: "op-1" }], holder: { owner: "alphaclaw", step: "gateway-restart", pid: process.pid } });
    await holder.exited;
    expect((await h.boxLock.readStatus()).recent.map((line) => line.event + " " + line.owner)).toEqual([
      "acquire OPS-7", "release OPS-7", "acquire alphaclaw", "release alphaclaw",
    ]);
  });

  it("is reentrant inside one operation and serializes unrelated ones in the process", async () => {
    const h = setup({ waitSeconds: 10 });
    const order = [];
    await h.boxLock.withBoxLock({ step: "doctor-fix", by: "api:repair" }, async () => {
      // A restart inside the repair runs without a second acquire.
      await h.boxLock.withBoxLock({ step: "gateway-restart", by: "watchdog:repair_replace", waitMs: 0 }, async () => order.push("nested"));
      expect(h.boxLock.tryWithBoxLockSync({ step: "sweep-delete" }, () => "swept")).toEqual({ ran: true, value: "swept" });
    });
    const first = h.boxLock.withBoxLock({ step: "git-sync" }, async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push("first:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = h.boxLock.withBoxLock({ step: "envars-write" }, async () => order.push("second"));
    await Promise.all([first, second]);
    expect(order).toEqual(["nested", "first:start", "first:end", "second"]);
    expect(h.readLog().filter((line) => line.includes(" acquire "))).toHaveLength(3);
  });

  it("a failing operation releases with rc 1; rcOf maps a reported failure", async () => {
    const h = setup();
    await expect(h.boxLock.withBoxLock({ step: "envars-write" }, async () => {
      throw new Error("disk full");
    })).rejects.toThrow("disk full");
    expect(h.readOwner()).toMatchObject({ rc: 1 });
    await h.boxLock.withBoxLock({ step: "git-sync", rcOf: (result) => (result.ok ? 0 : 1) }, async () => ({ ok: false }));
    expect(h.readLog().at(-1)).toMatch(/release alphaclaw git-sync rc=1 by=alphaclaw$/);
  });

  it("skips a sync sweep while another operator holds the lock, and runs it otherwise", async () => {
    const h = setup();
    expect(h.boxLock.tryWithBoxLockSync({ step: "sweep-delete", by: "snapshot-sweep:periodic" }, () => 3)).toEqual({ ran: true, value: 3 });
    const holder = await holdAsOperator(h.lockPath, { seconds: 30 });
    const fn = vi.fn();
    const skipped = h.boxLock.tryWithBoxLockSync({ step: "sweep-delete" }, fn);
    expect(skipped.ran).toBe(false);
    expect(skipped.error).toMatchObject({ code: "box_locked" });
    expect(fn).not.toHaveBeenCalled();
    expect(holder.child.exitCode).toBeNull();
  });

  it("an aborted wait stops waiting and takes nothing", async () => {
    const h = setup({ waitSeconds: 30 });
    await holdAsOperator(h.lockPath, { seconds: 30 });
    const controller = new AbortController();
    const fn = vi.fn();
    const pending = h.boxLock.withBoxLock({ step: "gateway-restart", signal: controller.signal, onWait: () => setTimeout(() => controller.abort(), 100) }, fn);
    await expect(pending).rejects.toMatchObject({ code: "box_lock_aborted" });
    expect(fn).not.toHaveBeenCalled();
    expect(h.readLog().some((line) => line.includes("alphaclaw"))).toBe(false);
  });
});

describe("box lock guard expectations", () => {
  it("spawns flock with argv only, never a shell string", () => {
    const { scanShellStrings } = require("./guards/scanners");
    expect(scanShellStrings(fs.readFileSync(kModule, "utf8"), "lib/server/box-lock.js")).toEqual([]);
    expect(fs.readFileSync(kModule, "utf8")).not.toMatch(/\bexec(Sync)?\(|shell\s*:/);
  });
});

describe("box lock without a flock binary", () => {
  it("refuses the operation (503 box_lock_unavailable) with the reason, rather than running unserialized", async () => {
    const h = setup({ flockBin: path.join(os.tmpdir(), "no-such-dir", "flock") });
    const fn = vi.fn();
    const error = await h.boxLock.withBoxLock({ step: "gateway-restart" }, fn).catch((caught) => caught);
    expect(fn).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: "box_lock_unavailable", statusCode: 503 });
    expect(error.message).toBe("AlphaClaw cannot take the box lock (the flock binary (util-linux) is not installed), so it did not start the gateway restart.");
    expect(h.events.map((row) => row.status)).toEqual(["failed"]);
    expect((await h.boxLock.readStatus()).state).toBe("unavailable");
  });
});
