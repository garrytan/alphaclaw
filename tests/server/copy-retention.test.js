const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  planRetention,
  resolveRetentionPolicy,
  sweepRetainedCopies,
  getLastRetentionSweep,
  kCaptureMarker,
  kCaptureMarkerContent,
} = require("../../lib/server/copy-retention");
const { createDiskReader } = require("../../lib/server/box-status/disk");

const kDay = 24 * 60 * 60 * 1000;
const kNow = Date.parse("2026-10-25T12:00:00Z");

describe("copy retention", () => {
  let root;
  let stateDir;
  let backupsDir;
  let captures;
  const logger = { log: vi.fn() };

  const archive = (name, ageDays) => {
    const filePath = path.join(backupsDir, name);
    fs.writeFileSync(filePath, Buffer.alloc(4096, 1));
    const at = (kNow - ageDays * kDay) / 1000;
    fs.utimesSync(filePath, at, at);
    return filePath;
  };
  const capture = (name, ageDays, { marker = kCaptureMarkerContent, manifest = true, partial = false } = {}) => {
    const directory = path.join(captures, name);
    fs.mkdirSync(path.join(directory, "payload"), { recursive: true });
    fs.writeFileSync(path.join(directory, "payload", "state.sqlite"), Buffer.alloc(8192, 1));
    if (marker !== null) fs.writeFileSync(path.join(directory, kCaptureMarker), marker);
    if (partial) fs.writeFileSync(path.join(directory, "manifest.json.partial"), "{}");
    if (manifest) {
      fs.writeFileSync(path.join(directory, "manifest.json"), "{}");
      const at = (kNow - ageDays * kDay) / 1000;
      fs.utimesSync(path.join(directory, "manifest.json"), at, at);
    }
    return directory;
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "copy-retention-")));
    stateDir = path.join(root, "state");
    backupsDir = path.join(root, "backups", "openclaw");
    captures = stateDir + ".update-captures";
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.mkdirSync(captures, { recursive: true });
    logger.log.mockClear();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reads the policy from the deployment env and falls back on junk", () => {
    expect(resolveRetentionPolicy({})).toEqual({ keep: 3, days: 7 });
    expect(resolveRetentionPolicy({ ALPHACLAW_BACKUP_RETENTION_KEEP: "5", ALPHACLAW_BACKUP_RETENTION_DAYS: "30" })).toEqual({ keep: 5, days: 30 });
    expect(resolveRetentionPolicy({ ALPHACLAW_BACKUP_RETENTION_KEEP: "0", ALPHACLAW_BACKUP_RETENTION_DAYS: "-1" })).toEqual({ keep: 3, days: 7 });
    expect(resolveRetentionPolicy({ ALPHACLAW_BACKUP_RETENTION_KEEP: "101", ALPHACLAW_BACKUP_RETENTION_DAYS: "lots" })).toEqual({ keep: 3, days: 7 });
  });

  it("keeps the newest 3 and anything under 7 days, and never plans an operator's own file", () => {
    archive("2026-10-24T10-00-00.000+00-00-openclaw-backup.tar.gz", 1);
    archive("2026-10-20T10-00-00.000+00-00-openclaw-backup.tar.gz", 5);
    archive("2026-10-19T10-00-00.000+00-00-openclaw-backup.tar.gz", 6);
    archive("2026-10-18T10-00-00.000+00-00-openclaw-backup.tar.gz", 6.5);
    archive("2026-09-01T10-00-00.000+00-00-openclaw-backup.tar.gz", 54);
    archive("2026-08-01T10-00-00.000Z-openclaw-backup.tar.gz", 85);
    archive("before-migration.tar.gz", 400);
    fs.mkdirSync(path.join(backupsDir, "2026-01-01T00-00-00.000Z-openclaw-backup.tar.gz"));

    const plan = planRetention({ backupsDir, stateDir: null, env: {}, nowMs: kNow });
    const verdicts = Object.fromEntries(plan.families[0].entries.map((entry) => [entry.name, entry.reason ? entry.verdict + ":" + entry.reason : entry.verdict]));
    expect(verdicts).toEqual({
      "2026-10-24T10-00-00.000+00-00-openclaw-backup.tar.gz": "kept_newest",
      "2026-10-20T10-00-00.000+00-00-openclaw-backup.tar.gz": "kept_newest",
      "2026-10-19T10-00-00.000+00-00-openclaw-backup.tar.gz": "kept_newest",
      "2026-10-18T10-00-00.000+00-00-openclaw-backup.tar.gz": "kept_recent",
      "2026-09-01T10-00-00.000+00-00-openclaw-backup.tar.gz": "due",
      "2026-08-01T10-00-00.000Z-openclaw-backup.tar.gz": "due",
      "2026-01-01T00-00-00.000Z-openclaw-backup.tar.gz": "not_managed:not_a_file",
    });
  });

  it("plans only sealed captures that carry OpenClaw's exact marker", () => {
    capture("doctor-a", 1);
    capture("doctor-b", 2);
    capture("doctor-c", 3);
    capture("update-old", 40);
    capture("operator-copy", 90, { marker: null });
    capture("forged", 90, { marker: "openclaw-private-update-capture-v2\n" });
    capture("unsealed", 90, { partial: true });
    capture("unpublished", 90, { manifest: false });
    capture("bad name!", 90);
    const plan = planRetention({ backupsDir: null, stateDir, env: {}, nowMs: kNow });
    const verdicts = Object.fromEntries(plan.families[0].entries.map((entry) => [entry.name, entry.reason ? entry.verdict + ":" + entry.reason : entry.verdict]));
    expect(verdicts).toEqual({
      "doctor-a": "kept_newest",
      "doctor-b": "kept_newest",
      "doctor-c": "kept_newest",
      "update-old": "due",
      "operator-copy": "not_managed:no_marker",
      forged: "not_managed:no_marker",
      unsealed: "not_managed:unsealed",
      unpublished: "not_managed:unsealed",
    });
    expect(planRetention({ stateDir, env: {}, nowMs: kNow, uid: 123456 }).families[0].entries.every((entry) => entry.reason === "other_owner" || entry.reason === "no_marker" || entry.reason === "unsealed")).toBe(true);
  });

  it("removes what is due, keeps what a process holds open and logs one line", () => {
    for (let index = 0; index < 3; index += 1) archive(`2026-10-2${index}T10-00-00.000Z-openclaw-backup.tar.gz`, 1);
    const oldArchive = archive("2026-09-01T10-00-00.000Z-openclaw-backup.tar.gz", 54);
    const heldArchive = archive("2026-08-01T10-00-00.000Z-openclaw-backup.tar.gz", 85);
    for (const name of ["doctor-a", "doctor-b", "doctor-c"]) capture(name, 1);
    const oldCapture = capture("update-old", 40);
    const operatorCopy = capture("operator-copy", 90, { marker: null });

    const result = sweepRetainedCopies({ backupsDir, stateDir, env: {}, nowMs: kNow, readOpen: () => new Set([heldArchive]), logger });
    expect(result).toMatchObject({ due: 3, removed: 2, held: 1, failed: 0, unverified: 0, policy: { keep: 3, days: 7 } });
    expect(result.byFamily.alphaclaw_backups.removed).toBe(1);
    expect(result.byFamily.openclaw_update_captures.removed).toBe(1);
    expect(result.byFamily.openclaw_update_captures.freedBytes).toBeGreaterThanOrEqual(8192);
    expect(fs.existsSync(oldArchive)).toBe(false);
    expect(fs.existsSync(oldCapture)).toBe(false);
    expect(fs.existsSync(heldArchive)).toBe(true);
    expect(fs.existsSync(operatorCopy)).toBe(true);
    expect(fs.readdirSync(captures).sort()).toEqual(["doctor-a", "doctor-b", "doctor-c", "operator-copy"]);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0][0]).toMatch(/retention sweep: keep newest 3 and anything under 7 days; 3 due, removed 2/);
    expect(getLastRetentionSweep()).toBe(result);
  });

  it("is skipped while an operator holds the box lock, and runs under it otherwise", () => {
    const { setBoxLockForTests } = require("../../lib/server/box-lock");
    archive("2026-10-24T10-00-00.000Z-openclaw-backup.tar.gz", 1);
    for (let index = 0; index < 3; index += 1) archive(`2026-10-2${index}T10-00-00.000Z-openclaw-backup.tar.gz`, 1);
    const oldArchive = archive("2026-09-01T10-00-00.000Z-openclaw-backup.tar.gz", 54);
    const steps = [];
    try {
      setBoxLockForTests({ tryWithBoxLockSync: (options) => { steps.push(options); return { ran: false, error: { code: "box_locked", message: "The box lock is held by OPS-7 (db-migrate)." } }; } });
      expect(sweepRetainedCopies({ backupsDir, stateDir, env: {}, nowMs: kNow, readOpen: () => new Set(), logger })).toEqual({ skipped: "box_locked" });
      expect(fs.existsSync(oldArchive)).toBe(true);
      expect(logger.log.mock.calls.at(-1)[0]).toBe("[alphaclaw] retention sweep: skipped: The box lock is held by OPS-7 (db-migrate).");
      expect(steps).toEqual([{ step: "sweep-delete", by: "retention-sweep" }]);

      setBoxLockForTests({ tryWithBoxLockSync: (options, fn) => ({ ran: true, value: fn() }) });
      expect(sweepRetainedCopies({ backupsDir, stateDir, env: {}, nowMs: kNow, readOpen: () => new Set(), logger })).toMatchObject({ due: 1, removed: 1 });
      expect(fs.existsSync(oldArchive)).toBe(false);
    } finally {
      setBoxLockForTests(null);
    }
  });

  it("removes nothing when /proc can't be read, and stays quiet when nothing is due", () => {
    for (let index = 0; index < 4; index += 1) archive(`2026-0${index + 1}-01T10-00-00.000Z-openclaw-backup.tar.gz`, 300 - index);
    const result = sweepRetainedCopies({ backupsDir, stateDir, env: {}, nowMs: kNow, readOpen: () => null, logger });
    expect(result).toMatchObject({ due: 1, removed: 0, unverified: 1 });
    expect(fs.readdirSync(backupsDir)).toHaveLength(4);

    const quiet = sweepRetainedCopies({ backupsDir, stateDir, env: { ALPHACLAW_BACKUP_RETENTION_KEEP: "10" }, nowMs: kNow, readOpen: () => new Set(), logger: { log: vi.fn() } });
    expect(quiet).toMatchObject({ due: 0, removed: 0 });
    expect(sweepRetainedCopies({ backupsDir: path.join(root, "missing"), stateDir: path.join(root, "missing-state"), env: {}, nowMs: kNow, logger })).toMatchObject({ due: 0 });
  });

  it("shows each item's verdict, the policy and the last sweep in the disk view", async () => {
    for (let index = 0; index < 3; index += 1) archive(`2026-10-2${index}T10-00-00.000Z-openclaw-backup.tar.gz`, 1);
    archive("2026-09-01T10-00-00.000Z-openclaw-backup.tar.gz", 54);
    archive("hand-made.tar.gz", 54);
    capture("doctor-a", 1);
    const reader = createDiskReader({
      resolveStateDir: () => stateDir,
      backupsDir,
      resolveEnv: () => ({}),
      listSnapshots: () => [],
      planCopyRetention: (options) => planRetention({ ...options, nowMs: kNow }),
      getLastSweep: () => ({ at: "2026-10-25T11:30:00.000Z", held: 0, failed: 0, byFamily: { alphaclaw_backups: { removed: 2, freedBytes: 9000 } } }),
    });
    const body = await reader.read();
    const groups = Object.fromEntries(body.temp.map((group) => [group.id, group]));
    expect(groups.alphaclaw_backups.retention).toEqual({ keep: 3, days: 7, due: 1, lastSweep: { at: "2026-10-25T11:30:00.000Z", removed: 2, freedBytes: 9000, held: 0, failed: 0 } });
    const items = Object.fromEntries(groups.alphaclaw_backups.items.map((item) => [item.name, item.retention]));
    expect(items["2026-09-01T10-00-00.000Z-openclaw-backup.tar.gz"]).toBe("due");
    expect(items["2026-10-20T10-00-00.000Z-openclaw-backup.tar.gz"]).toBe("kept_newest");
    expect(items["hand-made.tar.gz"]).toBe("not_managed:name");
    expect(groups.openclaw_update_captures.retention).toMatchObject({ keep: 3, days: 7, due: 0, lastSweep: { removed: 0 } });
    expect(groups.openclaw_update_captures.items[0].retention).toBe("kept_newest");
    expect(groups.config_backups.retention).toBeUndefined();
  });
});
