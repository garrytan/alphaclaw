const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  isOpenAiCompatApiEnabled,
  readAlphaclawConfig,
  readOpenclawReleaseChannel,
  updateOpenAiCompatApiFeature,
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
      },
      updates: {
        openclaw: {
          releaseChannel: "stable",
          overseer: { enabled: false },
        },
      },
      team: {
        enabled: false,
      },
      doctor: {
        autoRun: { enabled: false },
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
      },
      updates: {
        openclaw: {
          releaseChannel: "stable",
          overseer: { enabled: false },
        },
      },
      team: {
        enabled: false,
      },
      doctor: {
        autoRun: { enabled: false },
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
});
