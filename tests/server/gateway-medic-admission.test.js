const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGatewayMedic } = require("../../lib/server/gateway-medic");
const { createRepairOperation } = require("../../lib/server/repair-operation");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createDoctorFixRunner } = require("../../lib/server/doctor-fix-runner");
const { GatewayMutationBlockedError } = require("../../lib/server/gateway-mutation-policy");
const { createMedicAdmission } = require("../../lib/server/medic-admission");

// The caller's live admission (the watchdog's assertMutationAllowed) refusing
// with the shared gateway-mutation vocabulary.
const blocker = (code) => () => {
  throw new GatewayMutationBlockedError({ code, statusCode: 409, error: `blocked: ${code}` });
};
const kBlockedStates = [
  ["lease_expired", blocker("lease_expired"), "lease_expired"],
  ["booting", blocker("booting"), "booting"],
];
const allow = () => {};
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

  // `admit` is the caller's live admission, re-read at every mutation point.
  const setup = (remedy, overrides = {}) => {
    let admit = allow;
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
      assertMutationAllowed: (args) => admit(args),
      ...options,
    });
    return { medic, run, runDoctorFix, llmClient, logs, setAdmission: (next) => { admit = next; } };
  };

  const expectUntouched = () => {
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readdirSync(openclawDir)).toEqual(["openclaw.json"]);
  };

  for (const remedy of kRemedies) {
    it.each(kBlockedStates)(`${remedy} refuses a %s admission before any writer or paid AI`, async (_name, refuse, reason) => {
      const { run, runDoctorFix, llmClient, setAdmission } = setup(remedy);
      setAdmission(refuse);
      const outcome = await run();
      expectUntouched();
      expect(runDoctorFix).not.toHaveBeenCalled();
      expect(llmClient.complete).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ fixed: false, tier: "blocked", skipped: true, reason });
    });

    it.each(["admitted", "no caller admission"])(`${remedy} retains the mutation route when %s`, async (mode) => {
      const { run, runDoctorFix } = setup(remedy);
      expect(await run(mode === "admitted" ? {} : { assertMutationAllowed: null })).toMatchObject({ fixed: true });
      expect(fs.readdirSync(openclawDir).filter((name) => name.includes(".medic-"))).toHaveLength(1);
      if (remedy.includes("doctor")) expect(runDoctorFix).toHaveBeenCalledOnce();
      else expect(fs.readFileSync(configPath, "utf8")).not.toBe(original);
    });
  }

  for (const remedy of ["ai_remove_keys", "ai_doctor", "fallback"]) {
    it.each(kBlockedStates)(`${remedy} rechecks a %s admission after the LLM await`, async (_name, refuse, reason) => {
      const response = deferred();
      const entered = deferred();
      const llmClient = {
        getAvailability: () => ({ available: true }),
        complete: vi.fn(() => { entered.resolve(); return response.promise; }),
      };
      const { run, runDoctorFix, setAdmission } = setup(remedy, { llmClient });
      const running = run();
      await entered.promise;
      setAdmission(refuse);
      response.resolve({ ok: true, provider: "test", model: "test", text: JSON.stringify({ confidence: "high", remedy: remedy === "fallback" ? "none" : remedy === "ai_doctor" ? "doctor_fix" : "remove_keys", keys: ["audit"] }) });
      expect(await running).toMatchObject({ fixed: false, skipped: true, reason });
      expectUntouched();
      expect(runDoctorFix).not.toHaveBeenCalled();
    });
  }

  it.each(kBlockedStates)("keeps diagnostic collection read-only and avoids paid AI after a %s admission appears", async (_name, refuse, reason) => {
    let flip = null;
    const collectDoctorJson = vi.fn(async () => {
      flip(refuse);
      return '{"ok":true}';
    });
    const { medic, run, llmClient, setAdmission } = setup("ai_remove_keys", { collectDoctorJson });
    flip = setAdmission;
    expect(await run()).toMatchObject({ fixed: false, skipped: true, reason });
    expect(collectDoctorJson).toHaveBeenCalledOnce();
    expect(llmClient.complete).not.toHaveBeenCalled();
    expect(medic.getAvailability()).toMatchObject({ enabled: true, ai: { available: true } });
    expectUntouched();
  });

  it("refuses a managed write when admission changes during the locked config read", async () => {
    let reads = 0;
    let flip = null;
    const { run, setAdmission } = setup("managed", {
      fsModule: { ...fs, readFileSync: (...args) => {
        const value = fs.readFileSync(...args);
        if (args[0] === configPath && ++reads === 2) flip(blocker("lease_expired"));
        return value;
      } },
    });
    flip = setAdmission;
    expect(await run()).toMatchObject({ fixed: false, skipped: true, reason: "lease_expired" });
    expectUntouched();
  });

  it.each(["cancelled", "lease_expired"])("does not apply a late LLM remedy after %s", async (reason) => {
    let current = true;
    const operation = createRepairOperation({ isCurrent: () => current });
    operation.start(60_000);
    const response = deferred();
    const entered = deferred();
    const { run } = setup("ai_remove_keys", {
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

  it("recovers on a later run after the admission clears", async () => {
    const { run, setAdmission } = setup("managed");
    setAdmission(blocker("booting"));
    expect(await run()).toMatchObject({ fixed: false, skipped: true });
    expectUntouched();
    setAdmission(allow);
    expect(await run()).toMatchObject({ fixed: true, tier: "managed_key" });
    expect(fs.readFileSync(configPath, "utf8")).not.toBe(original);
  });

  it("withholds Doctor when the caller forbids it while still permitting blamed-key repair", async () => {
    const { run, runDoctorFix } = setup("doctor");
    expect(await run({ allowDoctorFix: false })).toMatchObject({ fixed: true, tier: "blamed_key_strip" });
    expect(runDoctorFix).not.toHaveBeenCalled();
    expect(await run()).toMatchObject({ fixed: true, tier: "doctor_fix" });
    expect(runDoctorFix).toHaveBeenCalledOnce();
  });

  it("names the Doctor prohibition in the medic admission vocabulary", () => {
    const admission = createMedicAdmission();
    expect(admission.read()).toBeNull();
    expect(admission.read({ doctor: true })).toBeNull();
    expect(admission.read({ allowDoctorFix: false })).toBeNull();
    expect(admission.read({ doctor: true, allowDoctorFix: false })).toMatchObject({ code: "medic_doctor_prohibited" });
    expect(() => admission.assert({ doctor: true, allowDoctorFix: false })).toThrow(GatewayMutationBlockedError);
  });

  it.each(kBlockedStates)("passes a live %s admission into the real queued Doctor writer", async (_name, refuse, reason) => {
    const runStreamed = vi.fn(async () => ({ ok: true, tail: "fixed" }));
    const withDoctorRestoreGuard = vi.fn(async ({ run }) => run());
    const runner = createDoctorFixRunner({
      openclawDir, doctorGuard: { withDoctorRestoreGuard },
      runStream: { runStreamed }, gatewayEnv: () => ({}), notifier: { notify: vi.fn() },
    });
    let flip = null;
    const { run, setAdmission } = setup("doctor", {
      runDoctorFix: (options) => {
        queueMicrotask(() => { flip(refuse); });
        return runner(options);
      },
    });
    flip = setAdmission;
    expect(await run()).toMatchObject({ fixed: false, skipped: true, reason });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(openclawDir, "openclaw.json.pre-doctor.bak"))).toBe(false);
    expect(withDoctorRestoreGuard).not.toHaveBeenCalled();
    expect(runStreamed).not.toHaveBeenCalled();
  });

  it("drains an expired real lifecycle lease before a late LLM result can write", async () => {
    vi.useFakeTimers();
    const response = deferred();
    const entered = deferred();
    const lock = createGatewayLifecycleLock({ logger: { warn() {} } });
    let hold;
    const operation = createRepairOperation({ isCurrent: () => hold.isValid() });
    hold = lock.tryAcquire("medic", { leaseMs: 100, cleanup: operation.cleanup });
    operation.start(60_000);
    const { run, runDoctorFix } = setup("ai_remove_keys", {
      llmClient: { getAvailability: () => ({ available: true }), complete: () => { entered.resolve(); return response.promise; } },
    });
    try {
      const running = run({ operation });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(101);
      expect(await running).toMatchObject({ fixed: false, tier: "cancelled" });
      expect(hold.isExpired()).toBe(true);
      expect(lock.getActiveOperation()).toBeNull();
      response.resolve({ ok: true, provider: "test", model: "test", text: JSON.stringify({ confidence: "high", remedy: "remove_keys", keys: ["audit"] }) });
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
