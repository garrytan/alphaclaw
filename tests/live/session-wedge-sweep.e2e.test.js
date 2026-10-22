// LIVE TIER — the post-relaunch wedge sweep (ALPH-17 PR 6) against the REAL
// pinned OpenClaw: its sessions.list reads (activeOnly before a restart, the
// recent window after a relaunch) and its sessions.recover call, with a real
// agent turn in flight (a local streaming model fixture holds it open). The
// gateway is SIGKILLed mid-turn and relaunched; 2026.10.6 resumes the killed
// turn itself, so the sweep finding nothing to alert is the expected outcome
// there, and a finished session must answer "nothing to recover".
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-sweep-root-");
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
const kTurnSeconds = 45;

describeLive(`LIVE wedge sweep against the ${kCandidateBinDir ? "candidate" : readDeclaredPin()} pin`, () => {
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
          `data: ${JSON.stringify({ id: "sweep-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
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
  it(
    "the sweep's reads and its recover call work against the real pin: running sessions are recorded before a restart, a relaunch after a SIGKILL mid-turn is swept, and a finished session answers 'nothing to recover'",
    async () => {
      const lines = [];
      const originalLog = console.log;
      console.log = (...args) => {
        lines.push(args.map(String).join(" "));
        originalLog(...args);
      };
      try {
        const { clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
        const insertEvent = vi.fn();
        const notify = vi.fn(async () => ({ ok: true }));
        const { createSessionWedgeSweep } = require("../../lib/server/session-wedge-sweep");
        const sweep = createSessionWedgeSweep({
          clawCmd,
          notify,
          insertEvent,
          resolveReadyzUrl: () => `http://127.0.0.1:${port}/readyz`,
          settleAfterReadyMs: 30_000,
        });
        await gateway.startGateway();
        await waitFor(readyzOk, 180_000, "first gateway /readyz 200");

        // 1. A turn in flight is recorded through sessions.list activeOnly.
        const turn = startTurn("sweep-live-1");
        await turn.inFlight();
        expect(await sweep.recordRunningSessions({ opId: "sweepliv1" })).toBe(1);

        // 2. SIGKILL mid-turn (the OOM shape), relaunch, sweep after ready.
        gateway.killManagedGatewayChildNow();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await gateway.startGateway();
        const result = await sweep.onGatewayLaunch({ generation: 2, startedAt: Date.now() });
        expect(result.skipped).toBeUndefined();
        const done = lines.find((line) => line.startsWith("[alphaclaw] wedge-sweep done generation=2"));
        expect(done).toMatch(/checked=[1-9]\d* recorded=1 /);
        // 2026.10.6 resumes the killed turn on its own (its recovery owner);
        // which branch it took is evidence, not a requirement.
        originalLog(`[live] after SIGKILL: ${JSON.stringify(result)} events=${JSON.stringify(insertEvent.mock.calls.map(([e]) => [e.status, e.details?.reason || null]))}`);
        expect(insertEvent.mock.calls.every(([e]) => e.status !== "failed")).toBe(true);
        await turn.exited;

        // 3. A finished session: OpenClaw says there is nothing to recover,
        // and the sweep stays silent (pins kNothingToRecoverPattern).
        await waitFor(async () => {
          const r = await clawCmd(`gateway call 'sessions.list' --params '{"activeOnly":true}' --json`, { quiet: true });
          return r.ok && JSON.parse(r.stdout).sessions.length === 0;
        }, 300_000, "no active sessions");
        insertEvent.mockClear();
        notify.mockClear();
        const quiet = await sweep.sweep({ generation: 3, launchAtMs: Date.now(), recordedKeys: new Map([["agent:main:explicit:sweep-live-1", { agentId: "main" }]]) });
        expect(quiet).toEqual({ recovered: [], alerted: [] });
        expect(insertEvent).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      } finally {
        console.log = originalLog;
      }
    },
    kTestTimeoutMs,
  );
});
