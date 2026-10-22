// LIVE TIER — "outcome unknown" is not "refused" (ALPH-17), against the REAL
// pinned OpenClaw driven through the REAL lib/server/gateway.js, with a real
// agent turn in flight (a local streaming model fixture holds the turn open):
//   1. the request lands but the ask CLI dies (SIGKILL right after the
//      gateway closes admission — the OOM-killer shape): the ladder probes,
//      sees the gateway draining, waits, and the stop is graceful; the turn
//      that was in flight finishes inside the drain;
//   2. the incident's exact failure: the gateway worker stalls for 11 s right
//      after it closed admission (SIGSTOP — a stand-in for load average 37),
//      so the CLI's hard 10 s gateway.restart.request ack timeout fires and it
//      exits 1 with "… its outcome is unknown." 2026.10.4 rolls the stalled
//      request back (admission reopens) and the ladder re-asks; 2026.10.6
//      applies it and drains. Either way: no SIGTERM, a graceful stop.
// OpenClaw's effective drain is min(--wait, its supervisor's stop budget):
// under systemd (this repo's cloud VM) that is ~75 s, so the turn here is
// shorter than that. Set OPENCLAW_CONTRACT_INSTALL_DIR to a directory with a
// candidate build's node_modules/.bin/openclaw to run against another pin.
// Requires Node new enough for the pin FIRST on PATH. ~4 minutes.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-ask-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
const kCandidateBinDir = process.env.OPENCLAW_CONTRACT_INSTALL_DIR
  ? path.resolve(process.env.OPENCLAW_CONTRACT_INSTALL_DIR, "node_modules", ".bin")
  : null;
process.env.PATH = [kCandidateBinDir, liveHelpers.repoBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);

const { kLiveEnabled, waitFor, readDeclaredPin } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 12 * 60 * 1000;
const kTurnSeconds = 35;
const kAskGraceMs = 60_000;

// Every process whose argv is the ask (`openclaw gateway restart --wait`):
// under the compile cache the CLI is a launcher plus its respawned child.
const askCliPids = () => {
  const pids = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      const at = argv.indexOf("gateway");
      if (at >= 0 && argv[at + 1] === "restart" && argv.includes("--wait")) pids.push(Number(entry));
    } catch {}
  }
  return pids;
};

describeLive(`LIVE ask outcome against the ${kCandidateBinDir ? "candidate" : readDeclaredPin()} pin`, () => {
  let gateway;
  let model;
  let modelRequests = 0;
  let port;

  beforeAll(async () => {
    model = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        modelRequests += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({ id: "ask-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        let n = 0;
        const timer = setInterval(() => {
          n += 1;
          if (res.destroyed) return clearInterval(timer);
          res.write(chunk(n === 1 ? { role: "assistant", content: "tick " } : { content: "tick " }));
          if (n >= kTurnSeconds) {
            clearInterval(timer);
            res.write(chunk({}, "stop"));
            res.end("data: [DONE]\n\n");
          }
        }, 1000);
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19500 + Math.floor(Math.random() * 400);
    const token = "live-ask-token-0000000000000000000000";
    fs.mkdirSync(path.join(OPENCLAW_DIR, "workspace"), { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace: path.join(OPENCLAW_DIR, "workspace"), model: { primary: "fixture/fixture" } } },
      models: { providers: { fixture: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      channels: {},
    }));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
  });

  afterAll(async () => {
    gateway?.setGatewayOutputObserver?.(null);
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    for (const pid of require("../../lib/server/gateway-identity").findPortListenerPids?.(port) || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    model?.close();
  });

  const readyzOk = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
    } catch {
      return false;
    }
  };
  // One agent turn through the gateway; resolves with the CLI's exit code.
  const startTurn = (sessionId) => {
    const before = modelRequests;
    const agent = spawn("openclaw", ["agent", "--session-id", sessionId, "-m", "count slowly", "--json", "--timeout", "300"], {
      env: gateway.gatewayEnv(),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const exited = new Promise((resolve) => agent.on("exit", (code) => resolve(code)));
    return { exited, inFlight: () => waitFor(async () => modelRequests > before, 120_000, "turn reached the model") };
  };
  // Run `action` once the gateway logs that it closed admission for the ask.
  const onAdmissionClosed = (action) => {
    let fired = false;
    gateway.setGatewayOutputObserver((text) => {
      if (fired || !/\[admission\] closed: restart-signal fence/.test(text)) return;
      fired = true;
      action();
    });
    return () => fired;
  };
  const ladderLines = (lines) => lines.filter((line) => /\[alphaclaw\] restart op=/.test(line));

  it(
    "an ask CLI that dies after the request landed, and one whose ack times out under a stalled worker, both end in a graceful stop with no SIGTERM",
    async () => {
      const lines = [];
      const originalLog = console.log;
      console.log = (...args) => {
        lines.push(args.map(String).join(" "));
        originalLog(...args);
      };
      try {
        await gateway.startGateway();
        await waitFor(readyzOk, 180_000, "first gateway /readyz 200");

        // 1. Applied, CLI killed.
        const first = startTurn("ask-live-1");
        await first.inFlight();
        const killed = onAdmissionClosed(() => {
          for (const pid of askCliPids()) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        });
        lines.length = 0;
        const one = await gateway.restartGateway(() => {}, { opId: "askliv01", ladder: { askGraceMs: kAskGraceMs } });
        expect(killed()).toBe(true);
        expect(one).toMatchObject({ ok: true, how: "graceful" });
        const oneLines = ladderLines(lines);
        expect(oneLines.some((line) => /asking status=exited attempt=1 .*class=unknown/.test(line))).toBe(true);
        expect(oneLines.some((line) => /asking status=probe attempt=1 gateway=(draining|closed)/.test(line))).toBe(true);
        expect(oneLines.some((line) => /stopping signal=SIGTERM/.test(line))).toBe(false);
        expect(await first.exited).toBe(0);
        await waitFor(readyzOk, 180_000, "relaunched gateway /readyz 200");

        // 2. The incident: ack timeout under a stalled worker.
        const second = startTurn("ask-live-2");
        await second.inFlight();
        const worker = gateway.getManagedGatewayWorkerPid();
        expect(worker).toEqual(expect.any(Number));
        const stalled = onAdmissionClosed(() => {
          try {
            process.kill(worker, "SIGSTOP");
          } catch {}
          setTimeout(() => {
            try {
              process.kill(worker, "SIGCONT");
            } catch {}
          }, 11_000);
        });
        lines.length = 0;
        const two = await gateway.restartGateway(() => {}, { opId: "askliv02", ladder: { askGraceMs: kAskGraceMs } });
        expect(stalled()).toBe(true);
        expect(two).toMatchObject({ ok: true, how: "graceful" });
        const twoLines = ladderLines(lines);
        const exited = twoLines.find((line) => /asking status=exited attempt=1/.test(line));
        expect(exited).toMatch(/exit=1 class=unknown/);
        expect(exited).toMatch(/outcome is unknown|gateway timeout after 10000ms/);
        expect(twoLines.some((line) => /stopping signal=SIGTERM/.test(line))).toBe(false);
        // Which branch the pin took is evidence, not a requirement.
        const reasked = twoLines.some((line) => /asking status=reasking/.test(line));
        originalLog(`[live] stalled ask: ${reasked ? "request rolled back, re-asked" : "request applied, drained"}`);
        await second.exited;
        await waitFor(readyzOk, 180_000, "second relaunch /readyz 200");
      } finally {
        console.log = originalLog;
        gateway.setGatewayOutputObserver(null);
      }
    },
    kTestTimeoutMs,
  );
});
