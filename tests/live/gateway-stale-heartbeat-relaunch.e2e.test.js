// LIVE TIER — a gateway that was SIGKILLed in another container (a killed
// deploy, an OOM kill, a SIGKILL from the stop ladder under tini) leaves
// OpenClaw's state-ownership heartbeat fresh for up to 90 s. On 2026.10.7 the
// next container's `gateway run` refuses at once with GatewayLockNamespaceError
// ("Cannot read shared state for discovery: … cannot verify Gateway ownership
// from this process (different PID namespace) … wait N s and retry") and exits
// 1, and before v0.10.137 the watchdog held the relaunch for the gateway-owner
// lease's recorded expiry (up to 300 s; a GitHub runner saw the gateway stay
// down for more than 3 minutes). This test kills a real AlphaClaw + gateway
// running in their own PID namespace (the container stand-in: `unshare -p`,
// killing its init kills everything in it), immediately boots a fresh
// AlphaClaw on the same root in this namespace, and requires: the refusal
// happened, the boot showed the lock_wait step instead of failing, the
// watchdog relaunched once, no earlier than the heartbeat's lapse and within a
// few seconds of it, and /readyz answered ready within the heartbeat window
// plus a cold-boot margin. The heartbeat's lapse is taken from upstream's
// own refusal ("last renewed S s ago"); OpenClaw's lock files are never read
// or touched.
// Requires: Node 24.22.1+/26.12.1+ first on PATH, the pinned OpenClaw in
// node_modules, and unprivileged user + PID namespaces (`unshare -U
// --map-current-user -pf --mount-proc`, util-linux 2.38+). Without them the
// test fails under CI and is skipped with a warning elsewhere.

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  kLiveEnabled,
  mkTemp,
  repoOpenclawBin,
  repoBinDir,
  scrubTestRunnerEnv,
  waitFor,
  readDeclaredPin,
} = require("./live-helpers");

const describeLive = kLiveEnabled ? describe : describe.skip;

// OpenClaw's GATEWAY_OWNER_HEARTBEAT_STALE_MS (dist/gateway-state-owner-*.mjs).
const kHeartbeatStaleMs = 90_000;
// The watchdog relaunches at upstream's countdown plus a 2 s margin; allow a
// little scheduling slack on a loaded runner.
const kRelaunchSlackMs = 8_000;
// A cold `gateway run` to /readyz ready after the relaunch (about 20 s on a
// 4-core machine).
const kColdBootMarginMs = 60_000;
const kNamespaceFlags = ["-U", "--map-current-user", "-pf", "--mount-proc", "--kill-child"];
const kSetupPassword = "live-stale-heartbeat-pw-1";

// The vitest worker's env without the runner's markers: under NODE_ENV=test
// OpenClaw takes no state-owner lock at all, so the scenario would never arise.
const childEnv = () => {
  const env = scrubTestRunnerEnv();
  for (const key of ["NODE_ENV", "TEST", "MODE", "DEV", "PROD", "SSR", "BASE_URL"]) delete env[key];
  return env;
};

const namespacesUsable = () => {
  const probe = spawnSync("unshare", [...kNamespaceFlags, "true"], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0 ? null : String(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim();
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

const readyzOk = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(3_000) })).status === 200;
  } catch {
    return false;
  }
};

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

// Upstream's own statement of the heartbeat it judged, in the refusal:
// "last renewed S s ago. wait N s and retry" (describeGatewayLockHolder).
const kRefusalHeartbeatPattern = /last renewed (\d+) s ago\. wait \d+ s and retry/;

// sink: { at, text } per output chunk, so a line's arrival time is known.
// OpenClaw's state-owner lock is present (existence only; never opened or
// changed): the gateway holds state ownership right now. A gateway caught in
// a restart has released it, and its successor would start unopposed.
const ownerLockHeld = (openclawDir) => {
  const tmp = path.join(openclawDir, "tmp");
  if (!fs.existsSync(tmp)) return false;
  return fs
    .readdirSync(tmp)
    .filter((dir) => /^openclaw(-\d+)?$/.test(dir))
    .some((dir) => fs.readdirSync(path.join(tmp, dir)).some((name) => /^state\.[0-9a-f]+\.lock$/.test(name)));
};

const spawnLogged = (argv, env, sink) => {
  const child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => sink.push({ at: Date.now(), text: String(d) }));
  child.stderr.on("data", (d) => sink.push({ at: Date.now(), text: String(d) }));
  return child;
};
const logText = (sink) => sink.map((chunk) => chunk.text).join("");

const stopChild = (child, signal = "SIGTERM", graceMs = 15_000) =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });

describeLive(`LIVE relaunch after a SIGKILLed gateway in another PID namespace (${readDeclaredPin()} pin)`, () => {
  let previous = null;
  let next = null;

  afterAll(async () => {
    await stopChild(next);
    await stopChild(previous, "SIGKILL", 5_000);
  });

  it("waits out the stale ownership heartbeat visibly and reaches /readyz within the heartbeat window plus a cold-boot margin", async () => {
    const unavailable = namespacesUsable();
    if (unavailable) {
      if (process.env.CI) throw new Error(`[live] unprivileged PID namespaces are unavailable in CI: ${unavailable}`);
      // eslint-disable-next-line no-console
      console.warn(`[live] unprivileged PID namespaces are unavailable (${unavailable}) — stale-heartbeat relaunch SKIPPED`);
      return;
    }

    const rootDir = mkTemp("alphaclaw-live-stale-heartbeat-");
    const openclawDir = path.join(rootDir, ".openclaw");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    const port = await findFreePort();
    const gatewayPort = await findFreePort();
    const onboard = spawnSync(
      process.execPath,
      [
        repoOpenclawBin(), "onboard", "--non-interactive", "--accept-risk", "--flow", "quickstart",
        "--gateway-bind", "loopback", "--gateway-port", String(gatewayPort), "--gateway-auth", "token",
        "--gateway-token", "live-stale-heartbeat-token", "--no-install-daemon", "--skip-health",
        "--workspace", workspaceDir, "--auth-choice", "skip",
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...childEnv(),
          HOME: rootDir,
          OPENCLAW_HOME: rootDir,
          OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
          OPENCLAW_STATE_DIR: openclawDir,
          XDG_CONFIG_HOME: openclawDir,
          OPENCLAW_NO_AUTO_UPDATE: "1",
        },
      },
    );
    expect(onboard.status, String(onboard.stderr || onboard.stdout).slice(-800)).toBe(0);
    fs.writeFileSync(
      path.join(rootDir, "onboarded.json"),
      JSON.stringify({ onboarded: true, reason: "live_e2e", markedAt: new Date().toISOString() }),
    );
    const env = {
      ...childEnv(),
      HOME: rootDir,
      ALPHACLAW_ROOT_DIR: rootDir,
      SETUP_PASSWORD: kSetupPassword,
      PORT: String(port),
      PATH: `${repoBinDir()}${path.delimiter}${process.env.PATH || ""}`,
      ALPHACLAW_GIT_SHIM_PATH: path.join(rootDir, "host-shims", "git"),
      ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(rootDir, "host-shims", "openclaw"),
      ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(rootDir, "host-shims", "alphaclaw-openclaw.sh"),
      ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
    };
    const alphaclawStart = [process.execPath, path.resolve(__dirname, "../../bin/alphaclaw.js"), "start"];

    // The previous "container": AlphaClaw and its gateway in their own PID namespace.
    const previousLog = [];
    previous = spawnLogged(["unshare", ...kNamespaceFlags, ...alphaclawStart], env, previousLog);
    await waitFor(() => readyzOk(gatewayPort), 5 * 60_000, `the first gateway ready (log tail: ${logText(previousLog).slice(-600)})`);
    // Let the owner heartbeat renew at least once before the kill, then kill
    // only while the gateway holds state ownership and serves.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    await waitFor(
      async () => ownerLockHeld(openclawDir) && (await readyzOk(gatewayPort)),
      2 * 60_000,
      `the first gateway serving and holding state ownership (log: ${logText(previousLog).split("\n").filter((line) => /restart op=|Starting openclaw|exited|boot timeline/.test(line)).join(" | ")})`,
    );

    // Kill the namespace's init: the kernel SIGKILLs everything inside it.
    previous.kill("SIGKILL");
    const killedAt = Date.now();
    await waitFor(async () => !(await portOpen(gatewayPort)), 15_000, "the killed gateway's port to close");
    // The next "container": a fresh AlphaClaw on the same root, right away.
    const nextLog = [];
    next = spawnLogged(alphaclawStart, env, nextLog);
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).status > 0;
      } catch {
        return false;
      }
    }, 60_000, "the fresh AlphaClaw to listen");
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: kSetupPassword }),
    });
    expect(login.status).toBe(200);
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

    const lockWaits = [];
    let readyAt = null;
    const deadline = killedAt + kHeartbeatStaleMs + kColdBootMarginMs;
    while (Date.now() < deadline + 30_000) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } });
        const body = res.status === 200 ? await res.json() : null;
        if (body?.bootProgress?.step?.id === "lock_wait") lockWaits.push({ at: Date.now(), lockWait: body.bootProgress.lockWait, outcome: body.bootProgress.outcome });
      } catch {}
      if (await readyzOk(gatewayPort)) {
        readyAt = Date.now();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const nextText = logText(nextLog);
    const tail = nextText.slice(-2_000);

    // The scenario really ran: upstream refused the fresh gateway on the fresh heartbeat.
    expect(nextText, tail).toMatch(/GatewayLockNamespaceError: cannot verify Gateway ownership from this process \(different PID namespace\)/);
    const refusal = nextLog.find((chunk) => kRefusalHeartbeatPattern.test(chunk.text));
    expect(refusal, tail).toBeTruthy();
    // S is floored: the last beat was between S and S + 1 seconds before the line arrived.
    const renewedAgoMs = Number(refusal.text.match(kRefusalHeartbeatPattern)[1]) * 1000;
    const lapseAt = refusal.at - renewedAgoMs + kHeartbeatStaleMs;
    expect(readyAt, `no /readyz ready within ${Math.round((deadline + 30_000 - killedAt) / 1000)} s of the kill; log tail: ${tail}`).not.toBeNull();
    expect(readyAt - killedAt, tail).toBeLessThanOrEqual(kHeartbeatStaleMs + kColdBootMarginMs);
    // The waiting step was visible while the watchdog waited.
    expect(lockWaits.length, tail).toBeGreaterThan(0);
    expect(lockWaits[0].lockWait).toMatchObject({ kind: "owner_lease_held" });
    expect(Math.abs(lockWaits[0].lockWait.untilMs - lapseAt)).toBeLessThanOrEqual(kRelaunchSlackMs);
    expect(nextText).not.toMatch(/boot timeline ended: failed/);

    // Exactly one relaunch, never before the heartbeat lapsed (no forcing past
    // OpenClaw's lock), and promptly after it (not at the lease's expiry).
    const db = new DatabaseSync(path.join(rootDir, "db", "watchdog.db"), { readOnly: true });
    const relaunches = db
      .prepare("SELECT created_at FROM watchdog_events WHERE event_type = 'restart' AND source = 'owner_lease_held' AND status = 'requested' ORDER BY id")
      .all();
    db.close();
    expect(relaunches).toHaveLength(1);
    const relaunchAt = Date.parse(relaunches[0].created_at);
    expect(relaunchAt).toBeGreaterThanOrEqual(lapseAt - 1_000);
    expect(relaunchAt - lapseAt).toBeLessThanOrEqual(kRelaunchSlackMs);

    await waitFor(() => /boot timeline ended: ready/.test(logText(nextLog)), 60_000, "the boot timeline to end ready");
  }, 12 * 60_000);
});
