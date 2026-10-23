// LIVE TIER — an agent turn inside an exec tool call, interrupted by each
// restart class, against the REAL pinned OpenClaw and the REAL
// lib/server/gateway.js ladder (ALPH-19). The wedge sweep is wired the way
// lib/server.js wires it (restart requested → record, every launch notice →
// onGatewayLaunch), so a managed restart's two launch notices per generation
// are exercised too.
//
// Per class (routine with the full 180 s drain, routine cut short by Restart
// now, a watchdog repair, a memory mitigation, a SIGKILL crash) it holds: the
// exec outlives the drain, the turn is interrupted, and after the relaunch
// OpenClaw's own restart recovery resumes it with exec still offered
// (AlphaClaw's managed default, tools.exec.mode=full). The model fixture
// re-runs the command and the turn finishes in the same session. Through the
// supported surfaces only: sessions.list shows no live run, no abortedLastRun
// and no tombstone; sessions.recover says there is nothing to recover; the
// sweep recorded the running session and stays silent.
//
// The one loss OpenClaw cannot recover is pinned too: an exec that already
// yielded to a background process session (the turn ended; OpenClaw caps the
// yield window at 120 s) is stopped by the restart, nothing resumes it, and
// the sweep tells the owner once from OpenClaw's drain report.
//
// ALPH-18's "exec turn lost" verdict came from its blackbox mock model, which
// answered the recovery prompt with plain text instead of acting on it. This
// fixture answers the way a working model does: on the restart-recovery note
// it re-issues the interrupted exec (with sleep 1), so a lost turn shows up as
// a missing "exec done: resumed-<tag>" reply.
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-exec-restart-root-");
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
const kCaseTimeoutMs = 12 * 60 * 1000;
// Longer than the routine drain (180 s), so every class interrupts the exec.
const kExecSleepSeconds = 300;
const kRecoveryNotePattern = /interrupted by a gateway restart/i;
const kNothingToRecoverPattern = /requires a restart-tombstoned session|Session is not recoverable/i;

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";

describeLive(`LIVE exec turn across every restart class against the ${kCandidateBinDir ? "candidate" : readDeclaredPin()} pin`, () => {
  let gateway;
  let model;
  let port;
  let call;
  let sweepJob = null;
  let originalLog = null;
  const requests = [];
  const lines = [];
  const notify = vi.fn(async () => ({ ok: true }));
  const insertEvent = vi.fn();

  const readyzOk = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    model = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {}
        const messages = payload.messages || [];
        const last = messages[messages.length - 1] || {};
        let start = messages.length;
        while (start > 0 && messages[start - 1].role === "user") start -= 1;
        const userText = messages.slice(start).filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
        const toolNames = (payload.tools || []).map((tool) => tool.function?.name || tool.name).filter(Boolean);
        const tag = (messages.map((m) => textOf(m.content) + JSON.stringify(m.tool_calls || "")).join(" ").match(/xr-[a-z]+-[0-9a-z]{6}/g) || []).pop() || null;
        const recovery = kRecoveryNotePattern.test(userText);
        let reply = null;
        let command = null;
        if (last.role === "tool") reply = `exec done: ${textOf(last.content).replace(/\s+/g, " ").slice(0, 200)}`;
        else if (recovery) {
          const interrupted = [...messages].reverse().flatMap((m) => m.tool_calls || []).find((c) => c.function?.name === "exec");
          const previous = interrupted ? JSON.parse(interrupted.function.arguments || "{}").command : null;
          if (previous && toolNames.includes("exec")) command = previous.replace(/sleep \d+/, "sleep 1").replace("echo done-", "echo resumed-");
          else reply = `recovered without exec: ${tag}`;
        } else if (/exec:\s*(.+)/.test(userText)) command = userText.match(/exec:\s*(.+)/)[1].trim();
        else reply = "pong";
        const yieldMs = /in the background/.test(userText) && !recovery ? 2000 : 600000;
        requests.push({ at: Date.now(), tag, recovery, execOffered: toolNames.includes("exec") });
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({ id: "exec-restart-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (command) {
          const call = { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ command, timeoutSeconds: 900, yieldMs }) } };
          res.write(chunk({ role: "assistant", content: null, tool_calls: [call] }));
          res.write(chunk({}, "tool_calls"));
        } else {
          res.write(chunk({ role: "assistant", content: reply }));
          res.write(chunk({}, "stop"));
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19900 + Math.floor(Math.random() * 90);
    const token = "live-exec-restart-token-000000000000000";
    const workspace = path.join(OPENCLAW_DIR, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    const { ensureManagedOpenclawExecDefaults } = require("../../lib/server/exec-defaults-config");
    const { config } = ensureManagedOpenclawExecDefaults({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace, model: { primary: "fixture/fixture" } } },
      models: { providers: { fixture: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      channels: {},
    });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(config));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
    const { clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
    const { shellEscapeArg } = require("../../lib/server/agents/shared");
    call = async (method, params) => {
      const result = await clawCmd(`gateway call ${shellEscapeArg(method)} --params ${shellEscapeArg(JSON.stringify(params))} --json`, { quiet: true, timeoutMs: 30_000 });
      let parsed = null;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {}
      return { body: parsed, stderr: String(result.stderr || "") };
    };
    originalLog = console.log;
    console.log = (...args) => {
      lines.push(args.map(String).join(" "));
      originalLog(...args);
    };
    const { createSessionWedgeSweep } = require("../../lib/server/session-wedge-sweep");
    const sweep = createSessionWedgeSweep({
      clawCmd,
      notify,
      insertEvent,
      resolveReadyzUrl: () => `http://127.0.0.1:${port}/readyz`,
      settleAfterReadyMs: 20_000,
    });
    gateway.setGatewayRestartRequestedHandler((payload) => sweep.recordRunningSessions(payload));
    gateway.setGatewayOutputObserver((text) => sweep.observeGatewayOutput(text));
    gateway.setGatewayLaunchHandler((payload) => {
      sweepJob = sweep.onGatewayLaunch(payload);
    });
    await gateway.startGateway();
    await waitFor(readyzOk, 180_000, "first gateway /readyz 200");
    await sweepJob;
  }, 6 * 60 * 1000);

  afterAll(async () => {
    if (originalLog) console.log = originalLog;
    gateway?.setGatewayLaunchHandler?.(null);
    gateway?.setGatewayOutputObserver?.(null);
    gateway?.setGatewayRestartRequestedHandler?.(null);
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

  // One exec turn interrupted by restart(): it must be resumed and finish,
  // and every supported surface must agree nothing is stuck.
  const runCase = async (name, restart, { recorded }) => {
    const tag = `xr-${name}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    const sessionKey = `agent:main:${tag}`;
    const marker = path.join(kRootDir, `${tag}.started`);
    if (!(await readyzOk())) {
      await gateway.startGateway();
      await waitFor(readyzOk, 240_000, `${name}: gateway ready before the case`);
      await sweepJob;
    }
    notify.mockClear();
    insertEvent.mockClear();
    const sent = await call("chat.send", {
      sessionKey,
      message: `Run it exec: touch ${marker} && sleep ${kExecSleepSeconds} && echo done-${tag}`,
      idempotencyKey: `${tag}-send`,
      deliver: false,
    });
    expect(sent.body?.status, sent.stderr).toBe("started");
    await waitFor(async () => fs.existsSync(marker), 120_000, `${name}: exec started`);
    sweepJob = null;
    const outcome = await restart();
    await waitFor(readyzOk, 240_000, `${name}: /readyz after the restart`);
    const readyAt = Date.now();

    let history = [];
    await waitFor(async () => {
      history = (await call("chat.history", { sessionKey, limit: 30 })).body?.messages || [];
      const finalText = textOf([...history].reverse().find((m) => m.role === "assistant")?.content);
      return finalText.includes(`exec done: resumed-${tag}`);
    }, 240_000, `${name}: the interrupted exec turn resumed and finished`);
    expect(history.some((m) => m.role === "user" && kRecoveryNotePattern.test(textOf(m.content)))).toBe(true);
    const recoveryRequest = requests.find((r) => r.tag === tag && r.recovery);
    expect(recoveryRequest, "OpenClaw sent the restart-recovery continuation").toBeTruthy();
    expect(recoveryRequest.execOffered, "exec is still offered to the resumed turn under full exec access").toBe(true);
    originalLog(`[live] ${name}: resumed ${Math.round((recoveryRequest.at - readyAt) / 1000)} s after ready`);

    const listed = await call("sessions.list", { activeMinutes: 60, limit: 200, rowMode: "compact" });
    const row = (listed.body?.sessions || []).find((s) => s.key === sessionKey);
    expect(row).toBeTruthy();
    expect(row.hasActiveRun).not.toBe(true);
    expect(row.abortedLastRun).not.toBe(true);
    expect(row.restartRecoveryStatus).toBeUndefined();
    const recover = await call("sessions.recover", { key: sessionKey, agentId: "main" });
    expect(recover.body?.ok).not.toBe(true);
    expect(`${recover.body?.error?.message || ""} ${recover.stderr}`).toMatch(kNothingToRecoverPattern);

    expect(sweepJob, "the relaunch scheduled a sweep").toBeTruthy();
    expect(await sweepJob).toEqual({ recovered: [], alerted: [] });
    const generation = gateway.getLaunchGeneration();
    const done = lines.filter((line) => line.startsWith(`[alphaclaw] wedge-sweep done generation=${generation} `));
    expect(done).toHaveLength(1);
    expect(done[0]).toContain(` recorded=${recorded} recovered=0 alerted=0`);
    expect(notify).not.toHaveBeenCalled();
    expect(insertEvent).not.toHaveBeenCalled();
    return outcome;
  };

  const restartVia = (options) => () => gateway.restartGateway(() => {}, { reason: "live exec turn", ...options });

  it("routine restart with the full drain: the exec outlives it, OpenClaw resumes the turn", async () => {
    const outcome = await runCase("routine", restartVia({ source: "api:restart" }), { recorded: 1 });
    expect(outcome.stopEvidence.askGraceMs).toBe(180_000);
  }, kCaseTimeoutMs);

  it("routine restart cut short by Restart now (SIGTERM, then SIGKILL): OpenClaw resumes the turn", async () => {
    const outcome = await runCase("restartnow", () => {
      const expediteAt = Date.now() + 10_000;
      return restartVia({ source: "api:restart", shouldExpedite: () => Date.now() >= expediteAt })();
    }, { recorded: 1 });
    expect(outcome.stopEvidence.askExit).toBe("expedited");
  }, kCaseTimeoutMs);

  it("watchdog repair (30 s drain): OpenClaw resumes the turn", async () => {
    const outcome = await runCase("repair", restartVia({ source: "watchdog:repair_replace" }), { recorded: 1 });
    expect(outcome.stopEvidence.askGraceMs).toBe(30_000);
  }, kCaseTimeoutMs);

  it("memory mitigation (imminent exhaustion, 30 s drain): OpenClaw resumes the turn", async () => {
    const outcome = await runCase("memory", restartVia({
      source: "watchdog:memory_mitigation",
      ladder: { askGraceMs: () => ({ askGraceMs: 30_000, reason: "live_imminent" }) },
    }), { recorded: 1 });
    expect(outcome.stopEvidence.askGraceReason).toBe("live_imminent");
  }, kCaseTimeoutMs);

  it("an exec already moved to the background is stopped by the restart, nothing resumes it, and the owner is told once", async () => {
    if (!(await readyzOk())) {
      await gateway.startGateway();
      await waitFor(readyzOk, 240_000, "background: gateway ready before the case");
      await sweepJob;
    }
    const tag = `xr-bg-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    const sessionKey = `agent:main:${tag}`;
    const marker = path.join(kRootDir, `${tag}.started`);
    notify.mockClear();
    insertEvent.mockClear();
    const sent = await call("chat.send", {
      sessionKey,
      message: `Run it in the background exec: touch ${marker} && sleep ${kExecSleepSeconds} && echo done-${tag}`,
      idempotencyKey: `${tag}-send`,
      deliver: false,
    });
    expect(sent.body?.status, sent.stderr).toBe("started");
    await waitFor(async () => fs.existsSync(marker), 120_000, "background: exec started");
    // The turn ends once the exec yields to a background process session.
    await waitFor(async () => {
      const listed = await call("sessions.list", { activeMinutes: 60, limit: 200, rowMode: "compact" });
      const row = (listed.body?.sessions || []).find((s) => s.key === sessionKey);
      return Boolean(row) && row.hasActiveRun !== true && row.status === "done";
    }, 120_000, "background: the turn ended with the exec still running");
    sweepJob = null;
    const outcome = await gateway.restartGateway(() => {}, { source: "watchdog:repair_replace", reason: "live exec turn" });
    expect(outcome.ok).toBe(true);
    await waitFor(readyzOk, 240_000, "background: /readyz after the restart");
    expect(await sweepJob).toEqual({ recovered: [], alerted: [] });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("The gateway restart stopped 1 command the agent was running in the background.");
    expect(insertEvent.mock.calls.map(([e]) => [e.status, e.details.count])).toEqual([["exec_stopped", 1]]);
    // OpenClaw's side: nothing marks or resumes it.
    expect(requests.some((r) => r.tag === tag && r.recovery)).toBe(false);
    const listed = await call("sessions.list", { activeMinutes: 60, limit: 200, rowMode: "compact" });
    const row = (listed.body?.sessions || []).find((s) => s.key === sessionKey);
    expect(row.abortedLastRun).not.toBe(true);
    expect(row.restartRecoveryStatus).toBeUndefined();
    const recover = await call("sessions.recover", { key: sessionKey, agentId: "main" });
    expect(`${recover.body?.error?.message || ""} ${recover.stderr}`).toMatch(kNothingToRecoverPattern);
  }, kCaseTimeoutMs);

  it("SIGKILL crash and relaunch: OpenClaw resumes the turn", async () => {
    await runCase("sigkill", async () => {
      gateway.killManagedGatewayChildNow();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await gateway.startGateway();
    }, { recorded: 0 });
  }, kCaseTimeoutMs);
});
