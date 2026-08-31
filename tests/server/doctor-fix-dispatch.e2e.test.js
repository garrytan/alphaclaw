// Wired-stack e2e for the seam no other suite covers: the session list a
// real operator picks from (REAL system routes) feeding the Doctor fix
// dispatch (REAL doctor routes + REAL createDoctorService + REAL SQLite DB +
// REAL canonical parser + REAL session validation), with only the OpenClaw
// CLI faked. This is the regression test for the "Ask Agent to Fix queued
// but never arrived in the DM" bug: before the canonical-parser fix, the
// account-scoped/suffixed/discord rows below carried EMPTY reply targets end
// to end and delivery was silently dropped while the client saw a 202.
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerSystemRoutes } = require("../../lib/server/routes/system");
const { registerDoctorRoutes } = require("../../lib/server/routes/doctor");
const {
  createSendableSessionLookup,
} = require("../../lib/server/utils/agent-session-lookup");
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

// Fast fake worker: computes snapshots in-process without batch pauses.
const fastComputeSnapshotAsync = (root, opts) =>
  computeWorkspaceSnapshotBounded(root, { ...(opts || {}), batchPauseMs: 0 });

const kSessionsPayload = {
  sessions: [
    { key: "agent:main:main", sessionId: "main-session", updatedAt: 10 },
    {
      key: "agent:main:telegram:default:direct:1050",
      sessionId: "account-direct-session",
      updatedAt: 9,
    },
    {
      key: "agent:main:telegram:direct:2020:heartbeat",
      sessionId: "suffixed-direct-session",
      updatedAt: 8,
    },
    {
      key: "agent:main:discord:direct:99",
      sessionId: "discord-direct-session",
      updatedAt: 7,
    },
  ],
};

// Minimal-but-real system deps: only what GET /api/agent/sessions touches
// does real work; everything else is an inert stub (routes-system pattern).
const createSystemDeps = (clawCmd) => ({
  fs: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("no config");
    }),
    statSync: vi.fn(() => ({ mtimeMs: 1, size: 1 })),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
  readEnvFile: vi.fn(() => []),
  writeEnvFile: vi.fn(),
  reloadEnv: vi.fn(() => true),
  kKnownVars: [],
  kKnownKeys: new Set(),
  kSystemVars: new Set(),
  syncChannelConfig: vi.fn(),
  isGatewayRunning: vi.fn(async () => true),
  isOnboarded: vi.fn(() => true),
  getChannelStatus: vi.fn(() => ({})),
  openclawVersionService: {
    readOpenclawVersion: vi.fn(() => "1.0.0"),
    getVersionStatus: vi.fn(async () => ({ ok: true })),
    updateOpenclaw: vi.fn(async () => ({ status: 200, body: { ok: true } })),
  },
  alphaclawVersionService: {
    readAlphaclawVersion: vi.fn(() => "0.0.0"),
    getVersionStatus: vi.fn(async () => ({ ok: true })),
    updateAlphaclaw: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    restartProcess: vi.fn(),
  },
  clawCmd,
  restartGateway: vi.fn(),
  restartRequiredState: {
    markRequired: vi.fn(),
    getSnapshot: vi.fn(async () => ({})),
    markRestartInProgress: vi.fn(),
    clearRequired: vi.fn(),
    markRestartComplete: vi.fn(),
  },
  topicRegistry: { getGroup: vi.fn(() => null) },
  authProfiles: {
    listApiKeyProviders: vi.fn(() => []),
    getEnvVarForApiKeyProvider: vi.fn(() => ""),
    upsertApiKeyProfileForEnvVar: vi.fn(),
    removeApiKeyProfileForEnvVar: vi.fn(),
  },
  OPENCLAW_DIR: "/tmp/openclaw-e2e",
  ensureGatewayProxyConfig: vi.fn(() => false),
  getBaseUrl: vi.fn(() => "https://setup.example.com"),
  kAlphaclawGithubReleasesBaseUrl: "https://api.github.com/repos/x/y/releases",
});

let currentDoctorDb = null;

describe("e2e: doctor fix dispatch delivers to the selected session", () => {
  afterEach(() => {
    if (currentDoctorDb?.closeDoctorDb) {
      currentDoctorDb.closeDoctorDb();
      currentDoctorDb = null;
    }
  });

  const buildStack = async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-e2e-ws-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-e2e-db-"));
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");

    const clawCmd = vi.fn(async (command) => {
      if (command === "sessions --json --all-agents") {
        return { ok: true, stdout: JSON.stringify(kSessionsPayload) };
      }
      return {
        ok: true,
        stdout: JSON.stringify({ status: "accepted", runId: "gateway-run" }),
        stderr: "",
      };
    });

    const doctorDb = loadDoctorDb();
    currentDoctorDb = doctorDb;
    doctorDb.initDoctorDb({ rootDir: dbRoot });

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
      setDoctorCardFixDelivery: doctorDb.setDoctorCardFixDelivery,
      findSendableSession: createSendableSessionLookup({ clawCmd }),
      workspaceRoot,
      managedRoot: workspaceRoot,
      alphaclawRootDir: "/data",
      computeSnapshotAsync: fastComputeSnapshotAsync,
    });

    const app = express();
    app.use(express.json());
    registerSystemRoutes({ app, ...createSystemDeps(clawCmd), doctorService });
    registerDoctorRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      doctorService,
    });

    const imported = await doctorService.importDoctorResult({
      rawOutput: JSON.stringify({
        summary: "One finding",
        cards: [
          {
            priority: "P1",
            category: "guidance",
            title: "Fix guidance drift",
            summary: "Stale guidance",
            recommendation: "Update it",
            evidence: [],
            targetPaths: ["AGENTS.md"],
            fixPrompt: "Update the stale guidance.",
            status: "open",
          },
        ],
      }),
    });
    const [card] = doctorDb.getDoctorCardsByRunId(imported.runId);
    return { app, clawCmd, doctorDb, card };
  };

  const findDispatchCommand = (clawCmd) =>
    clawCmd.mock.calls
      .map(([command]) => command)
      .find((command) => String(command).includes("gateway call agent"));

  it("journey: picked DM row → dispatch carries deliver:true with the server-derived target", async () => {
    const { app, clawCmd, doctorDb, card } = await buildStack();

    // 1. The operator's picker: rows come from the REAL sessions route.
    const sessionsRes = await request(app).get("/api/agent/sessions");
    expect(sessionsRes.status).toBe(200);
    const accountRow = sessionsRes.body.sessions.find(
      (row) => row.key === "agent:main:telegram:default:direct:1050",
    );
    // Fails before the canonical-parser fix: empty replyChannel/replyTo.
    expect(accountRow).toMatchObject({
      replyChannel: "telegram",
      replyTo: "1050",
      replyAccountId: "default",
      deliverable: true,
    });

    // 2. The fix request the modal sends: the picked row's fields verbatim.
    const fixRes = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({
        sessionKey: accountRow.key,
        replyChannel: accountRow.replyChannel,
        replyTo: accountRow.replyTo,
        prompt: "Apply the safe fix.",
      });
    expect(fixRes.status).toBe(202);
    expect(fixRes.body.ok).toBe(true);
    expect(fixRes.body.delivery).toEqual({
      attached: true,
      replyChannel: "telegram",
      replyTo: "1050",
      replyAccountId: "default",
    });

    // 3. The gateway dispatch: server-derived delivery params attached.
    const command = findDispatchCommand(clawCmd);
    expect(command).toContain("gateway call agent --json");
    expect(command).toContain(
      '"sessionKey":"agent:main:telegram:default:direct:1050"',
    );
    expect(command).toContain('"deliver":true');
    expect(command).toContain('"replyChannel":"telegram"');
    expect(command).toContain('"replyTo":"1050"');
    expect(command).toContain('"replyAccountId":"default"');
    expect(command).not.toContain('"agentId"');
    expect(command).not.toContain('"sessionId"');
    expect(command).toContain("AlphaClaw completion callback:");
    expect(command).toContain("doctor finding complete");

    // 4. Card lifecycle + persisted dispatch record.
    const workingCard = doctorDb.getDoctorCard(card.id);
    expect(workingCard.status).toBe("working");
    expect(workingCard.fixDelivery).toMatchObject({
      attached: true,
      replyChannel: "telegram",
      replyTo: "1050",
      replyAccountId: "default",
      gatewayOk: true,
    });
    expect(typeof workingCard.fixDelivery.dispatchedAt).toBe("string");
  });

  it("journey: main-session pick queues honestly without delivery", async () => {
    const { app, clawCmd, doctorDb, card } = await buildStack();

    const fixRes = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({ sessionKey: "agent:main:main", prompt: "Fix in main." });
    expect(fixRes.status).toBe(202);
    expect(fixRes.body.delivery).toEqual({
      attached: false,
      replyChannel: "",
      replyTo: "",
      replyAccountId: "",
    });
    const command = findDispatchCommand(clawCmd);
    expect(command).not.toContain('"deliver"');
    expect(doctorDb.getDoctorCard(card.id).fixDelivery).toMatchObject({
      attached: false,
      gatewayOk: true,
    });
  });

  it("derives the discord DM target as user:<id> (never a bare id)", async () => {
    const { app, clawCmd, card } = await buildStack();

    const fixRes = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({ sessionKey: "agent:main:discord:direct:99", prompt: "Fix it." });
    expect(fixRes.status).toBe(202);
    expect(fixRes.body.delivery).toEqual({
      attached: true,
      replyChannel: "discord",
      replyTo: "user:99",
      replyAccountId: "",
    });
    const command = findDispatchCommand(clawCmd);
    expect(command).toContain('"replyTo":"user:99"');
  });

  it("server derivation overrides stale client-supplied reply fields", async () => {
    const { app, clawCmd, card } = await buildStack();

    // A stale cached row: suffixed key with EMPTY client reply fields (the
    // pre-fix cache shape). The server derives the target anyway.
    const fixRes = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({
        sessionKey: "agent:main:telegram:direct:2020:heartbeat",
        replyChannel: "",
        replyTo: "",
        prompt: "Fix it.",
      });
    expect(fixRes.status).toBe(202);
    expect(fixRes.body.delivery).toEqual({
      attached: true,
      replyChannel: "telegram",
      replyTo: "2020",
      replyAccountId: "",
    });
    const command = findDispatchCommand(clawCmd);
    expect(command).toContain('"deliver":true');
    expect(command).toContain('"replyTo":"2020"');
  });

  it("server-derived target WINS over mismatched client fields (stale-cache override)", async () => {
    const { app, clawCmd, card } = await buildStack();

    // A poisoned/stale client copy: both fields present (passes the
    // half-specified 400) but pointing at the WRONG recipient. Server
    // derivation must override — the client can never redirect delivery.
    const fixRes = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({
        sessionKey: "agent:main:telegram:default:direct:1050",
        replyChannel: "telegram",
        replyTo: "9999",
        prompt: "Fix it.",
      });
    expect(fixRes.status).toBe(202);
    expect(fixRes.body.delivery).toEqual({
      attached: true,
      replyChannel: "telegram",
      replyTo: "1050",
      replyAccountId: "default",
    });
    const command = findDispatchCommand(clawCmd);
    expect(command).toContain('"replyTo":"1050"');
    expect(command).not.toContain('"replyTo":"9999"');
  });

  it("maps a failing sessions CLI to 502 (infrastructure, not a client error)", async () => {
    const { app, clawCmd, doctorDb, card } = await buildStack();
    clawCmd.mockImplementation(async (command) => {
      if (command === "sessions --json --all-agents") {
        return { ok: false, stdout: "", stderr: "gateway restarting" };
      }
      return { ok: true, stdout: "{}", stderr: "" };
    });

    const fixRes = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({
        sessionKey: "agent:main:telegram:default:direct:1050",
        prompt: "Fix.",
      });
    expect(fixRes.status).toBe(502);
    expect(fixRes.body.error).toBe("gateway restarting");
    // Nothing dispatched, card untouched.
    expect(doctorDb.getDoctorCard(card.id).status).toBe("open");
    expect(findDispatchCommand(clawCmd)).toBeUndefined();
  });

  it("rejects unknown session keys (400) and half-specified reply targets (400)", async () => {
    const { app, clawCmd, doctorDb, card } = await buildStack();

    const unknown = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({ sessionKey: "agent:main:telegram:direct:666", prompt: "Fix." });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("Selected session was not found");
    // The card never flipped and nothing was dispatched.
    expect(doctorDb.getDoctorCard(card.id).status).toBe("open");
    expect(findDispatchCommand(clawCmd)).toBeUndefined();

    const halfSpecified = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({
        sessionKey: "agent:main:telegram:default:direct:1050",
        replyChannel: "telegram",
        prompt: "Fix.",
      });
    expect(halfSpecified.status).toBe(400);
    expect(halfSpecified.body.error).toContain("replyChannel and replyTo");
  });

  it("records a failed dispatch on the card and reverts it to open", async () => {
    const { app, clawCmd, doctorDb, card } = await buildStack();
    clawCmd.mockImplementation(async (command) => {
      if (command === "sessions --json --all-agents") {
        return { ok: true, stdout: JSON.stringify(kSessionsPayload) };
      }
      return { ok: false, stdout: "", stderr: "gateway exploded" };
    });

    const fixRes = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({
        sessionKey: "agent:main:telegram:default:direct:1050",
        prompt: "Fix.",
      });
    expect(fixRes.status).toBe(400);
    const failedCard = doctorDb.getDoctorCard(card.id);
    expect(failedCard.status).toBe("open");
    // X5: the pre-written dispatch record survives the failure.
    expect(failedCard.fixDelivery).toMatchObject({
      attached: true,
      replyChannel: "telegram",
      gatewayOk: false,
    });
  });

  it("maps an unrecognizable sessions payload to 502, never a client-blaming 400", async () => {
    const { app, clawCmd, doctorDb, card } = await buildStack();
    clawCmd.mockImplementation(async (command) => {
      if (command === "sessions --json --all-agents") {
        // A stray log line that parses as JSON — the tolerant extractor
        // would adopt it; the shape guard must refuse a not-found verdict.
        return { ok: true, stdout: '{"level":"warn","msg":"gateway restarting"}' };
      }
      return { ok: true, stdout: "{}", stderr: "" };
    });

    const fixRes = await request(app)
      .post(`/api/doctor/findings/${card.id}/fix`)
      .send({
        sessionKey: "agent:main:telegram:default:direct:1050",
        prompt: "Fix.",
      });
    expect(fixRes.status).toBe(502);
    expect(fixRes.body.error).toBe("Could not parse agent sessions output");
    expect(doctorDb.getDoctorCard(card.id).status).toBe("open");
  });
});
