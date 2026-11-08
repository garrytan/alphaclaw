const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  planRetention,
  resolveCaptureKeep,
  sweepRetainedCopies,
  noteHealthyGatewayBoot,
  getHealthyGatewayBoot,
  kCaptureMarker,
  kCaptureMarkerContent,
} = require("../../lib/server/copy-retention");
const { createRestartRequiredLaunchClear } = require("../../lib/server/restart-required-launch-clear");

const kDay = 24 * 60 * 60 * 1000;
const kNow = Date.parse("2026-11-08T12:00:00Z");
const kVersion = "2026.10.9";
const installed = (version = kVersion) => () => version;

describe("OpenClaw update capture retention", () => {
  let root;
  let stateDir;
  let backupsDir;
  let captures;
  let logger;

  const capture = (name, sealedAtMs, bytes = 8192) => {
    const directory = path.join(captures, name);
    fs.mkdirSync(path.join(directory, "payload"), { recursive: true });
    fs.writeFileSync(path.join(directory, "payload", "state.sqlite"), Buffer.alloc(bytes, 1));
    fs.writeFileSync(path.join(directory, kCaptureMarker), kCaptureMarkerContent);
    fs.writeFileSync(path.join(directory, "manifest.json"), "{}");
    fs.utimesSync(path.join(directory, "manifest.json"), sealedAtMs / 1000, sealedAtMs / 1000);
    return directory;
  };
  const archive = (name, ageDays) => {
    const filePath = path.join(backupsDir, name);
    fs.writeFileSync(filePath, Buffer.alloc(4096, 1));
    const at = (kNow - ageDays * kDay) / 1000;
    fs.utimesSync(filePath, at, at);
  };
  const auditCaptures = () => {
    capture("doctor-oct27", Date.parse("2026-10-27T09:00:00Z"), 64 * 1024);
    capture("doctor-nov01", Date.parse("2026-11-01T09:00:00Z"), 32 * 1024);
    capture("doctor-nov07", Date.parse("2026-11-07T09:00:00Z"), 16 * 1024);
  };
  const captureVerdicts = (plan) => {
    const family = plan.families.find((entry) => entry.id === "openclaw_update_captures");
    return Object.fromEntries(family.entries.map((entry) => [entry.name, entry.verdict]));
  };
  const sweep = (options = {}) =>
    sweepRetainedCopies({ backupsDir, stateDir, env: {}, nowMs: kNow, readOpen: () => new Set(), logger, ...options });
  const healthyBootAfterNewest = { version: kVersion, readyAtMs: Date.parse("2026-11-07T09:05:00Z") };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "capture-retention-")));
    stateDir = path.join(root, "state");
    backupsDir = path.join(root, "backups", "openclaw");
    captures = stateDir + ".update-captures";
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.mkdirSync(captures, { recursive: true });
    logger = { log: vi.fn() };
  });
  afterEach(() => {
    noteHealthyGatewayBoot({ version: null, readyAtMs: null });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps 1 capture by default, reads ALPHACLAW_UPDATE_CAPTURE_KEEP, and falls back on bad values", () => {
    expect(resolveCaptureKeep({})).toBe(1);
    expect(resolveCaptureKeep({ ALPHACLAW_UPDATE_CAPTURE_KEEP: "2" })).toBe(2);
    expect(resolveCaptureKeep({ ALPHACLAW_UPDATE_CAPTURE_KEEP: " 100 " })).toBe(100);
    for (const junk of ["0", "101", "-1", "1.5", "two", ""]) {
      expect(resolveCaptureKeep({ ALPHACLAW_UPDATE_CAPTURE_KEEP: junk })).toBe(1);
    }
    expect(planRetention({ stateDir, env: { ALPHACLAW_UPDATE_CAPTURE_KEEP: "4" }, nowMs: kNow }).policy).toEqual({ keep: 3, days: 7, captureKeep: 4 });
  });

  it("removes no capture before this process sees a healthy gateway boot", () => {
    auditCaptures();
    const plan = planRetention({ stateDir, env: {}, nowMs: kNow, boot: null, readInstalledVersion: installed() });
    expect(captureVerdicts(plan)).toEqual({
      "doctor-nov07": "kept_newest",
      "doctor-nov01": "kept_until_healthy_boot",
      "doctor-oct27": "kept_until_healthy_boot",
    });
    expect(plan.families[0].gate).toBe("waiting_for_healthy_boot");

    expect(sweep({ boot: null, readInstalledVersion: installed() })).toMatchObject({ due: 0, removed: 0 });
    expect(fs.readdirSync(captures).sort()).toEqual(["doctor-nov01", "doctor-nov07", "doctor-oct27"]);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("removes no capture when the healthy boot ran another OpenClaw version, or before the newest capture was sealed", () => {
    auditCaptures();
    const otherVersion = sweep({ boot: healthyBootAfterNewest, readInstalledVersion: installed("2026.10.10") });
    expect(otherVersion).toMatchObject({ due: 0, removed: 0 });
    expect(planRetention({ stateDir, env: {}, nowMs: kNow, boot: healthyBootAfterNewest, readInstalledVersion: installed("2026.10.10") }).families[0].gate)
      .toBe("waiting_for_boot_on_installed_version");
    expect(sweep({ boot: healthyBootAfterNewest, readInstalledVersion: installed(null) })).toMatchObject({ due: 0, removed: 0 });

    const bootBeforeCapture = { version: kVersion, readyAtMs: Date.parse("2026-11-07T08:00:00Z") };
    expect(sweep({ boot: bootBeforeCapture, readInstalledVersion: installed() })).toMatchObject({ due: 0, removed: 0 });
    expect(planRetention({ stateDir, env: {}, nowMs: kNow, boot: bootBeforeCapture, readInstalledVersion: installed() }).families[0].gate)
      .toBe("waiting_for_boot_after_newest_capture");
    expect(fs.readdirSync(captures)).toHaveLength(3);
  });

  it("after a healthy boot on the installed version keeps only the newest capture, whatever its age, and logs each removal with its size", () => {
    auditCaptures();
    const result = sweep({ boot: healthyBootAfterNewest, readInstalledVersion: installed() });
    expect(result).toMatchObject({ due: 2, removed: 2, held: 0, failed: 0 });
    expect(result.byFamily.openclaw_update_captures.removed).toBe(2);
    expect(fs.readdirSync(captures)).toEqual(["doctor-nov07"]);
    const lines = logger.log.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[alphaclaw\] retention sweep: removed OpenClaw update capture doctor-nov01 \(0 MB, \d+ bytes\)$/);
    expect(lines[1]).toMatch(/^\[alphaclaw\] retention sweep: removed OpenClaw update capture doctor-oct27 \(0 MB, \d+ bytes\)$/);
    const bytes = lines.slice(0, 2).map((line) => Number(line.match(/, (\d+) bytes\)$/)[1]));
    expect(bytes[0]).toBeGreaterThanOrEqual(32 * 1024);
    expect(bytes[1]).toBeGreaterThanOrEqual(64 * 1024);
    expect(bytes[0] + bytes[1]).toBe(result.freedBytes);
    expect(lines[2]).toMatch(/2 due, removed 2 .*; update captures keep newest 1 after a healthy gateway boot$/);

    const allOld = planRetention({ stateDir, env: {}, nowMs: kNow + 400 * kDay, boot: healthyBootAfterNewest, readInstalledVersion: installed() });
    expect(captureVerdicts(allOld)).toEqual({ "doctor-nov07": "kept_newest" });
  });

  it("names a large capture in GB", () => {
    capture("doctor-old", Date.parse("2026-11-01T09:00:00Z"));
    capture("doctor-new", Date.parse("2026-11-07T09:00:00Z"));
    const sizedFs = {
      ...fs,
      lstatSync: (target, ...rest) => {
        const stat = fs.lstatSync(target, ...rest);
        return String(target).endsWith(path.join("doctor-old", "payload", "state.sqlite")) ? Object.assign(stat, { blocks: 10_000_000 }) : stat;
      },
    };
    sweep({ boot: healthyBootAfterNewest, readInstalledVersion: installed(), fsModule: sizedFs });
    expect(logger.log.mock.calls[0][0]).toMatch(/^\[alphaclaw\] retention sweep: removed OpenClaw update capture doctor-old \(5\.1 GB, 512\d{7} bytes\)$/);
  });

  it("keeps the newest N from the env, and never removes the newest capture", () => {
    auditCaptures();
    capture("doctor-nov08", Date.parse("2026-11-08T08:00:00Z"));
    const boot = { version: kVersion, readyAtMs: Date.parse("2026-11-08T08:10:00Z") };
    sweep({ boot, readInstalledVersion: installed(), env: { ALPHACLAW_UPDATE_CAPTURE_KEEP: "2" } });
    expect(fs.readdirSync(captures).sort()).toEqual(["doctor-nov07", "doctor-nov08"]);
    sweep({ boot, readInstalledVersion: installed(), env: { ALPHACLAW_UPDATE_CAPTURE_KEEP: "0" } });
    expect(fs.readdirSync(captures)).toEqual(["doctor-nov08"]);
    sweep({ boot, readInstalledVersion: installed(), env: { ALPHACLAW_UPDATE_CAPTURE_KEEP: "1" } });
    expect(fs.readdirSync(captures)).toEqual(["doctor-nov08"]);
  });

  it("leaves the archive policy as it was: newest 3 and anything under 7 days", () => {
    archive("2026-11-07T10-00-00.000Z-openclaw-backup.tar.gz", 1);
    archive("2026-11-04T10-00-00.000Z-openclaw-backup.tar.gz", 4);
    archive("2026-11-03T10-00-00.000Z-openclaw-backup.tar.gz", 5);
    archive("2026-11-02T10-00-00.000Z-openclaw-backup.tar.gz", 6);
    archive("2026-10-01T10-00-00.000Z-openclaw-backup.tar.gz", 38);
    auditCaptures();
    const plan = planRetention({ backupsDir, stateDir, env: { ALPHACLAW_UPDATE_CAPTURE_KEEP: "1" }, nowMs: kNow, boot: healthyBootAfterNewest, readInstalledVersion: installed() });
    const archives = plan.families.find((family) => family.id === "alphaclaw_backups");
    expect(archives).toMatchObject({ keep: 3, days: 7 });
    expect(Object.fromEntries(archives.entries.map((entry) => [entry.name, entry.verdict]))).toEqual({
      "2026-11-07T10-00-00.000Z-openclaw-backup.tar.gz": "kept_newest",
      "2026-11-04T10-00-00.000Z-openclaw-backup.tar.gz": "kept_newest",
      "2026-11-03T10-00-00.000Z-openclaw-backup.tar.gz": "kept_newest",
      "2026-11-02T10-00-00.000Z-openclaw-backup.tar.gz": "kept_recent",
      "2026-10-01T10-00-00.000Z-openclaw-backup.tar.gz": "due",
    });
    const archivesWithoutBoot = planRetention({ backupsDir, stateDir: null, env: {}, nowMs: kNow, boot: null });
    expect(archivesWithoutBoot.families[0].entries.find((entry) => entry.verdict === "due")?.name).toBe("2026-10-01T10-00-00.000Z-openclaw-backup.tar.gz");
  });

  it("records the healthy boot from a managed launch that answers /readyz ready, and the default sweep uses it", async () => {
    auditCaptures();
    const readyAtMs = Date.parse("2026-11-07T09:05:00Z");
    let nowMs = readyAtMs - 3000;
    const probes = [{ ok: false, kind: "unready", reason: "starting" }, { ok: true, kind: "ready" }];
    const seen = [];
    const clear = createRestartRequiredLaunchClear({
      restartRequiredState: { markAppliedByLaunch: () => null },
      isLaunchCurrent: () => true,
      probeReadiness: async () => probes.shift() ?? { ok: true, kind: "ready" },
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      onLaunchReady: (ready) => {
        seen.push(ready);
        noteHealthyGatewayBoot({ version: kVersion, readyAtMs: ready.readyAt });
      },
    });
    expect(getHealthyGatewayBoot()).toBe(null);
    await clear.onGatewayLaunch({ generation: 3, launchedAt: readyAtMs - 5000, supervision: "managed" });
    expect(seen).toEqual([{ generation: 3, launchedAt: readyAtMs - 5000, readyAt: readyAtMs - 2000 }]);
    expect(getHealthyGatewayBoot()).toEqual({ version: kVersion, readyAtMs: readyAtMs - 2000 });

    sweep({ readInstalledVersion: installed() });
    expect(fs.readdirSync(captures)).toEqual(["doctor-nov07"]);
  });

  it("records no healthy boot for an adopted gateway, a launch that never gets ready, or one replaced first", async () => {
    const onLaunchReady = vi.fn();
    const make = ({ ready = true, current = () => true } = {}) => {
      let nowMs = 0;
      return createRestartRequiredLaunchClear({
        restartRequiredState: { markAppliedByLaunch: () => null },
        isLaunchCurrent: current,
        probeReadiness: async () => (ready ? { ok: true, kind: "ready" } : { ok: false, kind: "unready", reason: "starting" }),
        sleep: async (ms) => { nowMs += ms; },
        now: () => nowMs,
        readyTimeoutMs: 5000,
        onLaunchReady,
      });
    };
    expect(await make().onGatewayLaunch({ generation: null, supervision: "adopted" })).toBe(null);
    expect(await make({ ready: false }).onGatewayLaunch({ generation: 1, launchedAt: 10, supervision: "managed" })).toEqual({ skipped: "not_ready" });
    expect(await make({ current: () => false }).onGatewayLaunch({ generation: 1, launchedAt: 10, supervision: "managed" })).toEqual({ skipped: "superseded" });
    expect(onLaunchReady).not.toHaveBeenCalled();
  });
});
