const fs = require("fs");
const os = require("os");
const path = require("path");

const { kDoctorCardStatus, kDoctorPriority, kDoctorRunStatus } = require("../../lib/server/doctor/constants");

const loadDoctorDb = () => {
  const modulePath = require.resolve("../../lib/server/db/doctor");
  delete require.cache[modulePath];
  return require(modulePath);
};

let currentDoctorDb = null;
let currentRootDir = "";

const createDoctorDbContext = (prefix) => {
  currentRootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  currentDoctorDb = loadDoctorDb();
  const dbResult = currentDoctorDb.initDoctorDb({ rootDir: currentRootDir });
  return {
    ...currentDoctorDb,
    ...dbResult,
    rootDir: currentRootDir,
  };
};

describe("server/doctor-db", () => {
  afterEach(() => {
    if (currentDoctorDb?.closeDoctorDb) {
      currentDoctorDb.closeDoctorDb();
      currentDoctorDb = null;
    }
    if (currentRootDir) {
      fs.rmSync(currentRootDir, { recursive: true, force: true });
      currentRootDir = "";
    }
  });

  it("initializes doctor.db under root db directory", () => {
    const result = createDoctorDbContext("doctor-db-init-");

    expect(result.path).toBe(path.join(result.rootDir, "db", "doctor.db"));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it("stores runs and cards with aggregated counts", () => {
    const {
      createDoctorRun,
      insertDoctorCards,
      completeDoctorRun,
      getInitialWorkspaceBaseline,
      getDoctorRun,
      getLatestDoctorRun,
      getDoctorCardsByRunId,
      setInitialWorkspaceBaseline,
      startDoctorCardFix,
      cancelDoctorCardFix,
      completeDoctorCardFix,
      updateDoctorCardStatus,
    } = createDoctorDbContext("doctor-db-cards-");
    setInitialWorkspaceBaseline({
      fingerprint: "initial-fingerprint",
      manifest: { "README.md": "hash-readme" },
      capturedAt: "2026-03-06T00:00:00.000Z",
    });

    const runId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fingerprint-123",
      workspaceManifest: { "AGENTS.md": "hash-1" },
      promptVersion: "doctor-v1",
      reusedFromRunId: 9,
    });
    insertDoctorCards({
      runId,
      cards: [
        {
          priority: kDoctorPriority.P0,
          category: "guidance",
          title: "Misplaced tools guidance",
          summary: "Tool guidance lives in the wrong file",
          recommendation: "Move tool guidance into TOOLS.md",
          evidence: [{ type: "path", path: "README.md" }],
          targetPaths: ["README.md", "hooks/bootstrap/TOOLS.md"],
          fixPrompt: "Move the tool guidance safely",
          status: kDoctorCardStatus.open,
        },
        {
          priority: kDoctorPriority.P2,
          category: "cleanup",
          title: "Duplicate notes",
          summary: "Low-value duplication",
          recommendation: "Consolidate the duplicate notes",
          evidence: [],
          targetPaths: ["docs/notes.md"],
          fixPrompt: "Consolidate the duplicate notes safely",
          status: kDoctorCardStatus.dismissed,
        },
      ],
    });
    completeDoctorRun({
      id: runId,
      status: kDoctorRunStatus.completed,
      summary: "Found 2 recommendations",
      rawResult: { cards: [] },
    });

    const run = getDoctorRun(runId);
    const latestRun = getLatestDoctorRun();
    const cards = getDoctorCardsByRunId(runId);
    const initialBaseline = getInitialWorkspaceBaseline();

    expect(run.status).toBe(kDoctorRunStatus.completed);
    expect(initialBaseline).toEqual({
      fingerprint: "initial-fingerprint",
      manifest: { "README.md": "hash-readme" },
      capturedAt: "2026-03-06T00:00:00.000Z",
    });
    expect(run.workspaceFingerprint).toBe("fingerprint-123");
    expect(run.workspaceManifest).toEqual({ "AGENTS.md": "hash-1" });
    expect(run.reusedFromRunId).toBe(9);
    expect(run.cardCount).toBe(2);
    expect(run.priorityCounts).toEqual({ P0: 1, P1: 0, P2: 1 });
    expect(run.statusCounts).toEqual({ open: 1, working: 0, dismissed: 1, fixed: 0 });
    expect(cards).toHaveLength(2);
    expect(latestRun.id).toBe(runId);

    const updatedCard = updateDoctorCardStatus({
      id: cards[0].id,
      status: kDoctorCardStatus.fixed,
    });
    expect(updatedCard.status).toBe(kDoctorCardStatus.fixed);

    updateDoctorCardStatus({
      id: cards[1].id,
      status: kDoctorCardStatus.open,
    });
    const workingCard = startDoctorCardFix({
      id: cards[1].id,
      runId: "doctor-fix-test",
      tokenHash: "token-hash",
    });
    expect(workingCard.status).toBe(kDoctorCardStatus.working);
    expect(
      startDoctorCardFix({
        id: cards[1].id,
        runId: "doctor-fix-concurrent",
        tokenHash: "concurrent-token-hash",
      }),
    ).toBeNull();
    expect(
      completeDoctorCardFix({
        id: cards[1].id,
        runId: "wrong-run",
        tokenHash: "token-hash",
      }),
    ).toBeNull();
    expect(
      completeDoctorCardFix({
        id: cards[1].id,
        runId: "doctor-fix-test",
        tokenHash: "wrong-token",
      }),
    ).toBeNull();
    const completedCard = completeDoctorCardFix({
      id: cards[1].id,
      runId: "doctor-fix-test",
      tokenHash: "token-hash",
    });
    expect(completedCard.status).toBe(kDoctorCardStatus.fixed);
    expect(
      completeDoctorCardFix({
        id: cards[1].id,
        runId: "doctor-fix-test",
        tokenHash: "token-hash",
      }),
    ).toBeNull();

    updateDoctorCardStatus({
      id: cards[1].id,
      status: kDoctorCardStatus.open,
    });
    startDoctorCardFix({
      id: cards[1].id,
      runId: "doctor-fix-cancel",
      tokenHash: "cancel-token-hash",
    });
    expect(
      cancelDoctorCardFix({ id: cards[1].id, runId: "doctor-fix-cancel" }).status,
    ).toBe(kDoctorCardStatus.open);

    startDoctorCardFix({
      id: cards[1].id,
      runId: "doctor-fix-manual-reopen",
      tokenHash: "manual-reopen-token-hash",
    });
    updateDoctorCardStatus({ id: cards[1].id, status: kDoctorCardStatus.open });
    expect(
      completeDoctorCardFix({
        id: cards[1].id,
        runId: "doctor-fix-manual-reopen",
        tokenHash: "manual-reopen-token-hash",
      }),
    ).toBeNull();
  });

  it("lists run summaries without heavy payloads and with grouped counts", () => {
    const {
      createDoctorRun,
      insertDoctorCards,
      completeDoctorRun,
      listDoctorRuns,
      listDoctorRunSummaries,
    } = createDoctorDbContext("doctor-db-summaries-");

    const firstRunId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-first",
      workspaceManifest: { "AGENTS.md": { hash: "hash-1", size: 10 } },
      promptVersion: "doctor-v1",
    });
    insertDoctorCards({
      runId: firstRunId,
      cards: [
        {
          priority: kDoctorPriority.P0,
          category: "guidance",
          title: "First finding",
          summary: "First finding",
          recommendation: "Fix it",
          targetPaths: ["AGENTS.md"],
          fixPrompt: "Fix safely",
          status: kDoctorCardStatus.open,
        },
        {
          priority: kDoctorPriority.P2,
          category: "cleanup",
          title: "Second finding",
          summary: "Second finding",
          recommendation: "Tidy it",
          targetPaths: ["docs/notes.md"],
          fixPrompt: "Tidy safely",
          status: kDoctorCardStatus.dismissed,
        },
      ],
    });
    completeDoctorRun({
      id: firstRunId,
      status: kDoctorRunStatus.completed,
      summary: "First run",
      rawResult: { cards: ["heavy"] },
    });
    const secondRunId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-second",
      workspaceManifest: { "AGENTS.md": { hash: "hash-2", size: 20 } },
      promptVersion: "doctor-v1",
    });
    insertDoctorCards({
      runId: secondRunId,
      cards: [
        {
          priority: kDoctorPriority.P1,
          category: "workspace",
          title: "Third finding",
          summary: "Third finding",
          recommendation: "Fix it",
          targetPaths: ["README.md"],
          fixPrompt: "Fix safely",
          status: kDoctorCardStatus.open,
        },
      ],
    });
    completeDoctorRun({
      id: secondRunId,
      status: kDoctorRunStatus.completed,
      summary: "Second run",
      rawResult: { cards: [] },
    });
    const emptyRunId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-empty",
      workspaceManifest: null,
      promptVersion: "doctor-v1",
    });

    const summaries = listDoctorRunSummaries({ limit: 10 });
    const firstSummary = summaries.find((run) => run.id === firstRunId);
    const secondSummary = summaries.find((run) => run.id === secondRunId);
    const emptySummary = summaries.find((run) => run.id === emptyRunId);

    expect(summaries).toHaveLength(3);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("workspaceManifest");
      expect(summary).not.toHaveProperty("rawResult");
    }
    // Summaries carry the full run model minus the two heavy payload fields.
    const fullFirstRun = listDoctorRuns({ limit: 10 }).find((run) => run.id === firstRunId);
    const { workspaceManifest, rawResult, ...expectedFirstSummary } = fullFirstRun;
    expect(firstSummary).toEqual(expectedFirstSummary);
    expect(firstSummary.workspaceFingerprint).toBe("fp-first");
    expect(firstSummary.cardCount).toBe(2);
    expect(firstSummary.priorityCounts).toEqual({ P0: 1, P1: 0, P2: 1 });
    expect(firstSummary.statusCounts).toEqual({ open: 1, working: 0, dismissed: 1, fixed: 0 });
    expect(secondSummary.cardCount).toBe(1);
    expect(secondSummary.priorityCounts).toEqual({ P0: 0, P1: 1, P2: 0 });
    expect(secondSummary.statusCounts).toEqual({ open: 1, working: 0, dismissed: 0, fixed: 0 });
    expect(emptySummary.cardCount).toBe(0);
    expect(emptySummary.priorityCounts).toEqual({ P0: 0, P1: 0, P2: 0 });
    expect(emptySummary.statusCounts).toEqual({ open: 0, working: 0, dismissed: 0, fixed: 0 });
  });

  it("fetches a single run's parsed workspace manifest by id", () => {
    const { createDoctorRun, getDoctorRunWorkspaceManifest } =
      createDoctorDbContext("doctor-db-manifest-");

    const runId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-manifest",
      workspaceManifest: { "AGENTS.md": { hash: "hash-1", size: 10, mtimeMs: 123.5 } },
      promptVersion: "doctor-v1",
    });
    const manifestlessRunId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-no-manifest",
      workspaceManifest: null,
      promptVersion: "doctor-v1",
    });

    expect(getDoctorRunWorkspaceManifest(runId)).toEqual({
      "AGENTS.md": { hash: "hash-1", size: 10, mtimeMs: 123.5 },
    });
    expect(getDoctorRunWorkspaceManifest(manifestlessRunId)).toBeNull();
    expect(getDoctorRunWorkspaceManifest(9999)).toBeNull();
  });
});
