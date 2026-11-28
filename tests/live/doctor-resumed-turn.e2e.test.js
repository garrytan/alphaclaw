// LIVE TIER — the resumed Doctor turn stop (doctor/resumed-turns.js) against
// the REAL pinned OpenClaw. A Doctor-shaped turn (session
// agent:main:doctor:<n>, sent through gateway call agent with the idempotency
// key doctor-run-<n>, the way doctor/service.js sends it) is running when
// AlphaClaw restarts the gateway through its stop ladder. OpenClaw cuts the
// turn short for restart resume and the next gateway starts it again; the
// stop must find that resumed turn and abort it. On 2026.11.5+ no gateway
// call names the resumed run's id (sessions.list, sessions.get and
// chat.history do not; the resume message's idempotency key is its own id),
// so the abort names the session and the run it stopped comes back from
// chat.abort.
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-doctor-resume-root-");
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
const kTurnSeconds = 240;

describeLive(`LIVE resumed Doctor turn stop against the ${kCandidateBinDir ? "candidate" : readDeclaredPin()} pin`, () => {
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
          `data: ${JSON.stringify({ id: "doctor-resume-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
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
    port = 19100 + Math.floor(Math.random() * 400);
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

  it(
    "a Doctor turn a gateway restart cut short and OpenClaw resumed is found and its run aborted",
    async () => {
      const { clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
      const call = async (method, params) => {
        const result = await clawCmd(`gateway call ${method} --params '${JSON.stringify(params)}' --json`, { quiet: true });
        return { ok: result.ok, body: JSON.parse(result.stdout || "{}"), stderr: String(result.stderr || "") };
      };
      const doctorRunId = 41;
      const sessionKey = `agent:main:doctor:${doctorRunId}`;
      await gateway.startGateway();
      await waitFor(readyzOk, 180_000, "first gateway /readyz 200");

      const before = modelRequests;
      const sent = await call("agent", { agentId: "main", idempotencyKey: `doctor-run-${doctorRunId}`, message: "count slowly", sessionKey, timeout: 600 });
      expect(sent.ok, sent.stderr).toBe(true);
      await waitFor(async () => modelRequests > before, 120_000, "the Doctor turn reached the model");

      const resumedBefore = modelRequests;
      await gateway.restartGateway(() => {}, { source: "live:doctor_resume", reason: "live test" });
      await waitFor(readyzOk, 180_000, "relaunched gateway /readyz 200");
      await waitFor(async () => modelRequests > resumedBefore, 120_000, "OpenClaw resumed the Doctor turn");

      const list = await call("sessions.list", { activeOnly: true, limit: 200, rowMode: "compact" });
      const row = (list.body.sessions || []).find((entry) => entry.key === sessionKey);
      const history = await call("sessions.get", { key: sessionKey, limit: 500 });
      const users = (history.body.messages || []).filter((message) => message.role === "user");
      const resume = users[users.length - 1];
      expect(users[0]?.idempotencyKey).toBe(`doctor-run-${doctorRunId}:user`);
      console.log(`[live] resumed row: ${JSON.stringify({ hasActiveRun: row?.hasActiveRun, activeRunIds: row?.activeRunIds })}; resume message: ${JSON.stringify({ idempotencyKey: resume?.idempotencyKey, provenance: resume?.provenance })}`);
      expect(row?.hasActiveRun).toBe(true);

      const insertEvent = vi.fn();
      const { createResumedDoctorTurnStop } = require("../../lib/server/doctor/resumed-turns");
      const stop = createResumedDoctorTurnStop({
        clawCmd,
        probeReadiness: require("../../lib/server/gateway-readiness").probeGatewayReadiness,
        resolveReadyzUrl: () => `http://127.0.0.1:${port}/readyz`,
        insertEvent,
        checkOffsetsMs: [0, 5_000, 15_000],
      });
      const result = await stop.onGatewayLaunch();
      console.log(`[live] stop result: ${JSON.stringify(result)}`);
      expect(result).toEqual({ stopped: [expect.any(String)], missed: [] });
      expect(insertEvent).toHaveBeenCalledTimes(1);
      const stoppedRun = insertEvent.mock.calls[0][0].details;
      console.log(`[live] stopped: ${JSON.stringify(stoppedRun)}`);
      expect(stoppedRun).toMatchObject({ kind: "resumed_turn_stopped", sessionKey, doctorRunId });
      expect(stoppedRun.runId).toMatch(/^[0-9a-f-]{36}$/);
      await waitFor(async () => {
        const after = await call("sessions.list", { activeOnly: true, limit: 200, rowMode: "compact" });
        return !(after.body.sessions || []).some((entry) => entry.key === sessionKey && entry.hasActiveRun === true);
      }, 60_000, "the resumed Doctor turn stopped");
      expect(stop.hasStopped(sessionKey, Date.now())).toBe(true);
    },
    kTestTimeoutMs,
  );
});
