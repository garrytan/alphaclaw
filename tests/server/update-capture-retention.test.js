// Version-anchored retention for OpenClaw's Doctor captures (ALPH-69): the
// capture taken before an OpenClaw upgrade survives until a later upgrade
// replaces it, and repair captures go once the installed version has had a
// verified healthy start. Real capture directories (OpenClaw's marker, a
// sealed manifest) and the real plan and sweep.
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  planRetention,
  listManagedCaptures,
  resolveUpdateCaptureKeep,
  sweepRetainedCopies,
  kCaptureMarker,
  kCaptureMarkerContent,
} = require("../../lib/server/copy-retention");
const { createUpdateCaptureTracker, readCaptureRecord, captureNameFromManifest } = require("../../lib/server/update-capture-record");
const { createDiskReader } = require("../../lib/server/box-status/disk");

const kHour = 60 * 60 * 1000;
const kDay = 24 * kHour;
const kStart = Date.parse("2026-10-01T00:00:00Z");
const A = "2026.10.8";
const B = "2026.10.9";
const C = "2026.11.1";

describe("version-anchored retention for OpenClaw update captures", () => {
  let root;
  let stateDir;
  let captures;
  let managedDir;
  let clock;
  let installed;
  let logger;

  const capture = (name, sealedAt) => {
    const directory = path.join(captures, name);
    fs.mkdirSync(path.join(directory, "payload"), { recursive: true });
    fs.writeFileSync(path.join(directory, "payload", "state.sqlite"), Buffer.alloc(8192, 1));
    fs.writeFileSync(path.join(directory, kCaptureMarker), kCaptureMarkerContent);
    fs.writeFileSync(path.join(directory, "manifest.json"), "{}");
    fs.utimesSync(path.join(directory, "manifest.json"), sealedAt / 1000, sealedAt / 1000);
    return directory;
  };
  const makeTracker = (overrides = {}) =>
    createUpdateCaptureTracker({
      managedDir,
      getInstalledVersion: () => installed,
      listCaptures: () => listManagedCaptures({ stateDir }),
      nowFn: () => clock,
      logger,
      ...overrides,
    });
  // A Doctor run on the installed version seals a capture and prints its line.
  const doctorSeals = (tracker, name) => {
    clock += kHour;
    capture(name, clock);
    return tracker.noteDoctorCapture({ manifestPath: path.join(captures, name, "manifest.json"), installedVersion: installed });
  };
  // A managed launch spawned now, verified ready a minute later.
  const healthyStart = (tracker, version = installed) => {
    clock += kHour;
    const launchedAt = clock;
    clock += 60_000;
    return tracker.noteHealthyStart({ openclawVersion: version, launchedAt });
  };
  const sweep = (tracker, env = {}) =>
    sweepRetainedCopies({ stateDir, captureState: tracker ? tracker.getState({ flush: true }) : null, env, nowMs: clock, readOpen: () => new Set(), logger });
  const left = () => fs.readdirSync(captures).sort();
  const verdicts = (tracker) =>
    Object.fromEntries(
      planRetention({ stateDir, captureState: tracker ? tracker.getState() : null, env: {}, nowMs: clock }).families[0].entries
        .map((entry) => [entry.name, entry.reason ? entry.verdict + ":" + entry.reason : entry.verdict]),
    );
  const removedLines = () => logger.log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("removed OpenClaw capture"));
  // A box that has run OpenClaw A healthily for a while: three repair captures.
  const establishedOnA = () => {
    installed = A;
    const tracker = makeTracker();
    healthyStart(tracker);
    for (const name of ["doctor-a1", "doctor-a2", "doctor-a3"]) doctorSeals(tracker, name);
    return tracker;
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "update-capture-retention-")));
    stateDir = path.join(root, "state");
    captures = stateDir + ".update-captures";
    managedDir = path.join(stateDir, ".alphaclaw");
    fs.mkdirSync(captures, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });
    clock = kStart;
    installed = A;
    logger = { log: vi.fn(), warn: vi.fn() };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("failed first launch: the copy from before the upgrade survives the repair captures sealed before the new version is ever ready", () => {
    const tracker = establishedOnA();
    installed = B;
    expect(doctorSeals(tracker, "doctor-upgrade")).toEqual({ promoted: true, name: "doctor-upgrade" });
    expect(doctorSeals(tracker, "doctor-repair")).toEqual({ promoted: false, reason: "already_recorded" });
    expect(sweep(tracker)).toMatchObject({ due: 0, removed: 0 });
    expect(verdicts(tracker)).toMatchObject({ "doctor-upgrade": "kept_pre_upgrade", "doctor-repair": "kept_newest", "doctor-a1": "kept_unproven" });

    healthyStart(tracker);
    const result = sweep(tracker);
    expect(result).toMatchObject({ due: 2, removed: 2 });
    expect(left()).toEqual(["doctor-a3", "doctor-repair", "doctor-upgrade"]);
    expect(removedLines()).toEqual([
      expect.stringMatching(/^\[alphaclaw\] retention sweep: removed OpenClaw capture doctor-a2 \(\d+ MB\)$/),
      expect.stringMatching(/^\[alphaclaw\] retention sweep: removed OpenClaw capture doctor-a1 \(\d+ MB\)$/),
    ]);

    // Ten days of daily restarts on B: each container start seals a capture.
    for (const name of ["doctor-b1", "doctor-b2", "doctor-b3"]) {
      clock += 3 * kDay;
      doctorSeals(tracker, name);
      healthyStart(tracker);
    }
    sweep(tracker);
    expect(left()).toEqual(["doctor-b2", "doctor-b3", "doctor-upgrade"]);
    expect(readCaptureRecord({ managedDir }).record.preUpgradeCapture).toMatchObject({ name: "doctor-upgrade", fromVersion: A, toVersion: B, settled: true });
  });

  it("first rollout with no record: nothing goes that the keep-3-and-7-days rule would keep", () => {
    clock = kStart + 60 * kDay;
    capture("doctor-old", clock - 40 * kDay);
    capture("doctor-older", clock - 20 * kDay);
    capture("doctor-real-pre-upgrade", clock - 4 * kDay);
    capture("doctor-c3", clock - 3 * kDay);
    capture("doctor-c2", clock - 2 * kDay);
    capture("doctor-c1", clock - 1 * kDay);
    const mainDue = Object.entries(verdicts(null)).filter(([, verdict]) => verdict === "due").map(([name]) => name).sort();
    expect(mainDue).toEqual(["doctor-old", "doctor-older"]);

    installed = B;
    const tracker = makeTracker();
    expect(doctorSeals(tracker, "doctor-boot")).toEqual({ promoted: false, reason: "no_record" });
    expect(sweep(tracker)).toMatchObject({ removed: 2 });
    healthyStart(tracker);
    const afterReady = sweep(tracker);
    expect(afterReady.removed).toBe(0);
    expect(left()).toEqual(["doctor-boot", "doctor-c1", "doctor-c2", "doctor-c3", "doctor-real-pre-upgrade"]);
    expect(verdicts(tracker)["doctor-real-pre-upgrade"]).toBe("kept_recent:before_record");

    // Captures from before the record keep that rule as they age.
    clock += 4 * kDay;
    sweep(tracker);
    expect(left()).toEqual(["doctor-boot", "doctor-c1", "doctor-c2"]);
  });

  it("downgrade A->B->A: the copy that is the only way back to B survives, and the A copy from before B falls under the keep count", () => {
    const tracker = establishedOnA();
    installed = B;
    doctorSeals(tracker, "doctor-before-b");
    healthyStart(tracker);
    doctorSeals(tracker, "doctor-b-repair1");
    doctorSeals(tracker, "doctor-b-repair2");
    sweep(tracker);
    expect(left()).toEqual(["doctor-b-repair1", "doctor-b-repair2", "doctor-before-b"]);

    installed = A;
    expect(doctorSeals(tracker, "doctor-before-back-to-a")).toEqual({ promoted: true, name: "doctor-before-back-to-a" });
    expect(logger.log.mock.calls.map(([line]) => line)).toContain(
      "[alphaclaw] update captures: keeping doctor-before-back-to-a as the copy from before OpenClaw " + B + " -> " + A +
        "; doctor-before-b is no longer held for the " + A + " -> " + B + " change",
    );
    expect(sweep(tracker).removed).toBe(0);
    healthyStart(tracker);
    doctorSeals(tracker, "doctor-a-repair");
    sweep(tracker);
    expect(left()).toEqual(["doctor-a-repair", "doctor-b-repair2", "doctor-before-back-to-a"]);
    expect(verdicts(tracker)).toEqual({ "doctor-a-repair": "kept_newest", "doctor-before-back-to-a": "kept_pre_upgrade", "doctor-b-repair2": "kept_newest" });
  });

  it("downgrade whose Doctor line AlphaClaw never saw: the healthy start holds the newest capture sealed before that launch", () => {
    const tracker = establishedOnA();
    installed = B;
    doctorSeals(tracker, "doctor-before-b");
    healthyStart(tracker);
    doctorSeals(tracker, "doctor-b-repair");
    installed = A;
    clock += kHour;
    capture("doctor-unseen", clock);
    healthyStart(tracker);
    doctorSeals(tracker, "doctor-a-repair1");
    doctorSeals(tracker, "doctor-a-repair2");
    sweep(tracker);
    expect(readCaptureRecord({ managedDir }).record.preUpgradeCapture).toMatchObject({ name: "doctor-unseen", fromVersion: B, toVersion: A, source: "healthy_start" });
    expect(left()).toEqual(["doctor-a-repair1", "doctor-a-repair2", "doctor-unseen"]);
  });

  it("a repair capture after the healthy start does not displace the pre-upgrade capture, and a restart on the same version keeps the record", () => {
    const tracker = establishedOnA();
    installed = B;
    doctorSeals(tracker, "doctor-upgrade");
    healthyStart(tracker);
    expect(doctorSeals(tracker, "doctor-after-ready")).toEqual({ promoted: false, reason: "same_version" });
    const before = readCaptureRecord({ managedDir }).record;
    expect(healthyStart(tracker)).toEqual({ changed: false });
    const after = readCaptureRecord({ managedDir }).record;
    expect(after).toEqual({ ...before, lastHealthyAt: clock });
    expect(after.lastHealthyAt).toBeGreaterThan(before.lastHealthyAt);
    expect(makeTracker().getState().record.preUpgradeCapture.name).toBe("doctor-upgrade");
    expect(verdicts(makeTracker())["doctor-upgrade"]).toBe("kept_pre_upgrade");
  });

  it("the next version change releases the old pre-upgrade capture once the new version proves itself", () => {
    const tracker = establishedOnA();
    installed = B;
    doctorSeals(tracker, "doctor-before-b");
    healthyStart(tracker);
    installed = C;
    doctorSeals(tracker, "doctor-before-c");
    doctorSeals(tracker, "doctor-c-repair");
    sweep(tracker);
    expect(left()).toContain("doctor-before-b");
    healthyStart(tracker);
    sweep(tracker);
    expect(left()).toEqual(["doctor-before-b", "doctor-before-c", "doctor-c-repair"]);
    doctorSeals(tracker, "doctor-c-repair2");
    sweep(tracker);
    expect(left()).toEqual(["doctor-before-c", "doctor-c-repair", "doctor-c-repair2"]);
  });

  it("an upgrade that never starts cleanly, fixed forward to a newer version: the copy from before the failed upgrade is still held after the newer version starts cleanly (Doctor line seen)", () => {
    const tracker = establishedOnA();
    installed = B;
    expect(doctorSeals(tracker, "doctor-upgrade")).toEqual({ promoted: true, name: "doctor-upgrade" });
    doctorSeals(tracker, "doctor-b-repair1");
    doctorSeals(tracker, "doctor-b-repair2");
    installed = C;
    expect(doctorSeals(tracker, "doctor-before-c")).toEqual({ promoted: false, reason: "already_recorded" });
    expect(logger.log.mock.calls.map(([line]) => line)).toContain(
      "[alphaclaw] update captures: keeping doctor-upgrade as the copy from before OpenClaw " + A + " -> " + C + " (" + B + " never started cleanly)",
    );
    healthyStart(tracker);
    sweep(tracker);
    expect(readCaptureRecord({ managedDir }).record.preUpgradeCapture).toMatchObject({ name: "doctor-upgrade", fromVersion: A, toVersion: C, settled: true });
    expect(left()).toEqual(["doctor-b-repair2", "doctor-before-c", "doctor-upgrade"]);
  });

  it("an upgrade that never starts cleanly, fixed forward to a newer version whose Doctor line AlphaClaw never saw: the newer version's clean start keeps the copy from before the failed upgrade", () => {
    const tracker = establishedOnA();
    installed = B;
    doctorSeals(tracker, "doctor-upgrade");
    doctorSeals(tracker, "doctor-b-repair1");
    doctorSeals(tracker, "doctor-b-repair2");
    installed = C;
    clock += kHour;
    capture("doctor-before-c", clock);
    healthyStart(tracker);
    doctorSeals(tracker, "doctor-c-repair");
    sweep(tracker);
    expect(readCaptureRecord({ managedDir }).record.preUpgradeCapture).toMatchObject({ name: "doctor-upgrade", fromVersion: A, toVersion: C, source: "doctor", settled: true });
    expect(left()).toEqual(["doctor-before-c", "doctor-c-repair", "doctor-upgrade"]);
  });

  it("AlphaClaw dies before it reads Doctor's line for the pre-upgrade copy: the next Doctor line on the new version still holds that copy, not the repair copy", () => {
    const tracker = establishedOnA();
    installed = B;
    clock += kHour;
    capture("doctor-upgrade", clock);
    const restarted = makeTracker();
    expect(doctorSeals(restarted, "doctor-b-repair1")).toEqual({ promoted: true, name: "doctor-upgrade" });
    expect(doctorSeals(restarted, "doctor-b-repair2")).toEqual({ promoted: false, reason: "already_recorded" });
    healthyStart(restarted);
    sweep(restarted);
    expect(readCaptureRecord({ managedDir }).record.preUpgradeCapture).toMatchObject({ name: "doctor-upgrade", fromVersion: A, toVersion: B, source: "doctor", settled: true });
    expect(left()).toEqual(["doctor-b-repair1", "doctor-b-repair2", "doctor-upgrade"]);
    expect(tracker).toBeTruthy();
  });

  it("a container restart on the same version moves the boundary: the upgrade's copy is held, not the older restart copy", () => {
    const tracker = establishedOnA();
    clock += kDay;
    capture("doctor-a-restart", clock);
    healthyStart(tracker);
    installed = B;
    clock += kHour;
    capture("doctor-upgrade", clock);
    expect(doctorSeals(tracker, "doctor-b-repair")).toEqual({ promoted: true, name: "doctor-upgrade" });
    healthyStart(tracker);
    sweep(tracker);
    expect(readCaptureRecord({ managedDir }).record.preUpgradeCapture).toMatchObject({ name: "doctor-upgrade", fromVersion: A, toVersion: B });
    expect(left()).toEqual(["doctor-a-restart", "doctor-b-repair", "doctor-upgrade"]);
  });

  it("leaves the record as it is while the captures can't be listed, and places the copy once they can", () => {
    establishedOnA();
    let listingFails = false;
    const tracker = makeTracker({
      listCaptures: () => {
        if (listingFails) throw Object.assign(new Error("I/O error"), { code: "EIO" });
        return listManagedCaptures({ stateDir });
      },
    });
    const recordPath = path.join(managedDir, "openclaw-update-captures.json");
    const before = fs.readFileSync(recordPath, "utf8");
    installed = B;
    listingFails = true;
    expect(doctorSeals(tracker, "doctor-upgrade")).toEqual({ promoted: false, reason: "listing_failed" });
    expect(healthyStart(tracker)).toEqual({ changed: false, reason: "listing_failed" });
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
    expect(sweep(tracker).removed).toBe(0);
    expect(verdicts(tracker)["doctor-a1"]).toBe("kept_unproven");

    listingFails = false;
    expect(healthyStart(tracker)).toEqual({ changed: true });
    expect(readCaptureRecord({ managedDir }).record).toMatchObject({
      lastHealthyVersion: B,
      preUpgradeCapture: { name: "doctor-upgrade", fromVersion: A, toVersion: B, source: "healthy_start", settled: true },
    });
  });

  it("keeps copies from before the record too while the installed version is unknown", () => {
    clock = kStart + 60 * kDay;
    for (const [name, days] of [["doctor-old", 40], ["doctor-older", 20], ["doctor-c3", 3], ["doctor-c2", 2], ["doctor-c1", 1]]) capture(name, clock - days * kDay);
    const tracker = makeTracker();
    healthyStart(tracker);
    installed = null;
    expect(verdicts(tracker)).toMatchObject({ "doctor-old": "kept_unplaced:version_unknown", "doctor-older": "kept_unplaced:version_unknown" });
    expect(sweep(tracker).removed).toBe(0);
    installed = A;
    expect(sweep(tracker).removed).toBe(2);
    expect(left()).toEqual(["doctor-c1", "doctor-c2", "doctor-c3"]);
  });

  it("while the record can't be saved, copies from before the record still follow the keep-3-and-7-days rule and the rest are kept", () => {
    let failWrites = false;
    const flakyFs = Object.create(fs);
    flakyFs.renameSync = (...args) => {
      if (failWrites) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      return fs.renameSync(...args);
    };
    clock = kStart + 60 * kDay;
    for (const [name, days] of [["doctor-old", 40], ["doctor-older", 20], ["doctor-c3", 3], ["doctor-c2", 2], ["doctor-c1", 1]]) capture(name, clock - days * kDay);
    const tracker = makeTracker({ fsModule: flakyFs });
    healthyStart(tracker);
    doctorSeals(tracker, "doctor-a-repair1");
    doctorSeals(tracker, "doctor-a-repair2");
    failWrites = true;
    installed = B;
    doctorSeals(tracker, "doctor-upgrade");
    expect(tracker.getState().status).toBe("unsaved");
    expect(verdicts(tracker)).toEqual({
      "doctor-upgrade": "kept_pre_upgrade",
      "doctor-a-repair2": "kept_newest",
      "doctor-a-repair1": "kept_unplaced:record_unsaved",
      "doctor-c1": "kept_recent:before_record",
      "doctor-c2": "kept_recent:before_record",
      "doctor-c3": "kept_recent:before_record",
      "doctor-older": "due:before_record",
      "doctor-old": "due:before_record",
    });
    expect(sweep(tracker).removed).toBe(2);
    expect(left()).toEqual(["doctor-a-repair1", "doctor-a-repair2", "doctor-c1", "doctor-c2", "doctor-c3", "doctor-upgrade"]);
  });

  it("never overwrites a record it could not read, and reads it again next time", () => {
    const tracker = establishedOnA();
    installed = B;
    doctorSeals(tracker, "doctor-upgrade");
    const recordPath = path.join(managedDir, "openclaw-update-captures.json");
    const before = fs.readFileSync(recordPath, "utf8");
    let failReads = true;
    const flakyFs = Object.create(fs);
    flakyFs.openSync = (file, ...rest) => {
      if (failReads && file === recordPath) throw Object.assign(new Error("I/O error"), { code: "EIO" });
      return fs.openSync(file, ...rest);
    };
    const reread = makeTracker({ fsModule: flakyFs });
    expect(sweep(reread).removed).toBe(0);
    healthyStart(reread);
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
    expect(healthyStart(reread)).toEqual({ changed: false, reason: "record_read_failed" });
    expect(verdicts(reread)["doctor-a1"]).toBe("kept_unplaced:record_read_failed");

    failReads = false;
    expect(reread.getState().record.preUpgradeCapture).toMatchObject({ name: "doctor-upgrade", fromVersion: A, toVersion: B, settled: false });
    expect(healthyStart(reread)).toEqual({ changed: true });
    expect(readCaptureRecord({ managedDir }).record).toMatchObject({ lastHealthyVersion: B, preUpgradeCapture: { name: "doctor-upgrade", settled: true } });
  });

  it("keeps every capture while the record cannot be saved, and saves it on the next sweep", () => {
    let failWrites = false;
    const flakyFs = Object.create(fs);
    flakyFs.renameSync = (...args) => {
      if (failWrites) throw Object.assign(new Error("I/O error"), { code: "EIO" });
      return fs.renameSync(...args);
    };
    const tracker = establishedOnA();
    const flaky = makeTracker({ fsModule: flakyFs });
    failWrites = true;
    installed = B;
    doctorSeals(flaky, "doctor-upgrade");
    healthyStart(flaky);
    expect(flaky.getState().status).toBe("unsaved");
    expect(sweep(flaky)).toMatchObject({ due: 0, removed: 0 });
    expect(verdicts(flaky)["doctor-a1"]).toBe("kept_unplaced:record_unsaved");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/could not save the record \(EIO\); only captures sealed before the record began are removed until it saves/);
    expect(tracker.getState().record.lastHealthyVersion).toBe(A);

    failWrites = false;
    sweep(flaky);
    expect(readCaptureRecord({ managedDir }).record).toMatchObject({ lastHealthyVersion: B, preUpgradeCapture: { name: "doctor-upgrade", settled: true } });
    expect(left()).toEqual(["doctor-a3", "doctor-upgrade"]);
  });

  it("keeps every capture while the record is unreadable or the installed version unknown, and starts a new record at the next healthy start", () => {
    const tracker = establishedOnA();
    fs.writeFileSync(path.join(managedDir, "openclaw-update-captures.json"), "{not json");
    const reread = makeTracker();
    expect(sweep(reread).removed).toBe(0);
    expect(verdicts(reread)["doctor-a1"]).toBe("kept_unplaced:record_unreadable");
    healthyStart(reread);
    expect(logger.warn).toHaveBeenCalledWith("[alphaclaw] update captures: the record was unreadable; starting a new one");
    expect(verdicts(reread)["doctor-a1"]).toBe("kept_newest:before_record");

    installed = null;
    expect(tracker.getState().installedVersion).toBe(null);
    doctorSeals(reread, "doctor-unknown1");
    doctorSeals(reread, "doctor-unknown2");
    doctorSeals(reread, "doctor-unknown3");
    expect(verdicts(reread)["doctor-unknown1"]).toBe("kept_unplaced:version_unknown");
  });

  it("leaves the Back up now archives on the keep-3-and-7-days rule", () => {
    const backupsDir = path.join(root, "backups");
    fs.mkdirSync(backupsDir);
    clock = kStart + 60 * kDay;
    const ages = { "2026-11-29T10-00-00.000Z-openclaw-backup.tar.gz": 1, "2026-11-28T10-00-00.000Z-openclaw-backup.tar.gz": 2, "2026-11-27T10-00-00.000Z-openclaw-backup.tar.gz": 3, "2026-11-26T10-00-00.000Z-openclaw-backup.tar.gz": 4, "2026-10-01T10-00-00.000Z-openclaw-backup.tar.gz": 40 };
    for (const [name, days] of Object.entries(ages)) {
      fs.writeFileSync(path.join(backupsDir, name), "x");
      fs.utimesSync(path.join(backupsDir, name), (clock - days * kDay) / 1000, (clock - days * kDay) / 1000);
    }
    const tracker = establishedOnA();
    const plan = planRetention({ backupsDir, stateDir, captureState: tracker.getState(), env: {}, nowMs: clock });
    expect(Object.fromEntries(plan.families[0].entries.map((entry) => [entry.name, entry.verdict]))).toEqual({
      "2026-11-29T10-00-00.000Z-openclaw-backup.tar.gz": "kept_newest",
      "2026-11-28T10-00-00.000Z-openclaw-backup.tar.gz": "kept_newest",
      "2026-11-27T10-00-00.000Z-openclaw-backup.tar.gz": "kept_newest",
      "2026-11-26T10-00-00.000Z-openclaw-backup.tar.gz": "kept_recent",
      "2026-10-01T10-00-00.000Z-openclaw-backup.tar.gz": "due",
    });
  });

  it("reads the update capture keep count from the deployment env, and honours it", () => {
    expect(resolveUpdateCaptureKeep({})).toBe(1);
    expect(resolveUpdateCaptureKeep({ ALPHACLAW_UPDATE_CAPTURE_KEEP: "4" })).toBe(4);
    expect(resolveUpdateCaptureKeep({ ALPHACLAW_UPDATE_CAPTURE_KEEP: "0" })).toBe(1);
    expect(resolveUpdateCaptureKeep({ ALPHACLAW_UPDATE_CAPTURE_KEEP: "101" })).toBe(1);
    const tracker = establishedOnA();
    doctorSeals(tracker, "doctor-a4");
    sweep(tracker, { ALPHACLAW_UPDATE_CAPTURE_KEEP: "2" });
    expect(left()).toEqual(["doctor-a2", "doctor-a3", "doctor-a4"]);
  });

  it("names the capture from the manifest path Doctor printed, and nothing else", () => {
    expect(captureNameFromManifest("/data/.openclaw.update-captures/doctor-1b2c/manifest.json")).toBe("doctor-1b2c");
    expect(captureNameFromManifest("~/.openclaw.update-captures/doctor-1b2c/manifest.json")).toBe("doctor-1b2c");
    expect(captureNameFromManifest("/data/elsewhere/doctor-1b2c/manifest.json")).toBe(null);
    expect(captureNameFromManifest("/data/.openclaw.update-captures/../manifest.json")).toBe(null);
  });

  it("shows each capture's verdict and the record in the disk view", async () => {
    const tracker = establishedOnA();
    installed = B;
    doctorSeals(tracker, "doctor-upgrade");
    const reader = createDiskReader({
      resolveStateDir: () => stateDir,
      backupsDir: null,
      resolveEnv: () => ({}),
      listSnapshots: () => [],
      planCopyRetention: (options) => planRetention({ ...options, nowMs: clock }),
      getLastSweep: () => null,
      readCaptureState: () => tracker.getState(),
    });
    const body = await reader.read();
    const group = body.temp.find((entry) => entry.id === "openclaw_update_captures");
    expect(group.retention).toMatchObject({
      updateCaptureKeep: 1,
      due: 0,
      record: { status: "ok", installedVersion: B, lastHealthyVersion: A, preUpgradeCapture: { name: "doctor-upgrade", fromVersion: A, toVersion: B, settled: false } },
    });
    expect(Object.fromEntries(group.items.map((item) => [item.name, item.retention]))).toEqual({
      "doctor-upgrade": "kept_pre_upgrade",
      "doctor-a3": "kept_newest",
      "doctor-a2": "kept_unproven",
      "doctor-a1": "kept_unproven",
    });
  });
});
