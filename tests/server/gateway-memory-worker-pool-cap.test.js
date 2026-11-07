const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const {
  capLegacyWorkerPoolSizing,
  isPoolSizingCall,
  readOpenclawVersion,
  sizesWorkerPoolsFromCpuCount,
} = require("../../lib/server/gateway-memory/worker-pool-cap");
const {
  withGatewayMallocArenaCap,
  withGatewayTelemetryEnv,
} = require("../../lib/server/gateway-memory/telemetry-bootstrap");

// OpenClaw 2026.10.9's src/infra/worker-pool-sizing.ts as bundled (dist/worker-pool-sizing-9BhYGOMs.mjs).
const kSizingModule = `import { availableParallelism } from "node:os";
function resolveWorkerComputeLimit() {
\treturn Math.max(1, availableParallelism() - 1);
}
function resolveWorkerPoolSize(kind) {
\treturn Math.min(kind === "reader" || kind === "file-reader" ? 2 : kind === "compute" ? 4 : 1, resolveWorkerComputeLimit());
}
function resolveSqliteBrokerWorkerCount() {
\treturn Math.min(8, Math.max(2, Math.floor(availableParallelism() / 8)));
}
const SESSION_TRANSCRIPT_FOREGROUND_WORKERS = Math.min(8, Math.ceil(resolveWorkerComputeLimit() / 2));
export { resolveWorkerComputeLimit as a, resolveSqliteBrokerWorkerCount as n, resolveWorkerPoolSize as o, SESSION_TRANSCRIPT_FOREGROUND_WORKERS as t };
`;
const kReportSizing = `const os = await import("node:os");
const sizing = await import("./dist/worker-pool-sizing-9BhYGOMs.mjs");
const report = { cpus: os.availableParallelism(), transcriptWorkers: sizing.t, brokerWorkers: sizing.n(),
  computeLimit: sizing.a(), computeClass: sizing.o("compute"), options: process.env.NODE_OPTIONS };`;

const writePackage = (root, version, main) => {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  fs.writeFileSync(path.join(root, "dist", "worker-pool-sizing-9BhYGOMs.mjs"), kSizingModule);
  fs.writeFileSync(path.join(root, "openclaw.mjs"), main);
};

describe("legacy OpenClaw worker pool sizing cap", () => {
  let temporary;
  beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), "worker-pool-cap-")); });
  afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

  it.each([
    ["2026.10.9", true], ["2026.10.4", true], ["2026.9.34", true],
    ["2026.10.10", false], ["2026.10.10-beta.2", false], ["2026.11.1", false], ["2027.1.1", false],
    ["", false], [null, false], ["garbage", false],
  ])("treats OpenClaw %s as sizing pools from CPU count: %s", (version, expected) => {
    expect(sizesWorkerPoolsFromCpuCount(version)).toBe(expected);
  });

  it("reads the version of the package the launched entry belongs to, through a .bin symlink", () => {
    const pkg = path.join(temporary, "node_modules", "openclaw");
    writePackage(pkg, "2026.10.9", "");
    fs.mkdirSync(path.join(temporary, "node_modules", ".bin"));
    const bin = path.join(temporary, "node_modules", ".bin", "openclaw");
    fs.symlinkSync(path.join(pkg, "openclaw.mjs"), bin);
    expect(readOpenclawVersion(bin)).toBe("2026.10.9");
    expect(readOpenclawVersion(path.join(pkg, "dist", "worker-pool-sizing-9BhYGOMs.mjs"))).toBe("2026.10.9");
    fs.writeFileSync(path.join(temporary, "other.mjs"), "");
    expect(readOpenclawVersion(path.join(temporary, "other.mjs"))).toBeNull();
  });

  it("recognizes only the two sizing computations openclaw#169110 fixed", () => {
    const stack = (...frames) => ["Error", "    at availableParallelism (data:text/javascript,cap)", ...frames].join("\n");
    const sizing = "file:///app/node_modules/openclaw/dist/worker-pool-sizing-9BhYGOMs.mjs";
    expect(isPoolSizingCall(stack(`    at Module.resolveSqliteBrokerWorkerCount (${sizing}:14:44)`))).toBe(true);
    expect(isPoolSizingCall(stack(`    at resolveSqliteBrokerWorkerCount (/app/dist/native-hook-relay/worker-task-pool-CDWdBchP.mjs:2776:39)`))).toBe(true);
    expect(isPoolSizingCall(stack(`    at resolveWorkerComputeLimit (${sizing}:4:21)`, `    at ${sizing}:16:69`))).toBe(true);
    expect(isPoolSizingCall(stack(`    at resolveWorkerComputeLimit (${sizing}:4:21)`, `    at Module.resolveWorkerPoolSize (${sizing}:8:96)`))).toBe(false);
    expect(isPoolSizingCall(stack(`    at resolveWorkerComputeLimit (${sizing}:4:21)`, "    at getWorkerComputeCapacity (file:///app/dist/src-CzdT_kJd.mjs:12:3)"))).toBe(false);
    expect(isPoolSizingCall(stack("    at resolveDefaultAgentMaxConcurrent (file:///app/dist/agent-limits-CB2bq0ey.mjs:8:103)"))).toBe(false);
    expect(isPoolSizingCall(stack("    at new WorkerTaskPoolCore (file:///app/dist/src-CzdT_kJd.mjs:929:62)"))).toBe(false);
  });

  it("leaves the CPU count alone when the host already fits the fixed sizing or the version is fixed", () => {
    const pkg = path.join(temporary, "openclaw");
    writePackage(pkg, "2026.10.9", "");
    const small = { availableParallelism: () => 4 };
    expect(capLegacyWorkerPoolSizing({ entry: path.join(pkg, "openclaw.mjs"), osModule: small, syncBuiltinESMExports: vi.fn() })).toBeNull();
    expect(small.availableParallelism()).toBe(4);
    writePackage(pkg, "2026.10.10", "");
    const big = { availableParallelism: () => 32 };
    const sync = vi.fn();
    expect(capLegacyWorkerPoolSizing({ entry: path.join(pkg, "openclaw.mjs"), osModule: big, syncBuiltinESMExports: sync })).toBeNull();
    expect(sync).not.toHaveBeenCalled();
  });

  it.each([
    ["2026.10.9", { cpus: 32, transcriptWorkers: 2, brokerWorkers: 2, computeLimit: 31, computeClass: 4 }],
    ["2026.10.10", { cpus: 32, transcriptWorkers: 8, brokerWorkers: 4, computeLimit: 31, computeClass: 4 }],
  ])("sizes the pools of a respawned %s gateway on a 32-CPU host like openclaw#169110", async (version, expected) => {
    const pkg = path.join(temporary, "openclaw");
    writePackage(pkg, version, `import {spawn} from 'node:child_process';
if(!process.env.FIXTURE_CHILD){
  const child=spawn(process.execPath,process.argv.slice(1),{env:{...process.env,FIXTURE_CHILD:'1'},stdio:'inherit'});
  child.on('exit',code=>process.exit(code));
}else{
  ${kReportSizing}
  process.title='openclaw-gateway';
  await new Promise(resolve=>setTimeout(resolve,1300));
  process.stdout.write(JSON.stringify({...report, options: process.env.NODE_OPTIONS}));
}
`);
    const cpus = path.join(temporary, "cpus.cjs");
    fs.writeFileSync(cpus, 'const os=require("node:os");os.availableParallelism=()=>32;require("node:module").syncBuiltinESMExports();');
    const env = withGatewayTelemetryEnv({ ...process.env, NODE_OPTIONS: `--require=${cpus}`, OPENCLAW_STATE_DIR: temporary });
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(pkg, "openclaw.mjs"), "gateway", "run"], { env, timeout: 10000 });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ ...expected, options: `--require=${cpus}` });
  });

  it("caps glibc malloc arenas for a legacy gateway launch only, and an operator value wins", () => {
    const launch = withGatewayTelemetryEnv({ PATH: "/bin" });
    expect(withGatewayMallocArenaCap(launch, { operatorEnv: {}, version: "2026.10.9" })).toEqual({
      ...launch, MALLOC_ARENA_MAX: "2", ALPHACLAW_GATEWAY_MALLOC_ARENA_MAX: "2",
    });
    expect(withGatewayMallocArenaCap(launch, { operatorEnv: {}, version: "2026.10.10" })).toEqual(launch);
    expect(withGatewayMallocArenaCap(launch, { operatorEnv: {}, version: null })).toEqual(launch);
    const telemetryOff = withGatewayTelemetryEnv({ PATH: "/bin", ALPHACLAW_GATEWAY_MEMORY_TELEMETRY: "off" });
    expect(withGatewayMallocArenaCap(telemetryOff, { operatorEnv: {}, version: "2026.10.9" })).toEqual(telemetryOff);
    expect(withGatewayMallocArenaCap(launch, { operatorEnv: { MALLOC_ARENA_MAX: " 4 " }, version: "2026.10.9" })).toEqual({
      ...launch, MALLOC_ARENA_MAX: "4",
    });
    expect(withGatewayMallocArenaCap(launch, { operatorEnv: { MALLOC_ARENA_MAX: "4" }, version: "2026.11.1" })).toEqual({
      ...launch, MALLOC_ARENA_MAX: "4",
    });
  });

  it.runIf(process.platform === "linux")("starts a respawned legacy gateway with the arena cap and keeps it from the gateway's own children", async () => {
    const pkg = path.join(temporary, "openclaw");
    writePackage(pkg, "2026.10.9", `import {spawn, execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const arena=()=>readFileSync('/proc/self/environ','utf8').split('\\0').filter(e=>/^(MALLOC_ARENA_MAX|ALPHACLAW_GATEWAY_MALLOC_ARENA_MAX)=/.test(e)).sort();
if(!process.env.FIXTURE_CHILD){
  const child=spawn(process.execPath,process.argv.slice(1),{env:{...process.env,FIXTURE_CHILD:'1'},stdio:'inherit'});
  child.on('exit',code=>process.exit(code));
}else{
  const started=arena();
  process.title='openclaw-gateway';
  await new Promise(resolve=>setTimeout(resolve,1300));
  const tool=execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify([process.env.MALLOC_ARENA_MAX??null,process.env.ALPHACLAW_GATEWAY_MALLOC_ARENA_MAX??null]))'],{env:process.env,encoding:'utf8'});
  process.stdout.write(JSON.stringify({started,gateway:process.env.MALLOC_ARENA_MAX??null,tool:JSON.parse(tool)}));
}
`);
    const env = withGatewayMallocArenaCap(
      withGatewayTelemetryEnv({ ...process.env, NODE_OPTIONS: "", OPENCLAW_STATE_DIR: temporary }),
      { operatorEnv: {}, version: "2026.10.9" },
    );
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(pkg, "openclaw.mjs"), "gateway", "run"], { env, timeout: 10000 });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      started: ["ALPHACLAW_GATEWAY_MALLOC_ARENA_MAX=2", "MALLOC_ARENA_MAX=2"],
      gateway: null,
      tool: [null, null],
    });
  });

  it("does not cap an OpenClaw CLI that is not the gateway", async () => {
    const pkg = path.join(temporary, "openclaw");
    writePackage(pkg, "2026.10.9", `${kReportSizing}
process.stdout.write(JSON.stringify(report));`);
    const cpus = path.join(temporary, "cpus.cjs");
    fs.writeFileSync(cpus, 'const os=require("node:os");os.availableParallelism=()=>32;require("node:module").syncBuiltinESMExports();');
    const env = withGatewayTelemetryEnv({ ...process.env, NODE_OPTIONS: `--require=${cpus}` });
    const { stdout } = await execFileAsync(process.execPath, [path.join(pkg, "openclaw.mjs"), "gateway", "call", "health"], { env, timeout: 10000 });
    expect(JSON.parse(stdout)).toMatchObject({ cpus: 32, transcriptWorkers: 8, brokerWorkers: 4 });
  });
});
