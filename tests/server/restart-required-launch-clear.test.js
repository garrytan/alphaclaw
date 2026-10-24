const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRestartRequiredState } = require("../../lib/server/restart-required-state");
const { createRestartRequiredLaunchClear } = require("../../lib/server/restart-required-launch-clear");

const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-launch-clear-"));
let dirSeq = 0;
const makeStateDir = () => fs.mkdtempSync(path.join(kTempRoot, `store-${(dirSeq += 1)}-`));

afterAll(() => {
  fs.rmSync(kTempRoot, { recursive: true, force: true });
});

const ready = { ok: true, kind: "ready" };
const starting = { ok: false, kind: "unready", reason: "starting" };

const makeStore = ({ stateDir = makeStateDir(), now } = {}) =>
  createRestartRequiredState({
    isGatewayRunning: async () => true,
    flagStore: { read: () => null, write: () => {}, clear: () => {} },
    stateDir,
    ...(now ? { now } : {}),
  });

const makeClear = ({ restartRequiredState, probes = [ready], isLaunchCurrent = () => true, nowMs = { value: 10_000 }, readyTimeoutMs = 60_000 }) => {
  const probeReadiness = vi.fn(async () => (probes.length > 1 ? probes.shift() : probes[0]));
  const insertEvent = vi.fn();
  const clear = createRestartRequiredLaunchClear({
    restartRequiredState,
    resolveReadyzUrl: () => "http://127.0.0.1:18789/readyz",
    isLaunchCurrent,
    insertEvent,
    probeReadiness,
    sleep: async (ms) => {
      nowMs.value += ms;
    },
    now: () => nowMs.value,
    readyTimeoutMs,
  });
  return { clear, probeReadiness, insertEvent };
};

describe("server/restart-required-launch-clear", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a fresh process's first launch clears the reasons a previous process persisted once /readyz is ready, by boot_launch", async () => {
    const dir = makeStateDir();
    makeStore({ stateDir: dir, now: () => 1_000 }).markRequired("env_vars_changed");

    const store = makeStore({ stateDir: dir, now: () => 12_000 });
    store.reconcileOnBoot();
    const { clear, probeReadiness, insertEvent } = makeClear({ restartRequiredState: store, probes: [starting, starting, ready] });
    const result = await clear.onGatewayLaunch({ generation: 1, launchedAt: 5_000, supervision: "managed" });

    expect(probeReadiness).toHaveBeenCalledTimes(3);
    expect(result.cleared).toMatchObject({ by: "boot_launch", launchedAt: 5_000, codes: ["env_vars_changed"] });
    expect((await store.getSnapshot()).restartRequired).toBe(false);
    expect(insertEvent).toHaveBeenCalledWith({
      eventType: "restart_required",
      source: "boot_launch",
      status: "cleared",
      details: { by: "boot_launch", generation: 1, launchedAt: 5_000, reasons: ["env_vars_changed"] },
    });
  });

  it("a later launch records gateway_launch, and a reason recorded after its spawn survives", async () => {
    let nowMs = 1_000;
    const store = makeStore({ now: () => nowMs });
    const { clear } = makeClear({ restartRequiredState: store });
    await clear.onGatewayLaunch({ generation: 1, launchedAt: 500, supervision: "managed" });

    store.markRequired("env_vars_changed");
    nowMs = 3_000;
    store.markRequired("config_file_edited");
    const result = await clear.onGatewayLaunch({ generation: 2, launchedAt: 2_000, supervision: "managed" });
    expect(result.cleared).toMatchObject({ by: "gateway_launch", codes: ["env_vars_changed"] });
    expect((await store.getSnapshot()).reasons.map((r) => r.code)).toEqual(["config_file_edited"]);
  });

  it("a launch that never reaches ready clears nothing", async () => {
    const store = makeStore({ now: () => 1_000 });
    store.markRequired("env_vars_changed");
    const { clear } = makeClear({ restartRequiredState: store, probes: [starting], readyTimeoutMs: 5_000 });
    expect(await clear.onGatewayLaunch({ generation: 1, launchedAt: 2_000, supervision: "managed" })).toEqual({ skipped: "not_ready" });
    expect((await store.getSnapshot()).restartRequired).toBe(true);
  });

  it("a launch that exited or was replaced before ready clears nothing", async () => {
    const store = makeStore({ now: () => 1_000 });
    store.markRequired("env_vars_changed");
    let current = true;
    const { clear } = makeClear({
      restartRequiredState: store,
      probes: [starting, ready],
      isLaunchCurrent: () => current,
    });
    const pending = clear.onGatewayLaunch({ generation: 1, launchedAt: 2_000, supervision: "managed" });
    current = false;
    expect(await pending).toEqual({ skipped: "superseded" });
    expect((await store.getSnapshot()).restartRequired).toBe(true);

    current = true;
    const { clear: clearB } = makeClear({ restartRequiredState: store, probes: [starting, ready] });
    const first = clearB.onGatewayLaunch({ generation: 3, launchedAt: 2_000, supervision: "managed" });
    const second = clearB.onGatewayLaunch({ generation: 4, launchedAt: 500, supervision: "managed" });
    expect(await first).toEqual({ skipped: "superseded" });
    expect((await second).cleared).toBeNull();
    expect((await store.getSnapshot()).restartRequired).toBe(true);
  });

  it("adopted, detached and spawn-time-less notices never probe or clear", async () => {
    const store = makeStore({ now: () => 1_000 });
    store.markRequired("env_vars_changed");
    const { clear, probeReadiness } = makeClear({ restartRequiredState: store });
    expect(clear.onGatewayLaunch({ generation: null, supervision: "adopted" })).toBeNull();
    expect(clear.onGatewayLaunch({ generation: null, supervision: "detached" })).toBeNull();
    expect(clear.onGatewayLaunch({ generation: 1, supervision: "managed" })).toBeNull();
    expect(probeReadiness).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).restartRequired).toBe(true);
  });

  it("the cold restart's second notice for one generation joins the first wait, and a stale generation is ignored", async () => {
    const restartRequiredState = { markAppliedByLaunch: vi.fn(() => null) };
    const { clear } = makeClear({ restartRequiredState, probes: [starting, ready] });
    const first = clear.onGatewayLaunch({ generation: 2, launchedAt: 2_000, supervision: "managed" });
    expect(clear.onGatewayLaunch({ generation: 2, launchedAt: 2_000, supervision: "managed" })).toBe(first);
    expect(clear.onGatewayLaunch({ generation: 1, launchedAt: 1_000, supervision: "managed" })).toBeNull();
    await first;
    expect(restartRequiredState.markAppliedByLaunch).toHaveBeenCalledTimes(1);
  });
});
