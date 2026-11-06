const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRelayService, buildRelayEngineSidecarEntry } = require("../../lib/server/relay");
const { normalizeBuiltinSidecarEntry, parseSidecarRegistry } = require("../../lib/server/sidecars/registry");
const { readRelayConfig } = require("../../lib/server/relay/config");
const { relayPaths } = require("../../lib/server/relay/constants");
const { RelayError } = require("../../lib/server/relay/errors");

const quiet = { log: () => {}, warn: () => {} };

// A minimal engine over fetch: /health, internal workspace creation, agent
// registration, the inbox (token check) and an empty event log.
const createEngineFetch = () => {
  let agents = 0;
  const json = (status, data) => new Response(JSON.stringify({ ok: status < 300, data }), { status, headers: { "content-type": "application/json" } });
  return async (url, options = {}) => {
    const { pathname } = new URL(url);
    if (pathname === "/health") return json(200, { ok: true });
    if (pathname === "/internal/workspaces") return json(201, { workspace_id: "ws1", api_key: "rk_live_test" });
    if (pathname === "/v1/agents" && options.method === "POST") return json(201, { name: JSON.parse(options.body).name, token: "at_live_" + ++agents });
    if (pathname === "/v1/inbox") return json(200, { unread_dms: [] });
    if (pathname === "/v1/workspace/events") return json(200, { events: [], latest_seq: 0, next_since: 0 });
    return json(404, null);
  };
};

const setup = ({ env = {}, ensureBinary = async () => ({ downloaded: false }), fetchImpl = createEngineFetch(), now = Date.now, setTimer = null } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-svc-"));
  const timers = [];
  const supervisor = { start: vi.fn(), getStatus: () => ({ status: "running", pid: 42, starts: 1 }) };
  const service = createRelayService({
    env,
    rootDir: root,
    getSupervisor: () => supervisor,
    readDefaultAgentLabel: () => "Wintermute",
    fetchImpl,
    ensureBinary,
    listAddresses: () => [],
    now,
    setTimer: setTimer || ((fn, ms) => {
      timers.push({ fn, ms });
      return { unref() {} };
    }),
    clearTimer: () => {},
    logger: quiet,
  });
  return { root, service, supervisor, timers, cleanup: () => { service.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
};

describe("relay service", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("ALPHACLAW_RELAY=off starts nothing", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY: "off" } });
    ctx.service.start();
    await ctx.service._internal.run;
    expect(ctx.supervisor.start).not.toHaveBeenCalled();
    expect(ctx.service.getStatus()).toMatchObject({ enabled: false, phase: "off", engine: { process: null } });
    expect(fs.existsSync(path.join(ctx.root, "relay"))).toBe(false);
  });

  it("boots to ready: verified binary, internal secret, engine, provisioning, bridge", async () => {
    ctx = setup();
    await ctx.service._internal.run();
    expect(ctx.supervisor.start).toHaveBeenCalledTimes(1);
    const status = ctx.service.getStatus();
    expect(status).toMatchObject({ enabled: true, phase: "ready", error: null, agentName: "wintermute" });
    expect(status.bridge).toMatchObject({ running: true, maxConcurrent: 2, hourlyCap: 30 });
    expect(JSON.stringify(status)).not.toMatch(/rk_live|at_live/);
    expect(fs.statSync(path.join(ctx.root, "relay", "internal.secret")).mode & 0o777).toBe(0o600);
  });

  it("a download failure is retried with backoff; platform_unsupported and secrets_missing wait for a person", async () => {
    ctx = setup({ ensureBinary: async () => { throw new RelayError("engine_download_failed", "offline"); } });
    await ctx.service._internal.run();
    expect(ctx.service.getStatus()).toMatchObject({ phase: "failed", error: { code: "engine_download_failed" } });
    expect(ctx.timers.map((timer) => timer.ms)).toContain(30000);
    ctx.cleanup();

    ctx = setup({ ensureBinary: async () => { throw new RelayError("platform_unsupported"); } });
    await ctx.service._internal.run();
    expect(ctx.service.getStatus().error.code).toBe("platform_unsupported");
    expect(ctx.timers).toEqual([]);
    ctx.cleanup();

    ctx = setup();
    fs.mkdirSync(path.join(ctx.root, "relay"), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, "relay", "relaycast.db"), "");
    await ctx.service._internal.run();
    expect(ctx.service.getStatus().error.code).toBe("secrets_missing");
    expect(ctx.timers).toEqual([]);
  });

  it("an engine that never answers /health within a minute is engine_unavailable, retried", async () => {
    let clock = Date.parse("2026-11-06T10:00:00Z");
    const retries = [];
    ctx = setup({
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
      now: () => clock,
      setTimer: (fn, ms) => {
        if (ms >= 30000) {
          retries.push(ms);
          return { unref() {} };
        }
        clock += ms;
        setImmediate(fn);
        return { unref() {} };
      },
    });
    await ctx.service._internal.run();
    expect(ctx.service.getStatus()).toMatchObject({ phase: "failed", error: { code: "engine_unavailable" } });
    expect(retries).toEqual([30000]);
  });
});

describe("relay engine sidecar entry", () => {
  it("runs the pinned binary on loopback with a minimal env and no secret value", () => {
    const config = readRelayConfig({ env: {} });
    const paths = relayPaths("/data");
    const entry = normalizeBuiltinSidecarEntry(buildRelayEngineSidecarEntry({ config, paths, target: "linux-x64" }));
    expect(entry).toMatchObject({
      name: "relay-engine",
      builtin: true,
      startAfter: "manual",
      restart: "always",
      inheritEnv: false,
      command: ["/data/relay/bin/relaycast-engine-12.8.0-linux-x64", "--db", "/data/relay/relaycast.db", "--port", "18787"],
    });
    expect(entry.env).toEqual({
      HOME: "/data/relay",
      RELAYCAST_INTERNAL_SECRET_FILE: "/data/relay/internal.secret",
      RELAYCAST_PUBLIC_WORKSPACE_CREATE: "false",
      RELAYCAST_MESSAGE_TTL_DAYS: "90",
    });
    const forever = buildRelayEngineSidecarEntry({ config: readRelayConfig({ env: { ALPHACLAW_RELAY_RETENTION_DAYS: "0" } }), paths, target: "linux-x64" });
    expect(forever.env.RELAYCAST_MESSAGE_TTL_DAYS).toBeUndefined();
  });

  it("an operator sidecar cannot take the built-in name", () => {
    const { entries, errors } = parseSidecarRegistry(JSON.stringify([{ name: "relay-engine", command: ["sleep", "1"] }]), { reservedNames: ["relay-engine"] });
    expect(entries).toEqual([]);
    expect(errors[0].errors).toEqual(["name is reserved for a built-in AlphaClaw sidecar"]);
  });
});


describe("relay service: ship review fixes (ALPH-63)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("a stop while the binary is still being verified never starts the engine", async () => {
    let finishBinary;
    ctx = setup({ ensureBinary: () => new Promise((resolve) => { finishBinary = resolve; }) });
    const running = ctx.service._internal.run();
    await new Promise((resolve) => setImmediate(resolve));
    ctx.service.stop();
    finishBinary({ downloaded: false });
    await running;
    expect(ctx.supervisor.start).not.toHaveBeenCalled();
  });

  it("a first boot whose engine created its database but missed the health wait provisions on the retry, never secrets_missing", async () => {
    let clock = Date.parse("2026-11-06T10:00:00Z");
    let healthy = false;
    const engineFetch = createEngineFetch();
    ctx = setup({
      fetchImpl: async (url, options) => {
        if (!healthy) throw new Error("ECONNREFUSED");
        return engineFetch(url, options);
      },
      now: () => clock,
      setTimer: (fn, ms) => {
        if (ms >= 30000) return { unref() {} };
        clock += ms;
        setImmediate(fn);
        return { unref() {} };
      },
    });
    const paths = relayPaths(ctx.root);
    ctx.supervisor.start.mockImplementation(() => fs.writeFileSync(paths.engineDb, ""));
    await ctx.service._internal.run();
    expect(ctx.service.getStatus()).toMatchObject({ phase: "failed", error: { code: "engine_unavailable" } });
    expect(fs.existsSync(paths.engineDb)).toBe(true);
    healthy = true;
    await ctx.service._internal.run();
    expect(ctx.service.getStatus()).toMatchObject({ phase: "ready", error: null });
  });
});



describe("relay builtin sidecars (ALPH-63 /ship round 2)", () => {
  it("registers no engine sidecar on a platform with no pinned engine build (native Windows), so startup cannot throw", () => {
    const { buildRelayBuiltinSidecars } = require("../../lib/server/relay");
    const winPaths = relayPaths("C:\\Users\\owner\\.alphaclaw");
    const config = readRelayConfig({ env: {} });
    expect(buildRelayBuiltinSidecars({ config, paths: winPaths, target: null })).toEqual([]);
    const linux = buildRelayBuiltinSidecars({ config, paths: relayPaths("/data"), target: "linux-x64" });
    expect(linux).toHaveLength(1);
    expect(() => normalizeBuiltinSidecarEntry(linux[0])).not.toThrow();
    expect(buildRelayBuiltinSidecars({ config: readRelayConfig({ env: { ALPHACLAW_RELAY: "off" } }), paths: relayPaths("/data"), target: "linux-x64" })).toEqual([]);
  });
});
