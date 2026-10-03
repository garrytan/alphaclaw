// boot-instance-guard.js: the bin phase of `alphaclaw start` — the
// single-instance judgement on the server pidfile, the one-time retirement of
// the old in-app OpenClaw version switch, and the bin half of
// boot-report.json. Hermetic: real temp dirs; the pidfile is the real module
// for the clean-boot case and a scripted fake for the live-owner cases.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runBootInstanceGuard } = require("../../lib/server/boot-instance-guard");
const { kRetirementFileName } = require("../../lib/server/openclaw-channel-retirement");
const { getProcessBootId } = require("../../lib/server/boot-id");

const kNow = 1_788_681_600_000;
const kPin = "2026.9.8";
// The guard reads the OpenClaw installed beside AlphaClaw (this checkout).
const kInstalled = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../node_modules/openclaw/package.json"), "utf8")).version;
  } catch {
    return null;
  }
})();
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const createBox = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-guard-"));
  const openclawDir = path.join(rootDir, ".openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  const packageRoot = path.join(rootDir, "alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@chrysb/alphaclaw", dependencies: { openclaw: kPin } }));
  return { rootDir, openclawDir, managedDir, packageRoot };
};

const kSelfVersion = { record: { version: "0.9.90", commit: "abc123" }, previousVersion: "0.9.89", changed: true };

// A scripted pidfile: every describe call returns `decision`.
const fakePidfile = (decision) => ({
  describeServerPidDecision: vi.fn(() => decision),
  convergeLegacyServerPidClaim: vi.fn(() => ({ converged: false, reason: "not_legacy_skip" })),
  writeServerPid: vi.fn(),
});
const liveOwner = (corroborated) => ({
  decision: "skip",
  reason: corroborated ? "corroborated" : "legacy_argv_match",
  pid: 4242,
  evidence: { pid: 4242, corroborated },
  record: { raw: { pid: 4242, at: 1 }, format: corroborated ? 2 : "legacy", legacyClaim: !corroborated },
});

describe("server/boot-instance-guard", () => {
  const roots = [];
  const newBox = () => {
    const box = createBox();
    roots.push(box.rootDir);
    return box;
  };
  const guard = (box, overrides = {}) =>
    runBootInstanceGuard({
      managedDir: box.managedDir,
      rootDir: box.rootDir,
      openclawDir: box.openclawDir,
      packageRoot: box.packageRoot,
      selfVersion: kSelfVersion,
      nowFn: () => kNow,
      logger: { log: vi.fn(), warn: vi.fn() },
      ...overrides,
    });
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a clean boot claims the pidfile, retires a leftover version switch and writes the bin phase of boot-report.json", () => {
    const box = newBox();
    fs.writeFileSync(
      path.join(box.managedDir, "openclaw-channel-state.json"),
      JSON.stringify({ applied: { channel: "beta", version: "2026.9.9-beta.2", sha: null } }),
    );
    const logger = { log: vi.fn(), warn: vi.fn() };

    const result = guard(box, { logger });

    expect(result).toMatchObject({ action: "none", warnings: [], pidDecision: expect.objectContaining({ decision: "proceed", reason: "absent" }) });
    expect(result.retirement).toMatchObject({ previous: { channel: "beta", version: "2026.9.9-beta.2" }, pinVersion: kPin, needsNotice: true });
    expect(readJson(path.join(box.managedDir, "alphaclaw-server.pid"))).toMatchObject({ pid: process.pid, format: 2 });
    expect(fs.existsSync(path.join(box.managedDir, kRetirementFileName))).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/^\[alphaclaw\] pidfile: .*→ absent \(proceed\)$/));

    const report = readJson(path.join(box.managedDir, "boot-report.json"));
    expect(report).toMatchObject({
      bootId: getProcessBootId(),
      at: kNow,
      alphaclaw: { version: "0.9.90", commit: "abc123", previousVersion: "0.9.89", firstBootOfVersion: true },
      pidfile: expect.objectContaining({ decision: "proceed" }),
      binPhase: { status: "ok" },
      serverPhase: { status: "pending" },
    });
    expect(report.openclaw).toEqual({
      stateDir: process.env.OPENCLAW_STATE_DIR || box.openclawDir,
      declaredPin: kPin,
      installedAtBoot: kInstalled,
      installedDiverged: kInstalled ? kInstalled !== kPin : null,
      retiredChannel: { channel: "beta", version: "2026.9.9-beta.2", sha: null },
      bootSync: { action: "none", reason: null, warnings: [] },
    });
  });

  it("a corroborated live owner: refuses without claiming or retiring, and records the attempt in boot-report-refused.json", () => {
    const box = newBox();
    const statePath = path.join(box.managedDir, "openclaw-channel-state.json");
    fs.writeFileSync(statePath, JSON.stringify({ applied: { channel: "beta", version: "2026.9.9-beta.2" } }));
    const liveReport = JSON.stringify({ schema: "alphaclaw.boot-report.v1", bootId: "1:1", serverPhase: { status: "recorded", verdict: [] } });
    fs.writeFileSync(path.join(box.managedDir, "boot-report.json"), liveReport);
    const pidfile = fakePidfile(liveOwner(true));

    const result = guard(box, { pidfile });

    expect(result).toMatchObject({ action: "skipped_concurrent", reason: "live_server_corroborated", livePid: 4242, corroborated: true, retirement: null });
    expect(pidfile.writeServerPid).not.toHaveBeenCalled();
    expect(pidfile.convergeLegacyServerPidClaim).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.readFileSync(path.join(box.managedDir, "boot-report.json"), "utf8")).toBe(liveReport);
    const refused = readJson(path.join(box.managedDir, "boot-report-refused.json"));
    expect(refused.openclaw.bootSync).toEqual({ action: "skipped_concurrent", reason: "live_server_corroborated", warnings: [] });
    expect(refused.serverPhase).toMatchObject({ status: "not_reached", reason: "pidfile_skip" });
  }, 10_000);

  it("an unverifiable live owner: boot continues without claiming or retiring, and the bin phase lands in boot-report.json", () => {
    const box = newBox();
    const pidfile = fakePidfile(liveOwner(false));

    const result = guard(box, { pidfile });

    expect(result).toMatchObject({ action: "skipped_concurrent", reason: "live_server_unverified", livePid: 4242, corroborated: false });
    expect(pidfile.writeServerPid).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(box.managedDir, "boot-report-refused.json"))).toBe(false);
    expect(readJson(path.join(box.managedDir, "boot-report.json")).openclaw.bootSync).toEqual({
      action: "skipped_concurrent",
      reason: "live_server_unverified",
      warnings: [],
    });
  }, 10_000);

  it("logs a converged legacy claim", () => {
    const box = newBox();
    const pidfile = fakePidfile({ decision: "proceed", reason: "dead", pid: 47, evidence: null, record: null });
    pidfile.convergeLegacyServerPidClaim.mockReturnValue({ converged: true, record: { observedTicks: 15532 } });
    const logger = { log: vi.fn(), warn: vi.fn() };
    guard(box, { pidfile, logger });
    expect(logger.log).toHaveBeenCalledWith("[alphaclaw] pidfile: legacy claim for pid 47 converged to format 2 (observedTicks=15532)");
    expect(pidfile.writeServerPid).toHaveBeenCalledTimes(1);
  });

  it("fails open: a throwing pidfile is a warning, the boot proceeds and the bin phase is still written", () => {
    const box = newBox();
    const pidfile = {
      describeServerPidDecision: () => {
        throw new Error("EIO pidfile");
      },
    };
    const result = guard(box, { pidfile });
    expect(result).toMatchObject({ action: "none", warnings: ["boot guard failed: EIO pidfile"] });
    const report = readJson(path.join(box.managedDir, "boot-report.json"));
    expect(report.openclaw.bootSync).toEqual({ action: "none", reason: null, warnings: ["boot guard failed: EIO pidfile"] });
    expect(report.openclaw.declaredPin).toBe(kPin);
  });

  it("an unreadable AlphaClaw package.json leaves the pin unknown and divergence undecided", () => {
    const box = newBox();
    fs.writeFileSync(path.join(box.packageRoot, "package.json"), "{ torn");
    guard(box);
    const report = readJson(path.join(box.managedDir, "boot-report.json"));
    expect(report.openclaw).toMatchObject({ declaredPin: null, installedDiverged: null });
  });
});
