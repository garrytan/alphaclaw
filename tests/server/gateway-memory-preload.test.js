const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { buildTelemetryBootstrapOption, stripTelemetryNodeOptions, withGatewayTelemetryEnv } =
  require("../../lib/server/gateway-memory/telemetry-bootstrap");
const { startGatewayTelemetryPreload } = require("../../lib/server/gateway-memory/telemetry-preload");
const { withOpenclawStartupEnv, ensureOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { filterGatewayChildEnv } = require("../../lib/server/gateway-env-policy");

describe("gateway memory preload boundary", () => {
  let temporary;
  beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-preload-")); });
  afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

  it("preserves operator options, deduplicates our bootstrap and honors the kill switch", () => {
    const original = '--no-warnings --require="/operator path/file.js"';
    const once = withGatewayTelemetryEnv({ NODE_OPTIONS: original });
    const twice = withGatewayTelemetryEnv(once);
    expect(twice.NODE_OPTIONS).toBe(once.NODE_OPTIONS);
    expect(stripTelemetryNodeOptions(twice.NODE_OPTIONS)).toBe(original);
    expect(withGatewayTelemetryEnv({ ...twice, ALPHACLAW_GATEWAY_MEMORY_TELEMETRY: "off" }).NODE_OPTIONS)
      .toBe(original);
    expect(withGatewayTelemetryEnv({ ALPHACLAW_GATEWAY_MEMORY_TELEMETRY: "off" }).NODE_OPTIONS)
      .toBeUndefined();
  });

  it("passes the child environment filter without modifying the parent NODE_OPTIONS", () => {
    const env = { NODE_OPTIONS: "--no-warnings" };
    const prepared = withOpenclawStartupEnv(env);
    expect(filterGatewayChildEnv(prepared, { logger: null }).NODE_OPTIONS).toBe(prepared.NODE_OPTIONS);
    ensureOpenclawStartupEnv({ env, fsModule: { mkdirSync: vi.fn() }, logger: null });
    expect(env.NODE_OPTIONS).toBe("--no-warnings");
  });

  it("waits for the serving title, unrefs the wait, and removes the token before sampling", () => {
    const processImpl = { title: "openclaw", platform: "linux", env: { OPENCLAW_STATE_DIR: temporary } };
    const stripOwnOptions = vi.fn();
    const startSampler = vi.fn(() => ({ stop: vi.fn() }));
    let tick;
    const timer = { unref: vi.fn() };
    const controller = startGatewayTelemetryPreload({ processImpl, mainThread: true,
      stripOwnOptions, startSampler, setIntervalImpl: (callback) => { tick = callback; return timer; },
      clearIntervalImpl: vi.fn() });
    expect(startSampler).not.toHaveBeenCalled();
    expect(timer.unref).toHaveBeenCalled();
    processImpl.title = "openclaw-gateway";
    tick();
    expect(stripOwnOptions).toHaveBeenCalledBefore(startSampler);
    expect(startSampler).toHaveBeenCalledWith({ stateDir: temporary });
    tick();
    expect(startSampler).toHaveBeenCalledOnce();
    controller.stop();
  });

  it("does not activate worker threads and bounds launcher waiting to fifteen minutes", () => {
    const startSampler = vi.fn();
    const stripOwnOptions = vi.fn();
    const setIntervalImpl = vi.fn();
    startGatewayTelemetryPreload({ mainThread: false, startSampler, stripOwnOptions, setIntervalImpl });
    expect(startSampler).not.toHaveBeenCalled();
    expect(setIntervalImpl).not.toHaveBeenCalled();
    let time = 0, tick;
    startGatewayTelemetryPreload({ mainThread: true, startSampler, stripOwnOptions,
      processImpl: { title: "node", platform: "linux", env: {} }, now: () => time,
      setIntervalImpl: (callback) => { tick = callback; return { unref() {} }; }, clearIntervalImpl: vi.fn() });
    time = 15 * 60 * 1000;
    tick();
    expect(startSampler).not.toHaveBeenCalled();
    expect(stripOwnOptions).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "malformed"])("starts a real Node gateway invocation with a %s sampler module", async (kind) => {
    const preloadPath = path.join(temporary, "broken sampler.cjs");
    if (kind === "malformed") fs.writeFileSync(preloadPath, "this is not valid JavaScript {");
    const main = path.join(temporary, "openclaw.mjs");
    fs.writeFileSync(main, 'process.stdout.write(JSON.stringify({ran:true,options:process.env.NODE_OPTIONS}));');
    const { stdout, stderr } = await execFileAsync(process.execPath, [main, "gateway", "run"], {
      env: { ...process.env, NODE_OPTIONS: `--no-warnings ${buildTelemetryBootstrapOption({ preloadPath })}` },
      timeout: 5000,
    });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ ran: true, options: "--no-warnings" });
  });

  it.each(["status", "stop", "--help"])("does not instrument a gateway %s CLI", async (verb) => {
    const main = path.join(temporary, "openclaw.mjs");
    fs.writeFileSync(main, 'process.title="openclaw-gateway";process.stdout.write(JSON.stringify({options:process.env.NODE_OPTIONS}));');
    const env = withGatewayTelemetryEnv({ ...process.env, NODE_OPTIONS: "--no-warnings", OPENCLAW_STATE_DIR: temporary });
    const { stdout } = await execFileAsync(process.execPath, [main, "gateway", verb], { env, timeout: 5000 });
    expect(JSON.parse(stdout)).toEqual({ options: "--no-warnings" });
    expect(fs.existsSync(path.join(temporary, ".alphaclaw", "gateway-memory"))).toBe(false);
  });

  it.each(["run", "--force"])("survives launcher respawn for %s, selects worker heap and isolates descendants", async (verb) => {
    const main = path.join(temporary, "openclaw.mjs");
    const identityModule = require.resolve("../../lib/server/gateway-memory/process-identity");
    const readerModule = require.resolve("../../lib/server/gateway-memory/telemetry");
    const workerSource = 'const {parentPort}=require("node:worker_threads");parentPort.postMessage(process.env.NODE_OPTIONS);';
    fs.writeFileSync(main, `
import {spawn,spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
if(!process.env.FIXTURE_WORKER){
  const child=spawn(process.execPath,process.argv.slice(1),{env:{...process.env,FIXTURE_WORKER:'1'},stdio:'inherit'});
  child.on('exit',code=>process.exit(code));
}else{
  process.title='openclaw';
  await new Promise(resolve=>setTimeout(resolve,10));
  process.title='openclaw-gateway';
  await new Promise(resolve=>setTimeout(resolve,1400));
  const identity=require(${JSON.stringify(identityModule)}).getProcessIdentity(process.pid);
  const telemetry=require(${JSON.stringify(readerModule)}).readGatewayTelemetry({identity,stateDir:process.env.OPENCLAW_STATE_DIR});
  const child=spawnSync(process.execPath,['-e','process.stdout.write(process.env.NODE_OPTIONS||"")'],{encoding:'utf8'});
  const workerOptions=await new Promise((resolve,reject)=>{const worker=new Worker(${JSON.stringify(workerSource)},{eval:true});worker.on('message',resolve);worker.on('error',reject);});
  process.stdout.write(JSON.stringify({identity,telemetry,options:process.env.NODE_OPTIONS,childOptions:child.stdout,workerOptions}));
}
`);
    const env = withGatewayTelemetryEnv({ ...process.env, NODE_OPTIONS: "--no-warnings", OPENCLAW_STATE_DIR: temporary });
    const { stdout, stderr } = await execFileAsync(process.execPath, [main, "gateway", verb], { env, timeout: 10000 });
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result.telemetry.status).toBe("fresh");
    expect(result.telemetry.records[0].heapLimitBytes).toBeGreaterThan(0);
    expect(result.telemetry.records[0].heapUsedBytes).toBeGreaterThan(0);
    expect(result.options).toBe("--no-warnings");
    expect(result.childOptions).toBe("--no-warnings");
    expect(result.workerOptions).toBe("--no-warnings");
    expect(fs.readdirSync(path.join(temporary, ".alphaclaw", "gateway-memory"))).toEqual([]);
  });
});
