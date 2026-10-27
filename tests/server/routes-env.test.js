const express = require("express");
const request = require("supertest");
const { registerEnvRoutes } = require("../../lib/server/routes/env");

const createDeps = (initial = []) => {
  let fileVars = initial.map((entry) => ({ ...entry }));
  const deps = {
    readEnvFile: vi.fn(() => fileVars.map((entry) => ({ ...entry }))),
    writeEnvFile: vi.fn((next) => {
      fileVars = next.map(({ key, value }) => ({ key, value }));
    }),
    reloadEnv: vi.fn(() => true),
    kKnownVars: [
      { key: "OPENAI_API_KEY", label: "OpenAI", group: "ai", hint: "" },
      { key: "ANTHROPIC_TOKEN", label: "Anthropic token", group: "ai", hint: "", visibleInEnvars: false },
    ],
    kKnownKeys: new Set(["OPENAI_API_KEY", "ANTHROPIC_TOKEN"]),
    syncChannelConfig: vi.fn(),
    isOnboarded: vi.fn(() => true),
    restartRequiredState: { markRequired: vi.fn(), hasReason: vi.fn(() => false) },
    gatewayLaunchEnv: vi.fn(() => ({ ...Object.fromEntries(fileVars.map(({ key, value }) => [key, value])) })),
    scanStaleEnvProcesses: vi.fn(({ keys }) => ({
      available: true,
      checkedKeys: keys.length,
      scannedProcesses: 3,
      unreadableProcesses: 0,
      stale: keys.map((key) => ({ key, processes: [{ pid: 42, command: "worker.js", gateway: false, state: "differs" }] })),
    })),
  };
  return deps;
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerEnvRoutes({ app, ...deps });
  return app;
};

describe("GET /api/env", () => {
  it("reports a key the deployment sets as deployment, without its value, while its .env line is empty", async () => {
    const deps = createDeps([{ key: "OPENAI_API_KEY", value: "" }]);
    deps.getDeploymentEnvBaseline = () => ({ OPENAI_API_KEY: "fixture-deployment-value" });
    const res = await request(createApp(deps)).get("/api/env");
    const row = res.body.vars.find((entry) => entry.key === "OPENAI_API_KEY");
    expect(row).toMatchObject({ source: "deployment", value: "" });
    expect(JSON.stringify(res.body)).not.toContain("fixture-deployment-value");
  });

  it("reports the .env value when the file sets one, and unset when neither does", async () => {
    const withFile = createDeps([{ key: "OPENAI_API_KEY", value: "fixture-file" }]);
    withFile.getDeploymentEnvBaseline = () => ({ OPENAI_API_KEY: "fixture-deployment-value" });
    const fileRow = (await request(createApp(withFile)).get("/api/env")).body.vars.find((entry) => entry.key === "OPENAI_API_KEY");
    expect(fileRow).toMatchObject({ source: "env_file", value: "fixture-file" });

    const neither = createDeps([]);
    neither.getDeploymentEnvBaseline = () => null;
    const unsetRow = (await request(createApp(neither)).get("/api/env")).body.vars.find((entry) => entry.key === "OPENAI_API_KEY");
    expect(unsetRow).toMatchObject({ source: "unset", value: "" });
  });
});

describe("PATCH /api/env", () => {
  it("sets one key and leaves every other key as it is", async () => {
    const deps = createDeps([
      { key: "OPENAI_API_KEY", value: "sk-old" },
      { key: "CUSTOM_FLAG", value: "on" },
      { key: "TELEGRAM_BOT_TOKEN", value: "123:abc" },
    ]);
    const res = await request(createApp(deps)).patch("/api/env").send({ key: "OPENAI_API_KEY", value: "sk-new" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: true, gatewayEnvChanged: true });
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "CUSTOM_FLAG", value: "on" },
      { key: "TELEGRAM_BOT_TOKEN", value: "123:abc" },
      { key: "OPENAI_API_KEY", value: "sk-new" },
    ]);
    expect(deps.restartRequiredState.markRequired).toHaveBeenCalledWith("env_vars_changed");
  });

  it("deletes one key", async () => {
    const deps = createDeps([
      { key: "CUSTOM_FLAG", value: "on" },
      { key: "OTHER", value: "1" },
    ]);
    const res = await request(createApp(deps)).patch("/api/env").send({ key: "CUSTOM_FLAG", delete: true });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([{ key: "OTHER", value: "1" }]);
  });

  it("deleting a key that is not set writes nothing", async () => {
    const deps = createDeps([{ key: "OTHER", value: "1" }]);
    const res = await request(createApp(deps)).patch("/api/env").send({ key: "CUSTOM_FLAG", delete: true });

    expect(res.body).toEqual({ ok: true, changed: false, restartRequired: false });
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "Missing key"],
    [{ key: 7, value: "x" }, "Missing key"],
    [{ key: "BAD KEY", value: "x" }, "Invalid environment variable name"],
    [{ key: "A" }, 'Send either "value"'],
    [{ key: "A", value: "x", delete: true }, 'Send either "value"'],
    [{ key: "A", value: 5 }, '"value" must be a string'],
    [{ key: "PORT", value: "1" }, "PORT is reserved"],
    [{ key: "TELEGRAM_BOT_TOKEN_2", value: "1" }, "managed from Channels"],
    [{ key: "ANTHROPIC_TOKEN", value: "1" }, "managed by AlphaClaw"],
  ])("refuses %j", async (body, message) => {
    const deps = createDeps();
    const res = await request(createApp(deps)).patch("/api/env").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(message);
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
  });
});

describe("stale processes after an env save", () => {
  it("scans only the keys the save changed and returns the result", async () => {
    const deps = createDeps([
      { key: "OPENAI_API_KEY", value: "sk-old" },
      { key: "KEPT", value: "same" },
      { key: "GONE", value: "x" },
    ]);
    const res = await request(createApp(deps))
      .put("/api/env")
      .send({ vars: [{ key: "OPENAI_API_KEY", value: "sk-new" }, { key: "KEPT", value: "same" }, { key: "NEW", value: "1" }] });

    expect(res.status).toBe(200);
    const call = deps.scanStaleEnvProcesses.mock.calls[0][0];
    expect(call.keys).toEqual(["GONE", "NEW", "OPENAI_API_KEY"]);
    expect(call.envFileValues.get("OPENAI_API_KEY")).toBe("sk-new");
    expect(call.envFileValues.has("GONE")).toBe(false);
    expect(call.gatewayEnv).toMatchObject({ OPENAI_API_KEY: "sk-new" });
    expect(res.body.staleProcesses.stale.map((row) => row.key)).toEqual(["GONE", "NEW", "OPENAI_API_KEY"]);
  });

  it("does not scan when nothing changed", async () => {
    const deps = createDeps([{ key: "KEPT", value: "same" }]);
    deps.reloadEnv.mockReturnValue(false);
    const res = await request(createApp(deps)).put("/api/env").send({ vars: [{ key: "KEPT", value: "same" }] });

    expect(res.body.staleProcesses).toBeUndefined();
    expect(deps.scanStaleEnvProcesses).not.toHaveBeenCalled();
  });

  it("a failing scan never fails the save", async () => {
    const deps = createDeps([{ key: "A", value: "1" }]);
    deps.scanStaleEnvProcesses.mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await request(createApp(deps)).patch("/api/env").send({ key: "A", value: "2" });

    expect(res.status).toBe(200);
    expect(res.body.staleProcesses).toEqual({ available: false, reason: "scan_failed" });
  });
});

describe("GET /api/env/stale-processes", () => {
  it("checks every .env key by default", async () => {
    const deps = createDeps([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
    const res = await request(createApp(deps)).get("/api/env/stale-processes");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deps.scanStaleEnvProcesses.mock.calls[0][0].keys).toEqual(["A", "B"]);
    expect(JSON.stringify(res.body)).not.toContain('"1"');
  });

  it("checks the requested keys and refuses a malformed one", async () => {
    const deps = createDeps([{ key: "A", value: "1" }]);
    const app = createApp(deps);
    await request(app).get("/api/env/stale-processes?keys=A,MISSING");
    expect(deps.scanStaleEnvProcesses.mock.calls[0][0].keys).toEqual(["A", "MISSING"]);

    const bad = await request(app).get("/api/env/stale-processes?keys=A,B%20C");
    expect(bad.status).toBe(400);
  });

  it("answers available:false without a scanner", async () => {
    const deps = createDeps([{ key: "A", value: "1" }]);
    delete deps.scanStaleEnvProcesses;
    const res = await request(createApp(deps)).get("/api/env/stale-processes");
    expect(res.body).toEqual({ ok: true, available: false, reason: "unsupported" });
  });
});

describe("PATCH /api/env and the operator box lock", () => {
  const nodeFs = require("fs");
  const os = require("os");
  const nodePath = require("path");
  const { spawn, spawnSync } = require("child_process");
  const { createBoxLock, resolveBoxLockConfig, setBoxLockForTests } = require("../../lib/server/box-lock");
  const hasFlock = spawnSync("flock", ["--version"]).status === 0;
  const kScript = nodePath.join(__dirname, "..", "fixtures", "box-lock.sh");
  const children = [];
  afterEach(() => {
    setBoxLockForTests(null);
    while (children.length) children.pop().kill("SIGKILL");
  });

  it.runIf(hasFlock)("is refused with 409 box_locked while another holder has the lock, writes nothing, and takes the lock once it is free", async () => {
    const lockPath = nodePath.join(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "alphaclaw-env-patch-box-")), "box.lock");
    setBoxLockForTests(createBoxLock({
      config: resolveBoxLockConfig({ ALPHACLAW_BOX_LOCK_PATH: lockPath, ALPHACLAW_BOX_LOCK_WAIT_SECONDS: "1" }),
      recordEvent: () => {},
      logger: { log() {}, warn() {}, error() {} },
    }));
    const holder = spawn("bash", [kScript, "run", "OPS-7", "db-migrate", "--", "sleep", "30"], { env: { ...process.env, BOX_LOCK: lockPath }, stdio: "ignore" });
    children.push(holder);
    const ownerPath = lockPath.replace(/\.lock$/, ".owner");
    for (let i = 0; i < 250 && !nodeFs.existsSync(ownerPath); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const deps = createDeps([{ key: "A", value: "1" }]);
    const app = createApp(deps);

    const refused = await request(app).patch("/api/env").send({ key: "A", value: "2" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      ok: false,
      code: "box_locked",
      error: expect.stringMatching(/^The box lock is held by OPS-7 \(db-migrate\) since \S+Z, so AlphaClaw did not start saving Envars after waiting 1s\.$/),
      boxLock: { step: "envars-write", holder: { owner: "OPS-7", step: "db-migrate" } },
    });
    const startedAt = Date.now();
    expect((await request(app).patch("/api/env?boxLockWait=0").send({ key: "A", delete: true })).status).toBe(409);
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
    expect(deps.syncChannelConfig).not.toHaveBeenCalled();

    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    const saved = await request(app).patch("/api/env").send({ key: "A", value: "2" });
    expect(saved.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledTimes(1);
    expect(nodeFs.readFileSync(lockPath.replace(/\.lock$/, ".log"), "utf8").trim().split("\n").slice(-2)).toEqual([
      expect.stringMatching(/ acquire alphaclaw envars-write pid=\d+ by=api:env$/),
      expect.stringMatching(/ release alphaclaw envars-write rc=0 by=api:env$/),
    ]);
  });
});
