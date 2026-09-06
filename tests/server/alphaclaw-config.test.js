const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  isOpenAiCompatApiEnabled,
  readAlphaclawConfig,
  readAutotuneEnabled,
  readAutotuneSettings,
  readDoctorAutoRunEnabled,
  readDoctorScanConfig,
  updateDoctorScanConfig,
  updateDoctorSettingsConfig,
  readOpenclawMedicEnabled,
  readOpenclawReleaseChannel,
  readWatchdogOverseerEnabled,
  readWatchdogMemorySettings,
  updateWatchdogMemorySettings,
  updateAutotuneSettings,
  updateDoctorAutoRunEnabled,
  updateOpenAiCompatApiFeature,
  updateOpenclawMedicEnabled,
  updateOpenclawReleaseChannel,
  updateWatchdogOverseerEnabled,
  writeAlphaclawConfig,
} = require("../../lib/server/alphaclaw-config");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-config-test-"));

describe("server/alphaclaw-config", () => {
  it("defaults the OpenAI-compatible API feature to disabled when config is missing", () => {
    const openclawDir = createTempOpenclawDir();

    expect(isOpenAiCompatApiEnabled({ openclawDir })).toBe(false);
    expect(readAlphaclawConfig({ openclawDir }).features.openaiCompatApi).toEqual({
      enabled: false,
    });
  });

  it("keys the read cache on the READER identity, not just mtime/size (merge resolution)", () => {
    const openclawDir = createTempOpenclawDir();
    updateOpenAiCompatApiFeature({ openclawDir, enabled: true });
    // Warm the cache through the real fs reader.
    expect(isOpenAiCompatApiEnabled({ openclawDir })).toBe(true);

    // Same path, same on-disk stat — but a swapped reader (a per-test fs
    // mock) must never be served the previous reader's parse.
    const mockFs = {
      statSync: fs.statSync,
      readFileSync: () =>
        JSON.stringify({ features: { openaiCompatApi: { enabled: false } } }),
    };
    expect(isOpenAiCompatApiEnabled({ fsModule: mockFs, openclawDir })).toBe(
      false,
    );
    // And switching back re-reads through the real fs again.
    expect(isOpenAiCompatApiEnabled({ openclawDir })).toBe(true);
  });

  it("defaults to disabled when alphaclaw.json is malformed", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(path.join(openclawDir, "alphaclaw.json"), "{broken", "utf8");

    expect(isOpenAiCompatApiEnabled({ openclawDir })).toBe(false);
  });

  it("persists the explicit API feature toggle in alphaclaw.json", () => {
    const openclawDir = createTempOpenclawDir();

    const result = updateOpenAiCompatApiFeature({ openclawDir, enabled: true });

    expect(result.changed).toBe(true);
    expect(result.config.features.openaiCompatApi.enabled).toBe(true);
    expect(isOpenAiCompatApiEnabled({ openclawDir })).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(openclawDir, "alphaclaw.json"), "utf8")),
    ).toEqual({
      features: {
        openaiCompatApi: {
          enabled: true,
        },
        agentAdmin: {
          enabled: false,
        },
      },
      updates: {
        openclaw: {
          releaseChannel: "stable",
          overseer: { enabled: false },
          medic: { enabled: true },
        },
      },
      team: {
        enabled: false,
        disableLegacyLogin: false,
      },
      watchdog: {
        overseer: { enabled: false },
        memory: {
          enabled: true,
          autoRestart: false,
          budgetMb: null,
          maxRestartsPerDay: 2,
        },
      },
      doctor: {
        autoRun: { enabled: false },
        scan: { maxFiles: null, maxFileMb: null },
      },
      autotune: {
        enabled: true,
        overrides: {},
      },
    });
  });

  it("preserves unknown keys while updating the feature flag", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "alphaclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        custom: { keep: true },
        features: {
          futureFeature: { enabled: true },
          openaiCompatApi: { enabled: true, note: "keep" },
        },
      }),
      "utf8",
    );

    updateOpenAiCompatApiFeature({ openclawDir, enabled: false });

    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      custom: { keep: true },
      features: {
        futureFeature: { enabled: true },
        openaiCompatApi: { enabled: false, note: "keep" },
        agentAdmin: { enabled: false },
      },
      updates: {
        openclaw: {
          releaseChannel: "stable",
          overseer: { enabled: false },
          medic: { enabled: true },
        },
      },
      team: {
        enabled: false,
        disableLegacyLogin: false,
      },
      watchdog: {
        overseer: { enabled: false },
        memory: {
          enabled: true,
          autoRestart: false,
          budgetMb: null,
          maxRestartsPerDay: 2,
        },
      },
      doctor: {
        autoRun: { enabled: false },
        scan: { maxFiles: null, maxFileMb: null },
      },
      autotune: {
        enabled: true,
        overrides: {},
      },
    });
  });

  it("defaults the OpenClaw release channel to stable", () => {
    const openclawDir = createTempOpenclawDir();

    expect(readOpenclawReleaseChannel({ openclawDir })).toBe("stable");
  });

  it("normalizes an invalid release channel back to stable", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ updates: { openclaw: { releaseChannel: "nightly" } } }),
      "utf8",
    );

    expect(readOpenclawReleaseChannel({ openclawDir })).toBe("stable");
  });

  it("persists a release-channel change and reports changed", () => {
    const openclawDir = createTempOpenclawDir();

    const first = updateOpenclawReleaseChannel({
      openclawDir,
      releaseChannel: "dev",
    });
    expect(first.changed).toBe(true);
    expect(readOpenclawReleaseChannel({ openclawDir })).toBe("dev");

    const second = updateOpenclawReleaseChannel({
      openclawDir,
      releaseChannel: "dev",
    });
    expect(second.changed).toBe(false);

    const invalid = updateOpenclawReleaseChannel({
      openclawDir,
      releaseChannel: "nightly",
    });
    expect(invalid.config.updates.openclaw.releaseChannel).toBe("stable");
  });

  it("defaults the startup medic to ENABLED (opt-out, unlike the overseer)", () => {
    const openclawDir = createTempOpenclawDir();
    // Missing config, missing updates block, and junk all normalize to on.
    expect(readOpenclawMedicEnabled({ openclawDir })).toBe(true);

    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ updates: { openclaw: { medic: { enabled: "no" } } } }),
      "utf8",
    );
    expect(readOpenclawMedicEnabled({ openclawDir })).toBe(true);

    // Only a literal false disables it.
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ updates: { openclaw: { medic: { enabled: false } } } }),
      "utf8",
    );
    expect(readOpenclawMedicEnabled({ openclawDir })).toBe(false);
  });

  it("fails CLOSED on a corrupt config instead of re-enabling a disabled medic", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "alphaclaw.json");

    // Operator turned the medic off, then the file gets torn/corrupted.
    updateOpenclawMedicEnabled({ openclawDir, enabled: false });
    fs.writeFileSync(configPath, '{ "updates": { "openclaw": { "medic":', "utf8");

    // The generic defaults would say enabled — the medic gate must not.
    expect(readOpenclawMedicEnabled({ openclawDir })).toBe(false);
  });

  it("persists the medic toggle and reports changed", () => {
    const openclawDir = createTempOpenclawDir();

    const off = updateOpenclawMedicEnabled({ openclawDir, enabled: false });
    expect(off.changed).toBe(true);
    expect(readOpenclawMedicEnabled({ openclawDir })).toBe(false);

    const again = updateOpenclawMedicEnabled({ openclawDir, enabled: false });
    expect(again.changed).toBe(false);

    const on = updateOpenclawMedicEnabled({ openclawDir, enabled: true });
    expect(on.changed).toBe(true);
    expect(readOpenclawMedicEnabled({ openclawDir })).toBe(true);
  });

  it("defaults scheduled Doctor scans to OFF (opt-in, spends user tokens)", () => {
    const openclawDir = createTempOpenclawDir();
    expect(readDoctorAutoRunEnabled({ openclawDir })).toBe(false);
  });

  it("persists the Doctor auto-run toggle round-trip", () => {
    const openclawDir = createTempOpenclawDir();

    expect(updateDoctorAutoRunEnabled({ openclawDir, enabled: true })).toBe(true);
    expect(readDoctorAutoRunEnabled({ openclawDir })).toBe(true);

    expect(updateDoctorAutoRunEnabled({ openclawDir, enabled: false })).toBe(false);
    expect(readDoctorAutoRunEnabled({ openclawDir })).toBe(false);
  });

  it("normalizes anything but literal true to off for Doctor auto-run", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ doctor: { autoRun: { enabled: "yes" } } }),
      "utf8",
    );
    expect(readDoctorAutoRunEnabled({ openclawDir })).toBe(false);
    expect(readAlphaclawConfig({ openclawDir }).doctor.autoRun.enabled).toBe(false);

    // Truthy-but-not-true through the updater is also normalized off.
    expect(updateDoctorAutoRunEnabled({ openclawDir, enabled: 1 })).toBe(false);
    expect(readDoctorAutoRunEnabled({ openclawDir })).toBe(false);
  });

  it("writes alphaclaw.json atomically: temp file in the same dir, then rename", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "alphaclaw.json");
    const writes = [];
    const renames = [];
    const fsModule = {
      ...fs,
      writeFileSync: vi.fn((target, ...rest) => {
        writes.push(String(target));
        return fs.writeFileSync(target, ...rest);
      }),
      renameSync: vi.fn((from, to) => {
        renames.push([String(from), String(to)]);
        return fs.renameSync(from, to);
      }),
    };

    const written = writeAlphaclawConfig({
      fsModule,
      openclawDir,
      config: { team: { enabled: true } },
    });

    // The final path is NEVER written directly — a crash mid-write must not
    // leave a torn alphaclaw.json (readAlphaclawConfig would silently fall
    // back to defaults). Only a same-dir temp file, then a rename over it.
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toBe(configPath);
    expect(path.dirname(writes[0])).toBe(openclawDir);
    expect(renames).toEqual([[writes[0], configPath]]);
    // What landed on disk is valid JSON and round-trips through the reader.
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).team.enabled).toBe(true);
    expect(written.team.enabled).toBe(true);
    expect(readAlphaclawConfig({ openclawDir }).team.enabled).toBe(true);
  });

  it("leaves the previous config intact when the atomic rename fails", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "alphaclaw.json");
    updateOpenAiCompatApiFeature({ openclawDir, enabled: true });
    const before = fs.readFileSync(configPath, "utf8");
    const fsModule = {
      ...fs,
      renameSync: vi.fn(() => {
        throw new Error("EIO: rename failed");
      }),
    };

    expect(() =>
      writeAlphaclawConfig({
        fsModule,
        openclawDir,
        config: { features: { openaiCompatApi: { enabled: false } } },
      }),
    ).toThrow("EIO: rename failed");

    // Target untouched (old, valid JSON) and the temp file cleaned up.
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(fs.readdirSync(openclawDir)).toEqual(["alphaclaw.json"]);
    expect(isOpenAiCompatApiEnabled({ openclawDir })).toBe(true);
  });

  it("normalizes doctor scan caps: clamp/reject matrix", () => {
    const openclawDir = createTempOpenclawDir();
    // Hand-edited out-of-bounds / wrong-type values normalize to null
    // (built-in default) — storage never surprises the scanner.
    const cases = [
      [{ maxFiles: 999, maxFileMb: 0 }, { maxFiles: null, maxFileMb: null }],
      [{ maxFiles: 500001, maxFileMb: 101 }, { maxFiles: null, maxFileMb: null }],
      [{ maxFiles: 1.5, maxFileMb: "big" }, { maxFiles: null, maxFileMb: null }],
      [{ maxFiles: 1000, maxFileMb: 1 }, { maxFiles: 1000, maxFileMb: 1 }],
      [{ maxFiles: 500000, maxFileMb: 100 }, { maxFiles: 500000, maxFileMb: 100 }],
      [{}, { maxFiles: null, maxFileMb: null }],
    ];
    for (const [stored, expected] of cases) {
      fs.writeFileSync(
        path.join(openclawDir, "alphaclaw.json"),
        JSON.stringify({ doctor: { scan: stored } }),
        "utf8",
      );
      expect(readDoctorScanConfig({ openclawDir })).toEqual(expected);
    }
  });

  it("updates doctor scan caps partially and resets on null", () => {
    const openclawDir = createTempOpenclawDir();
    expect(updateDoctorScanConfig({ openclawDir, maxFiles: 300000 })).toEqual({
      maxFiles: 300000,
      maxFileMb: null,
    });
    // Partial update leaves the other cap untouched.
    expect(updateDoctorScanConfig({ openclawDir, maxFileMb: 25 })).toEqual({
      maxFiles: 300000,
      maxFileMb: 25,
    });
    // null resets to the built-in default.
    expect(updateDoctorScanConfig({ openclawDir, maxFiles: null })).toEqual({
      maxFiles: null,
      maxFileMb: 25,
    });
    expect(readDoctorScanConfig({ openclawDir })).toEqual({
      maxFiles: null,
      maxFileMb: 25,
    });
    // Scan updates never disturb sibling doctor settings.
    expect(readDoctorAutoRunEnabled({ openclawDir })).toBe(false);
  });

  it("preserves unknown doctor keys through an auto-run update", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ doctor: { futureKnob: "keep-me", autoRun: { enabled: false } } }),
      "utf8",
    );
    updateDoctorAutoRunEnabled({ openclawDir, enabled: true });
    const written = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "alphaclaw.json"), "utf8"),
    );
    expect(written.doctor.futureKnob).toBe("keep-me");
    expect(written.doctor.autoRun.enabled).toBe(true);
  });

  it("defaults the watchdog overseer to DISABLED and normalizes anything but literal true", () => {
    const openclawDir = createTempOpenclawDir();
    // Missing config, missing watchdog block → off.
    expect(readWatchdogOverseerEnabled({ openclawDir })).toBe(false);

    // Truthy junk must NOT enable an off-by-default LLM feature.
    for (const junk of ["true", 1, "yes", {}, []]) {
      fs.writeFileSync(
        path.join(openclawDir, "alphaclaw.json"),
        JSON.stringify({ watchdog: { overseer: { enabled: junk } } }),
        "utf8",
      );
      expect(readWatchdogOverseerEnabled({ openclawDir })).toBe(false);
    }

    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ watchdog: { overseer: { enabled: true } } }),
      "utf8",
    );
    expect(readWatchdogOverseerEnabled({ openclawDir })).toBe(true);
  });

  it("persists the watchdog overseer toggle, reports changed, and keeps foreign watchdog keys", () => {
    const openclawDir = createTempOpenclawDir();
    // A future sibling key under watchdog must survive the toggle write.
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ watchdog: { futureKnob: 7, overseer: { model: "x" } } }),
      "utf8",
    );

    const on = updateWatchdogOverseerEnabled({ openclawDir, enabled: true });
    expect(on.changed).toBe(true);
    expect(readWatchdogOverseerEnabled({ openclawDir })).toBe(true);

    const again = updateWatchdogOverseerEnabled({ openclawDir, enabled: true });
    expect(again.changed).toBe(false);

    const off = updateWatchdogOverseerEnabled({ openclawDir, enabled: false });
    expect(off.changed).toBe(true);
    expect(readWatchdogOverseerEnabled({ openclawDir })).toBe(false);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "alphaclaw.json"), "utf8"),
    );
    expect(persisted.watchdog.futureKnob).toBe(7);
    expect(persisted.watchdog.overseer.model).toBe("x");
  });

  it("defaults autotune to enabled (opt-out) and normalizes overrides strictly", () => {
    const openclawDir = createTempOpenclawDir();

    expect(readAutotuneEnabled({ openclawDir })).toBe(true);
    expect(readAutotuneSettings({ openclawDir })).toEqual({
      enabled: true,
      overrides: {},
    });

    const configPath = path.join(openclawDir, "alphaclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        autotune: {
          enabled: "yes", // not literal false → enabled
          overrides: {
            gatewayHeapMb: 2048,
            uvThreadpoolSize: 200, // out of bounds → dropped
            agentConcurrencyCap: "64", // numeric string → accepted
            unknownKnob: 5, // unknown → dropped
            openAiCompatBodyLimitMb: 12.5, // non-integer → dropped
          },
        },
      }),
      "utf8",
    );
    expect(readAutotuneSettings({ openclawDir })).toEqual({
      enabled: true,
      overrides: { gatewayHeapMb: 2048, agentConcurrencyCap: 64 },
    });
  });

  it("fails CLOSED on a corrupt config for the default-ON autotune gate", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      "{ not json",
      "utf8",
    );
    expect(readAutotuneEnabled({ openclawDir })).toBe(false);
  });

  it("fails CLOSED on a non-ENOENT stat failure — only a missing file is a fresh install", () => {
    const openclawDir = createTempOpenclawDir();
    // The operator's enabled:false may be INSIDE the unreadable file — a
    // transient EACCES/EIO must not flip the default-ON feature back on.
    const eaccesFs = {
      ...fs,
      statSync: () => {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      },
    };
    expect(readAutotuneEnabled({ openclawDir, fsModule: eaccesFs })).toBe(false);

    // A genuinely missing file keeps the fresh-install default.
    const enoentFs = {
      ...fs,
      statSync: () => {
        throw Object.assign(new Error("ENOENT: no such file"), {
          code: "ENOENT",
        });
      },
    };
    expect(readAutotuneEnabled({ openclawDir, fsModule: enoentFs })).toBe(true);
  });

  it("merges autotune overrides per key and clears with null", () => {
    const openclawDir = createTempOpenclawDir();

    updateAutotuneSettings({
      openclawDir,
      overrides: { gatewayHeapMb: 1024, sqliteCacheMb: 16 },
    });
    // Saving one key must not erase siblings.
    const second = updateAutotuneSettings({
      openclawDir,
      overrides: { gatewayHeapMb: 2048 },
    });
    expect(second.changed).toBe(true);
    expect(readAutotuneSettings({ openclawDir }).overrides).toEqual({
      gatewayHeapMb: 2048,
      sqliteCacheMb: 16,
    });

    // Explicit null clears exactly one key.
    updateAutotuneSettings({ openclawDir, overrides: { gatewayHeapMb: null } });
    expect(readAutotuneSettings({ openclawDir }).overrides).toEqual({
      sqliteCacheMb: 16,
    });

    const disabled = updateAutotuneSettings({ openclawDir, enabled: false });
    expect(disabled.changed).toBe(true);
    expect(readAutotuneEnabled({ openclawDir })).toBe(false);

    const noop = updateAutotuneSettings({ openclawDir, enabled: false });
    expect(noop.changed).toBe(false);
  });

  it("defaults memory detection ON (opt-out) and autoRestart OFF (strict opt-in)", () => {
    const openclawDir = createTempOpenclawDir();
    // Missing file = fresh install → defaults.
    expect(readWatchdogMemorySettings({ openclawDir })).toEqual({
      enabled: true,
      autoRestart: false,
      effectiveAutoRestart: false,
      budgetMb: null,
      maxRestartsPerDay: 2,
    });

    // Truthy junk must never enable the enforcement half.
    for (const junk of ["true", 1, "yes", {}, []]) {
      fs.writeFileSync(
        path.join(openclawDir, "alphaclaw.json"),
        JSON.stringify({ watchdog: { memory: { autoRestart: junk } } }),
        "utf8",
      );
      expect(readWatchdogMemorySettings({ openclawDir }).autoRestart).toBe(
        false,
      );
    }
    // Falsy junk must not disable detection: only literal false does.
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ watchdog: { memory: { enabled: 0 } } }),
      "utf8",
    );
    expect(readWatchdogMemorySettings({ openclawDir }).enabled).toBe(true);
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ watchdog: { memory: { enabled: false } } }),
      "utf8",
    );
    expect(readWatchdogMemorySettings({ openclawDir }).enabled).toBe(false);
  });

  it("fails CLOSED on a corrupt config (never re-enables detection an operator turned off)", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      "{broken",
      "utf8",
    );
    expect(readWatchdogMemorySettings({ openclawDir })).toEqual({
      enabled: false,
      autoRestart: false,
      effectiveAutoRestart: false,
      budgetMb: null,
      maxRestartsPerDay: 2,
      configUnreadable: true,
    });
  });

  it("REFUSES a write while the config is corrupt instead of rebuilding it from defaults", () => {
    const openclawDir = createTempOpenclawDir();
    // Seed a real config with unrelated operator settings, then corrupt it.
    updateWatchdogMemorySettings({ openclawDir, autoRestart: true });
    const configPath = path.join(openclawDir, "alphaclaw.json");
    const goodRaw = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(configPath, `${goodRaw.slice(0, 20)}{broken`, "utf8");
    let thrown = null;
    try {
      updateWatchdogMemorySettings({ openclawDir, enabled: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.code).toBe("config_unreadable");
    // The corrupt file was left untouched — nothing was rewritten from
    // defaults (a "toggle write" must never destroy unrelated settings).
    expect(fs.readFileSync(configPath, "utf8")).toBe(
      `${goodRaw.slice(0, 20)}{broken`,
    );
  });

  it("derives effectiveAutoRestart = enabled && autoRestart without rewriting stored values", () => {
    const openclawDir = createTempOpenclawDir();
    updateWatchdogMemorySettings({ openclawDir, autoRestart: true });
    expect(readWatchdogMemorySettings({ openclawDir })).toEqual({
      enabled: true,
      autoRestart: true,
      effectiveAutoRestart: true,
      budgetMb: null,
      maxRestartsPerDay: 2,
    });

    // Detection off: enforcement is effectively off, but the stored
    // autoRestart choice survives the round-trip.
    updateWatchdogMemorySettings({ openclawDir, enabled: false });
    expect(readWatchdogMemorySettings({ openclawDir })).toEqual({
      enabled: false,
      autoRestart: true,
      effectiveAutoRestart: false,
      budgetMb: null,
      maxRestartsPerDay: 2,
    });
    updateWatchdogMemorySettings({ openclawDir, enabled: true });
    expect(readWatchdogMemorySettings({ openclawDir }).effectiveAutoRestart).toBe(
      true,
    );
  });

  it("updates memory settings per-field, reports changed, and keeps foreign keys", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ watchdog: { futureKnob: 7, memory: { note: "keep" } } }),
      "utf8",
    );

    const on = updateWatchdogMemorySettings({ openclawDir, autoRestart: true });
    expect(on.changed).toBe(true);
    expect(on.settings).toEqual({
      enabled: true,
      autoRestart: true,
      effectiveAutoRestart: true,
      budgetMb: null,
      maxRestartsPerDay: 2,
    });

    const again = updateWatchdogMemorySettings({ openclawDir, autoRestart: true });
    expect(again.changed).toBe(false);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "alphaclaw.json"), "utf8"),
    );
    expect(persisted.watchdog.futureKnob).toBe(7);
    expect(persisted.watchdog.memory.note).toBe("keep");
    // Per-field narrow: the autoRestart write never touched enabled.
    expect(persisted.watchdog.memory.enabled).toBe(true);
  });

  it("fast-leak profile (issue #56): budgetMb/maxRestartsPerDay persist per-field, null clears, out-of-bounds normalizes to defaults", () => {
    const openclawDir = createTempOpenclawDir();

    const budget = updateWatchdogMemorySettings({ openclawDir, budgetMb: 2800 });
    expect(budget.changed).toBe(true);
    expect(budget.settings).toMatchObject({ budgetMb: 2800, maxRestartsPerDay: 2 });

    const brake = updateWatchdogMemorySettings({ openclawDir, maxRestartsPerDay: 8 });
    expect(brake.changed).toBe(true);
    // Per-field narrow: the brake write left the budget alone.
    expect(brake.settings).toMatchObject({ budgetMb: 2800, maxRestartsPerDay: 8 });
    expect(readWatchdogMemorySettings({ openclawDir })).toMatchObject({
      budgetMb: 2800,
      maxRestartsPerDay: 8,
    });

    const cleared = updateWatchdogMemorySettings({ openclawDir, budgetMb: null });
    expect(cleared.changed).toBe(true);
    expect(cleared.settings.budgetMb).toBe(null);
    expect(updateWatchdogMemorySettings({ openclawDir, budgetMb: null }).changed).toBe(false);

    // Hand-edited junk normalizes to the default instead of reaching the
    // detector (a 1 MB budget would restart the gateway every tick).
    for (const [budgetMb, maxRestartsPerDay] of [
      [1, 0],
      [-5, 25],
      ["nope", 2.5],
      [Infinity, "3.5"],
      [10 ** 9, null],
      // Whole numbers only: a fraction is rejected, never rounded.
      [2800.4, 2.5],
      [255.6, 1.5],
    ]) {
      fs.writeFileSync(
        path.join(openclawDir, "alphaclaw.json"),
        JSON.stringify({ watchdog: { memory: { budgetMb, maxRestartsPerDay } } }),
        "utf8",
      );
      const read = readWatchdogMemorySettings({ openclawDir });
      expect(read.budgetMb).toBe(null);
      expect(read.maxRestartsPerDay).toBe(2);
    }
    // In-bounds strings from a hand edit are accepted.
    fs.writeFileSync(
      path.join(openclawDir, "alphaclaw.json"),
      JSON.stringify({ watchdog: { memory: { budgetMb: "4096", maxRestartsPerDay: "6" } } }),
      "utf8",
    );
    expect(readWatchdogMemorySettings({ openclawDir })).toMatchObject({
      budgetMb: 4096,
      maxRestartsPerDay: 6,
    });
  });

  it("fast-leak profile bounds are inclusive; non-numeric junk and direct out-of-bounds updater writes normalize to defaults", () => {
    const openclawDir = createTempOpenclawDir();
    // Inclusive edges survive a round trip at the storage layer.
    for (const [budgetMb, maxRestartsPerDay] of [[256, 1], [1048576, 24]]) {
      fs.writeFileSync(
        path.join(openclawDir, "alphaclaw.json"),
        JSON.stringify({ watchdog: { memory: { budgetMb, maxRestartsPerDay } } }),
        "utf8",
      );
      expect(readWatchdogMemorySettings({ openclawDir })).toMatchObject({
        budgetMb,
        maxRestartsPerDay,
      });
    }
    // Non-string, non-number junk never reaches the detector.
    for (const [budgetMb, maxRestartsPerDay] of [
      [true, true],
      [{}, {}],
      [[], []],
      ["", ""],
      ["  ", "  "],
    ]) {
      fs.writeFileSync(
        path.join(openclawDir, "alphaclaw.json"),
        JSON.stringify({ watchdog: { memory: { budgetMb, maxRestartsPerDay } } }),
        "utf8",
      );
      const read = readWatchdogMemorySettings({ openclawDir });
      expect(read.budgetMb).toBe(null);
      expect(read.maxRestartsPerDay).toBe(2);
    }
    // The updater is the last line of defense when a caller bypasses the
    // route: an out-of-bounds write stores the default and `changed` reflects
    // what was actually stored.
    updateWatchdogMemorySettings({ openclawDir, budgetMb: 2800, maxRestartsPerDay: 6 });
    const oob = updateWatchdogMemorySettings({ openclawDir, budgetMb: 1, maxRestartsPerDay: 99 });
    expect(oob.settings).toMatchObject({ budgetMb: null, maxRestartsPerDay: 2 });
    expect(oob.changed).toBe(true);
    expect(updateWatchdogMemorySettings({ openclawDir, budgetMb: 1 }).changed).toBe(false);
  });
});

describe("server/alphaclaw-config combined doctor settings write (adversarial C-ADV6)", () => {
  it("applies toggle + caps in ONE locked write and leaves untouched fields alone", () => {
    const openclawDir = createTempOpenclawDir();
    const applied = updateDoctorSettingsConfig({
      openclawDir,
      autoRunEnabled: true,
      maxFiles: 300000,
    });
    expect(applied).toEqual({
      autoRunEnabled: true,
      scan: { maxFiles: 300000, maxFileMb: null },
    });
    // Field-untouched semantics: a caps-only follow-up must not disturb the toggle.
    const capsOnly = updateDoctorSettingsConfig({ openclawDir, maxFileMb: 25 });
    expect(capsOnly).toEqual({
      autoRunEnabled: true,
      scan: { maxFiles: 300000, maxFileMb: 25 },
    });
    expect(readDoctorAutoRunEnabled({ openclawDir })).toBe(true);
    expect(readDoctorScanConfig({ openclawDir })).toEqual({
      maxFiles: 300000,
      maxFileMb: 25,
    });
  });

  // Fix wave F049: the auth boundary's team reader fails closed on a corrupt file.
  describe("readTeamSettingsStrict", () => {
    it("flags an existing-but-unparseable file and answers defaults for a missing one", () => {
      const { readTeamSettingsStrict } = require("../../lib/server/alphaclaw-config");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-team-strict-"));
      try {
        const missing = readTeamSettingsStrict({ openclawDir: dir });
        expect(missing.configUnreadable).toBeUndefined();
        expect(missing.enabled).toBe(false);
        fs.writeFileSync(path.join(dir, "alphaclaw.json"), "{ not json");
        const corrupt = readTeamSettingsStrict({ openclawDir: dir });
        expect(corrupt.configUnreadable).toBe(true);
        expect(corrupt.enabled).toBe(false);
        fs.writeFileSync(
          path.join(dir, "alphaclaw.json"),
          JSON.stringify({ team: { enabled: true, disableLegacyLogin: true } }),
        );
        const good = readTeamSettingsStrict({ openclawDir: dir });
        expect(good).toMatchObject({ enabled: true, disableLegacyLogin: true });
        expect(good.configUnreadable).toBeUndefined();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
