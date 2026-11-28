// LIVE TIER — the post-relaunch lost-turn check (ALPH-17 PR 6, rewritten for
// OpenClaw 2026.11.5+) against the REAL pinned OpenClaw: its sessions.list
// read after a relaunch, with a real agent turn in flight (a local streaming
// model fixture holds it open). The gateway is SIGKILLed mid-turn and
// relaunched. OpenClaw 2026.11.10 resumes a turn the killed gateway left open
// when its boot record covers the turn; one it does not resume is lost, and
// its start-up pass ends that row as killed. Which happens is OpenClaw's
// choice, so the check is asserted against the row OpenClaw actually wrote:
// silent when the row shows a run started after the launch, one notice naming
// the session otherwise, and a later check stays silent either way. The
// killed row itself is built by the pin's own lifecycle code and classified
// here, so the 2026.11.10 shape is checked on every run whatever the kill did.
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
    "the lost-turn check against the real pin: after a SIGKILL mid-turn it matches the row OpenClaw wrote (silent after a resume, one notice after a loss), and a later check stays silent",
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
        const { createSessionWedgeSweep, classifySessions } = require("../../lib/server/session-wedge-sweep");
        const { callGateway } = require("../../lib/server/gateway-call");
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
        const launchAt = Date.now();
        await gateway.startGateway();
        const result = await sweep.onGatewayLaunch({ generation: 2, startedAt: launchAt });
        const listed = await callGateway(clawCmd, "sessions.list", { activeMinutes: 60, limit: 200, rowMode: "compact" });
        const row = (listed.body?.sessions || []).find((entry) => entry.key === sessionKey);
        const fields = row && { status: row.status ?? null, startedAt: row.startedAt ?? null, endedAt: row.endedAt ?? null, hasActiveRun: row.hasActiveRun === true };
        originalLog(`[live] after SIGKILL: ${JSON.stringify({ result, launchAt, fields })}`);
        expect(row, "the killed turn's session row").toBeTruthy();
        // A resume shows as a run that started after the launch; anything
        // else is a turn nothing resumed (2026.11.10: status "killed" ended by
        // its start-up pass; older pins: never ended).
        const resumed = row.hasActiveRun === true || Number(row.startedAt) >= launchAt;
        if (resumed) {
          expect(result).toEqual({ alerted: [] });
          expect(notify).not.toHaveBeenCalled();
          expect(insertEvent).not.toHaveBeenCalled();
          expect(lines.find((line) => line.startsWith("[alphaclaw] wedge-sweep done generation=2 "))).toMatch(/ checked=[1-9]\d* lost=0$/);
        } else {
          // 2026.11.10's killed row is lost from its fields alone; a row the
          // kill caught before it recorded the run is only a candidate that
          // the sweep confirms from chat.history.
          const classified = classifySessions({ rows: [row], launchAtMs: launchAt, sinceMs: launchAt - 60 * 60 * 1000 });
          expect([...classified.lost, ...classified.unstarted].map((entry) => entry.row.key)).toEqual([sessionKey]);
          expect(result).toEqual({ alerted: [sessionKey] });
          expect(notify).toHaveBeenCalledTimes(1);
          expect(notify.mock.calls[0][0]).toContain("so a turn it was running was lost:");
          expect(notify.mock.calls[0][0]).toContain(sessionKey);
          expect(notify.mock.calls[0][1]).toEqual({ eventType: "session_wedge", id: expect.stringMatching(/^session-lost-[0-9a-f]{16}$/) });
          expect(insertEvent.mock.calls.map(([e]) => [e.status, e.details.sessionKey, e.details.reason])).toEqual([["alerted", sessionKey, "lost"]]);
          expect(lines.find((line) => line.startsWith("[alphaclaw] wedge-sweep done generation=2 "))).toMatch(/ checked=[1-9]\d* lost=1$/);
        }

        // 2. The next launch reaches back only to the last check, so a loss
        // is not reported again, and a resumed turn stays unreported.
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

  it("the pin's own restart-end patch for a run nothing resumed (status killed, ended after the launch) counts as lost; one ended before the launch does not", async () => {
    const distDir = path.dirname(require.resolve("openclaw", kCandidateBinDir ? { paths: [path.dirname(kCandidateBinDir)] } : undefined));
    const candidates = fs.readdirSync(distDir).filter((name) => /^session-entry-patch-operation-.*\.mjs$/.test(name));
    let derive = null;
    for (const name of candidates) {
      const text = fs.readFileSync(path.join(distDir, name), "utf8");
      const alias = /derivePersistedSessionLifecyclePatch as ([\w$]+)/.exec(text)?.[1];
      if (alias) derive = (await import(path.join(distDir, name)))[alias];
    }
    expect(typeof derive, "the pin's derivePersistedSessionLifecyclePatch").toBe("function");
    const launchAt = Date.now();
    const { classifySessions } = require("../../lib/server/session-wedge-sweep");
    // What 2026.11.10's session-restart-resume writes at start for a run the
    // dead process left open and it did not resume.
    const endedBy = (ts) => {
      const entry = { key: "agent:main:killed", sessionId: "s1", lifecycleRunId: "run-1", startedAt: launchAt - 60_000, updatedAt: launchAt - 59_000, abortedLastRun: false, hasActiveRun: false };
      // The pin's own patch; classifySessions reads only status, startedAt,
      // endedAt and hasActiveRun from it.
      return { ...entry, ...derive({ entry, currentLifecycleGeneration: 1, event: { runId: "run-1", ts, data: { phase: "end", aborted: true, stopReason: "restart" } } }) };
    };
    const killed = endedBy(launchAt + 3_000);
    expect(killed).toMatchObject({ status: "killed", endedAt: launchAt + 3_000, startedAt: launchAt - 60_000, lifecycleRunId: undefined, lastRunId: "run-1" });
    const classify = (row) => classifySessions({ rows: [row], launchAtMs: launchAt, sinceMs: launchAt - 60 * 60 * 1000 }).lost.length;
    expect(classify(killed)).toBe(1);
    expect(classify(endedBy(launchAt - 10_000))).toBe(0);
  });
});
