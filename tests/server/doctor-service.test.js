const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  computeWorkspaceSnapshotBounded,
} = require("../../lib/server/doctor/workspace-fingerprint");

const loadDoctorDb = () => {
  const modulePath = require.resolve("../../lib/server/db/doctor");
  delete require.cache[modulePath];
  return require(modulePath);
};

const loadDoctorService = () => {
  const modulePath = require.resolve("../../lib/server/doctor/service");
  delete require.cache[modulePath];
  return require(modulePath);
};

const repeatText = (length, character = "A") => character.repeat(length);

// Fast fake worker: computes snapshots in-process without batch pauses so no
// real worker thread is ever spawned by these tests.
const fastComputeSnapshotAsync = (root, opts) =>
  computeWorkspaceSnapshotBounded(root, { ...(opts || {}), batchPauseMs: 0 });

let currentDoctorDb = null;

const loadManagedDoctorDb = () => {
  currentDoctorDb = loadDoctorDb();
  return currentDoctorDb;
};

describe("server/doctor-service", () => {
  afterEach(() => {
    if (currentDoctorDb?.closeDoctorDb) {
      currentDoctorDb.closeDoctorDb();
      currentDoctorDb = null;
    }
  });

  it("reuses the previous completed run when the workspace fingerprint is unchanged", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-service-db-"));
    fs.writeFileSync(
      path.join(workspaceRoot, "AGENTS.md"),
      "# Workspace Guidance\n\nKeep this concise.\n",
      "utf8",
    );

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const clawCmd = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        summary: "Should not be called",
        cards: [],
      }),
    }));
    // Spies wrap the real db fns: with the lean summary readers injected, the
    // reuse path must fetch the source run's rawResult through getDoctorRun
    // (summaries no longer carry it).
    const getDoctorRunSpy = vi.fn(doctorDb.getDoctorRun);
    const completeDoctorRunSpy = vi.fn(doctorDb.completeDoctorRun);
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd,
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorRunSummaries: doctorDb.listDoctorRunSummaries,
      getDoctorRunManifest: doctorDb.getDoctorRunManifest,
      getLatestCompletedRunSummary: doctorDb.getLatestCompletedRunSummary,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: completeDoctorRunSpy,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: getDoctorRunSpy,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const imported = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "Initial findings",
        cards: [
          {
            priority: "P1",
            category: "redundancy",
            title: "Duplicated UI guidance",
            summary: "Two files describe the same flow",
            recommendation: "Keep one file authoritative",
            evidence: [{ type: "path", path: "AGENTS.md" }],
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Consolidate the duplicated guidance safely.",
            status: "open",
          },
        ],
      }),
    });
    const [workingSourceCard] = doctorDb.getDoctorCardsByRunId(imported.runId);
    doctorDb.startDoctorCardFix({
      id: workingSourceCard.id,
      runId: "doctor-fix-active",
      tokenHash: "active-token-hash",
    });

    const rerun = await doctorService.runDoctor();
    const latestRun = doctorDb.getDoctorRun(rerun.runId);

    expect(imported.ok).toBe(true);
    expect(rerun.ok).toBe(true);
    expect(rerun.reusedPreviousRun).toBe(true);
    expect(rerun.sourceRunId).toBe(imported.runId);
    expect(clawCmd).not.toHaveBeenCalled();
    expect(latestRun.engine).toBe("deterministic_reuse");
    expect(latestRun.reusedFromRunId).toBe(imported.runId);
    expect(latestRun.summary).toMatch(/^No workspace changes since last scan/);
    expect(doctorDb.getDoctorCardsByRunId(rerun.runId)).toEqual([
      expect.objectContaining({ status: "open" }),
    ]);
    // rawResult propagation: the lean baseline summary has no rawResult, so
    // the reuse path fetched the FULL source run and passed its rawResult to
    // completeDoctorRun.
    const sourceRawResult = doctorDb.getDoctorRun(imported.runId).rawResult;
    expect(sourceRawResult).toBeTruthy();
    expect(getDoctorRunSpy).toHaveBeenCalledWith(imported.runId);
    expect(completeDoctorRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: rerun.runId,
        status: "completed",
        rawResult: sourceRawResult,
      }),
    );
    expect(latestRun.rawResult).toEqual(sourceRawResult);
  });

  it("buildStatus reads lean run summaries and caches the baseline manifest per run id", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-summaries-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-summaries-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const listRunsSpy = vi.fn(doctorDb.listDoctorRuns);
    const listSummariesSpy = vi.fn(doctorDb.listDoctorRunSummaries);
    const manifestSpy = vi.fn(doctorDb.getDoctorRunManifest);
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: listRunsSpy,
      listDoctorRunSummaries: listSummariesSpy,
      getDoctorRunManifest: manifestSpy,
      getLatestCompletedRunSummary: doctorDb.getLatestCompletedRunSummary,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const firstImport = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({ summary: "Baseline", cards: [] }),
    });

    const statusA = doctorService.buildStatus();
    const statusB = doctorService.buildStatus();

    // The status hot path lists lean summaries, never the heavy full runs.
    expect(listSummariesSpy).toHaveBeenCalled();
    expect(listRunsSpy).not.toHaveBeenCalled();
    expect(statusA.latestRun.id).toBe(firstImport.runId);
    expect(statusA.latestRun).not.toHaveProperty("workspaceManifest");
    expect(statusA.latestRun).not.toHaveProperty("rawResult");
    expect(statusB.changeSummary.hasBaseline).toBe(true);
    expect(statusB.changeSummary.baselineSource).toBe("last_run");

    // Zero drift is proven by fingerprint equality alone — the multi-MB
    // baseline manifest is never parsed while nothing has changed.
    expect(manifestSpy).not.toHaveBeenCalled();

    // Once the workspace drifts, the baseline manifest is fetched ONCE for
    // the same completed run across consecutive buildStatus calls.
    await doctorService.awaitWorkspaceSnapshotRefresh();
    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Drift\n", "utf8");
    await doctorService.refreshWorkspaceSnapshot();
    doctorService.buildStatus();
    doctorService.buildStatus();

    expect(manifestSpy).toHaveBeenCalledTimes(1);
    expect(manifestSpy).toHaveBeenCalledWith(firstImport.runId);

    // A NEWER completed run becomes the baseline: exactly one more fetch once
    // the workspace drifts past it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondImport = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({ summary: "Newer baseline", cards: [] }),
    });
    await doctorService.awaitWorkspaceSnapshotRefresh();
    fs.writeFileSync(path.join(workspaceRoot, "TOOLS.md"), "# More drift\n", "utf8");
    await doctorService.refreshWorkspaceSnapshot();
    doctorService.buildStatus();
    doctorService.buildStatus();

    expect(manifestSpy).toHaveBeenCalledTimes(2);
    expect(manifestSpy).toHaveBeenLastCalledWith(secondImport.runId);
  });

  it("runs Doctor analysis in a dedicated doctor session", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-session-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-session-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Workspace Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const clawCmd = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        summary: "Healthy workspace",
        cards: [],
      }),
      stderr: "",
      code: 0,
    }));
    const { buildDoctorIdempotencyKey, buildDoctorSessionKey, createDoctorService } =
      loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd,
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const result = await doctorService.runDoctor();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.ok).toBe(true);
    expect(clawCmd).toHaveBeenCalledTimes(1);
    expect(clawCmd.mock.calls[0][0]).toContain("gateway call agent --expect-final --json");
    expect(clawCmd.mock.calls[0][0]).toContain(
      `"idempotencyKey":"${buildDoctorIdempotencyKey(result.runId)}"`,
    );
    expect(clawCmd.mock.calls[0][0]).toContain(
      `"sessionKey":"${buildDoctorSessionKey(result.runId)}"`,
    );
  });

  it("queues Doctor card fixes through the gateway without waiting for the agent", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-fix-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-fix-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Workspace Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });
    const clawCmd = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ status: "accepted", runId: "gateway-run" }),
      stderr: "",
    }));
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd,
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      startDoctorCardFix: doctorDb.startDoctorCardFix,
      cancelDoctorCardFix: doctorDb.cancelDoctorCardFix,
      workspaceRoot,
      managedRoot: workspaceRoot,
      alphaclawRootDir: "/data",
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });
    const imported = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "One finding",
        cards: [
          {
            priority: "P1",
            category: "guidance",
            title: "Fix guidance drift",
            summary: "The guidance is stale",
            recommendation: "Update it",
            evidence: [{ type: "path", path: "AGENTS.md" }],
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Update the stale guidance.",
            status: "open",
          },
        ],
      }),
    });
    const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);

    const result = await doctorService.requestCardFix({
      cardId: card.id,
      sessionKey: "agent:main:doctor:42",
      prompt: "Apply the safe fix.",
    });

    expect(result.ok).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.runId).toMatch(new RegExp(`^doctor-fix-${card.id}-`));
    expect(clawCmd).toHaveBeenCalledTimes(1);
    const command = clawCmd.mock.calls[0][0];
    expect(command).toContain("gateway call agent --json");
    expect(command).not.toContain("--expect-final");
    expect(command).toContain('"message":"Apply the safe fix.\\n\\n');
    expect(command).toContain('"sessionKey":"agent:main:doctor:42"');
    expect(command).not.toContain('"agentId":"main"');
    expect(command).not.toContain('"sessionId"');
    expect(command).not.toContain('"deliver":true');
    expect(command).toContain("AlphaClaw completion callback:");
    expect(command).toContain("alphaclaw --root-dir");
    expect(command).toContain("/data");
    expect(command).toContain("doctor finding complete");
    expect(command).toContain(`--id`);
    expect(command).toContain(result.runId);
    expect(command).toContain("--token");
    expect(command).toContain("Do not call the completion callback");
    expect(doctorDb.getDoctorCard(card.id).status).toBe("working");

    await expect(
      doctorService.requestCardFix({
        cardId: card.id,
        sessionKey: "agent:main:doctor:42",
        prompt: "Apply the safe fix again.",
      }),
    ).rejects.toThrow("Doctor fix already in progress");
    expect(clawCmd).toHaveBeenCalledTimes(1);

    doctorDb.updateDoctorCardStatus({ id: card.id, status: "open" });

    await doctorService.requestCardFix({
      cardId: card.id,
      sessionKey: "agent:main:telegram:direct:1050",
      replyChannel: "telegram",
      replyTo: "1050",
      prompt: "Apply the safe fix.",
    });

    expect(clawCmd).toHaveBeenCalledTimes(2);
    const deliveryCommand = clawCmd.mock.calls[1][0];
    expect(deliveryCommand).toContain(
      '"sessionKey":"agent:main:telegram:direct:1050"',
    );
    expect(deliveryCommand).toContain('"deliver":true');
    expect(deliveryCommand).toContain('"replyChannel":"telegram"');
    expect(deliveryCommand).toContain('"replyTo":"1050"');
    expect(deliveryCommand).not.toContain('"sessionId"');

    doctorDb.updateDoctorCardStatus({ id: card.id, status: "open" });
    clawCmd.mockResolvedValueOnce({
      ok: false,
      stderr: "gateway unavailable",
    });
    await expect(
      doctorService.requestCardFix({
        cardId: card.id,
        sessionKey: "agent:main:doctor:42",
        prompt: "Apply the safe fix.",
      }),
    ).rejects.toThrow("gateway unavailable");
    expect(doctorDb.getDoctorCard(card.id).status).toBe("open");

    await expect(
      doctorService.requestCardFix({
        cardId: card.id,
        prompt: "Apply the safe fix.",
      }),
    ).rejects.toThrow("Doctor fix request requires a session key");
    expect(clawCmd).toHaveBeenCalledTimes(3);
  });

  it("does not suppress previously fixed findings on later Doctor runs", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-fixed-rerun-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-fixed-rerun-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Workspace Guidance\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Initial docs\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    let runCount = 0;
    const clawCmd = vi.fn(async () => {
      runCount += 1;
      return {
        ok: true,
        stdout: JSON.stringify({
          summary: `Run ${runCount}`,
          cards: [
            {
              priority: "P1",
              category: "workspace",
              title: "Stale docs remain",
              summary: "README still contains stale guidance",
              recommendation: "Update README to match the current workspace",
              evidence: [{ type: "path", path: "README.md" }],
              targetPaths: ["README.md"],
              fixPrompt: "Update README safely.",
              status: "open",
            },
          ],
        }),
        stderr: "",
        code: 0,
      };
    });
    const { createDoctorService } = loadDoctorService();
    const buildDoctorService = () =>
      createDoctorService({
        clawCmd,
        listDoctorRuns: doctorDb.listDoctorRuns,
        listDoctorCards: doctorDb.listDoctorCards,
        getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
        setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
        createDoctorRun: doctorDb.createDoctorRun,
        completeDoctorRun: doctorDb.completeDoctorRun,
        insertDoctorCards: doctorDb.insertDoctorCards,
        getDoctorRun: doctorDb.getDoctorRun,
        getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
        getDoctorCard: doctorDb.getDoctorCard,
        updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: fastComputeSnapshotAsync,
      });
    const doctorService = buildDoctorService();

    const firstRun = await doctorService.runDoctor();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstRunCards = doctorDb.getDoctorCardsByRunId(firstRun.runId);
    doctorService.setCardStatus({
      cardId: firstRunCards[0].id,
      status: "fixed",
    });

    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Updated docs, longer\n", "utf8");

    const secondRun = await buildDoctorService().runDoctor();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clawCmd).toHaveBeenCalledTimes(2);
    expect(clawCmd.mock.calls[1][0]).toContain("Previously fixed findings");
    expect(clawCmd.mock.calls[1][0]).toContain("[fixed] Stale docs remain (workspace)");
    expect(clawCmd.mock.calls[1][0]).toContain(
      "Previously fixed findings may be re-suggested if the underlying issue is still present",
    );
    expect(doctorDb.getDoctorCardsByRunId(secondRun.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Stale docs remain",
          status: "open",
        }),
      ]),
    );
  });

  it("reports meaningful workspace drift only after a stale completed run", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-drift-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-drift-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const listDoctorRuns = ({ limit } = {}) =>
      doctorDb.listDoctorRuns({ limit }).map((run) => ({
        ...run,
        startedAt: "2000-01-01T00:00:00.000Z",
        completedAt: "2000-01-01T00:00:00.000Z",
      }));
    const listDoctorRunSummaries = ({ limit } = {}) =>
      doctorDb.listDoctorRunSummaries({ limit }).map((run) => ({
        ...run,
        startedAt: "2000-01-01T00:00:00.000Z",
        completedAt: "2000-01-01T00:00:00.000Z",
      }));

    const { createDoctorService } = loadDoctorService();
    const buildDoctorService = () =>
      createDoctorService({
        clawCmd: vi.fn(),
        listDoctorRuns,
        listDoctorRunSummaries,
        listDoctorCards: doctorDb.listDoctorCards,
        getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
        setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
        createDoctorRun: doctorDb.createDoctorRun,
        completeDoctorRun: doctorDb.completeDoctorRun,
        insertDoctorCards: doctorDb.insertDoctorCards,
        getDoctorRun: doctorDb.getDoctorRun,
        getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
        getDoctorCard: doctorDb.getDoctorCard,
        updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: fastComputeSnapshotAsync,
      });

    const doctorService = buildDoctorService();

    await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "Baseline findings",
        cards: [],
      }),
    });

    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Updated docs\n", "utf8");
    fs.mkdirSync(path.join(workspaceRoot, "skills"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "skills", "note.md"), "extra guidance\n", "utf8");

    const refreshedDoctorService = buildDoctorService();
    // Cold cache: the first status must NOT hash the workspace on the event
    // loop — it kicks the background worker and reports drift as unknown.
    const coldStatus = refreshedDoctorService.buildStatus();
    expect(coldStatus.changeSummary.hasBaseline).toBe(false);
    await refreshedDoctorService.awaitWorkspaceSnapshotRefresh();
    const status = refreshedDoctorService.buildStatus();

    expect(status.needsInitialRun).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.changeSummary.hasBaseline).toBe(true);
    expect(status.changeSummary.changedFilesCount).toBe(2);
    expect(status.changeSummary.hasMeaningfulChanges).toBe(true);
    expect(status.changeSummary.deltaScore).toBeGreaterThanOrEqual(4);
    expect(status.changeSummary.snapshotAgeMs).toBeGreaterThanOrEqual(0);
    expect(status.changeSummary.workspaceLimited).toBe(false);
  });

  it("uses the persisted initial baseline before the first completed run", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-initial-baseline-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-initial-baseline-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const { createDoctorService } = loadDoctorService();
    const buildDoctorService = () =>
      createDoctorService({
        clawCmd: vi.fn(),
        listDoctorRuns: doctorDb.listDoctorRuns,
        listDoctorCards: doctorDb.listDoctorCards,
        getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
        setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
        createDoctorRun: doctorDb.createDoctorRun,
        completeDoctorRun: doctorDb.completeDoctorRun,
        insertDoctorCards: doctorDb.insertDoctorCards,
        getDoctorRun: doctorDb.getDoctorRun,
        getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
        getDoctorCard: doctorDb.getDoctorCard,
        updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: fastComputeSnapshotAsync,
      });

    const doctorService = buildDoctorService();

    // Cold cache: status kicks the background snapshot worker; the initial
    // baseline is created (and drift computed) once it lands.
    doctorService.buildStatus();
    await doctorService.awaitWorkspaceSnapshotRefresh();
    const initialStatus = doctorService.buildStatus();
    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Added after baseline\n", "utf8");
    const nextService = buildDoctorService();
    nextService.buildStatus();
    await nextService.awaitWorkspaceSnapshotRefresh();
    const nextStatus = nextService.buildStatus();

    expect(initialStatus.needsInitialRun).toBe(true);
    expect(initialStatus.changeSummary.hasBaseline).toBe(true);
    expect(initialStatus.changeSummary.baselineSource).toBe("initial_install");
    expect(nextStatus.changeSummary.changedFilesCount).toBe(1);
    expect(nextStatus.changeSummary.hasMeaningfulChanges).toBe(false);
  });

  it("reports healthy Project Context files without truncation", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-healthy-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-healthy-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\nKeep it short.\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const status = doctorService.buildStatus();

    expect(status.bootstrapContext.hasActiveTruncation).toBe(false);
    expect(status.bootstrapContext.activeTruncatedFiles).toEqual([]);
  });

  it("reports per-file Project Context truncation in Doctor status", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-file-limit-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-file-limit-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), repeatText(20001), "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const status = doctorService.buildStatus();

    expect(status.bootstrapContext.hasActiveTruncation).toBe(true);
    expect(status.bootstrapContext.hasTotalLimitTruncation).toBe(false);
    expect(status.bootstrapContext.activeTruncatedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "AGENTS.md",
          rawChars: 20001,
          truncatedByFileLimit: true,
          truncatedByTotalLimit: false,
          reason: "file_limit",
        }),
      ]),
    );
  });

  it("reports total Project Context truncation when active injected files exceed the total cap", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-total-limit-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-total-limit-db-"));
    const activeProjectContextFiles = [
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "hooks/bootstrap/AGENTS.md",
      "hooks/bootstrap/TOOLS.md",
    ];
    fs.mkdirSync(path.join(workspaceRoot, "hooks", "bootstrap"), { recursive: true });
    for (const filePath of activeProjectContextFiles) {
      fs.writeFileSync(path.join(workspaceRoot, filePath), repeatText(20000), "utf8");
    }

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const status = doctorService.buildStatus();

    expect(status.bootstrapContext.hasActiveTruncation).toBe(true);
    expect(status.bootstrapContext.hasTotalLimitTruncation).toBe(true);
    expect(status.bootstrapContext.activeInjectedChars).toBe(
      status.bootstrapContext.bootstrapTotalMaxChars,
    );
    expect(status.bootstrapContext.activeTruncatedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "hooks/bootstrap/TOOLS.md",
          truncatedByTotalLimit: true,
        }),
      ]),
    );
  });

  it("persists reuse summaries without a frozen elapsed phrase", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-elapsed-workspace-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");
    const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
    const fingerprint = computeWorkspaceSnapshot(workspaceRoot).fingerprint;
    const { createDoctorService } = loadDoctorService();

    // Source run completed 2 hours ago: the old code baked "(2 hours ago)"
    // into the persisted summary, which then read back stale forever.
    const completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const summaries = [];
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: () => [
        {
          id: 1,
          status: "completed",
          workspaceFingerprint: fingerprint,
          completedAt,
          startedAt: completedAt,
          rawResult: {},
        },
      ],
      listDoctorRunSummaries: () => [
        {
          id: 1,
          status: "completed",
          workspaceFingerprint: fingerprint,
          completedAt,
          startedAt: completedAt,
        },
      ],
      getDoctorRunWorkspaceManifest: () => null,
      listDoctorCards: () => [],
      createDoctorRun: () => 2,
      completeDoctorRun: ({ summary }) => {
        summaries.push(summary);
      },
      insertDoctorCards: vi.fn(),
      getDoctorRun: () => null,
      getDoctorCardsByRunId: () => [{ status: "working", title: "Clone me" }],
      getDoctorCard: () => null,
      updateDoctorCardStatus: () => null,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const result = await doctorService.runDoctor();
    expect(result.reusedPreviousRun).toBe(true);
    const reuseSummary = summaries.find((summary) =>
      /No workspace changes/.test(summary || ""),
    );
    expect(reuseSummary).toBe(
      "No workspace changes since last scan. Same findings apply.",
    );
    expect(reuseSummary).not.toMatch(/\(/);
  });

  it("scrubs legacy frozen-elapsed reuse summaries on read but leaves other summaries alone", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-scrub-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-scrub-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorRunSummaries: doctorDb.listDoctorRunSummaries,
      getDoctorRunManifest: doctorDb.getDoctorRunManifest,
      getLatestCompletedRunSummary: doctorDb.getLatestCompletedRunSummary,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    // Seed runs straight into the DB the way legacy code persisted them.
    const seedRun = async (summary) => {
      const runId = doctorDb.createDoctorRun({
        status: "completed",
        engine: "gateway_agent",
        workspaceRoot,
        workspaceFingerprint: `fp-${summary.length}-${Math.random()}`,
        promptVersion: "test",
      });
      doctorDb.completeDoctorRun({ id: runId, status: "completed", summary });
      // listDoctorRuns orders by started_at (ms precision); keep seeds apart.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return runId;
    };

    const scrubbedSummary = "No workspace changes since last scan. Same findings apply.";
    const legacyShapes = [
      "No workspace changes since last scan (1 minute ago). Same findings apply.",
      "No workspace changes since last scan (12 minutes ago). Same findings apply.",
      "No workspace changes since last scan (2 hours ago). Same findings apply.",
      "No workspace changes since last scan (3 days ago). Same findings apply.",
      "No workspace changes since last scan (the last scan). Same findings apply.",
    ];
    // A coincidental "(3 minutes ago)" in a DIFFERENT sentence context must
    // survive untouched — the scrub matches the exact legacy template only.
    const coincidentalSummary =
      "Found a stale lockfile refreshed recently (3 minutes ago). Consider pinning versions.";

    const legacyRunIds = [];
    for (const shape of legacyShapes) {
      legacyRunIds.push(await seedRun(shape));
    }
    const coincidentalRunId = await seedRun(coincidentalSummary);
    // Seed a legacy-shaped run LAST so the status path serves it as latestRun.
    const latestLegacyRunId = await seedRun(
      "No workspace changes since last scan (12 minutes ago). Same findings apply.",
    );

    // Status path (/api/doctor/status): latestRun.summary is scrubbed.
    const status = doctorService.buildStatus();
    expect(status.latestRun.id).toBe(latestLegacyRunId);
    expect(status.latestRun.summary).toBe(scrubbedSummary);

    // Runs list path (/api/doctor/runs): every legacy shape is scrubbed, the
    // coincidental phrase is not.
    const listedRuns = doctorService.listDoctorRuns({ limit: 20 });
    for (const runId of [...legacyRunIds, latestLegacyRunId]) {
      const listed = listedRuns.find((run) => run.id === runId);
      expect(listed.summary).toBe(scrubbedSummary);
    }
    const listedCoincidental = listedRuns.find((run) => run.id === coincidentalRunId);
    expect(listedCoincidental.summary).toBe(coincidentalSummary);

    // Single-run path (/api/doctor/runs/:id): same scrub, same exemption.
    expect(doctorService.getDoctorRun(latestLegacyRunId).summary).toBe(scrubbedSummary);
    expect(doctorService.getDoctorRun(coincidentalRunId).summary).toBe(coincidentalSummary);

    // The DB row itself is untouched — this is a scrub-on-read, not a
    // migration.
    expect(doctorDb.getDoctorRun(latestLegacyRunId).summary).toBe(
      "No workspace changes since last scan (12 minutes ago). Same findings apply.",
    );
  });

  it("captures evidence snippets for path evidence with line ranges", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-db-"));
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), lines.join("\n"), "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const imported = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "Snippet findings",
        cards: [
          {
            priority: "P1",
            category: "workspace",
            title: "Snippet capture",
            summary: "Snippet capture test",
            recommendation: "Check the lines",
            evidence: [
              { type: "path", path: "AGENTS.md", startLine: 2, endLine: 3 },
              { type: "path", path: "AGENTS.md", startLine: 1, endLine: 30 },
              { type: "path", path: "AGENTS.md", startLine: 5 },
              { type: "path", path: "missing.md", startLine: 1, endLine: 2 },
            ],
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Fix it safely.",
            status: "open",
          },
        ],
      }),
    });

    const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);
    const [rangeItem, cappedItem, singleLineItem, missingItem] = card.evidence;

    expect(rangeItem.snippet).toMatchObject({
      text: "line 2\nline 3",
      startLine: 2,
      endLine: 3,
      truncated: false,
      totalFileLines: 30,
    });
    expect(cappedItem.snippet).toMatchObject({
      startLine: 1,
      endLine: 20,
      truncated: true,
    });
    expect(singleLineItem.snippet).toMatchObject({
      text: "line 5",
      startLine: 5,
      endLine: 5,
    });
    expect(missingItem.snippet).toBeUndefined();
  });

  it("marks the run failed when the gateway command reports an error", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-gwfail-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-gwfail-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const clawCmd = vi.fn(async () => ({ ok: false, stderr: "gateway exploded" }));
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd,
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const result = await doctorService.runDoctor();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const run = doctorDb.getDoctorRun(result.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("gateway exploded");
  });

  it("logs raw output and fails the run when normalization rejects the payload", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-badjson-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-badjson-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clawCmd = vi.fn(async () => ({
      ok: true,
      stdout: "definitely not doctor json",
      stderr: "",
    }));
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd,
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const result = await doctorService.runDoctor();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const run = doctorDb.getDoctorRun(result.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/recognizable cards payload/);
    const loggedMessages = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(loggedMessages.some((message) => /normalize failed/.test(message))).toBe(true);
    expect(loggedMessages).toContain("definitely not doctor json");
  });

  it("rejects a second Doctor run while one is in progress", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-busy-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-busy-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    let releaseGateway;
    const gatewayGate = new Promise((resolve) => {
      releaseGateway = resolve;
    });
    const clawCmd = vi.fn(async () => {
      await gatewayGate;
      return { ok: true, stdout: JSON.stringify({ summary: "Done", cards: [] }) };
    });
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd,
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const firstRun = await doctorService.runDoctor();
    const secondRun = await doctorService.runDoctor();
    releaseGateway();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstRun.ok).toBe(true);
    expect(secondRun.ok).toBe(false);
    expect(secondRun.alreadyRunning).toBe(true);
    expect(secondRun.runId).toBe(firstRun.runId);
    expect(secondRun.error).toBe("Doctor run already in progress");
  });

  it("requires raw output for imports and open cards plus a working gateway for fixes", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-guards-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-guards-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const clawCmd = vi.fn(async () => ({ ok: true, stdout: "{}", stderr: "" }));
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd,
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      startDoctorCardFix: doctorDb.startDoctorCardFix,
      cancelDoctorCardFix: doctorDb.cancelDoctorCardFix,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    await expect(doctorService.importDoctorResult({ rawOutput: "   " })).rejects.toThrow(
      "Doctor import requires raw output",
    );

    const imported = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "One finding",
        cards: [
          {
            priority: "P1",
            category: "workspace",
            title: "Guard checks",
            summary: "Guard checks",
            recommendation: "Guard checks",
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Fix safely.",
            status: "open",
          },
        ],
      }),
    });
    const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);

    doctorDb.updateDoctorCardStatus({ id: card.id, status: "fixed" });
    await expect(
      doctorService.requestCardFix({
        cardId: card.id,
        sessionKey: "agent:main:doctor:1",
        prompt: "Fix it.",
      }),
    ).rejects.toThrow("Doctor finding must be open before requesting a fix");

    doctorDb.updateDoctorCardStatus({ id: card.id, status: "open" });
    clawCmd.mockRejectedValueOnce(new Error("dispatch timeout"));
    await expect(
      doctorService.requestCardFix({
        cardId: card.id,
        sessionKey: "agent:main:doctor:1",
        prompt: "Fix it.",
      }),
    ).rejects.toThrow("dispatch timeout");
    expect(doctorDb.getDoctorCard(card.id).status).toBe("open");
  });

  it("adds deterministic truncation cards alongside imported Doctor findings", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-import-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-import-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), repeatText(20001), "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const imported = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "Imported findings",
        cards: [
          {
            priority: "P2",
            category: "workspace",
            title: "Small cleanup",
            summary: "Minor cleanup item",
            recommendation: "Tidy the note",
            evidence: [{ type: "path", path: "AGENTS.md" }],
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Tidy the note safely.",
            status: "open",
          },
        ],
      }),
    });

    const cards = doctorDb.getDoctorCardsByRunId(imported.runId);

    expect(cards).toHaveLength(2);
    expect(cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          priority: "P0",
          title: "AGENTS.md is being truncated in Project Context",
        }),
        expect.objectContaining({
          priority: "P2",
          title: "Small cleanup",
        }),
      ]),
    );
  });

  it("returns a slim latestRun without workspaceManifest or rawResult", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-slim-status-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-slim-status-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      computeSnapshotAsync: async () => computeWorkspaceSnapshot(workspaceRoot),
      workspaceRoot,
      managedRoot: workspaceRoot,
    });

    const imported = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "One finding",
        cards: [
          {
            priority: "P1",
            category: "workspace",
            title: "Slim status check",
            summary: "Slim status check",
            recommendation: "Keep status payloads small",
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Fix safely.",
            status: "open",
          },
        ],
      }),
    });

    const status = doctorService.buildStatus();

    expect(status.latestRun).toEqual({
      id: imported.runId,
      status: "completed",
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      summary: "One finding",
      counts: {
        cardCount: 1,
        priorityCounts: { P0: 0, P1: 1, P2: 0 },
        statusCounts: { open: 1, working: 0, dismissed: 0, fixed: 0 },
      },
    });
    expect(status.latestRun).not.toHaveProperty("workspaceManifest");
    expect(status.latestRun).not.toHaveProperty("rawResult");
  });

  it("serves the stale snapshot and recomputes it in the background", async () => {
    vi.useFakeTimers();
    try {
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bg-refresh-"));
      const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bg-refresh-db-"));
      fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

      const doctorDb = loadManagedDoctorDb();
      doctorDb.initDoctorDb({ rootDir: dbRoot });

      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
      let resolveRefresh;
      const computeSnapshotAsync = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      const { createDoctorService } = loadDoctorService();
      const doctorService = createDoctorService({
        clawCmd: vi.fn(),
        listDoctorRuns: doctorDb.listDoctorRuns,
        listDoctorCards: doctorDb.listDoctorCards,
        getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
        setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
        createDoctorRun: doctorDb.createDoctorRun,
        completeDoctorRun: doctorDb.completeDoctorRun,
        insertDoctorCards: doctorDb.insertDoctorCards,
        getDoctorRun: doctorDb.getDoctorRun,
        getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
        getDoctorCard: doctorDb.getDoctorCard,
        updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
        computeSnapshotAsync,
        workspaceRoot,
        managedRoot: workspaceRoot,
      });
      const flushMicrotasks = async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      };

      // Cold boot never hashes on the event loop: the first status kicks the
      // background worker and reports drift as unknown until it lands.
      const initialStatus = doctorService.buildStatus();
      expect(initialStatus.changeSummary.hasBaseline).toBe(false);
      expect(computeSnapshotAsync).toHaveBeenCalledTimes(1);
      resolveRefresh(computeWorkspaceSnapshot(workspaceRoot));
      await flushMicrotasks();
      const warmStatus = doctorService.buildStatus();
      expect(warmStatus.changeSummary.changedFilesCount).toBe(0);

      fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Added later\n", "utf8");
      vi.advanceTimersByTime(61_000);

      // Stale memo: the stale snapshot is served immediately and one
      // background recompute is kicked.
      const staleStatus = doctorService.buildStatus();
      expect(staleStatus.changeSummary.changedFilesCount).toBe(0);
      expect(computeSnapshotAsync).toHaveBeenCalledTimes(2);
      expect(computeSnapshotAsync).toHaveBeenLastCalledWith(workspaceRoot, {
        previousManifest: expect.any(Object),
      });

      // Refreshes coalesce while one is already in flight.
      vi.advanceTimersByTime(6_000);
      doctorService.buildStatus();
      expect(computeSnapshotAsync).toHaveBeenCalledTimes(2);

      resolveRefresh(computeWorkspaceSnapshot(workspaceRoot));
      await flushMicrotasks();
      vi.advanceTimersByTime(6_000);

      const freshStatus = doctorService.buildStatus();
      expect(freshStatus.changeSummary.changedFilesCount).toBe(1);
      expect(freshStatus.changeSummary.changedPaths).toEqual(["README.md"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps serving the stale snapshot and logs once when the worker crashes", async () => {
    vi.useFakeTimers();
    try {
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-worker-crash-"));
      const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-worker-crash-db-"));
      fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

      const doctorDb = loadManagedDoctorDb();
      doctorDb.initDoctorDb({ rootDir: dbRoot });

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const computeSnapshotAsync = vi.fn(async () => {
        throw new Error("worker exploded");
      });
      const { createDoctorService } = loadDoctorService();
      const doctorService = createDoctorService({
        clawCmd: vi.fn(),
        listDoctorRuns: doctorDb.listDoctorRuns,
        listDoctorCards: doctorDb.listDoctorCards,
        getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
        setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
        createDoctorRun: doctorDb.createDoctorRun,
        completeDoctorRun: doctorDb.completeDoctorRun,
        insertDoctorCards: doctorDb.insertDoctorCards,
        getDoctorRun: doctorDb.getDoctorRun,
        getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
        getDoctorCard: doctorDb.getDoctorCard,
        updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
        computeSnapshotAsync,
        workspaceRoot,
        managedRoot: workspaceRoot,
      });
      const flushMicrotasks = async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      };

      doctorService.buildStatus();
      fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Added later\n", "utf8");

      vi.advanceTimersByTime(61_000);
      const staleStatus = doctorService.buildStatus();
      await flushMicrotasks();

      vi.advanceTimersByTime(6_000);
      const retryStatus = doctorService.buildStatus();
      await flushMicrotasks();

      // Refresh failed both times: the stale manifest keeps serving status.
      expect(computeSnapshotAsync).toHaveBeenCalledTimes(2);
      expect(staleStatus.changeSummary.changedFilesCount).toBe(0);
      expect(retryStatus.changeSummary.changedFilesCount).toBe(0);
      const refreshFailureLogs = consoleErrorSpy.mock.calls.filter((call) =>
        /workspace snapshot refresh failed/.test(String(call[0])),
      );
      expect(refreshFailureLogs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Ported from v0.9.36 ("buildStatus never computes a snapshot
  // synchronously"): the status hot path returns a degraded view immediately
  // instead of awaiting the snapshot worker. The upstream assertion that the
  // compute is deferred to a later tick targeted their microtask scheduling
  // and is dropped — here the kick happens inline but is never awaited.
  it("buildStatus returns a degraded status without waiting for the snapshot worker", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-nonblocking-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-nonblocking-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    // Never-resolving compute: if buildStatus ever awaited/blocked on it,
    // this test would hang instead of returning a degraded status.
    const computeSpy = vi.fn(() => new Promise(() => {}));
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: computeSpy,
    });

    const status = doctorService.buildStatus();

    // buildStatus returned synchronously with a degraded (no-snapshot) view
    // while the background compute is still pending.
    expect(status.changeSummary.hasBaseline).toBe(false);
    expect(status.changeSummary.baselineSource).toBe("none");
    expect(status.changeSummary.changedFilesCount).toBe(0);
    expect(status.changeSummary.deltaScore).toBe(0);
    expect(status.changeSummary.snapshotAgeMs).toBe(null);
    expect(status.changeSummary.workspaceLimited).toBe(false);
    expect(computeSpy).toHaveBeenCalledTimes(1);
  });

  // Ported from v0.9.36 ("serves the stale snapshot when the worker fails"):
  // an explicit refresh resolves to the stale snapshot instead of rejecting.
  // Adapted to this branch's surface: no {incremental:false} option and the
  // crash-fallback logs through console.error (log-once), not console.warn.
  it("refreshWorkspaceSnapshot resolves the stale snapshot when the worker fails", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-stale-workspace-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-stale-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const computeSpy = vi.fn(fastComputeSnapshotAsync);
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorRunSummaries: doctorDb.listDoctorRunSummaries,
      getDoctorRunManifest: doctorDb.getDoctorRunManifest,
      getLatestCompletedRunSummary: doctorDb.getLatestCompletedRunSummary,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: computeSpy,
    });

    // Establish a run baseline, then drift the workspace and seed the cache.
    await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({ summary: "Baseline", cards: [] }),
    });
    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# New file\n", "utf8");
    const seeded = await doctorService.refreshWorkspaceSnapshot();

    const statusBefore = doctorService.buildStatus();
    expect(statusBefore.changeSummary.hasBaseline).toBe(true);
    expect(statusBefore.changeSummary.changedFilesCount).toBe(1);

    // Worker starts failing: refresh must resolve to the stale snapshot.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    computeSpy.mockRejectedValue(new Error("worker exploded"));
    const stale = await doctorService.refreshWorkspaceSnapshot();

    expect(stale).toBeTruthy();
    expect(stale.fingerprint).toBe(seeded.fingerprint);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("workspace snapshot refresh failed"),
    );

    // buildStatus still reports the old delta from the stale snapshot.
    const statusAfter = doctorService.buildStatus();
    expect(statusAfter.changeSummary.hasBaseline).toBe(true);
    expect(statusAfter.changeSummary.changedFilesCount).toBe(1);
    errorSpy.mockRestore();
  });

  it("computes snapshots in the fingerprint worker with incremental re-hashing", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-worker-smoke-"));
    fs.writeFileSync(path.join(workspaceRoot, "a.md"), "alpha\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "b.md"), "beta\n", "utf8");
    const {
      computeWorkspaceSnapshot,
      createWorkspaceSnapshotWorkerClient,
    } = require("../../lib/server/doctor/workspace-fingerprint");

    const baseline = computeWorkspaceSnapshot(workspaceRoot);
    const updatedContent = "beta with more content\n";
    fs.writeFileSync(path.join(workspaceRoot, "b.md"), updatedContent, "utf8");
    // Sentinel hash: it can only survive into the next manifest if the
    // unchanged file was NOT re-hashed (mtime+size short-circuit).
    const tamperedManifest = {
      ...baseline.manifest,
      "a.md": { ...baseline.manifest["a.md"], hash: "sentinel-not-rehashed" },
    };

    const client = createWorkspaceSnapshotWorkerClient();
    try {
      const snapshot = await client.computeWorkspaceSnapshotAsync(workspaceRoot, {
        previousManifest: tamperedManifest,
      });
      expect(snapshot.manifest["a.md"].hash).toBe("sentinel-not-rehashed");
      expect(snapshot.manifest["b.md"].hash).toBe(
        crypto.createHash("sha256").update(updatedContent).digest("hex"),
      );
      expect(snapshot.manifest["a.md"].mtimeMs).toEqual(expect.any(Number));
      expect(snapshot.manifest["a.md"].size).toBe(baseline.manifest["a.md"].size);
      expect(snapshot.fingerprint).not.toBe(baseline.fingerprint);

      // Persisted manifests without mtime metadata are always re-hashed.
      const legacySnapshot = await client.computeWorkspaceSnapshotAsync(workspaceRoot, {
        previousManifest: {
          "a.md": { hash: "sentinel-not-rehashed", size: baseline.manifest["a.md"].size },
        },
      });
      expect(legacySnapshot.manifest["a.md"].hash).toBe(baseline.manifest["a.md"].hash);
    } finally {
      await client.terminate();
    }
  });

  // Ported from v0.9.36's fingerprint-worker tests: worker/sync parity, scan
  // stats, previousManifest passthrough, and a fresh client after a previous
  // one was terminated.
  it("matches the sync scanner in the worker and reuses hashes on the second pass", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-worker-parity-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\nKeep it tight.\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Readme\n", "utf8");
    fs.mkdirSync(path.join(workspaceRoot, "skills"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "skills", "note.md"), "extra guidance\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "data.bin"), Buffer.from([1, 2, 3, 4]));
    const {
      computeWorkspaceSnapshot,
      createWorkspaceSnapshotWorkerClient,
    } = require("../../lib/server/doctor/workspace-fingerprint");

    const syncSnapshot = computeWorkspaceSnapshot(workspaceRoot);
    const client = createWorkspaceSnapshotWorkerClient();
    try {
      const workerSnapshot = await client.computeWorkspaceSnapshotAsync(workspaceRoot);

      expect(workerSnapshot.fingerprint).toBe(syncSnapshot.fingerprint);
      expect(Object.keys(workerSnapshot.manifest).sort()).toEqual(
        Object.keys(syncSnapshot.manifest).sort(),
      );
      for (const [relativePath, entry] of Object.entries(syncSnapshot.manifest)) {
        expect(workerSnapshot.manifest[relativePath].hash).toBe(entry.hash);
        expect(workerSnapshot.manifest[relativePath].size).toBe(entry.size);
      }
      expect(workerSnapshot.limited).toBe(false);
      expect(workerSnapshot.stats).toEqual(
        expect.objectContaining({
          totalFiles: 4,
          hashedCount: 4,
          reusedCount: 0,
          skippedLargeCount: 0,
        }),
      );

      const second = await client.computeWorkspaceSnapshotAsync(workspaceRoot, {
        previousManifest: workerSnapshot.manifest,
      });
      expect(second.fingerprint).toBe(workerSnapshot.fingerprint);
      expect(second.stats.reusedCount).toBe(4);
      expect(second.stats.hashedCount).toBe(0);
    } finally {
      await client.terminate();
    }

    // Crash resilience at the client level: a brand-new client spawns a
    // fresh worker and keeps serving snapshots.
    const freshClient = createWorkspaceSnapshotWorkerClient();
    try {
      const third = await freshClient.computeWorkspaceSnapshotAsync(workspaceRoot);
      expect(third.fingerprint).toBe(syncSnapshot.fingerprint);
    } finally {
      await freshClient.terminate();
    }
  });

  // Ported from v0.9.36's fingerprint-client tests onto this branch's worker
  // client. Fake worker scripts speak the real worker protocol (see
  // lib/server/doctor/fingerprint-worker.js):
  //   in:  {jobId, workspaceRoot, previousManifest}
  //   out: {jobId, ok, snapshot | error}
  describe("workspace snapshot worker client lifecycle", () => {
    const { createWorkspaceSnapshotWorkerClient } = require("../../lib/server/doctor/workspace-fingerprint");
    const tmpDirs = [];
    let client = null;

    const makeTmpDir = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-worker-client-"));
      tmpDirs.push(dir);
      return dir;
    };

    afterEach(async () => {
      if (client) {
        await client.terminate();
        client = null;
      }
      while (tmpDirs.length > 0) {
        fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
      }
    });

    // Worker that crashes unless a sentinel file exists — lets one client (the
    // workerScriptPath is fixed per client) alternate between failing and
    // healthy round-trips.
    const writeSentinelWorker = (dir, sentinelPath) => {
      const workerScriptPath = path.join(dir, "sentinel-worker.js");
      fs.writeFileSync(
        workerScriptPath,
        `
        const fs = require("fs");
        const { parentPort } = require("worker_threads");
        parentPort.on("message", (message) => {
          if (fs.existsSync(${JSON.stringify(sentinelPath)})) {
            parentPort.postMessage({
              jobId: message.jobId,
              ok: true,
              snapshot: { fingerprint: "fp-healthy", manifest: {} },
            });
          } else {
            process.exit(1);
          }
        });
        `,
      );
      return workerScriptPath;
    };

    // Worker that records each spawn, then crashes on the first request.
    const writeCrashWorker = (dir, spawnLogPath) => {
      const workerScriptPath = path.join(dir, "crash-worker.js");
      fs.writeFileSync(
        workerScriptPath,
        `
        const fs = require("fs");
        const { parentPort } = require("worker_threads");
        fs.appendFileSync(${JSON.stringify(spawnLogPath)}, "spawn\\n");
        parentPort.on("message", () => {
          process.exit(1);
        });
        `,
      );
      return workerScriptPath;
    };

    it("resets the respawn budget after a healthy round-trip", async () => {
      const dir = makeTmpDir();
      const sentinelPath = path.join(dir, "healthy.sentinel");
      const workerScriptPath = writeSentinelWorker(dir, sentinelPath);
      client = createWorkspaceSnapshotWorkerClient({ workerScriptPath });

      // Two crashes burn respawns 1 and 2 of the cap of 3.
      await expect(client.computeWorkspaceSnapshotAsync("/ws")).rejects.toThrow(
        "Workspace snapshot worker exited",
      );
      await expect(client.computeWorkspaceSnapshotAsync("/ws")).rejects.toThrow(
        "Workspace snapshot worker exited",
      );

      // A healthy round-trip resets the counter to 0.
      fs.writeFileSync(sentinelPath, "ok", "utf8");
      const snapshot = await client.computeWorkspaceSnapshotAsync("/ws");
      expect(snapshot.fingerprint).toBe("fp-healthy");

      // Two MORE crashes still respawn and reject with the exit error. Without
      // the reset these would be lifetime failures 3 and 4 — the 4th call would
      // hit the cap and reject with "respawn cap reached" without respawning.
      fs.rmSync(sentinelPath);
      await expect(client.computeWorkspaceSnapshotAsync("/ws")).rejects.toThrow(
        "Workspace snapshot worker exited",
      );
      await expect(client.computeWorkspaceSnapshotAsync("/ws")).rejects.toThrow(
        "Workspace snapshot worker exited",
      );
    });

    it("stops respawning after three consecutive failures", async () => {
      const dir = makeTmpDir();
      const spawnLogPath = path.join(dir, "spawn.log");
      const workerScriptPath = writeCrashWorker(dir, spawnLogPath);
      client = createWorkspaceSnapshotWorkerClient({ workerScriptPath });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(client.computeWorkspaceSnapshotAsync("/ws")).rejects.toThrow(
          "Workspace snapshot worker exited",
        );
      }

      // The cap is exhausted: the 4th call rejects up front, without spawning
      // a 4th worker (the spawn log stays at 3 entries).
      await expect(client.computeWorkspaceSnapshotAsync("/ws")).rejects.toThrow(
        "Workspace snapshot worker unavailable (respawn cap reached)",
      );
      const spawns = fs
        .readFileSync(spawnLogPath, "utf8")
        .split("\n")
        .filter(Boolean);
      expect(spawns).toHaveLength(3);
    });

    it("rejects computeWorkspaceSnapshotAsync after terminate()", async () => {
      const dir = makeTmpDir();
      const spawnLogPath = path.join(dir, "spawn.log");
      const workerScriptPath = writeCrashWorker(dir, spawnLogPath);
      client = createWorkspaceSnapshotWorkerClient({ workerScriptPath });

      await client.terminate();

      await expect(client.computeWorkspaceSnapshotAsync("/ws")).rejects.toThrow(
        "Workspace snapshot worker terminated",
      );
      // The terminated guard fires before any worker could spawn.
      expect(fs.existsSync(spawnLogPath)).toBe(false);
    });
  });
});

// H6: evidence snippet paths come from untrusted AI/import output. They must be
// realpath-contained to the workspace, and must be regular files under a size
// cap (no traversal, no symlink escape, no FIFO/huge-file DoS).
describe("server/doctor-service evidence snippet containment (H6)", () => {
  let managedDb = null;

  afterEach(() => {
    if (managedDb?.closeDoctorDb) {
      managedDb.closeDoctorDb();
      managedDb = null;
    }
  });

  const importWithEvidence = async ({ workspaceRoot, evidence }) => {
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-h6-db-"));
    const doctorDb = loadDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });
    managedDb = doctorDb;
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
      listDoctorRuns: doctorDb.listDoctorRuns,
      listDoctorRunSummaries: doctorDb.listDoctorRunSummaries,
      getDoctorRunManifest: doctorDb.getDoctorRunManifest,
      getLatestCompletedRunSummary: doctorDb.getLatestCompletedRunSummary,
      listDoctorCards: doctorDb.listDoctorCards,
      getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
      setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
      createDoctorRun: doctorDb.createDoctorRun,
      completeDoctorRun: doctorDb.completeDoctorRun,
      insertDoctorCards: doctorDb.insertDoctorCards,
      getDoctorRun: doctorDb.getDoctorRun,
      getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
      getDoctorCard: doctorDb.getDoctorCard,
      updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
      workspaceRoot,
      managedRoot: workspaceRoot,
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });
    const imported = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "findings",
        cards: [
          {
            priority: "P1",
            category: "correctness",
            title: "evidence card",
            summary: "s",
            recommendation: "r",
            evidence,
            targetPaths: [],
            fixPrompt: "fix",
            status: "open",
          },
        ],
      }),
    });
    const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);
    return card.evidence[0];
  };

  it("captures a snippet for an in-workspace evidence path (allow-legit)", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-h6-ws-"));
    fs.writeFileSync(
      path.join(workspaceRoot, "note.txt"),
      "line one\nline two\nline three\n",
      "utf8",
    );
    const item = await importWithEvidence({
      workspaceRoot,
      evidence: [{ type: "path", path: "note.txt", startLine: 1, endLine: 2 }],
    });
    expect(item.snippet).toBeTruthy();
    expect(item.snippet.text).toBe("line one\nline two");
  });

  it("does not capture a snippet for a traversing evidence path", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-h6-ws-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-h6-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET\n", "utf8");
    const item = await importWithEvidence({
      workspaceRoot,
      evidence: [
        {
          type: "path",
          path: `../${path.basename(outsideDir)}/secret.txt`,
          startLine: 1,
          endLine: 1,
        },
      ],
    });
    expect(item.snippet).toBeUndefined();
  });

  it("does not capture a snippet for a symlink escaping the workspace", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-h6-ws-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-h6-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET\n", "utf8");
    let symlinked = true;
    try {
      fs.symlinkSync(
        path.join(outsideDir, "secret.txt"),
        path.join(workspaceRoot, "innocent.txt"),
      );
    } catch {
      symlinked = false;
    }
    if (!symlinked) return;
    const item = await importWithEvidence({
      workspaceRoot,
      evidence: [{ type: "path", path: "innocent.txt", startLine: 1, endLine: 1 }],
    });
    expect(item.snippet).toBeUndefined();
  });

  it("does not read an oversized in-workspace file (DoS guard)", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-h6-ws-"));
    const bigPath = path.join(workspaceRoot, "big.txt");
    fs.writeFileSync(bigPath, "start\n", "utf8");
    const fd = fs.openSync(bigPath, "r+");
    try {
      fs.ftruncateSync(fd, 3 * 1024 * 1024); // over the 2MB cap
    } finally {
      fs.closeSync(fd);
    }
    const item = await importWithEvidence({
      workspaceRoot,
      evidence: [{ type: "path", path: "big.txt", startLine: 1, endLine: 2 }],
    });
    expect(item.snippet).toBeUndefined();
  });
});
