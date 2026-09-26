const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assessBootConfigRestore } = require("../../lib/server/boot-config-restore-guard");

describe("missing-config boot restore admission", () => {
  let root;
  let managed;
  let runs;
  const writeState = (state) => fs.writeFileSync(path.join(managed, "openclaw-channel-state.json"), JSON.stringify(state));
  const writeRun = (record, name = "12345678.json") => fs.writeFileSync(path.join(runs, name), JSON.stringify(record));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-restore-guard-"));
    managed = path.join(root, ".alphaclaw");
    runs = path.join(managed, "runs");
    fs.mkdirSync(runs, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("allows ordinary missing-config recovery with absent authority or completed historical runs", () => {
    fs.rmSync(managed, { recursive: true });
    expect(assessBootConfigRestore({ openclawDir: root })).toEqual({ allowed: true, reason: "unprotected" });
    fs.mkdirSync(runs, { recursive: true });
    writeState({ applied: { version: "2026.9.5" }, recoveryReview: null, gatewayHold: null });
    writeRun({ state: "activated", recoveryIntent: { approved: true }, recoveryReview: { active: false } });
    expect(assessBootConfigRestore({ openclawDir: root })).toEqual({ allowed: true, reason: "unprotected" });
  });

  it.each([
    { recoveryReview: { operationId: "12345678", hold: { reason: "recovery_review" } } },
    { gatewayHold: { reason: "recovery_intent_stale" } },
    { gatewayHold: { reason: "recovery_choice_required" } },
    { lastUpdateRun: { state: "restart_expected" } },
  ])("refuses missing-config restoration while persisted state owns recovery: %j", (state) => {
    writeState(state);
    expect(assessBootConfigRestore({ openclawDir: root })).toEqual({ allowed: false, reason: "recovery_pending" });
    expect(fs.existsSync(path.join(root, "openclaw.json"))).toBe(false);
  });

  it.each([
    { state: "restart_expected", recoveryIntent: { approved: true } },
    { state: "running", recoveryIntent: { approved: true } },
    { state: "failed", recoveryReview: { active: true } },
  ])("refuses pending approved handoffs and active review records: %j", (record) => {
    writeRun(record);
    expect(assessBootConfigRestore({ openclawDir: root })).toEqual({ allowed: false, reason: "recovery_pending" });
  });

  it.each(["state", "run", "oversized", "entries", "symlink", "shape", "permission", "deadline"])("fails closed when authority cannot be bounded and verified: %s", (mode) => {
    let options = {};
    const stateFile = path.join(managed, "openclaw-channel-state.json");
    if (mode === "state") fs.writeFileSync(stateFile, "{corrupt");
    if (mode === "run") fs.writeFileSync(path.join(runs, "12345678.json"), "{corrupt");
    if (mode === "oversized") fs.writeFileSync(stateFile, " ".repeat(1024 * 1024 + 1));
    if (mode === "entries") for (let index = 0; index < 257; index += 1) fs.writeFileSync(path.join(runs, `${index}.tmp`), "");
    if (mode === "symlink") {
      fs.writeFileSync(path.join(root, "outside.json"), "{}");
      fs.symlinkSync(path.join(root, "outside.json"), stateFile);
    }
    if (mode === "shape") writeState([]);
    if (mode === "permission") options = { fsModule: { ...fs, openSync: () => { throw Object.assign(new Error("permission"), { code: "EACCES" }); } } };
    if (mode === "deadline") {
      let tick = 0;
      options = { now: () => { tick += 1001; return tick; } };
    }
    expect(assessBootConfigRestore({ openclawDir: root, ...options })).toEqual({ allowed: false, reason: "recovery_authority_unverified" });
    expect(fs.existsSync(path.join(root, "openclaw.json"))).toBe(false);
  });

  it("honors a logical state-root symlink without changing the authority identity", () => {
    writeRun({ state: "restart_expected", recoveryIntent: { approved: true } });
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    try {
      expect(assessBootConfigRestore({ openclawDir: alias })).toEqual({ allowed: false, reason: "recovery_pending" });
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it("bounds aggregate authority bytes instead of only individual run files", () => {
    for (let index = 0; index < 9; index += 1) {
      writeRun({ state: "completed", detail: "x".repeat(1024 * 1024 - 100) }, `1234567${index}.json`);
    }
    expect(assessBootConfigRestore({ openclawDir: root })).toEqual({ allowed: false, reason: "recovery_authority_unverified" });
  });

  it("refuses a record that is replaced during the descriptor-bound read", () => {
    writeState({});
    const stateFile = path.join(managed, "openclaw-channel-state.json");
    const replacement = path.join(managed, "replacement.json");
    fs.writeFileSync(replacement, JSON.stringify({ recoveryReview: { operationId: "12345678" } }));
    const fsModule = {
      ...fs,
      readSync: (...args) => {
        const length = fs.readSync(...args);
        fs.renameSync(replacement, stateFile);
        return length;
      },
    };
    expect(assessBootConfigRestore({ openclawDir: root, fsModule })).toEqual({ allowed: false, reason: "recovery_authority_unverified" });
  });

  it("bin checks admission before calling the existing Git restore, but bypasses the scan for a local config", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../bin/alphaclaw.js"), "utf8");
    const start = source.indexOf("  const restoreAdmission =");
    const end = source.indexOf("  if (\n    ensureMainUpstream", start);
    const block = source.slice(start, end);
    const restore = vi.fn();
    const run = new Function("fs", "configPath", "openclawDir", "assessBootConfigRestore", "restoreMissingOpenclawConfigFromRemote", "console", block);
    writeRun({ state: "restart_expected", recoveryIntent: { approved: true } });
    const configPath = path.join(root, "openclaw.json");
    const logger = { warn: vi.fn() };
    run(fs, configPath, root, assessBootConfigRestore, restore, logger);
    expect(restore).not.toHaveBeenCalled();
    fs.unlinkSync(path.join(runs, "12345678.json"));
    run(fs, configPath, root, assessBootConfigRestore, restore, logger);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ openclawDir: root, configPath }));
    fs.writeFileSync(configPath, "{}");
    const noRead = vi.fn(() => { throw new Error("must not read authority for existing config"); });
    run(fs, configPath, root, noRead, restore, logger);
    expect(noRead).not.toHaveBeenCalled();
  });
});
