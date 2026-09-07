// boot-report.json (#76 A1): the two-phase writer's ring rotation, the
// server-phase merge guards (missing bin file, bootId mismatch, corrupt file),
// the not_reached marker, the pinned incident report's replacement rules and
// the pure verdict. Hermetic: real fs on a temp dir plus injected fsModule /
// nowFn seams; every write goes through writeFileAtomic.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kBootReportSchema,
  kBootReportFileName,
  kBootReportIncidentFileName,
  kBootReportRefusedFileName,
  kBootReportRingSize,
  kIncidentPinMaxAgeMs,
  kBinPhaseStatuses,
  kServerPhaseStatuses,
  kPidfileSkipReason,
  kBootVerdicts,
  buildBinPhaseReport,
  describeReportVersions,
  computeVerdict,
  normalizeVerdict,
  createBootReportWriter,
} = require("../../lib/server/boot-report");

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-report-"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const kBootId = "40:1700000000000";
const kOtherBootId = "7:1699999000000";

// A bin-phase report the way bin/alphaclaw.js would shape it after syncAtBoot.
const binReport = (overrides = {}) =>
  buildBinPhaseReport({
    bootId: kBootId,
    at: 1_700_000_000_000,
    alphaclaw: { version: "0.9.77", commit: "abc123", previousVersion: "0.9.76", firstBootOfVersion: true },
    container: { pid1StartTicks: 3431, startMs: 1_699_999_990_000 },
    pidDecision: { evidence: null, decision: "proceed", reason: "absent", record: { raw: null, format: null, legacyClaim: false } },
    openclaw: {
      declaredPin: "2026.9.2",
      channelApplied: null,
      lastKnownGood: null,
      expected: "2026.9.2",
      installedAtBoot: "2026.9.2",
      resolvedForLaunch: "2026.9.2",
      overlayPresent: false,
      overlayComplete: false,
      sentinelMatches: true,
    },
    bootSync: { action: "none", reason: null, warnings: [] },
    ...overrides,
  });

describe("boot-report: buildBinPhaseReport", () => {
  it("shapes every declared field (null when unknown), keeps the pid decision as-is and stamps pending", () => {
    const pidDecision = { evidence: { pid: 21, corroborated: false }, decision: "skip", reason: "legacy_argv_match", record: { raw: { pid: 21, at: 1 }, format: "legacy", legacyClaim: true } };
    const report = buildBinPhaseReport({
      bootId: kBootId,
      at: 1_700_000_000_000,
      alphaclaw: { version: "0.9.77" },
      pidDecision,
      openclaw: { expected: "2026.9.2" },
      bootSync: { action: "skipped_concurrent", reason: "pid_live", warnings: ["w1", 42] },
    });
    expect(report).toEqual({
      schema: kBootReportSchema,
      bootId: kBootId,
      at: 1_700_000_000_000,
      alphaclaw: { version: "0.9.77", commit: null, previousVersion: null, firstBootOfVersion: null },
      container: { pid1StartTicks: null, startMs: null },
      pidfile: pidDecision,
      openclaw: {
        declaredPin: null,
        channelApplied: null,
        lastKnownGood: null,
        expected: "2026.9.2",
        installedAtBoot: null,
        resolvedForLaunch: null,
        installedDiverged: null,
        overlayPresent: null,
        overlayComplete: null,
        sentinelMatches: null,
        bootSync: {
          action: "skipped_concurrent",
          reason: "pid_live",
          warnings: ["w1", "42"],
          danglingRecords: null,
        },
      },
      binPhase: { status: kBinPhaseStatuses.ok },
      serverPhase: { status: kServerPhaseStatuses.pending },
    });
    // The decision record is the store's object, not a copy of selected keys.
    expect(report.pidfile).toBe(pidDecision);
  });

  it("tolerates no arguments at all: a fully-null report, never a throw", () => {
    const report = buildBinPhaseReport();
    expect(report.bootId).toBeNull();
    expect(report.at).toBeNull();
    expect(report.pidfile).toBeNull();
    expect(report.openclaw.bootSync).toEqual({ action: null, reason: null, warnings: [], danglingRecords: null });
    expect(buildBinPhaseReport({ alphaclaw: "garbage", openclaw: [] }).alphaclaw.version).toBeNull();
  });
});

describe("boot-report: writer construction", () => {
  it("requires managedDir and bootId (a writer without an identity could never merge)", () => {
    expect(() => createBootReportWriter({ bootId: kBootId })).toThrow(/managedDir/);
    expect(() => createBootReportWriter({ managedDir: mkTemp() })).toThrow(/bootId/);
    expect(() => createBootReportWriter({ managedDir: mkTemp(), bootId: "" })).toThrow(/bootId/);
  });

  it("exposes the paths under the managed dir with the kName constants", () => {
    const managedDir = path.join(mkTemp(), ".alphaclaw");
    const writer = createBootReportWriter({ managedDir, bootId: kBootId, logger: { warn: vi.fn() } });
    expect(writer.reportPath).toBe(path.join(managedDir, kBootReportFileName));
    expect(writer.incidentPath).toBe(path.join(managedDir, kBootReportIncidentFileName));
    expect(writer.bootId).toBe(kBootId);
  });
});

describe("boot-report: writeBinPhase + ring rotation", () => {
  let managedDir;
  let logger;
  const writerFor = (bootId, extra = {}) =>
    createBootReportWriter({ managedDir, bootId, nowFn: () => 1_700_000_000_000, logger, ...extra });

  beforeEach(() => {
    managedDir = path.join(mkTemp(), ".alphaclaw");
    logger = { warn: vi.fn() };
  });

  it("creates the managed dir, writes the report with the writer's bootId, binPhase ok and serverPhase pending", () => {
    const writer = writerFor(kBootId);
    const written = writer.writeBinPhase(binReport());
    expect(written).not.toBeNull();
    const onDisk = readJson(writer.reportPath);
    expect(onDisk).toEqual(written);
    expect(onDisk.bootId).toBe(kBootId);
    expect(onDisk.binPhase).toEqual({ status: "ok" });
    expect(onDisk.serverPhase).toEqual({ status: "pending" });
    expect(onDisk.openclaw.installedAtBoot).toBe("2026.9.2");
    expect(onDisk.pidfile.decision).toBe("proceed");
    // Atomic write: no temp file left beside the report.
    expect(fs.readdirSync(managedDir)).toEqual([kBootReportFileName]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("stamps the writer's bootId over a report that carries another one, with a warning", () => {
    const writer = writerFor(kBootId);
    writer.writeBinPhase(binReport({ bootId: kOtherBootId }));
    expect(readJson(writer.reportPath).bootId).toBe(kBootId);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/\[boot-report\] bin-phase report carries bootId 7:1699999000000; stamping 40:1700000000000/);
  });

  it("rotates boot-report.json → .1.json → .2.json and drops the oldest (ring of 3)", () => {
    const ids = ["1:1", "2:2", "3:3", "4:4"];
    for (const id of ids) {
      writerFor(id).writeBinPhase(binReport({ bootId: id }));
    }
    expect(kBootReportRingSize).toBe(3);
    expect(fs.readdirSync(managedDir).sort()).toEqual([
      "boot-report.1.json",
      "boot-report.2.json",
      "boot-report.json",
    ]);
    expect(readJson(path.join(managedDir, "boot-report.json")).bootId).toBe("4:4");
    expect(readJson(path.join(managedDir, "boot-report.1.json")).bootId).toBe("3:3");
    expect(readJson(path.join(managedDir, "boot-report.2.json")).bootId).toBe("2:2");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a young box with no predecessors rotates silently (ENOENT is not a warning)", () => {
    const writer = writerFor(kBootId);
    writer.writeBinPhase(binReport());
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(managedDir, "boot-report.1.json"))).toBe(false);
  });

  it("rotation happens ONLY in the bin phase: server-phase writes never move ring files", () => {
    writerFor("1:1").writeBinPhase(binReport({ bootId: "1:1" }));
    const writer = writerFor(kBootId);
    writer.writeBinPhase(binReport());
    const before = fs.readdirSync(managedDir).sort();
    expect(before).toEqual(["boot-report.1.json", "boot-report.json"]);
    writer.mergeServerPhase({ legacyExecApprovalsPresent: false });
    writer.mergeServerPhase({ stateDb: [] });
    writer.markServerPhaseNotReached("test");
    expect(fs.readdirSync(managedDir).sort()).toEqual(before);
    expect(readJson(path.join(managedDir, "boot-report.1.json")).bootId).toBe("1:1");
  });

  it("a garbage report argument still produces a valid pending report", () => {
    const writer = writerFor(kBootId);
    const written = writer.writeBinPhase("not an object");
    expect(written.bootId).toBe(kBootId);
    expect(written.schema).toBe(kBootReportSchema);
    expect(written.serverPhase).toEqual({ status: "pending" });
    expect(written.at).toBe(1_700_000_000_000);
  });
});

describe("boot-report: mergeServerPhase", () => {
  let managedDir;
  let logger;
  let clock;
  const writerFor = (bootId = kBootId) =>
    createBootReportWriter({ managedDir, bootId, nowFn: () => clock, logger });

  beforeEach(() => {
    managedDir = path.join(mkTemp(), ".alphaclaw");
    logger = { warn: vi.fn() };
    clock = 1_700_000_000_000;
  });

  it("merges into the report this boot wrote: bin fields intact, status recorded, verdict derived", () => {
    const writer = writerFor();
    writer.writeBinPhase(binReport());
    clock += 5_000;
    const merged = writer.mergeServerPhase({
      stateDb: [{ path: "/data/.openclaw/openclaw.sqlite", kind: "state", userVersion: 15, status: "ok" }],
      supportedSchema: { state: 15, agent: 19, source: "declared" },
      legacyExecApprovalsPresent: false,
    });
    expect(merged).toEqual(readJson(writer.reportPath));
    expect(merged.bootId).toBe(kBootId);
    expect(merged.openclaw.installedAtBoot).toBe("2026.9.2");
    expect(merged.pidfile.decision).toBe("proceed");
    expect(merged.binPhase).toEqual({ status: "ok" });
    expect(merged.serverPhase).toEqual({
      status: "recorded",
      at: 1_700_000_005_000,
      stateDb: [{ path: "/data/.openclaw/openclaw.sqlite", kind: "state", userVersion: 15, status: "ok" }],
      supportedSchema: { state: 15, agent: 19, source: "declared" },
      legacyExecApprovalsPresent: false,
      verdict: [],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a second merge keeps the first merge's fields and recomputes the verdict over everything known", () => {
    const writer = writerFor();
    writer.writeBinPhase(binReport());
    writer.mergeServerPhase({
      stateDb: [{ path: "/s", kind: "state", userVersion: 16, status: "ok" }],
      supportedSchema: { state: 15, agent: 19, source: "declared" },
    });
    expect(readJson(writer.reportPath).serverPhase.verdict).toEqual(["state_schema_too_new"]);
    const merged = writer.mergeServerPhase({ legacyExecApprovalsPresent: true, config: { sha256: "x" } });
    expect(merged.serverPhase.stateDb).toHaveLength(1);
    expect(merged.serverPhase.config).toEqual({ sha256: "x" });
    expect(merged.serverPhase.status).toBe("recorded");
    expect(merged.serverPhase.verdict).toEqual(["state_schema_too_new", "legacy_exec_approvals_present"]);
  });

  it("an explicit status or verdict in the patch is honoured verbatim", () => {
    const writer = writerFor();
    writer.writeBinPhase(binReport());
    const merged = writer.mergeServerPhase({ status: "complete", verdict: ["hand_written"] });
    expect(merged.serverPhase.status).toBe("complete");
    expect(merged.serverPhase.verdict).toEqual(["hand_written"]);
    // A later patch without a status keeps the non-pending status it found.
    expect(writer.mergeServerPhase({ note: 1 }).serverPhase.status).toBe("complete");
  });

  it("with no bin-phase file, creates the report with binPhase missing and continues (CEO 4.1)", () => {
    const writer = writerFor();
    const merged = writer.mergeServerPhase({ legacyExecApprovalsPresent: true });
    expect(merged).not.toBeNull();
    const onDisk = readJson(writer.reportPath);
    expect(onDisk.schema).toBe(kBootReportSchema);
    expect(onDisk.bootId).toBe(kBootId);
    expect(onDisk.at).toBe(clock);
    expect(onDisk.binPhase).toEqual({ status: "missing" });
    expect(onDisk.alphaclaw).toBeNull();
    expect(onDisk.openclaw).toBeNull();
    expect(onDisk.pidfile).toBeNull();
    expect(onDisk.serverPhase.status).toBe("recorded");
    expect(onDisk.serverPhase.legacyExecApprovalsPresent).toBe(true);
    expect(onDisk.serverPhase.verdict).toEqual(["legacy_exec_approvals_present"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/\[boot-report\] .*boot-report\.json is missing \(no bin phase\)/);
    // No rotation happened: the ring is still just the one file.
    expect(fs.readdirSync(managedDir)).toEqual([kBootReportFileName]);
  });

  it("a file from another boot is replaced by a fresh report (binPhase mismatch + previousBootId), never merged (Codex D16)", () => {
    createBootReportWriter({ managedDir, bootId: kOtherBootId, nowFn: () => clock, logger })
      .writeBinPhase(binReport({ bootId: kOtherBootId }));
    const writer = writerFor(kBootId);
    const merged = writer.mergeServerPhase({ legacyExecApprovalsPresent: false });
    expect(merged.bootId).toBe(kBootId);
    expect(merged.binPhase).toEqual({ status: "mismatch", previousBootId: kOtherBootId });
    // The other boot's bin fields are NOT carried over — they described a
    // different process.
    expect(merged.openclaw).toBeNull();
    expect(merged.pidfile).toBeNull();
    expect(merged.serverPhase.status).toBe("recorded");
    expect(readJson(writer.reportPath)).toEqual(merged);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/belongs to boot 7:1699999000000, not 40:1700000000000/);
  });

  it("a corrupt file is rewritten from scratch with binPhase unreadable and previous: \"unreadable\"", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, kBootReportFileName), "{ not json");
    const writer = writerFor();
    const merged = writer.mergeServerPhase({ stateDb: [] });
    expect(merged.binPhase).toEqual({ status: "unreadable" });
    expect(merged.previous).toBe("unreadable");
    expect(merged.bootId).toBe(kBootId);
    expect(merged.serverPhase).toMatchObject({ status: "recorded", stateDb: [], verdict: [] });
    expect(readJson(writer.reportPath)).toEqual(merged);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/is unreadable .*rewriting it from scratch/);
  });

  it("a parseable file that is not an object (array, string) counts as unreadable too", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, kBootReportFileName), "[1,2,3]");
    const writer = writerFor();
    expect(writer.mergeServerPhase({}).binPhase).toEqual({ status: "unreadable" });
  });

  it("a garbage patch merges as an empty patch", () => {
    const writer = writerFor();
    writer.writeBinPhase(binReport());
    const merged = writer.mergeServerPhase("nope");
    expect(merged.serverPhase).toEqual({ status: "recorded", at: clock, verdict: [] });
  });
});

describe("boot-report: writeRefusedBinPhase (a refused second instance never evicts the live server's report)", () => {
  let managedDir;
  let logger;
  const writerFor = (bootId = kBootId, extra = {}) =>
    createBootReportWriter({ managedDir, bootId, nowFn: () => 1_700_000_002_000, logger, ...extra });
  // The live sibling's COMPLETED report at slot 0 plus one rotated predecessor.
  const seedLiveRing = () => {
    writerFor("1:1").writeBinPhase(binReport({ bootId: "1:1" }));
    const live = writerFor(kOtherBootId);
    live.writeBinPhase(binReport({ bootId: kOtherBootId }));
    live.mergeServerPhase({ stateDb: [], legacyExecApprovalsPresent: false });
    return {
      current: fs.readFileSync(path.join(managedDir, "boot-report.json"), "utf8"),
      rotated: fs.readFileSync(path.join(managedDir, "boot-report.1.json"), "utf8"),
    };
  };
  const skipDecision = {
    evidence: { pid: 21, corroborated: true },
    decision: "skip",
    reason: "corroborated",
    record: { raw: { pid: 21, at: 1, startTicks: 5 }, format: 2, legacyClaim: false },
  };

  beforeEach(() => {
    managedDir = path.join(mkTemp(), ".alphaclaw");
    logger = { warn: vi.fn() };
  });

  it("writes boot-report-refused.json with serverPhase not_reached/pidfile_skip and leaves slot 0 and the ring byte-for-byte untouched", () => {
    const seeded = seedLiveRing();
    const writer = writerFor();
    const refused = writer.writeRefusedBinPhase(
      binReport({
        pidDecision: skipDecision,
        // The #76 shape behind a live claim: the applied build never activated.
        openclaw: { expected: "2026.9.2", installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.7.1-2", installedDiverged: true },
        bootSync: { action: "skipped_concurrent", reason: "live_server_corroborated", warnings: [] },
      }),
      kPidfileSkipReason,
    );
    expect(refused).not.toBeNull();
    expect(writer.refusedPath).toBe(path.join(managedDir, kBootReportRefusedFileName));
    expect(readJson(writer.refusedPath)).toEqual(refused);
    expect(refused.bootId).toBe(kBootId);
    expect(refused.binPhase).toEqual({ status: "ok" });
    expect(refused.pidfile).toEqual(skipDecision);
    expect(refused.serverPhase).toEqual({
      status: "not_reached",
      reason: "pidfile_skip",
      at: 1_700_000_002_000,
      // The bin half is judged (the running tree is not the expected build);
      // pidfile_contradiction needs a server phase that never comes.
      verdict: ["installed_not_expected"],
    });
    // No rotation, no slot-0 write: the live server's report is still current.
    expect(fs.readdirSync(managedDir).sort()).toEqual([
      "boot-report-refused.json",
      "boot-report.1.json",
      "boot-report.json",
    ]);
    expect(fs.readFileSync(path.join(managedDir, "boot-report.json"), "utf8")).toBe(seeded.current);
    expect(fs.readFileSync(path.join(managedDir, "boot-report.1.json"), "utf8")).toBe(seeded.rotated);
    const reports = writer.readBootReports();
    expect(reports.current.bootId).toBe(kOtherBootId);
    expect(reports.current.serverPhase.status).toBe("recorded");
    expect(reports.refused).toEqual(refused);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("three refused starts in a row still leave the live ring intact (the eviction the incident pin exists to prevent)", () => {
    const seeded = seedLiveRing();
    for (const id of ["50:1", "51:1", "52:1"]) {
      writerFor(id).writeRefusedBinPhase(binReport({ bootId: id, pidDecision: skipDecision }));
    }
    expect(fs.readFileSync(path.join(managedDir, "boot-report.json"), "utf8")).toBe(seeded.current);
    expect(fs.readFileSync(path.join(managedDir, "boot-report.1.json"), "utf8")).toBe(seeded.rotated);
    expect(fs.existsSync(path.join(managedDir, "boot-report.2.json"))).toBe(false);
    // The refused file holds the LAST refused attempt.
    expect(readJson(path.join(managedDir, kBootReportRefusedFileName)).bootId).toBe("52:1");
  });

  it("defaults the reason to pidfile_skip, stamps the writer's bootId, and a garbage reason reads as unknown", () => {
    const writer = writerFor();
    expect(writer.writeRefusedBinPhase(binReport({ bootId: kOtherBootId })).serverPhase).toEqual(
      expect.objectContaining({ status: "not_reached", reason: kPidfileSkipReason }),
    );
    expect(readJson(writer.refusedPath).bootId).toBe(kBootId);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(writer.writeRefusedBinPhase(binReport(), 42).serverPhase.reason).toBe("unknown");
    // A refused attempt never creates a ring file of its own.
    expect(fs.existsSync(path.join(managedDir, kBootReportFileName))).toBe(false);
  });

  it("a failing write costs one warning naming the refused file and a null result", () => {
    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const fsModule = { ...fs, writeFileSync: () => { throw enospc; } };
    const writer = writerFor(kBootId, { fsModule });
    expect(writer.writeRefusedBinPhase(binReport())).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/could not write .*boot-report-refused\.json \(ENOSPC/);
  });
});

describe("boot-report: markServerPhaseNotReached", () => {
  let managedDir;
  let logger;
  const writerFor = (bootId = kBootId) =>
    createBootReportWriter({ managedDir, bootId, nowFn: () => 1_700_000_001_000, logger });

  beforeEach(() => {
    managedDir = path.join(mkTemp(), ".alphaclaw");
    logger = { warn: vi.fn() };
  });

  it("replaces the pending server phase with { status: not_reached, reason } and keeps the bin phase", () => {
    const writer = writerFor();
    writer.writeBinPhase(binReport());
    const marked = writer.markServerPhaseNotReached("not_onboarded");
    expect(marked.serverPhase).toEqual({
      status: "not_reached",
      reason: "not_onboarded",
      at: 1_700_000_001_000,
      verdict: [],
    });
    expect(marked.openclaw.installedAtBoot).toBe("2026.9.2");
    expect(readJson(writer.reportPath)).toEqual(marked);
  });

  it("the verdict still covers the bin phase (installed_not_expected) but never pidfile_contradiction", () => {
    const writer = writerFor();
    writer.writeBinPhase(
      binReport({
        openclaw: { expected: "2026.9.2", installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.7.1-2" },
        pidDecision: { evidence: { pid: 21, corroborated: true }, decision: "skip", reason: "corroborated" },
      }),
    );
    const marked = writer.markServerPhaseNotReached("pidfile_skip");
    expect(marked.serverPhase.verdict).toEqual(["installed_not_expected"]);
  });

  it("applies the same guards as a merge: missing file → binPhase missing; no reason → \"unknown\"", () => {
    const writer = writerFor();
    const marked = writer.markServerPhaseNotReached();
    expect(marked.binPhase).toEqual({ status: "missing" });
    expect(marked.serverPhase.status).toBe("not_reached");
    expect(marked.serverPhase.reason).toBe("unknown");
  });
});

describe("boot-report: computeVerdict", () => {
  const inconsistent = (report) => computeVerdict(report);
  const withServer = (serverPhase, openclaw = {}) => ({
    ...binReport({ openclaw: { expected: "2026.9.2", installedAtBoot: "2026.9.2", ...openclaw } }),
    serverPhase: { status: "recorded", ...serverPhase },
  });
  const kSupported = { state: 15, agent: 19, source: "declared" };

  it("a consistent boot has an empty verdict", () => {
    expect(
      inconsistent(
        withServer({
          stateDb: [
            { path: "/s", kind: "state", userVersion: 15, status: "ok" },
            { path: "/a", kind: "agent", userVersion: 19, status: "ok" },
            { path: "/m", kind: "agent", userVersion: null, status: "missing" },
          ],
          supportedSchema: kSupported,
          legacyExecApprovalsPresent: false,
        }),
      ),
    ).toEqual([]);
    expect(inconsistent(null)).toEqual([]);
    expect(inconsistent({})).toEqual([]);
    expect(inconsistent(binReport())).toEqual([]);
  });

  it("installed_not_expected judges the tree the gateway will RUN (resolvedForLaunch), never the pre-sync installedAtBoot", () => {
    // The applied build never activated: what runs is not what was expected.
    expect(inconsistent(withServer({}, { installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.7.1-2" }))).toEqual([
      "installed_not_expected",
    ]);
    // An ACTIVATION boot: the container woke up on the old tree and the sync
    // activated the expected build — installedAtBoot differs, the launch does
    // not. This is a HEALTHY boot (the e2e's activated-boot shape), not a
    // latched version mismatch.
    expect(inconsistent(withServer({}, { installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.9.2" }))).toEqual([]);
    // installedAtBoot alone (no post-sync read) is evidence, never a finding.
    expect(inconsistent(withServer({}, { installedAtBoot: "2026.7.1-2", resolvedForLaunch: null }))).toEqual([]);
    // An unknown side is silence.
    expect(inconsistent(withServer({}, { installedAtBoot: null, resolvedForLaunch: null }))).toEqual([]);
    expect(inconsistent(withServer({}, { expected: null, resolvedForLaunch: "2026.7.1-2" }))).toEqual([]);
    expect(inconsistent(withServer({}, { expected: "", resolvedForLaunch: "x" }))).toEqual([]);
  });

  it("installed_not_expected: the e2e activated-boot report with a recorded server phase is consistent", () => {
    // Exactly the bin-phase report tests/server/openclaw-channel-boot.e2e.test.js
    // pins for a healthy activation, plus the server phase's own post-sync read.
    const activated = {
      ...binReport({
        openclaw: {
          declaredPin: "1.0.0",
          channelApplied: "beta:1.1.0",
          lastKnownGood: { package: null, dev: null },
          expected: "1.1.0",
          installedAtBoot: "1.0.0",
          resolvedForLaunch: "1.1.0",
          installedDiverged: false,
          overlayPresent: true,
          overlayComplete: true,
          sentinelMatches: true,
        },
        bootSync: { action: "activated", reason: null, warnings: [] },
      }),
      serverPhase: { status: "recorded", installedVersion: "1.1.0", legacyExecApprovalsPresent: false },
    };
    expect(inconsistent(activated)).toEqual([]);
    expect(describeReportVersions(activated)).toEqual({ expected: "1.1.0", running: "1.1.0", diverged: false });
  });

  it("installed_not_expected honours the bin phase's canonical installedDiverged (a live pinLag excuses the lagging pair), the way computeInstalledDiverged does", () => {
    // AlphaClaw self-update: the pin moved to 2026.9.2, npm has not reinstalled
    // yet, the sync recorded state.pinLag — the predicate says "not diverged".
    const lagging = { expected: "2026.9.2", installedAtBoot: "2026.9.1", resolvedForLaunch: "2026.9.1" };
    expect(inconsistent(withServer({}, { ...lagging, installedDiverged: false }))).toEqual([]);
    expect(inconsistent(withServer({}, { ...lagging, installedDiverged: true }))).toEqual(["installed_not_expected"]);
    // No predicate recorded (an older report): the plain comparison decides.
    expect(inconsistent(withServer({}, { ...lagging, installedDiverged: null }))).toEqual(["installed_not_expected"]);
  });

  it("installed_not_expected with NO bin phase falls back to the server phase's channelInfo snapshot", () => {
    const noBin = (channelInfo, serverExtra = {}) => ({
      ...binReport(),
      openclaw: null,
      binPhase: { status: "missing" },
      serverPhase: { status: "recorded", channelInfo, ...serverExtra },
    });
    expect(
      inconsistent(noBin({ installedVersion: "2026.9.1", expectedVersion: "2026.9.2", installedDiverged: null })),
    ).toEqual(["installed_not_expected"]);
    expect(
      inconsistent(noBin({ installedVersion: "2026.9.1", expectedVersion: "2026.9.2", installedDiverged: true })),
    ).toEqual(["installed_not_expected"]);
    // The live predicate excused it (pinLag): silence.
    expect(
      inconsistent(noBin({ installedVersion: "2026.9.1", expectedVersion: "2026.9.2", installedDiverged: false })),
    ).toEqual([]);
    // The server phase's own read outranks the snapshot's installedVersion.
    expect(
      inconsistent(
        noBin({ installedVersion: "2026.9.1", expectedVersion: "2026.9.2", installedDiverged: null }, { installedVersion: "2026.9.2" }),
      ),
    ).toEqual([]);
    expect(inconsistent(noBin(null))).toEqual([]);
    expect(inconsistent(noBin({ installedVersion: null, expectedVersion: "2026.9.2", installedDiverged: null }))).toEqual([]);
  });

  it("describeReportVersions: precedence bin resolvedForLaunch → serverPhase.installedVersion → channelInfo; null-null when nothing is known", () => {
    expect(
      describeReportVersions({
        openclaw: { expected: "b", resolvedForLaunch: "a", installedAtBoot: "z" },
        serverPhase: { installedVersion: "c", channelInfo: { installedVersion: "d", expectedVersion: "e" } },
      }),
    ).toEqual({ expected: "b", running: "a", diverged: true });
    expect(
      describeReportVersions({
        openclaw: { expected: null, resolvedForLaunch: null, installedAtBoot: "z" },
        serverPhase: { installedVersion: "c", channelInfo: { installedVersion: "d", expectedVersion: "c" } },
      }),
    ).toEqual({ expected: "c", running: "c", diverged: false });
    expect(describeReportVersions({ openclaw: null, serverPhase: { channelInfo: { installedVersion: "d", expectedVersion: "e" } } })).toEqual({
      expected: "e",
      running: "d",
      diverged: true,
    });
    expect(describeReportVersions({ openclaw: { installedAtBoot: "z" } })).toEqual({ expected: null, running: null, diverged: null });
    expect(describeReportVersions(null)).toEqual({ expected: null, running: null, diverged: null });
  });

  it("state_schema_too_new / agent_schema_too_new: any entry of that kind above the supported schema", () => {
    const stateDb = [
      { path: "/s", kind: "state", userVersion: 16, status: "ok" },
      { path: "/a1", kind: "agent", userVersion: 19, status: "ok" },
      { path: "/a2", kind: "agent", userVersion: 20, status: "ok" },
    ];
    expect(inconsistent(withServer({ stateDb, supportedSchema: kSupported }))).toEqual([
      "state_schema_too_new",
      "agent_schema_too_new",
    ]);
    // Equal or older is fine; a kind with no supported number is indeterminate.
    expect(inconsistent(withServer({ stateDb, supportedSchema: { state: 16, agent: null } }))).toEqual([]);
    expect(inconsistent(withServer({ stateDb }))).toEqual([]);
    // A null userVersion (busy/indeterminate) never counts as "too new".
    expect(
      inconsistent(
        withServer({
          stateDb: [{ path: "/s", kind: "state", userVersion: null, status: "busy" }],
          supportedSchema: kSupported,
        }),
      ),
    ).toEqual([]);
  });

  it("state_db_unreadable: any corrupt entry, independent of the schema table", () => {
    expect(
      inconsistent(
        withServer({
          stateDb: [
            { path: "/s", kind: "state", userVersion: null, status: "corrupt", error: { code: "SQLITE_NOTADB" } },
          ],
        }),
      ),
    ).toEqual(["state_db_unreadable"]);
    expect(
      inconsistent(withServer({ stateDb: [{ path: "/s", kind: "state", userVersion: null, status: "error" }] })),
    ).toEqual([]);
  });

  it("legacy_exec_approvals_present only on a literal true", () => {
    expect(inconsistent(withServer({ legacyExecApprovalsPresent: true }))).toEqual(["legacy_exec_approvals_present"]);
    expect(inconsistent(withServer({ legacyExecApprovalsPresent: "true" }))).toEqual([]);
    expect(inconsistent(withServer({ legacyExecApprovalsPresent: null }))).toEqual([]);
  });

  it("pidfile_contradiction: the bin phase skipped for a live owner yet the server phase ran", () => {
    const skip = { evidence: { pid: 21, corroborated: false }, decision: "skip", reason: "legacy_argv_match" };
    const report = withServer({});
    expect(inconsistent({ ...report, pidfile: skip })).toEqual(["pidfile_contradiction"]);
    // proceed is never a contradiction; a pending/not_reached server phase
    // has nothing to contradict.
    expect(inconsistent({ ...report, pidfile: { ...skip, decision: "proceed", reason: "thread" } })).toEqual([]);
    expect(inconsistent({ ...report, pidfile: skip, serverPhase: { status: "pending" } })).toEqual([]);
    expect(inconsistent({ ...report, pidfile: skip, serverPhase: { status: "not_reached", reason: "x" } })).toEqual([]);
  });

  it("every finding at once, in the documented order; the enum is the persisted vocabulary", () => {
    const everything = inconsistent({
      ...withServer(
        {
          stateDb: [
            { path: "/s", kind: "state", userVersion: 99, status: "ok" },
            { path: "/a", kind: "agent", userVersion: 99, status: "ok" },
            { path: "/c", kind: "agent", userVersion: null, status: "corrupt" },
          ],
          supportedSchema: kSupported,
          legacyExecApprovalsPresent: true,
        },
        { installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.7.1-2" },
      ),
      pidfile: { decision: "skip", reason: "legacy_no_argv", evidence: { pid: 5, corroborated: false } },
    });
    expect(everything).toEqual([
      "installed_not_expected",
      "state_schema_too_new",
      "agent_schema_too_new",
      "state_db_unreadable",
      "legacy_exec_approvals_present",
      "pidfile_contradiction",
    ]);
    expect(new Set(everything)).toEqual(new Set(Object.values(kBootVerdicts)));
  });

  it("normalizeVerdict sorts, dedupes and drops non-strings", () => {
    expect(normalizeVerdict(["b", "a", "b", 3, "", null])).toEqual(["a", "b"]);
    expect(normalizeVerdict("a")).toEqual([]);
  });
});

describe("boot-report: pinIncidentReport", () => {
  let managedDir;
  let logger;
  let clock;
  const writerFor = () => createBootReportWriter({ managedDir, bootId: kBootId, nowFn: () => clock, logger });
  const inconsistentReport = (verdict, installedAtBoot = "2026.7.1-2") => ({
    ...binReport({ openclaw: { expected: "2026.9.2", installedAtBoot } }),
    serverPhase: { status: "recorded", verdict },
  });

  beforeEach(() => {
    managedDir = path.join(mkTemp(), ".alphaclaw");
    logger = { warn: vi.fn() };
    clock = 1_700_000_000_000;
  });

  it("a consistent report (empty or absent verdict) is never pinned", () => {
    const writer = writerFor();
    expect(writer.pinIncidentReport(binReport())).toEqual({ pinned: false, reason: "consistent" });
    expect(writer.pinIncidentReport(inconsistentReport([]))).toEqual({ pinned: false, reason: "consistent" });
    expect(writer.pinIncidentReport(null)).toEqual({ pinned: false, reason: "no_report" });
    expect(fs.existsSync(writer.incidentPath)).toBe(false);
  });

  it("the first inconsistent report is pinned with pinnedAt", () => {
    const writer = writerFor();
    const report = inconsistentReport(["installed_not_expected"]);
    expect(writer.pinIncidentReport(report)).toEqual({ pinned: true, reason: "first" });
    const pinned = readJson(writer.incidentPath);
    expect(pinned).toEqual({ ...report, pinnedAt: clock });
    expect(fs.readdirSync(managedDir)).toEqual([kBootReportIncidentFileName]);
  });

  it("a restart loop keeps the FIRST pin: same version + same verdict set within 7 days is not rewritten", () => {
    const writer = writerFor();
    writer.pinIncidentReport(inconsistentReport(["installed_not_expected", "state_schema_too_new"]));
    const firstBytes = fs.readFileSync(writer.incidentPath, "utf8");
    // 13 later boots, each with the verdict in a different order and a new
    // bootId — the report that explains the loop must survive them all.
    for (let boot = 0; boot < 13; boot += 1) {
      clock += 60_000;
      const later = {
        ...inconsistentReport(["state_schema_too_new", "installed_not_expected"]),
        bootId: `${50 + boot}:${clock}`,
      };
      expect(writer.pinIncidentReport(later)).toEqual({ pinned: false, reason: "already_pinned" });
    }
    expect(fs.readFileSync(writer.incidentPath, "utf8")).toBe(firstBytes);
  });

  it("a different verdict set replaces the pin", () => {
    const writer = writerFor();
    writer.pinIncidentReport(inconsistentReport(["installed_not_expected"]));
    clock += 1000;
    expect(
      writer.pinIncidentReport(inconsistentReport(["installed_not_expected", "legacy_exec_approvals_present"])),
    ).toEqual({ pinned: true, reason: "verdict_changed" });
    expect(readJson(writer.incidentPath).serverPhase.verdict).toEqual([
      "installed_not_expected",
      "legacy_exec_approvals_present",
    ]);
    expect(readJson(writer.incidentPath).pinnedAt).toBe(clock);
  });

  it("a different installed version replaces the pin even with the same verdict", () => {
    const writer = writerFor();
    writer.pinIncidentReport(inconsistentReport(["installed_not_expected"], "2026.7.1-2"));
    expect(writer.pinIncidentReport(inconsistentReport(["installed_not_expected"], "2026.8.2"))).toEqual({
      pinned: true,
      reason: "version_changed",
    });
    expect(readJson(writer.incidentPath).openclaw.installedAtBoot).toBe("2026.8.2");
  });

  it("a pin 7 days old is replaced even when version and verdict match; 7 days minus a tick is kept", () => {
    const writer = writerFor();
    writer.pinIncidentReport(inconsistentReport(["installed_not_expected"]));
    clock += kIncidentPinMaxAgeMs - 1;
    expect(writer.pinIncidentReport(inconsistentReport(["installed_not_expected"]))).toEqual({
      pinned: false,
      reason: "already_pinned",
    });
    clock += 1;
    expect(writer.pinIncidentReport(inconsistentReport(["installed_not_expected"]))).toEqual({
      pinned: true,
      reason: "expired",
    });
    expect(readJson(writer.incidentPath).pinnedAt).toBe(clock);
  });

  it("a corrupt existing pin is replaced", () => {
    const writer = writerFor();
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(writer.incidentPath, "garbage");
    expect(writer.pinIncidentReport(inconsistentReport(["installed_not_expected"]))).toEqual({
      pinned: true,
      reason: "replaced_unreadable",
    });
    expect(readJson(writer.incidentPath).serverPhase.verdict).toEqual(["installed_not_expected"]);
  });
});

describe("boot-report: readBootReports", () => {
  let managedDir;
  let logger;

  beforeEach(() => {
    managedDir = path.join(mkTemp(), ".alphaclaw");
    logger = { warn: vi.fn() };
  });

  it("returns current, the rotated predecessors (newest first) and the incident pin", () => {
    for (const id of ["1:1", "2:2", "3:3"]) {
      createBootReportWriter({ managedDir, bootId: id, logger }).writeBinPhase(binReport({ bootId: id }));
    }
    const writer = createBootReportWriter({ managedDir, bootId: "3:3", nowFn: () => 5, logger });
    writer.pinIncidentReport({
      ...binReport({ bootId: "3:3", openclaw: { expected: "a", installedAtBoot: "b" } }),
      serverPhase: { status: "recorded", verdict: ["installed_not_expected"] },
    });
    const reports = writer.readBootReports();
    expect(reports.current.bootId).toBe("3:3");
    expect(reports.previous.map((report) => report.bootId)).toEqual(["2:2", "1:1"]);
    expect(reports.incident.serverPhase.verdict).toEqual(["installed_not_expected"]);
    expect(reports.incident.pinnedAt).toBe(5);
    expect(reports.refused).toBeNull();
    expect(reports.unreadable).toEqual([]);
    // The last refused start rides along, outside the ring.
    createBootReportWriter({ managedDir, bootId: "9:9", logger }).writeRefusedBinPhase(binReport({ bootId: "9:9" }));
    const withRefused = writer.readBootReports();
    expect(withRefused.current.bootId).toBe("3:3");
    expect(withRefused.refused).toEqual(expect.objectContaining({ bootId: "9:9", serverPhase: expect.objectContaining({ status: "not_reached" }) }));
  });

  it("is lenient: missing files are null/empty, corrupt files are skipped and named", () => {
    const writer = createBootReportWriter({ managedDir, bootId: kBootId, logger });
    expect(writer.readBootReports()).toEqual({ current: null, previous: [], incident: null, refused: null, unreadable: [] });
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, "boot-report.json"), "{");
    fs.writeFileSync(path.join(managedDir, "boot-report.1.json"), JSON.stringify({ bootId: "1:1" }));
    fs.writeFileSync(path.join(managedDir, "boot-report.2.json"), "null");
    fs.writeFileSync(path.join(managedDir, "boot-report-incident.json"), "[]");
    fs.writeFileSync(path.join(managedDir, "boot-report-refused.json"), "{");
    const reports = writer.readBootReports();
    expect(reports.current).toBeNull();
    expect(reports.previous).toEqual([{ bootId: "1:1" }]);
    expect(reports.incident).toBeNull();
    expect(reports.refused).toBeNull();
    expect(reports.unreadable).toEqual([
      "boot-report.json",
      "boot-report.2.json",
      "boot-report-incident.json",
      "boot-report-refused.json",
    ]);
    // Reading never warns: diagnose already shows the gap.
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("boot-report: never throws into the boot", () => {
  let managedDir;
  let logger;

  beforeEach(() => {
    managedDir = path.join(mkTemp(), ".alphaclaw");
    logger = { warn: vi.fn() };
  });

  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

  it("a failing write costs one warning per call and a null / { pinned: false } result", () => {
    const fsModule = { ...fs, writeFileSync: () => { throw enospc(); } };
    const writer = createBootReportWriter({ managedDir, bootId: kBootId, fsModule, logger });
    expect(writer.writeBinPhase(binReport())).toBeNull();
    expect(writer.mergeServerPhase({ stateDb: [] })).toBeNull();
    expect(writer.markServerPhaseNotReached("x")).toBeNull();
    expect(
      writer.pinIncidentReport({ ...binReport(), serverPhase: { status: "recorded", verdict: ["installed_not_expected"] } }),
    ).toEqual({ pinned: false, reason: "write_failed" });
    // 1 (bin) + 2 (merge: missing + write) + 2 (not_reached: missing + write) + 1 (pin)
    expect(logger.warn).toHaveBeenCalledTimes(6);
    for (const [line] of logger.warn.mock.calls) {
      expect(line).toMatch(/^\[boot-report\] /);
    }
    expect(logger.warn.mock.calls[0][0]).toMatch(/could not write .*boot-report\.json \(ENOSPC/);
    expect(fs.existsSync(path.join(managedDir, kBootReportFileName))).toBe(false);
  });

  it("a rotation failure other than ENOENT is logged and the new report is still written", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, "boot-report.json"), JSON.stringify({ bootId: "1:1" }));
    const fsModule = {
      ...fs,
      renameSync: (from, to) => {
        if (from.endsWith("boot-report.json") && to.endsWith("boot-report.1.json")) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return fs.renameSync(from, to);
      },
    };
    const writer = createBootReportWriter({ managedDir, bootId: kBootId, fsModule, logger });
    expect(writer.writeBinPhase(binReport())).not.toBeNull();
    expect(readJson(writer.reportPath).bootId).toBe(kBootId);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/could not rotate .*boot-report\.json \(EACCES\)/);
  });

  it("an unreadable directory (EACCES on read) is reported, never thrown", () => {
    const fsModule = {
      ...fs,
      readFileSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    const writer = createBootReportWriter({ managedDir, bootId: kBootId, fsModule, logger });
    const reports = writer.readBootReports();
    expect(reports.current).toBeNull();
    expect(reports.unreadable).toEqual([
      "boot-report.json",
      "boot-report.1.json",
      "boot-report.2.json",
      "boot-report-incident.json",
      "boot-report-refused.json",
    ]);
    // A merge over an unreadable file rewrites from scratch (the 4.1 rule).
    const merged = writer.mergeServerPhase({});
    expect(merged.binPhase).toEqual({ status: "unreadable" });
    expect(merged.previous).toBe("unreadable");
  });

  it("a logger that itself throws is swallowed", () => {
    const fsModule = { ...fs, writeFileSync: () => { throw enospc(); } };
    const writer = createBootReportWriter({
      managedDir,
      bootId: kBootId,
      fsModule,
      logger: { warn: () => { throw new Error("logger down"); } },
    });
    expect(() => writer.writeBinPhase(binReport())).not.toThrow();
    expect(writer.writeBinPhase(binReport())).toBeNull();
  });
});

describe("boot-report: bootSync.danglingRecords + readOwnReport (#76 A7 — the bin phase's closures reach the server phase)", () => {
  const mkManaged = () => path.join(mkTemp(), ".alphaclaw");
  const silentLogger = () => ({ log() {}, warn() {}, error() {} });

  it("buildBinPhaseReport carries danglingRecords normalized: ids as strings, flag as boolean, garbage → null", () => {
    const shaped = buildBinPhaseReport({
      bootId: "1:1",
      bootSync: {
        action: "none",
        danglingRecords: { closedRuns: ["run-a", 42, "", null, "run-b"], closedLastUpdateRun: "yes" },
      },
    });
    expect(shaped.openclaw.bootSync.danglingRecords).toEqual({
      closedRuns: ["run-a", "run-b"],
      closedLastUpdateRun: false,
    });
    expect(buildBinPhaseReport({ bootSync: { action: "none" } }).openclaw.bootSync.danglingRecords).toBeNull();
    expect(
      buildBinPhaseReport({ bootSync: { action: "none", danglingRecords: "nope" } }).openclaw.bootSync.danglingRecords,
    ).toBeNull();
    expect(
      buildBinPhaseReport({ bootSync: { action: "none", danglingRecords: { closedLastUpdateRun: true } } }).openclaw
        .bootSync.danglingRecords,
    ).toEqual({ closedRuns: [], closedLastUpdateRun: true });
  });

  it("readOwnReport returns the report THIS boot wrote, and null for a missing, unreadable or foreign-boot file", () => {
    const managedDir = mkManaged();
    const writer = createBootReportWriter({ managedDir, bootId: "77:1", nowFn: () => 1000, logger: silentLogger() });
    expect(writer.readOwnReport()).toBeNull();
    writer.writeBinPhase(
      buildBinPhaseReport({
        bootId: "77:1",
        bootSync: { action: "none", danglingRecords: { closedRuns: ["run-a"], closedLastUpdateRun: false } },
      }),
    );
    expect(writer.readOwnReport()?.openclaw?.bootSync?.danglingRecords).toEqual({
      closedRuns: ["run-a"],
      closedLastUpdateRun: false,
    });
    // Another boot's file is never returned as our own.
    const other = createBootReportWriter({ managedDir, bootId: "78:1", nowFn: () => 2000, logger: silentLogger() });
    expect(other.readOwnReport()).toBeNull();
    // Unreadable → null, never a throw.
    fs.writeFileSync(writer.reportPath, "{not json");
    expect(writer.readOwnReport()).toBeNull();
  });
});
