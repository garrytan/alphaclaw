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
    // Honest response: no reply target derivable from a doctor session key.
    expect(result.delivery).toEqual({
      attached: false,
      replyChannel: "",
      replyTo: "",
      replyAccountId: "",
    });
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

    const deliveryResult = await doctorService.requestCardFix({
      cardId: card.id,
      sessionKey: "agent:main:telegram:direct:1050",
      replyChannel: "telegram",
      replyTo: "1050",
      prompt: "Apply the safe fix.",
    });

    expect(deliveryResult.delivery).toEqual({
      attached: true,
      replyChannel: "telegram",
      replyTo: "1050",
      replyAccountId: "",
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
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-total-limit-managed-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-total-limit-db-"));
    // 60k total budget: AGENTS+SOUL+TOOLS consume it; everything after (incl.
    // AlphaClaw's hook extra, injected LAST) starves.
    const activeProjectContextFiles = [
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "hooks/bootstrap/AGENTS.md",
    ];
    fs.mkdirSync(path.join(workspaceRoot, "hooks", "bootstrap"), { recursive: true });
    for (const filePath of activeProjectContextFiles) {
      fs.writeFileSync(path.join(workspaceRoot, filePath), repeatText(20000), "utf8");
    }
    fs.writeFileSync(
      path.join(managedRoot, "openclaw.json"),
      JSON.stringify({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "bootstrap-extra-files": {
                enabled: true,
                paths: ["hooks/bootstrap/AGENTS.md"],
              },
            },
          },
        },
      }),
      "utf8",
    );

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
      managedRoot,
      readOpenclawConfig: ({ openclawDir, fallback }) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
          );
        } catch {
          return fallback;
        }
      },
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
          path: "hooks/bootstrap/AGENTS.md",
          truncatedByTotalLimit: true,
          skipped: true,
          reason: "starved",
        }),
      ]),
    );
    expect(status.bootstrapContext.hardening.state).toBe("starved");
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
          promptVersion: "doctor-v2",
          contextProfile: "stable-2026.7",
          openclawVersion: "",
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
          promptVersion: "doctor-v2",
          contextProfile: "stable-2026.7",
          openclawVersion: "",
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
      "No workspace changes since last scan. LLM findings carried over; environment checks re-evaluated.",
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

    const scrubbedSummary = "No workspace changes since last scan. LLM findings carried over; environment checks re-evaluated.";
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

  it("contains evidence snippets to the workspace and redacts secret-shaped values", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-guard-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-guard-db-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "outside contents\n", "utf8");
    fs.writeFileSync(
      path.join(workspaceRoot, "AGENTS.md"),
      "safe line\ntoken=doctor-snippet-secret-value\n",
      "utf8",
    );
    // The service's sanitizer collects secret-shaped env values at creation.
    process.env.DOCTOR_SNIPPET_TEST_TOKEN = "doctor-snippet-secret-value";
    try {
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

      const traversalPath = path.relative(workspaceRoot, path.join(outsideDir, "secret.md"));
      const imported = await doctorService.importDoctorResult({
        rawOutput: JSON.stringify({
          summary: "Snippet guard",
          cards: [
            {
              priority: "P1",
              category: "workspace",
              title: "Snippet guard",
              summary: "Snippet guard",
              recommendation: "r",
              evidence: [
                { type: "path", path: traversalPath, startLine: 1, endLine: 2 },
                { type: "path", path: path.join(outsideDir, "secret.md"), startLine: 1 },
                { type: "path", path: "AGENTS.md", startLine: 1, endLine: 2 },
              ],
              targetPaths: ["AGENTS.md"],
              fixPrompt: "Fix safely.",
              status: "open",
            },
          ],
        }),
      });

      const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);
      const [traversalItem, absoluteItem, insideItem] = card.evidence;

      // Traversal ("../…") and absolute paths never read outside the root.
      expect(traversalItem.snippet).toBeUndefined();
      expect(absoluteItem.snippet).toBeUndefined();
      // In-root snippets are captured but secret values are redacted.
      expect(insideItem.snippet.text).toContain("safe line");
      expect(insideItem.snippet.text).toContain("[redacted]");
      expect(insideItem.snippet.text).not.toContain("doctor-snippet-secret-value");
    } finally {
      delete process.env.DOCTOR_SNIPPET_TEST_TOKEN;
    }
  });

  it("refuses snippets through in-workspace symlinks and bounds huge-file reads", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-symlink-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-symlink-db-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-symlink-out-"));
    fs.writeFileSync(path.join(outsideDir, "host-secret.md"), "host file contents\n", "utf8");
    // The lexical containment check passes for "sneaky.md" — only the
    // realpath check can catch the link escaping the workspace.
    fs.symlinkSync(path.join(outsideDir, "host-secret.md"), path.join(workspaceRoot, "sneaky.md"));
    // A >512KB file: the reader scans in bounded chunks, so an in-window
    // range is fully served (not truncated) without buffering the whole file.
    const hugeLines = ["head line one", "head line two"];
    for (let index = 0; index < 40; index += 1) hugeLines.push(repeatText(20000, "x"));
    fs.writeFileSync(path.join(workspaceRoot, "HUGE.md"), hugeLines.join("\n"), "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

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
        summary: "Symlink and cap guard",
        cards: [
          {
            priority: "P1",
            category: "workspace",
            title: "Symlink and cap guard",
            summary: "s",
            recommendation: "r",
            evidence: [
              { type: "path", path: "sneaky.md", startLine: 1, endLine: 1 },
              { type: "path", path: "HUGE.md", startLine: 1, endLine: 2 },
            ],
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Fix safely.",
            status: "open",
          },
        ],
      }),
    });

    const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);
    const [symlinkItem, hugeItem] = card.evidence;

    // The symlink resolves outside the workspace: no snippet, no host bytes.
    expect(symlinkItem.snippet).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain("host file contents");
    // The huge file's in-range citation is fully served: not truncated, and
    // the whole file (< 8 MiB) was countable within the scan bound.
    expect(hugeItem.snippet).toMatchObject({
      text: "head line one\nhead line two",
      startLine: 1,
      endLine: 2,
      truncated: false,
      totalFileLines: 42,
    });

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("serves citations past the 512KB chunk window and nulls past the 8MiB scan bound", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-deep-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-snippet-deep-db-"));
    // ~9.4MB of ~1KB lines: line 700 sits past the 512KB chunk size (the old
    // head-read returned an empty snippet for it) and line 9000 sits past the
    // 8 MiB scan bound (no snippet at all rather than an unbounded read).
    const deepLines = [];
    for (let index = 1; index <= 9500; index += 1) {
      deepLines.push(`line-${index} ${repeatText(980, "x")}`);
    }
    fs.writeFileSync(path.join(workspaceRoot, "DEEP.md"), deepLines.join("\n"), "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

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
        summary: "Deep citation",
        cards: [
          {
            priority: "P1",
            category: "workspace",
            title: "Deep citation",
            summary: "s",
            recommendation: "r",
            evidence: [
              { type: "path", path: "DEEP.md", startLine: 700, endLine: 701 },
              { type: "path", path: "DEEP.md", startLine: 9000, endLine: 9001 },
            ],
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Fix safely.",
            status: "open",
          },
        ],
      }),
    });

    const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);
    const [deepItem, pastBoundItem] = card.evidence;

    // The cited lines past the first 512KB come back with correct content and
    // metadata — but the file is larger than the 8 MiB scan bound, so
    // totalFileLines is dropped instead of scanning to EOF to count lines.
    expect(deepItem.snippet.startLine).toBe(700);
    expect(deepItem.snippet.endLine).toBe(701);
    expect(deepItem.snippet.truncated).toBe(false);
    expect(deepItem.snippet.totalFileLines).toBeUndefined();
    const deepSnippetLines = deepItem.snippet.text.split("\n");
    expect(deepSnippetLines).toHaveLength(2);
    expect(deepSnippetLines[0].startsWith("line-700 ")).toBe(true);
    expect(deepSnippetLines[1].startsWith("line-701 ")).toBe(true);
    // Reaching line 9000 needs more than 8 MiB of scanning: no snippet.
    expect(pastBoundItem.snippet).toBeUndefined();
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

  it("includes the wired dashboard-token check in a full doctor run's output", async () => {
    // Wiring proof, not another unit test: an unwired check passes its unit
    // suite while never appearing in a run. Registers through the same
    // registerDashboardTokenCheck path register-server-routes uses, then
    // asserts the card lands among the run's persisted cards.
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-dash-token-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-dash-token-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");
    try {
      const doctorDb = loadManagedDoctorDb();
      doctorDb.initDoctorDb({ rootDir: dbRoot });

      const { createDashboardUrlService } = require("../../lib/server/gateway-dashboard-url");
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/#token=cli-token",
      }));
      const dashboardUrlService = createDashboardUrlService({
        // Token mode, no token anywhere: config-only resolution comes up empty.
        fsModule: { readFileSync: () => JSON.stringify({ gateway: { auth: {} } }) },
        openclawDir: "/tmp/openclaw",
        readEnvFile: () => [],
        clawCmd,
        importSecretRuntime: () =>
          Promise.resolve([
            { coerceSecretRef: () => null },
            { resolveSecretRefValues: async () => new Map() },
          ]),
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
        readOpenclawConfig: () => ({ gateway: { auth: {} } }),
        isOnboarded: () => true,
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: fastComputeSnapshotAsync,
      });
      doctorService.registerDashboardTokenCheck(dashboardUrlService);

      const imported = await doctorService.importDoctorResult({
        rawOutput: JSON.stringify({ summary: "Clean", cards: [] }),
      });

      const cards = doctorDb.getDoctorCardsByRunId(imported.runId);
      expect(cards).toEqual([
        expect.objectContaining({
          sourceKey: "det:dashboard-token-unresolvable",
          priority: "P2",
          source: "deterministic",
        }),
      ]);
      // The check is config-only: the CLI-spawning resolver path never ran.
      expect(clawCmd).not.toHaveBeenCalled();
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
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

  it("runStartPending latch: concurrent runDoctor during the pre-run snapshot await gets alreadyRunning", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-latch-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-latch-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    let resolveSnapshot;
    const snapshotGate = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    const computeSnapshotAsync = vi.fn(async (root, opts) => {
      await snapshotGate;
      return computeWorkspaceSnapshotBounded(root, { ...(opts || {}), batchPauseMs: 0 });
    });
    const clawCmd = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ summary: "clean", cards: [] }),
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
      computeSnapshotAsync,
      workspaceRoot,
      managedRoot: workspaceRoot,
    });

    // First run is parked on the pre-run snapshot await — BEFORE the
    // activeRunPromise latch exists. The runStartPending latch must cover
    // exactly this window: a concurrent run must not slip through and start
    // a second scan.
    const firstRun = doctorService.runDoctor();
    const concurrent = await doctorService.runDoctor();
    expect(concurrent.ok).toBe(false);
    expect(concurrent.alreadyRunning).toBe(true);
    expect(concurrent.error).toBe("Doctor run already in progress");

    resolveSnapshot();
    const firstResult = await firstRun;
    expect(firstResult.ok).toBe(true);
    expect(computeSnapshotAsync).toHaveBeenCalledTimes(1);
    // runStartPending released: the busy signal now comes from the REAL run
    // latch (activeRunPromise carries the created run's id), not a stuck
    // pending flag (which would report runId 0 forever).
    const duringRun = await doctorService.runDoctor();
    expect(duringRun.alreadyRunning).toBe(true);
    expect(duringRun.runId).toBe(firstResult.runId);
    // Once the background run settles, nothing blocks a new run.
    await vi.waitFor(() => {
      expect(doctorService.buildStatus().runInProgress).toBe(false);
    });
    const afterward = await doctorService.runDoctor();
    expect(afterward.alreadyRunning).not.toBe(true);
  });

  it("clamps the worker-unavailable sync fallback to the legacy caps (X11)", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-fallback-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-fallback-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    const computeSnapshotAsync = vi.fn(async () => {
      throw new Error("Workspace snapshot worker unavailable (respawn cap reached)");
    });
    const syncCompute = vi.fn((root, opts) => {
      syncCompute.lastOpts = opts;
      return {
        fingerprint: "sync-fallback",
        manifest: {},
        limited: false,
        capsUsed: { maxFiles: opts.maxFiles, maxFileBytes: opts.maxFileBytes },
        stats: { totalFiles: 0 },
      };
    });
    const { createDoctorService } = loadDoctorService();
    const doctorService = createDoctorService({
      clawCmd: vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ summary: "clean", cards: [] }),
        stderr: "",
      })),
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
      computeSnapshot: syncCompute,
      computeSnapshotAsync,
      // Operator raised the caps well above legacy…
      readScanCaps: () => ({ maxFiles: 500000, maxFileMb: 100 }),
      workspaceRoot,
      managedRoot: workspaceRoot,
    });

    const result = await doctorService.runDoctor();
    expect(result.ok).toBe(true);
    // …but the degraded sync path never runs above the legacy bounds: the
    // event-loop block stays capped at the pre-configurable worst case.
    expect(syncCompute).toHaveBeenCalledTimes(1);
    expect(syncCompute.lastOpts.maxFiles).toBe(50000);
    expect(syncCompute.lastOpts.maxFileBytes).toBe(10 * 1024 * 1024);
  });

  it("discards in-flight old-cap snapshot results after invalidateSnapshotCache (caps epoch)", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-caps-epoch-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-caps-epoch-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    let resolveFirst;
    const firstGate = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const computeSnapshotAsync = vi.fn(async (root, opts) => {
      if (computeSnapshotAsync.mock.calls.length === 1) {
        await firstGate;
        return {
          fingerprint: "old-caps",
          manifest: {},
          limited: false,
          capsUsed: { maxFiles: opts.maxFiles, maxFileBytes: opts.maxFileBytes },
          stats: { totalFiles: 0 },
        };
      }
      return {
        fingerprint: "new-caps",
        manifest: {},
        limited: false,
        capsUsed: { maxFiles: opts.maxFiles, maxFileBytes: opts.maxFileBytes },
        stats: { totalFiles: 0 },
      };
    });

    let caps = { maxFiles: null, maxFileMb: null };
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
      readScanCaps: () => caps,
      workspaceRoot,
      managedRoot: workspaceRoot,
    });

    // A refresh is in flight under the default caps…
    const firstRefresh = doctorService.refreshWorkspaceSnapshot();
    expect(computeSnapshotAsync.mock.calls[0][1].maxFiles).toBe(200000);

    // …when the operator changes the caps. The epoch bump must discard the
    // in-flight old-cap result and queue a fresh-caps refresh behind it.
    caps = { maxFiles: 1000, maxFileMb: 5 };
    const invalidated = doctorService.invalidateSnapshotCache();

    resolveFirst();
    await firstRefresh;
    await invalidated;

    expect(computeSnapshotAsync).toHaveBeenCalledTimes(2);
    const secondOpts = computeSnapshotAsync.mock.calls[1][1];
    expect(secondOpts.maxFiles).toBe(1000);
    expect(secondOpts.maxFileBytes).toBe(5 * 1024 * 1024);
    // The discarded old-cap result never became the cache: the follow-up
    // refresh saw NO previous fingerprint (a committed old result would have
    // handed it "old-caps").
    expect(secondOpts.previousFingerprint).toBe("");

    const status = doctorService.buildStatus();
    expect(computeSnapshotAsync).toHaveBeenCalledTimes(2);
    expect(status.workspaceScan.configured).toEqual({ maxFiles: 1000, maxFileMb: 5 });
    expect(status.workspaceScan.effective).toEqual({
      maxFiles: 1000,
      maxFileBytes: 5 * 1024 * 1024,
      maxFileMb: 5,
    });
    expect(status.workspaceScan.capsUsed).toEqual({
      maxFiles: 1000,
      maxFileBytes: 5 * 1024 * 1024,
    });
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
        previousFingerprint: expect.any(String),
        maxFiles: expect.any(Number),
        maxFileBytes: expect.any(Number),
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

  describe("doctor-v2 reuse guard and card provenance", () => {
    const makeFixtureService = ({
      previousRun,
      previousCards = [],
      allCards = [],
      workspaceRoot,
      managedRoot = workspaceRoot,
      featureGates = null,
      getInstalledVersion,
      inserts,
      created,
    }) => {
      const { createDoctorService } = loadDoctorService();
      return createDoctorService({
        clawCmd: vi.fn(async () => ({
          ok: true,
          stdout: JSON.stringify({ summary: "fresh", cards: [] }),
        })),
        listDoctorRuns: () => (previousRun ? [previousRun] : []),
        listDoctorCards: () => allCards,
        createDoctorRun: (run) => {
          created.push(run);
          return created.length + 1;
        },
        completeDoctorRun: vi.fn(),
        insertDoctorCards: (payload) => {
          inserts.push(payload);
        },
        getDoctorRun: () => ({ rawResult: {} }),
        getDoctorCardsByRunId: () => previousCards,
        getDoctorCard: () => null,
        updateDoctorCardStatus: () => null,
        getInitialWorkspaceBaseline: () => null,
        setInitialWorkspaceBaseline: () => null,
        workspaceRoot,
        managedRoot,
        featureGates,
        getInstalledVersion,
        readOpenclawConfig: ({ openclawDir, fallback }) => {
          try {
            return JSON.parse(
              fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
            );
          } catch {
            return fallback;
          }
        },
        computeSnapshotAsync: fastComputeSnapshotAsync,
      });
    };

    const settleBackgroundRun = () => new Promise((resolve) => setImmediate(resolve));

    const makeMatchingRun = (fingerprint, overrides = {}) => ({
      id: 1,
      status: "completed",
      workspaceFingerprint: fingerprint,
      promptVersion: "doctor-v2",
      contextProfile: "stable-2026.7",
      openclawVersion: "2026.7.1-2",
      completedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      ...overrides,
    });

    let workspaceRoot;
    beforeEach(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-reuse-guard-"));
      fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");
    });

    it.each([
      ["prompt version", { promptVersion: "doctor-v1" }],
      ["context profile", { contextProfile: "beta-2026.8.1" }],
      ["installed version", { openclawVersion: "2026.7.1-1" }],
      ["legacy run without profile columns", { promptVersion: "doctor-v2", contextProfile: "", openclawVersion: "" }],
    ])("rejects fingerprint reuse on a %s mismatch", async (_label, overrides) => {
      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
      const fingerprint = computeWorkspaceSnapshot(workspaceRoot).fingerprint;
      const inserts = [];
      const created = [];
      const doctorService = makeFixtureService({
        previousRun: makeMatchingRun(fingerprint, overrides),
        workspaceRoot,
        getInstalledVersion: () => "2026.7.1-2",
        inserts,
        created,
      });

      const result = await doctorService.runDoctor();
      await settleBackgroundRun();

      expect(result.reusedPreviousRun).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(created[0]).toMatchObject({
        status: "running",
        engine: "gateway_agent",
        contextProfile: "stable-2026.7",
        openclawVersion: "2026.7.1-2",
      });
    });

    it("reuses on a full match and clones only LLM cards, recomputing bootstrap cards", async () => {
      // A tiny per-file budget makes AGENTS.md (11 chars) truncate so a fresh
      // bootstrap card must be emitted on the reuse run.
      const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-reuse-managed-"));
      fs.writeFileSync(
        path.join(managedRoot, "openclaw.json"),
        JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 5, bootstrapTotalMaxChars: 60000 } } }),
        "utf8",
      );
      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
      const fingerprint = computeWorkspaceSnapshot(workspaceRoot).fingerprint;
      const inserts = [];
      const created = [];
      const doctorService = makeFixtureService({
        previousRun: makeMatchingRun(fingerprint),
        previousCards: [
          { title: "LLM finding", status: "open", source: "llm", sourceKey: "" },
          { title: "Legacy finding without source", status: "open" },
          {
            title: "Old bootstrap card",
            status: "open",
            source: "bootstrap",
            sourceKey: "boot:file_limit:AGENTS.md",
          },
          // Bridge cards read openclaw.json/CLI state outside the workspace
          // fingerprint: cloning them would freeze stale upstream findings.
          {
            title: "Stale upstream finding",
            status: "open",
            source: "openclaw_doctor",
            sourceKey: "ocd:core/doctor/gateway-config:openclaw.json",
          },
        ],
        workspaceRoot,
        managedRoot,
        getInstalledVersion: () => "2026.7.1-2",
        inserts,
        created,
      });

      const result = await doctorService.runDoctor();

      expect(result.reusedPreviousRun).toBe(true);
      expect(created[0]).toMatchObject({ engine: "deterministic_reuse" });
      // First insert: cloned LLM cards only (legacy source-less rows count as
      // LLM); bootstrap AND bridge cards are never cloned.
      expect(inserts[0].cards.map((card) => card.title)).toEqual([
        "LLM finding",
        "Legacy finding without source",
      ]);
      // Second insert: freshly recomputed bootstrap cards (no bridge runner
      // wired here → zero fresh bridge cards, and the stale one stays gone).
      expect(inserts[1].cards).toEqual([
        expect.objectContaining({
          source: "bootstrap",
          sourceKey: "boot:file_limit:AGENTS.md",
        }),
      ]);
    });

    it("suppresses sourced cards whose source key was previously dismissed", async () => {
      const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-reuse-dismiss-"));
      fs.writeFileSync(
        path.join(managedRoot, "openclaw.json"),
        JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 5 } } }),
        "utf8",
      );
      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
      const fingerprint = computeWorkspaceSnapshot(workspaceRoot).fingerprint;
      const inserts = [];
      const created = [];
      const doctorService = makeFixtureService({
        previousRun: makeMatchingRun(fingerprint),
        previousCards: [],
        allCards: [
          {
            title: "Old bootstrap card",
            status: "dismissed",
            source: "bootstrap",
            sourceKey: "boot:file_limit:AGENTS.md",
          },
        ],
        workspaceRoot,
        managedRoot,
        getInstalledVersion: () => "2026.7.1-2",
        inserts,
        created,
      });

      const result = await doctorService.runDoctor();

      expect(result.reusedPreviousRun).toBe(true);
      // Clone insert is empty and the dismissed bootstrap card is not re-emitted.
      expect(inserts.every((insert) => insert.cards.length === 0)).toBe(true);
    });

    it("selects the beta profile through the feature gates", async () => {
      const inserts = [];
      const created = [];
      const doctorService = makeFixtureService({
        previousRun: null,
        workspaceRoot,
        featureGates: { supportsFeature: (name) => name === "bootstrapContractV2" },
        getInstalledVersion: () => "2026.8.1-beta.3",
        inserts,
        created,
      });

      const status = doctorService.buildStatus();
      expect(status.bootstrapContext.profileId).toBe("beta-2026.8.1");

      await doctorService.runDoctor();
      await settleBackgroundRun();
      expect(created[0]).toMatchObject({
        contextProfile: "beta-2026.8.1",
        openclawVersion: "2026.8.1-beta.3",
      });
    });

    it("releases the busy guard when run creation throws after the snapshot", async () => {
      let shouldThrow = true;
      const { createDoctorService } = loadDoctorService();
      const service = createDoctorService({
        clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
        listDoctorRuns: () => [],
        listDoctorCards: () => [],
        createDoctorRun: () => {
          if (shouldThrow) {
            shouldThrow = false;
            throw new Error("db write failed");
          }
          return 7;
        },
        completeDoctorRun: vi.fn(),
        insertDoctorCards: vi.fn(),
        getDoctorRun: () => null,
        getDoctorCardsByRunId: () => [],
        getDoctorCard: () => null,
        updateDoctorCardStatus: () => null,
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: fastComputeSnapshotAsync,
      });

      await expect(service.runDoctor()).rejects.toThrow("db write failed");
      // The busy guard must not stay latched: the next run proceeds.
      const second = await service.runDoctor();
      await settleBackgroundRun();
      expect(second.ok).toBe(true);
      expect(second.alreadyRunning).toBeUndefined();
    });
  });

  describe("liveness integration (fail-fast, notifications, auto-run)", () => {
    let workspaceRoot;
    beforeEach(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-liveness-"));
      fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");
    });

    const settle = () => new Promise((resolve) => setImmediate(resolve));

    const makeService = ({
      readiness = { ok: true, reason: "" },
      notify = null,
      runDoctorLintJson = null,
      readAutoRunEnabled = null,
      autoRunTickMs = 999999,
      meta = new Map(),
      runsByIdCards = new Map(),
      summaries = [],
      llmCards = [],
      clawCmd = null,
      getReadiness = null,
      computeSnapshot = undefined,
      computeSnapshotAsync = fastComputeSnapshotAsync,
      listDismissedSourceKeys = null,
      readOpenclawConfig = null,
    } = {}) => {
      const { createDoctorService } = loadDoctorService();
      const created = [];
      const runs = new Map();
      const service = createDoctorService({
        clawCmd:
          clawCmd ||
          vi.fn(async () => ({
            ok: true,
            stdout: JSON.stringify({ summary: "done", cards: llmCards }),
          })),
        listDoctorRuns: () => summaries,
        listDoctorCards: () => [],
        createDoctorRun: (run) => {
          created.push(run);
          const id = 100 + created.length;
          runs.set(id, { id, status: "running", ...run });
          return id;
        },
        completeDoctorRun: ({ id, status, summary }) => {
          const run = runs.get(id) || { id };
          runs.set(id, { ...run, status, summary });
        },
        insertDoctorCards: ({ runId, cards }) => {
          runsByIdCards.set(runId, [...(runsByIdCards.get(runId) || []), ...cards]);
        },
        getDoctorRun: (id) => runs.get(Number(id)) || null,
        getDoctorCardsByRunId: (id) => runsByIdCards.get(Number(id)) || [],
        getDoctorCard: () => null,
        updateDoctorCardStatus: () => null,
        getInitialWorkspaceBaseline: () => null,
        setInitialWorkspaceBaseline: () => null,
        workspaceRoot,
        managedRoot: workspaceRoot,
        ...(computeSnapshot ? { computeSnapshot } : {}),
        computeSnapshotAsync,
        getGatewayReadiness: () => (getReadiness ? getReadiness() : readiness),
        notify,
        runDoctorLintJson,
        readAutoRunEnabled,
        autoRunTickMs,
        getDoctorMeta: (key) => (meta.has(key) ? { key, value: meta.get(key) } : null),
        setDoctorMeta: ({ key, value }) => {
          meta.set(key, value);
        },
        listDismissedSourceKeys,
        ...(readOpenclawConfig ? { readOpenclawConfig } : {}),
      });
      return { service, created, runsByIdCards, meta };
    };

    // A MISSING stored env signature now counts as changed (the post-upgrade
    // scan is due by design), so tests exercising the OTHER auto-run guards
    // must seed the live signature first. A throwaway service sharing `meta`
    // runs a fully-awaited fingerprint-reuse run: it writes
    // last_env_signature without arming the throttle or the failure backoff.
    const seedLiveEnvSignature = async (meta) => {
      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
      const nowIso = new Date().toISOString();
      const seeded = makeService({
        meta,
        summaries: [
          {
            id: 1,
            status: "completed",
            engine: "gateway_agent",
            workspaceFingerprint: computeWorkspaceSnapshot(workspaceRoot).fingerprint,
            promptVersion: "doctor-v2",
            contextProfile: "stable-2026.7",
            openclawVersion: "",
            completedAt: nowIso,
            startedAt: nowIso,
          },
        ],
      });
      const seededRun = await seeded.service.runDoctor();
      expect(seededRun.reusedPreviousRun).toBe(true);
      expect(meta.get("last_env_signature")).toBeTruthy();
    };

    it("fails fast with gatewayUnavailable on the LLM branch only", async () => {
      const { service, created } = makeService({
        readiness: { ok: false, reason: "gateway is unhealthy" },
      });
      const result = await service.runDoctor();
      expect(result).toMatchObject({
        ok: false,
        gatewayUnavailable: true,
        reason: "gateway is unhealthy",
      });
      // No running run was created.
      expect(created).toHaveLength(0);
    });

    it("still serves fingerprint reuse while the gateway is degraded", async () => {
      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
      const fingerprint = computeWorkspaceSnapshot(workspaceRoot).fingerprint;
      const { service } = makeService({
        readiness: { ok: false, reason: "gateway is unhealthy" },
        summaries: [
          {
            id: 1,
            status: "completed",
            workspaceFingerprint: fingerprint,
            promptVersion: "doctor-v2",
            contextProfile: "stable-2026.7",
            openclawVersion: "",
            completedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
          },
        ],
      });
      const result = await service.runDoctor();
      expect(result.reusedPreviousRun).toBe(true);
    });

    it("includes the main agent's budget overrides in the env signature", async () => {
      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
      const makeMatchingSummary = () => {
        const nowIso = new Date().toISOString();
        return {
          id: 1,
          status: "completed",
          engine: "gateway_agent",
          workspaceFingerprint: computeWorkspaceSnapshot(workspaceRoot).fingerprint,
          promptVersion: "doctor-v2",
          contextProfile: "stable-2026.7",
          openclawVersion: "",
          completedAt: nowIso,
          startedAt: nowIso,
        };
      };
      // A fully-awaited fingerprint-reuse run records the signature for the
      // given config; comparing recorded signatures across configs observes
      // buildEnvSignature without exporting it.
      const signatureFor = async (config) => {
        const meta = new Map();
        const { service } = makeService({
          meta,
          summaries: [makeMatchingSummary()],
          readOpenclawConfig: () => config,
        });
        const result = await service.runDoctor();
        expect(result.reusedPreviousRun).toBe(true);
        return meta.get("last_env_signature");
      };
      const configWith = (entries) => ({
        agents: {
          defaults: { bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 60000 },
          entries,
        },
      });

      const baseline = await signatureFor(
        configWith({
          main: { bootstrapMaxChars: 20000 },
          sidekick: { bootstrapMaxChars: 1000 },
        }),
      );
      // An unrelated agent's override never flips the signature.
      const unrelatedChange = await signatureFor(
        configWith({
          main: { bootstrapMaxChars: 20000 },
          sidekick: { bootstrapMaxChars: 5000 },
        }),
      );
      // The MAIN entry's override does: the analyzer honors it, so raising it
      // to fix a truncation must read as an environment change.
      const mainChange = await signatureFor(
        configWith({
          main: { bootstrapMaxChars: 30000 },
          sidekick: { bootstrapMaxChars: 1000 },
        }),
      );

      expect(baseline).toBeTruthy();
      expect(unrelatedChange).toBe(baseline);
      expect(mainChange).not.toBe(baseline);
    });

    it("rejects card fixes with a gatewayUnavailable error while degraded", async () => {
      const { createDoctorService } = loadDoctorService();
      const service = createDoctorService({
        clawCmd: vi.fn(),
        listDoctorRuns: () => [],
        listDoctorCards: () => [],
        createDoctorRun: () => 1,
        completeDoctorRun: vi.fn(),
        insertDoctorCards: vi.fn(),
        getDoctorRun: () => null,
        getDoctorCardsByRunId: () => [],
        getDoctorCard: () => ({ id: 5, fixPrompt: "fix it", status: "open" }),
        updateDoctorCardStatus: () => null,
        startDoctorCardFix: vi.fn(),
        cancelDoctorCardFix: vi.fn(),
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: fastComputeSnapshotAsync,
        getGatewayReadiness: () => ({ ok: false, reason: "safe mode" }),
      });
      await expect(
        service.requestCardFix({ cardId: 5, sessionKey: "agent:main:main" }),
      ).rejects.toMatchObject({ gatewayUnavailable: true, reason: "safe mode" });
    });

    it("completes the run when the bridge fails but merges bridge cards when it works", async () => {
      const failing = makeService({
        runDoctorLintJson: async () => {
          throw new Error("CLI missing");
        },
      });
      const failResult = await failing.service.runDoctor();
      await settle();
      const failRun = failing.service.getDoctorRun(failResult.runId);
      expect(failRun.status).toBe("completed");

      const working = makeService({
        runDoctorLintJson: async () => ({
          ok: false,
          code: 1,
          truncated: false,
          stdout: JSON.stringify({
            ok: false,
            findings: [
              { checkId: "core/doctor/gateway-config", severity: "error", message: "bad token" },
            ],
          }),
        }),
      });
      const okResult = await working.service.runDoctor();
      await settle();
      const cards = working.runsByIdCards.get(okResult.runId) || [];
      expect(
        cards.some((card) => card.sourceKey === "ocd:core/doctor/gateway-config:3331faf3e131"),
      ).toBe(true);
    });

    describe("bridge freshness on fingerprint reuse", () => {
      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");

      const makeReuseSummary = () => {
        const nowIso = new Date().toISOString();
        return {
          id: 1,
          status: "completed",
          engine: "gateway_agent",
          workspaceFingerprint: computeWorkspaceSnapshot(workspaceRoot).fingerprint,
          promptVersion: "doctor-v2",
          contextProfile: "stable-2026.7",
          openclawVersion: "",
          completedAt: nowIso,
          startedAt: nowIso,
        };
      };

      const staleBridgeCard = {
        title: "Stale upstream finding",
        status: "open",
        source: "openclaw_doctor",
        sourceKey: "ocd:core/doctor/stale-check:openclaw.json",
        priority: "P1",
      };
      const llmCard = {
        title: "Carried LLM finding",
        status: "open",
        source: "llm",
        sourceKey: "",
      };

      it("reruns the bridge fresh instead of cloning stale bridge cards", async () => {
        const runDoctorLintJson = vi.fn(async () => ({
          ok: false,
          code: 1,
          truncated: false,
          stdout: JSON.stringify({
            ok: false,
            findings: [
              { checkId: "core/doctor/gateway-config", severity: "error", message: "bad token" },
            ],
          }),
        }));
        const runsByIdCards = new Map([[1, [llmCard, staleBridgeCard]]]);
        const { service, created } = makeService({
          runDoctorLintJson,
          runsByIdCards,
          summaries: [makeReuseSummary()],
        });
        const result = await service.runDoctor();

        expect(result.reusedPreviousRun).toBe(true);
        expect(created[0]).toMatchObject({ engine: "deterministic_reuse" });
        // The bridge ran fresh on the reuse path.
        expect(runDoctorLintJson).toHaveBeenCalledTimes(1);
        const cards = runsByIdCards.get(result.runId) || [];
        // Cloned: the LLM card. Fresh: the new bridge finding. Gone: the
        // stale bridge card from the source run.
        expect(cards.map((card) => card.title)).toContain("Carried LLM finding");
        expect(
          cards.some(
            (card) => card.sourceKey === "ocd:core/doctor/gateway-config:3331faf3e131",
          ),
        ).toBe(true);
        expect(cards.map((card) => card.title)).not.toContain("Stale upstream finding");
      });

      it("still completes the reuse run when the bridge fails", async () => {
        const runDoctorLintJson = vi.fn(async () => {
          throw new Error("CLI missing");
        });
        const runsByIdCards = new Map([[1, [llmCard, staleBridgeCard]]]);
        const { service } = makeService({
          runDoctorLintJson,
          runsByIdCards,
          summaries: [makeReuseSummary()],
        });
        const result = await service.runDoctor();

        expect(result.ok).toBe(true);
        expect(result.reusedPreviousRun).toBe(true);
        expect(runDoctorLintJson).toHaveBeenCalledTimes(1);
        const cards = runsByIdCards.get(result.runId) || [];
        // Zero bridge cards (fail-soft), stale ones not resurrected, LLM
        // clone intact.
        expect(cards.some((card) => card.source === "openclaw_doctor")).toBe(false);
        expect(cards.map((card) => card.title)).toContain("Carried LLM finding");
        expect(service.getDoctorRun(result.runId).status).toBe("completed");
      });

      it("filters fresh reuse bridge cards through dismissed source keys", async () => {
        const listDismissedSourceKeys = vi.fn(() => [
          "ocd:core/doctor/gateway-config:openclaw.json",
        ]);
        const runDoctorLintJson = vi.fn(async () => ({
          ok: false,
          code: 1,
          truncated: false,
          stdout: JSON.stringify({
            ok: false,
            findings: [
              {
                checkId: "core/doctor/gateway-config",
                severity: "error",
                message: "bad token",
                path: "openclaw.json",
              },
            ],
          }),
        }));
        const runsByIdCards = new Map([[1, [llmCard]]]);
        const { service } = makeService({
          runDoctorLintJson,
          runsByIdCards,
          summaries: [makeReuseSummary()],
          listDismissedSourceKeys,
        });
        const result = await service.runDoctor();

        expect(result.reusedPreviousRun).toBe(true);
        // One dismissed-keys read shared by the sourced and bridge filters.
        expect(listDismissedSourceKeys).toHaveBeenCalledTimes(1);
        const cards = runsByIdCards.get(result.runId) || [];
        expect(cards.some((card) => card.source === "openclaw_doctor")).toBe(false);
      });

      it("holds the run latch across reuse enrichment: concurrent runs get alreadyRunning", async () => {
        let releaseBridge;
        const bridgeGate = new Promise((resolve) => {
          releaseBridge = resolve;
        });
        const runDoctorLintJson = vi.fn(async () => {
          await bridgeGate;
          return {
            ok: true,
            code: 0,
            truncated: false,
            stdout: JSON.stringify({ ok: true, findings: [] }),
          };
        });
        const runsByIdCards = new Map([[1, [llmCard]]]);
        const { service } = makeService({
          runDoctorLintJson,
          runsByIdCards,
          summaries: [makeReuseSummary()],
        });

        const firstRun = service.runDoctor();
        // Let the pre-run worker snapshot settle so the first run reaches the
        // reuse branch and takes the run latch (the bridge gate then holds it).
        await settle();
        // While the bridge is in flight, the reuse run must hold the busy
        // latch — not sit in the DB as an incomplete "completed" run a
        // concurrent runDoctor could reuse (starting a second bridge).
        const concurrent = await service.runDoctor();
        expect(concurrent.ok).toBe(false);
        expect(concurrent.alreadyRunning).toBe(true);
        expect(concurrent.error).toBe("Doctor run already in progress");
        expect(service.getDoctorRun(concurrent.runId).status).toBe("running");
        expect(concurrent.status.runInProgress).toBe(true);
        expect(runDoctorLintJson).toHaveBeenCalledTimes(1);

        releaseBridge();
        const result = await firstRun;
        expect(result.reusedPreviousRun).toBe(true);
        expect(result.runId).toBe(concurrent.runId);
        // Reported completed only once every card (clone + fresh) is in.
        expect(service.getDoctorRun(result.runId).status).toBe("completed");
        expect(result.status.runInProgress).toBe(false);
        const cards = runsByIdCards.get(result.runId) || [];
        expect(cards.map((card) => card.title)).toContain("Carried LLM finding");
      });
    });

    it("notifies once on new non-bridge P0s with a deterministic outbox id", async () => {
      const notify = vi.fn(() => Promise.resolve({ ok: true }));
      const meta = new Map();
      const { service } = makeService({
        notify,
        meta,
        llmCards: [
          {
            priority: "P0",
            category: "workspace state",
            title: "Dangerous drift",
            summary: "s",
            recommendation: "r",
            fixPrompt: "f",
            status: "open",
          },
        ],
      });
      const result = await service.runDoctor();
      await settle();
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, opts] = notify.mock.calls[0];
      expect(message).toContain("🐺 *AlphaClaw Watchdog*");
      expect(message).toContain("Drift Doctor found 1 new P0 finding");
      expect(message).toContain("Dangerous drift");
      expect(opts).toEqual({ id: `doctor-run-${result.runId}-p0` });
      expect(meta.get("last_notified_run_id")).toBe(result.runId);
    });

    it("does not notify for bridge-sourced P0s", async () => {
      const notify = vi.fn(() => Promise.resolve({ ok: true }));
      const { service } = makeService({
        notify,
        runDoctorLintJson: async () => ({
          ok: false,
          code: 1,
          truncated: false,
          stdout: JSON.stringify({
            ok: false,
            findings: [{ checkId: "x/y", severity: "error", message: "upstream boom" }],
          }),
        }),
      });
      await service.runDoctor();
      await settle();
      expect(notify).not.toHaveBeenCalled();
    });

    it("treats a P1→P0 escalation as new against the baseline", async () => {
      const notify = vi.fn(() => Promise.resolve({ ok: true }));
      const runsByIdCards = new Map();
      // Baseline run 50 carries the same title at P1.
      runsByIdCards.set(50, [
        { priority: "P1", title: "Dangerous drift", source: "llm", sourceKey: "" },
      ]);
      const { service } = makeService({
        notify,
        runsByIdCards,
        summaries: [
          {
            id: 50,
            status: "completed",
            engine: "gateway_agent",
            workspaceFingerprint: "other",
            promptVersion: "doctor-v2",
            contextProfile: "stable-2026.7",
            openclawVersion: "",
            completedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
          },
        ],
        llmCards: [
          {
            priority: "P0",
            category: "workspace state",
            title: "Dangerous drift",
            summary: "s",
            recommendation: "r",
            fixPrompt: "f",
            status: "open",
          },
        ],
      });
      await service.runDoctor();
      await settle();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("never uses an import run as the notification baseline", async () => {
      const notify = vi.fn(() => Promise.resolve({ ok: true }));
      const runsByIdCards = new Map();
      // The import run already saw this P0 — but imports are not baselines.
      runsByIdCards.set(60, [
        { priority: "P0", title: "Dangerous drift", source: "llm", sourceKey: "" },
      ]);
      const { service } = makeService({
        notify,
        runsByIdCards,
        summaries: [
          {
            id: 60,
            status: "completed",
            engine: "manual_import",
            workspaceFingerprint: "other",
            promptVersion: "doctor-v2",
            contextProfile: "stable-2026.7",
            openclawVersion: "",
            completedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
          },
        ],
        llmCards: [
          {
            priority: "P0",
            category: "workspace state",
            title: "Dangerous drift",
            summary: "s",
            recommendation: "r",
            fixPrompt: "f",
            status: "open",
          },
        ],
      });
      await service.runDoctor();
      await settle();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("skips the auto-run tick for every guard reason and runs when triggered", async () => {
      vi.useFakeTimers();
      try {
        const notify = vi.fn(() => Promise.resolve({ ok: true }));
        const meta = new Map();
        let autoRunEnabled = false;
        // A stale completed baseline run: needsInitialRun is false, so the
        // fresh-install trigger stays out of this guard-reason matrix.
        const staleIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        const { service } = makeService({
          notify,
          meta,
          readAutoRunEnabled: () => autoRunEnabled,
          autoRunTickMs: 1000,
          summaries: [
            {
              id: 1,
              status: "completed",
              engine: "gateway_agent",
              workspaceFingerprint: "stale-baseline",
              promptVersion: "doctor-v2",
              contextProfile: "stable-2026.7",
              openclawVersion: "",
              completedAt: staleIso,
              startedAt: staleIso,
            },
          ],
        });
        // Disabled → skip.
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        expect(service.buildStatus().autoRun.lastSkipReason).toBe("disabled");

        // Enabled but nothing changed → stale run with no readable baseline
        // manifest → meaningful changes false → "no-meaningful-change".
        // (Seed the matching signature first: a MISSING one now schedules
        // the post-upgrade scan by design — covered by its own test below.)
        await seedLiveEnvSignature(meta);
        autoRunEnabled = true;
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        expect(service.buildStatus().autoRun.lastSkipReason).toBe("no-meaningful-change");

        // Environment signature change → triggers a run.
        meta.set("last_env_signature", "different-signature");
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        // Let the dispatched run settle on real microtasks.
        await vi.runOnlyPendingTimersAsync();
        expect(meta.get("last_auto_run")?.outcome).toBe("ran");
        // Completion notification for the scheduled run.
        expect(
          notify.mock.calls.some(([message]) =>
            message.includes("Scheduled Drift Doctor scan finished"),
          ),
        ).toBe(true);

        // Immediately after: throttled by the 6h minimum interval.
        meta.set("last_env_signature", "another-signature");
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        expect(service.buildStatus().autoRun.lastSkipReason).toBe("throttled");

        service.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("backs off after a failed auto-run until inputs change", async () => {
      vi.useFakeTimers();
      try {
        const meta = new Map();
        meta.set("last_env_signature", "changed");
        // A last auto-run that failed 7h ago with the CURRENT signature: the
        // 6h throttle has passed but the 24h failure backoff holds.
        const { service } = makeService({
          readAutoRunEnabled: () => true,
          autoRunTickMs: 1000,
          readiness: { ok: true, reason: "" },
          meta,
        });
        // Compute the live signature by triggering one tick first (record it).
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        await vi.runOnlyPendingTimersAsync();
        const recorded = meta.get("last_auto_run");
        expect(recorded?.outcome).toBe("ran");
        // Rewrite history: same signature, failed, 7h ago.
        meta.set("last_auto_run", {
          at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
          outcome: "failed",
          envSignature: recorded.envSignature,
        });
        meta.set("last_env_signature", "changed-again");
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        expect(service.buildStatus().autoRun.lastSkipReason).toBe("backoff");
        service.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("holds the failure backoff on an unchanged fingerprint and lifts it when the workspace changes", async () => {
      vi.useFakeTimers();
      try {
        const meta = new Map();
        const { service } = makeService({
          readAutoRunEnabled: () => true,
          autoRunTickMs: 1000,
          meta,
        });
        // Tick 1 (fresh install → needsInitialRun): runs and records the
        // marker WITH the workspace fingerprint the run consumed.
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        await vi.runOnlyPendingTimersAsync();
        const recorded = meta.get("last_auto_run");
        expect(recorded?.outcome).toBe("ran");
        expect(recorded?.workspaceFingerprint).toBeTruthy();

        // Rewrite history: failed 7h ago (6h throttle passed, 24h backoff
        // not), SAME signature and SAME fingerprint → the backoff holds even
        // though the envChanged trigger is armed.
        meta.set("last_env_signature", "different-signature");
        const failedMarker = {
          at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
          outcome: "failed",
          envSignature: recorded.envSignature,
          workspaceFingerprint: recorded.workspaceFingerprint,
        };
        meta.set("last_auto_run", failedMarker);
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        expect(service.buildStatus().autoRun.lastSkipReason).toBe("backoff");
        // The backoff skip never rewrites the marker.
        expect(meta.get("last_auto_run")).toEqual(failedMarker);

        // The workspace no longer matches what the failed run saw: the
        // backoff lifts and the tick proceeds (subject to the other guards).
        meta.set("last_auto_run", {
          ...failedMarker,
          workspaceFingerprint: "fingerprint-before-the-workspace-edit",
        });
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        await vi.runOnlyPendingTimersAsync();
        expect(meta.get("last_auto_run")?.outcome).toBe("ran");
        service.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips the tick as busy while a manual run is in flight, without touching the throttle", async () => {
      vi.useFakeTimers();
      try {
        const meta = new Map();
        let releaseLlm;
        const hangingClawCmd = vi.fn(
          () =>
            new Promise((resolve) => {
              releaseLlm = () =>
                resolve({
                  ok: true,
                  stdout: JSON.stringify({ summary: "done", cards: [] }),
                });
            }),
        );
        const { service } = makeService({
          readAutoRunEnabled: () => true,
          autoRunTickMs: 1000,
          meta,
          clawCmd: hangingClawCmd,
        });
        meta.set("last_env_signature", "different-signature");
        // Manual run dispatches synchronously (busy latch set before any await).
        const manualRun = service.runDoctor();
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        expect(service.buildStatus().autoRun.lastSkipReason).toBe("busy");
        // The busy skip never arms the throttle or the failure backoff.
        expect(meta.get("last_auto_run")).toBeUndefined();
        releaseLlm();
        await manualRun;
        await vi.runOnlyPendingTimersAsync();
        service.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("restores the throttle marker when the gateway flips between pre-check and dispatch", async () => {
      vi.useFakeTimers();
      try {
        const meta = new Map();
        const staleMarker = {
          at: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
          outcome: "ran",
          envSignature: "old-signature",
        };
        meta.set("last_auto_run", staleMarker);
        meta.set("last_env_signature", "different-signature");
        let flipArmed = true;
        const { service } = makeService({
          readAutoRunEnabled: () => true,
          autoRunTickMs: 1000,
          meta,
          // Degraded ONLY once the tick has committed to dispatch (it writes
          // the "started" marker immediately before calling runDoctor): the
          // tick's own pre-check and status build both see a ready gateway,
          // and runDoctor's internal readiness check sees the flip.
          getReadiness: () => {
            if (flipArmed && meta.get("last_auto_run")?.outcome === "started") {
              return { ok: false, reason: "flipped mid-dispatch" };
            }
            return { ok: true, reason: "" };
          },
        });
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        await vi.runOnlyPendingTimersAsync();
        // Benign non-dispatch: nothing auto-ran, so the previous marker is
        // restored verbatim — the throttle slot is not burned and the failure
        // backoff is not armed.
        expect(service.buildStatus().autoRun.lastSkipReason).toBe("gateway-degraded");
        expect(meta.get("last_auto_run")).toEqual(staleMarker);
        // With the flip gone, the very next tick dispatches for real.
        flipArmed = false;
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        await vi.runOnlyPendingTimersAsync();
        expect(meta.get("last_auto_run")?.outcome).toBe("ran");
        service.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("dispatches the first scheduled run on a fresh install with healthy hardening", async () => {
      vi.useFakeTimers();
      try {
        // No completed runs, no stored env signature, healthy hardening: only
        // the needsInitialRun trigger can fire — and it must.
        const meta = new Map();
        const { service, created } = makeService({
          readAutoRunEnabled: () => true,
          autoRunTickMs: 1000,
          meta,
        });
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        await vi.runOnlyPendingTimersAsync();
        expect(meta.get("last_auto_run")?.outcome).toBe("ran");
        expect(created).toHaveLength(1);
        service.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats a missing stored env signature as changed and schedules the post-upgrade scan", async () => {
      vi.useFakeTimers();
      try {
        // An existing install: completed doctor runs from before env-signature
        // tracking shipped (no stored signature), a fresh (non-stale) matching
        // baseline, healthy hardening, needsInitialRun false. No other trigger
        // can fire — the missing signature alone must schedule the scan.
        const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");
        const nowIso = new Date().toISOString();
        const meta = new Map();
        const { service, created } = makeService({
          readAutoRunEnabled: () => true,
          autoRunTickMs: 1000,
          meta,
          summaries: [
            {
              id: 1,
              status: "completed",
              engine: "gateway_agent",
              workspaceFingerprint: computeWorkspaceSnapshot(workspaceRoot).fingerprint,
              promptVersion: "doctor-v2",
              contextProfile: "stable-2026.7",
              openclawVersion: "",
              completedAt: nowIso,
              startedAt: nowIso,
            },
          ],
        });
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        await vi.runOnlyPendingTimersAsync();
        expect(meta.get("last_auto_run")?.outcome).toBe("ran");
        // Zero workspace delta → the post-upgrade scan is a fingerprint reuse.
        expect(created[0]).toMatchObject({ engine: "deterministic_reuse" });
        // The run recorded the signature: the next tick skips as unchanged.
        expect(meta.get("last_env_signature")).toBeTruthy();
        service.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("refreshes the workspace snapshot on the worker before a scheduled run, never synchronously", async () => {
      vi.useFakeTimers();
      try {
        const meta = new Map();
        // Any sync walk from the tick path fails the test loudly.
        const computeSnapshotSpy = vi.fn(() => {
          throw new Error("sync snapshot compute called from the auto-run tick");
        });
        const computeSnapshotAsyncSpy = vi.fn(fastComputeSnapshotAsync);
        const { service } = makeService({
          readAutoRunEnabled: () => true,
          autoRunTickMs: 1000,
          meta,
          computeSnapshot: computeSnapshotSpy,
          computeSnapshotAsync: computeSnapshotAsyncSpy,
        });
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        await vi.runOnlyPendingTimersAsync();
        expect(meta.get("last_auto_run")?.outcome).toBe("ran");
        expect(computeSnapshotAsyncSpy).toHaveBeenCalled();
        expect(computeSnapshotSpy).not.toHaveBeenCalled();
        service.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    describe("hardening trigger for scheduled scans", () => {
      const { computeWorkspaceSnapshot } = require("../../lib/server/doctor/workspace-fingerprint");

      const seedHardeningBreakage = (kind) => {
        if (kind === "blocked") {
          // Merged hardening file on disk with no config entry → "blocked".
          fs.mkdirSync(path.join(workspaceRoot, "hooks", "bootstrap"), { recursive: true });
          fs.writeFileSync(
            path.join(workspaceRoot, "hooks", "bootstrap", "AGENTS.md"),
            "# Hardening\n",
            "utf8",
          );
        } else {
          // AGENTS.md over the per-file cap → active truncation.
          fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), repeatText(20001), "utf8");
        }
      };

      // Latest completed run matches the CURRENT fingerprint: zero workspace
      // delta, not stale, needsInitialRun false — only hardeningNew can fire.
      const makeMatchingSummary = () => {
        const nowIso = new Date().toISOString();
        return {
          id: 1,
          status: "completed",
          engine: "gateway_agent",
          workspaceFingerprint: computeWorkspaceSnapshot(workspaceRoot).fingerprint,
          promptVersion: "doctor-v2",
          contextProfile: "stable-2026.7",
          openclawVersion: "",
          completedAt: nowIso,
          startedAt: nowIso,
        };
      };

      it.each(["blocked", "truncation"])(
        "triggers a run when hardening is %s with zero workspace delta",
        async (kind) => {
          vi.useFakeTimers();
          try {
            seedHardeningBreakage(kind);
            const meta = new Map();
            // Seed the matching env signature so hardeningNew — not the
            // missing-signature (post-upgrade) trigger — is what fires.
            await seedLiveEnvSignature(meta);
            const { service, created } = makeService({
              readAutoRunEnabled: () => true,
              autoRunTickMs: 1000,
              meta,
              summaries: [makeMatchingSummary()],
            });
            await vi.advanceTimersByTimeAsync(1100 + 60000);
            await vi.runOnlyPendingTimersAsync();
            expect(meta.get("last_auto_run")?.outcome).toBe("ran");
            // Zero delta → the dispatched run is a fingerprint reuse.
            expect(created[0]).toMatchObject({ engine: "deterministic_reuse" });
            service.dispose();
          } finally {
            vi.useRealTimers();
          }
        },
      );

      it("suppresses the trigger when the latest run already reported the condition", async () => {
        vi.useFakeTimers();
        try {
          seedHardeningBreakage("blocked");
          const meta = new Map();
          // Matching signature: only the hardening-trigger suppression is
          // under test, not the missing-signature (post-upgrade) trigger.
          await seedLiveEnvSignature(meta);
          const runsByIdCards = new Map([
            [1, [{ priority: "P0", status: "open", source: "deterministic", sourceKey: "det:hardening:blocked" }]],
          ]);
          const { service, created } = makeService({
            readAutoRunEnabled: () => true,
            autoRunTickMs: 1000,
            meta,
            runsByIdCards,
            summaries: [makeMatchingSummary()],
          });
          await vi.advanceTimersByTimeAsync(1100 + 60000);
          expect(service.buildStatus().autoRun.lastSkipReason).toBe("not-stale");
          expect(meta.get("last_auto_run")).toBeUndefined();
          expect(created).toHaveLength(0);
          service.dispose();
        } finally {
          vi.useRealTimers();
        }
      });

      it("suppresses the trigger when the condition's own source key was dismissed", async () => {
        vi.useFakeTimers();
        try {
          // AGENTS.md over the per-file cap: the truncation card it would
          // carry is exactly boot:file_limit:AGENTS.md.
          seedHardeningBreakage("truncation");
          const meta = new Map();
          // Matching signature: only the dismissed-key suppression is under
          // test, not the missing-signature (post-upgrade) trigger.
          await seedLiveEnvSignature(meta);
          const { service, created } = makeService({
            readAutoRunEnabled: () => true,
            autoRunTickMs: 1000,
            meta,
            summaries: [makeMatchingSummary()],
            listDismissedSourceKeys: () => ["boot:file_limit:AGENTS.md"],
          });
          await vi.advanceTimersByTimeAsync(1100 + 60000);
          expect(service.buildStatus().autoRun.lastSkipReason).toBe("not-stale");
          expect(meta.get("last_auto_run")).toBeUndefined();
          expect(created).toHaveLength(0);
          service.dispose();
        } finally {
          vi.useRealTimers();
        }
      });

      it("does not let an unrelated dismissed boot: key suppress a new blocked state", async () => {
        vi.useFakeTimers();
        try {
          // A once-dismissed boot:file_limit:USER.md card (condition long
          // gone) must not disable the trigger for a NEW hardening-blocked
          // state — the candidate keys come from the current condition only.
          seedHardeningBreakage("blocked");
          const meta = new Map();
          // Matching signature: hardeningNew must be the trigger that fires,
          // not the missing-signature (post-upgrade) trigger.
          await seedLiveEnvSignature(meta);
          const { service, created } = makeService({
            readAutoRunEnabled: () => true,
            autoRunTickMs: 1000,
            meta,
            summaries: [makeMatchingSummary()],
            listDismissedSourceKeys: () => ["boot:file_limit:USER.md"],
          });
          await vi.advanceTimersByTimeAsync(1100 + 60000);
          await vi.runOnlyPendingTimersAsync();
          expect(meta.get("last_auto_run")?.outcome).toBe("ran");
          expect(created[0]).toMatchObject({ engine: "deterministic_reuse" });
          service.dispose();
        } finally {
          vi.useRealTimers();
        }
      });

      it("does not fire the hardening trigger when the config is unreadable", async () => {
        vi.useFakeTimers();
        try {
          // Merged hardening file on disk PLUS an openclaw.json our parser
          // cannot read: hardening reads "unknown" (config_unreadable), which
          // must not count as blocked and must not schedule a scan.
          seedHardeningBreakage("blocked");
          fs.writeFileSync(
            path.join(workspaceRoot, "openclaw.json"),
            "{ hooks: { /* json5 */ } }",
            "utf8",
          );
          const meta = new Map();
          // Matching signature: only the unreadable-config suppression is
          // under test, not the missing-signature (post-upgrade) trigger.
          await seedLiveEnvSignature(meta);
          const { service, created } = makeService({
            readAutoRunEnabled: () => true,
            autoRunTickMs: 1000,
            meta,
            summaries: [makeMatchingSummary()],
            readOpenclawConfig: () => null,
          });
          expect(service.buildStatus().bootstrapContext.hardening).toMatchObject({
            state: "unknown",
            reason: "config_unreadable",
          });
          await vi.advanceTimersByTimeAsync(1100 + 60000);
          expect(service.buildStatus().autoRun.lastSkipReason).toBe("not-stale");
          expect(meta.get("last_auto_run")).toBeUndefined();
          expect(created).toHaveLength(0);
          service.dispose();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("never re-notifies when last_notified_run_id is at or past the new run (crash replay)", async () => {
      const notify = vi.fn(() => Promise.resolve({ ok: true }));
      const meta = new Map();
      // makeService run ids start at 101; 999 simulates a replayed marker.
      meta.set("last_notified_run_id", 999);
      const { service } = makeService({
        notify,
        meta,
        llmCards: [
          {
            priority: "P0",
            category: "workspace state",
            title: "Dangerous drift",
            summary: "s",
            recommendation: "r",
            fixPrompt: "f",
            status: "open",
          },
        ],
      });
      const result = await service.runDoctor();
      await settle();
      expect(result.ok).toBe(true);
      expect(notify).not.toHaveBeenCalled();
      expect(meta.get("last_notified_run_id")).toBe(999);
    });

    it("reads dismissed source keys once per run", async () => {
      const listDismissedSourceKeys = vi.fn(() => []);
      const { service } = makeService({
        listDismissedSourceKeys,
        // Bridge cards force the second (bridge) dismissal filter too.
        runDoctorLintJson: async () => ({
          ok: false,
          code: 1,
          truncated: false,
          stdout: JSON.stringify({
            ok: false,
            findings: [{ checkId: "x/y", severity: "info", message: "m" }],
          }),
        }),
      });
      await service.runDoctor();
      await settle();
      expect(listDismissedSourceKeys).toHaveBeenCalledTimes(1);
    });

    it("survives a throwing tick and clears the interval on dispose", async () => {
      vi.useFakeTimers();
      try {
        const { service } = makeService({
          readAutoRunEnabled: () => {
            throw new Error("config exploded");
          },
          autoRunTickMs: 1000,
        });
        await vi.advanceTimersByTimeAsync(1100 + 60000);
        // readAutoRunEnabledSafe catches → "disabled", not "error".
        expect(service.buildStatus().autoRun.lastSkipReason).toBe("disabled");
        service.dispose();
        const before = service.buildStatus().autoRun.lastCheckAt;
        await vi.advanceTimersByTimeAsync(5000 + 120000);
        expect(service.buildStatus().autoRun.lastCheckAt).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });

    it("exposes gateway readiness and auto-run state on the status payload", () => {
      const { service } = makeService({
        readiness: { ok: false, reason: "crash loop" },
        readAutoRunEnabled: () => true,
      });
      const status = service.buildStatus();
      expect(status.gatewayReadiness).toEqual({ ok: false, reason: "crash loop" });
      expect(status.autoRun).toMatchObject({ enabled: true });
      service.dispose();
    });
  });
});

// H6: evidence snippet paths come from untrusted AI/import output. They must be
// realpath-contained to the workspace, and must be regular files read only
// within the scan bound (no traversal, no symlink escape, no FIFO/huge-file
// DoS).
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
      // Past the 8 MiB scan bound: the cited window (line 2 runs to EOF)
      // cannot be completed within kSnippetScanMaxBytes, so the bounded
      // reader must give up (null) instead of slurping the whole file.
      fs.ftruncateSync(fd, 9 * 1024 * 1024);
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

describe("server/doctor-service review-batch regressions", () => {
  afterEach(() => {
    if (currentDoctorDb?.closeDoctorDb) {
      currentDoctorDb.closeDoctorDb();
      currentDoctorDb = null;
    }
  });

  const makeMinimalService = (overrides = {}) => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-review-batch-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-review-batch-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");
    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });
    const { createDoctorService } = loadDoctorService();
    const service = createDoctorService({
      clawCmd: vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ summary: "clean", cards: [] }),
        stderr: "",
      })),
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
      computeSnapshotAsync: fastComputeSnapshotAsync,
      workspaceRoot,
      managedRoot: workspaceRoot,
      alphaclawRootDir: "/data",
      ...overrides,
    });
    return { service, doctorDb, workspaceRoot };
  };

  it("clears runStartPending when BOTH snapshot paths fail (latch never wedges)", async () => {
    const { service } = makeMinimalService({
      computeSnapshotAsync: vi.fn(async () => {
        throw new Error("worker down");
      }),
      computeSnapshot: vi.fn(() => {
        throw new Error("Workspace root is not readable: /gone");
      }),
    });

    await expect(service.runDoctor()).rejects.toThrow(/not readable/);
    // A wedged runStartPending would report alreadyRunning (runId 0) forever.
    await expect(service.runDoctor()).rejects.toThrow(/not readable/);
  });

  it("sanitizes forged client reply fields before logging the mismatch warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { service, doctorDb } = makeMinimalService();
      const imported = await service.importDoctorResult({
        rawOutput: JSON.stringify({
          summary: "One finding",
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
        }),
      });
      const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);

      const forged = "9999\n[doctor] forged log line" + "A".repeat(300);
      await service.requestCardFix({
        cardId: card.id,
        sessionKey: "agent:main:telegram:direct:1050",
        replyChannel: "telegram",
        replyTo: forged,
        prompt: "Fix.",
      });

      const mismatchLine = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("differs from server-derived"));
      expect(mismatchLine).toBeTruthy();
      expect(mismatchLine).not.toContain("\n");
      expect(mismatchLine).not.toContain("forged log line" + "A".repeat(200));
      // Capped at 120 chars per field.
      expect(mismatchLine.length).toBeLessThan(500);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns once (and only once) when session-target validation is not wired", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { service, doctorDb } = makeMinimalService();
      const imported = await service.importDoctorResult({
        rawOutput: JSON.stringify({
          summary: "s",
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
        }),
      });
      const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);
      await service.requestCardFix({ cardId: card.id, sessionKey: "agent:main:main", prompt: "x" });
      doctorDb.updateDoctorCardStatus({ id: card.id, status: "open" });
      await service.requestCardFix({ cardId: card.id, sessionKey: "agent:main:main", prompt: "x" });

      const skipWarns = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("findSendableSession not wired"));
      expect(skipWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("server/doctor-service dispatch byte budget (red-team RT3)", () => {
  afterEach(() => {
    if (currentDoctorDb?.closeDoctorDb) {
      currentDoctorDb.closeDoctorDb();
      currentDoctorDb = null;
    }
  });

  it("rejects an oversized FINAL payload before the card flips (covers the fixPrompt fallback)", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bytecap-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bytecap-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# G\n", "utf8");
    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });
    const clawCmd = vi.fn(async () => ({ ok: true, stdout: "{}", stderr: "" }));
    const { createDoctorService } = loadDoctorService();
    const service = createDoctorService({
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
      computeSnapshotAsync: fastComputeSnapshotAsync,
      workspaceRoot,
      managedRoot: workspaceRoot,
      alphaclawRootDir: "/data",
    });
    // The oversized prompt arrives via the CARD's fixPrompt (the route's
    // char pre-filter never sees this path) — multi-byte chars make the
    // byte length ~3x the char length.
    const imported = await service.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "s",
        cards: [
          {
            priority: "P1",
            category: "guidance",
            title: "t",
            summary: "s",
            recommendation: "r",
            fixPrompt: "…".repeat(60000),
            status: "open",
          },
        ],
      }),
    });
    const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);

    await expect(
      service.requestCardFix({ cardId: card.id, sessionKey: "agent:main:main" }),
    ).rejects.toMatchObject({ promptTooLarge: true });
    // Rejected BEFORE any state change: card still open, nothing dispatched.
    expect(doctorDb.getDoctorCard(card.id).status).toBe("open");
    expect(clawCmd).not.toHaveBeenCalled();
  });
});

describe("server/doctor-service run-path snapshot freshness (adversarial finding 2)", () => {
  afterEach(() => {
    if (currentDoctorDb?.closeDoctorDb) {
      currentDoctorDb.closeDoctorDb();
      currentDoctorDb = null;
    }
  });

  it("re-scans when the run joins a walk that began before the run was requested", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-joined-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-joined-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# G\n", "utf8");
    const doctorDb = loadManagedDoctorDb();
    doctorDb.initDoctorDb({ rootDir: dbRoot });

    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const computeSnapshotAsync = vi.fn(async (root, opts) => {
      if (computeSnapshotAsync.mock.calls.length === 1) await firstGate;
      return computeWorkspaceSnapshotBounded(root, { ...(opts || {}), batchPauseMs: 0 });
    });
    const { createDoctorService } = loadDoctorService();
    const service = createDoctorService({
      clawCmd: vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ summary: "clean", cards: [] }),
        stderr: "",
      })),
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

    // A background refresh (status polling) starts BEFORE the user's change…
    const backgroundRefresh = service.refreshWorkspaceSnapshot();
    // …the user edits a file, then explicitly runs the doctor.
    fs.writeFileSync(path.join(workspaceRoot, "NEW.md"), "changed after walk began\n");
    const runPromise = service.runDoctor();
    releaseFirst();
    await backgroundRefresh;
    const result = await runPromise;

    expect(result.ok).toBe(true);
    // The run must NOT trust the joined pre-request walk: a second scan runs.
    expect(computeSnapshotAsync.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The persisted run fingerprints the post-change workspace.
    const run = doctorDb.getDoctorRun(result.runId);
    expect(Object.keys(run.workspaceManifest)).toContain("NEW.md");
  });
});
