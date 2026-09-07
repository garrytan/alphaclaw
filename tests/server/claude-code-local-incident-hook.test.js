// The incident tracker's rescue hook: fires on open (fresh + orphan-adopt)
// and on crash_loop escalation appends, and MUST be fail-open — a throwing
// observer never affects incident processing (the tracker's founding
// contract).
const {
  createWatchdogIncidentTracker,
  classifyEvent,
} = require("../../lib/server/watchdog-incidents");

const createFakeDb = () => {
  let nextId = 1;
  return {
    getOpenIncident: vi.fn(() => null),
    insertIncident: vi.fn(() => nextId++),
    resolveIncident: vi.fn(),
    getIncidentEventTypeCounts: vi.fn(() => ({})),
    withTransaction: vi.fn((fn) => fn()),
  };
};

const createTracker = (overrides = {}) => {
  const db = createFakeDb();
  const onIncidentActivity = vi.fn();
  const insert = vi.fn(() => 42);
  const tracker = createWatchdogIncidentTracker({
    db,
    onIncidentActivity,
    logger: { info: vi.fn(), error: vi.fn(), log: vi.fn() },
    ...overrides.deps,
  });
  const sink = tracker.wrapInsertEvent(insert);
  return { db, onIncidentActivity, insert, tracker, sink };
};

describe("watchdog-incidents rescue hook", () => {
  it("classifies channel_rollback as OPEN and crash_loop as append (comment-vs-code pin)", () => {
    expect(classifyEvent({ eventType: "channel_rollback" })).toBe("open");
    expect(classifyEvent({ eventType: "crash_loop" })).toBe("append");
  });

  it("fires kind=open on every open trigger, outside the transaction", () => {
    for (const eventType of ["crash", "config_error", "safe_mode", "channel_rollback"]) {
      const { onIncidentActivity, sink } = createTracker();
      sink({ eventType, status: "failed", details: {} });
      expect(onIncidentActivity).toHaveBeenCalledTimes(1);
      expect(onIncidentActivity).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "open", eventType }),
      );
    }
    const failedCheck = createTracker();
    failedCheck.sink({ eventType: "health_check", status: "failed", details: {} });
    expect(failedCheck.onIncidentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open", eventType: "health_check" }),
    );
  });

  it("fires kind=open when adopting an orphaned open incident", () => {
    const { db, onIncidentActivity, sink } = createTracker();
    db.getOpenIncident.mockReturnValue({ id: 7, incidentKey: "gateway_crash" });
    sink({ eventType: "crash", details: {} });
    expect(onIncidentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open", incidentId: 7 }),
    );
  });

  it("fires kind=escalation on crash_loop appends to an open incident", () => {
    const { onIncidentActivity, sink } = createTracker();
    sink({ eventType: "crash", details: {} }); // opens
    onIncidentActivity.mockClear();
    sink({ eventType: "crash_loop", details: {} });
    expect(onIncidentActivity).toHaveBeenCalledTimes(1);
    expect(onIncidentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "escalation", eventType: "crash_loop" }),
    );
  });

  it("does NOT fire on plain appends or closes", () => {
    const { onIncidentActivity, sink } = createTracker();
    sink({ eventType: "crash", details: {} });
    onIncidentActivity.mockClear();
    sink({ eventType: "restart", details: {} });
    sink({ eventType: "recovery", details: {} });
    expect(onIncidentActivity).not.toHaveBeenCalled();
  });

  it("never lets a throwing hook affect incident processing", () => {
    const throwing = createTracker();
    throwing.onIncidentActivity.mockImplementation(() => {
      throw new Error("hook boom");
    });
    const eventId = throwing.sink({ eventType: "crash", details: {} });
    expect(eventId).toBe(42);
    expect(throwing.db.insertIncident).toHaveBeenCalledTimes(1);
    // Escalation path too.
    expect(() => throwing.sink({ eventType: "crash_loop", details: {} })).not.toThrow();
  });

  it("does not fire kind=open when a rolled-back open transaction throws", () => {
    const { db, onIncidentActivity, insert, sink } = createTracker();
    db.withTransaction.mockImplementation(() => {
      throw new Error("db down");
    });
    const eventId = sink({ eventType: "crash", details: {} });
    // Fail-open: the event still inserts unstamped…
    expect(eventId).toBe(42);
    expect(insert).toHaveBeenCalledWith({ eventType: "crash", details: {} });
    // …but the rescue hook must not have fired for a failed open.
    expect(onIncidentActivity).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #76 B4 — the service side of the hook. The tracker's context reaches
// ensureForIncident (enriched by lib/server.js with the fingerprint/cause),
// which must write the evidence BEFORE the spawn, stay fail-open when the
// write fails, append for the same fingerprint while a session is live, and
// never type into the pane (Codex 13). Fakes mirror claude-code-local-
// service.test.js (a Map-backed fs, a scripted tmux driver, a probe stream).
// ---------------------------------------------------------------------------
const fs = require("node:fs");
const path = require("node:path");
const { createClaudeCodeLocalService } = require("../../lib/server/claude-code-local");
const { kManagedClaudeMdMarker } = require("../../lib/server/claude-code-local/incident-bundle");

const kHookPaths = {
  root: "/data/claude-code-local",
  home: "/data/claude-code-local/home",
  workspace: "/data/claude-code-local/workspace",
  stateFile: "/data/claude-code-local/state.json",
  socket: "/data/claude-code-local/tmux.sock",
  lockFile: "/data/claude-code-local/lifecycle.lock",
};
const kHookBundle = `${kHookPaths.workspace}/INCIDENT-9.md`;
const kHookFingerprint = "0badc0ffee11";
const flushHook = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const createHookFs = () => {
  const files = new Map();
  const dirs = new Set(["/proc/4242"]);
  return {
    files,
    dirs,
    mkdirSync: vi.fn((dir) => dirs.add(dir)),
    existsSync: vi.fn((p) => files.has(p) || dirs.has(p)),
    readFileSync: vi.fn((p) => {
      if (!files.has(p)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    }),
    writeFileSync: vi.fn((p, data, opts) => {
      if (opts?.flag === "wx" && files.has(p)) {
        const err = new Error("EEXIST");
        err.code = "EEXIST";
        throw err;
      }
      files.set(p, String(data));
    }),
    renameSync: vi.fn((from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    }),
    unlinkSync: vi.fn((p) => files.delete(p)),
    rmSync: vi.fn((p) => {
      files.delete(p);
      dirs.delete(p);
    }),
  };
};
const createHookDriver = () => {
  const state = { buffer: "", sessionAlive: false, panePid: 4242, paneDead: false };
  return {
    state,
    socketPath: kHookPaths.socket,
    hasTmux: vi.fn(async () => ({ ok: true, version: "tmux 3.6a" })),
    newSession: vi.fn(async () => {
      state.sessionAlive = true;
      return { code: 0, stdout: "", stderr: "" };
    }),
    hasSession: vi.fn(async () => ({ alive: state.sessionAlive })),
    capturePane: vi.fn(async () => (state.sessionAlive ? state.buffer : null)),
    listPaneInfo: vi.fn(async () =>
      state.sessionAlive ? { panePid: state.panePid, paneDead: state.paneDead } : null,
    ),
    sendKeys: vi.fn(async () => ({ code: 0 })),
    killSession: vi.fn(async () => {
      state.sessionAlive = false;
      return { ok: true };
    }),
  };
};
const createHookRunStream = () => ({
  runStreamed: vi.fn(async ({ args }) =>
    args[0] === "--version"
      ? { ok: true, code: 0, tail: "2.1.237 (Claude Code)" }
      : { ok: true, code: 0, tail: JSON.stringify({ loggedIn: true, authMethod: "oauth" }) },
  ),
});
const createHookService = ({ incidentEvidence } = {}) => {
  const fsModule = createHookFs();
  const driver = createHookDriver();
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createClaudeCodeLocalService({
    env: {},
    fsModule,
    tmux: driver,
    runStream: createHookRunStream(),
    logger,
    paths: kHookPaths,
    timers: { urlPollMs: 2, urlDeadlineMs: 2_000, trustWatchMs: 2, loginPollMs: 2, loginTtlMs: 500, probeMs: 60_000 },
    incidentEvidence: incidentEvidence ?? {
      readBootReports: () => ({ current: { bootId: "40:1700000000000", serverPhase: { verdict: [] } }, previous: [], incident: null }),
      collectDiagnoseMarkdown: async () => "# AlphaClaw diagnose\n",
      buildRedactor: () => (text) => text,
    },
  });
  return { fsModule, driver, logger, service };
};
const kHookContext = () => ({
  kind: "open",
  eventType: "crash",
  incidentId: 9,
  fingerprint: kHookFingerprint,
  cause: "state_schema_too_new",
  corroborated: true,
  crash: { cause: "state_schema_too_new", code: 1, signal: null },
  stderrLines: ["uses newer schema version 12; this build supports 1."],
  versions: { running: "2026.7.1-2", expected: "2026.9.1-beta.1" },
});

describe("rescue service side of the hook (#76 B4)", () => {
  it("INCIDENT-<id>.md and the managed CLAUDE.md exist in the managed workspace when newSession is called", async () => {
    const { fsModule, driver, service } = createHookService();
    await service.refreshProbes({ force: true });
    let atSpawn = null;
    driver.newSession.mockImplementation(async ({ cwd }) => {
      atSpawn = {
        cwd,
        bundle: fsModule.files.get(kHookBundle) ?? null,
        claudeMd: fsModule.files.get(`${kHookPaths.workspace}/CLAUDE.md`) ?? null,
      };
      driver.state.sessionAlive = true;
      return { code: 0, stdout: "", stderr: "" };
    });
    service.ensureForIncident(kHookContext());
    await flushHook();
    expect(driver.newSession).toHaveBeenCalledTimes(1);
    expect(atSpawn.cwd).toBe(kHookPaths.workspace);
    expect(atSpawn.bundle).toContain("# AlphaClaw incident 9");
    expect(atSpawn.bundle).toContain("Cause: `state_schema_too_new`");
    expect(atSpawn.claudeMd.startsWith(kManagedClaudeMdMarker)).toBe(true);
  });

  it("is fail-open: a bundle write failure logs once and the spawn still proceeds", async () => {
    const { fsModule, driver, logger, service } = createHookService();
    await service.refreshProbes({ force: true });
    const realWrite = fsModule.writeFileSync.getMockImplementation();
    fsModule.writeFileSync.mockImplementation((p, data, opts) => {
      if (String(p).startsWith(kHookPaths.workspace)) {
        const err = new Error("ENOSPC: no space left on device");
        err.code = "ENOSPC";
        throw err;
      }
      return realWrite(p, data, opts);
    });
    service.ensureForIncident(kHookContext());
    await flushHook();
    expect(driver.newSession).toHaveBeenCalledTimes(1);
    expect(fsModule.files.has(kHookBundle)).toBe(false);
    const warnings = logger.warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes("[incident-bundle]") && line.includes("ENOSPC"))).toBe(true);
    // A throwing seam is also fail-open: the bundle is written with placeholders.
    const throwing = createHookService({
      incidentEvidence: {
        readBootReports: () => {
          throw new Error("reports boom");
        },
        collectDiagnoseMarkdown: async () => {
          throw new Error("diagnose boom");
        },
        buildRedactor: () => {
          throw new Error("redactor boom");
        },
      },
    });
    await throwing.service.refreshProbes({ force: true });
    throwing.service.ensureForIncident(kHookContext());
    await flushHook();
    expect(throwing.driver.newSession).toHaveBeenCalledTimes(1);
    const bundle = throwing.fsModule.files.get(kHookBundle);
    expect(bundle).toContain("_No boot report was available._");
    expect(bundle).toContain("_`alphaclaw diagnose` output was not available._");
  });

  it("same fingerprint while a session is live → appends ## Boot <n>, no second spawn, and NEVER sendKeys", async () => {
    const { fsModule, driver, service } = createHookService();
    await service.refreshProbes({ force: true });
    service.ensureForIncident(kHookContext());
    await flushHook();
    driver.state.buffer = "https://claude.ai/code/sess_hook00000001?from=cli\n";
    await flushHook();
    expect(service.getStatusSnapshot().state).toBe("running");
    driver.sendKeys.mockClear();
    const before = fsModule.files.get(kHookBundle);

    service.ensureForIncident({ ...kHookContext(), kind: "escalation", eventType: "crash_loop" });
    await flushHook();

    expect(driver.newSession).toHaveBeenCalledTimes(1);
    expect(driver.sendKeys).not.toHaveBeenCalled();
    const after = fsModule.files.get(kHookBundle);
    expect(after.startsWith(before.slice(0, before.lastIndexOf("</alphaclaw-untrusted-content>")))).toBe(true);
    expect(after).toContain("## Boot 2 · ");
    expect(service.getNotificationLine()).toContain(" · Evidence: `INCIDENT-9.md` (updated)");
  });

  it("lib/server.js enriches the tracker context with fingerprint/cause and hands the service its evidence seams (source pin)", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "server.js"), "utf8");
    const hook = source.slice(source.indexOf("const watchdogIncidentTracker = createWatchdogIncidentTracker({"));
    expect(hook).toContain("evidence = describeIncidentEvidence(context);");
    expect(hook).toContain("claudeCodeLocalService?.ensureForIncident?.(evidence);");
    const enrich = source.slice(
      source.indexOf("const describeIncidentEvidence = (context = {}) => {"),
      source.indexOf("const watchdogIncidentTracker = createWatchdogIncidentTracker({"),
    );
    for (const field of ["evidence.fingerprint =", "evidence.cause =", "evidence.crash =", "evidence.stderrLines =", "evidence.versions =", "evidence.plan ="]) {
      expect(enrich).toContain(field);
    }
    expect(enrich).toContain("watchdogDb.getIncidentById?.(incidentId)");
    expect(enrich).toContain("watchdogDb.getIncidentEvents?.(incidentId");
    const construction = source.slice(source.indexOf("claudeCodeLocalService = createClaudeCodeLocalService({"));
    const block = construction.slice(0, construction.indexOf("\n});") + 4);
    expect(block).toContain("incidentEvidence: {");
    expect(block).toContain("readBootReports: () => bootReportWriter?.readBootReports?.()");
    expect(block).toContain("renderDiagnoseMarkdown(");
    expect(block).toContain("await collectDiagnose({");
    expect(block).toContain("buildRedactor: () => {");
    expect(block).toContain("redactCollectedSecrets(text, { secrets })");
  });
});
