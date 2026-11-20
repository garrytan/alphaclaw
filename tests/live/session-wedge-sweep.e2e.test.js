// LIVE TIER — the post-relaunch lost-turn check (ALPH-17 PR 6, rewritten for
// OpenClaw 2026.11.5+) against the REAL pinned OpenClaw: its sessions.list
// read after a relaunch, with a real agent turn in flight (a local streaming
// model fixture holds it open). The gateway is SIGKILLed mid-turn and
// relaunched; OpenClaw writes no restart marker for a SIGKILL and resumes
// nothing, so the check must name that session to the owner exactly once,
// and a later check after a clean launch must stay silent.
const fs = require("fs");
const http = require("http");
const path = require("path");

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
  // One agent turn through the gateway's chat.send (the way the Control UI
  // and channels start one). Not `openclaw agent`: on 2026.11.6 that CLI,
  // left waiting when its gateway is SIGKILLed, stops the relaunched gateway.
  const startTurn = async (clawCmd, sessionKey) => {
    const before = modelRequests;
    const params = JSON.stringify({ sessionKey, message: "count slowly", idempotencyKey: `${sessionKey}-send`, deliver: false });
    const sent = await clawCmd(`gateway call chat.send --params '${params}' --json`, { quiet: true });
    expect(JSON.parse(sent.stdout || "{}").status, String(sent.stderr || "")).toBe("started");
    await waitFor(async () => modelRequests > before, 120_000, "turn reached the model");
  };
  it(
    "the lost-turn check against the real pin: a turn killed by SIGKILL is named to the owner once after the relaunch, and a later check stays silent",
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
        const boot = await sweep.onGatewayLaunch({ generation: 1, startedAt: Date.now() });
        expect(boot).toEqual({ alerted: [] });

        // 1. A turn in flight, then SIGKILL (the OOM shape) and a relaunch.
        const sessionKey = "agent:main:sweep-live-1";
        await startTurn(clawCmd, sessionKey);
        gateway.killManagedGatewayChildNow();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await gateway.startGateway();
        const result = await sweep.onGatewayLaunch({ generation: 2, startedAt: Date.now() });
        originalLog(`[live] after SIGKILL: ${JSON.stringify(result)}`);
        expect(result).toEqual({ alerted: [sessionKey] });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toContain("so a turn it was running was lost:");
        expect(notify.mock.calls[0][0]).toContain(sessionKey);
        expect(notify.mock.calls[0][1]).toEqual({ eventType: "session_wedge", id: expect.stringMatching(/^session-lost-[0-9a-f]{16}$/) });
        expect(insertEvent.mock.calls.map(([e]) => [e.status, e.details.sessionKey, e.details.reason])).toEqual([["alerted", sessionKey, "lost"]]);
        expect(lines.find((line) => line.startsWith("[alphaclaw] wedge-sweep done generation=2 "))).toMatch(/ checked=[1-9]\d* lost=1$/);

        // 2. The next launch reaches back only to the last check, so the same
        // loss is not reported again.
        insertEvent.mockClear();
        notify.mockClear();
        const quiet = await sweep.onGatewayLaunch({ generation: 3, startedAt: Date.now() });
        expect(quiet).toEqual({ alerted: [] });
        expect(insertEvent).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      } finally {
        console.log = originalLog;
      }
    },
    kTestTimeoutMs,
  );
});
