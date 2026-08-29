const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  deriveTunings,
  applyResourceAutotune,
  getAutotuneLedger,
  acknowledgeResize,
  getGatewayNodeOptionsSuffix,
  getUvThreadpoolSize,
  getAgentConcurrencyCap,
  deriveBodyLimits,
  getSqliteCacheMb,
  getBackupMaxTotalBytes,
  stampGatewayEnvApplied,
  getActiveGatewayHeapMb,
  resetAutotuneForTests,
} = require("../../lib/server/autotune");
const {
  resetMachineProfileForTests,
} = require("../../lib/server/machine-profile");
const { updateAutotuneSettings } = require("../../lib/server/alphaclaw-config");

const kMb = 1024 * 1024;
const kGb = 1024 * kMb;

const makeProfile = ({
  memMb,
  cores,
  diskGb = 40,
  source = "cgroup-v2",
  environment = "container",
} = {}) => ({
  detectedAt: 1,
  memory: { limitBytes: memMb * kMb, source },
  cpu: { cores, hostCores: 16, source: source === "host" ? "host" : "cpu.max" },
  disk: { totalBytes: diskGb * kGb, path: "/" },
  gpu: { present: false },
  tier:
    memMb <= 640
      ? "micro"
      : memMb <= 2048
        ? "small"
        : memMb <= 4096
          ? "medium"
          : memMb <= 8192
            ? "large"
            : "xl",
  environment,
});

// Live-profile control for getter/apply tests: fs-spy the cgroup files the
// machine-profile primitives read (same pattern as machine-profile.test.js).
const spyCgroupFiles = (files) => {
  const realReadFileSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
    const key = String(filePath);
    if (key.startsWith("/sys/fs/cgroup")) {
      if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return realReadFileSync(filePath, ...args);
  });
};

const containerFsModule = {
  existsSync: (p) => String(p) === "/.dockerenv",
  readFileSync: () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
};

const setLiveProfile = ({ memMb, cores, diskGb = 40 }) => {
  spyCgroupFiles({
    "/sys/fs/cgroup/memory.max": `${memMb * kMb}\n`,
    "/sys/fs/cgroup/cpu.max": `${Math.round(cores * 100000)} 100000`,
  });
  vi.spyOn(fs, "statfsSync").mockReturnValue({
    bsize: 4096,
    blocks: (diskGb * kGb) / 4096,
    bfree: ((diskGb / 2) * kGb) / 4096,
  });
  resetMachineProfileForTests({ fsModule: containerFsModule });
};

// In-memory openclaw.json honoring the updateOpenclawConfig mutate contract.
const makeConfigStore = (initial = {}) => {
  const store = { config: initial };
  const fn = vi.fn(({ mutate }) => {
    const result = mutate(store.config) || {};
    return { config: store.config, ...result };
  });
  return { store, fn };
};

const makeTempDirs = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "autotune-test-"));
  const openclawDir = path.join(base, ".openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  return { base, openclawDir, managedDir };
};

describe("server/autotune", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMachineProfileForTests();
    resetAutotuneForTests();
  });

  it("derives the golden table across the boundary matrix", () => {
    const expectations = [
      {
        memMb: 512,
        cores: 0.5,
        heap: 256,
        uv: 4,
        cap: 8,
        boot: 8,
        openai: 20,
        local: 5,
        sqlite: 4,
        admin: null,
      },
      {
        memMb: 2048,
        cores: 1,
        heap: 1024,
        uv: 4,
        cap: 8,
        boot: 8,
        openai: 20,
        local: 5,
        sqlite: 16,
        admin: 512,
      },
      {
        memMb: 8192,
        cores: 4,
        heap: 4096,
        uv: 8,
        cap: 32,
        boot: 32,
        openai: 48,
        local: 10,
        sqlite: 64,
        admin: 2048,
      },
      {
        memMb: 32768,
        cores: 16,
        heap: 8192,
        uv: 16,
        cap: 128,
        boot: 32,
        openai: 64,
        local: 10,
        sqlite: 64,
        admin: 2048,
      },
    ];
    for (const row of expectations) {
      const { suppressed, values } = deriveTunings(
        makeProfile({ memMb: row.memMb, cores: row.cores }),
        {},
      );
      expect(suppressed).toBe(false);
      expect(values.gatewayHeapMb, `heap @${row.memMb}`).toBe(row.heap);
      expect(values.uvThreadpoolSize, `uv @${row.memMb}`).toBe(row.uv);
      expect(values.agentConcurrencyCap, `cap @${row.memMb}`).toBe(row.cap);
      expect(values.bootMaxConcurrent, `boot @${row.memMb}`).toBe(row.boot);
      expect(values.openAiCompatBodyLimitMb).toBe(row.openai);
      expect(values.localBodyLimitMb).toBe(row.local);
      expect(values.sqliteCacheMb).toBe(row.sqlite);
      expect(values.adminHeapRecommendedMb).toBe(row.admin);
    }
  });

  it("clamps overrides to the live machine and records the clamp", () => {
    const { values, notes } = deriveTunings(
      makeProfile({ memMb: 2048, cores: 1 }),
      { overrides: { gatewayHeapMb: 16384 } },
    );
    // 0.85 × 2048 = 1741 — an override larger than the box is an OOM
    // instruction, not a preference.
    expect(values.gatewayHeapMb).toBe(1741);
    expect(notes.gatewayHeapMb).toEqual({
      clamped: true,
      requested: 16384,
      applied: 1741,
    });

    // In-range overrides pass through with no note.
    const inRange = deriveTunings(makeProfile({ memMb: 8192, cores: 4 }), {
      overrides: { gatewayHeapMb: 6144, agentConcurrencyCap: 64 },
    });
    expect(inRange.values.gatewayHeapMb).toBe(6144);
    expect(inRange.values.agentConcurrencyCap).toBe(64);
    expect(inRange.notes).toEqual({});
  });

  it("suppresses derivation on host values inside a container, tunes on bare metal", () => {
    const suppressed = deriveTunings(
      makeProfile({ memMb: 65536, cores: 16, source: "host", environment: "container" }),
      {},
    );
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.reason).toBe("container_limits_unavailable");

    const unknown = deriveTunings(
      makeProfile({ memMb: 65536, cores: 16, source: "host", environment: "unknown" }),
      {},
    );
    expect(unknown.suppressed).toBe(true);

    const bareMetal = deriveTunings(
      makeProfile({ memMb: 16384, cores: 8, source: "host", environment: "bare-metal" }),
      {},
    );
    expect(bareMetal.suppressed).toBe(false);
    expect(bareMetal.values.gatewayHeapMb).toBe(8192);
  });

  it("getters return derived values when active and null when disabled or kill-switched", () => {
    const { openclawDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 1 });
    const options = { openclawDir, env: {} };

    expect(getGatewayNodeOptionsSuffix(options)).toBe("--max-old-space-size=1024");
    expect(getUvThreadpoolSize(options)).toBe(4);
    expect(getAgentConcurrencyCap(options)).toBe(8);
    expect(deriveBodyLimits(options)).toEqual({ openAiCompat: "20mb", local: "5mb" });
    expect(getSqliteCacheMb(options)).toBe(16);
    expect(getBackupMaxTotalBytes(options)).toBe(8 * kGb); // 20% of 40GB disk... via statfs

    // Kill-switch wins over config.
    const killed = { openclawDir, env: { ALPHACLAW_AUTOTUNE_DISABLED: "1" } };
    expect(getGatewayNodeOptionsSuffix(killed)).toBeNull();
    expect(getUvThreadpoolSize(killed)).toBeNull();
    expect(getAgentConcurrencyCap(killed)).toBeNull();
    expect(deriveBodyLimits(killed)).toBeNull();
    expect(getSqliteCacheMb(killed)).toBeNull();

    // Config disable.
    updateAutotuneSettings({ openclawDir, enabled: false });
    expect(getGatewayNodeOptionsSuffix(options)).toBeNull();
    expect(getBackupMaxTotalBytes(options)).toBeNull();
  });

  it("adopts an absent concurrency key with intent-first ownership and stamps env rows", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    resetAutotuneForTests({ managedDir });
    const { store, fn } = makeConfigStore({});
    const events = [];

    const ledger = await applyResourceAutotune({
      trigger: "boot",
      deps: {
        env: {},
        openclawDir,
        updateOpenclawConfigFn: fn,
        emitWatchdogEvent: (e) => events.push(e),
      },
    });

    expect(store.config.agents.defaults.maxConcurrent).toBe(32);
    const concurrencyRow = ledger.rows.find((r) => r.knob === "agentConcurrencyCap");
    expect(concurrencyRow).toMatchObject({
      status: "pending_restart",
      restartTarget: "gateway",
      effectiveValue: 32,
      verified: true,
    });
    // Persisted ownership survives a fresh in-memory state (new boot).
    const persisted = JSON.parse(
      fs.readFileSync(path.join(managedDir, "autotune-ledger.json"), "utf8"),
    );
    expect(persisted.ownedKeys["agents.defaults.maxConcurrent"]).toEqual({
      ownedFromAbsent: true,
      lastApplied: 32,
    });

    // Gateway-env rows are pending until a spawn consumes them...
    const heapRow = ledger.rows.find((r) => r.knob === "gatewayHeapMb");
    expect(heapRow).toMatchObject({ status: "pending_restart", restartTarget: "gateway" });
    // ...then the SPAWN STAMP ALONE flips them (adversarial-review P1: no
    // apply trigger fires on a gateway restart, so the stamp must rebuild the
    // rows or the card stays amber for the whole admin-process lifetime).
    stampGatewayEnvApplied({ gatewayHeapMb: 4096, uvThreadpoolSize: 8 });
    expect(getActiveGatewayHeapMb()).toBe(4096);
    const stamped = getAutotuneLedger();
    expect(stamped.rows.find((r) => r.knob === "gatewayHeapMb").status).toBe("applied");
    expect(stamped.rows.find((r) => r.knob === "uvThreadpoolSize").status).toBe("applied");
    // The spawn also consumed the openclaw.json boot default.
    expect(stamped.rows.find((r) => r.knob === "agentConcurrencyCap").status).toBe(
      "applied",
    );
    // An unchanged reapply keeps "applied" (satisfiedAt survives) instead of
    // regressing to a fresh pending_restart on every apply.
    const after = await applyResourceAutotune({
      trigger: "reapply",
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
    });
    expect(after.rows.find((r) => r.knob === "gatewayHeapMb").status).toBe("applied");
    expect(after.rows.find((r) => r.knob === "uvThreadpoolSize").status).toBe("applied");
    expect(after.rows.find((r) => r.knob === "agentConcurrencyCap").status).toBe(
      "applied",
    );
  });

  it("clears a stale spawn stamp when a spawn consumed no autotune values", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    resetAutotuneForTests({ managedDir });
    stampGatewayEnvApplied({ gatewayHeapMb: 4096, uvThreadpoolSize: 8 });
    expect(getActiveGatewayHeapMb()).toBe(4096);

    // Disabled/kill-switched spawn: gateway.js stamps nulls — the old stamp
    // must not keep describing a heap the running gateway never consumed
    // (medic prompt + false "applied" rows on re-enable).
    stampGatewayEnvApplied({ gatewayHeapMb: null, uvThreadpoolSize: null });
    expect(getActiveGatewayHeapMb()).toBeNull();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(managedDir, "autotune-ledger.json"), "utf8"),
    );
    expect(persisted.activeGatewayEnv).toBeNull();

    // Re-enable: rows correctly report pending, not falsely applied.
    const { fn } = makeConfigStore({});
    const ledger = await applyResourceAutotune({
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
    });
    expect(ledger.rows.find((r) => r.knob === "gatewayHeapMb").status).toBe(
      "pending_restart",
    );
  });

  it("keeps the restart signal on clamped overrides (clamped is a flag, not a status)", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 1 });
    resetAutotuneForTests({ managedDir });
    updateAutotuneSettings({ openclawDir, overrides: { gatewayHeapMb: 16384 } });
    const { fn } = makeConfigStore({});
    const ledger = await applyResourceAutotune({
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
    });
    const row = ledger.rows.find((r) => r.knob === "gatewayHeapMb");
    // 0.85×2048 = 1741, gateway not yet restarted: BOTH facts must survive.
    expect(row).toMatchObject({
      value: 1741,
      status: "pending_restart",
      restartTarget: "gateway",
      clamped: true,
    });
    expect(row.reason).toContain("16384");
  });

  it("reports an operator-set UV_THREADPOOL_SIZE as manual, never endlessly pending", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({});
    process.env.UV_THREADPOOL_SIZE = "32";
    try {
      const ledger = await applyResourceAutotune({
        deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
      });
      const row = ledger.rows.find((r) => r.knob === "uvThreadpoolSize");
      expect(row).toMatchObject({
        status: "manual",
        restartTarget: null,
        effectiveValue: 32,
      });
      expect(row.reason).toContain("operator-set");
    } finally {
      delete process.env.UV_THREADPOOL_SIZE;
    }
  });

  it("clamps a >64 concurrency back to the legacy ceiling on disable, even when not owned", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 32768, cores: 16 });
    resetAutotuneForTests({ managedDir });
    // A telegram sync under the raised cap wrote 90 — not ledger-owned.
    const { store, fn } = makeConfigStore({
      agents: { defaults: { maxConcurrent: 90, subagents: { maxConcurrent: 88 } } },
    });
    await applyResourceAutotune({
      deps: {
        openclawDir,
        updateOpenclawConfigFn: fn,
        env: { ALPHACLAW_AUTOTUNE_DISABLED: "1" },
      },
    });
    // Pre-feature nothing could write >64; the oversize came from autotune's
    // cap, so disable restores the legacy invariant. Sub-64 operator values
    // are left alone (covered by the owned-from-absent revert test).
    expect(store.config.agents.defaults.maxConcurrent).toBe(64);
    expect(store.config.agents.defaults.subagents.maxConcurrent).toBe(62);
  });

  it("does not notify or mark restart-required on a resize while autotune is off", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 1 });
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({});
    const killed = { ALPHACLAW_AUTOTUNE_DISABLED: "1" };
    await applyResourceAutotune({
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: killed },
    });

    vi.restoreAllMocks();
    setLiveProfile({ memMb: 8192, cores: 4 });
    const events = [];
    const notes = [];
    let restartMarked = false;
    const ledger = await applyResourceAutotune({
      refreshProfile: true,
      deps: {
        openclawDir,
        updateOpenclawConfigFn: fn,
        env: killed,
        emitWatchdogEvent: (e) => events.push(e),
        notify: (m) => notes.push(m),
        markRestartRequired: () => {
          restartMarked = true;
        },
      },
    });
    // Capacity history is still recorded, but pre-acknowledged (no banner
    // demanding a restart that would apply nothing) and silent.
    expect(ledger.lastResize).toMatchObject({ acknowledged: true });
    expect(events).toEqual([]);
    expect(notes).toEqual([]);
    expect(restartMarked).toBe(false);
  });

  it("survives a valid-JSON ledger with a broken shape", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 1 });
    fs.writeFileSync(path.join(managedDir, "autotune-ledger.json"), "[1,2,3]", "utf8");
    resetAutotuneForTests({ managedDir });
    const { store, fn } = makeConfigStore({});
    const ledger = await applyResourceAutotune({
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
    });
    expect(ledger.rows.length).toBeGreaterThan(0);
    expect(store.config.agents.defaults.maxConcurrent).toBe(8);
  });

  it("relinquishes ownership when the operator changes the value", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    resetAutotuneForTests({ managedDir });
    const { store, fn } = makeConfigStore({});

    await applyResourceAutotune({ deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} } });
    expect(store.config.agents.defaults.maxConcurrent).toBe(32);

    // Operator (or telegram sync) moves the value out from under us.
    store.config.agents.defaults.maxConcurrent = 50;
    const ledger = await applyResourceAutotune({
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
    });
    expect(store.config.agents.defaults.maxConcurrent).toBe(50); // untouched
    const row = ledger.rows.find((r) => r.knob === "agentConcurrencyCap");
    expect(row.status).toBe("manual");
    expect(row.effectiveValue).toBe(50);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(managedDir, "autotune-ledger.json"), "utf8"),
    );
    expect(persisted.ownedKeys["agents.defaults.maxConcurrent"]).toBeUndefined();
  });

  it("never adopts a foreign value and records it as manual", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 1 });
    resetAutotuneForTests({ managedDir });
    const { store, fn } = makeConfigStore({ agents: { defaults: { maxConcurrent: 64 } } });

    const ledger = await applyResourceAutotune({
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
    });
    expect(store.config.agents.defaults.maxConcurrent).toBe(64);
    expect(ledger.rows.find((r) => r.knob === "agentConcurrencyCap")).toMatchObject({
      status: "manual",
      effectiveValue: 64,
    });
  });

  it("skips the concurrency write on JSON5 configs with a human-first reason and an event", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 1 });
    resetAutotuneForTests({ managedDir });
    const events = [];
    const failing = vi.fn(() => {
      const error = new Error("unparseable");
      error.name = "OpenclawConfigReadError";
      throw error;
    });

    const ledger = await applyResourceAutotune({
      deps: {
        env: {},
        openclawDir,
        updateOpenclawConfigFn: failing,
        emitWatchdogEvent: (e) => events.push(e),
      },
    });
    const row = ledger.rows.find((r) => r.knob === "agentConcurrencyCap");
    expect(row.status).toBe("skipped");
    expect(row.reason).toContain("JSON5");
    expect(events.some((e) => e.eventType === "autotune")).toBe(true);
  });

  it("reverts an owned-from-absent key on disable AND on the env kill-switch", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    resetAutotuneForTests({ managedDir });
    const { store, fn } = makeConfigStore({});

    await applyResourceAutotune({ deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} } });
    expect(store.config.agents.defaults.maxConcurrent).toBe(32);

    // Kill-switch boot: the owned key is deleted (pre-feature semantics),
    // ownership cleared.
    const ledger = await applyResourceAutotune({
      deps: {
        env: {},
        openclawDir,
        updateOpenclawConfigFn: fn,
        env: { ALPHACLAW_AUTOTUNE_DISABLED: "1" },
      },
    });
    expect(store.config.agents.defaults.maxConcurrent).toBeUndefined();
    expect(ledger.enabled).toBe(false);
    expect(ledger.rows).toEqual([]);

    // Re-enable adopts again; config disable reverts the same way.
    await applyResourceAutotune({ deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} } });
    expect(store.config.agents.defaults.maxConcurrent).toBe(32);
    updateAutotuneSettings({ openclawDir, enabled: false });
    await applyResourceAutotune({ deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} } });
    expect(store.config.agents.defaults.maxConcurrent).toBeUndefined();
  });

  it("refuses to adopt when the ledger intent cannot be persisted", async () => {
    const { openclawDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 1 });
    // Managed dir that cannot be created/written.
    const brokenFs = {
      ...fs,
      readFileSync: fs.readFileSync,
      mkdirSync: () => {
        throw new Error("EACCES");
      },
      writeFileSync: () => {
        throw new Error("EACCES");
      },
    };
    resetAutotuneForTests({ fsModule: brokenFs, managedDir: "/nonexistent/autotune" });
    const { store, fn } = makeConfigStore({});

    const ledger = await applyResourceAutotune({
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
    });
    // No adoption: we must not create ownership we could lose track of.
    expect(store.config.agents?.defaults?.maxConcurrent).toBeUndefined();
    const row = ledger.rows.find((r) => r.knob === "agentConcurrencyCap");
    expect(row.status).toBe("manual");
    expect(row.reason).toContain("ledger not writable");
  });

  it("detects capacity resizes, notifies, and supports acknowledgement", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 1 });
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({});
    const events = [];
    const notes = [];

    await applyResourceAutotune({ deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} } });
    expect(getAutotuneLedger().lastResize).toBeNull();

    // Container resized between applies.
    vi.restoreAllMocks();
    setLiveProfile({ memMb: 8192, cores: 4 });
    let promptSynced = false;
    const ledger = await applyResourceAutotune({
      refreshProfile: true,
      deps: {
        env: {},
        openclawDir,
        updateOpenclawConfigFn: fn,
        emitWatchdogEvent: (e) => events.push(e),
        notify: (m) => notes.push(m),
        syncPromptFiles: () => {
          promptSynced = true;
        },
      },
    });
    expect(ledger.lastResize).toMatchObject({ acknowledged: false });
    expect(ledger.lastResize.from.memoryLimitBytes).toBe(2048 * kMb);
    expect(ledger.lastResize.to.memoryLimitBytes).toBe(8192 * kMb);
    expect(events.some((e) => String(e.message).includes("resized"))).toBe(true);
    expect(notes.some((m) => String(m).includes("resized"))).toBe(true);
    expect(promptSynced).toBe(true);

    expect(acknowledgeResize()).toBe(true);
    expect(getAutotuneLedger().lastResize.acknowledged).toBe(true);
    expect(acknowledgeResize()).toBe(false);
  });

  it("stampGatewayEnvApplied never throws on ledger IO failure", () => {
    const brokenFs = {
      ...fs,
      mkdirSync: () => {
        throw new Error("EACCES");
      },
      writeFileSync: () => {
        throw new Error("EACCES");
      },
      readFileSync: () => {
        throw new Error("EACCES");
      },
    };
    resetAutotuneForTests({ fsModule: brokenFs, managedDir: "/nonexistent" });
    expect(() =>
      stampGatewayEnvApplied({ gatewayHeapMb: 1024, uvThreadpoolSize: 4 }),
    ).not.toThrow();
    expect(getActiveGatewayHeapMb()).toBe(1024);
  });

  it("holds defaults (all rows skipped) when suppressed inside a container", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    // Host values + container marker: cgroup limit files absent.
    spyCgroupFiles({});
    resetMachineProfileForTests({ fsModule: containerFsModule });
    resetAutotuneForTests({ managedDir });
    const { store, fn } = makeConfigStore({});

    const ledger = await applyResourceAutotune({
      deps: { openclawDir, updateOpenclawConfigFn: fn, env: {} },
    });
    expect(ledger.suppressed).toBe(true);
    expect(store.config.agents?.defaults?.maxConcurrent).toBeUndefined();
    expect(ledger.rows.length).toBeGreaterThan(0);
    expect(ledger.rows.every((r) => r.status === "skipped")).toBe(true);
    expect(getGatewayNodeOptionsSuffix({ openclawDir, env: {} })).toBeNull();
  });
});
