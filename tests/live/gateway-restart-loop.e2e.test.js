// LIVE TIER — the cold restart relaunches every time (ALPH-19). The stop
// ladder judges the old launcher gone from /proc (a zombie counts), and it can
// reach requestGatewayLaunch before Node has reaped that child. Before the
// launch guard waited for the reap, about one restart in fifteen was skipped
// as child_retained and left no gateway running. This loop runs N real
// restarts through the REAL lib/server/gateway.js against the pinned OpenClaw
// and requires that none is skipped as child_retained ("already running —
// skipping launch"). Any other restart failure is printed with its evidence:
// a rare new gateway that receives a SIGTERM during startup and exits 0
// (exited_before_ready) is still under investigation and does not fail here. Loop count:
// ALPHACLAW_LIVE_RESTART_LOOPS (default 30). About 30 s per restart.
// Requires: Node 24.22.1+/26.12.1+ first on PATH, the pinned OpenClaw in
// node_modules (no registry access).

const fs = require("fs");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-restart-loop-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
process.env.PATH = `${liveHelpers.repoBinDir()}${path.delimiter}${process.env.PATH}`;

const { kLiveEnabled, waitFor, readDeclaredPin } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kLoops = Math.max(1, Number.parseInt(process.env.ALPHACLAW_LIVE_RESTART_LOOPS || "30", 10) || 30);
const kTestTimeoutMs = (5 + kLoops * 2) * 60 * 1000;

describeLive(`LIVE restart loop against the ${readDeclaredPin()} pin`, () => {
  let gateway;
  let gatewayIdentity;
  let port;
  const lines = [];
  const originalLog = console.log;

  beforeAll(() => {
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    expect(OPENCLAW_DIR.startsWith(kRootDir)).toBe(true);
    port = 19500 + Math.floor(Math.random() * 400);
    fs.mkdirSync(path.join(OPENCLAW_DIR, "state"), { recursive: true });
    fs.mkdirSync(path.join(kRootDir, "cache", "openclaw-compile-cache"), { recursive: true });
    const token = "live-loop-token-000000000000000000000000";
    fs.writeFileSync(
      path.join(OPENCLAW_DIR, "openclaw.json"),
      JSON.stringify({ gateway: { mode: "local", bind: "loopback", port, auth: { token } }, channels: {} }),
    );
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    console.log = (...args) => {
      lines.push(args.map(String).join(" "));
      originalLog(...args);
    };
    gateway = require("../../lib/server/gateway");
    gatewayIdentity = require("../../lib/server/gateway-identity");
  });

  afterAll(async () => {
    console.log = originalLog;
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    for (const pid of gatewayIdentity?.findPortListenerPids?.(port) || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });

  // The ladder's own `openclaw gateway restart` ask CLIs still running. One
  // that outlives the stop keeps polling health and can SIGTERM the starting
  // replacement as a "stale gateway".
  const liveAskClis = () => {
    const found = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
        const ppid = Number(fs.readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1].split(" ")[1]);
        if (ppid === process.pid && argv.includes("gateway") && argv.includes("restart")) found.push(Number(entry));
      } catch {}
    }
    return found;
  };

  const readyzStatus = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/readyz`)).status;
    } catch {
      return 0;
    }
  };

  it(
    `${kLoops} cold restarts in a row: none is skipped as child_retained`,
    async () => {
      const child = await gateway.startGateway();
      expect(child?.pid).toEqual(expect.any(Number));
      await waitFor(async () => (await readyzStatus()) === 200, 180_000, "first gateway /readyz 200");

      const failures = [];
      const results = [];
      let previousRoot = gateway.resolveGatewayIdentity()?.rootPid;
      for (let i = 1; i <= kLoops; i += 1) {
        const startedAt = Date.now();
        try {
          const result = await gateway.restartGateway(() => {}, { source: "api:restart", reason: `live-loop ${i}/${kLoops}` });
          const identity = gateway.resolveGatewayIdentity();
          const askClis = liveAskClis();
          results.push({ i, how: result.how, ms: Date.now() - startedAt, rootPid: identity?.rootPid, askClis });
          if (!result.ok || identity?.rootPid === previousRoot || askClis.length > 0) failures.push({ i, result, identity, askClis });
          previousRoot = identity?.rootPid;
        } catch (error) {
          failures.push({ i, code: error?.evidence?.code, outcome: error?.evidence?.outcome, message: error?.message, askClis: liveAskClis() });
          await waitFor(async () => !gateway.resolveGatewayIdentity()?.rootPid || (await readyzStatus()) === 200, 30_000, "settle after failure").catch(() => {});
        }
        originalLog(`[live-loop] restart ${i}/${kLoops} ${JSON.stringify(results.at(-1) ?? failures.at(-1))}`);
      }
      const skipped = lines.filter((line) => line.includes("already running — skipping launch"));
      const reapWaits = lines.filter((line) => line.includes("launch guard waited"));
      originalLog(`[live-loop] summary restarts=${kLoops} failures=${failures.length} skipped=${skipped.length} reapWaits=${reapWaits.length}`);
      for (const line of reapWaits) originalLog(`[live-loop] ${line}`);
      for (const failure of failures) originalLog(`[live-loop] failure ${JSON.stringify(failure)}`);
      expect(failures.filter((failure) => failure.outcome === "child_retained")).toEqual([]);
      expect(skipped).toEqual([]);
      await waitFor(async () => (await readyzStatus()) === 200, 60_000, "gateway ready at the end");
    },
    kTestTimeoutMs,
  );
});
