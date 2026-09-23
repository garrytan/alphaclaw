const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGatewayMedic } = require("../../lib/server/gateway-medic");
const { createRepairOperation } = require("../../lib/server/repair-operation");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createDoctorFixRunner } = require("../../lib/server/doctor-fix-runner");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");

const kBlockedStates = [
  ["corrupted", () => ({ stateCorrupted: true }), "gateway_hold_unreadable"],
  ["null", () => null, "gateway_hold_unreadable"],
  ["throwing", () => { throw new Error("private-state-read-secret"); }, "gateway_hold_unreadable"],
  ["held", () => ({ gatewayHold: { reason: "migration_pending" } }), "gateway_held"],
];
const kRemedies = ["managed", "ai_remove_keys", "fallback", "doctor", "ai_doctor"];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe("gateway medic live mutation admission", () => {
  let openclawDir;
  let configPath;
  let original;
  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-medic-admission-"));
    configPath = path.join(openclawDir, "openclaw.json");
    original = `${JSON.stringify({ gateway: { controlUi: { environment: { label: "BETA" } } }, audit: { legacy: true } }, null, 2)}\n`;
    fs.writeFileSync(configPath, original);
  });
  afterEach(() => fs.rmSync(openclawDir, { recursive: true, force: true }));

  const setup = (remedy, overrides = {}) => {
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const llmClient = {
      getAvailability: () => ({ available: true }),
      complete: vi.fn(async () => ({
        ok: true,
        provider: "test",
        model: "test",
        text: JSON.stringify({ confidence: "high", remedy: remedy === "ai_doctor" ? "doctor_fix" : "remove_keys", keys: ["audit"] }),
      })),
    };
    const logs = [];
    const medic = createGatewayMedic({
      openclawDir,
      env: {},
      logger: { log: (line) => logs.push(line) },
      ...(remedy.startsWith("ai_") ? { llmClient } : {}),
      ...(["doctor", "ai_doctor"].includes(remedy) ? { runDoctorFix } : {}),
      ...overrides,
    });
    const run = (options = {}) => medic.run({
      exitCode: 78,
      stderrTail: remedy === "managed"
        ? ['gateway.controlUi: Unrecognized key: "environment"']
        : ['Unrecognized key: "audit"'],
      ...options,
    });
    return { medic, run, runDoctorFix, llmClient, logs };
  };

  const expectUntouched = () => {
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readdirSync(openclawDir)).toEqual(["openclaw.json"]);
  };

  for (const remedy of kRemedies) {
    it.each(kBlockedStates)(`${remedy} refuses %s channel state before any writer or paid AI`, async (_name, getChannelInfo, reason) => {
      const { run, runDoctorFix, llmClient, logs } = setup(remedy, { getChannelInfo });
      const outcome = await run();
      expectUntouched();
      expect(runDoctorFix).not.toHaveBeenCalled();
      expect(llmClient.complete).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ fixed: false, skipped: true, reason });
      expect(JSON.stringify({ outcome, logs })).not.toContain("private-state-read-secret");
    });

    it.each(["clean", "legacy"])(`${remedy} retains the %s mutation route`, async (mode) => {
      const { run, runDoctorFix } = setup(remedy, mode === "clean" ? { getChannelInfo: () => ({}) } : {});
      expect(await run()).toMatchObject({ fixed: true });
      expect(fs.readdirSync(openclawDir).filter((name) => name.includes(".medic-"))).toHaveLength(1);
      if (remedy.includes("doctor")) expect(runDoctorFix).toHaveBeenCalledOnce();
      else expect(fs.readFileSync(configPath, "utf8")).not.toBe(original);
    });
  }

  for (const remedy of ["ai_remove_keys", "ai_doctor", "fallback"]) {
    it.each(kBlockedStates)(`${remedy} rechecks %s state after the LLM await`, async (_name, blockedInfo, reason) => {
      let getInfo = () => ({});
      const response = deferred();
      const entered = deferred();
      const llmClient = {
        getAvailability: () => ({ available: true }),
        complete: vi.fn(() => { entered.resolve(); return response.promise; }),
      };
      const { run, runDoctorFix } = setup(remedy, { llmClient, getChannelInfo: () => getInfo() });
      const running = run();
      await entered.promise;
      getInfo = blockedInfo;
      response.resolve({ ok: true, provider: "test", model: "test", text: JSON.stringify({ confidence: "high", remedy: remedy === "fallback" ? "none" : remedy === "ai_doctor" ? "doctor_fix" : "remove_keys", keys: ["audit"] }) });
      expect(await running).toMatchObject({ fixed: false, skipped: true, reason });
      expectUntouched();
      expect(runDoctorFix).not.toHaveBeenCalled();
    });
  }

  it.each(kBlockedStates)("Doctor rechecks %s state after resolving its binary", async (_name, blockedInfo, reason) => {
    let getInfo = () => ({ installedDiverged: true });
    const response = deferred();
    const entered = deferred();
    const { run, runDoctorFix } = setup("doctor", {
      getChannelInfo: () => getInfo(),
      resolveDoctorBin: () => { entered.resolve(); return response.promise; },
    });
    const running = run();
    await entered.promise;
    getInfo = blockedInfo;
    response.resolve({ bin: "/compatible/openclaw", version: "2026.9.5" });
    expect(await running).toMatchObject({ fixed: false, skipped: true, reason });
    expectUntouched();
    expect(runDoctorFix).not.toHaveBeenCalled();
  });

  it.each(kBlockedStates)("keeps diagnostic collection read-only and avoids paid AI after %s state appears", async (_name, blockedInfo, reason) => {
    let getInfo = () => ({});
    const collectDoctorJson = vi.fn(async () => {
      getInfo = blockedInfo;
      return '{"ok":true}';
    });
    const { medic, run, llmClient } = setup("ai_remove_keys", { getChannelInfo: () => getInfo(), collectDoctorJson });
    expect(await run()).toMatchObject({ fixed: false, skipped: true, reason });
    expect(collectDoctorJson).toHaveBeenCalledOnce();
    expect(llmClient.complete).not.toHaveBeenCalled();
    expect(medic.getAvailability()).toMatchObject({ enabled: true, ai: { available: true } });
    expectUntouched();
  });

  it("refuses a managed write when policy changes during the locked config read", async () => {
    let blocked = false;
    let reads = 0;
    const { run } = setup("managed", {
      getChannelInfo: () => ({ stateCorrupted: blocked }),
      fsModule: { ...fs, readFileSync: (...args) => {
        const value = fs.readFileSync(...args);
        if (args[0] === configPath && ++reads === 2) blocked = true;
        return value;
      } },
    });
    expect(await run()).toMatchObject({ fixed: false, skipped: true, reason: "gateway_hold_unreadable" });
    expectUntouched();
  });

  it.each(["cancelled", "lease_expired"])("does not apply a late LLM remedy after %s", async (reason) => {
    let current = true;
    const operation = createRepairOperation({ isCurrent: () => current });
    operation.start(60_000);
    const response = deferred();
    const entered = deferred();
    const { run } = setup("ai_remove_keys", {
      getChannelInfo: () => ({}),
      llmClient: { getAvailability: () => ({ available: true }), complete: () => { entered.resolve(); return response.promise; } },
    });
    const running = run({ operation });
    await entered.promise;
    if (reason === "cancelled") operation.cancel(reason);
    else current = false;
    response.resolve({ ok: true, provider: "test", model: "test", text: JSON.stringify({ confidence: "high", remedy: "remove_keys", keys: ["audit"] }) });
    expect(await running).toMatchObject({ fixed: false });
    await operation.cleanup.wait();
    expectUntouched();
  });

  it("recovers on a later run after the release state is repaired", async () => {
    let info = { stateCorrupted: true };
    const { run } = setup("managed", { getChannelInfo: () => info });
    expect(await run()).toMatchObject({ fixed: false, skipped: true });
    expectUntouched();
    info = {};
    expect(await run()).toMatchObject({ fixed: true, tier: "managed_key" });
    expect(fs.readFileSync(configPath, "utf8")).not.toBe(original);
  });

  it("refuses a torn on-disk channel store and recovers through the real channel-info projection", async () => {
    const logger = { log() {}, warn() {}, error() {} };
    const store = createOpenclawReleaseChannelStore({ rootDir: openclawDir, openclawDir, logger });
    store.writeState({});
    const channel = createOpenclawChannelSync({
      rootDir: openclawDir, openclawDir, store, logger,
      resolveInstallDir: () => null, readReleaseChannel: () => "stable",
    });
    const statePath = store.statePath;
    const torn = '{"gatewayHold":';
    fs.writeFileSync(statePath, torn);
    const protectedPath = path.join(openclawDir, "exec-approvals.json");
    const protectedBytes = '{"version":1,"defaults":{"security":"deny"}}\n';
    fs.writeFileSync(protectedPath, protectedBytes);
    const { run, runDoctorFix } = setup("managed", {
      getChannelInfo: channel.getChannelInfo,
    });
    expect(channel.getChannelInfo()).toMatchObject({ stateCorrupted: true, gatewayHold: null });
    expect(await run()).toMatchObject({ fixed: false, skipped: true, reason: "gateway_hold_unreadable" });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readFileSync(statePath, "utf8")).toBe(torn);
    expect(fs.readFileSync(protectedPath, "utf8")).toBe(protectedBytes);
    expect(runDoctorFix).not.toHaveBeenCalled();
    expect(fs.readdirSync(openclawDir).filter((name) => name.includes(".medic-"))).toEqual([]);
    store.writeState({});
    expect(channel.getChannelInfo()).toMatchObject({ stateCorrupted: false, gatewayHold: null });
    expect(await run()).toMatchObject({ fixed: true, tier: "managed_key" });
    expect(fs.readFileSync(protectedPath, "utf8")).toBe(protectedBytes);
  });

  it.each([
    ["legacy non-pin window", { isPin: false, inStabilizationWindow: true }, false],
    ["legacy pin", { isPin: true, inStabilizationWindow: true }, true],
    ["pin window", { isPin: true, stabilization: { inWindow: true } }, false],
    ["channel window", { isPin: false, stabilization: { inWindow: true } }, false],
    ["accepted build", { isPin: false, inStabilizationWindow: true, stabilization: { inWindow: false } }, true],
  ])("preserves the Doctor policy for a %s while still permitting blamed-key repair", async (_name, info, allowed) => {
    const { run, runDoctorFix } = setup("doctor", { getChannelInfo: () => info });
    expect(await run()).toMatchObject({ fixed: true, tier: allowed ? "doctor_fix" : "blamed_key_strip" });
    expect(runDoctorFix).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it("rechecks a stabilization window opened during Doctor binary resolution", async () => {
    let info = { installedDiverged: true };
    const { run, runDoctorFix } = setup("doctor", {
      getChannelInfo: () => info,
      resolveDoctorBin: async () => {
        info = { ...info, stabilization: { inWindow: true } };
        return { bin: "/compatible/openclaw" };
      },
    });
    expect(await run()).toMatchObject({ fixed: true, tier: "blamed_key_strip" });
    expect(runDoctorFix).not.toHaveBeenCalled();
  });

  it.each(kBlockedStates)("passes live %s admission into the real queued Doctor writer", async (_name, blockedInfo, reason) => {
    let getInfo = () => ({});
    const runStreamed = vi.fn(async () => ({ ok: true, tail: "fixed" }));
    const withDoctorRestoreGuard = vi.fn(async ({ run }) => run());
    const runner = createDoctorFixRunner({
      openclawDir, doctorGuard: { withDoctorRestoreGuard },
      runStream: { runStreamed }, gatewayEnv: () => ({}), notifier: { notify: vi.fn() },
    });
    const { run } = setup("doctor", {
      getChannelInfo: () => getInfo(),
      runDoctorFix: (options) => {
        queueMicrotask(() => { getInfo = blockedInfo; });
        return runner(options);
      },
    });
    expect(await run()).toMatchObject({ fixed: false, skipped: true, reason });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(openclawDir, "openclaw.json.pre-doctor.bak"))).toBe(false);
    expect(withDoctorRestoreGuard).not.toHaveBeenCalled();
    expect(runStreamed).not.toHaveBeenCalled();
  });

  it.each(["LLM", "Doctor resolver"])("drains an expired real lifecycle lease before a late %s result can write", async (phase) => {
    vi.useFakeTimers();
    const response = deferred();
    const entered = deferred();
    const lock = createGatewayLifecycleLock({ logger: { warn() {} } });
    let hold;
    const operation = createRepairOperation({ isCurrent: () => hold.isValid() });
    hold = lock.tryAcquire("medic", { leaseMs: 100, cleanup: operation.cleanup });
    operation.start(60_000);
    const { run, runDoctorFix } = setup(phase === "LLM" ? "ai_remove_keys" : "doctor", {
      getChannelInfo: () => ({ installedDiverged: true }),
      ...(phase === "LLM" ? {
        llmClient: { getAvailability: () => ({ available: true }), complete: () => { entered.resolve(); return response.promise; } },
      } : { resolveDoctorBin: () => { entered.resolve(); return response.promise; } }),
    });
    try {
      const running = run({ operation });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(101);
      expect(await running).toMatchObject({ fixed: false, tier: "cancelled" });
      expect(hold.isExpired()).toBe(true);
      expect(lock.getActiveOperation()).toBeNull();
      response.resolve(phase === "LLM"
        ? { ok: true, provider: "test", model: "test", text: JSON.stringify({ confidence: "high", remedy: "remove_keys", keys: ["audit"] }) }
        : { bin: "/compatible/openclaw" });
      await Promise.resolve();
      await Promise.resolve();
      expectUntouched();
      expect(runDoctorFix).not.toHaveBeenCalled();
    } finally {
      operation.cancel("completed");
      await hold();
      vi.useRealTimers();
    }
  });
});
