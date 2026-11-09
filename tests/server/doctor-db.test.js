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

  it("carries source/sourceKey through single-card reads and fix mutations", () => {
    const {
      createDoctorRun,
      insertDoctorCards,
      getDoctorCardsByRunId,
      getDoctorCard,
      updateDoctorCardStatus,
      startDoctorCardFix,
      cancelDoctorCardFix,
      completeDoctorCardFix,
    } = createDoctorDbContext("doctor-db-provenance-");

    const runId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-provenance",
      workspaceManifest: null,
      promptVersion: "doctor-v2",
    });
    insertDoctorCards({
      runId,
      cards: [
        {
          priority: kDoctorPriority.P0,
          category: "project context",
          title: "Hardening blocked",
          summary: "s",
          recommendation: "r",
          evidence: [],
          targetPaths: [],
          fixPrompt: "f",
          status: kDoctorCardStatus.open,
          source: "deterministic",
          sourceKey: "det:hardening:blocked",
        },
      ],
    });
    const provenance = { source: "deterministic", sourceKey: "det:hardening:blocked" };
    const [inserted] = getDoctorCardsByRunId(runId);
    expect(inserted).toMatchObject(provenance);

    // The single-card read must not relabel a sourced card as llm.
    expect(getDoctorCard(inserted.id)).toMatchObject(provenance);

    // Every mutation that returns a card keeps the provenance too — these
    // feed the status/fix API responses.
    expect(
      updateDoctorCardStatus({ id: inserted.id, status: kDoctorCardStatus.open }),
    ).toMatchObject(provenance);
    expect(
      startDoctorCardFix({
        id: inserted.id,
        runId: "doctor-fix-provenance",
        tokenHash: "provenance-hash",
      }),
    ).toMatchObject(provenance);
    expect(
      cancelDoctorCardFix({ id: inserted.id, runId: "doctor-fix-provenance" }),
    ).toMatchObject(provenance);
    startDoctorCardFix({
      id: inserted.id,
      runId: "doctor-fix-provenance-2",
      tokenHash: "provenance-hash-2",
    });
    expect(
      completeDoctorCardFix({
        id: inserted.id,
        runId: "doctor-fix-provenance-2",
        tokenHash: "provenance-hash-2",
      }),
    ).toMatchObject(provenance);
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
    const { createDoctorRun, getDoctorRunWorkspaceManifest, getDoctorRunManifest } =
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
    // v0.9.36 alias: same reader under the upstream name.
    expect(getDoctorRunManifest).toBe(getDoctorRunWorkspaceManifest);
  });

  // Ported from v0.9.36: ordering vs the full listing, the latest COMPLETED
  // summary skipping a newer failed run, and lazy per-run manifest fetches.
  it("serves lean run summaries, the latest completed summary, and run manifests", async () => {
    const {
      createDoctorRun,
      insertDoctorCards,
      completeDoctorRun,
      listDoctorRuns,
      listDoctorRunSummaries,
      getLatestCompletedRunSummary,
      getDoctorRunManifest,
    } = createDoctorDbContext("doctor-db-latest-summary-");

    // started_at has millisecond precision; the sleeps keep the three runs on
    // distinct timestamps so started_at DESC ordering is deterministic.
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const firstManifest = { "AGENTS.md": { hash: "hash-1", size: 10 } };

    const firstRunId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-1",
      workspaceManifest: firstManifest,
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
          fixPrompt: "Fix it safely",
          status: kDoctorCardStatus.open,
        },
        {
          priority: kDoctorPriority.P2,
          category: "cleanup",
          title: "Second finding",
          summary: "Second finding",
          recommendation: "Tidy it",
          targetPaths: ["docs/notes.md"],
          fixPrompt: "Tidy it safely",
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
    await sleep(5);

    const secondRunId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-2",
      workspaceManifest: { "README.md": { hash: "hash-2", size: 20 } },
      promptVersion: "doctor-v1",
    });
    insertDoctorCards({
      runId: secondRunId,
      cards: [
        {
          priority: kDoctorPriority.P1,
          category: "guidance",
          title: "Third finding",
          summary: "Third finding",
          recommendation: "Fix it",
          targetPaths: ["README.md"],
          fixPrompt: "Fix it safely",
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
    await sleep(5);

    const failedRunId = createDoctorRun({
      engine: "gateway_agent",
      workspaceRoot: "/tmp/workspace",
      workspaceFingerprint: "fp-3",
      workspaceManifest: null,
      promptVersion: "doctor-v1",
    });
    completeDoctorRun({
      id: failedRunId,
      status: kDoctorRunStatus.failed,
      error: "gateway exploded",
    });

    const fullRuns = listDoctorRuns({ limit: 10 });
    const summaries = listDoctorRunSummaries({ limit: 10 });

    // Summaries mirror the full listing (same runs, same counts) minus the
    // heavy JSON columns.
    expect(summaries.map((run) => run.id)).toEqual(fullRuns.map((run) => run.id));
    expect(summaries.map((run) => run.id)).toEqual([
      failedRunId,
      secondRunId,
      firstRunId,
    ]);
    summaries.forEach((summary, index) => {
      const fullRun = fullRuns[index];
      expect(summary.status).toBe(fullRun.status);
      expect(summary.cardCount).toBe(fullRun.cardCount);
      expect(summary.priorityCounts).toEqual(fullRun.priorityCounts);
      expect(summary.statusCounts).toEqual(fullRun.statusCounts);
      expect(summary).not.toHaveProperty("workspaceManifest");
      expect(summary).not.toHaveProperty("rawResult");
    });
    expect(summaries[2].cardCount).toBe(2);
    expect(summaries[2].priorityCounts).toEqual({ P0: 1, P1: 0, P2: 1 });
    expect(summaries[2].statusCounts).toEqual({
      open: 1,
      working: 0,
      dismissed: 1,
      fixed: 0,
    });

    // The latest COMPLETED summary skips the newer failed run.
    const latestCompleted = getLatestCompletedRunSummary();
    expect(latestCompleted.id).toBe(secondRunId);
    expect(latestCompleted.status).toBe(kDoctorRunStatus.completed);
    expect(latestCompleted.workspaceFingerprint).toBe("fp-2");
    expect(latestCompleted.cardCount).toBe(1);
    expect(latestCompleted).not.toHaveProperty("workspaceManifest");
    expect(latestCompleted).not.toHaveProperty("rawResult");

    // Manifests are fetched lazily per run, and a missing run yields null.
    expect(getDoctorRunManifest(firstRunId)).toEqual(firstManifest);
    expect(getDoctorRunManifest(failedRunId)).toBeNull();
    expect(getDoctorRunManifest(999999)).toBeNull();
  });

  it("migrates a pre-wave doctor.db idempotently and coerces legacy rows", () => {
    const { DatabaseSync } = require("node:sqlite");
    currentRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-db-prewave-"));
    const dbDir = path.join(currentRootDir, "db");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "doctor.db");

    // Pre-wave schema: no context_profile/openclaw_version on doctor_runs,
    // no source/source_key (or fix_*) on doctor_cards.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE doctor_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        completed_at TEXT,
        status TEXT NOT NULL,
        engine TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        workspace_fingerprint TEXT,
        workspace_manifest_json TEXT,
        prompt_version TEXT NOT NULL,
        summary TEXT,
        raw_result_json TEXT,
        error TEXT,
        reused_from_run_id INTEGER
      );
      CREATE TABLE doctor_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE doctor_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        priority TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        recommendation TEXT NOT NULL,
        evidence_json TEXT,
        target_paths_json TEXT,
        fix_prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES doctor_runs(id) ON DELETE CASCADE
      );
      INSERT INTO doctor_runs (
        completed_at, status, engine, workspace_root,
        workspace_fingerprint, prompt_version, summary
      ) VALUES (
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'completed', 'gateway_agent',
        '/tmp/legacy', 'legacy-fp', 'doctor-v1', 'Legacy run'
      );
      INSERT INTO doctor_cards (
        run_id, priority, category, title, summary,
        recommendation, evidence_json, target_paths_json, fix_prompt, status
      ) VALUES
        (1, 'P1', 'workspace', 'Legacy open', 's', 'r', '[]', '[]', 'f', 'open'),
        (1, 'P2', 'cleanup', 'Legacy dismissed', 's', 'r', '[]', '[]', 'f', 'dismissed');
    `);
    legacy.close();

    currentDoctorDb = loadDoctorDb();
    currentDoctorDb.initDoctorDb({ rootDir: currentRootDir });
    // Twice: every migration step (ALTERs, index creation) must be idempotent.
    currentDoctorDb.initDoctorDb({ rootDir: currentRootDir });

    const run = currentDoctorDb.getDoctorRun(1);
    expect(run.status).toBe(kDoctorRunStatus.completed);
    expect(run.contextProfile).toBe("");
    expect(run.openclawVersion).toBe("");
    const [summary] = currentDoctorDb.listDoctorRunSummaries({ limit: 5 });
    expect(summary.id).toBe(1);
    expect(summary.contextProfile).toBe("");
    expect(summary.openclawVersion).toBe("");

    const cards = currentDoctorDb.getDoctorCardsByRunId(1);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.sourceKey).toBe("");
      expect(card.source).toBe("llm");
    }

    // Legacy dismissed rows carry a NULL source_key: never a dismissed key.
    expect(currentDoctorDb.listDismissedDoctorSourceKeys()).toEqual([]);

    // The dismissal partial index landed (and survived the double init).
    currentDoctorDb.closeDoctorDb();
    const inspect = new DatabaseSync(dbPath);
    const indexRow = inspect
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_doctor_cards_dismissed_source_key'",
      )
      .get();
    inspect.close();
    expect(indexRow).toBeTruthy();
    expect(String(indexRow.sql)).toContain("WHERE status = 'dismissed'");
  });
});
