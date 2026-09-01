const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the constants-derived default paths at a temp root before any module
// under test is required, so nothing touches the real ~/.alphaclaw.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-state-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const {
  kGatewayRestartOperationBudgetMs,
  kRestartOperationRetentionMs,
} = require("../../lib/server/constants");
const {
  createRestartRequiredState,
  restartReasonLabelFor,
} = require("../../lib/server/restart-required-state");

const kTempDirs = [];
const makeStateDir = () => {
  const dir = fs.mkdtempSync(path.join(kTempRoot, "store-"));
  kTempDirs.push(dir);
  return dir;
};

const nullFlagStore = () => ({
  read: vi.fn(() => null),
  write: vi.fn(),
  clear: vi.fn(),
});

const makeStore = (overrides = {}) =>
  createRestartRequiredState({
    isGatewayRunning: async () => true,
    flagStore: nullFlagStore(),
    stateDir: makeStateDir(),
    ...overrides,
  });

afterAll(() => {
  fs.rmSync(kTempRoot, { recursive: true, force: true });
});

describe("server/restart-required-state (reasons)", () => {
  it("dedupes reasons by code and refreshes addedAt on repeat", async () => {
    let nowMs = 1000;
    const store = makeStore({ now: () => nowMs });

    store.markRequired("channel_token_updated");
    nowMs = 2000;
    store.markRequired("channel_token_updated");

    const snapshot = await store.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.reasons).toEqual([
      {
        code: "channel_token_updated",
        label: "Channel token updated",
        addedAt: 2000,
      },
    ]);
    expect(snapshot.reason).toBe("channel_token_updated");
  });

  it("maps known codes (and legacy aliases) to labels, raw string otherwise", async () => {
    const store = makeStore();
    store.markRequired("env_vars_changed");
    store.markRequired("config_file_edited");
    store.markRequired("gmail-watch");
    store.markRequired("webhooks");
    store.markRequired("some_unknown_reason");

    const { reasons } = await store.getSnapshot();
    const labels = Object.fromEntries(reasons.map((r) => [r.code, r.label]));
    expect(labels).toEqual({
      env_vars_changed: "Environment variables changed",
      config_file_edited: "Configuration file edited",
      "gmail-watch": "Gmail watch updated",
      webhooks: "Webhook mappings changed",
      some_unknown_reason: "some_unknown_reason",
    });
    expect(restartReasonLabelFor("openai_compat_api_enabled")).toBe(
      "OpenAI-compatible API toggled",
    );
  });

  it("persists reasons across store instances (round-trip)", async () => {
    const stateDir = makeStateDir();
    const storeA = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
    });
    storeA.markRequired("env_vars_changed");
    storeA.markRequired("openclaw_release_channel_changed");

    const storeB = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
    });
    const snapshot = await storeB.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.reasons.map((r) => r.code).sort()).toEqual([
      "env_vars_changed",
      "openclaw_release_channel_changed",
    ]);
    expect(snapshot.reasons.every((r) => r.label && r.addedAt > 0)).toBe(true);
  });

  it("adopts a legacy flag file as one coded reason entry", async () => {
    const flagStore = nullFlagStore();
    flagStore.read.mockReturnValue({
      reason: "telegram_actions_enabled",
      source: "cli",
      markedAt: 4242,
    });
    const store = makeStore({ flagStore });

    const snapshot = await store.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.reason).toBe("telegram_actions_enabled");
    expect(snapshot.reasons).toEqual([
      {
        code: "telegram_actions_enabled",
        label: "Telegram actions enabled",
        addedAt: 4242,
      },
    ]);
    // Re-reading the same flag does not duplicate the entry.
    expect((await store.getSnapshot()).reasons).toHaveLength(1);
  });

  it("clearRequired clears all reasons, the flag, and the persisted file", async () => {
    const stateDir = makeStateDir();
    const flagStore = nullFlagStore();
    const store = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore,
      stateDir,
    });
    store.markRequired("env_vars_changed");
    store.markRequired("config_file_edited");
    const reasonsFile = path.join(stateDir, "alphaclaw-restart-reasons.json");
    expect(fs.existsSync(reasonsFile)).toBe(true);

    store.clearRequired();
    expect(flagStore.clear).toHaveBeenCalled();
    expect(fs.existsSync(reasonsFile)).toBe(false);
    const snapshot = await store.getSnapshot();
    expect(snapshot.restartRequired).toBe(false);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.reason).toBe("");
  });
});

describe("server/restart-required-state (operation lifecycle)", () => {
  it("begin → update lastStep → complete ok", async () => {
    let nowMs = 10_000;
    const store = makeStore({ now: () => nowMs, getBootId: () => "boot-A" });
    store.markRequired("env_vars_changed");

    const { operationId, reasonsSnapshot } = store.beginRestart();
    expect(operationId).toMatch(/[0-9a-f-]{36}/);
    expect(reasonsSnapshot).toEqual(["env_vars_changed"]);

    const active = store.getActiveRestartOperation();
    expect(active).toMatchObject({
      operationId,
      kind: "gateway_restart",
      startedAt: 10_000,
      bootId: "boot-A",
      // Initial lifetime = the shared restart-operation budget (the route
      // keepalive extends it while queued/running).
      expiresAt: 10_000 + kGatewayRestartOperationBudgetMs,
      status: "running",
      lastStep: null,
      errorSummary: null,
    });
    expect((await store.getSnapshot()).restartInProgress).toBe(true);
    expect((await store.getSnapshot()).activeOperation.operationId).toBe(
      operationId,
    );

    const updated = store.updateRestartOperation({
      operationId,
      lastStep: "stopping",
    });
    expect(updated.lastStep).toBe("stopping");
    expect(store.updateRestartOperation({ operationId: "nope" })).toBeNull();

    nowMs = 20_000;
    const record = store.completeRestart({ operationId, ok: true });
    expect(record).toMatchObject({
      operationId,
      status: "succeeded",
      completedAt: 20_000,
      errorSummary: null,
    });
    expect(store.getActiveRestartOperation()).toBeNull();
    expect(store.getLastRestartOperation().status).toBe("succeeded");

    const snapshot = await store.getSnapshot();
    expect(snapshot.restartRequired).toBe(false);
    expect(snapshot.restartInProgress).toBe(false);
    expect(snapshot.activeOperation).toBeNull();
  });

  it("clears only the reasons snapshot: mid-restart reasons survive", async () => {
    const store = makeStore();
    store.markRequired("env_vars_changed");

    const { operationId, reasonsSnapshot } = store.beginRestart();
    expect(reasonsSnapshot).toEqual(["env_vars_changed"]);

    // A new reason lands while the restart is in flight.
    store.markRequired("config_file_edited");

    store.completeRestart({ operationId, ok: true });
    const snapshot = await store.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.reasons.map((r) => r.code)).toEqual(["config_file_edited"]);
    expect(snapshot.restartInProgress).toBe(false);
  });

  it("captures CLI flag reasons in the snapshot and clears the flag on success", async () => {
    const flagStore = nullFlagStore();
    flagStore.read.mockReturnValue({
      reason: "telegram_actions_enabled",
      markedAt: 1,
    });
    const store = makeStore({ flagStore });

    const { operationId, reasonsSnapshot } = store.beginRestart();
    expect(reasonsSnapshot).toEqual(["telegram_actions_enabled"]);

    store.completeRestart({ operationId, ok: true });
    expect(flagStore.clear).toHaveBeenCalled();

    // The flag file is gone now; the reason must not be re-adopted.
    flagStore.read.mockReturnValue(null);
    const snapshot = await store.getSnapshot();
    expect(snapshot.restartRequired).toBe(false);
    expect(snapshot.reasons).toEqual([]);
  });

  it("keeps a flag written mid-restart with a different code", async () => {
    const flagStore = nullFlagStore();
    const store = makeStore({ flagStore });
    store.markRequired("env_vars_changed");
    flagStore.write.mockClear();

    const { operationId } = store.beginRestart();
    // The CLI writes a new flag while the restart is running.
    flagStore.read.mockReturnValue({
      reason: "telegram_actions_enabled",
      markedAt: Date.now(),
    });
    store.completeRestart({ operationId, ok: true });
    expect(flagStore.clear).not.toHaveBeenCalled();

    // The surviving flag is re-adopted on the next snapshot.
    const snapshot = await store.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.reasons.map((r) => r.code)).toEqual([
      "telegram_actions_enabled",
    ]);
  });

  it("complete with ok:false marks failed and keeps reasons", async () => {
    const store = makeStore();
    store.markRequired("env_vars_changed");

    const { operationId } = store.beginRestart();
    const record = store.completeRestart({
      operationId,
      ok: false,
      errorSummary: "gateway never became ready",
    });
    expect(record.status).toBe("failed");
    expect(record.errorSummary).toBe("gateway never became ready");
    expect(store.getActiveRestartOperation()).toBeNull();
    expect(store.getLastRestartOperation().status).toBe("failed");

    const snapshot = await store.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.reasons.map((r) => r.code)).toEqual(["env_vars_changed"]);
    expect(snapshot.restartInProgress).toBe(false);
  });

  it("attaches to the existing operation on concurrent beginRestart", () => {
    const store = makeStore();
    store.markRequired("env_vars_changed");
    const first = store.beginRestart();
    const second = store.beginRestart();
    expect(second.operationId).toBe(first.operationId);
    expect(second.reasonsSnapshot).toEqual(first.reasonsSnapshot);
  });

  it("completeRestart with an unknown operationId is a safe no-op", () => {
    const store = makeStore();
    expect(store.completeRestart({ operationId: "missing", ok: true })).toBeNull();
  });
});

describe("server/restart-required-state (boot reconciliation)", () => {
  it("closes a running record from another boot as interrupted", () => {
    const stateDir = makeStateDir();
    const storeA = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      getBootId: () => "boot-A",
    });
    storeA.markRequired("env_vars_changed");
    const { operationId } = storeA.beginRestart();

    // "AlphaClaw restarts": a new process with a new bootId reads the record.
    const storeB = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      getBootId: () => "boot-B",
    });
    storeB.reconcileOnBoot();
    expect(storeB.getActiveRestartOperation()).toBeNull();
    const last = storeB.getLastRestartOperation();
    expect(last).toMatchObject({
      operationId,
      status: "interrupted",
      errorSummary: "AlphaClaw restarted before the operation finished",
    });
    // The interrupted reasons were never cleared: they still need a restart.
    expect(last.reasonsSnapshot).toEqual(["env_vars_changed"]);
  });

  it("closes an expired running record as interrupted", () => {
    let nowMs = 50_000;
    const store = makeStore({ now: () => nowMs, getBootId: () => "boot-A" });
    const { operationId } = store.beginRestart();

    nowMs += kGatewayRestartOperationBudgetMs + 1;
    expect(store.getActiveRestartOperation()).toBeNull();
    const last = store.getLastRestartOperation();
    expect(last.operationId).toBe(operationId);
    expect(last.status).toBe("interrupted");
  });

  it("prunes terminal records past retention", () => {
    let nowMs = 100_000;
    const stateDir = makeStateDir();
    const store = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    const { operationId } = store.beginRestart();
    store.completeRestart({ operationId, ok: true });
    expect(store.getLastRestartOperation()).not.toBeNull();

    nowMs += kRestartOperationRetentionMs + 1;
    expect(store.getLastRestartOperation()).toBeNull();
    const operationFile = path.join(
      stateDir,
      "alphaclaw-restart-operation.json",
    );
    expect(fs.existsSync(operationFile)).toBe(false);
  });

  it("durationMs/downtimeMs survive a fresh instance over the same dir (reload previously dropped them)", () => {
    let nowMs = 100_000;
    const stateDir = makeStateDir();
    const storeA = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    const { operationId } = storeA.beginRestart();
    storeA.completeRestart({
      operationId,
      ok: true,
      durationMs: 4200,
      downtimeMs: 3100,
    });

    // Simulated AlphaClaw supervisor restart: a brand-new instance reloads
    // the persisted record — the UI reads these fields from it.
    const storeB = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    storeB.reconcileOnBoot();
    expect(storeB.getLastRestartOperation()).toMatchObject({
      operationId,
      status: "succeeded",
      durationMs: 4200,
      downtimeMs: 3100,
    });
  });

  it("evidenceTail round-trips a reload with a tail-keeping 4000-char cap", () => {
    let nowMs = 100_000;
    const stateDir = makeStateDir();
    const storeA = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    const { operationId } = storeA.beginRestart();
    // Plant the cause line at the very END of an oversized tail: a
    // head-keeping cap would drop it.
    const causeLine = "state-lifecycle lock held by dead pid 57 — cannot start";
    const oversized = `${"noise line\n".repeat(600)}${causeLine}`;
    expect(oversized.length).toBeGreaterThan(4000);
    storeA.completeRestart({
      operationId,
      ok: false,
      errorSummary: "boom",
      evidenceTail: oversized,
    });
    const saved = storeA.getLastRestartOperation();
    expect(saved.evidenceTail.length).toBeLessThanOrEqual(4000);
    expect(saved.evidenceTail.endsWith(causeLine)).toBe(true);

    const storeB = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    storeB.reconcileOnBoot();
    const reloaded = storeB.getLastRestartOperation();
    expect(reloaded.evidenceTail.endsWith(causeLine)).toBe(true);
    // Empty/absent stays absent — never "".
    expect(reloaded.evidenceTail).not.toBe("");
  });

  it("reload guards evidenceTail against corrupted/hand-edited files (non-string, oversized tail-keeping)", () => {
    let nowMs = 100_000;
    const stateDir = makeStateDir();
    const storeA = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    const { operationId } = storeA.beginRestart();
    storeA.completeRestart({ operationId, ok: false, errorSummary: "boom" });

    const operationFile = path.join(
      stateDir,
      "alphaclaw-restart-operation.json",
    );
    // Hand-edit: non-string evidenceTail plus a multi-MB variant.
    const raw = JSON.parse(fs.readFileSync(operationFile, "utf8"));
    raw.evidenceTail = { sneaky: "object" };
    fs.writeFileSync(operationFile, JSON.stringify(raw));
    const storeB = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    storeB.reconcileOnBoot();
    expect(storeB.getLastRestartOperation().evidenceTail).toBeUndefined();

    raw.evidenceTail = `${"x".repeat(3_000_000)}THE-END`;
    fs.writeFileSync(operationFile, JSON.stringify(raw));
    const storeC = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    storeC.reconcileOnBoot();
    const guarded = storeC.getLastRestartOperation().evidenceTail;
    expect(guarded.length).toBe(4000);
    expect(guarded.endsWith("THE-END")).toBe(true);
  });

  it("a legacy (pre-upgrade) operation file without the new fields still loads", () => {
    let nowMs = 100_000;
    const stateDir = makeStateDir();
    const legacy = {
      operationId: "11111111-2222-3333-4444-555555555555",
      kind: "gateway_restart",
      startedAt: nowMs - 1000,
      bootId: "old-boot",
      expiresAt: nowMs + 60_000,
      status: "failed",
      lastStep: "waiting_ready",
      errorSummary: "Gateway did not become ready within 120s",
      completedAt: nowMs - 500,
      reasonsSnapshot: [],
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "alphaclaw-restart-operation.json"),
      JSON.stringify(legacy),
    );
    const store = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    store.reconcileOnBoot();
    const loaded = store.getLastRestartOperation();
    expect(loaded).toMatchObject({
      operationId: legacy.operationId,
      status: "failed",
    });
    expect(loaded.evidenceTail).toBeUndefined();
    expect(loaded.durationMs).toBeUndefined();
  });

  it("updateRestartOperation refreshes expiresAt (queue keepalive) without touching lastStep", () => {
    let nowMs = 10_000;
    const store = makeStore({ now: () => nowMs, getBootId: () => "boot-A" });
    const { operationId } = store.beginRestart();
    store.updateRestartOperation({ operationId, lastStep: "stopping" });

    // Keepalive: expiry extended past the initial budget; lastStep untouched.
    const refreshed = store.updateRestartOperation({
      operationId,
      expiresAt: nowMs + kGatewayRestartOperationBudgetMs * 3,
    });
    expect(refreshed.expiresAt).toBe(
      nowMs + kGatewayRestartOperationBudgetMs * 3,
    );
    expect(refreshed.lastStep).toBe("stopping");

    // The record now survives well past the initial budget...
    nowMs += kGatewayRestartOperationBudgetMs + 1;
    expect(store.getActiveRestartOperation()).not.toBeNull();
    // ...and the eventual completion persists the real outcome + evidence,
    // never "interrupted".
    const done = store.completeRestart({
      operationId,
      ok: false,
      errorSummary: "real failure",
      evidenceTail: "the real cause line",
    });
    expect(done.status).toBe("failed");
    expect(done.evidenceTail).toBe("the real cause line");
    // A non-finite or closed-record refresh is refused.
    expect(
      store.updateRestartOperation({ operationId, expiresAt: nowMs + 1 }),
    ).toBeNull();
  });

  it("prunes stale terminal records at boot in a fresh instance", () => {
    let nowMs = 100_000;
    const stateDir = makeStateDir();
    const storeA = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    const { operationId } = storeA.beginRestart();
    storeA.completeRestart({ operationId, ok: false, errorSummary: "boom" });

    nowMs += kRestartOperationRetentionMs + 1;
    const storeB = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => nowMs,
    });
    storeB.reconcileOnBoot();
    expect(storeB.getLastRestartOperation()).toBeNull();
  });
});
