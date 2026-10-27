const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createDoctorPhaseTracker,
  createDoctorProgressReader,
  describeDoctorProgress,
} = require("../../lib/server/doctor-progress");

// Lines and order from a real OpenClaw 2026.10.6 doctor --fix on 16 GB of
// 2026.10.4 state (ALPH-23, Ubicloud standard-8): silent for 411 s, then
// these in this order.
const kRealDoctorLines = {
  captureDone: [
    "Pre-repair state retained for manual recovery at /data/.openclaw.update-captures/doctor-ae69f56f/manifest.json.",
    "[gateway] startup trace: doctor.maintenance.preserve-original-state 359666.8ms total=411646.7ms start=51979.9ms",
    "[gateway] startup trace: doctor.database-preflight 822.3ms total=412490.8ms start=411668.5ms",
  ],
  backupDone: "Saved pre-migration SQLite backup: /data/.openclaw/agents/a01/agent/openclaw-agent.sqlite.pre-startup-migration-058ad1c9.bak",
  migrating: "[state/agent-db] agent database schema migration pending; verifying integrity first",
  migrationsDone: "[gateway] startup trace: cli.bootstrap.legacy-state-migrations 97761.5ms total=623008.3ms start=525246.8ms",
};

describe("doctor phase tracker (ALPH-23)", () => {
  it("walks capture → backup → migrate → checks from Doctor's real lines, counting migrated agents", () => {
    const tracker = createDoctorPhaseTracker();
    tracker.onOutput("┌  OpenClaw doctor\n");
    expect(tracker.snapshot()).toEqual({ phase: "capture", migrated: 0 });
    tracker.onOutput(kRealDoctorLines.captureDone.join("\n") + "\n");
    expect(tracker.snapshot().phase).toBe("backup");
    tracker.onOutput(kRealDoctorLines.backupDone + "\n");
    tracker.onOutput(kRealDoctorLines.migrating + "\n" + kRealDoctorLines.migrating.slice(0, 20));
    expect(tracker.snapshot()).toEqual({ phase: "migrate", migrated: 1 });
    tracker.onOutput(kRealDoctorLines.migrating.slice(20) + "\n");
    expect(tracker.snapshot()).toEqual({ phase: "migrate", migrated: 2 });
    tracker.onOutput(kRealDoctorLines.migrationsDone + "\n");
    expect(tracker.snapshot().phase).toBe("checks");
  });

  it("keeps counting agent migrations that come after the checks marker (2026.10.8 order, startup trace on)", () => {
    const tracker = createDoctorPhaseTracker();
    tracker.onOutput(kRealDoctorLines.captureDone.join("\n") + "\n");
    tracker.onOutput(kRealDoctorLines.backupDone + "\n");
    tracker.onOutput(kRealDoctorLines.migrationsDone + "\n");
    expect(tracker.snapshot().phase).toBe("checks");
    tracker.onOutput(`${kRealDoctorLines.migrating}\n${kRealDoctorLines.migrating}\n`);
    expect(tracker.snapshot()).toEqual({ phase: "migrate", migrated: 2 });
  });

  it("never moves backwards", () => {
    const tracker = createDoctorPhaseTracker();
    tracker.onOutput(kRealDoctorLines.migrationsDone + "\n" + kRealDoctorLines.captureDone[2] + "\n");
    expect(tracker.snapshot().phase).toBe("checks");
  });

  it("names a skipped capture's end as the backup phase", () => {
    const tracker = createDoctorPhaseTracker();
    tracker.onOutput("Original state capture was unavailable: not enough free space\n");
    expect(tracker.snapshot().phase).toBe("backup");
  });
});

describe("doctor progress words", () => {
  it("says what each phase is doing", () => {
    expect(describeDoctorProgress({ phase: "capture", doneBytes: 4.1e9, totalBytes: 16e9 })).toBe("Making a recovery copy: 4.1 of 16.0 GB");
    expect(describeDoctorProgress({ phase: "capture", doneBytes: 0, totalBytes: 16e9 })).toBe("Preparing OpenClaw's data upgrade");
    expect(describeDoctorProgress({ phase: "backup", doneBytes: 20e9, totalBytes: 16e9 })).toBe("Backing up each database: 16.0 of 16.0 GB");
    expect(describeDoctorProgress({ phase: "migrate", migrated: 7, agentDatabases: 20 })).toBe("Migrating agent databases: 7 of 20");
    expect(describeDoctorProgress({ phase: "checks" })).toBe("Checking sessions and transcripts");
    expect(describeDoctorProgress({ phase: "capture", doneBytes: 420e6, totalBytes: 16e9 })).toBe("Making a recovery copy: 420 MB of 16.0 GB");
  });
});

describe("doctor progress reader", () => {
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes));
  };
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-progress-"));
    const stateDir = path.join(root, ".openclaw");
    const stateDb = path.join(stateDir, "state", "openclaw.sqlite");
    const agentDbs = ["main", "a01"].map((id) => path.join(stateDir, "agents", id, "agent", "openclaw-agent.sqlite"));
    write(stateDb, 1000);
    for (const db of agentDbs) write(db, 4000);
    return { root, stateDir, databaseFiles: [stateDb, ...agentDbs] };
  };

  it("measures this run's recovery copy, not an interrupted run's copy", () => {
    const { root, stateDir, databaseFiles } = setup();
    const captures = stateDir + ".update-captures";
    const orphan = path.join(captures, "doctor-old");
    write(path.join(orphan, "agents", "main", "openclaw-agent.sqlite"), 9000);
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(orphan, past, past);
    write(path.join(captures, "doctor-new", "agents", "main", "openclaw-agent.sqlite"), 3000);
    const read = createDoctorProgressReader({ stateDir: () => stateDir, listStateDbFiles: () => databaseFiles });
    expect(read({ phase: "capture", startedAtMs: Date.now() - 1000 })).toEqual({
      phase: "capture",
      words: "Making a recovery copy: 1 MB of 1 MB",
      doneBytes: 3000,
      totalBytes: 9000,
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("counts finished backups and the ones still staged in .sqlite-publish-*", () => {
    const { root, stateDir, databaseFiles } = setup();
    write(databaseFiles[1] + ".pre-startup-migration-abc.bak", 4000);
    write(path.join(path.dirname(databaseFiles[2]), ".sqlite-publish-x1", "database.sqlite"), 1500);
    const read = createDoctorProgressReader({ stateDir: () => stateDir, listStateDbFiles: () => databaseFiles });
    expect(read({ phase: "backup", startedAtMs: Date.now() - 1000 })).toMatchObject({ doneBytes: 5500, totalBytes: 9000 });
    expect(read({ phase: "migrate", migrated: 1, startedAtMs: Date.now() - 1000 }).words).toBe("Migrating agent databases: 1 of 2");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
