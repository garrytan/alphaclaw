const http = require("http");
const { createWatchdog } = require("../../lib/server/watchdog");
const { waitForBackupReadiness } = require("../../lib/server/openclaw-backup-readiness");

describe("native readiness after backup relaunch", () => {
  let server;
  let watchdog;
  let response;
  let requests;
  let gateway;
  beforeEach(async () => {
    requests = 0;
    response = () => [503, { ready: false, status: "starting" }];
    server = http.createServer((req, res) => {
      requests++;
      const [status, body] = response();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    watchdog = createWatchdog({ clawCmd: async () => ({ ok: true, stdout: "{}" }),
      launchGatewayProcess: () => {}, insertWatchdogEvent: () => {}, notifier: { notify: async () => {} },
      readEnvFile: () => [], writeEnvFile: () => {}, reloadEnv: () => {}, resolveSetupUrl: () => "",
      resolveGatewayReadyzUrl: () => `http://127.0.0.1:${server.address()?.port}/readyz` });
    gateway = { probeReadiness: watchdog.probeGatewayReadiness, isRunning: vi.fn(async () => server.listening) };
  });
  afterEach(async () => { watchdog.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const wait = (options = {}) => waitForBackupReadiness({ gateway, timeoutMs: 200, pollMs: 10,
    settleMs: 15, shouldAbort: () => false, ...options });

  it("does not turn a listening but permanently not-ready gateway into success", async () => {
    expect(await wait()).toBe(false);
    expect(requests).toBeGreaterThan(1);
    expect(gateway.isRunning).not.toHaveBeenCalled();
  });

  it("waits for slow readiness and confirms it after the settlement interval", async () => {
    response = () => requests < 4 ? [503, { ready: false, status: "starting" }] : [200, { ready: true }];
    expect(await wait()).toBe(true);
    expect(requests).toBeGreaterThanOrEqual(5);
  });

  it.each([404, 405, 501])("accepts explicit unsupported readyz (%s) only with confirmed liveness", async (status) => {
    response = () => [status, {}];
    expect(await wait()).toBe(true);
    expect(gateway.isRunning).toHaveBeenCalledTimes(2);
    gateway.isRunning.mockResolvedValue(false);
    expect(await wait()).toBe(false);
  });

  it.each([200, 503, 500])("never treats malformed or failed readyz (%s) as legacy support", async (status) => {
    response = () => [status, "invalid"];
    expect(await wait()).toBe(false);
    expect(gateway.isRunning).not.toHaveBeenCalled();
  });

  it("fails when the gateway dies after the first ready observation", async () => {
    response = () => [200, { ready: true }];
    const probe = gateway.probeReadiness;
    gateway.probeReadiness = async () => {
      const result = await probe();
      server.closeAllConnections();
      server.close();
      return result;
    };
    expect(await wait()).toBe(false);
  });

  it.each(["shutdown", "lease loss"])("fences %s during a hung readiness probe and returns promptly", async () => {
    let cancelled = false;
    gateway.probeReadiness = () => new Promise(() => {});
    const timer = setTimeout(() => { cancelled = true; }, 25);
    const started = Date.now();
    expect(await wait({ timeoutMs: 1000, shouldAbort: () => cancelled })).toBe(false);
    clearTimeout(timer);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
