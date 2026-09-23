const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { createDoctorFixRunner } = require("../../lib/server/doctor-fix-runner");
const { createRepairOperation } = require("../../lib/server/repair-operation");
const { createGatewayMedic } = require("../../lib/server/gateway-medic");
const { createDoctorGuard } = require("../../lib/server/doctor-guard");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { processGroupHasWriters } = require("../../lib/server/process-group");

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

  it.each([
    { reason: "test abort", stdio: "ignore" },
    { reason: "shutdown", stdio: "ignore" },
    { reason: "shutdown", stdio: "inherit" },
    { reason: "deadline then shutdown", stdio: "inherit" },
  ])("$reason with $stdio stdio reaps grandchildren before the guard finalizes", async ({ reason, stdio }) => {
    const ready = path.join(dir, "ready");
    const output = path.join(dir, "writes");
    const grandchild = [
      'const fs=require("fs"); process.on("SIGTERM",()=>{});',
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
      `setInterval(()=>fs.appendFileSync(${JSON.stringify(output)},"x"),5);`,
    ].join("\n");
    const leader = [
      'const {spawn}=require("child_process"); const fs=require("fs");',
      `spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:${JSON.stringify(stdio)}});`,
      `const t=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(t);console.log("ready");}},5);`,
      'setInterval(()=>{},1000);',
    ].join("\n");
    const operation = createRepairOperation();
    operation.start(5000);
    let groupPid;
    const base = createRunStream();
    const runStream = { runStreamed: (options) => base.runStreamed({
      ...options, command: process.execPath, args: ["-e", leader],
      ...(reason === "test abort" ? { killGraceMs: 150 } : {}),
      onProcess: (info) => { groupPid ||= info.pid; options.onProcess?.(info); },
      onOutput: () => {
        if (reason === "deadline then shutdown") {
          operation.cancel("deadline");
          setTimeout(() => operation.cancel("shutdown"), 50);
        } else operation.cancel(reason);
      },
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
      const startedAt = Date.now();
      const result = await run({ operation });
      expect(Date.now() - startedAt).toBeLessThan(4000);
      expect(result).toMatchObject({ ok: false, cancelled: true });
      expect(fs.readFileSync(ready, "utf8")).toBe("ready");
      expect(order).toEqual(["guard finalized"]);
      await operation.cleanup.wait();
    } finally {
      if (groupPid) { try { process.kill(-groupPid, "SIGKILL"); } catch {} }
    }
  });

  it("a post-spawn error retains escalation and ownership through a surviving grandchild and the real restore guard", async () => {
    const ready = path.join(dir, "error-ready");
    const writes = path.join(dir, "error-writes");
    const lastGood = path.join(dir, "openclaw.json.last-good");
    fs.writeFileSync(path.join(dir, "openclaw.json"), "{}\n");
    fs.writeFileSync(lastGood, "{\"original\":true}\n");
    const grandchild = [
      'const fs=require("fs"); process.on("SIGTERM",()=>{});',
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
      `setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},"x"),5);`,
    ].join("\n");
    const leader = [
      'const {spawn}=require("child_process");',
      `spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});`,
      'setInterval(()=>{},1000);',
    ].join("\n");
    const operation = createRepairOperation();
    operation.start(8000);
    const lock = createGatewayLifecycleLock({ logger: { warn() {} } });
    const release = await lock.acquire("repair", { leaseMs: 10_000, cleanup: operation.cleanup });
    let child;
    let streamedResult;
    const base = createRunStream({ spawnImpl: (...args) => {
      child = require("child_process").spawn(...args);
      return child;
    } });
    const runner = createDoctorFixRunner({ openclawDir: dir,
      doctorGuard: createDoctorGuard({ openclawDir: dir, logger: { log() {} } }),
      runStream: { runStreamed: async (options) => {
        streamedResult = await base.runStreamed({ ...options, command: process.execPath,
          args: ["-e", leader], killGraceMs: 1000 });
        return streamedResult;
      } },
      gatewayEnv: () => process.env, notifier: { notify: vi.fn() },
    });
    const run = runner({ operation });
    let successor = null;
    let queued;
    try {
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 3000 });
      expect(fs.existsSync(lastGood)).toBe(false);
      // An error can arrive after spawn. The leader dies on TERM, while
      // its grandchild ignores TERM and has no inherited pipes to hold close.
      child.emit("error", new Error("injected post-spawn transport failure"));
      const drained = release();
      queued = lock.acquire("manual_restart").then((hold) => { successor = hold; });
      await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
        { timeout: 500, interval: 5 });
      const before = fs.existsSync(writes) ? fs.statSync(writes).size : 0;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.statSync(writes).size).toBeGreaterThan(before);
      expect(streamedResult).toBeUndefined();
      expect(successor).toBeNull();
      expect(lock.getActiveOperation()).toMatchObject({ kind: "repair", phase: "cleanup" });
      expect(fs.existsSync(lastGood)).toBe(false);

      expect(await run).toMatchObject({ ok: false });
      await drained;
      await queued;
      expect(streamedResult).toMatchObject({ ok: false, killed: true,
        error: "injected post-spawn transport failure" });
      expect(processGroupHasWriters(child.pid)).toBe(false);
      expect(fs.readFileSync(lastGood, "utf8")).toBe("{\"original\":true}\n");
      expect(lock.getActiveOperation()).toMatchObject({ kind: "manual_restart" });
      const finalSize = fs.statSync(writes).size;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.statSync(writes).size).toBe(finalSize);
    } finally {
      operation.cancel("shutdown");
      if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      await run;
      await release();
      await queued;
      await successor?.();
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
