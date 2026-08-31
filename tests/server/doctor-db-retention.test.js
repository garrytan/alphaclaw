const fs = require("fs");
const os = require("os");
const path = require("path");

const loadDoctorDb = () => {
  const modulePath = require.resolve("../../lib/server/db/doctor");
  delete require.cache[modulePath];
  return require(modulePath);
};

let doctorDb = null;

const makeRun = (overrides = {}) => ({
  status: "completed",
  engine: "manual_import",
  workspaceRoot: "/ws",
  workspaceFingerprint: "fp",
  workspaceManifest: { "a.md": { hash: "h", size: 1, mtimeMs: 1 } },
  promptVersion: "doctor-v2",
  ...overrides,
});

describe("server/db/doctor manifest retention + fix delivery", () => {
  beforeEach(() => {
    doctorDb = loadDoctorDb();
    doctorDb.initDoctorDb({
      rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "doctor-db-retention-")),
    });
  });

  afterEach(() => {
    doctorDb?.closeDoctorDb?.();
    doctorDb = null;
  });

  it("keeps the newest 2 manifest-bearing runs and prunes older ones", () => {
    const first = doctorDb.createDoctorRun(makeRun());
    const second = doctorDb.createDoctorRun(makeRun());
    const third = doctorDb.createDoctorRun(makeRun());
    const fourth = doctorDb.createDoctorRun(makeRun());

    expect(doctorDb.getDoctorRunWorkspaceManifest(first)).toBeNull();
    expect(doctorDb.getDoctorRunWorkspaceManifest(second)).toBeNull();
    expect(doctorDb.getDoctorRunWorkspaceManifest(third)).not.toBeNull();
    expect(doctorDb.getDoctorRunWorkspaceManifest(fourth)).not.toBeNull();
  });

  it("never prunes the latest COMPLETED run's manifest through a failed-run sequence", () => {
    // The 24h-backoff shape the reviewer flagged: a completed baseline run
    // followed by failed/running rows must not lose the active baseline —
    // baseline loading reads the latest completed run.
    const baseline = doctorDb.createDoctorRun(makeRun({ status: "completed" }));
    doctorDb.completeDoctorRun({ id: baseline, status: "completed", summary: "ok" });
    const failed1 = doctorDb.createDoctorRun(makeRun({ status: "running" }));
    doctorDb.completeDoctorRun({ id: failed1, status: "failed", error: "x" });
    const failed2 = doctorDb.createDoctorRun(makeRun({ status: "running" }));
    doctorDb.completeDoctorRun({ id: failed2, status: "failed", error: "x" });
    const running = doctorDb.createDoctorRun(makeRun({ status: "running" }));

    // Baseline sits OUTSIDE the newest-2 manifest-bearing window but is the
    // latest completed run — its manifest must survive.
    expect(doctorDb.getDoctorRunWorkspaceManifest(baseline)).not.toBeNull();
    expect(doctorDb.getDoctorRunWorkspaceManifest(running)).not.toBeNull();
    expect(doctorDb.getDoctorRunWorkspaceManifest(failed1)).toBeNull();
  });

  it("round-trips scan stats on run rows", () => {
    const scanStats = {
      capsUsed: { maxFiles: 200000, maxFileBytes: 52428800 },
      totalFiles: 123456,
      skippedLargeCount: 3,
    };
    const runId = doctorDb.createDoctorRun(makeRun({ status: "running", scanStats }));
    expect(doctorDb.getDoctorRun(runId).scanStats).toEqual(scanStats);
    expect(doctorDb.getLatestCompletedRunSummary()).toBeNull();
    doctorDb.completeDoctorRun({ id: runId, status: "completed", summary: "ok" });
    expect(doctorDb.getLatestCompletedRunSummary().scanStats).toEqual(scanStats);
  });

  it("round-trips the fix delivery record on cards", () => {
    const runId = doctorDb.createDoctorRun(makeRun());
    doctorDb.insertDoctorCards({
      runId,
      cards: [
        {
          priority: "P1",
          category: "guidance",
          title: "t",
          summary: "s",
          recommendation: "r",
          fixPrompt: "f",
          status: "open",
        },
      ],
    });
    const [card] = doctorDb.getDoctorCardsByRunId(runId);
    expect(card.fixDelivery).toBeNull();

    const delivery = {
      attached: true,
      replyChannel: "telegram",
      replyTo: "1050",
      replyAccountId: "default",
      dispatchedAt: "2026-08-31T00:00:00.000Z",
      gatewayOk: true,
    };
    expect(doctorDb.setDoctorCardFixDelivery({ id: card.id, delivery })).toBe(true);
    expect(doctorDb.getDoctorCard(card.id).fixDelivery).toEqual(delivery);
    expect(doctorDb.listDoctorCards({ runId }).find((row) => row.id === card.id).fixDelivery)
      .toEqual(delivery);
  });
});

describe("server/db/doctor reuse-clone dispatch record (red-team RT2)", () => {
  beforeEach(() => {
    doctorDb = loadDoctorDb();
    doctorDb.initDoctorDb({
      rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "doctor-db-clone-")),
    });
  });

  afterEach(() => {
    doctorDb?.closeDoctorDb?.();
    doctorDb = null;
  });

  it("insertDoctorCards carries fixDelivery so reuse-run clones keep the dispatch record", () => {
    const runId = doctorDb.createDoctorRun(makeRun());
    const fixDelivery = {
      attached: true,
      replyChannel: "telegram",
      replyTo: "1050",
      replyAccountId: "",
      dispatchedAt: "2026-08-31T00:00:00.000Z",
      gatewayOk: false,
    };
    doctorDb.insertDoctorCards({
      runId,
      cards: [
        {
          priority: "P1",
          category: "guidance",
          title: "cloned card",
          summary: "s",
          recommendation: "r",
          fixPrompt: "f",
          status: "open",
          // The reuse path clones the full card model — the failed-dispatch
          // trace must survive into the clone.
          fixDelivery,
        },
        {
          priority: "P2",
          category: "guidance",
          title: "fresh card",
          summary: "s",
          recommendation: "r",
          fixPrompt: "f",
          status: "open",
        },
      ],
    });
    const cards = doctorDb.getDoctorCardsByRunId(runId);
    expect(cards.find((card) => card.title === "cloned card").fixDelivery).toEqual(
      fixDelivery,
    );
    expect(cards.find((card) => card.title === "fresh card").fixDelivery).toBeNull();
  });
});

describe("server/db/doctor stale-dispatch record guard (adversarial C-ADV5)", () => {
  beforeEach(() => {
    doctorDb = loadDoctorDb();
    doctorDb.initDoctorDb({
      rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "doctor-db-stale-")),
    });
  });

  afterEach(() => {
    doctorDb?.closeDoctorDb?.();
    doctorDb = null;
  });

  it("a stale dispatch cannot overwrite the newer dispatch's record after reopen + re-dispatch", () => {
    const runId = doctorDb.createDoctorRun(makeRun());
    doctorDb.insertDoctorCards({
      runId,
      cards: [
        {
          priority: "P1",
          category: "guidance",
          title: "t",
          summary: "s",
          recommendation: "r",
          fixPrompt: "f",
          status: "open",
        },
      ],
    });
    const [card] = doctorDb.getDoctorCardsByRunId(runId);

    // Dispatch A starts…
    doctorDb.startDoctorCardFix({ id: card.id, runId: "fix-A", tokenHash: "hA" });
    expect(
      doctorDb.setDoctorCardFixDelivery({
        id: card.id,
        runId: "fix-A",
        delivery: { attached: true, replyTo: "1050", gatewayOk: null },
      }),
    ).toBe(true);
    // …operator reopens the card and dispatch B takes over.
    doctorDb.updateDoctorCardStatus({ id: card.id, status: "open" });
    doctorDb.startDoctorCardFix({ id: card.id, runId: "fix-B", tokenHash: "hB" });
    doctorDb.setDoctorCardFixDelivery({
      id: card.id,
      runId: "fix-B",
      delivery: { attached: true, replyTo: "2020", gatewayOk: null },
    });

    // A's late settle must be a NO-OP (conditional on fix_run_id).
    expect(
      doctorDb.setDoctorCardFixDelivery({
        id: card.id,
        runId: "fix-A",
        delivery: { attached: true, replyTo: "1050", gatewayOk: false },
      }),
    ).toBe(false);
    expect(doctorDb.getDoctorCard(card.id).fixDelivery.replyTo).toBe("2020");
  });
});
