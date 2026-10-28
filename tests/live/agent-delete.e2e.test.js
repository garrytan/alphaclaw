// LIVE TIER — Delete Agent (ALPH-51) against the REAL pinned OpenClaw: the
// serving gateway deletes an agent with chat history through its own
// agents.delete. Afterwards the state database has no registry row for it,
// OpenClaw's deletion journal is complete, Doctor names nothing, the gateway
// never restarted, and AlphaClaw's own process changed nothing under the
// state directory (Node fs calls in this process; the gateway and the
// openclaw CLI children are OpenClaw). Also: a client-side timeout after
// OpenClaw journaled the delete still resolves to "deleted" from the
// read-back; restoring a pre-delete openclaw.json (a git restore) brings the
// entry back without a usable database, and Delete Agent removes it again;
// and the snapshot restores through OpenClaw (backup sqlite restore +
// agents.create) with the old session and a clean Doctor.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-agent-delete-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
process.env.PATH = [liveHelpers.repoBinDir(), process.env.PATH].join(path.delimiter);

const { kLiveEnabled, waitFor, readDeclaredPin, runCliJson } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 6 * 60 * 1000;

function streamingModel(port) {
  require("http").createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null) =>
        "data: " + JSON.stringify({ id: "delete-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
      res.write(chunk({ role: "assistant", content: "noted" }));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  }).listen(port, "127.0.0.1");
}

describeLive(`LIVE Delete Agent against the ${readDeclaredPin()} pin`, () => {
  let gateway;
  let model;
  let modelPort;
  let port;
  let OPENCLAW_DIR;
  let archivesRoot;
  let deleterModule;
  let readBack;
  let execFileCmd;
  let preDeleteConfig;
  let firstArchive;

  beforeAll(async () => {
    // The model fixture runs in its own process: the CLI calls below are
    // synchronous and would starve a server in this one.
    modelPort = 19500 + Math.floor(Math.random() * 300);
    model = spawn(process.execPath, ["-e", `(${streamingModel.toString()})(${modelPort})`], { stdio: "ignore" });
    await waitFor(async () => {
      try {
        await (await fetch(`http://127.0.0.1:${modelPort}/`, { method: "POST", body: "{}" })).text();
        return true;
      } catch {
        return false;
      }
    }, 30_000, "model fixture listening");
    const constants = require("../../lib/server/constants");
    OPENCLAW_DIR = constants.OPENCLAW_DIR;
    archivesRoot = constants.kAgentArchivesDir;
    port = 19100 + Math.floor(Math.random() * 300);
    const token = "live-delete-token-00000000000000000000";
    fs.mkdirSync(path.join(OPENCLAW_DIR, "workspace"), { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace: path.join(OPENCLAW_DIR, "workspace"), model: { primary: "fixture/fixture" } } },
      models: { providers: { fixture: {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      channels: {},
    }));
    fs.writeFileSync(constants.kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
    deleterModule = require("../../lib/server/agents/delete-agent");
    readBack = require("../../lib/server/agents/delete-agent/read-back");
    execFileCmd = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv }).execFileCmd;
    await gateway.startGateway();
    await waitFor(readyzOk, 180_000, "gateway /readyz 200");
  }, 240_000);

  afterAll(async () => {
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    for (const pid of require("../../lib/server/gateway-identity").findPortListenerPids?.(port) || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    model?.kill("SIGKILL");
  });

  async function readyzOk() {
    try {
      return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
    } catch {
      return false;
    }
  }

  const env = () => liveHelpers.scrubTestRunnerEnv(gateway.gatewayEnv());
  const cli = (args, opts = {}) => runCliJson(liveHelpers.repoOpenclawBin(), args, { env: env(), timeoutMs: 180_000, ...opts });
  const cliRaw = (args) => spawnSync(process.execPath, [liveHelpers.repoOpenclawBin(), ...args], { env: env(), encoding: "utf8", timeout: 300_000 });
  const stateRows = (sql) => {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(OPENCLAW_DIR, "state", "openclaw.sqlite"), { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const registeredIds = () => stateRows("SELECT agent_id FROM agent_databases").map((row) => row.agent_id).sort();
  const journalOf = (agentId) => stateRows("SELECT agent_id, cleanup_completed FROM agent_deletion_journal").find((row) => row.agent_id === agentId) || null;
  const configuredIds = () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), "utf8"));
    return Object.keys(cfg.agents?.entries || {}).concat((cfg.agents?.list || []).map((entry) => entry.id)).sort();
  };
  const workspaceOf = (agentId) => path.join(OPENCLAW_DIR, `ws-${agentId}`);
  const sessionKeys = (agentId) => cli(["sessions", "--agent", agentId, "--json"]).sessions.map((session) => session.key);

  const addAgentWithHistory = async (agentId) => {
    cli(["agents", "add", agentId, "--workspace", workspaceOf(agentId), "--non-interactive", "--json"]);
    fs.writeFileSync(path.join(workspaceOf(agentId), "NOTE.md"), `notes for ${agentId}\n`);
    // The gateway picks the new entry up on its config hot reload.
    await waitFor(async () => {
      const turn = cliRaw(["agent", "--agent", agentId, "-m", "remember the word pineapple", "--json"]);
      if (turn.status === 0) return true;
      if (!turn.stdout.includes(`unknown agent id \\"${agentId}\\"`)) throw new Error(`turn for ${agentId} failed: ${turn.stdout.slice(-600)} ${turn.stderr.slice(-600)}`);
      return false;
    }, 60_000, `a turn for ${agentId}`);
    expect(sessionKeys(agentId)).toContain(`agent:${agentId}:main`);
    expect(registeredIds()).toContain(agentId);
  };

  const makeDeleter = (overrides = {}) =>
    deleterModule.createAgentDeleter({
      openclawDir: OPENCLAW_DIR,
      archivesRoot,
      execFileCmd,
      gatewayEnv: env,
      isGatewayRunning: readyzOk,
      lifecycleLock: require("../../lib/server/gateway-lifecycle-lock").createGatewayLifecycleLock({ logger: liveHelpers.kSilentLogger }),
      insertEvent: vi.fn(),
      notify: vi.fn(async () => ({ ok: true })),
      logger: liveHelpers.kSilentLogger,
      ...overrides,
    });

  // Every Node fs call in this process that names a path under the state
  // directory with a mutating method.
  const spyStateMutations = () => {
    const stateRoot = fs.realpathSync(OPENCLAW_DIR);
    const hits = [];
    const under = (target) => {
      if (typeof target !== "string" && !(target instanceof URL) && !Buffer.isBuffer(target)) return false;
      const resolved = path.resolve(String(target instanceof URL ? target.pathname : target));
      return resolved === stateRoot || resolved.startsWith(stateRoot + path.sep) || resolved.startsWith(OPENCLAW_DIR + path.sep);
    };
    const spies = [];
    const watch = (owner, label, names) => {
      for (const name of names) {
        if (typeof owner[name] !== "function") continue;
        const original = owner[name];
        spies.push(vi.spyOn(owner, name).mockImplementation(function (...args) {
          const paths = /^rename/.test(name) ? args.slice(0, 2) : /^(copyFile|cp|symlink|link)/.test(name) ? args.slice(1, 2) : args.slice(0, 1);
          if (paths.some(under)) hits.push(`${label}.${name} ${paths.map(String).join(" -> ")}`);
          return original.apply(this, args);
        }));
      }
    };
    watch(fs, "fs", ["rmSync", "rmdirSync", "unlinkSync", "renameSync", "writeFileSync", "appendFileSync", "mkdirSync", "copyFileSync", "cpSync", "symlinkSync", "linkSync", "truncateSync", "chmodSync", "chownSync", "utimesSync"]);
    watch(fs.promises, "fsp", ["rm", "rmdir", "unlink", "rename", "writeFile", "appendFile", "mkdir", "copyFile", "cp", "symlink", "link", "truncate", "chmod", "chown", "utimes"]);
    return { hits, restore: () => spies.forEach((spy) => spy.mockRestore()) };
  };

  it("deletes an agent with chat history through the serving gateway: no registry row, journal complete, no restart, a verified snapshot, nothing changed by AlphaClaw under the state dir", async () => {
    await addAgentWithHistory("ops");
    preDeleteConfig = fs.readFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), "utf8");
    const generation = gateway.getLaunchGeneration();
    const workerPid = gateway.getManagedGatewayWorkerPid();
    const deleter = makeDeleter();

    const preview = await deleter.preview("ops");
    expect(preview).toMatchObject({ gatewayServing: true, refusal: null, history: expect.objectContaining({ hasDatabase: true }), snapshot: expect.objectContaining({ available: true, fits: true }) });

    const spy = spyStateMutations();
    let result;
    try {
      result = await deleter.deleteAgent("ops", { snapshot: true, actor: "human" });
    } finally {
      spy.restore();
    }
    expect(spy.hits).toEqual([]);
    expect(result).toMatchObject({ agentId: "ops", outcome: "deleted", archive: expect.objectContaining({ workspaceIncluded: true, noChatHistory: false }) });

    expect(configuredIds()).not.toContain("ops");
    expect(registeredIds()).not.toContain("ops");
    expect(journalOf("ops")).toMatchObject({ cleanup_completed: 1 });
    expect(fs.existsSync(path.join(OPENCLAW_DIR, "agents", "ops", "agent", "openclaw-agent.sqlite"))).toBe(false);
    expect(gateway.getLaunchGeneration()).toBe(generation);
    expect(gateway.getManagedGatewayWorkerPid()).toBe(workerPid);
    expect(await readyzOk()).toBe(true);
    const { readUnconfiguredAgentDatabases } = require("../../lib/server/agent-database-registry");
    const leftovers = readUnconfiguredAgentDatabases({ openclawDir: OPENCLAW_DIR, config: require("../../lib/server/openclaw-config").readOpenclawConfig({ openclawDir: OPENCLAW_DIR }) });
    expect(leftovers).toMatchObject({ available: true, databases: [] });

    firstArchive = path.join(archivesRoot, result.archive.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(firstArchive, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schema: "alphaclaw.agent-archive/1", agentId: "ops", noChatHistory: false, delete: expect.objectContaining({ outcome: "deleted" }) });
    expect(fs.readFileSync(path.join(firstArchive, "workspace", "NOTE.md"), "utf8")).toBe("notes for ops\n");
    const snapshotDir = path.join(firstArchive, "database", manifest.database.snapshotId);
    expect(cli(["backup", "sqlite", "verify", snapshotDir, "--json"])).toMatchObject({ ok: true });
    expect(deleter.listDeletions().deletions).toEqual([expect.objectContaining({ agentId: "ops", outcome: "deleted", archive: result.archive.name })]);
  }, kTestTimeoutMs);

  it("a client-side timeout after OpenClaw journaled the delete resolves to deleted from the read-back", async () => {
    await addAgentWithHistory("ops2");
    let killedWhileRunning = null;
    const timingOut = async (file, args, opts) => {
      if (args[0] !== "gateway") return execFileCmd(file, args, opts);
      const child = spawn(file, args, { env: opts.env, detached: true, stdio: "ignore" });
      const exited = new Promise((resolve) => child.on("exit", () => resolve(true)));
      let done = false;
      exited.then(() => {
        done = true;
      });
      await waitFor(async () => done || journalOf("ops2") !== null, 120_000, "deletion journal row for ops2");
      killedWhileRunning = !done;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      await exited;
      const error = new Error("timed out");
      error.timedOut = true;
      throw error;
    };
    const deleter = makeDeleter({ execFileCmd: timingOut });
    const result = await deleter.deleteAgent("ops2", { snapshot: false, actor: "human" });
    console.log(`[live] client-side kill landed while the CLI was still running: ${killedWhileRunning}`);
    expect(result).toMatchObject({ agentId: "ops2", outcome: "deleted", archive: null });
    expect(registeredIds()).not.toContain("ops2");
    expect(journalOf("ops2")).toMatchObject({ cleanup_completed: 1 });
    expect(readBack.classifyDeletion({ facts: readBack.readDeletionFacts({ openclawDir: OPENCLAW_DIR, agentId: "ops2" }), answer: { kind: "none" }, settled: true })).toBe("deleted");
  }, kTestTimeoutMs);

  it("restoring the pre-delete openclaw.json (a git restore) brings the entry back without a usable database; AlphaClaw sees the id as reserved; Delete Agent removes it again", async () => {
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), preDeleteConfig);
    await waitFor(async () => configuredIds().includes("ops") && (await readyzOk()), 60_000, "restored config served");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await readyzOk()).toBe(true);
    expect(registeredIds()).not.toContain("ops");
    expect(journalOf("ops")).toMatchObject({ cleanup_completed: 1 });
    const turn = cliRaw(["agent", "--agent", "ops", "-m", "hello again", "--json"]);
    expect(turn.status).not.toBe(0);
    expect(turn.stdout + turn.stderr).toContain("OpenClaw agent database is unavailable while agent ops is deleted.");

    const deleter = makeDeleter();
    expect(deleter.findDeletionRecord("ops")).toMatchObject({ complete: true });
    const again = await deleter.deleteAgent("ops", { snapshot: false, actor: "human" });
    expect(again).toMatchObject({ outcome: "deleted" });
    expect(configuredIds()).not.toContain("ops");
    expect(registeredIds()).not.toContain("ops");
  }, kTestTimeoutMs);

  it("the snapshot restores through OpenClaw while the gateway serves: backup sqlite restore, then agents.create claims the id; the old session is back", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(firstArchive, "manifest.json"), "utf8"));
    const agentDir = path.join(OPENCLAW_DIR, "agents", "ops", "agent");
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    expect(cli(["backup", "sqlite", "restore", path.join(firstArchive, "database", manifest.database.snapshotId), "--target", path.join(agentDir, "openclaw-agent.sqlite"), "--json"])).toMatchObject({ ok: true });
    fs.cpSync(path.join(firstArchive, "workspace"), workspaceOf("ops"), { recursive: true });
    expect(cli(["gateway", "call", "agents.create", "--params", JSON.stringify({ name: "ops", workspace: workspaceOf("ops") }), "--json"])).toMatchObject({ ok: true, agentId: "ops" });

    expect(configuredIds()).toContain("ops");
    expect(journalOf("ops")).toBeNull();
    expect(sessionKeys("ops")).toContain("agent:ops:main");
    cli(["agent", "--agent", "ops", "-m", "hello again", "--json"]);
    await waitFor(async () => registeredIds().includes("ops"), 30_000, "restored database registered");
    expect(fs.readFileSync(path.join(workspaceOf("ops"), "NOTE.md"), "utf8")).toBe("notes for ops\n");
  }, kTestTimeoutMs);

  it("Doctor names no deleted agent afterwards and exits 0", async () => {
    await gateway.stopGatewayForShutdown({ budgetMs: 20_000 });
    const doctor = cliRaw(["doctor", "--fix", "--non-interactive"]);
    const output = doctor.stdout + doctor.stderr;
    expect(doctor.status, output.slice(-2000)).toBe(0);
    expect(output).not.toMatch(/not a configured target|unavailable while agent|deletion journal|ops2/i);
  }, kTestTimeoutMs);
});
