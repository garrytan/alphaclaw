// LIVE TIER — the restart ladder against the REAL pinned OpenClaw, driven
// through the REAL lib/server/gateway.js (no process/signal/readyz fakes):
//   1. boot a managed gateway: the child is the compile-cache launcher, the
//      worker (a different pid) holds the port, both in one process group;
//   2. restartGateway(): the graceful ask (`gateway restart --wait`) makes the
//      gateway exit 0 inside the grace (how: graceful), a fresh `gateway run`
//      comes up, /readyz answers from the new worker, and a rotated env value
//      is live in the new process;
//   3. stopGatewayLadder without the ask: SIGTERM to the group stops an idle
//      gateway in well under its grace (how: sigterm), nothing left listening.
// Requires: Node 24.16+/26.1+ first on PATH, the pinned OpenClaw installed in
// node_modules (no registry access). ~1 minute.

const fs = require("fs");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-ladder-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
// gateway.js spawns from process.env: scrub the test-runner markers the way
// scrubTestRunnerEnv does (under NODE_ENV=test / VITEST OpenClaw runs without
// its gateway locks and silences stdout — a different gateway than production).
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
// Production shape: the compile cache lives under the AlphaClaw root (a host
// NODE_COMPILE_CACHE such as a read-only CI cache would silently disable the
// cache and with it OpenClaw's launcher→worker respawn).
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
// gateway.js spawns `openclaw` by name: the repo's own bin dir first.
process.env.PATH = `${liveHelpers.repoBinDir()}${path.delimiter}${process.env.PATH}`;

const { kLiveEnabled, waitFor, readDeclaredPin } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 10 * 60 * 1000;

describeLive(`LIVE restart ladder against the ${readDeclaredPin()} pin`, () => {
  let gateway;
  let gatewayIdentity;
  let OPENCLAW_DIR;
  let kOnboardingMarkerPath;
  let port;

  beforeAll(() => {
    ({ OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants"));
    expect(OPENCLAW_DIR.startsWith(kRootDir)).toBe(true);
    port = 19000 + Math.floor(Math.random() * 500);
    fs.mkdirSync(path.join(OPENCLAW_DIR, "state"), { recursive: true });
    fs.mkdirSync(path.join(kRootDir, "cache", "openclaw-compile-cache"), { recursive: true });
    fs.writeFileSync(
      path.join(OPENCLAW_DIR, "openclaw.json"),
      JSON.stringify({
        gateway: { mode: "local", bind: "loopback", port, auth: { token: "live-ladder-token-00000000000000000000" } },
        channels: {},
      }),
    );
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = "live-ladder-token-00000000000000000000";
    gateway = require("../../lib/server/gateway");
    gatewayIdentity = require("../../lib/server/gateway-identity");
  });

  afterAll(async () => {
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    const leftovers = gatewayIdentity?.findPortListenerPids?.(port) || [];
    for (const pid of leftovers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });

  const readyz = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return { status: 0, body: null };
    }
  };
  const workerEnv = (pid, key) => {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((e) => e.startsWith(`${key}=`)) ?? null;
    } catch {
      return null;
    }
  };

  it(
    "boots a managed launcher→worker tree, restarts it gracefully with a fresh env, then stops it by SIGTERM in under its grace",
    async () => {
      const launches = [];
      gateway.setGatewayLaunchHandler((payload) => launches.push(payload));
      const exits = [];
      gateway.setGatewayExitHandler((payload) => exits.push(payload));

      const child = await gateway.startGateway();
      expect(child?.pid).toEqual(expect.any(Number));
      await waitFor(async () => (await readyz()).status === 200, 180_000, "first gateway /readyz 200");

      // Launcher/worker split, one process group, worker resolved as servingPid.
      const identity = gateway.resolveGatewayIdentity();
      expect(identity).toMatchObject({ owner: "managed", rootPid: child.pid, pgid: child.pid });
      expect(identity.workerPid).toEqual(expect.any(Number));
      expect(identity.workerPid).not.toBe(child.pid);
      expect(gatewayIdentity.readProcessGroupId(identity.workerPid)).toBe(child.pid);
      await waitFor(async () => launches.length > 0, 10_000, "launch handler");
      expect(launches[0]).toMatchObject({ pid: child.pid, servingPid: identity.workerPid, supervision: "managed" });
      const firstWorker = identity.workerPid;

      // Rotate an env value the gateway reads at spawn; the restart must make
      // it live in the NEW worker.
      process.env.OPENCLAW_GATEWAY_TOKEN = "live-ladder-token-ROTATED000000000000000";
      fs.writeFileSync(
        path.join(OPENCLAW_DIR, "openclaw.json"),
        JSON.stringify({
          gateway: { mode: "local", bind: "loopback", port, auth: { token: process.env.OPENCLAW_GATEWAY_TOKEN } },
          channels: {},
        }),
      );
      const steps = [];
      const startedAt = Date.now();
      const result = await gateway.restartGateway(() => {}, { onStep: (step) => steps.push(step) });
      const restartMs = Date.now() - startedAt;

      expect(result).toMatchObject({ ok: true, how: "graceful", durationMs: expect.any(Number), downtimeMs: expect.any(Number) });
      expect(restartMs).toBeLessThan(120_000);
      expect(steps.map((s) => s.step)).toEqual(["preparing_plugins", "preparing_plugins", "stopping", "stopping", "launching", "launching", "waiting_ready"]);
      expect(steps.find((s) => s.step === "stopping")).toMatchObject({ detail: { phase: "asking" } });
      expect((await readyz()).status).toBe(200);
      const after = gateway.resolveGatewayIdentity();
      expect(after.owner).toBe("managed");
      expect(after.rootPid).not.toBe(child.pid);
      expect(after.workerPid).not.toBe(firstWorker);
      expect(gatewayIdentity.findPortListenerPids(port)).toEqual([after.workerPid]);
      expect(workerEnv(after.workerPid, "OPENCLAW_GATEWAY_TOKEN")).toBe("OPENCLAW_GATEWAY_TOKEN=live-ladder-token-ROTATED000000000000000");
      // The old launcher's exit was OUR stop (code 0 from the graceful ask),
      // booked expected with the worker pid the handoff row is keyed by.
      await waitFor(async () => exits.some((e) => e.pid === child.pid), 10_000, "old launcher exit event");
      expect(exits.find((e) => e.pid === child.pid)).toMatchObject({ code: 0, expectedExit: true, workerPid: firstWorker });

      // SIGTERM path: an idle gateway goes down in well under the grace.
      const stopStartedAt = Date.now();
      const stop = await gateway.stopGatewayLadder({ allowGracefulRestart: false, termGraceMs: 10_000, killGraceMs: 5_000 });
      expect(stop.how).toBe("sigterm");
      expect(Date.now() - stopStartedAt).toBeLessThan(10_000);
      expect(gatewayIdentity.findPortListenerPids(port)).toEqual([]);
      expect((await readyz()).status).toBe(0);
      gateway.setGatewayLaunchHandler(null);
      gateway.setGatewayExitHandler(null);
    },
    kTestTimeoutMs,
  );
});
