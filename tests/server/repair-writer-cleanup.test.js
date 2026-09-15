const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { createDoctorFixRunner } = require("../../lib/server/doctor-fix-runner");
const { createRepairOperation } = require("../../lib/server/repair-operation");
const { createGatewayMedic } = require("../../lib/server/gateway-medic");

describe("repair writer cancellation boundaries", () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-writer-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

  it("does not spawn an already aborted command", async () => {
    const spawnImpl = vi.fn();
    const signal = AbortSignal.abort("superseded");
    const result = await createRunStream({ spawnImpl }).runStreamed({ command: "node", signal });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, cancelled: true });
  });

  it("keeps escalation after the leader closes and finalizes the restore guard after the last writer", async () => {
    const ready = path.join(dir, "ready");
    const output = path.join(dir, "writes");
    const grandchild = [
      'const fs=require("fs"); process.on("SIGTERM",()=>{});',
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
      `setInterval(()=>fs.appendFileSync(${JSON.stringify(output)},"x"),5);`,
    ].join("\n");
    const leader = [
      'const {spawn}=require("child_process"); const fs=require("fs");',
      `spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});`,
      `const t=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(t);console.log("ready");}},5);`,
      'setInterval(()=>{},1000);',
    ].join("\n");
    const operation = createRepairOperation();
    operation.start(5000);
    let groupPid;
    const base = createRunStream();
    const runStream = { runStreamed: (options) => base.runStreamed({
      ...options, command: process.execPath, args: ["-e", leader], killGraceMs: 150,
      onProcess: (info) => { groupPid ||= info.pid; options.onProcess?.(info); },
      onOutput: () => operation.cancel("test abort"),
    }) };
    const order = [];
    const doctorGuard = { withDoctorRestoreGuard: async ({ run }) => {
      const result = await run();
      order.push("guard finalized");
      const size = fs.existsSync(output) ? fs.statSync(output).size : 0;
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(fs.existsSync(output) ? fs.statSync(output).size : 0).toBe(size);
      return result;
    } };
    const run = createDoctorFixRunner({ openclawDir: dir, doctorGuard, runStream,
      gatewayEnv: () => process.env, notifier: { notify: vi.fn() } });
    try {
      const result = await run({ operation });
      expect(result).toMatchObject({ ok: false, cancelled: true });
      expect(fs.readFileSync(ready, "utf8")).toBe("ready");
      expect(order).toEqual(["guard finalized"]);
      await operation.cleanup.wait();
    } finally {
      if (groupPid) { try { process.kill(-groupPid, "SIGKILL"); } catch {} }
    }
  });

  it("late binary discovery cannot make a backup or start Doctor after the budget", async () => {
    vi.useFakeTimers();
    fs.writeFileSync(path.join(dir, "openclaw.json"), "{}\n");
    let resolve;
    const resolveDoctorBin = vi.fn(() => new Promise((r) => { resolve = r; }));
    const runDoctorFix = vi.fn();
    const medic = createGatewayMedic({ openclawDir: dir, env: {}, logger: { log() {} },
      getChannelInfo: () => ({ installedDiverged: true }), resolveDoctorBin, runDoctorFix });
    const result = medic.run({ budgetMs: 120_000 });
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await result).fixed).toBe(false);
    resolve({ bin: "/late/openclaw.mjs" });
    await vi.advanceTimersByTimeAsync(1);
    expect(runDoctorFix).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(["openclaw.json"]);
  });
});
