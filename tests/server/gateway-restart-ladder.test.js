// The stop ladder + cold restart (v0.10.0): one way to stop (ask → SIGTERM →
// SIGKILL, identity-bound, process-group wide), one way to start (`gateway
// run`, managed, detached), one proof of "it's the new one" (/readyz from a
// listener inside the new child's tree). Driven against a fake process world
// so the escalation runs in fake-timer milliseconds; the real pinned binary
// is covered by tests/live.
process.env.GATEWAY_RESTART_READY_TIMEOUT = "30";

const EventEmitter = require("events");
const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const { kDefaultGatewayPort } = require("../../lib/server/constants");

const modulePath = require.resolve("../../lib/server/gateway");
const gatewayIdentity = require("../../lib/server/gateway-identity");
const lockContention = require("../../lib/server/openclaw-lock-contention");
const lsofShim = require("../../lib/server/lsof-shim");
const autotune = require("../../lib/server/autotune");

const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalCreateConnection = net.createConnection;
const originalFetch = globalThis.fetch;
const originalNoRespawn = process.env.OPENCLAW_NO_RESPAWN;

// Fake pids far above any real one: resolveFirstChildPid still walks the
// real /proc when nothing else answers, and a collision with a live process
// would hand it a stranger's child.
let nextPid = 910000;

const createSocket = (isRunning) => ({
  setTimeout: vi.fn(),
  destroy: vi.fn(),
  on(event, handler) {
    const running = isRunning();
    if (running && event === "connect") setImmediate(handler);
    if (!running && event === "error") setImmediate(handler);
    return this;
  },
});

// A process world: pids with liveness, parentage, who listens on the port,
// and how each reacts to signals. Spawned children are EventEmitters with
// the ChildProcess surface the module reads.
const createWorld = () => {
  const procs = new Map();
  const world = {
    procs,
    signals: [],
    signalLog: [],
    readyState: "ready", // what /readyz answers once a listener is up
    restartCli: "graceful", // graceful | refuse | ignored
    gracefulDelayMs: 500,
    cliExitDelayMs: 300,
    drainExitMs: null,
    restartArgs: [],
    listenDelayMs: 200,
    lockWaitLine: false,
    slowReap: new Set(),
    slowReapMs: 300,
    spawned: [],
    add(pid, { ppid = null, listens = false, openclaw = true, ignoreSigterm = false, pgid = null, child = null, cmd = null, zombie = false, unknown = false } = {}) {
      procs.set(pid, { pid, ppid, alive: true, listens, openclaw, ignoreSigterm, pgid: pgid ?? pid, child, exitCode: null, cmd: cmd ?? (openclaw ? "node openclaw" : "node service.mjs"), zombie, unknown });
      return procs.get(pid);
    },
    alive: (pid) => procs.get(pid)?.alive === true,
    // Three-way liveness as gateway-identity.resolveProcessVerdict answers it:
    // a dead pid is gone; a `zombie` proc is gone even while kill(0) would
    // succeed; an `unknown` proc has an unreadable /proc.
    verdict(pid) {
      const proc = procs.get(pid);
      if (!proc || !proc.alive) return { verdict: "gone", reason: "esrch" };
      if (proc.zombie) return { verdict: "gone", reason: "state_z" };
      if (proc.unknown) return { verdict: "unknown", reason: "stat_eacces" };
      return { verdict: "alive", reason: "state_s" };
    },
    groupMembers: (pgid) => [...procs.values()].filter((p) => p.alive && p.pgid === pgid).map((p) => p.pid).sort((a, b) => a - b),
    listeners: () => [...procs.values()].filter((p) => p.alive && p.listens).map((p) => p.pid).sort((a, b) => a - b),
    tree(root) {
      if (!world.alive(root)) return [];
      const out = [root];
      for (let i = 0; i < out.length; i += 1) {
        for (const p of procs.values()) if (p.alive && p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid);
      }
      return out;
    },
    exit(pid, code, signal = null) {
      const proc = procs.get(pid);
      if (!proc || !proc.alive) return;
      proc.alive = false;
      proc.listens = false;
      proc.exitCode = code;
      // A drain or a stall belongs to the gateway that just went away; the
      // next one boots into the plain ready state.
      if (world.listeners().length === 0 && (world.readyState === "draining" || world.readyState === "hang")) {
        world.readyState = "ready";
      }
      for (const p of procs.values()) if (p.alive && p.ppid === pid) world.exit(p.pid, code, signal);
      const child = proc.child;
      if (!child) return;
      const reap = () => {
        child.exitCode = signal ? null : code;
        child.signalCode = signal;
        child.emit("exit", child.exitCode, signal);
        child.emit("close", child.exitCode, signal);
      };
      // slowReap: the kernel already reports the pid gone, but Node has not
      // read the SIGCHLD yet, so the ChildProcess still looks live.
      if (world.slowReap.has(pid)) setTimeout(reap, world.slowReapMs);
      else reap();
    },
    signal(pid, sig) {
      world.signals.push([pid, sig]);
      world.signalLog.push({ pid, sig, at: Date.now() });
      const targets = pid < 0 ? [...procs.values()].filter((p) => p.alive && p.pgid === -pid).map((p) => p.pid) : [pid];
      if (sig === 0) {
        if (targets.some((t) => world.alive(t))) return true;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (!targets.some((t) => world.alive(t))) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      for (const t of targets) {
        const proc = procs.get(t);
        if (!proc?.alive) continue;
        if (sig === "SIGKILL") world.exit(t, null, "SIGKILL");
        else if (sig === "SIGTERM" && !proc.ignoreSigterm) world.exit(t, 0);
      }
      return true;
    },
    makeChild(pid) {
      const child = new EventEmitter();
      child.pid = pid;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.killed = false;
      child.kill = vi.fn((sig = "SIGTERM") => {
        child.killed = true;
        try {
          world.signal(pid, sig);
        } catch {}
        return true;
      });
      return child;
    },
    // `gateway run`: a launcher whose worker binds the port shortly after.
    spawnGateway({ ignoreSigterm = false, exitBeforeReady = null, neverListen = false } = {}) {
      const launcherPid = nextPid++;
      const workerPid = nextPid++;
      const child = world.makeChild(launcherPid);
      world.add(launcherPid, { ppid: process.pid, child, ignoreSigterm });
      world.add(workerPid, { ppid: launcherPid, pgid: launcherPid, ignoreSigterm });
      setTimeout(() => {
        if (exitBeforeReady) {
          child.stderr.emit("data", Buffer.from(`${exitBeforeReady.stderr || "fatal: boom"}\n`));
          world.exit(launcherPid, exitBeforeReady.code ?? 1);
          return;
        }
        if (world.lockWaitLine) {
          const line =
            typeof world.lockWaitLine === "string"
              ? world.lockWaitLine
              : "waiting for Gateway state ownership held by another OpenClaw process, up to 300 s";
          child.stdout.emit("data", Buffer.from(`${line}\n`));
        }
        if (neverListen || !world.alive(workerPid)) return;
        procs.get(workerPid).listens = true;
        child.stdout.emit("data", Buffer.from("http server listening on 127.0.0.1\n"));
      }, world.listenDelayMs);
      world.spawned.push({ kind: "run", launcherPid, workerPid, child });
      return child;
    },
    // `gateway restart --wait`: the graceful ask.
    // restartCli is one mode for every attempt, or a list consumed one
    // attempt at a time:
    //   graceful          the gateway exits 0 after gracefulDelayMs
    //   refuse            exit 1, no output, the gateway keeps admitting
    //   rejected          exit 1 with an explicit OpenClaw refusal
    //   ignored           the CLI never exits, the gateway never stops
    //   unknown_draining  the request lands (the gateway drains, exits 0 at
    //                     drainExitMs if set) but the ack is lost: exit 1
    //                     with the CLI's "outcome is unknown" text
    //   killed_draining   same, but the CLI dies by SIGKILL (OOM killer)
    //   unknown_dropped   the ack is lost AND the request was rolled back:
    //                     exit 1 "outcome is unknown", the gateway admits
    spawnRestartCli(args = []) {
      const pid = nextPid++;
      const child = world.makeChild(pid);
      world.add(pid, { ppid: process.pid, child, openclaw: true });
      world.restartArgs.push(args);
      const mode = Array.isArray(world.restartCli) ? (world.restartCli.shift() ?? "graceful") : world.restartCli;
      const gateway = [...procs.values()].find((p) => p.alive && p.listens);
      const exitGatewayRoot = () => {
        if (!gateway?.alive) return;
        const root = [...procs.values()].find((p) => p.alive && p.pid === gateway.ppid) || gateway;
        world.exit(root.pid, 0);
      };
      const unknownText = "Gateway restart failed: GatewayTransportError: gateway timeout after 10000ms\nGateway target: ws://127.0.0.1:18789\nThe request was already sent to the gateway, so the operation may have been applied even though no response arrived; its outcome is unknown.\n";
      if (mode === "refuse" || !gateway) {
        setTimeout(() => world.exit(pid, 1), 20);
      } else if (mode === "rejected") {
        setTimeout(() => {
          child.stderr.emit("data", Buffer.from("Gateway restart failed: Error: target gateway no longer owns the active lock\n"));
          world.exit(pid, 1);
        }, 20);
      } else if (mode === "graceful") {
        setTimeout(exitGatewayRoot, world.gracefulDelayMs);
      } else if (mode === "unknown_draining" || mode === "killed_draining") {
        setTimeout(() => { world.readyState = "draining"; }, 50);
        setTimeout(() => {
          if (mode === "killed_draining") {
            world.exit(pid, null, "SIGKILL");
            return;
          }
          child.stderr.emit("data", Buffer.from(unknownText));
          world.exit(pid, 1);
        }, world.cliExitDelayMs);
        if (world.drainExitMs != null) setTimeout(exitGatewayRoot, world.drainExitMs);
      } else if (mode === "unknown_dropped") {
        setTimeout(() => {
          child.stderr.emit("data", Buffer.from(unknownText));
          world.exit(pid, 1);
        }, world.cliExitDelayMs);
      }
      world.spawned.push({ kind: "restart", pid, child });
      return child;
    },
  };
  return world;
};

const installWorld = (world) => {
  vi.spyOn(gatewayIdentity, "findPortListenerPids").mockImplementation(() => world.listeners());
  vi.spyOn(gatewayIdentity, "listProcessTree").mockImplementation((pid) => world.tree(pid));
  vi.spyOn(gatewayIdentity, "readProcessGroupId").mockImplementation((pid) =>
    pid === process.pid ? 1 : (world.procs.get(pid)?.pgid ?? null),
  );
  vi.spyOn(gatewayIdentity, "isSameProcess").mockImplementation((pid) => world.verdict(pid).verdict === "alive");
  vi.spyOn(gatewayIdentity, "resolveProcessVerdict").mockImplementation((pid) => world.verdict(pid));
  vi.spyOn(gatewayIdentity, "isOpenclawPid").mockImplementation((pid) => world.procs.get(pid)?.openclaw === true);
  vi.spyOn(gatewayIdentity, "isOpenclawProgramPid").mockImplementation((pid) => world.procs.get(pid)?.openclaw === true);
  vi.spyOn(gatewayIdentity, "listProcessGroupMembers").mockImplementation((pgid) => world.groupMembers(pgid));
  vi.spyOn(gatewayIdentity, "describeProcessCommand").mockImplementation((pid) => world.procs.get(pid)?.cmd ?? "");
  vi.spyOn(lockContention, "readProcStartTicks").mockImplementation((pid) => (world.procs.has(pid) ? 1 : null));
  vi.spyOn(lockContention, "readProcParentPid").mockImplementation((pid) => world.procs.get(pid)?.ppid ?? null);
  // The ask preflight needs an lsof on the ask CLI's PATH; the world has one
  // unless a test takes it away (world.lsof = null).
  world.lsof = "/usr/bin/lsof";
  vi.spyOn(lsofShim, "resolveAskLsofPath").mockImplementation(() =>
    world.lsof ? { path: world.lsof, kind: "real" } : { path: null, kind: "none" },
  );
  vi.spyOn(lockContention, "listLiveOpenclawProcesses").mockReturnValue([]);
  vi.spyOn(process, "kill").mockImplementation((pid, sig) => world.signal(pid, sig));
  childProcess.spawn = vi.fn((file, args, options) => {
    if (args?.[0] === "gateway" && args?.[1] === "run") return world.spawnGateway(world.nextRunOptions || {});
    if (args?.[0] === "gateway" && args?.[1] === "restart") return world.spawnRestartCli(args);
    throw new Error(`unexpected spawn ${file} ${args?.join(" ")}`);
  });
  childProcess.execFile = vi.fn((file, args, opts, cb) => cb(null, "", ""));
  fs.existsSync = vi.fn(() => true);
  fs.readFileSync = vi.fn((target, ...rest) =>
    String(target).endsWith("openclaw.json")
      ? JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } } })
      : originalReadFileSync(target, ...rest),
  );
  net.createConnection = vi.fn(() => createSocket(() => world.listeners().length > 0));
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    if (world.readyState === "hang" && world.listeners().length > 0) {
      // A stalled gateway: the probe only ends by its own abort.
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (world.listeners().length === 0) {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    const ready = world.readyState === "ready";
    // The real /readyz shape (2026.9.8 and 2026.10.2 server-start-*.mjs): no
    // `status` field; a transitional phase is a single failing[] entry.
    const phaseFailing = { starting: "startup-sidecars", draining: "gateway-draining" };
    return {
      status: ready ? 200 : 503,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify(ready ? { ready: true, failing: [] } : { ready: false, failing: [phaseFailing[world.readyState]] }),
    };
  });
};

// Fake timers fake setImmediate too (the TCP probe mock resolves through it),
// so every module promise is driven by advancing the clock in slices until
// it settles or the slice budget is spent.
const drive = async (promise, ms = 10000) => {
  let done = false;
  const settled = promise.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  ).finally(() => { done = true; });
  for (let elapsed = 0; !done && elapsed < ms; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  if (!done) await vi.advanceTimersByTimeAsync(100);
  return settled;
};

const bootManaged = async (gateway, world) => {
  const { value: child, error } = await drive(gateway.startGateway(), 2000);
  if (error) throw error;
  // Let the worker bind the port and the "listening on" sniff fire.
  await vi.advanceTimersByTimeAsync(world.listenDelayMs + 100);
  return { child, launcherPid: child.pid, workerPid: world.spawned.at(-1).workerPid };
};

describe("stop ladder + cold restart (v0.10.0)", () => {
  let world;
  let gateway;
  let quiet;
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.OPENCLAW_NO_RESPAWN;
    quiet = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ];
    world = createWorld();
    installWorld(world);
    delete require.cache[modulePath];
    gateway = require(modulePath);
  });
  afterEach(() => {
    gateway.setGatewayExitHandler(null);
    gateway.setGatewayLaunchHandler(null);
    for (const spy of quiet) spy.mockRestore();
    vi.restoreAllMocks();
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    net.createConnection = originalCreateConnection;
    globalThis.fetch = originalFetch;
    if (originalNoRespawn === undefined) delete process.env.OPENCLAW_NO_RESPAWN;
    else process.env.OPENCLAW_NO_RESPAWN = originalNoRespawn;
    vi.useRealTimers();
    delete require.cache[modulePath];
  });

  const ladder = { askGraceMs: 3000, termGraceMs: 2000, killGraceMs: 1000 };
  const runRestart = (options = {}, ms = 10000) => drive(gateway.restartGateway(vi.fn(), { ladder, ...options }), ms);

  it("asks OpenClaw to restart itself first: the gateway exits 0 inside the grace, no signal is sent, a fresh `gateway run` is spawned detached, /readyz from the new worker proves it, autotune is stamped only then, and the launch handler names the worker as the serving pid", async () => {
    const exitHandler = vi.fn();
    const launchHandler = vi.fn();
    gateway.setGatewayExitHandler(exitHandler);
    gateway.setGatewayLaunchHandler(launchHandler);
    const stamp = vi.spyOn(autotune, "stampGatewayEnvApplied").mockReturnValue({ ok: true });
    const { launcherPid, workerPid } = await bootManaged(gateway, world);
    expect(launchHandler).toHaveBeenCalledWith(expect.objectContaining({ pid: launcherPid, servingPid: workerPid, rootPid: launcherPid, supervision: "managed" }));
    launchHandler.mockClear();
    const onStep = vi.fn();

    const { value, error } = await runRestart({ onStep }, 5000);
    expect(error).toBeNull();
    expect(value).toMatchObject({ ok: true, how: "graceful", durationMs: expect.any(Number), downtimeMs: expect.any(Number) });

    // The ask went through the CLI with the grace as its --wait; nothing was signalled.
    expect(childProcess.spawn).toHaveBeenCalledWith("openclaw", ["gateway", "restart", "--wait", "3000ms"], expect.objectContaining({ env: expect.any(Object) }));
    // The only SIGTERM is the ladder reaping its own `gateway restart` CLI
    // child once the gateway was gone; the gateway tree got no signal.
    const cliPid = world.spawned.find((sp) => sp.kind === "restart").pid;
    expect(world.signals.filter(([, sig]) => sig === "SIGTERM" || sig === "SIGKILL")).toEqual([[cliPid, "SIGTERM"]]);
    // The old tree is gone, the new one is up, detached (its own process group).
    expect(world.alive(launcherPid)).toBe(false);
    expect(world.alive(workerPid)).toBe(false);
    const runSpawn = childProcess.spawn.mock.calls.filter(([, args]) => args[1] === "run");
    expect(runSpawn).toHaveLength(2);
    expect(runSpawn[1][2]).toMatchObject({ detached: true });
    const next = world.spawned.filter((s) => s.kind === "run").at(-1);
    expect(world.listeners()).toEqual([next.workerPid]);
    // Our own stop is an EXPECTED exit (code 0), never a crash.
    expect(exitHandler).toHaveBeenCalledWith(expect.objectContaining({ pid: launcherPid, workerPid, code: 0, expectedExit: true, supervisor: true }));
    // Step stream: prepare → stopping(asking) → stopping done {graceful} → launching → waiting_ready → (ready is the route's).
    const steps = onStep.mock.calls.map(([s]) => s);
    expect(steps).toEqual([
      { step: "preparing_plugins", status: "running" },
      { step: "preparing_plugins", status: "skipped" },
      { step: "stopping", status: "running", detail: { phase: "asking", graceSeconds: 3 } },
      { step: "stopping", status: "done", detail: { how: "graceful" } },
      { step: "launching", status: "running" },
      { step: "launching", status: "done" },
      { step: "waiting_ready", status: "running", budgetMs: 30000 },
    ]);
    // Autotune stamped exactly once, after ready (the boot launch stamped once at spawn before).
    expect(stamp).toHaveBeenCalledTimes(2);
    expect(launchHandler).toHaveBeenCalledWith(expect.objectContaining({ pid: next.launcherPid, servingPid: next.workerPid, supervision: "managed" }));
    // Both notices for the new child (listening, then ready) carry its spawn time.
    const nextNotices = launchHandler.mock.calls.map(([payload]) => payload).filter((payload) => payload.pid === next.launcherPid);
    expect(nextNotices.length).toBe(2);
    expect(nextNotices.map((payload) => payload.launchedAt)).toEqual([expect.any(Number), nextNotices[0].launchedAt]);
    expect(gateway.getManagedGatewayWorkerPid()).toBe(next.workerPid);
  });

  it("a busy gateway that ignores the ask and SIGTERM is SIGKILLed as a process GROUP — launcher and worker both die (the worker is what holds the port), the step names the forced stop, and the exit stays expected", async () => {
    const exitHandler = vi.fn();
    gateway.setGatewayExitHandler(exitHandler);
    world.nextRunOptions = { ignoreSigterm: true };
    const { launcherPid, workerPid } = await bootManaged(gateway, world);
    world.nextRunOptions = {};
    world.restartCli = "ignored";
    const onStep = vi.fn();

    const { value, error } = await runRestart({ onStep }, gateway.gatewayStopAskBudgetMs(3000) + 2000 + 1000 + 2000);
    expect(error).toBeNull();
    expect(value.how).toBe("sigkill");
    expect(world.signals).toEqual(expect.arrayContaining([[-launcherPid, "SIGTERM"], [-launcherPid, "SIGKILL"]]));
    expect(world.alive(workerPid)).toBe(false);
    expect(world.alive(launcherPid)).toBe(false);
    const stopping = onStep.mock.calls.map(([s]) => s).filter((s) => s.step === "stopping");
    expect(stopping).toEqual([
      { step: "stopping", status: "running", detail: { phase: "asking", graceSeconds: 3 } },
      { step: "stopping", status: "running", detail: { phase: "terminating" } },
      { step: "stopping", status: "running", detail: { phase: "forcing", graceSeconds: 3 } },
      { step: "stopping", status: "done", detail: { how: "sigkill" } },
    ]);
    expect(exitHandler).toHaveBeenCalledWith(expect.objectContaining({ pid: launcherPid, code: null, signal: "SIGKILL", expectedExit: true }));
  });

  it("a refused restart request (the CLI exits non-zero) escalates to SIGTERM at once instead of waiting out the ask grace", async () => {
    const { launcherPid } = await bootManaged(gateway, world);
    world.restartCli = "refuse";
    const { value, error } = await runRestart({}, 1500);
    expect(error).toBeNull();
    expect(value.how).toBe("sigterm");
    expect(world.signals).toContainEqual([-launcherPid, "SIGTERM"]);
  });

  it("OPENCLAW_NO_RESPAWN=1 (the supervisor escape hatch) skips the ask — an in-process restart could never free the port — and goes straight to SIGTERM", async () => {
    process.env.OPENCLAW_NO_RESPAWN = "1";
    delete require.cache[modulePath];
    gateway = require(modulePath);
    await bootManaged(gateway, world);
    const { value, error } = await runRestart({}, 1500);
    expect(error).toBeNull();
    expect(value.how).toBe("sigterm");
    expect(childProcess.spawn.mock.calls.some(([, args]) => args[1] === "restart")).toBe(false);
  });

  it("refuses to stop when the port is held by a process that is not the gateway: stop_refused, nothing signalled, nothing spawned", async () => {
    const stranger = nextPid++;
    world.add(stranger, { ppid: 1, listens: true, openclaw: false });
    const { error } = await runRestart({}, 500);
    expect(error).toBeInstanceOf(gateway.GatewayStopError);
    expect(error.code).toBe("stop_refused");
    expect(error.message).toContain(String(stranger));
    expect(world.signals.filter(([, sig]) => sig !== 0)).toEqual([]);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("refuses when the port answers but no process can be identified behind it (no managed child, no serving tree, no listener in /proc)", async () => {
    net.createConnection = vi.fn(() => createSocket(() => true));
    const { error } = await runRestart({}, 500);
    expect(error).toMatchObject({ code: "stop_refused" });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("an adopted incumbent (serving tree discovered in /proc, no managed child) is stopped per pid in tree order with start ticks re-checked, and a pid that changed identity mid-ladder is never signalled", async () => {
    const root = nextPid++;
    const worker = nextPid++;
    world.add(root, { ppid: 1, pgid: 4242 }); // not its own group leader: per-pid signalling
    world.add(worker, { ppid: root, listens: true, ignoreSigterm: true, pgid: 4242 });
    lockContention.listLiveOpenclawProcesses.mockReturnValue([
      { pid: root, cmdline: "openclaw gateway run" },
      { pid: worker, cmdline: "node /app/node_modules/openclaw/dist/entry.js gateway run" },
    ]);
    // The root's pid is reused by a stranger right after resolve: its start
    // ticks no longer match, so it must not be signalled.
    gatewayIdentity.resolveProcessVerdict.mockImplementation((pid) =>
      pid === root ? { verdict: "gone", reason: "pid_reused" } : world.verdict(pid),
    );
    world.restartCli = "ignored";
    const { value, error } = await runRestart({}, gateway.gatewayStopAskBudgetMs(3000) + 2000 + 1000 + 2000);
    expect(error).toBeNull();
    expect(value.how).toBe("sigkill");
    const cliPids = new Set(world.spawned.filter((sp) => sp.kind === "restart").map((sp) => sp.pid));
    const sent = world.signals.filter(([pid, sig]) => (sig === "SIGTERM" || sig === "SIGKILL") && !cliPids.has(pid));
    expect(sent).toEqual([[worker, "SIGTERM"], [worker, "SIGKILL"]]);
  });

  it("stop_failed when the gateway survives SIGKILL (nothing spawned on top of it)", async () => {
    const { workerPid } = await bootManaged(gateway, world);
    world.restartCli = "ignored";
    const unkillable = world.procs.get(workerPid);
    unkillable.ignoreSigterm = true;
    const realExit = world.exit;
    world.exit = (pid, code, signal) => {
      if (pid === workerPid) return;
      return realExit.call(world, pid, code, signal);
    };
    const { error } = await runRestart({}, gateway.gatewayStopAskBudgetMs(3000) + 2000 + 1000 + 3000);
    expect(error).toBeInstanceOf(gateway.GatewayStopError);
    expect(error.code).toBe("stop_failed");
    expect(error.message).toContain(String(workerPid));
    expect(childProcess.spawn.mock.calls.filter(([, args]) => args[1] === "run")).toHaveLength(1);
  });

  it("the caller's lease fence ends the ladder between polls: no further signal, no spawn, aborted_by_caller", async () => {
    world.nextRunOptions = { ignoreSigterm: true };
    await bootManaged(gateway, world);
    world.nextRunOptions = {};
    world.restartCli = "ignored";
    let abort = false;
    setTimeout(() => { abort = true; }, 1000);
    const { error } = await runRestart({ shouldAbort: () => abort }, 3000);
    expect(error).toBeInstanceOf(gateway.GatewayRestartError);
    expect(error.evidence).toMatchObject({ aborted: true, reason: "aborted_by_caller" });
    expect(world.signals.filter(([, sig]) => sig === "SIGKILL")).toEqual([]);
    expect(childProcess.spawn.mock.calls.filter(([, args]) => args[1] === "run")).toHaveLength(1);
  });

  it("the plugin preflight runs exactly once per restart (prepared before the stop, never again inside the launch)", async () => {
    fs.readFileSync = vi.fn((target, ...rest) =>
      String(target).endsWith("openclaw.json")
        ? JSON.stringify({ channels: { telegram: { enabled: true } } })
        : originalReadFileSync(target, ...rest),
    );
    fs.readdirSync = vi.fn(() => []);
    childProcess.execFile = vi.fn((file, args, opts, cb) => cb(null, JSON.stringify({ plugins: [] }), ""));
    delete require.cache[modulePath];
    gateway = require(modulePath);
    await bootManaged(gateway, world);
    // A changed desired plugin state defeats the preflight memo, so the
    // restart has to run it — and must run it exactly once.
    fs.readFileSync = vi.fn((target, ...rest) =>
      String(target).endsWith("openclaw.json")
        ? JSON.stringify({ channels: { telegram: { enabled: true }, discord: { enabled: true } } })
        : originalReadFileSync(target, ...rest),
    );
    childProcess.execFile.mockClear();
    const { error } = await runRestart({}, 5000);
    expect(error).toBeNull();
    const preflights = childProcess.execFile.mock.calls.filter(([, args]) => args?.[0] === "plugins");
    expect(preflights).toHaveLength(1);
    fs.readdirSync = require("fs").readdirSync;
  });

  it("a launcher the kernel reports gone before Node has reaped it is waited for, not retained: the graceful stop relaunches instead of failing as child_retained (ALPH-19)", async () => {
    const { launcherPid } = await bootManaged(gateway, world);
    world.slowReap.add(launcherPid);
    const { value, error } = await runRestart({}, 5000);
    expect(error).toBeNull();
    expect(value).toMatchObject({ ok: true, how: "graceful" });
    const runs = world.spawned.filter((s) => s.kind === "run");
    expect(runs).toHaveLength(2);
    expect(world.listeners()).toEqual([runs[1].workerPid]);
  });

  it("a stranger that grabs the port between stop and spawn is launch_failed — nothing is spawned into it", async () => {
    await bootManaged(gateway, world);
    const realExit = world.exit;
    world.exit = (pid, code, signal) => {
      realExit.call(world, pid, code, signal);
      if (world.listeners().length === 0 && !world.strangerAdded) {
        world.strangerAdded = true;
        world.add(nextPid++, { ppid: 1, listens: true, openclaw: false });
      }
    };
    const { error } = await runRestart({}, 5000);
    expect(error).toBeInstanceOf(gateway.GatewayRestartError);
    expect(error.evidence).toMatchObject({ code: "launch_failed", listeners: [expect.any(Number)] });
    expect(childProcess.spawn.mock.calls.filter(([, args]) => args[1] === "run")).toHaveLength(1);
  });

  it("a new gateway that exits before ready is launch_failed with its stderr tail and exit code; autotune is NOT stamped", async () => {
    const stamp = vi.spyOn(autotune, "stampGatewayEnvApplied").mockReturnValue({ ok: true });
    await bootManaged(gateway, world);
    stamp.mockClear();
    world.nextRunOptions = { exitBeforeReady: { code: 78, stderr: "Another gateway (pid 1) already owns this state directory" } };
    const { error } = await runRestart({}, 5000);
    expect(error).toBeInstanceOf(gateway.GatewayRestartError);
    expect(error.message).toContain("exited before it was ready (code 78)");
    expect(error.evidence).toMatchObject({ code: "launch_failed", exitCode: 78 });
    expect(error.evidence.stderrTail.join("\n")).toContain("already owns this state directory");
    expect(stamp).not.toHaveBeenCalled();
  });

  it("503 `starting` keeps waiting until 200, and the state-ownership wait line streams as a waiting_ready {lock_wait} step", async () => {
    await bootManaged(gateway, world);
    world.readyState = "starting";
    world.lockWaitLine = true;
    const onStep = vi.fn();
    setTimeout(() => { world.readyState = "ready"; }, 4000);
    const { value, error } = await runRestart({ onStep }, 8000);
    expect(error).toBeNull();
    expect(value.ok).toBe(true);
    const waiting = onStep.mock.calls.map(([s]) => s).filter((s) => s.step === "waiting_ready");
    expect(waiting).toEqual([
      { step: "waiting_ready", status: "running", budgetMs: 30000 },
      { step: "waiting_ready", status: "running", budgetMs: 30000, detail: { phase: "lock_wait" } },
    ]);
  });

  it("2026.10.2: the owner-heartbeat wait line (a holder in another PID namespace) also streams as a waiting_ready {lock_wait} step", async () => {
    await bootManaged(gateway, world);
    world.readyState = "starting";
    // Verbatim from dist/gateway-lock-*.mjs (log.warn before the 95 s retry).
    world.lockWaitLine =
      "[gateway] Waiting for the previous Gateway's owner heartbeat to expire before reclaiming state (up to 95 seconds). cannot verify Gateway ownership from this process (different PID namespace); the owner heartbeat is fresh — run this command inside the Gateway container or with a shared PID namespace. If the previous Gateway stopped, wait up to 90 seconds after its last heartbeat. holder 41 at old-container/pid-ns 4026532201, last renewed 12 s ago. wait 79 s and retry.";
    const onStep = vi.fn();
    setTimeout(() => { world.readyState = "ready"; }, 4000);
    const { value, error } = await runRestart({ onStep }, 8000);
    expect(error).toBeNull();
    expect(value.ok).toBe(true);
    const waiting = onStep.mock.calls.map(([s]) => s).filter((s) => s.step === "waiting_ready");
    expect(waiting).toEqual([
      { step: "waiting_ready", status: "running", budgetMs: 30000 },
      { step: "waiting_ready", status: "running", budgetMs: 30000, detail: { phase: "lock_wait" } },
    ]);
  });

  it("a gateway that never reports ready inside the budget is ready_timeout {budgetMs}: the child is left running for the watchdog's readiness ladder, autotune is not stamped", async () => {
    const stamp = vi.spyOn(autotune, "stampGatewayEnvApplied").mockReturnValue({ ok: true });
    await bootManaged(gateway, world);
    stamp.mockClear();
    world.readyState = "starting";
    const { error } = await runRestart({}, 40000);
    expect(error).toBeInstanceOf(gateway.GatewayRestartError);
    expect(error.evidence).toMatchObject({ code: "ready_timeout", budgetMs: 30000, readiness: { kind: "not_ready", status: "starting" } });
    const next = world.spawned.filter((s) => s.kind === "run").at(-1);
    expect(world.alive(next.workerPid)).toBe(true);
    expect(world.signals.filter(([pid]) => pid === -next.launcherPid)).toEqual([]);
    expect(stamp).not.toHaveBeenCalled();
  });

  it("a ready answer from a listener OUTSIDE the new child's tree is launch_failed, never success", async () => {
    await bootManaged(gateway, world);
    world.nextRunOptions = { neverListen: true };
    const realExit = world.exit;
    world.exit = (pid, code, signal) => {
      realExit.call(world, pid, code, signal);
      if (world.listeners().length === 0 && !world.impostor) {
        // Appears only after the spawn (the pre-spawn port check must pass).
        setTimeout(() => {
          world.impostor = world.add(nextPid++, { ppid: 1, listens: true, openclaw: true });
        }, 400);
      }
    };
    const { error } = await runRestart({}, 5000);
    expect(error).toBeInstanceOf(gateway.GatewayRestartError);
    expect(error.message).toContain("another process answered");
    expect(error.evidence).toMatchObject({ code: "launch_failed" });
  });

  describe("an ask CLI that exits non-zero: the gateway's state decides, not the exit code", () => {
    const termsTo = (pgid) => world.signalLog.filter((entry) => entry.pid === -pgid && (entry.sig === "SIGTERM" || entry.sig === "SIGKILL"));
    const logLines = () => console.log.mock.calls.map(([line]) => String(line));

    it("the incident: the CLI exits 1 with 'outcome is unknown' while the gateway drains — no SIGTERM is sent, the drain finishes inside the grace and the stop is graceful", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = "unknown_draining";
      world.drainExitMs = 2500;
      const askAt = Date.now();
      const { value, error } = await runRestart({}, 8000);
      expect(error).toBeNull();
      expect(value.how).toBe("graceful");
      expect(termsTo(launcherPid)).toEqual([]);
      expect(Date.now() - askAt).toBeGreaterThanOrEqual(2500);
      const log = logLines();
      expect(log.some((line) => /asking status=exited attempt=1 exit=1 class=unknown/.test(line))).toBe(true);
      expect(log.some((line) => /asking status=probe attempt=1 gateway=draining/.test(line))).toBe(true);
      expect(log.some((line) => /asking status=honoured attempts=1/.test(line))).toBe(true);
    });

    it("a draining gateway that outlives the grace is SIGTERMed only once the whole ask budget (grace + ack window + shutdown reserve) is spent, never at the CLI's exit", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = "unknown_draining";
      const askAt = Date.now();
      const { value, error } = await runRestart({}, gateway.gatewayStopAskBudgetMs(3000) + 4000);
      expect(error).toBeNull();
      expect(value.how).toBe("sigterm");
      const [first] = termsTo(launcherPid);
      expect(first.sig).toBe("SIGTERM");
      expect(first.at - askAt).toBeGreaterThanOrEqual(gateway.gatewayStopAskBudgetMs(3000) - 500);
      expect(value.stopEvidence.askAttempts).toEqual([{ attempt: 1, exit: 1, class: "unknown", gateway: "draining" }]);
    });

    it("a CLI killed by a signal (the OOM killer) while the gateway drains is waited out the same way", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = "killed_draining";
      world.drainExitMs = 2000;
      const { value, error } = await runRestart({}, 8000);
      expect(error).toBeNull();
      expect(value.how).toBe("graceful");
      expect(termsTo(launcherPid)).toEqual([]);
    });

    it("'outcome is unknown' with the gateway confirmed admitting again (the request was dropped) re-asks once with the remaining grace; the second ask is honoured", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = ["unknown_dropped", "graceful"];
      const { value, error } = await runRestart({}, 10000);
      expect(error).toBeNull();
      expect(value.how).toBe("graceful");
      expect(termsTo(launcherPid)).toEqual([]);
      expect(world.restartArgs).toHaveLength(2);
      expect(world.restartArgs[0]).toEqual(["gateway", "restart", "--wait", "3000ms"]);
      const secondWait = Number(world.restartArgs[1][3].replace("ms", ""));
      expect(secondWait).toBeGreaterThan(1500);
      expect(secondWait).toBeLessThan(3000);
    });

    it("a second 'outcome unknown' against an admitting gateway escalates: one re-ask, never a loop", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = ["unknown_dropped", "unknown_dropped", "graceful"];
      const { value, error } = await runRestart({}, 10000);
      expect(error).toBeNull();
      expect(value.how).toBe("sigterm");
      expect(world.restartArgs).toHaveLength(2);
      expect(termsTo(launcherPid)[0].sig).toBe("SIGTERM");
      const refused = logLines().find((line) => /asking status=refused/.test(line));
      expect(refused).toMatch(/class=unknown gateway=admitting attempts=2/);
    });

    it("an explicit OpenClaw refusal against an admitting gateway escalates to SIGTERM within a second and a half", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = "rejected";
      const askAt = Date.now();
      const { value, error } = await runRestart({}, 3000);
      expect(error).toBeNull();
      expect(value.how).toBe("sigterm");
      expect(termsTo(launcherPid)[0].at - askAt).toBeLessThan(1500);
      expect(world.restartArgs).toHaveLength(1);
    });

    it("an explicit refusal while the gateway is visibly draining is still waited out: draining wins over the CLI's words", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = "rejected";
      world.readyState = "draining";
      setTimeout(() => world.exit(launcherPid, 0), 2000);
      const { value, error } = await runRestart({}, 8000);
      expect(error).toBeNull();
      expect(value.how).toBe("graceful");
      expect(termsTo(launcherPid)).toEqual([]);
    });

    it("probes that time out (a stalled gateway) are inconclusive: an 'outcome unknown' exit keeps waiting, and the stop is graceful once the gateway exits", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = "unknown_dropped";
      world.readyState = "hang";
      setTimeout(() => world.exit(launcherPid, 0), 4000);
      const { value, error } = await runRestart({}, 9000);
      expect(error).toBeNull();
      expect(value.how).toBe("graceful");
      expect(termsTo(launcherPid)).toEqual([]);
      expect(world.restartArgs).toHaveLength(1);
    });

    it("the gateway's announced drain budget (min of --wait and its supervisor's stop budget) is recorded on the honoured line", async () => {
      const { child } = await bootManaged(gateway, world);
      world.restartCli = "graceful";
      setTimeout(() => child.stderr.emit("data", Buffer.from("[gateway] largest observed model request timeout is 300000ms; shutdown drain budget remains with timeout 2930.5ms\n")), 100);
      const { value, error } = await runRestart({}, 5000);
      expect(error).toBeNull();
      expect(value.how).toBe("graceful");
      expect(logLines().find((line) => /asking status=honoured/.test(line))).toMatch(/drainMs=2931/);
    });

    it("an askGraceMs resolver is called once, after preflight, right before the ask: its grace is the --wait and its reason is logged and kept on the evidence", async () => {
      await bootManaged(gateway, world);
      world.restartCli = "graceful";
      const resolver = vi.fn(() => ({ askGraceMs: 2500, reason: "derived" }));
      const { value, error } = await runRestart({ ladder: { ...ladder, askGraceMs: resolver } }, 5000);
      expect(error).toBeNull();
      expect(value.how).toBe("graceful");
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(world.restartArgs.at(-1)).toEqual(["gateway", "restart", "--wait", "2500ms"]);
      expect(logLines().find((line) => /asking status=running/.test(line))).toMatch(/graceMs=2500 graceReason=derived/);
    });

    it("every ladder line carries a real operation id: the caller's, or one minted for it, opened by a requested line naming the source (ALPH-17)", async () => {
      await bootManaged(gateway, world);
      world.restartCli = "graceful";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const attributed = await runRestart({ source: "watchdog:memory_mitigation", reason: "episode 101-1" }, 5000);
      expect(attributed.error).toBeNull();
      const restartLines = () => logLines().filter((line) => line.startsWith("[alphaclaw] restart op="));
      const firstOp = /op=(\S+)/.exec(restartLines()[0])[1];
      expect(firstOp).toMatch(/^[0-9a-f]{8}$/);
      expect(attributed.value.opId.slice(0, 8)).toBe(firstOp);
      expect(restartLines()[0]).toBe(`[alphaclaw] restart op=${firstOp} requested source=watchdog:memory_mitigation reason=episode 101-1 class=memory`);
      expect(restartLines().every((line) => line.startsWith(`[alphaclaw] restart op=${firstOp} `))).toBe(true);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("has no source"));

      console.log.mockClear();
      world.restartCli = "graceful";
      const bare = await runRestart({}, 5000);
      expect(bare.error).toBeNull();
      expect(restartLines()[0]).toMatch(/^\[alphaclaw\] restart op=[0-9a-f]{8} requested source=unattributed class=repair$/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("has no source"));

      console.log.mockClear();
      await drive(gateway.stopGatewayForShutdown({ budgetMs: 2000 }), 3000);
      expect(restartLines()[0]).toMatch(/^\[alphaclaw\] restart op=[0-9a-f]{8} requested source=shutdown$/);
      expect(logLines().some((line) => /restart op=(-|shutdown) /.test(line))).toBe(false);
    });

    it("a throwing resolver falls back to the default 30 s grace and says so", async () => {
      await bootManaged(gateway, world);
      world.restartCli = "graceful";
      const { error } = await runRestart({ ladder: { ...ladder, askGraceMs: () => { throw new Error("sample read failed"); } } }, 5000);
      expect(error).toBeNull();
      expect(world.restartArgs.at(-1)).toEqual(["gateway", "restart", "--wait", "30000ms"]);
      expect(logLines().find((line) => /asking status=running/.test(line))).toMatch(/graceMs=30000 graceReason=resolver_failed/);
    });
  });

  describe("the ask grace follows the restart class (ALPH-17 PR 5)", () => {
    const logLines = () => console.log.mock.calls.map(([line]) => String(line));
    const noAskGrace = { termGraceMs: 2000, killGraceMs: 1000 };

    it("a routine restart (operator, channel, team) asks with the routine grace, 180 s by default", async () => {
      expect(gateway.kRestartClasses).toEqual({ ROUTINE: "routine", REPAIR: "repair", MEMORY: "memory" });
      await bootManaged(gateway, world);
      for (const source of ["api:restart", "api:upgrade", "channels:create", "team:enable"]) {
        world.restartCli = "graceful";
        const { error } = await runRestart({ source, ladder: noAskGrace }, 5000);
        expect(error).toBeNull();
        expect(world.restartArgs.at(-1)).toEqual(["gateway", "restart", "--wait", "180000ms"]);
        expect(logLines().find((line) => line.includes("requested source=" + source))).toMatch(/ class=routine$/);
      }
    });

    it("a watchdog repair and an unattributed caller keep the short 30 s grace; an explicit ladder grace always wins", async () => {
      await bootManaged(gateway, world);
      world.restartCli = "graceful";
      expect((await runRestart({ source: "watchdog:repair_replace", reason: "x", ladder: noAskGrace }, 5000)).error).toBeNull();
      expect(world.restartArgs.at(-1)).toEqual(["gateway", "restart", "--wait", "30000ms"]);
      expect(logLines().find((line) => line.includes("requested source=watchdog:repair_replace"))).toMatch(/ class=repair$/);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      world.restartCli = "graceful";
      expect((await runRestart({ ladder: noAskGrace }, 5000)).error).toBeNull();
      expect(world.restartArgs.at(-1)).toEqual(["gateway", "restart", "--wait", "30000ms"]);
      world.restartCli = "graceful";
      expect((await runRestart({ source: "api:restart" }, 5000)).error).toBeNull();
      expect(world.restartArgs.at(-1)).toEqual(["gateway", "restart", "--wait", "3000ms"]);
    });

    it("Restart now: an expedite between ask polls ends the drain and SIGTERMs at once; the evidence says it was cut short, not refused", async () => {
      const { launcherPid } = await bootManaged(gateway, world);
      world.restartCli = "unknown_draining";
      let expedite = false;
      const askAt = Date.now();
      setTimeout(() => { expedite = true; }, 1000);
      const { value, error } = await runRestart({ source: "api:restart", ladder: { ...ladder, askGraceMs: 60_000 }, shouldExpedite: () => expedite }, 6000);
      expect(error).toBeNull();
      expect(value.how).toBe("sigterm");
      const [first] = world.signalLog.filter((entry) => entry.pid === -launcherPid && entry.sig === "SIGTERM");
      expect(first.at - askAt).toBeGreaterThanOrEqual(1000);
      expect(first.at - askAt).toBeLessThan(2000);
      expect(value.stopEvidence.askExit).toBe("expedited");
      expect(value.stopEvidence.askExpedited).toBe(true);
      expect(value.stopEvidence.askRefusedLine).toBeNull();
      expect(logLines().some((line) => /asking status=expedited ms=\d+/.test(line))).toBe(true);
      expect(logLines().some((line) => /asking status=(refused|expired)/.test(line))).toBe(false);
    });
  });

  it("a requested restart hands the wedge sweep its op id and source without waiting on it; shutdown never does (ALPH-17 PR 6)", async () => {
    await bootManaged(gateway, world);
    world.restartCli = "graceful";
    const handler = vi.fn(() => new Promise(() => {}));
    gateway.setGatewayRestartRequestedHandler(handler);
    try {
      const { value, error } = await runRestart({ source: "api:restart", opId: "1234abcd-op" }, 5000);
      expect(error).toBeNull();
      expect(value.how).toBe("graceful");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ opId: "1234abcd-op", source: "api:restart" });
      await drive(gateway.stopGatewayForShutdown({ budgetMs: 2000 }), 3000);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      gateway.setGatewayRestartRequestedHandler(null);
    }
  });

  it("every cold restart reports to the last-restart recorder: who asked, why, the outcome and the downtime; a refused stop reports its class (ALPH-40)", async () => {
    await bootManaged(gateway, world);
    world.restartCli = "graceful";
    const recorder = { requested: vi.fn(), finished: vi.fn() };
    gateway.setGatewayRestartRecorder(recorder);
    try {
      const { value, error } = await runRestart({ source: "api:restart", reason: "operator", opId: "abcd1234-op" }, 5000);
      expect(error).toBeNull();
      expect(recorder.requested).toHaveBeenCalledWith({ opId: "abcd1234-op", source: "api:restart", reason: "operator", restartClass: "routine" });
      expect(recorder.finished).toHaveBeenCalledWith({
        opId: "abcd1234-op", outcome: "ready", durationMs: value.durationMs, downtimeMs: value.downtimeMs, how: "graceful",
      });
      expect(value.downtimeMs).toBeGreaterThan(0);

      const stranger = nextPid++;
      for (const proc of world.procs.values()) proc.listens = false;
      world.add(stranger, { ppid: 1, listens: true, openclaw: false });
      recorder.finished.mockClear();
      const refused = await runRestart({ source: "watchdog:repair_replace", reason: "stuck" }, 500);
      expect(refused.error.code).toBe("stop_refused");
      const [[requested]] = recorder.requested.mock.calls.slice(-1);
      expect(requested).toMatchObject({ source: "watchdog:repair_replace", reason: "stuck", restartClass: "repair" });
      expect(recorder.finished).toHaveBeenCalledWith({ opId: requested.opId, outcome: "stop_refused" });
    } finally {
      gateway.setGatewayRestartRecorder(null);
    }
  });

  it("a recorder that throws never fails a restart (ALPH-40)", async () => {
    await bootManaged(gateway, world);
    world.restartCli = "graceful";
    gateway.setGatewayRestartRecorder({ requested: () => { throw new Error("disk full"); }, finished: () => { throw new Error("disk full"); } });
    try {
      const { error } = await runRestart({ source: "api:restart" }, 5000);
      expect(error).toBeNull();
    } finally {
      gateway.setGatewayRestartRecorder(null);
    }
  });

  it("stopGatewayForShutdown never asks (no supervisor will relaunch): SIGTERM the group, SIGKILL inside its budget; killManagedGatewayChildNow SIGKILLs the group synchronously", async () => {
    world.nextRunOptions = { ignoreSigterm: true };
    const { launcherPid, workerPid } = await bootManaged(gateway, world);
    await drive(gateway.stopGatewayForShutdown({ budgetMs: 2000 }), 3000);
    expect(childProcess.spawn.mock.calls.some(([, args]) => args[1] === "restart")).toBe(false);
    expect(world.signals).toEqual(expect.arrayContaining([[-launcherPid, "SIGTERM"], [-launcherPid, "SIGKILL"]]));
    expect(world.alive(workerPid)).toBe(false);

    // A fresh managed child for the synchronous reaper.
    world.nextRunOptions = { ignoreSigterm: true };
    delete require.cache[modulePath];
    gateway = require(modulePath);
    const second = await bootManaged(gateway, world);
    expect(gateway.killManagedGatewayChildNow()).toBe(true);
    expect(world.signals.at(-1)).toEqual([-second.launcherPid, "SIGKILL"]);
    expect(world.alive(second.workerPid)).toBe(false);
  });

  it("the retired machinery is gone: no --force launch, no CLI stop, no incumbent verdict, no supervisor adoption, no stop-force capability", () => {
    for (const name of [
      "runGatewayCmd",
      "GatewayIncumbentRestartError",
      "kGatewayIncumbentRestartReason",
      "assessRestartIncumbent",
      "setGatewayCapabilities",
      "isManagedGatewayChildSupervisor",
      "kGatewayShutdownProbeTimeoutMs",
    ]) {
      expect(gateway[name]).toBeUndefined();
    }
    const source = originalReadFileSync(modulePath, "utf8");
    expect(source).not.toMatch(/\["gateway", "--force"\]/);
    expect(source).not.toMatch(/gatewayStopForce/);
  });
});
