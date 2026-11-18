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
const registerPlugin = (rootDir, { fsModule, generationId, now } = {}) => {
  const handlers = {};
  const lines = [];
  const plugin = reporterPlugin.createAgentrunReporterPlugin({ ...(fsModule ? { fsModule } : {}), ...(generationId ? { generationId } : {}), ...(now ? { now } : {}) });
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

const makePipeline = (rootDir, { fake, contentCron = [], hiddenCron = [], cronJobs = [], token, runtime = "claude-agent-sdk", now } = {}) => {
  const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db"), ...(now ? { now } : {}) });
  const source = createOpenclawSource({
    rootDir,
    outbox,
    getContentCronJobs: () => new Set(contentCron),
    getHiddenCronNames: () => new Set(hiddenCron),
    readCronJobs: () => cronJobs,
    logger: { warn: () => {} },
    ...(now ? { now } : {}),
  });
  const logs = [];
  const settings = { runtime };
  const sender = createSender({
    outbox,
    client: createAgentrunClient({ baseUrl: kBase, fetchImpl: fake.fetchImpl }),
    token: token ?? fake.token,
    getRuntime: () => settings.runtime,
    contentAllowed: (row) => contentStillAllowed(row, new Set(contentCron)),
    agentNameOf: (row) => source.agentNameOf(row, cronJobs),
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
    expect(Object.keys(handlers).sort()).toEqual(["after_tool_call", "agent_end", "cron_changed", "gateway_start", "llm_output", "model_call_ended", "model_call_started", "subagent_spawned"]);
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
    expect(wire).toContain("Cron: Inbox digest");
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
      rowOf: () => null,
      openRows: () => [],
      countLive: () => 0,
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
    // OpenClaw 2026.11.4's order: each attempt opens with model_call_started
    // and fires its llm_output after its agent_end.
    handlers.model_call_started({ runId: "r1" }, { runId: "r1", sessionKey });
    handlers.agent_end({ runId: "r1", success: false, error: "overloaded" }, ctx);
    handlers.llm_output({ runId: "r1", assistantTexts: ["first"], usage: { input: 10, output: 1 } }, ctx);
    handlers.model_call_started({ runId: "r1" }, { runId: "r1", sessionKey });
    handlers.after_tool_call({ toolName: "read", runId: "r1", durationMs: 1 }, ctx);
    handlers.agent_end({ runId: "r1", success: true }, ctx);
    handlers.llm_output({ runId: "r1", assistantTexts: ["second"], usage: { input: 20, output: 2 } }, ctx);
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
    for (const key of ["ALPHACLAW_AGENTRUN_URL", "ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN", "ALPHACLAW_AGENTRUN_RUNTIME", "ALPHACLAW_AGENTRUN_CONTENT_CRON", "ALPHACLAW_AGENTRUN_LIVE"]) {
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

  it("keeps a turn's model and usage when OpenClaw sends llm_output after agent_end", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    const ctx = { runId: "r-late", sessionKey: "agent:main:telegram:group:-100:topic:7", trigger: "user", agentId: "main", channel: "telegram" };
    handlers.model_call_started({ runId: "r-late" }, { runId: "r-late", sessionKey: ctx.sessionKey, agentId: "main" });
    handlers.model_call_ended({ runId: "r-late", provider: "anthropic", model: "claude-opus-5-5", durationMs: 900, outcome: "completed" }, ctx);
    handlers.after_tool_call({ toolName: "message", runId: "r-late", durationMs: 3 }, ctx);
    handlers.agent_end({ runId: "r-late", success: true, durationMs: 24500 }, ctx);
    handlers.llm_output({ runId: "r-late", provider: "anthropic", model: "claude-opus-5-5", resolvedRef: "anthropic/claude-opus-5-5", usage: { input: 300, output: 12 } }, ctx);
    handlers.llm_output({ runId: "r-late", usage: { input: 1, output: 1 } }, ctx);
    handlers.after_tool_call({ toolName: "late", runId: "r-late", durationMs: 1 }, ctx);
    const fake = createFakeAgentrun();
    const { source, sender } = makePipeline(rootDir, { fake });
    expect(source.ingest().added).toBe(1);
    expect(readSpool(rootDir)).toBe("");
    expect((await sender.sendDue()).sent).toBe(1);
    const [run] = fake.runs.values();
    expect(run.start.model).toBe("anthropic/claude-opus-5-5");
    expect(run.completion.usage).toMatchObject({ input_tokens: 300, output_tokens: 12 });
    expect(run.start.input.replace(/\s+/g, " ").slice(0, 80)).toMatch(/^Telegram group \(main\) · 24\.5s · completed — 1 tool call; started 2026-/);
  });

  it("reports an ended turn that never gets its llm_output once it has settled, naming the model from model_call_ended", async () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    const ctx = { runId: "r-quiet", sessionKey: "agent:main:main", trigger: "user", agentId: "main" };
    handlers.model_call_started({ runId: "r-quiet" }, { runId: "r-quiet", sessionKey: ctx.sessionKey });
    handlers.model_call_ended({ runId: "r-quiet", provider: "openai", model: "gpt-6.1-sol", durationMs: 5, outcome: "error" }, ctx);
    handlers.agent_end({ runId: "r-quiet", success: false, error: "refused", durationMs: 40 }, ctx);
    let clock = Date.now();
    const fake = createFakeAgentrun();
    const { outbox, sender } = makePipeline(rootDir, { fake });
    const source = createOpenclawSource({ rootDir, outbox, logger: { warn: () => {} }, now: () => clock });
    expect(source.ingest().added).toBe(0);
    clock += 31_000;
    expect(source.ingest().added).toBe(1);
    expect((await sender.sendDue()).sent).toBe(1);
    const [run] = fake.runs.values();
    expect(run.start.model).toBe("openai/gpt-6.1-sol");
    expect(run.completion.status).toBe("failed");
    expect(run.start.input).toMatch(/^Main session \(main\) · 0\.?\d*s · failed — 0 tool calls; started /);
  });

  it("reports a turn whose agent_end OpenClaw dropped from its last llm_output, and leaves a running turn alone", () => {
    const rootDir = makeRoot();
    const { handlers } = registerPlugin(rootDir);
    const turn = (runId, stopReason) => {
      const ctx = { runId, sessionKey: "agent:main:main", trigger: "user", agentId: "main" };
      handlers.model_call_started({ runId }, { runId, sessionKey: ctx.sessionKey });
      handlers.after_tool_call({ toolName: "read", runId, durationMs: 2 }, ctx);
      handlers.llm_output({ runId, provider: "anthropic", model: "claude", usage: { input: 7, output: 3 }, lastAssistant: { stopReason, content: kMarker } }, ctx);
    };
    turn("r-ok", "stop");
    turn("r-err", "error");
    turn("r-abort", "aborted");
    handlers.model_call_started({ runId: "r-running" }, { runId: "r-running", sessionKey: "agent:main:main" });
    handlers.after_tool_call({ toolName: "exec", runId: "r-running", durationMs: 2 }, { runId: "r-running", sessionKey: "agent:main:main", trigger: "user" });
    let clock = Date.now();
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const source = createOpenclawSource({ rootDir, outbox, logger: { warn: () => {} }, now: () => clock });
    expect(source.ingest().added).toBe(0);
    clock += 31_000;
    expect(source.ingest().added).toBe(3);
    const rows = outbox.db.prepare("SELECT source_run_id, status, error_text, usage_json, evidence_complete FROM turns ORDER BY source_run_id").all();
    expect(rows.map((row) => [row.source_run_id, row.status])).toEqual([
      ["r-abort", "cancelled"],
      ["r-err", "failed"],
      ["r-ok", "completed"],
    ]);
    expect(rows.find((row) => row.source_run_id === "r-ok").error_text).toBe("end not recorded");
    expect(JSON.parse(rows[0].usage_json)).toMatchObject({ input_tokens: 7, output_tokens: 3 });
    expect(rows.every((row) => row.evidence_complete === 0)).toBe(true);
    expect(readSpool(rootDir)).not.toContain(kMarker);
    expect(readSpool(rootDir)).toContain('"runId":"r-running"');
  });

  it("starts no file without an open record for a hook that comes after the server read a settled turn", () => {
    const rootDir = makeRoot();
    let clock = Date.now();
    const { handlers, lines } = registerPlugin(rootDir, { now: () => clock });
    const ctx = { runId: "r-gone", sessionKey: "agent:main:main", trigger: "user", agentId: "main" };
    handlers.model_call_started({ runId: "r-gone" }, { runId: "r-gone", sessionKey: ctx.sessionKey });
    handlers.agent_end({ runId: "r-gone", success: true, durationMs: 40 }, ctx);
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const source = createOpenclawSource({ rootDir, outbox, logger: { warn: () => {} }, now: () => clock });
    clock += 31_000;
    expect(source.ingest().added).toBe(1);
    handlers.llm_output({ runId: "r-gone", provider: "anthropic", model: "claude", usage: { input: 7, output: 3 } }, ctx);
    handlers.after_tool_call({ toolName: "late", runId: "r-gone", durationMs: 1 }, ctx);
    handlers.agent_end({ runId: "r-gone", success: true, durationMs: 41 }, ctx);
    expect(readSpool(rootDir)).toBe("");
    expect(lines.filter((line) => line.includes("capture_error"))).toEqual([]);
  });

  it("forgets an ended run that waited past its time for llm_output and ignores that llm_output", () => {
    const rootDir = makeRoot();
    let clock = Date.now();
    const { handlers } = registerPlugin(rootDir, { now: () => clock });
    const ctx = { runId: "r-old", sessionKey: "agent:main:main", trigger: "user", agentId: "main" };
    handlers.model_call_started({ runId: "r-old" }, { runId: "r-old", sessionKey: ctx.sessionKey });
    handlers.agent_end({ runId: "r-old", success: true, durationMs: 40 }, ctx);
    clock += 61_000;
    handlers.model_call_started({ runId: "r-new" }, { runId: "r-new", sessionKey: ctx.sessionKey });
    handlers.llm_output({ runId: "r-old", provider: "anthropic", model: "claude", usage: { input: 7, output: 3 } }, ctx);
    const records = readSpool(rootDir).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(records.filter((record) => record.t === "llm")).toEqual([]);
    expect([...new Set(records.filter((record) => record.t === "open").map((record) => record.runId))].sort()).toEqual(["r-new", "r-old"]);
  });

  it("keeps a run open across a revision pass that sends llm_output without agent_end", () => {
    const rootDir = makeRoot();
    let clock = Date.now();
    const { handlers } = registerPlugin(rootDir, { now: () => clock });
    const ctx = { runId: "r-revise", sessionKey: "agent:main:main", trigger: "user", agentId: "main" };
    handlers.model_call_started({ runId: "r-revise" }, { runId: "r-revise", sessionKey: ctx.sessionKey });
    handlers.llm_output({ runId: "r-revise", provider: "anthropic", model: "claude", usage: { input: 7, output: 3 }, lastAssistant: { stopReason: "stop" } }, ctx);
    handlers.model_call_started({ runId: "r-revise" }, { runId: "r-revise", sessionKey: ctx.sessionKey });
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const source = createOpenclawSource({ rootDir, outbox, logger: { warn: () => {} }, now: () => clock });
    clock += 31_000;
    expect(source.ingest().added).toBe(0);
    handlers.agent_end({ runId: "r-revise", success: true, durationMs: 31_500 }, ctx);
    handlers.llm_output({ runId: "r-revise", provider: "anthropic", model: "claude", usage: { input: 5, output: 2 }, lastAssistant: { stopReason: "stop" } }, ctx);
    expect(source.ingest().added).toBe(1);
    const [row] = outbox.db.prepare("SELECT status, error_text, usage_json, evidence_complete FROM turns").all();
    expect(row).toMatchObject({ status: "completed", error_text: "" });
    expect(JSON.parse(row.usage_json)).toMatchObject({ input_tokens: 12, output_tokens: 5 });
  });

  it("titles every class within AgentRun's 80 characters", () => {
    const rootDir = makeRoot();
    const outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db") });
    const source = createOpenclawSource({ rootDir, outbox, logger: { warn: () => {} }, readCronJobs: () => [{ id: "brief", name: "Morning brief" }], getContentCronJobs: () => new Set(["brief"]) });
    const cases = [
      ["agent:main:telegram:direct:42", "user", "", "Telegram DM (main) · 1.2s · completed"],
      ["agent:main:discord:channel:9", "user", "", "Discord group (main) · 1.2s · completed"],
      ["agent:main:main", "heartbeat", "", "Heartbeat (main) · 1.2s · completed"],
      ["agent:main:relay-capy-abc", "user", "", "Relay (main) · 1.2s · completed"],
      ["agent:main:cron:brief", "cron", "brief", "Cron: Morning brief · 1.2s · completed"],
      ["agent:main:cron:other", "cron", "other", "Cron job other · 1.2s · completed"],
      ["agent:main:webchat:x", "user", "", "Turn (main) · 1.2s · completed"],
    ];
    const dir = path.join(rootDir, "agentrun-spool", "1000-1");
    fs.mkdirSync(dir, { recursive: true });
    cases.forEach(([sessionKey, trigger, jobId], index) => {
      const cls = classifySession({ sessionKey, trigger, jobId }).class;
      const lines = [
        { t: "open", at: 1000, runId: `r${index}`, sessionKey, class: cls, agentId: "main", jobId: cls === "cron" ? jobId : "", trigger },
        { t: "end", at: 2200, status: "completed", durationMs: 1200 },
      ];
      fs.writeFileSync(path.join(dir, `r${index}.done`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    });
    expect(source.ingest().added).toBe(cases.length);
    const inputs = outbox.db.prepare("SELECT source_run_id, input_text FROM turns ORDER BY source_run_id").all();
    cases.forEach(([, , , title], index) => {
      const { input_text: input } = inputs.find((row) => row.source_run_id === `r${index}`);
      expect(input.startsWith(`${title} — `)).toBe(true);
    });
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
    let clock = Date.now();
    const source = createOpenclawSource({ rootDir, outbox, isProcessAlive: (pid) => pid === livePid, logger: { warn: () => {} }, now: () => clock });
    expect(source.ingest().added).toBe(1);
    expect(outbox.db.prepare("SELECT source_run_id, status FROM turns").all()).toEqual([{ source_run_id: "r-dead", status: "cancelled" }]);
    expect(fs.existsSync(path.join(rootDir, "agentrun-spool", `2000000000000-${deadPid}`))).toBe(false);
    live.handlers.agent_end({ runId: "r-live", success: true }, { runId: "r-live", sessionKey: "agent:main:main" });
    expect(source.ingest().added).toBe(0);
    clock += 31_000;
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

describe("agentrun reporter: cron runs", () => {
  const T0 = 1_800_000_000_000;
  const recurring = { name: "Morning brief", schedule: { kind: "cron" }, payload: { kind: "agentTurn" }, sessionTarget: "isolated", wakeMode: "now", agentId: "main" };
  // OpenClaw 2026.11.4 stamps both events with the run receipt's start time
  // (run-queue-execution.ts emits started with runReceipt.startedAtMs and
  // finalizes with startedAt: runReceipt.startedAtMs, which run-result.ts
  // publishes as the finish's runAtMs), so one run is one key.
  const cronEvent = (handlers, action, jobId, job, extra = {}) => handlers.cron_changed({ action, jobId, job, agentId: job.agentId, sessionTarget: job.sessionTarget, ...extra }, {});
  const isolatedTurn = (handlers, clock, jobId, runId) => {
    clock.t += 1000;
    driveTurn(handlers, { runId, sessionKey: "agent:main:cron:" + jobId + ":run:" + runId, trigger: "cron", jobId });
  };
  const setup = (options = {}) => {
    const rootDir = makeRoot();
    const clock = { t: T0 };
    const now = () => clock.t;
    const { handlers } = registerPlugin(rootDir, { now });
    const fake = createFakeAgentrun({ now });
    const pipeline = makePipeline(rootDir, { fake, now, ...options });
    return { rootDir, clock, handlers, fake, ...pipeline };
  };

  it("reports a cron run once, keyed by job and start time, with its isolated turn folded in", async () => {
    const { clock, handlers, fake, source, sender, outbox, rootDir } = setup({
      contentCron: ["brief"],
      cronJobs: [{ id: "brief", name: "Morning brief", payload: { kind: "agentTurn", message: "Summarize the news" } }],
    });
    cronEvent(handlers, "started", "brief", recurring, { runAtMs: T0, summary: kMarker });
    isolatedTurn(handlers, clock, "brief", "r1");
    clock.t += 1000;
    cronEvent(handlers, "finished", "brief", recurring, {
      runAtMs: T0, durationMs: 2500, status: "ok", sessionKey: "agent:main:cron:brief:run:r1", provider: "anthropic", model: "claude",
      summary: "summary " + kMarker, error: "error " + kMarker,
    });
    expect(readSpool(rootDir)).not.toContain("summary " + kMarker);
    expect(readSpool(rootDir)).not.toContain("error " + kMarker);
    expect(source.ingest().added).toBe(1);
    expect(outbox.counts()).toEqual({ queued: 1 });
    await sender.sendDue();
    expect(fake.runs.size).toBe(1);
    const start = fake.requests.find((request) => /sdk-runs$/.test(request.path));
    expect(start.headers["idempotency-key"]).toBe("alphaclaw:openclaw-cron:brief:" + T0);
    const [run] = fake.runs.values();
    expect(run.start.input).toMatch(/^Cron: Morning brief · 2\.5s · completed — 2 tool calls; started /);
    expect(run.start.input).toContain("Summarize the news");
    expect(run.completion).toMatchObject({ status: "completed", model: "anthropic/claude", evidence_complete: true });
    expect(run.completion.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(run.batches.flatMap((batch) => batch.events).filter((event) => event.type === "tool")).toHaveLength(4);
    expect(run.completion.answer).toContain("r1");
    expect(readSpool(rootDir)).toBe("");
  });

  it("holds a settled turn while its run is still going, and reports both as one run when the run finishes", async () => {
    const { clock, handlers, fake, source, sender } = setup();
    cronEvent(handlers, "started", "brief", recurring, { runAtMs: T0 });
    isolatedTurn(handlers, clock, "brief", "r1");
    expect(source.ingest().added).toBe(0);
    clock.t += 60_000;
    expect(source.ingest().added).toBe(0);
    cronEvent(handlers, "finished", "brief", recurring, { runAtMs: T0, durationMs: 62_000, status: "error" });
    expect(source.ingest().added).toBe(1);
    await sender.sendDue();
    const [run] = fake.runs.values();
    expect(run.completion).toMatchObject({ status: "failed", error: "The cron run failed (details withheld)." });
    expect(run.completion.answer).toBe("");
  });

  it("folds a main-session job's heartbeat turn inside the run as metadata only, and leaves a later one alone", async () => {
    const main = { ...recurring, name: "Check inbox", sessionTarget: "main", payload: { kind: "systemEvent" } };
    const { clock, handlers, fake, source, sender, outbox } = setup({ contentCron: ["inbox"], cronJobs: [{ id: "inbox", name: "Check inbox", payload: { message: "secret " + kMarker } }] });
    cronEvent(handlers, "started", "inbox", main, { runAtMs: T0 });
    clock.t += 500;
    driveTurn(handlers, { runId: "hb1", sessionKey: "agent:main:main", trigger: "heartbeat" });
    clock.t += 500;
    cronEvent(handlers, "finished", "inbox", main, { runAtMs: T0, durationMs: 4000, status: "ok" });
    clock.t += 60_000;
    driveTurn(handlers, { runId: "hb2", sessionKey: "agent:main:main", trigger: "heartbeat" });
    expect(source.ingest().added).toBe(2);
    const rows = outbox.db.prepare("SELECT source, class, contents, agent_key FROM turns ORDER BY id").all();
    expect(rows).toEqual([
      { source: "openclaw-cron", class: "heartbeat", contents: 0, agent_key: "openclaw-cron-inbox" },
      { source: "openclaw", class: "heartbeat", contents: 0, agent_key: "openclaw-agent-main" },
    ]);
    await sender.sendDue();
    const wire = fake.requests.map((request) => request.body).join("\n");
    expect(wire).not.toContain(kMarker);
    expect(wire).toContain("with a heartbeat turn of agent main");
  });

  it("leaves a heartbeat during an isolated job's run alone, and keeps a cron run's turn when its queue write fails once", async () => {
    const { clock, handlers, source, outbox } = setup({ contentCron: ["brief"], cronJobs: [{ id: "brief", name: "Morning brief", payload: { kind: "agentTurn", message: "Summarize the news" } }] });
    cronEvent(handlers, "started", "brief", recurring, { runAtMs: T0 });
    clock.t += 500;
    driveTurn(handlers, { runId: "hb1", sessionKey: "agent:main:main", trigger: "heartbeat" });
    isolatedTurn(handlers, clock, "brief", "r1");
    clock.t += 1000;
    cronEvent(handlers, "finished", "brief", recurring, { runAtMs: T0, durationMs: 4000, status: "ok", sessionKey: "agent:main:cron:brief:run:r1" });
    const addTurn = outbox.addTurn;
    let refused = 0;
    outbox.addTurn = (row) => {
      if (row.source === "openclaw-cron" && refused++ === 0) throw new Error("SQLITE_BUSY: database is locked");
      return addTurn.call(outbox, row);
    };
    expect(source.ingest().added).toBe(1);
    expect(source.ingest().added).toBe(1);
    const rows = outbox.db.prepare("SELECT source, class, contents, agent_key FROM turns ORDER BY id").all();
    expect(rows).toEqual([
      { source: "openclaw", class: "heartbeat", contents: 0, agent_key: "openclaw-agent-main" },
      { source: "openclaw-cron", class: "cron", contents: 1, agent_key: "openclaw-cron-brief" },
    ]);
  });

  it("names recurring jobs, hides listed names, and files one-shot jobs and script runs as metadata", async () => {
    const { clock, handlers, fake, source, sender, outbox } = setup({
      hiddenCron: ["secretjob-123456"],
      contentCron: ["oneshot", "script"],
      cronJobs: [{ id: "secretjob-123456", name: "Pay rent " + kMarker }],
    });
    cronEvent(handlers, "started", "secretjob-123456", { ...recurring, name: "Pay rent " + kMarker }, { runAtMs: T0 });
    cronEvent(handlers, "finished", "secretjob-123456", { ...recurring, name: "Pay rent " + kMarker }, { runAtMs: T0, durationMs: 10, status: "ok" });
    const oneShot = { ...recurring, name: "Call   mom", schedule: { kind: "at" } };
    cronEvent(handlers, "started", "oneshot", oneShot, { runAtMs: T0 + 1 });
    isolatedTurn(handlers, clock, "oneshot", "r-one");
    cronEvent(handlers, "finished", "oneshot", oneShot, { runAtMs: T0 + 1, durationMs: 5000, status: "ok" });
    const script = { ...recurring, name: "Backup", payload: { kind: "command" } };
    cronEvent(handlers, "finished", "script", script, { runAtMs: T0 + 2, durationMs: 300, status: "skipped" });
    expect(source.ingest().added).toBe(3);
    await sender.sendDue();
    expect([...fake.agents.values()].map((agent) => [agent.agent_id, agent.definition.name]).sort()).toEqual([
      ["openclaw-cron-oneshot-main", "One-shot jobs (main)"],
      ["openclaw-cron-script", "Cron: Backup"],
      ["openclaw-cron-secretjob-123456", "Cron job secretjo"],
    ]);
    const inputs = [...fake.runs.values()].map((run) => run.start.input);
    expect(inputs.some((input) => input.startsWith("One-shot: Call mom · 5s · completed"))).toBe(true);
    expect(inputs.some((input) => input.startsWith("Cron: Backup · 0.3s · cancelled (skipped) — 0 tool calls") && input.includes("cron script run"))).toBe(true);
    expect(fake.requests.map((request) => request.body).join("\n")).not.toContain("Pay rent");
    expect(outbox.db.prepare("SELECT job_id, contents FROM turns ORDER BY job_id").all()).toEqual([
      { job_id: "oneshot", contents: 1 },
      { job_id: "script", contents: 0 },
      { job_id: "secretjob-123456", contents: 0 },
    ]);
  });

  it("reports a dead gateway's unfinished run as cancelled and lets a start a later start replaced go", async () => {
    const rootDir = makeRoot();
    let generation = 1000;
    const first = registerPlugin(rootDir, { generationId: () => String(generation) });
    cronEvent(first.handlers, "started", "brief", recurring, { runAtMs: T0 });
    cronEvent(first.handlers, "started", "brief", recurring, { runAtMs: T0 + 60_000 });
    generation = 2000;
    registerPlugin(rootDir, { generationId: () => String(generation) }).handlers.gateway_start({ port: 1 }, {});
    const fake = createFakeAgentrun();
    const { source, sender, outbox } = makePipeline(rootDir, { fake });
    expect(source.ingest().added).toBe(1);
    expect(outbox.db.prepare("SELECT source_run_id FROM turns").all()).toEqual([{ source_run_id: "brief:" + (T0 + 60_000) }]);
    await sender.sendDue();
    const [run] = fake.runs.values();
    expect(run.completion).toMatchObject({ status: "cancelled", error: "interrupted by gateway restart" });
    expect(readSpool(rootDir)).toBe("");
  });

  it("drops a dead gateway's trigger check that ran no turn instead of reporting it as interrupted", async () => {
    const rootDir = makeRoot();
    let generation = 1000;
    const first = registerPlugin(rootDir, { generationId: () => String(generation) });
    cronEvent(first.handlers, "started", "notify", { ...recurring, trigger: { script: "exit 1" } }, { runAtMs: T0 });
    cronEvent(first.handlers, "started", "watch", { ...recurring, schedule: { kind: "stream" } }, { runAtMs: T0 });
    generation = 2000;
    registerPlugin(rootDir, { generationId: () => String(generation) }).handlers.gateway_start({ port: 1 }, {});
    const { source, outbox } = makePipeline(rootDir, { fake: createFakeAgentrun() });
    expect(source.ingest().added).toBe(0);
    expect(outbox.db.prepare("SELECT COUNT(*) AS n FROM turns").get().n).toBe(0);
    expect(readSpool(rootDir)).toBe("");
  });

  it("still reports a dead gateway's unfinished trigger run with a command payload, which never folds a turn, as interrupted", async () => {
    const rootDir = makeRoot();
    let generation = 1000;
    const first = registerPlugin(rootDir, { generationId: () => String(generation) });
    cronEvent(first.handlers, "started", "backup", { ...recurring, name: "Backup", payload: { kind: "command" }, trigger: { script: "exit 0" } }, { runAtMs: T0 });
    generation = 2000;
    registerPlugin(rootDir, { generationId: () => String(generation) }).handlers.gateway_start({ port: 1 }, {});
    const fake = createFakeAgentrun();
    const { source, sender } = makePipeline(rootDir, { fake });
    expect(source.ingest().added).toBe(1);
    await sender.sendDue();
    const [run] = fake.runs.values();
    expect(run.completion).toMatchObject({ status: "cancelled", error: "interrupted by gateway restart" });
  });

  it("archives a removed job's agent only after its queued runs are sent, and unarchives it for a late run", async () => {
    const { handlers, fake, source, sender, outbox, logs } = setup();
    cronEvent(handlers, "finished", "brief", recurring, { runAtMs: T0, durationMs: 10, status: "ok" });
    cronEvent(handlers, "removed", "brief", recurring);
    cronEvent(handlers, "removed", "once", { ...recurring, schedule: { kind: "at" } });
    expect(source.ingest().added).toBe(1);
    expect(outbox.db.prepare("SELECT agent_key FROM agent_archives").all()).toEqual([{ agent_key: "openclaw-cron-brief" }]);
    expect(await sender.archiveDue()).toBe(0);
    await sender.sendDue();
    expect(await sender.archiveDue()).toBe(1);
    expect(fake.agents.get("openclaw-cron-brief").archived).toBe(true);
    cronEvent(handlers, "finished", "brief", recurring, { runAtMs: T0 + 5, durationMs: 10, status: "ok" });
    expect(source.ingest().added).toBe(1);
    expect(await sender.sendDue()).toMatchObject({ sent: 1 });
    expect(fake.agents.get("openclaw-cron-brief").archived).toBe(false);
    expect(logs.some((line) => line.includes("agent_unarchived"))).toBe(true);
    fake.state.failNext.push({ path: /\/archive$/, status: 503, body: { error: { code: "unavailable" } } });
    outbox.requestArchive("openclaw-cron-brief");
    expect(await sender.archiveDue()).toBe(0);
    expect(logs.some((line) => line.includes("agent_archive_failed") && line.includes("fix="))).toBe(true);
  });

  it("opens a queue written by v0.10.296 and sends the turns waiting in it", async () => {
    const rootDir = makeRoot();
    const dbPath = path.join(rootDir, "db", "agentrun-outbox.db");
    const old = openOutbox({ dbPath });
    for (const column of ["live", "ended", "tools_batched", "last_record_at", "last_batch_at", "attempt_ended_at", "attempt_files", "key_suffix"]) old.db.exec(`ALTER TABLE turns DROP COLUMN ${column}`);
    old.db.exec("DROP TABLE agent_archives; ALTER TABLE turns DROP COLUMN job_id; PRAGMA user_version = 0;");
    old.db
      .prepare("INSERT INTO turns (source, source_run_id, agent_key, agent_name, class, status, input_text, created_at, updated_at) VALUES ('openclaw', 'old-1', 'openclaw-cron-brief', 'Cron job brief', 'cron', 'completed', 'old turn', 1, 1)")
      .run();
    old.close();
    const fake = createFakeAgentrun();
    const { sender, outbox } = makePipeline(rootDir, { fake, cronJobs: [{ id: "brief", name: "Morning brief" }] });
    expect(outbox.db.prepare("PRAGMA user_version").get().user_version).toBe(2);
    expect(await sender.sendDue()).toMatchObject({ sent: 1 });
    expect(fake.agents.get("openclaw-cron-brief").definition.name).toBe("Cron: Morning brief");
  });

  it("names a subagent's parent session by its label, never its key", async () => {
    const { handlers, fake, source, sender } = setup();
    handlers.subagent_spawned({ childSessionKey: "agent:main:subagent:abc", agentId: "main", mode: "run", runId: "x" }, { requesterSessionKey: "agent:main:telegram:direct:424242" });
    driveTurn(handlers, { runId: "r-sub", sessionKey: "agent:main:subagent:abc" });
    expect(source.ingest().added).toBe(1);
    await sender.sendDue();
    const [run] = fake.runs.values();
    expect(run.start.input).toMatch(/spawned by openclaw:dm:telegram:[0-9a-f]{12}\./);
    expect(fake.requests.map((request) => request.body).join("\n")).not.toContain("424242");
  });

  it("reads an unknown stop reason as completed, never as an inherited property", () => {
    const { handlers, clock, source, outbox } = setup();
    const ctx = { runId: "r-odd", sessionKey: "agent:main:main", trigger: "user", agentId: "main" };
    handlers.model_call_started({ runId: "r-odd" }, { runId: "r-odd", sessionKey: ctx.sessionKey });
    handlers.llm_output({ runId: "r-odd", provider: "anthropic", model: "claude", usage: { input: 1 }, lastAssistant: { stopReason: "constructor" } }, ctx);
    clock.t += 31_000;
    expect(source.ingest().added).toBe(1);
    expect(outbox.db.prepare("SELECT status FROM turns").get().status).toBe("completed");
  });
});

describe("agentrun reporter: live runs", () => {
  const T0 = 1_800_000_000_000;
  const dm = "agent:main:telegram:direct:424242";
  const iso = (ms) => new Date(ms).toISOString();
  // The whole reporter (settings, capabilities, ingest and sender) on one
  // clock with the plugin and the fake AgentRun. timeoutSeconds is
  // openclaw.json's agents.defaults.timeoutSeconds (0: unset, OpenClaw's 48 h).
  const setup = ({ timeoutSeconds = 1200, sdkRuns = false, env = {}, cronJobs = [] } = {}) => {
    const rootDir = makeRoot();
    const clock = { t: T0 };
    const now = () => clock.t;
    const { handlers } = registerPlugin(rootDir, { now });
    const fake = createFakeAgentrun({ now });
    fake.state.sdkRuns = sdkRuns;
    const lines = [];
    const make = () =>
      createAgentrunReporter({
        env: { ALPHACLAW_AGENTRUN_URL: kBase, ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN: fake.token, ...env },
        rootDir,
        readCronJobs: () => cronJobs,
        readOpenclawConfig: () => (timeoutSeconds ? { agents: { defaults: { timeoutSeconds } } } : {}),
        fetchImpl: fake.fetchImpl,
        now,
        logger: { warn: (line) => lines.push(line), log: () => {} },
      });
    const ctx = (runId) => ({ runId, sessionKey: dm, trigger: "user", agentId: "main", channel: "telegram" });
    const open = (runId) => handlers.model_call_started({ runId }, { runId, sessionKey: dm, agentId: "main" });
    const tool = (runId, name) => handlers.after_tool_call({ toolName: name, runId, durationMs: 5 }, ctx(runId));
    const end = (runId, { success = true, usage = { input: 10, output: 2 } } = {}) => {
      handlers.agent_end({ runId, success, error: success ? undefined : "overloaded", durationMs: 1000 }, ctx(runId));
      handlers.llm_output({ runId, provider: "anthropic", model: "claude", usage }, ctx(runId));
    };
    const state = { reporter: make() };
    const tick = () => state.reporter.tick();
    const restart = () => {
      state.reporter.stop();
      state.reporter = make();
    };
    const at = (ms) => {
      clock.t += ms;
    };
    return { rootDir, clock, handlers, fake, lines, state, tick, restart, open, tool, end, at };
  };
  const toolNames = (batch) => batch.events.filter((event) => event.type === "tool" && event.status === "started").map((event) => event.name);
  const onlyRun = (fake) => {
    expect(fake.runs.size).toBe(1);
    return [...fake.runs.values()][0];
  };

  it("starts a live run only once a hook decided its class, never from model_call_started alone", async () => {
    const s = setup();
    s.open("r1");
    await s.tick();
    expect(readSpool(s.rootDir)).toContain('"provisional":true');
    s.at(15_000);
    await s.tick();
    expect(s.fake.runs.size).toBe(0);
    s.tool("r1", "read");
    await s.tick();
    const run = onlyRun(s.fake);
    expect(run.start.input).toBe(`Telegram DM (main)\nStarted ${iso(T0)}`);
    expect(run.completion).toBe(null);
  });

  it("sends a live run's tools batch by batch and completes it with the same bytes after a restart", async () => {
    const s = setup();
    s.open("r1");
    s.tool("r1", "read");
    await s.tick();
    const run = onlyRun(s.fake);
    expect(run.start.input).not.toMatch(/running|completed|·/);
    expect(run.batches[0].events[0]).toMatchObject({ type: "session" });
    s.at(15_000);
    s.tool("r1", "exec");
    s.tool("r1", "write");
    // The second batch is carried out but its answer is lost.
    s.fake.state.loseAnswer = /\/events$/;
    await s.tick();
    s.fake.state.down = false;
    s.at(15_000);
    await s.tick();
    s.at(30_000);
    await s.tick();
    expect(run.batches.map(toolNames)).toEqual([["read"], ["exec", "write"]]);
    s.end("r1");
    s.fake.state.loseAnswer = /\/complete$/;
    s.at(15_000);
    await s.tick();
    expect(run.completion).not.toBe(null);
    s.restart();
    s.fake.state.down = false;
    s.at(60_000);
    await s.tick();
    const bodies = (pattern) => s.fake.requests.filter((request) => pattern.test(request.path)).map((request) => request.body);
    expect(bodies(/\/sdk-runs$/).length).toBeGreaterThan(1);
    expect(new Set(bodies(/\/sdk-runs$/)).size).toBe(1);
    expect(bodies(/\/events$/)).toHaveLength(3);
    expect(new Set(bodies(/\/events$/)).size).toBe(2);
    expect(bodies(/\/complete$/)).toHaveLength(2);
    expect(new Set(bodies(/\/complete$/)).size).toBe(1);
    expect(onlyRun(s.fake)).toBe(run);
    expect(run.batches).toHaveLength(2);
    expect(run.completion).toMatchObject({ status: "completed", usage: { input_tokens: 10, output_tokens: 2 } });
    expect(s.state.reporter.status()).toEqual({ sent: 1 });
  });

  it("stays finished-only without the capability under OpenClaw's 48 h default, and goes live under a 20-minute timeout or a short cron job", async () => {
    const slow = setup({ timeoutSeconds: 0 });
    slow.open("r1");
    slow.tool("r1", "read");
    await slow.tick();
    expect(slow.fake.runs.size).toBe(0);
    slow.end("r1");
    slow.at(15_000);
    await slow.tick();
    const finished = onlyRun(slow.fake);
    expect(finished.start.input).toMatch(/^Telegram DM \(main\) · 1s · completed — 1 tool call; /);
    expect(finished.start).not.toHaveProperty("started_at");

    const quick = setup({ timeoutSeconds: 1200 });
    quick.open("r1");
    quick.tool("r1", "read");
    await quick.tick();
    expect(onlyRun(quick.fake).completion).toBe(null);

    const job = setup({ timeoutSeconds: 0, cronJobs: [{ id: "brief", name: "Brief", payload: { kind: "agentTurn", timeoutSeconds: 600 } }] });
    job.handlers.cron_changed({ action: "started", jobId: "brief", job: { name: "Brief", schedule: { kind: "cron" }, payload: { kind: "agentTurn" }, sessionTarget: "isolated", agentId: "main" }, runAtMs: T0 }, {});
    await job.tick();
    expect(onlyRun(job.fake).start.input).toBe(`Cron: Brief\nStarted ${iso(T0)}`);
  });

  it("appends a model-fallback attempt to the same live row, and completes a failed run 30 s after its last attempt", async () => {
    const s = setup();
    s.open("r1");
    s.tool("r1", "read");
    await s.tick();
    s.at(5_000);
    s.end("r1", { success: false, usage: { input: 10, output: 1 } });
    s.at(5_000);
    s.open("r1");
    s.tool("r1", "exec");
    await s.tick();
    const run = onlyRun(s.fake);
    expect(run.completion).toBe(null);
    expect(run.batches.map(toolNames)).toEqual([["read"], ["exec"]]);
    s.at(5_000);
    s.end("r1", { usage: { input: 20, output: 2 } });
    s.at(15_000);
    await s.tick();
    expect(run.completion).toMatchObject({ status: "completed", usage: { input_tokens: 30, output_tokens: 3 } });
    expect(s.lines.join("\n")).not.toContain("late_attempt");

    const failing = setup();
    failing.open("r2");
    failing.tool("r2", "read");
    await failing.tick();
    failing.end("r2", { success: false });
    failing.at(15_000);
    await failing.tick();
    const failed = onlyRun(failing.fake);
    expect(failed.completion).toBe(null);
    failing.at(31_000);
    await failing.tick();
    expect(failed.completion).toMatchObject({ status: "failed" });
  });

  it("completes a live row as cancelled after 30 minutes without a record, or once its file is gone without an end", async () => {
    const s = setup();
    s.open("r1");
    s.tool("r1", "read");
    await s.tick();
    const run = onlyRun(s.fake);
    s.at(29 * 60_000);
    await s.tick();
    expect(run.completion).toBe(null);
    s.at(2 * 60_000);
    await s.tick();
    expect(run.completion).toMatchObject({ status: "cancelled", error: "ended without a report" });

    const gone = setup();
    gone.open("r2");
    gone.tool("r2", "read");
    await gone.tick();
    const spool = path.join(gone.rootDir, "agentrun-spool");
    for (const name of fs.readdirSync(spool, { recursive: true })) if (String(name).endsWith(".jsonl")) fs.rmSync(path.join(spool, String(name)));
    gone.at(15_000);
    await gone.tick();
    expect(onlyRun(gone.fake).completion).toMatchObject({ status: "cancelled", error: "ended without a report" });
  });

  it("reports a live run AgentRun expired once more under :final when it ends", async () => {
    const s = setup();
    s.open("r1");
    s.tool("r1", "read");
    await s.tick();
    for (let index = 0; index < 4; index += 1) {
      s.at(20 * 60_000);
      s.tool("r1", `t${index}`);
      await s.tick();
    }
    expect(s.lines.some((line) => line.includes("run_expired") && line.includes("live=1"))).toBe(true);
    expect(s.fake.runs.size).toBe(1);
    s.end("r1");
    s.at(15_000);
    await s.tick();
    expect(s.fake.runs.size).toBe(2);
    const [live, final] = [...s.fake.runs.values()];
    expect(live.completion).toBe(null);
    expect(final.start.input).toMatch(/^Telegram DM \(main\) · .* · completed — 5 tool calls; /);
    expect(final.batches.flatMap(toolNames)).toEqual(["read", "t0", "t1", "t2", "t3"]);
    expect(final.completion).toMatchObject({ status: "completed" });
    const starts = s.fake.requests.filter((request) => /\/sdk-runs$/.test(request.path)).map((request) => request.headers["idempotency-key"]);
    expect([...new Set(starts)]).toEqual(["alphaclaw:openclaw:r1", "alphaclaw:openclaw:r1:final"]);
  });

  it("logs run_ended_elsewhere, not run_expired, for a live run stopped in AgentRun's console", async () => {
    const s = setup();
    s.open("r1");
    s.tool("r1", "read");
    await s.tick();
    const run = onlyRun(s.fake);
    s.fake.stop(run.id);
    s.at(15_000);
    s.tool("r1", "exec");
    await s.tick();
    expect(s.lines.some((line) => line.includes("run_ended_elsewhere op=events") && line.includes("fix="))).toBe(true);
    expect(s.lines.some((line) => line.includes("run_expired"))).toBe(false);
    expect(s.state.reporter.status()).toEqual({ sent: 1 });
    s.end("r1");
    s.at(15_000);
    await s.tick();
    expect(onlyRun(s.fake).completion).toBe(null);
  });

  it("keeps at most 15 live rows open and reports a turn past the cap when it ends, logging live_cap once an hour", async () => {
    const s = setup();
    const ids = Array.from({ length: 16 }, (_, index) => `r${String(index).padStart(2, "0")}`);
    for (const id of ids) {
      s.open(id);
      s.tool(id, "read");
    }
    await s.tick();
    expect(s.fake.runs.size).toBe(15);
    s.at(15_000);
    await s.tick();
    expect(s.fake.runs.size).toBe(15);
    const capLines = s.lines.filter((line) => line.includes("live_cap"));
    expect(capLines).toHaveLength(1);
    expect(capLines[0]).toMatch(/count=1 open=15 .*fix=/);
    s.end("r15");
    s.at(15_000);
    await s.tick();
    expect(s.fake.runs.size).toBe(16);
    const late = [...s.fake.runs.values()].find((run) => run.completion);
    expect(late.start.input).toMatch(/^Telegram DM \(main\) · .* · completed/);
  });

  it("sends an empty batch every 10 minutes and the new start fields only while AgentRun advertises features.sdk_runs", async () => {
    const s = setup({ timeoutSeconds: 0, sdkRuns: true });
    s.open("r1");
    s.tool("r1", "read");
    await s.tick();
    const run = onlyRun(s.fake);
    expect(run.start).toMatchObject({ started_at: iso(T0), title: "Telegram DM (main)", labels: ["source:openclaw", "class:dm"] });
    s.at(5 * 60_000);
    await s.tick();
    expect(run.batches).toHaveLength(1);
    s.at(6 * 60_000);
    await s.tick();
    expect(run.batches.map((batch) => batch.events.length)).toEqual([3, 0]);
    s.at(15_000);
    await s.tick();
    expect(run.batches).toHaveLength(2);

    const plain = setup({ timeoutSeconds: 1200 });
    plain.open("r1");
    plain.tool("r1", "read");
    await plain.tick();
    plain.at(11 * 60_000);
    await plain.tick();
    const plainRun = onlyRun(plain.fake);
    expect(plainRun.batches).toHaveLength(1);
    expect(plainRun.start).not.toHaveProperty("started_at");
    expect(plainRun.start).not.toHaveProperty("labels");

    // The capability was read, then the server stopped taking the fields:
    // the start is rebuilt once without them.
    const downgraded = setup({ timeoutSeconds: 1200, sdkRuns: true });
    await downgraded.tick();
    downgraded.fake.state.sdkRuns = false;
    downgraded.open("r1");
    downgraded.tool("r1", "read");
    await downgraded.tick();
    const starts = downgraded.fake.requests.filter((request) => /\/sdk-runs$/.test(request.path)).map((request) => JSON.parse(request.body));
    expect(starts.map((body) => "started_at" in body)).toEqual([true, false]);
    expect(onlyRun(downgraded.fake).start.input).toBe(`Telegram DM (main)\nStarted ${iso(T0)}`);
  });

  it("sends a listed cron job's message and text only after the run ends, never in its start", async () => {
    const s = setup({
      timeoutSeconds: 0,
      env: { ALPHACLAW_AGENTRUN_CONTENT_CRON: "brief" },
      cronJobs: [{ id: "brief", name: "Morning brief", payload: { kind: "agentTurn", message: "Summarize " + kMarker, timeoutSeconds: 600 } }],
    });
    const job = { name: "Morning brief", schedule: { kind: "cron" }, payload: { kind: "agentTurn" }, sessionTarget: "isolated", wakeMode: "now", agentId: "main" };
    s.handlers.cron_changed({ action: "started", jobId: "brief", job, agentId: "main", sessionTarget: "isolated", runAtMs: T0 }, {});
    await s.tick();
    const run = onlyRun(s.fake);
    expect(run.start.input).toBe(`Cron: Morning brief\nStarted ${iso(T0)}`);
    const sessionKey = "agent:main:cron:brief:run:r1";
    const ctx = { runId: "r1", sessionKey, trigger: "cron", jobId: "brief", agentId: "main" };
    s.at(1000);
    s.handlers.model_call_started({ runId: "r1" }, { runId: "r1", sessionKey, agentId: "main" });
    s.handlers.after_tool_call({ toolName: "search", runId: "r1", durationMs: 5 }, ctx);
    s.handlers.llm_output({ runId: "r1", provider: "anthropic", model: "claude", assistantTexts: [`answer ${kMarker}`], usage: { input: 3, output: 4 } }, ctx);
    s.at(15_000);
    await s.tick();
    s.at(45_000);
    await s.tick();
    expect(run.batches.map(toolNames)).toEqual([["search"]]);
    expect(s.fake.requests.map((request) => request.body).join("\n")).not.toContain(kMarker);
    s.handlers.agent_end({ runId: "r1", success: true, durationMs: 60_000 }, ctx);
    s.handlers.cron_changed({ action: "finished", jobId: "brief", job, runAtMs: T0, durationMs: 62_000, status: "ok", sessionKey, provider: "anthropic", model: "claude" }, {});
    s.at(15_000);
    await s.tick();
    expect(onlyRun(s.fake)).toBe(run);
    expect(run.start.input).not.toContain(kMarker);
    const texts = run.batches.flatMap((batch) => batch.events).filter((event) => event.type === "text").map((event) => event.text);
    expect(texts).toEqual([`Job message: Summarize ${kMarker}`, `answer ${kMarker}`]);
    expect(run.batches[run.batches.length - 1].sequence).toBe(2);
    expect(run.completion).toMatchObject({ status: "completed", answer: `answer ${kMarker}`, usage: { input_tokens: 3, output_tokens: 4 } });
  });

  it("starts a cron run with a trigger or a stream schedule live only once its turn runs, and never sends a trigger check that did not fire", async () => {
    const s = setup({
      timeoutSeconds: 0,
      cronJobs: [
        { id: "notify", name: "Notify", payload: { kind: "agentTurn", timeoutSeconds: 600 } },
        { id: "watch", name: "Watch", payload: { kind: "agentTurn", timeoutSeconds: 600 } },
      ],
    });
    const notify = { name: "Notify", schedule: { kind: "cron" }, payload: { kind: "agentTurn" }, sessionTarget: "isolated", wakeMode: "now", agentId: "main", trigger: { script: "exit 1" } };
    const watch = { name: "Watch", schedule: { kind: "stream" }, payload: { kind: "agentTurn" }, sessionTarget: "isolated", wakeMode: "now", agentId: "main" };
    const start = (jobId, job, runAtMs) => s.handlers.cron_changed({ action: "started", jobId, job, agentId: "main", sessionTarget: "isolated", runAtMs }, {});
    start("notify", notify, T0);
    start("watch", watch, T0);
    await s.tick();
    expect(readSpool(s.rootDir)).toContain('"hasTrigger":true');
    expect(readSpool(s.rootDir)).not.toContain("exit 1");
    s.at(60_000);
    start("notify", notify, T0 + 60_000);
    start("watch", watch, T0 + 60_000);
    await s.tick();
    expect(s.fake.runs.size).toBe(0);
    s.at(1_000);

    const sessionKey = "agent:main:cron:notify:run:r1";
    const ctx = { runId: "r1", sessionKey, trigger: "cron", jobId: "notify", agentId: "main" };
    s.handlers.model_call_started({ runId: "r1" }, { runId: "r1", sessionKey, agentId: "main" });
    s.handlers.after_tool_call({ toolName: "search", runId: "r1", durationMs: 5 }, ctx);
    await s.tick();
    const run = onlyRun(s.fake);
    expect(run.start.input).toBe(`Cron: Notify\nStarted ${iso(T0 + 60_000)}`);
    expect(run.completion).toBe(null);
    s.handlers.agent_end({ runId: "r1", success: true, durationMs: 5_000 }, ctx);
    s.handlers.llm_output({ runId: "r1", provider: "anthropic", model: "claude", usage: { input: 3, output: 4 } }, ctx);
    s.handlers.cron_changed({ action: "finished", jobId: "notify", job: notify, runAtMs: T0 + 60_000, durationMs: 6_000, status: "ok", sessionKey }, {});
    s.at(15_000);
    await s.tick();
    expect(onlyRun(s.fake)).toBe(run);
    expect(run.completion).toMatchObject({ status: "completed", usage: { input_tokens: 3, output_tokens: 4 } });
    s.at(31 * 60_000);
    await s.tick();
    expect(onlyRun(s.fake)).toBe(run);
    expect(s.lines.join("\n")).not.toContain("late_attempt");
  });

  it("starts a stream-schedule cron run live once its turn runs", async () => {
    const s = setup({ timeoutSeconds: 0, cronJobs: [{ id: "watch", name: "Watch", payload: { kind: "agentTurn", timeoutSeconds: 600 } }] });
    const watch = { name: "Watch", schedule: { kind: "stream" }, payload: { kind: "agentTurn" }, sessionTarget: "isolated", wakeMode: "now", agentId: "main" };
    s.handlers.cron_changed({ action: "started", jobId: "watch", job: watch, agentId: "main", sessionTarget: "isolated", runAtMs: T0 }, {});
    await s.tick();
    expect(s.fake.runs.size).toBe(0);
    s.at(1_000);
    const sessionKey = "agent:main:cron:watch:run:r1";
    const ctx = { runId: "r1", sessionKey, trigger: "cron", jobId: "watch", agentId: "main" };
    s.handlers.model_call_started({ runId: "r1" }, { runId: "r1", sessionKey, agentId: "main" });
    s.handlers.after_tool_call({ toolName: "search", runId: "r1", durationMs: 5 }, ctx);
    await s.tick();
    const run = onlyRun(s.fake);
    expect(run.start.input).toBe(`Cron: Watch\nStarted ${iso(T0)}`);
    expect(run.completion).toBe(null);
  });

  it("keeps finished-only reporting with ALPHACLAW_AGENTRUN_LIVE=off, and keeps live on with live_invalid for any other value", async () => {
    const s = setup({ env: { ALPHACLAW_AGENTRUN_LIVE: "off" } });
    s.open("r1");
    s.tool("r1", "read");
    await s.tick();
    expect(s.fake.runs.size).toBe(0);
    s.end("r1");
    s.at(15_000);
    await s.tick();
    expect(onlyRun(s.fake).start.input).toMatch(/^Telegram DM \(main\) · 1s · completed/);

    const odd = setup({ env: { ALPHACLAW_AGENTRUN_LIVE: "sometimes" } });
    expect(odd.state.reporter.settings.live).toBe(true);
    odd.state.reporter.start();
    odd.state.reporter.stop();
    expect(odd.lines.some((line) => line.includes("live_invalid") && line.includes("fix="))).toBe(true);
  });

  it("keeps a quiet live run open past 30 minutes while it is within its timeout, and reports its real end", async () => {
    const s = setup({ timeoutSeconds: 2700, cronJobs: [{ id: "backup", name: "Backup", payload: { kind: "command", timeoutSeconds: 2700 } }] });
    const job = { name: "Backup", schedule: { kind: "cron" }, payload: { kind: "command" }, sessionTarget: "isolated", agentId: "main" };
    s.handlers.cron_changed({ action: "started", jobId: "backup", job, agentId: "main", sessionTarget: "isolated", runAtMs: T0 }, {});
    s.open("r1");
    s.tool("r1", "read");
    await s.tick();
    expect(s.fake.runs.size).toBe(2);
    s.at(35 * 60_000);
    await s.tick();
    expect([...s.fake.runs.values()].every((run) => run.completion === null)).toBe(true);
    s.tool("r1", "exec");
    s.end("r1");
    s.handlers.cron_changed({ action: "finished", jobId: "backup", job, runAtMs: T0, durationMs: 35 * 60_000, status: "ok" }, {});
    s.at(15_000);
    await s.tick();
    const runs = [...s.fake.runs.values()];
    expect(runs.map((run) => run.completion?.status)).toEqual(["completed", "completed"]);
    expect(s.lines.join("\n")).not.toContain("late_attempt");
  });

  it("adds a failed attempt's tools and usage once when its file is read again after a crash", async () => {
    const s = setup();
    s.open("r1");
    s.tool("r1", "read");
    s.end("r1", { success: false, usage: { input: 10, output: 2 } });
    const spool = path.join(s.rootDir, "agentrun-spool");
    const files = fs.readdirSync(spool, { recursive: true }).map((name) => path.join(spool, String(name))).filter((file) => fs.statSync(file).isFile());
    const copies = files.map((file) => [file, fs.readFileSync(file)]);
    await s.tick();
    for (const [file, bytes] of copies) fs.writeFileSync(file, bytes);
    s.at(15_000);
    await s.tick();
    s.at(31_000);
    await s.tick();
    const run = onlyRun(s.fake);
    expect(run.completion).toMatchObject({ status: "failed", usage: { input_tokens: 10, output_tokens: 2 } });
    expect(run.batches.flatMap(toolNames)).toEqual(["read"]);
  });

  it("opens a queue written by v0.10.297 and sends the runs waiting in it", async () => {
    const rootDir = makeRoot();
    const dbPath = path.join(rootDir, "db", "agentrun-outbox.db");
    const old = openOutbox({ dbPath });
    for (const column of ["live", "ended", "tools_batched", "last_record_at", "last_batch_at", "attempt_ended_at", "attempt_files", "key_suffix"]) old.db.exec(`ALTER TABLE turns DROP COLUMN ${column}`);
    old.db.exec("PRAGMA user_version = 1;");
    old.db
      .prepare("INSERT INTO turns (source, source_run_id, agent_key, agent_name, class, status, input_text, created_at, updated_at) VALUES ('openclaw', 'old-1', 'openclaw-agent-main', 'OpenClaw agent main', 'main', 'completed', 'old turn', 1, 1)")
      .run();
    old.close();
    const fake = createFakeAgentrun();
    const { sender, outbox } = makePipeline(rootDir, { fake });
    expect(outbox.db.prepare("PRAGMA user_version").get().user_version).toBe(2);
    expect(await sender.sendDue()).toMatchObject({ sent: 1 });
    expect(onlyRun(fake).completion.status).toBe("completed");
  });
});
