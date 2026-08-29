// The shared progress model lives in dependency-free CommonJS at the lib root
// so the boot-time update pipeline can require it directly; the upgrade tab's
// helpers.js re-exports it so existing frontend imports keep working.
const loadProgressModel = async () =>
  import("../../lib/update-progress-model.js");
const loadUpgradeHelpers = async () =>
  import("../../lib/public/js/components/upgrade-tab/helpers.js");

const kNow = Date.parse("2026-08-25T12:00:00.000Z");

describe("shared update-progress model", () => {
  it("keeps the existing step labels and adds the boot-time activation steps", async () => {
    const { kStepLabels } = await loadProgressModel();

    // Pre-existing labels are untouched.
    expect(kStepLabels.preflight).toBe("Preflight checks");
    expect(kStepLabels["db-preflight"]).toBe("Database compatibility");
    expect(kStepLabels.restarting).toBe("Restarting");

    // Boot-time steps a parallel workstream appends to the run ledger.
    expect(kStepLabels.activate).toBe("Activating new version");
    expect(kStepLabels["config-migrate"]).toBe("Migrating settings");
    expect(kStepLabels["db-migrate"]).toBe("Migrating databases");
  });

  it("helpers.js re-exports the SAME references — no fork of the model", async () => {
    const model = await loadProgressModel();
    const helpers = await loadUpgradeHelpers();

    expect(helpers.kStepLabels).toBe(model.kStepLabels);
    expect(helpers.buildStepListModel).toBe(model.buildStepListModel);
    expect(helpers.formatElapsed).toBe(model.formatElapsed);
  });

  it("collapses repeated step events to one row, first-seen order, latest status", async () => {
    const { buildStepListModel } = await loadProgressModel();

    const model = buildStepListModel([
      { name: "preflight", status: "running", at: 1 },
      { name: "preflight", status: "completed", at: 2 },
      { name: "backup", status: "running", at: 3 },
      { name: "backup", status: "completed", at: 4 },
      { name: "download", status: "running", at: 5, detail: "npm install openclaw@2026.7.2" },
      { name: "download", status: "failed", at: 6, error: "ETIMEDOUT" },
    ]);

    expect(model.map((step) => [step.name, step.status])).toEqual([
      ["preflight", "completed"],
      ["backup", "completed"],
      ["download", "failed"],
    ]);
    expect(model[2].detail).toBe("npm install openclaw@2026.7.2");
    expect(model[2].error).toBe("ETIMEDOUT");
    expect(model[0].label).toBe("Preflight checks");
  });

  it("labels the boot-time steps in the collapsed list", async () => {
    const { buildStepListModel } = await loadProgressModel();

    const model = buildStepListModel([
      { name: "activate", status: "completed", at: 1 },
      { name: "config-migrate", status: "failed", at: 2, error: "reconcile failed" },
      { name: "db-migrate", status: "running", at: 3 },
    ]);

    expect(model.map((step) => step.label)).toEqual([
      "Activating new version",
      "Migrating settings",
      "Migrating databases",
    ]);
  });

  it("exports toEpochMs for the boot placeholder — epoch numbers, ISO strings, Dates", async () => {
    const { toEpochMs } = await loadProgressModel();

    expect(toEpochMs(kNow)).toBe(kNow);
    expect(toEpochMs("2026-08-25T12:00:00.000Z")).toBe(kNow);
    // Date instances resolve via getTime(), not the string round-trip.
    expect(toEpochMs(new Date(kNow))).toBe(kNow);
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs("")).toBeNull();
    expect(toEpochMs("not a timestamp")).toBeNull();
  });

  it("formats elapsed durations exactly as the old helpers export did", async () => {
    const { formatElapsed } = await loadProgressModel();
    expect(formatElapsed(kNow - 42_000, kNow)).toBe("42s");
    expect(formatElapsed(kNow - 83_000, kNow)).toBe("1m 23s");
    expect(formatElapsed(null, kNow)).toBe("0s");
    // Clamps when the end bound precedes the start.
    expect(formatElapsed(1000, 500)).toBe("0s");
  });
});
