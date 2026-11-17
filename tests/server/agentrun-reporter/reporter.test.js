const fs = require("fs");
const os = require("os");
const path = require("path");

const reporterPlugin = require("../../../lib/plugin/agentrun-reporter");
const { classifySession, isIncognitoSessionKey } = require("../../../lib/plugin/agentrun-reporter/classify");
const { createAgentrunReporter } = require("../../../lib/server/agentrun-reporter");
const { openOutbox } = require("../../../lib/server/agentrun-reporter/outbox");
const { createOpenclawSource, contentStillAllowed } = require("../../../lib/server/agentrun-reporter/openclaw-source");
const { createAgentrunClient } = require("../../../lib/server/agentrun-reporter/agentrun-client");
const { createSender } = require("../../../lib/server/agentrun-reporter/sender");
const { eventBatches, cut } = require("../../../lib/server/agentrun-reporter/bodies");
const {
  applyAgentrunReporterEntry,
  resolveAgentrunReporterConfig,
  kAgentrunReporterPluginPath,
} = require("../../../lib/server/agentrun-reporter/config");
const { kDeploymentOnlyEnvKeys, kDeploymentSecretEnvKeys } = require("../../../lib/server/deployment-only-env");
const { admitsGatewayEnvKey } = require("../../../lib/server/gateway-env-policy");
const { createFakeAgentrun } = require("./fake-agentrun");

const kMarker = "SECRET-MARKER-7f3a";
const kBase = "http://agentrun.test/v2";

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "agentrun-reporter-"));

// Registers a fresh plugin instance and returns its hooks.
const registerPlugin = (rootDir, { fsModule, generationId } = {}) => {
  const handlers = {};
  const lines = [];
  const plugin = reporterPlugin.createAgentrunReporterPlugin({ ...(fsModule ? { fsModule } : {}), ...(generationId ? { generationId } : {}) });
  plugin.register({
    pluginConfig: { rootDir },
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    on: (name, handler) => {
      handlers[name] = handler;
    },
  });
  return { handlers, lines };
};

// One full turn through the plugin's hooks, with marker text everywhere a
// turn can carry contents. model_call_started gets the context OpenClaw
// 2026.11.4 really sends it: no trigger and no job id.
const driveTurn = (handlers, { runId, sessionKey, trigger = "user", jobId, agentId = "main", fail = false, tools = 2 }) => {
  const ctx = { runId, sessionKey, trigger, jobId, agentId, channel: "telegram" };
  handlers.model_call_started({ runId, sessionKey, provider: "anthropic", model: "claude" }, { runId, sessionKey, agentId, modelProviderId: "anthropic", modelId: "claude" });
  handlers.llm_output(
    {
      runId,
      sessionId: "s1",
      provider: "anthropic",
      model: "claude",
      prompt: `prompt ${kMarker} injected brain page`,
      assistantTexts: [`answer ${kMarker}-${runId}`],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
    },
    ctx,
  );
  for (let index = 0; index < tools; index += 1) {
    handlers.after_tool_call(
      { toolName: `tool${index}`, params: { secret: kMarker }, result: { body: kMarker }, runId, durationMs: 12 },
      { ...ctx, toolName: `tool${index}` },
    );
  }
  handlers.agent_end({ runId, messages: [{ role: "user", content: kMarker }], success: !fail, error: fail ? `boom ${kMarker}` : undefined, durationMs: 900 }, ctx);
};

const readSpool = (rootDir) => {
  const spool = path.join(rootDir, "agentrun-spool");
  if (!fs.existsSync(spool)) return "";
  return fs
    .readdirSync(spool, { recursive: true })
    .map((name) => path.join(spool, String(name)))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
};

const makePipeline = (rootDir, { fake, contentCron = [], cronJobs = [], token, runtime = "claude-agent-sdk", now } = {}) => {
  const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db"), ...(now ? { now } : {}) });
  const source = createOpenclawSource({
    rootDir,
    outbox,
    getContentCronJobs: () => new Set(contentCron),
    readCronJobs: () => cronJobs,
    logger: { warn: () => {} },
  });
  const logs = [];
  const settings = { runtime };
  const sender = createSender({
    outbox,
    client: createAgentrunClient({ baseUrl: kBase, fetchImpl: fake.fetchImpl }),
    token: token ?? fake.token,
    getRuntime: () => settings.runtime,
    contentAllowed: (row) => contentStillAllowed(row, new Set(contentCron)),
    random: () => 0.5,
    logger: { warn: (line) => logs.push(line) },
    ...(now ? { now } : {}),
  });
  return { outbox, source, sender, logs, settings };
};

describe("agentrun reporter: session classes", () => {
  it.each([
    ["agent:main:cron:daily-brief", "cron", undefined, "cron"],
    ["agent:main:cron:daily-brief:run:abc", "cron", "daily-brief", "cron"],
    ["agent:main:cron:daily-brief:run:abc", "cron", "other-job", "unknown"],
    ["agent:main:cron:daily-brief", "user", undefined, "unknown"],
    ["agent:main:cron:daily-brief", undefined, undefined, "unknown"],
    ["agent:main:telegram:direct:424242", "user", undefined, "dm"],
    ["agent:main:telegram:default:direct:424242", "user", undefined, "dm"],
    ["agent:main:telegram:direct:424242:heartbeat", "user", undefined, "dm"],
    ["agent:main:telegram:group:-1001:topic:42", "user", undefined, "group"],
    ["agent:main:discord:channel:99", "user", undefined, "group"],
    ["agent:main:main", "user", undefined, "main"],
    ["agent:main:main", "cron", undefined, "main"],
    ["agent:main:main", "heartbeat", undefined, "heartbeat"],
    ["agent:main:relay-capy-abc", "user", undefined, "relay"],
    ["agent:main:hook:gmail:123", "user", undefined, "hook"],
    ["agent:main:subagent:5f1d", "cron", undefined, "subagent"],
    ["agent:main:webchat:something", "user", undefined, "unknown"],
    ["", "cron", undefined, "unknown"],
    ["garbage", "cron", undefined, "unknown"],
  ])("%s (trigger %s, job %s) is %s", (sessionKey, trigger, jobId, expected) => {
    expect(classifySession({ sessionKey, trigger, jobId }).class).toBe(expected);
  });

  it("recognises incognito keys as OpenClaw does", () => {
    expect(isIncognitoSessionKey("agent:main:dashboard:incognito-abc")).toBe(true);
    expect(isIncognitoSessionKey("agent:main:subagent:incognito-x1")).toBe(true);
    expect(isIncognitoSessionKey("agent:main:main")).toBe(false);
  });
});

describe("agentrun reporter: capture plugin", () => {
  it("writes no prompt, tool input or tool output, and text only for an isolated cron session", () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r-dm", sessionKey: "agent:main:telegram:direct:424242" });
    driveTurn(handlers, { runId: "r-group", sessionKey: "agent:main:telegram:group:-1001", fail: true });
    driveTurn(handlers, { runId: "r-main", sessionKey: "agent:main:main" });
    driveTurn(handlers, { runId: "r-cron", sessionKey: "agent:main:cron:brief", trigger: "cron", jobId: "brief" });
    const spool = readSpool(rootDir);
    expect(spool).not.toContain(`prompt ${kMarker}`);
    expect(spool).not.toContain(`answer ${kMarker}-r-dm`);
    expect(spool).not.toContain(`answer ${kMarker}-r-group`);
    expect(spool).not.toContain(`answer ${kMarker}-r-main`);
    expect(spool).not.toContain(`boom ${kMarker}`);
    expect(spool.split(kMarker).length - 1).toBe(1);
    expect(spool).toContain(`answer ${kMarker}-r-cron`);
    const done = fs.readdirSync(path.join(rootDir, "agentrun-spool"), { recursive: true }).filter((name) => String(name).endsWith(".done"));
    expect(done).toHaveLength(4);
  });

  it("records nothing for an incognito session", () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r-inc", sessionKey: "agent:main:dashboard:incognito-abc" });
    expect(readSpool(rootDir)).toBe("");
  });

  it("opens a row for a turn that ends before its first model call, and reports a stopped run as cancelled", () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    handlers.agent_end({ runId: "r-early", success: false, error: "no model" }, { runId: "r-early", sessionKey: "agent:main:main" });
    handlers.model_call_started({ runId: "r-stop" }, { runId: "r-stop", sessionKey: "agent:main:main" });
    handlers.agent_end({ runId: "r-stop", success: false, durationMs: 5 }, { runId: "r-stop", sessionKey: "agent:main:main", trigger: "user" });
    const spool = readSpool(rootDir);
    expect(spool).toContain('"runId":"r-early"');
    expect(spool).toContain('"status":"cancelled","reason":"stopped"');
    expect(spool).not.toContain("no model");
    expect(Object.keys(handlers).sort()).toEqual(["after_tool_call", "agent_end", "gateway_start", "llm_output", "model_call_started"]);
  });

  it("decides a cron run's class from the first hook that carries its trigger", () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    const sessionKey = "agent:main:cron:brief";
    handlers.model_call_started({ runId: "r", sessionKey }, { runId: "r", sessionKey, agentId: "main" });
    handlers.llm_output({ runId: "r", assistantTexts: ["hi"] }, { runId: "r", sessionKey, trigger: "cron", jobId: "brief" });
    handlers.agent_end({ runId: "r", success: true }, { runId: "r", sessionKey, trigger: "cron", jobId: "brief" });
    const records = readSpool(rootDir).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.filter((record) => record.t === "open").map((record) => record.class)).toEqual(["unknown", "cron"]);
    expect(records.find((record) => record.t === "llm").text).toBe("hi");
  });

  it("never throws into OpenClaw and stays fast when the disk refuses writes", () => {
    const rootDir = makeRoot();
    const failing = { ...fs, appendFileSync: () => { throw new Error("EACCES"); }, mkdirSync: () => { throw new Error("EACCES"); }, renameSync: () => { throw new Error("EACCES"); } };
    const { handlers, lines } = registerPlugin(rootDir, { fsModule: failing });
    const started = performance.now();
    for (let index = 0; index < 50; index += 1) {
      expect(() => driveTurn(handlers, { runId: `r${index}`, sessionKey: "agent:main:main" })).not.toThrow();
    }
    expect((performance.now() - started) / 50).toBeLessThan(5);
    expect(Object.values(handlers).every((handler) => handler({}, {}) === undefined)).toBe(true);
    expect(lines.filter((line) => line.includes("capture_error hook=")).length).toBeLessThanOrEqual(10);
  });
});

describe("agentrun reporter: queue and sender", () => {
  it("sends metadata only for private classes and contents only for a listed cron job, exactly once", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r-dm", sessionKey: "agent:main:telegram:direct:424242" });
    driveTurn(handlers, { runId: "r-cron-listed", sessionKey: "agent:main:cron:brief", trigger: "cron", jobId: "brief" });
    driveTurn(handlers, { runId: "r-cron-other", sessionKey: "agent:main:cron:mail", trigger: "cron", jobId: "mail" });
    const fake = createFakeAgentrun();
    const { source, sender, outbox } = makePipeline(rootDir, {
      fake,
      contentCron: ["brief"],
      cronJobs: [
        { id: "brief", name: "Morning brief", payload: { kind: "agentTurn", message: "Summarize the news" } },
        { id: "mail", name: "Inbox digest", payload: { kind: "agentTurn", message: `read mail ${kMarker}` } },
      ],
    });
    expect(source.ingest().added).toBe(3);
    expect(await sender.sendDue()).toMatchObject({ sent: 3 });
    expect(await sender.sendDue()).toMatchObject({ sent: 0 });
    expect(fake.runs.size).toBe(3);
    const wire = fake.requests.map((request) => request.body).join("\n");
    expect(wire).toContain(`answer ${kMarker}-r-cron-listed`);
    expect(wire.split(kMarker).length - 1).toBe(2);
    expect(wire).not.toContain("424242");
    expect(wire).not.toContain("telegram:direct");
    expect(wire).not.toContain("Inbox digest");
    expect(wire).toContain("Summarize the news");
    expect(wire).toContain("Cron: Morning brief");
    expect([...fake.agents.keys()].sort()).toEqual(["openclaw-agent-main", "openclaw-cron-brief", "openclaw-cron-mail"]);
    expect([...fake.agents.values()].every((agent) => agent.definition.learning === false && agent.definition.max_cost_usd === undefined)).toBe(true);
    const runs = [...fake.runs.values()];
    expect(runs.every((run) => run.completion)).toBe(true);
    const listed = runs.find((run) => run.completion.answer.includes("r-cron-listed"));
    expect(listed.completion.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(runs.filter((run) => run.completion.answer === "")).toHaveLength(2);
    expect(outbox.counts()).toEqual({ sent: 3 });
  });

  it("keeps every turn while AgentRun is down for 30 hours and then reports each once", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    for (let index = 0; index < 5; index += 1) driveTurn(handlers, { runId: `r${index}`, sessionKey: "agent:main:main" });
    const fake = createFakeAgentrun();
    let clock = Date.now();
    const now = () => clock;
    const { source, sender } = makePipeline(rootDir, { fake, now });
    source.ingest();
    fake.state.down = true;
    for (let hour = 0; hour < 30; hour += 1) {
      clock += 60 * 60 * 1000;
      expect((await sender.sendDue()).sent).toBe(0);
    }
    fake.state.down = false;
    clock += 60 * 60 * 1000;
    expect((await sender.sendDue()).sent).toBe(5);
    expect(fake.runs.size).toBe(5);
  });

  it("resumes after a crash between steps without a second run", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main", tools: 3 });
    const fake = createFakeAgentrun();
    let clock = Date.now();
    const now = () => clock;
    const first = makePipeline(rootDir, { fake, now });
    first.source.ingest();
    // GET agent (404), POST agent, then the start's answer is lost.
    const lostStart = fake.fetchImpl;
    let calls = 0;
    const flaky = async (url, init) => {
      calls += 1;
      const answer = await lostStart(url, init);
      if (String(url).endsWith("/sdk-runs") && calls === 3) throw new TypeError("socket hang up");
      return answer;
    };
    const crashed = createSender({
      outbox: first.outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: flaky }),
      token: fake.token,
      getRuntime: () => "claude-agent-sdk",
      random: () => 0.5,
      now,
      logger: { warn: () => {} },
    });
    expect((await crashed.sendDue()).retry).toBe(1);
    expect(fake.runs.size).toBe(1);
    clock += 60 * 1000;
    const restarted = makePipeline(rootDir, { fake, now });
    expect((await restarted.sender.sendDue()).sent).toBe(1);
    expect(fake.runs.size).toBe(1);
    const [run] = fake.runs.values();
    expect(run.batches).toHaveLength(1);
    expect(run.completion.status).toBe("completed");
  });

  it("marks a run expired, never restarted, when AgentRun's hour has passed", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    let clock = Date.now();
    const now = () => clock;
    const fake = createFakeAgentrun({ now });
    const { source, sender, outbox, logs } = makePipeline(rootDir, { fake, now });
    source.ingest();
    const originalFetch = fake.fetchImpl;
    let started = false;
    fake.fetchImpl = async (url, init) => {
      const answer = await originalFetch(url, init);
      if (String(url).endsWith("/sdk-runs") && !started) {
        started = true;
        clock += 2 * 60 * 60 * 1000;
      }
      return answer;
    };
    const late = createSender({
      outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: fake.fetchImpl }),
      token: fake.token,
      getRuntime: () => "claude-agent-sdk",
      now,
      logger: { warn: (line) => logs.push(line) },
    });
    expect((await late.sendDue()).expired).toBe(1);
    expect(outbox.counts()).toEqual({ expired: 1 });
    expect(fake.runs.size).toBe(1);
    expect(logs.some((line) => line.includes("run_expired"))).toBe(true);
    expect((await sender.sendDue()).sent).toBe(0);
  });

  it("pauses on a rejected token and keeps the rows", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const fake = createFakeAgentrun();
    const { source, sender, outbox, logs } = makePipeline(rootDir, { fake, token: "w".repeat(40) });
    source.ingest();
    expect((await sender.sendDue()).paused).toBe(1);
    expect(outbox.counts()).toEqual({ queued: 1 });
    expect(logs.join("\n")).toContain("token_rejected");
    expect(logs.join("\n")).not.toContain("w".repeat(40));
  });

  it("pauses on a 403 and keeps the row", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const fake = createFakeAgentrun();
    const { source, sender, outbox } = makePipeline(rootDir, { fake });
    source.ingest();
    fake.state.failNext.push({ status: 403, body: { error: { code: "forbidden" } } });
    expect((await sender.sendDue()).paused).toBe(1);
    expect(outbox.counts()).toEqual({ queued: 1 });
  });

  it("keeps a spool file whose queue write fails and reads it again next tick", () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    let calls = 0;
    const outbox = {
      addTurn: () => {
        calls += 1;
        if (calls === 1) throw new Error("database is locked");
        return true;
      },
    };
    const source = createOpenclawSource({ rootDir, outbox, getContentCronJobs: () => new Set(), logger: { warn: () => {} } });
    expect(source.ingest().added).toBe(0);
    expect(readSpool(rootDir)).not.toBe("");
    expect(source.ingest().added).toBe(1);
    expect(readSpool(rootDir)).toBe("");
  });

  it("keeps a spool file it cannot read and reports the turn on a later tick", () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    let failing = true;
    const flaky = {
      ...fs,
      readFileSync: (file, ...rest) => {
        if (failing && String(file).endsWith(".done")) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
        return fs.readFileSync(file, ...rest);
      },
    };
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const logs = [];
    const source = createOpenclawSource({ rootDir, outbox, fsModule: flaky, logger: { warn: (line) => logs.push(line) } });
    expect(source.ingest().added).toBe(0);
    expect(readSpool(rootDir)).not.toBe("");
    expect(logs.join("\n")).toContain("kept for the next tick");
    failing = false;
    expect(source.ingest().added).toBe(1);
    expect(readSpool(rootDir)).toBe("");
    expect(outbox.counts()).toEqual({ queued: 1 });
  });

  it("drops a spool file only after it fails five ticks in a row", () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const logs = [];
    const broken = createOpenclawSource({
      rootDir,
      outbox,
      fsModule: {
        ...fs,
        readFileSync: (file, ...rest) => {
          if (String(file).endsWith(".done")) throw new Error("bad file");
          return fs.readFileSync(file, ...rest);
        },
      },
      logger: { warn: (line) => logs.push(line) },
    });
    for (let tick = 1; tick < 5; tick += 1) {
      expect(broken.ingest().added).toBe(0);
      expect(readSpool(rootDir)).not.toBe("");
    }
    expect(broken.ingest().added).toBe(0);
    expect(readSpool(rootDir)).toBe("");
    expect(logs.filter((line) => line.includes("kept for the next tick"))).toHaveLength(4);
    expect(logs.some((line) => line.includes("dropped after 5 tries"))).toBe(true);
  });

  it("reports a model-fallback run as its first attempt, once, even when a file is read twice", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    const sessionKey = "agent:main:cron:brief";
    const ctx = { runId: "r1", sessionKey, trigger: "cron", jobId: "brief" };
    handlers.llm_output({ runId: "r1", assistantTexts: ["first"], usage: { input: 10, output: 1 } }, ctx);
    handlers.agent_end({ runId: "r1", success: false, error: "overloaded" }, ctx);
    handlers.llm_output({ runId: "r1", assistantTexts: ["second"], usage: { input: 20, output: 2 } }, ctx);
    handlers.after_tool_call({ toolName: "read", runId: "r1", durationMs: 1 }, ctx);
    handlers.agent_end({ runId: "r1", success: true }, ctx);
    const fake = createFakeAgentrun();
    const spoolFiles = fs
      .readdirSync(path.join(rootDir, "agentrun-spool"), { recursive: true })
      .map((name) => path.join(rootDir, "agentrun-spool", String(name)))
      .filter((file) => fs.statSync(file).isFile());
    const copies = spoolFiles.map((file) => [file, fs.readFileSync(file)]);
    const logs = [];
    const { outbox, sender } = makePipeline(rootDir, { fake, contentCron: ["brief"] });
    const source = createOpenclawSource({ rootDir, outbox, getContentCronJobs: () => new Set(["brief"]), logger: { warn: (line) => logs.push(line) } });
    expect(source.ingest().added).toBe(1);
    for (const [file, bytes] of copies) fs.writeFileSync(file, bytes);
    expect(source.ingest().added).toBe(0);
    expect(outbox.counts()).toEqual({ queued: 1 });
    expect(logs.filter((line) => line.includes("late_attempt"))).toHaveLength(3);
    expect((await sender.sendDue()).sent).toBe(1);
    const [run] = fake.runs.values();
    expect(run.completion.status).toBe("failed");
    expect(run.completion.usage).toMatchObject({ input_tokens: 10, output_tokens: 1 });
  });

  it("switches an agent's runtime and rebuilds a queued body built for the old one", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const fake = createFakeAgentrun();
    const pipeline = makePipeline(rootDir, { fake });
    pipeline.source.ingest();
    expect((await pipeline.sender.sendDue()).sent).toBe(1);
    driveTurn(handlers, { runId: "r2", sessionKey: "agent:main:main" });
    pipeline.source.ingest();
    // r2's body is stored with the old runtime, then the start fails once.
    fake.state.failNext.push({ status: 503, body: { error: { code: "unavailable" } } });
    expect((await pipeline.sender.sendDue()).retry).toBe(1);
    pipeline.settings.runtime = "openclaw";
    const later = makePipeline(rootDir, { fake, runtime: "openclaw", now: () => Date.now() + 3600 * 1000 });
    expect((await later.sender.sendDue()).sent).toBe(1);
    expect(fake.agents.get("openclaw-agent-main").definition.sdk.runtime).toBe("openclaw");
    expect([...fake.runs.values()].map((run) => run.start.runtime).sort()).toEqual(["claude-agent-sdk", "openclaw"]);
  });

  it("turns files left by an earlier gateway process into cancelled runs", async () => {
    const rootDir = makeRoot();
    let generation = 1000;
    const first = registerPlugin(rootDir, { generationId: () => String(generation) });
    first.handlers.model_call_started({ runId: "r-cut" }, { runId: "r-cut", sessionKey: "agent:main:main" });
    generation = 2000;
    const second = registerPlugin(rootDir, { generationId: () => String(generation) });
    second.handlers.gateway_start({ port: 1 }, {});
    const fake = createFakeAgentrun();
    const { source, sender } = makePipeline(rootDir, { fake });
    expect(source.ingest().added).toBe(1);
    await sender.sendDue();
    const [run] = fake.runs.values();
    expect(run.completion).toMatchObject({ status: "cancelled", evidence_complete: false });
    expect(run.completion.error).toContain("interrupted by gateway restart");
  });

  it("splits events into batches AgentRun accepts and keeps tool ids unique", () => {
    const tools = Array.from({ length: 180 }, (_, index) => ({ name: `t${index}`, ok: index % 7 !== 0 }));
    const batches = eventBatches({ rowId: "openclaw-1", sessionLabel: "openclaw:main:abc", texts: ["x".repeat(40000)], tools });
    expect(batches.every((batch) => batch.events.length <= 100)).toBe(true);
    expect(batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) <= 256 * 1024)).toBe(true);
    expect(batches.map((batch) => batch.sequence)).toEqual(batches.map((_, index) => index + 1));
    const starts = batches.flatMap((batch) => batch.events).filter((event) => event.type === "tool" && event.status === "started");
    expect(new Set(starts.map((event) => event.id)).size).toBe(180);
    const text = batches.flatMap((batch) => batch.events).find((event) => event.type === "text");
    expect(text.text.length).toBeLessThanOrEqual(16000);
  });
});

describe("agentrun reporter: settings and plugin entry", () => {
  it("is off without ALPHACLAW_AGENTRUN_URL and never runs", async () => {
    const rootDir = makeRoot();
    const reporter = createAgentrunReporter({ env: {}, rootDir });
    expect(reporter.start()).toBe(false);
    expect(await reporter.tick()).toBe(null);
    expect(fs.existsSync(path.join(rootDir, "db"))).toBe(false);
  });

  it("captures but does not send until the token is set", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const lines = [];
    const reporter = createAgentrunReporter({ env: { ALPHACLAW_AGENTRUN_URL: kBase }, rootDir, logger: { warn: (line) => lines.push(line), log: () => {} } });
    const result = await reporter.tick();
    expect(result.ingested.added).toBe(1);
    expect(result.sent).toBe(null);
    expect(lines.join("\n")).toContain("token_missing");
    reporter.stop();
  });

  it("reads its settings", () => {
    const settings = resolveAgentrunReporterConfig({
      ALPHACLAW_AGENTRUN_URL: "http://127.0.0.1:7340/v2/",
      ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN: "x".repeat(40),
      ALPHACLAW_AGENTRUN_RUNTIME: "openclaw",
      ALPHACLAW_AGENTRUN_CONTENT_CRON: "brief, digest",
    });
    expect(settings).toMatchObject({ enabled: true, url: "http://127.0.0.1:7340/v2", runtime: "openclaw" });
    expect([...settings.contentCronJobs]).toEqual(["brief", "digest"]);
    expect(resolveAgentrunReporterConfig({ ALPHACLAW_AGENTRUN_URL: "x", ALPHACLAW_AGENTRUN_RUNTIME: "Bad Runtime!" })).toMatchObject({ enabled: false, runtime: "claude-agent-sdk", runtimeValid: false });
  });

  it("adds its plugin entry when on and removes only its own entry when off", () => {
    const cfg = {};
    expect(applyAgentrunReporterEntry(cfg, { enabled: true, rootDir: "/data", log: () => {} }).changed).toBe(true);
    expect(cfg.plugins.allow).toContain("agentrun-reporter");
    expect(cfg.plugins.load.paths).toContain(kAgentrunReporterPluginPath);
    expect(cfg.plugins.entries["agentrun-reporter"]).toMatchObject({ enabled: true, hooks: { allowConversationAccess: true }, config: { rootDir: "/data" } });
    expect(applyAgentrunReporterEntry(cfg, { enabled: true, rootDir: "/data", log: () => {} }).changed).toBe(false);
    expect(applyAgentrunReporterEntry(cfg, { enabled: false, log: () => {} }).changed).toBe(true);
    expect(cfg.plugins.entries["agentrun-reporter"]).toBeUndefined();
    expect(cfg.plugins.allow).not.toContain("agentrun-reporter");
    const foreign = { plugins: { entries: { "agentrun-reporter": { enabled: true } } } };
    expect(applyAgentrunReporterEntry(foreign, { enabled: false, log: () => {} }).changed).toBe(false);
    expect(foreign.plugins.entries["agentrun-reporter"]).toEqual({ enabled: true });
  });

  it("keeps its settings deployment-only and out of the gateway's env", () => {
    for (const key of ["ALPHACLAW_AGENTRUN_URL", "ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN", "ALPHACLAW_AGENTRUN_RUNTIME", "ALPHACLAW_AGENTRUN_CONTENT_CRON"]) {
      expect(kDeploymentOnlyEnvKeys).toContain(key);
      expect(admitsGatewayEnvKey(key)).toBe(false);
    }
    expect(kDeploymentSecretEnvKeys).toContain("ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN");
  });
});

describe("agentrun reporter: gateway start and refused agents", () => {
  it("keeps a turn that is running when gateway_start fires as one completed run", async () => {
    const rootDir = makeRoot();
    let generation = 1000;
    const { handlers } = registerPlugin(rootDir, { generationId: () => String((generation += 1)) });
    const ctx = { runId: "r1", sessionKey: "agent:main:main", trigger: "user", agentId: "main" };
    handlers.model_call_started({ runId: "r1" }, ctx);
    handlers.gateway_start({ port: 1 }, {});
    handlers.llm_output({ runId: "r1", model: "claude", assistantTexts: ["hi"], usage: { input: 7, output: 3 } }, ctx);
    handlers.agent_end({ runId: "r1", success: true, durationMs: 50 }, ctx);
    const fake = createFakeAgentrun();
    const { outbox, sender } = makePipeline(rootDir, { fake });
    const logs = [];
    const source = createOpenclawSource({ rootDir, outbox, logger: { warn: (line) => logs.push(line) } });
    expect(source.ingest().added).toBe(1);
    expect(logs).toEqual([]);
    expect((await sender.sendDue()).sent).toBe(1);
    const [run] = fake.runs.values();
    expect(run.completion.status).toBe("completed");
    expect(run.completion.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
  });

  it("drops an agent's turns when AgentRun refuses the agent, with one log line per hour", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    driveTurn(handlers, { runId: "r2", sessionKey: "agent:main:main" });
    let clock = Date.now();
    const now = () => clock;
    const fake = createFakeAgentrun();
    const refusing = async (url, init) => {
      if (String(url).endsWith("/agents") && init.method === "POST") {
        return new Response(JSON.stringify({ error: { code: "input_invalid", message: "bad definition" } }), { status: 422 });
      }
      return fake.fetchImpl(url, init);
    };
    const { source, outbox, logs } = makePipeline(rootDir, { fake, now });
    source.ingest();
    const sender = createSender({
      outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: refusing }),
      token: fake.token,
      getRuntime: () => "claude-agent-sdk",
      now,
      logger: { warn: (line) => logs.push(line) },
    });
    expect(await sender.sendDue()).toMatchObject({ dropped: 2, retry: 0 });
    expect(outbox.counts()).toEqual({ dropped: 2 });
    expect(logs.filter((line) => line.includes("agent_refused"))).toHaveLength(1);
    expect(logs[0]).toContain("agent=openclaw-agent-main code=input_invalid count=1");
    expect(await sender.sendDue()).toMatchObject({ dropped: 0, retry: 0 });
    driveTurn(handlers, { runId: "r3", sessionKey: "agent:main:main" });
    source.ingest();
    clock += 61 * 60 * 1000;
    expect((await sender.sendDue()).dropped).toBe(1);
    expect(logs.filter((line) => line.includes("agent_refused"))).toHaveLength(2);
    expect(logs[logs.length - 1]).toContain("count=2");
  });

  it("drops a turn whose start AgentRun refuses for its runtime twice", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const fake = createFakeAgentrun();
    const refusing = async (url, init) => {
      if (String(url).endsWith("/sdk-runs") && init.method === "POST") {
        return new Response(JSON.stringify({ error: { code: "input_invalid", message: "The SDK runtime must match the registered agent." } }), { status: 422 });
      }
      return fake.fetchImpl(url, init);
    };
    const { source, outbox, logs } = makePipeline(rootDir, { fake });
    source.ingest();
    const sender = createSender({
      outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: refusing }),
      token: fake.token,
      getRuntime: () => "claude-agent-sdk",
      logger: { warn: (line) => logs.push(line) },
    });
    expect((await sender.sendDue()).dropped).toBe(1);
    expect(logs.join("\n")).toContain("agent_refused op=start_runtime");
    expect(fake.runs.size).toBe(0);
  });

  it("retries an agent edit that lost an If-Match race instead of dropping it", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const fake = createFakeAgentrun();
    const first = makePipeline(rootDir, { fake });
    first.source.ingest();
    expect((await first.sender.sendDue()).sent).toBe(1);
    driveTurn(handlers, { runId: "r2", sessionKey: "agent:main:main" });
    first.source.ingest();
    const racing = async (url, init) => {
      if (String(url).endsWith("/definition") && init.method === "PUT") {
        return new Response(JSON.stringify({ error: { code: "precondition_failed", message: "moved" } }), { status: 412 });
      }
      return fake.fetchImpl(url, init);
    };
    const sender = createSender({
      outbox: first.outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: racing }),
      token: fake.token,
      getRuntime: () => "openclaw",
      logger: { warn: () => {} },
    });
    expect(await sender.sendDue()).toMatchObject({ retry: 1, dropped: 0 });
    expect(first.outbox.counts()).toEqual({ sent: 1, queued: 1 });
  });
});

describe("agentrun reporter: revoked content, live directories and unreadable spool", () => {
  it("drops a queued contents turn whose job left the allowlist, sending none of its text", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r-cron", sessionKey: "agent:main:cron:brief", trigger: "cron", jobId: "brief" });
    const fake = createFakeAgentrun();
    const queued = makePipeline(rootDir, { fake, contentCron: ["brief"], cronJobs: [{ id: "brief", name: "Brief", payload: { message: "Summarize" } }] });
    expect(queued.source.ingest().added).toBe(1);
    queued.outbox.close();
    const revoked = makePipeline(rootDir, { fake, contentCron: [] });
    expect((await revoked.sender.sendDue()).dropped).toBe(1);
    expect(revoked.outbox.counts()).toEqual({ dropped: 1 });
    expect(revoked.logs.join("\n")).toContain("content_revoked op=send source=openclaw agent=openclaw-cron-brief");
    expect(fake.requests.map((request) => request.body).join("\n")).not.toContain(kMarker);
    expect(fake.runs.size).toBe(0);
  });

  it("reads a dead gateway's open files as interrupted and leaves a live one's alone, whatever the clock says", () => {
    const rootDir = makeRoot();
    const livePid = 4242;
    const deadPid = 999999;
    const dead = registerPlugin(rootDir, { generationId: () => `2000000000000-${deadPid}` });
    dead.handlers.model_call_started({ runId: "r-dead" }, { runId: "r-dead", sessionKey: "agent:main:main" });
    const live = registerPlugin(rootDir, { generationId: () => `1000000000000-${livePid}` });
    live.handlers.model_call_started({ runId: "r-live" }, { runId: "r-live", sessionKey: "agent:main:main" });
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const source = createOpenclawSource({ rootDir, outbox, isProcessAlive: (pid) => pid === livePid, logger: { warn: () => {} } });
    expect(source.ingest().added).toBe(1);
    expect(outbox.db.prepare("SELECT source_run_id, status FROM turns").all()).toEqual([{ source_run_id: "r-dead", status: "cancelled" }]);
    expect(fs.existsSync(path.join(rootDir, "agentrun-spool", `2000000000000-${deadPid}`))).toBe(false);
    live.handlers.agent_end({ runId: "r-live", success: true }, { runId: "r-live", sessionKey: "agent:main:main" });
    expect(source.ingest().added).toBe(1);
    expect(outbox.db.prepare("SELECT status FROM turns WHERE source_run_id = 'r-live'").get()).toEqual({ status: "completed" });
  });

  it.runIf(process.platform === "linux")("reads an earlier gateway's open files as interrupted when a later process reuses its pid", () => {
    const rootDir = makeRoot();
    registerPlugin(rootDir).handlers.gateway_start({}, {});
    const [ownName] = fs.readdirSync(path.join(rootDir, "agentrun-spool"));
    fs.rmSync(path.join(rootDir, "agentrun-spool", ownName), { recursive: true });
    const [, pid, ticks] = ownName.split("-");
    expect(Number(pid)).toBe(process.pid);
    expect(ticks).toMatch(/^\d+$/);
    const earlier = registerPlugin(rootDir, { generationId: () => `1000000000000-${process.pid}-${Number(ticks) + 1}` });
    earlier.handlers.model_call_started({ runId: "r-earlier" }, { runId: "r-earlier", sessionKey: "agent:main:main" });
    const current = registerPlugin(rootDir, { generationId: () => `2000000000000-${process.pid}-${ticks}` });
    current.handlers.model_call_started({ runId: "r-current" }, { runId: "r-current", sessionKey: "agent:main:main" });
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const source = createOpenclawSource({ rootDir, outbox, logger: { warn: () => {} } });
    expect(source.ingest().added).toBe(1);
    expect(outbox.db.prepare("SELECT source_run_id, status FROM turns").all()).toEqual([{ source_run_id: "r-earlier", status: "cancelled" }]);
    expect(fs.existsSync(path.join(rootDir, "agentrun-spool", `2000000000000-${process.pid}-${ticks}`))).toBe(true);
  });

  it("skips a spool directory it cannot read, logs it once an hour, and keeps reading the others", () => {
    const rootDir = makeRoot();
    const bad = registerPlugin(rootDir, { generationId: () => "1000-1" });
    driveTurn(bad.handlers, { runId: "r-bad", sessionKey: "agent:main:main" });
    const good = registerPlugin(rootDir, { generationId: () => "2000-2" });
    driveTurn(good.handlers, { runId: "r-good", sessionKey: "agent:main:main" });
    let clock = Date.now();
    const logs = [];
    const flaky = {
      ...fs,
      readdirSync: (dir, ...rest) => {
        if (String(dir).endsWith("1000-1")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return fs.readdirSync(dir, ...rest);
      },
    };
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const source = createOpenclawSource({ rootDir, outbox, fsModule: flaky, now: () => clock, isProcessAlive: () => true, logger: { warn: (line) => logs.push(line) } });
    expect(source.ingest().added).toBe(1);
    expect(source.ingest().added).toBe(0);
    expect(logs.filter((line) => line.includes("dir=1000-1 EACCES"))).toHaveLength(1);
    clock += 61 * 60 * 1000;
    source.ingest();
    expect(logs.filter((line) => line.includes("dir=1000-1 EACCES"))).toHaveLength(2);
  });

  it("keeps sending when the spool cannot be read at all", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const fake = createFakeAgentrun();
    const first = makePipeline(rootDir, { fake });
    expect(first.source.ingest().added).toBe(1);
    first.outbox.close();
    fs.rmSync(path.join(rootDir, "agentrun-spool"), { recursive: true, force: true });
    fs.writeFileSync(path.join(rootDir, "agentrun-spool"), "not a directory");
    const lines = [];
    const reporter = createAgentrunReporter({
      env: { ALPHACLAW_AGENTRUN_URL: kBase, ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN: fake.token },
      rootDir,
      fetchImpl: fake.fetchImpl,
      logger: { warn: (line) => lines.push(line), log: () => {} },
    });
    const result = await reporter.tick();
    expect(result.sent.sent).toBe(1);
    expect(lines.join("\n")).toContain("capture_error op=ingest dir=agentrun-spool ENOTDIR");
    reporter.stop();
  });

  it("cuts to the budget even when it is shorter than the cut marker", () => {
    expect(cut("abcdefghij", 3)).toBe("abc");
    expect(cut("abcdefghij", 0)).toBe("");
    expect(cut("abcdefghij", 8)).toBe("ab [cut]");
    expect(cut("abc", 3)).toBe("abc");
  });
});

describe("agentrun reporter: an agent another writer just created", () => {
  const agentExists = () => new Response(JSON.stringify({ error: { code: "agent_exists", message: "exists" } }), { status: 409 });

  it("reads the agent again after agent_exists and sends the turn on the next pass", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    let clock = Date.now();
    const now = () => clock;
    const fake = createFakeAgentrun();
    let raced = false;
    const racing = async (url, init) => {
      if (String(url).endsWith("/agents") && init.method === "POST" && !raced) {
        raced = true;
        await fake.fetchImpl(url, init);
        return agentExists();
      }
      return fake.fetchImpl(url, init);
    };
    const { source, outbox, logs } = makePipeline(rootDir, { fake, now });
    source.ingest();
    const sender = createSender({
      outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: racing }),
      token: fake.token,
      getRuntime: () => "claude-agent-sdk",
      random: () => 0.5,
      now,
      logger: { warn: (line) => logs.push(line) },
    });
    expect(await sender.sendDue()).toMatchObject({ retry: 1, dropped: 0 });
    clock += 60 * 1000;
    expect((await sender.sendDue()).sent).toBe(1);
    expect(logs.join("\n")).not.toContain("agent_refused");
  });

  it("drops the turn when agent_exists comes back but the agent still cannot be read", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    const fake = createFakeAgentrun();
    const held = async (url, init) => (String(url).endsWith("/agents") && init.method === "POST" ? agentExists() : fake.fetchImpl(url, init));
    const { source, outbox, logs } = makePipeline(rootDir, { fake });
    source.ingest();
    const sender = createSender({
      outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: held }),
      token: fake.token,
      getRuntime: () => "claude-agent-sdk",
      logger: { warn: (line) => logs.push(line) },
    });
    expect((await sender.sendDue()).dropped).toBe(1);
    expect(logs.join("\n")).toContain("agent_refused op=agent_create source=openclaw agent=openclaw-agent-main code=agent_exists");
  });
});

describe("agentrun reporter: answers from something other than AgentRun", () => {
  it.each([
    [408, "text/plain", "Request Timeout"],
    [405, "text/html", "<html>Method Not Allowed</html>"],
    [400, "text/plain", "Bad Request"],
    [404, "text/html", "<html>Not Found</html>"],
  ])("keeps the turn queued on a %s without an AgentRun error code", async (status, type, text) => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    let clock = Date.now();
    const now = () => clock;
    const fake = createFakeAgentrun();
    let proxyFails = true;
    const proxy = async (url, init) => (proxyFails ? new Response(text, { status, headers: { "content-type": type } }) : fake.fetchImpl(url, init));
    const { source, outbox, logs } = makePipeline(rootDir, { fake, now });
    source.ingest();
    const sender = createSender({
      outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: proxy }),
      token: fake.token,
      getRuntime: () => "claude-agent-sdk",
      random: () => 0.5,
      now,
      logger: { warn: (line) => logs.push(line) },
    });
    expect(await sender.sendDue()).toMatchObject({ retry: 1, dropped: 0 });
    expect(outbox.counts()).toEqual({ queued: 1 });
    proxyFails = false;
    clock += 60 * 1000;
    expect((await sender.sendDue()).sent).toBe(1);
    expect(logs.join("\n")).not.toContain("agent_refused");
  });

  it("keeps a started turn queued when a proxy answers its events with a 404", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    driveTurn(handlers, { runId: "r1", sessionKey: "agent:main:main" });
    let clock = Date.now();
    const now = () => clock;
    const fake = createFakeAgentrun();
    let proxyFails = true;
    const proxy = async (url, init) =>
      proxyFails && String(url).endsWith("/events") ? new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } }) : fake.fetchImpl(url, init);
    const { source, outbox, logs } = makePipeline(rootDir, { fake, now });
    source.ingest();
    const sender = createSender({
      outbox,
      client: createAgentrunClient({ baseUrl: kBase, fetchImpl: proxy }),
      token: fake.token,
      getRuntime: () => "claude-agent-sdk",
      random: () => 0.5,
      now,
      logger: { warn: (line) => logs.push(line) },
    });
    expect(await sender.sendDue()).toMatchObject({ retry: 1, dropped: 0 });
    expect(outbox.counts()).toEqual({ queued: 1 });
    proxyFails = false;
    clock += 60 * 1000;
    expect((await sender.sendDue()).sent).toBe(1);
    expect(logs.join("\n")).not.toContain("row_dropped");
  });
});
