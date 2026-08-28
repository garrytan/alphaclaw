const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const { OPENCLAW_DIR } = require("../../lib/server/constants");

// Lifecycle-lock coalescing across the real gateway module: concurrent
// restarts JOIN, different ops QUEUE in FIFO order, and the watchdog launch
// path never interleaves with an in-flight restart.

const modulePath = require.resolve("../../lib/server/gateway");
const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
const originalCreateConnection = net.createConnection;

const createChild = () => ({
  pid: 1234,
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
  exitCode: null,
  killed: false,
});

const createSocket = (isRunning) => {
  const running = typeof isRunning === "function" ? isRunning() : isRunning;
  return {
    setTimeout: vi.fn(),
    destroy: vi.fn(),
    on(event, handler) {
      if (running && event === "connect") setImmediate(handler);
      if (!running && event === "error") setImmediate(handler);
      return this;
    },
  };
};

describe("server/gateway lifecycle coalescing", () => {
  // Shared per-test harness: instrumented spawn/execFile mocks record an
  // ordered event log so tests can assert execution windows, not just counts.
  const setupHarness = ({ configRaw = JSON.stringify({ channels: {} }) } = {}) => {
    const events = [];
    let gatewayPortOpen = false;

    const spawnMock = vi.fn((file, args) => {
      events.push(`spawn:${args.join(" ")}`);
      return createChild();
    });
    const execFileMock = vi.fn((file, args, opts, cb) => {
      events.push(`exec:${args.join(" ")}`);
      cb(null, "", "");
      return { kill: vi.fn() };
    });
    childProcess.spawn = spawnMock;
    childProcess.execFile = execFileMock;
    // No onboarding marker / channel config on disk: plugin preflight is
    // skipped, so the only CLI traffic is the lifecycle commands under test.
    fs.existsSync = vi.fn(() => false);
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) return configRaw;
      return originalReadFileSync(targetPath, ...args);
    });
    fs.writeFileSync = vi.fn();
    net.createConnection = vi.fn(() =>
      createSocket(() => gatewayPortOpen),
    );
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    return {
      events,
      spawnMock,
      execFileMock,
      gateway,
      openGatewayPort: () => {
        gatewayPortOpen = true;
      },
    };
  };

  afterEach(() => {
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    net.createConnection = originalCreateConnection;
    delete require.cache[modulePath];
  });

  it("joins a second restartGateway issued while the first is in flight", async () => {
    const harness = setupHarness();
    const reloadEnv = vi.fn();

    const first = harness.gateway.restartGateway(reloadEnv);
    const second = harness.gateway.restartGateway(reloadEnv);
    harness.openGatewayPort();
    await Promise.all([first, second]);

    // One underlying cold start: one env reload, one `gateway stop`, one
    // `gateway --force` supervisor spawn.
    expect(reloadEnv).toHaveBeenCalledTimes(1);
    expect(
      harness.events.filter((event) => event === "exec:gateway stop"),
    ).toHaveLength(1);
    expect(
      harness.events.filter((event) => event === "spawn:gateway --force"),
    ).toHaveLength(1);
  });

  it("queues syncChannelConfig behind an in-flight restart (FIFO)", async () => {
    const harness = setupHarness();

    const restart = harness.gateway.restartGateway(vi.fn());
    void restart.then(() => harness.events.push("restart:resolved"));
    const sync = harness.gateway.syncChannelConfig(
      [{ key: "TELEGRAM_BOT_TOKEN", value: "tg-secret" }],
      "add",
    );
    harness.openGatewayPort();
    await Promise.all([restart, sync]);

    const addEvent =
      "exec:channels add --channel telegram --token tg-secret";
    expect(harness.events).toContain(addEvent);
    // The channel sync only ran after the restart fully completed — no
    // interleaving with the cold-start window.
    expect(harness.events.indexOf(addEvent)).toBeGreaterThan(
      harness.events.indexOf("restart:resolved"),
    );
    expect(harness.events.indexOf("restart:resolved")).toBeGreaterThan(
      harness.events.indexOf("spawn:gateway --force"),
    );
  });

  it("queues a watchdog launchGatewayProcess behind an in-flight restart", async () => {
    const harness = setupHarness();

    const restart = harness.gateway.restartGateway(vi.fn());
    void restart.then(() => harness.events.push("restart:resolved"));
    // Watchdog crash-restart path firing mid-restart: must queue, not
    // interleave with the cold start.
    const launch = harness.gateway.launchGatewayProcess();
    harness.openGatewayPort();
    const [, child] = await Promise.all([restart, launch]);

    expect(child).toBeTruthy();
    expect(child.pid).toBe(1234);
    // Execution windows do not overlap: the restart's spawn and completion
    // both precede the launch's spawn.
    const forceIdx = harness.events.indexOf("spawn:gateway --force");
    const resolvedIdx = harness.events.indexOf("restart:resolved");
    const runIdx = harness.events.indexOf("spawn:gateway run");
    expect(forceIdx).toBeGreaterThanOrEqual(0);
    expect(resolvedIdx).toBeGreaterThan(forceIdx);
    expect(runIdx).toBeGreaterThan(resolvedIdx);
    expect(
      harness.events.filter((event) => event === "spawn:gateway run"),
    ).toHaveLength(1);
  });
});
