const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const { createSidecarService, readProcStartTime } = require("../../lib/server/sidecars");
const { kDaemonizeHint } = require("../../lib/server/sidecars/supervisor");

// Real processes (bash, node, sleep; tmux when installed): the supervisor's
// job is process groups, signals and exits, which a stubbed spawn can't prove.
const kRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-sidecars-"));
let seq = 0;
const makeRoot = () => fs.mkdtempSync(path.join(kRoot, `case-${(seq += 1)}-`));
const services = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.stopAll()));
});
afterAll(() => fs.rmSync(kRoot, { recursive: true, force: true }));

const waitFor = async (predicate, timeoutMs = 8000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return readProcStartTime(pid) !== null;
  } catch {
    return false;
  }
};

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const makeService = ({ sidecars, ready = () => true, env = {}, ...options }) => {
  const rootDir = options.rootDir || makeRoot();
  const events = [];
  const notices = [];
  const service = createSidecarService({
    env: { PATH: process.env.PATH, ...env, ALPHACLAW_SIDECARS: JSON.stringify(sidecars) },
    rootDir,
    resolveReadyzUrl: () => "http://127.0.0.1:1/readyz",
    probeReadiness: async () => (ready() ? { ok: true, kind: "ready" } : { ok: false, kind: "unready" }),
    readyPollMs: 50,
    insertEvent: (event) => events.push(event.details),
    notify: async (message, opts) => {
      notices.push({ message, opts });
      return { ok: true };
    },
    logger: { log() {}, warn() {}, error() {} },
    supervisorOptions: { backoffMs: [50, 100], ...(options.supervisorOptions || {}) },
    ...options,
  });
  services.push(service);
  return { service, events, notices, rootDir };
};

const status = (service, name) => service.getStatus().sidecars.find((sidecar) => sidecar.name === name);

describe("sidecar service (real processes)", () => {
  it("starts gateway entries only after the gateway is ready, boot entries at once", async () => {
    let ready = false;
    const { service } = makeService({
      ready: () => ready,
      sidecars: [
        { name: "early", command: ["sleep", "30"], startAfter: "boot" },
        { name: "late", command: ["sleep", "30"] },
      ],
    });
    await service.start();
    await waitFor(() => status(service, "early").status === "running", 4000, "early running");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(status(service, "late").status).toBe("idle");
    ready = true;
    await waitFor(() => status(service, "late").status === "running", 4000, "late running");
    expect(service.getStatus().startedBy).toBe("gateway_ready");
  });

  it("starts gateway entries after the fallback when the gateway never gets ready", async () => {
    const { service } = makeService({
      ready: () => false,
      readyFallbackMs: 200,
      sidecars: [{ name: "guard", command: ["sleep", "30"] }],
    });
    await service.start();
    await waitFor(() => status(service, "guard").status === "running", 4000, "guard running");
    expect(service.getStatus().startedBy).toBe("fallback");
  });

  it("a bash guard runs in its own process group: stop kills it and what it spawned", async () => {
    const rootDir = makeRoot();
    const script = path.join(rootDir, "guard.sh");
    fs.writeFileSync(script, '#!/bin/bash\nsleep 300 &\necho "$!" > "$1"\nwait\n');
    const childPidFile = path.join(rootDir, "child.pid");
    const { service } = makeService({
      rootDir,
      sidecars: [{ name: "guard", command: ["bash", script, childPidFile], stopTimeoutSeconds: 2 }],
    });
    await service.start();
    const childPid = Number(await waitFor(() => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, "utf8").trim(), 4000, "child pid"));
    const guardPid = status(service, "guard").pid;
    expect(isAlive(guardPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(guardPid)]).toString().trim());
    expect(pgid).toBe(guardPid);
    await service.stopAll();
    await waitFor(() => !isAlive(guardPid) && !isAlive(childPid), 4000, "group gone");
    expect(status(service, "guard").status).toBe("stopped");
    expect(fs.existsSync(path.join(rootDir, "sidecars-state.json"))).toBe(false);
  });

  it("escalates to SIGKILL when a sidecar ignores SIGTERM", async () => {
    const { service, rootDir } = makeService({
      sidecars: [{ name: "stubborn", command: ["bash", "-c", "trap '' TERM; echo trapped-$$; while true; do sleep 0.1; done"], startAfter: "boot", stopTimeoutSeconds: 1 }],
    });
    await service.start();
    const pid = await waitFor(() => status(service, "stubborn").pid, 4000, "pid");
    const logFile = path.join(rootDir, "logs", "sidecars", "stubborn.log");
    await waitFor(() => fs.existsSync(logFile) && /^trapped-\d+$/m.test(fs.readFileSync(logFile, "utf8")), 4000, "trap set");
    const started = Date.now();
    await service.stopAll();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    await waitFor(() => !isAlive(pid), 3000, "killed");
  });

  it("restarts a crashing sidecar with backoff, alerts once on a crash loop and records events", async () => {
    const { service, events, notices, rootDir } = makeService({
      sidecars: [{ name: "crashy", command: ["bash", "-c", "echo boom; exit 3"], startAfter: "boot" }],
    });
    await service.start();
    await waitFor(() => status(service, "crashy").crashLoop, 6000, "crash loop");
    await waitFor(() => status(service, "crashy").starts >= 7, 6000, "more restarts");
    const crashNotices = notices.filter(({ opts }) => String(opts.id).startsWith("sidecar-crash-loop-crashy-"));
    expect(crashNotices).toHaveLength(1);
    expect(crashNotices[0].message).toMatch(/Sidecar crashy is crash-looping: 5 exits in 10 min \(last: exit code 3\)/);
    expect(crashNotices[0].message).toMatch(/logs\/sidecars\/crashy\.log/);
    expect(events.filter((event) => event.phase === "crash_loop")).toHaveLength(1);
    expect(status(service, "crashy").lastExit).toMatchObject({ code: 3, signal: null });
    const log = fs.readFileSync(path.join(rootDir, "logs", "sidecars", "crashy.log"), "utf8");
    expect(log).toMatch(/^boom$/m);
    expect(log).toMatch(/alphaclaw: restart in /);
  });

  it("hints when a simple sidecar daemonizes itself (setsid -f) instead of staying in the foreground", async () => {
    const { service, notices } = makeService({
      sidecars: [{ name: "forks", command: ["bash", "-c", "exit 0"], startAfter: "boot" }],
    });
    await service.start();
    await waitFor(() => notices.length, 6000, "notice");
    expect(notices[0].message).toContain(kDaemonizeHint);
  });

  it("restart policy on-failure leaves a clean exit alone; never leaves any exit alone", async () => {
    const { service } = makeService({
      sidecars: [
        { name: "clean", command: ["bash", "-c", "sleep 3.2; exit 0"], restart: "on-failure", startAfter: "boot" },
        { name: "once", command: ["bash", "-c", "exit 4"], restart: "never", startAfter: "boot" },
        { name: "task", type: "oneshot", command: ["bash", "-c", "exit 0"], startAfter: "boot" },
      ],
    });
    await service.start();
    await waitFor(() => status(service, "once").status === "failed", 4000, "once failed");
    await waitFor(() => status(service, "task").status === "exited", 4000, "task exited");
    await waitFor(() => status(service, "clean").status === "exited", 8000, "clean exited");
    expect(status(service, "clean").starts).toBe(1);
    expect(status(service, "once").starts).toBe(1);
  });

  it("passes the minimal env, envFile, env and envUnset to the process", async () => {
    const rootDir = makeRoot();
    const out = path.join(rootDir, "env.txt");
    const envFile = path.join(rootDir, "ops.env");
    fs.writeFileSync(envFile, "FROM_FILE=yes\nANTHROPIC_API_KEY=file-key\n");
    const { service } = makeService({
      rootDir,
      env: { SETUP_PASSWORD: "secret", ANTHROPIC_API_KEY: "k" },
      sidecars: [
        {
          name: "envy",
          type: "oneshot",
          command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`],
          envFile,
          env: { HOME: rootDir },
          envUnset: ["ANTHROPIC_*"],
          startAfter: "boot",
        },
      ],
    });
    await service.start();
    const seen = JSON.parse(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, "utf8"), 4000, "env dump"));
    expect(seen).toMatchObject({ FROM_FILE: "yes", HOME: rootDir, ALPHACLAW_SIDECAR_NAME: "envy" });
    expect(seen.SETUP_PASSWORD).toBeUndefined();
    expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("a long-running node daemon keeps logging to its own log file", async () => {
    const { service, rootDir } = makeService({
      sidecars: [{ name: "daemon", command: [process.execPath, "-e", "setInterval(() => console.log('tick'), 50)"], startAfter: "boot" }],
    });
    await service.start();
    const logFile = path.join(rootDir, "logs", "sidecars", "daemon.log");
    await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("tick"), 4000, "log");
    expect(fs.readFileSync(logFile, "utf8")).toMatch(/alphaclaw: starting: /);
  });

  it("stops the copy a previous AlphaClaw process left running, and never a reused pid", async () => {
    const rootDir = makeRoot();
    const leftover = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    leftover.unref();
    const stranger = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    stranger.unref();
    await waitFor(() => readProcStartTime(leftover.pid) && readProcStartTime(stranger.pid), 2000, "spawned");
    fs.writeFileSync(
      path.join(rootDir, "sidecars-state.json"),
      JSON.stringify({
        sidecars: {
          guard: { pid: leftover.pid, startTime: readProcStartTime(leftover.pid) },
          old: { pid: stranger.pid, startTime: "1" },
        },
      }),
    );
    try {
      const { service } = makeService({ rootDir, sidecars: [{ name: "guard", command: ["sleep", "30"], startAfter: "boot" }] });
      await service.start();
      await waitFor(() => !isAlive(leftover.pid), 4000, "leftover stopped");
      expect(isAlive(stranger.pid)).toBe(true);
      await waitFor(() => status(service, "guard").status === "running", 4000, "fresh copy");
    } finally {
      try {
        process.kill(-stranger.pid, "SIGKILL");
      } catch {}
      try {
        process.kill(-leftover.pid, "SIGKILL");
      } catch {}
    }
  });

  it("runs the post-boot hook once after the gateway is ready and reports a failure", async () => {
    const calls = [];
    const { service, notices } = makeService({
      env: { ALPHACLAW_POST_BOOT_HOOK: "/opt/ops/after-boot" },
      sidecars: [],
      getBootId: () => "boot-1",
      runPostBootHook: async (args) => {
        calls.push(args);
        throw Object.assign(new Error("Post-boot hook exited with code 2: /opt/ops/after-boot"), { status: "failed", code: "nonzero_exit" });
      },
    });
    await service.start();
    await waitFor(() => service.getStatus().postBootHook.last, 4000, "hook ran");
    expect(calls).toEqual([expect.objectContaining({ hookPath: "/opt/ops/after-boot", bootId: "boot-1" })]);
    expect(service.getStatus().postBootHook.last).toMatchObject({ status: "failed", code: "nonzero_exit" });
    expect(notices[0].message).toMatch(/post-boot hook \(ALPHACLAW_POST_BOOT_HOOK\) failed/);
  });

  it("reports registry errors without starting the bad entry, and never returns env values", async () => {
    const { service, events } = makeService({
      sidecars: [
        { name: "good", command: ["sleep", "30"], env: { API_TOKEN: "hunter2" }, startAfter: "boot" },
        { name: "bad", command: "sleep 30" },
      ],
    });
    await service.start();
    const snapshot = service.getStatus();
    expect(snapshot.errors).toEqual([expect.objectContaining({ index: 1, name: "bad" })]);
    expect(events.some((event) => event.phase === "registry_invalid")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
    expect(snapshot.sidecars[0].envKeys).toEqual(["API_TOKEN"]);
  });

  (hasTmux ? it : it.skip)("a tmux-hosted server (forking) is started, checked, adopted on restart and stopped", async () => {
    const socket = `alphaclaw-test-${process.pid}-${seq}`;
    const out = path.join(makeRoot(), "tmux-env.txt");
    const entry = {
      name: "cli-server",
      type: "forking",
      command: ["tmux", "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "cli", `env > ${out}; sleep 300`],
      check: ["tmux", "-L", socket, "has-session", "-t", "cli"],
      stop: ["tmux", "-L", socket, "kill-server"],
      env: { HOME: "/tmp" },
      envUnset: ["ANTHROPIC_*"],
      inheritEnv: true,
      checkIntervalSeconds: 5,
      startAfter: "boot",
    };
    const tmuxAlive = () => {
      try {
        execFileSync("tmux", ["-L", socket, "has-session", "-t", "cli"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    try {
      const { service } = makeService({ env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" }, sidecars: [entry] });
      await service.start();
      await waitFor(() => status(service, "cli-server").status === "running" && tmuxAlive(), 6000, "tmux running");
      const seen = await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, "utf8"), 4000, "tmux env");
      expect(seen).toMatch(/^HOME=\/tmp$/m);
      expect(seen).not.toMatch(/^ANTHROPIC_/m);
      expect(seen).not.toMatch(/^ALPHACLAW_SIDECARS=/m);
      expect(status(service, "cli-server").adopted).toBe(false);

      const second = makeService({ sidecars: [entry] }).service;
      await second.start();
      await waitFor(() => status(second, "cli-server").status === "running", 6000, "adopted");
      expect(status(second, "cli-server").adopted).toBe(true);

      await service.stopAll();
      expect(tmuxAlive()).toBe(false);
    } finally {
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      } catch {}
    }
  });
});
