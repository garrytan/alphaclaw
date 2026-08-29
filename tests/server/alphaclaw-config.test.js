const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  isOpenAiCompatApiEnabled,
  readAlphaclawConfig,
  readAutotuneEnabled,
  readAutotuneSettings,
  readOpenclawMedicEnabled,
  readOpenclawReleaseChannel,
  updateAutotuneSettings,
  updateOpenAiCompatApiFeature,
  updateOpenclawMedicEnabled,
  updateOpenclawReleaseChannel,
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
});
