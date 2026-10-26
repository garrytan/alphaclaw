// LIVE TIER — a deploy's SIGTERM with an agent turn running (ALPH-45).
//
// A real AlphaClaw (\`alphaclaw start\`) manages a real pinned-OpenClaw gateway
// whose agent is inside an exec tool call (a mock model, the way
// restart-exec-turn.e2e drives one). The platform's SIGTERM goes to AlphaClaw.
//
// With the default shutdown budget (ALPHACLAW_SHUTDOWN_GRACE_SECONDS unset,
// 25 s) AlphaClaw asks OpenClaw for a restart drain sized to the time left:
// OpenClaw cuts the turn short at the drain's end, marks the session for its
// restart recovery and exits 0 on its own, so AlphaClaw exits 0 inside the
// budget and the next AlphaClaw on the same root (the next container) resumes
// the turn. The shutdown record and the deploy history are written.
//
// With the floor budget (10 s, about the old fixed 6 s slice for the gateway)
// there is no room for a drain: OpenClaw's plain stop drains for a fixed 20 s,
// so the same load is SIGKILLed — what every deploy with a running turn got
// before v0.10.140.
// Requires: Node 24.22.1+/26.12.1+ first on PATH and the pinned OpenClaw in
// node_modules.

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const {
  kLiveEnabled,
  mkTemp,
  repoOpenclawBin,
  repoBinDir,
  runCliJson,
  scrubTestRunnerEnv,
  waitFor,
  readDeclaredPin,
} = require("./live-helpers");

const describeLive = kLiveEnabled ? describe : describe.skip;
const kCaseTimeoutMs = 15 * 60 * 1000;
const kSetupPassword = "live-shutdown-drain-pw-1";
const kGatewayToken = "live-shutdown-drain-token-000000000000";
const kExecSleepSeconds = 300;
// 2026.10.6 says "interrupted by a gateway restart"; 2026.10.7 dropped it.
const kRecoveryNotePattern = /previous turn was interrupted (by a gateway restart )?while OpenClaw was waiting on tool\/model work/i;

// The model fixture runs in its own process so the synchronous CLI reads
// below never stall it. On OpenClaw's restart-recovery note it re-issues the
// interrupted exec (sleep 1, "resumed-" marker), the way a working model does.
const kModelFixtureSource = String.raw`
const http = require("http");
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && p.text) || "").join(" ") : "";
const recoveryNote = /previous turn was interrupted (by a gateway restart )?while OpenClaw was waiting on tool\/model work/i;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(body || "{}"); } catch {}
    const messages = payload.messages || [];
    const last = messages[messages.length - 1] || {};
    let start = messages.length;
    while (start > 0 && messages[start - 1].role === "user") start -= 1;
    const userText = messages.slice(start).filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
    const toolNames = (payload.tools || []).map((t) => (t.function && t.function.name) || t.name).filter(Boolean);
    let reply = null;
    let command = null;
    if (last.role === "tool") reply = "exec done: " + textOf(last.content).replace(/\s+/g, " ").slice(0, 200);
    else if (recoveryNote.test(userText)) {
      const call = [...messages].reverse().flatMap((m) => m.tool_calls || []).find((c) => c.function && c.function.name === "exec");
      const previous = call ? JSON.parse(call.function.arguments || "{}").command : null;
      if (previous && toolNames.includes("exec")) command = previous.replace(/sleep \d+/, "sleep 1").replace("echo done-", "echo resumed-");
      else reply = "recovered without exec";
    } else if (/exec:\s*(.+)/.test(userText)) command = userText.match(/exec:\s*(.+)/)[1].trim();
    else reply = "pong";
    const chunk = (delta, finish = null) => "data: " + JSON.stringify({ id: "shutdown-drain-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (command) {
      const call = { index: 0, id: "call_" + Date.now(), type: "function", function: { name: "exec", arguments: JSON.stringify({ command, timeoutSeconds: 900, yieldMs: 600000 }) } };
      res.write(chunk({ role: "assistant", content: null, tool_calls: [call] }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: reply }));
      res.write(chunk({}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + server.address().port + "\n"));
`;

// The vitest worker's env without the runner's markers (OpenClaw silences
// stdout and skips its state-owner lock under them).
const childEnv = () => {
  const env = scrubTestRunnerEnv();
  for (const key of ["NODE_ENV", "TEST", "MODE", "DEV", "PROD", "SSR", "BASE_URL", "ALPHACLAW_SHUTDOWN_GRACE_SECONDS"]) delete env[key];
  return env;
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

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";

const spawnLogged = (argv, env, sink) => {
  const child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => sink.push(String(d)));
  child.stderr.on("data", (d) => sink.push(String(d)));
  child.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  return child;
};

const killHard = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  await child.exited;
};

describeLive(`LIVE deploy SIGTERM with a running turn against the ${readDeclaredPin()} pin`, () => {
  let model = null;
  let alphaclaw = null;
  let rootDir;
  let port;
  let gatewayPort;
  let openclawEnv;
  let call;

  const boot = async (extraEnv, log) => {
    alphaclaw = spawnLogged(
      [process.execPath, path.resolve(__dirname, "../../bin/alphaclaw.js"), "start"],
      {
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
        ...extraEnv,
      },
      log,
    );
    await waitFor(() => readyzOk(gatewayPort), 5 * 60_000, `gateway ready (log tail: ${log.join("").slice(-800)})`);
  };

  // One exec turn, running when the SIGTERM lands. Returns the session key and tag.
  const startTurn = async (name) => {
    const tag = `xs-${name}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    const marker = path.join(rootDir, `${tag}.started`);
    // The gateway answers /readyz before the agent has finished its startup
    // preparation (UNAVAILABLE until then); the idempotency key makes a
    // retried send one turn.
    let sent = null;
    await waitFor(async () => {
      sent = call("chat.send", {
        sessionKey: `agent:main:${tag}`,
        message: `Run it exec: touch ${marker} && sleep ${kExecSleepSeconds} && echo done-${tag}`,
        idempotencyKey: `${tag}-send`,
        deliver: false,
      }, { exits: [0, 1] });
      if (sent?.error?.code === "UNAVAILABLE") {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return false;
      }
      return true;
    }, 180_000, `${name}: the agent accepts the turn`);
    expect(sent?.status, JSON.stringify(sent)).toBe("started");
    await waitFor(async () => fs.existsSync(marker), 120_000, `${name}: exec started`);
    // Let the tool call settle into its wait, as a real turn would be.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return { tag, sessionKey: `agent:main:${tag}` };
  };

  const sigterm = async () => {
    const sentAt = Date.now();
    alphaclaw.kill("SIGTERM");
    const exit = await Promise.race([
      alphaclaw.exited,
      new Promise((resolve) => setTimeout(() => resolve(null), 330_000)),
    ]);
    expect(exit, "AlphaClaw exited after SIGTERM").not.toBeNull();
    return { ...exit, ms: exit.at - sentAt };
  };

  beforeAll(async () => {
    const fixture = spawn(process.execPath, ["-e", kModelFixtureSource], { stdio: ["ignore", "pipe", "inherit"] });
    model = fixture;
    const modelPort = await new Promise((resolve, reject) => {
      let out = "";
      fixture.stdout.on("data", (d) => {
        out += String(d);
        const match = out.match(/PORT (\d+)/);
        if (match) resolve(Number(match[1]));
      });
      fixture.once("exit", (code) => reject(new Error(`model fixture exited ${code}`)));
    });

    rootDir = mkTemp("alphaclaw-live-shutdown-drain-");
    const openclawDir = path.join(rootDir, ".openclaw");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    port = await findFreePort();
    gatewayPort = await findFreePort();
    openclawEnv = {
      ...childEnv(),
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: openclawDir,
      XDG_CONFIG_HOME: openclawDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
      OPENCLAW_GATEWAY_TOKEN: kGatewayToken,
    };
    const onboard = spawnSync(
      process.execPath,
      [
        repoOpenclawBin(), "onboard", "--non-interactive", "--accept-risk", "--flow", "quickstart",
        "--gateway-bind", "loopback", "--gateway-port", String(gatewayPort), "--gateway-auth", "token",
        "--gateway-token", kGatewayToken, "--no-install-daemon", "--skip-health",
        "--workspace", workspaceDir, "--auth-choice", "skip",
      ],
      { encoding: "utf8", timeout: 120_000, env: openclawEnv },
    );
    expect(onboard.status, String(onboard.stderr || onboard.stdout).slice(-800)).toBe(0);
    // The agent's model is the fixture; exec runs with AlphaClaw's managed
    // defaults (full access), so the resumed turn is offered exec again.
    const configPath = path.join(openclawDir, "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.agents = { ...(config.agents || {}), defaults: { ...(config.agents?.defaults || {}), workspace: workspaceDir, model: { primary: "fixture/fixture" } } };
    config.models = { ...(config.models || {}), providers: { fixture: {
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      api: "openai-completions",
      apiKey: "local-model-fixture",
      models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
    } } };
    config.tools = { ...(config.tools || {}), exec: { ...(config.tools?.exec || {}), mode: "full" } };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.writeFileSync(
      path.join(rootDir, "onboarded.json"),
      JSON.stringify({ onboarded: true, reason: "live_e2e", markedAt: new Date().toISOString() }),
    );
    call = (method, params, { exits = [0] } = {}) =>
      runCliJson(repoOpenclawBin(), ["gateway", "call", method, "--params", JSON.stringify(params), "--json"], {
        env: openclawEnv,
        exits,
        timeoutMs: 60_000,
        label: `gateway call ${method}`,
      });
  }, 5 * 60 * 1000);

  afterAll(async () => {
    await killHard(alphaclaw);
    model?.kill("SIGKILL");
  });

  it("the floor budget (10 s) has no room for a drain: the same load is SIGKILLed, like the old 6 s slice", async () => {
    const log = [];
    await boot({ ALPHACLAW_SHUTDOWN_GRACE_SECONDS: "10" }, log);
    await startTurn("floor");
    const exit = await sigterm();
    const text = log.join("");
    console.log(`[live] floor budget: exit ${JSON.stringify(exit)}; ${text.match(/restart op=\S+ stopped how=\S+ ms=\d+/)?.[0]}`);
    expect(text).toContain("[alphaclaw] Shutting down: SIGTERM (budget 10 s)");
    expect(text).toMatch(/restart op=\S+ asking status=skipped reason=no_budget/);
    expect(text).toMatch(/restart op=\S+ stopped how=sigkill /);
    expect(exit.ms).toBeLessThan(10_000 + 2_000);
  }, kCaseTimeoutMs);

  it("the default budget (25 s): OpenClaw drains, cuts the turn short for restart recovery and exits on its own; AlphaClaw exits 0 inside the budget, records the shutdown, and the next AlphaClaw resumes the turn", async () => {
    const log = [];
    await boot({}, log);
    const { tag, sessionKey } = await startTurn("default");
    const exit = await sigterm();
    const text = log.join("");
    const tail = text.slice(-3_000);
    console.log(`[live] default budget: exit ${JSON.stringify(exit)}; ${text.match(/restart op=\S+ asking status=running graceMs=\d+/)?.[0]}; ${text.match(/restart op=\S+ stopped how=\S+ ms=\d+/)?.[0]}`);

    expect(exit, tail).toMatchObject({ code: 0, signal: null });
    expect(exit.ms, tail).toBeLessThan(25_000);
    expect(text).toContain("[alphaclaw] Shutting down: SIGTERM (budget 25 s)");
    expect(text, tail).toMatch(/restart op=\S+ asking status=running graceMs=\d+ graceReason=shutdown_budget/);
    expect(text, tail).toMatch(/restart op=\S+ stopped how=graceful /);
    expect(text).not.toMatch(/restart op=\S+ forcing signal=SIGKILL/);
    expect(text).not.toContain("Shutdown deadline exceeded");
    expect(text, tail).toMatch(/marked 1 interrupted main session\(s\) for restart recovery/);
    const drain = Number(text.match(/restart op=\S+ asking status=running graceMs=(\d+)/)[1]);
    // OpenClaw's drain filled most of the budget, not a fixed sliver of it.
    expect(drain).toBeGreaterThanOrEqual(5_000);
    // The shutdown record and the deploy history survive the drain.
    const record = JSON.parse(fs.readFileSync(path.join(rootDir, ".openclaw", ".alphaclaw", "last-shutdown.json"), "utf8"));
    expect(record).toMatchObject({ kind: "shutdown", reason: "SIGTERM", code: 0 });
    const history = JSON.parse(fs.readFileSync(path.join(rootDir, "deploy-history.json"), "utf8"));
    expect(history.lastShutdown).toMatchObject({ reason: "SIGTERM" });
    expect(text).toContain("[deploy] SIGTERM with no announcement: sending the shutdown notice");

    // The next container: a fresh AlphaClaw on the same root resumes the turn.
    await boot({}, []);
    let messages = [];
    await waitFor(async () => {
      messages = call("chat.history", { sessionKey, limit: 30 }, { exits: [0, 1] })?.messages || [];
      const finalText = textOf([...messages].reverse().find((m) => m.role === "assistant")?.content);
      return finalText.includes(`exec done: resumed-${tag}`);
    }, 240_000, "the interrupted turn resumed and finished after the next boot");
    expect(messages.some((m) => m.role === "user" && kRecoveryNotePattern.test(textOf(m.content)))).toBe(true);
  }, kCaseTimeoutMs);
});
