const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const watchdogDb = require("../../lib/server/db/watchdog");
const { createManagedUpdateAttempts } = require("../../lib/server/managed-update-attempts");
const { createAlphaclawVersionService } = require("../../lib/server/alphaclaw-version");
const { createOpenclawUpdateRepair } = require("../../lib/server/openclaw-update-repair");

const kTarget = { repo: "owner/template", ref: "abc123", alphaclawVersion: "0.9.85", openclawVersion: "2026.9.3" };
const kEnv = { ALPHACLAW_MANAGED_UPDATE_URL: "https://bridge.example/private-update",
  ALPHACLAW_MANAGED_UPDATE_TOKEN: "never-expose-this-token", ALPHACLAW_TEMPLATE_REPO_URL: "https://github.com/owner/template.git" };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe("durable managed deployment attempts", () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-attempt-")); });
  afterEach(() => { watchdogDb.closeWatchdogDb(); fs.rmSync(dir, { recursive: true, force: true }); });
  const makeService = ({ post = async () => response({ ok: true, phase: "queued", noop: false }), ...options } = {}) => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (init?.method === "POST") return post(url, init);
      if (String(url).includes("/commits/")) return response({ sha: kTarget.ref });
      return response({ dependencies: { alphaclaw: kTarget.alphaclawVersion, openclaw: kTarget.openclawVersion } });
    });
    const service = createAlphaclawVersionService({ managedDir: dir, env: kEnv, fetchImpl,
      readOpenclawVersion: () => "2026.9.2", insertWatchdogEvent: vi.fn(), ...options });
    return { service, fetchImpl };
  };

  it("persists before POST and gates concurrent calls and resolution while the local POST is active", async () => {
    const pending = deferred();
    const posted = deferred();
    const { service, fetchImpl } = makeService({ post: async (url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const doc = JSON.parse(fs.readFileSync(path.join(dir, "managed-update-attempt.json")));
      expect(doc.attempt.state).toBe("submitting");
      posted.resolve(doc.attempt.id);
      return pending.promise;
    } });
    const first = service.updateAlphaclaw();
    expect(service.isDeploymentMutationBlocked()).toBe(true);
    expect((await service.updateAlphaclaw()).status).toBe(409);
    const id = await posted.promise;
    expect(service.resolveManagedUpdate({ attemptId: id, confirmProviderChecked: true, outcome: "deployed" }).body.code).toBe("attempt_in_flight");
    pending.resolve(response({ ok: true, phase: "queued", noop: false }));
    expect((await first).body).toMatchObject({ restarting: false, managedUpdateAttempt: { id, state: "accepted" } });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect((await service.updateAlphaclaw()).body.code).toBe("managed_update_pending");
  });

  it("accepted survives reboot/version changes; human resolution is idempotent and never dispatches", async () => {
    const first = makeService();
    const id = (await first.service.updateAlphaclaw()).body.managedUpdateAttempt.id;
    const { service, fetchImpl } = makeService({ readOpenclawVersion: () => "2099.1.1" });
    expect((await service.getVersionStatus()).managedUpdateAttempt).toMatchObject({ id, state: "accepted" });
    expect((await service.updateAlphaclaw()).status).toBe(409);
    const args = { attemptId: id, confirmProviderChecked: true, outcome: "deployed" };
    expect(service.resolveManagedUpdate(args)).toMatchObject({ status: 200, body: { managedUpdateAttempt: { state: "resolved" } } });
    expect(service.resolveManagedUpdate(args).status).toBe(200);
    expect(service.resolveManagedUpdate({ ...args, outcome: "not_deployed" }).status).toBe(409);
    expect(service.resolveManagedUpdate({ ...args, attemptId: "old" }).status).toBe(409);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect((await service.updateAlphaclaw()).status).toBe(200);
  });

  it.each(["timeout", "lost response", "bad JSON", "server error", "unrecognized acknowledgement"])("%s becomes unknown and never resubmits on restart", async (mode) => {
    const pending = deferred();
    const post = mode === "timeout" ? () => pending.promise : mode === "lost response" ? () => Promise.reject(new Error("lost")) :
      mode === "bad JSON" ? () => ({ ok: true, status: 200, text: async () => "broken" }) :
      mode === "server error" ? () => response({ ok: false }, 500) : () => response({ ok: true });
    const { service } = makeService({ post, managedPostTimeoutMs: 15 });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      const result = await service.updateAlphaclaw();
      expect(result).toMatchObject({ status: 502, body: { code: "managed_update_unknown", managedUpdateAttempt: { state: "unknown" } } });
      pending.resolve(response({ ok: true, phase: "queued", noop: false }));
      const restarted = makeService();
      expect((await restarted.service.updateAlphaclaw()).status).toBe(409);
      expect(restarted.fetchImpl).not.toHaveBeenCalled();
    } finally { clearTimeout(keepAlive); }
  });

  it.each(["before_post", "after_post"])("real process death %s leaves a durable unknown attempt without a boot resend", (phase) => {
    const modulePath = require.resolve("../../lib/server/managed-update-attempts");
    const servicePath = require.resolve("../../lib/server/alphaclaw-version");
    const script = phase === "before_post"
      ? `require(${JSON.stringify(modulePath)}).createManagedUpdateAttempts({managedDir:process.argv[1]}).begin(${JSON.stringify(kTarget)});`
      : `const {createAlphaclawVersionService}=require(${JSON.stringify(servicePath)});
         createAlphaclawVersionService({managedDir:process.argv[1],env:${JSON.stringify(kEnv)},insertWatchdogEvent:()=>{},fetchImpl:async(url,init)=>{
           if(init?.method==='POST') process.exit(0);
           return {ok:true,status:200,text:async()=>JSON.stringify(String(url).includes('/commits/')?{sha:'abc123'}:{dependencies:{alphaclaw:'0.9.85',openclaw:'2026.9.3'}})};
         }}).updateAlphaclaw();`;
    execFileSync(process.execPath, ["-e", script, dir], { timeout: 5000 });
    const { service, fetchImpl } = makeService();
    expect(createManagedUpdateAttempts({ managedDir: dir }).read().state).toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.isUpdateInProgress()).toBe(false);
  });

  it.each(["rejected", "noop"])("a recognized %s permits a later attempt", async (mode) => {
    const { service } = makeService({ post: () => mode === "noop" ? response({ ok: true, noop: true }) : response({ ok: false }, 400) });
    const first = await service.updateAlphaclaw();
    expect(first.body.managedUpdateAttempt.state).toBe(mode);
    expect(service.isDeploymentMutationBlocked()).toBe(false);
    const second = await service.updateAlphaclaw();
    expect(second.body.managedUpdateAttempt.id).not.toBe(first.body.managedUpdateAttempt.id);
  });

  it.each([307, 308])("a real HTTP %s never replays the provider POST and leaves a blocking unknown attempt", async (status) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, path: req.url });
      req.resume();
      if (req.url === "/update") {
        res.writeHead(status, { Location: "/redirected-update" });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, noop: false, phase: "queued" }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { service } = makeService({
        env: { ...kEnv, ALPHACLAW_MANAGED_UPDATE_URL: `http://127.0.0.1:${server.address().port}/update` },
        post: (url, init) => fetch(url, init),
      });
      const result = await service.updateAlphaclaw();
      expect(result).toMatchObject({ status: 502, body: {
        code: "managed_update_unknown", managedUpdateAttempt: { state: "unknown" },
      } });
      expect(requests).toEqual([{ method: "POST", path: "/update" }]);
      expect((await service.updateAlphaclaw()).body.code).toBe("managed_update_pending");
      expect(requests).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("does not write or POST after preflight failure and never exposes bridge URL/token", async () => {
    const { service } = makeService();
    const status = await service.getVersionStatus();
    expect(JSON.stringify(status)).not.toContain(kEnv.ALPHACLAW_MANAGED_UPDATE_TOKEN);
    expect(JSON.stringify(status)).not.toContain(kEnv.ALPHACLAW_MANAGED_UPDATE_URL);
    const broken = createAlphaclawVersionService({ managedDir: dir, env: kEnv,
      insertWatchdogEvent: vi.fn(), fetchImpl: async () => { throw new Error(kEnv.ALPHACLAW_MANAGED_UPDATE_TOKEN); } });
    const result = await broken.updateAlphaclaw();
    expect(result.body.code).toBe("managed_update_preflight_failed");
    expect(JSON.stringify(result)).not.toContain(kEnv.ALPHACLAW_MANAGED_UPDATE_TOKEN);
    expect(fs.existsSync(path.join(dir, "managed-update-attempt.json"))).toBe(false);
    expect(broken.isUpdateInProgress()).toBe(false);
  });

  it.each(["{bad", '{"schemaVersion":1,"attempt":{}}'])("corrupt storage fails closed and preserves bytes: %s", async (bytes) => {
    const file = path.join(dir, "managed-update-attempt.json");
    fs.writeFileSync(file, bytes);
    const { service, fetchImpl } = makeService();
    await expect(service.updateAlphaclaw()).rejects.toMatchObject({ code: "MANAGED_UPDATE_ATTEMPT_UNREADABLE" });
    expect(() => service.resolveManagedUpdate({ attemptId: "a", confirmProviderChecked: true, outcome: "deployed" }))
      .toThrow(/Cannot read managed update attempt/);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.isDeploymentMutationBlocked()).toBe(true);
  });

  it.each(["accepted", "unknown"])("blocks the actual repair writer while a %s deployment can still restart AlphaClaw", async (state) => {
    const original = makeService({ post: state === "unknown"
      ? async () => { throw new Error("response lost"); }
      : async () => response({ ok: true, noop: false, phase: "queued" }) });
    const submission = await original.service.updateAlphaclaw();
    expect(submission.body.managedUpdateAttempt.state).toBe(state);
    // A fresh service must preserve the same restriction after a restart.
    const { service } = makeService();
    expect(service.isUpdateInProgress()).toBe(false);
    expect(service.isDeploymentMutationBlocked()).toBe(true);
    let applying = false;
    const hold = Object.assign(async () => {}, { isValid: () => true });
    const runner = { runStreamed: vi.fn(async () => ({ ok: true })) };
    const ledger = {
      createRun: vi.fn(), completeRun: vi.fn(),
      createLogSink: () => ({ writeLine: () => {}, close: async () => {} }),
    };
    const repair = createOpenclawUpdateRepair({
      getChannelInfo: () => ({ releaseChannel: "dev" }), isOnboarded: () => true,
      isSelfUpdateInProgress: service.isDeploymentMutationBlocked,
      isApplyInProgress: () => applying, setApplyInProgress: (value) => { applying = value; },
      getActiveGatewayOperation: () => null, acquireLifecycleLock: async () => hold,
      mutationPolicy: { assert: () => {} }, ledger, runner, devUpdateEnv: () => ({}),
      stepRecorder: () => ({ steps: [], emit: () => {} }),
      makeOutputPublisher: () => Object.assign(() => {}, { flush: () => {} }),
      setActiveSink: () => {}, channelError: (code, message) => ({ ok: false, code, message }),
      rootDir: dir, log: () => {},
    });
    expect(await repair()).toMatchObject({ status: 409, body: { code: "self_update_in_progress" } });
    expect(runner.runStreamed).not.toHaveBeenCalled();
    expect(ledger.createRun).not.toHaveBeenCalled();
    expect(service.resolveManagedUpdate({ attemptId: submission.body.managedUpdateAttempt.id,
      confirmProviderChecked: true, outcome: "not_deployed" }).status).toBe(200);
    expect(service.isDeploymentMutationBlocked()).toBe(false);
    expect(await repair()).toMatchObject({ status: 200 });
    expect(runner.runStreamed).toHaveBeenCalledTimes(1);
  });

  it("refuses an invalid optional resolution on an otherwise valid accepted attempt", () => {
    const store = createManagedUpdateAttempts({ managedDir: dir });
    const attempt = store.begin(kTarget);
    const bytes = JSON.stringify({ schemaVersion: 1, attempt: {
      ...attempt, state: "accepted", resolution: { outcome: "deployed" },
    } });
    fs.writeFileSync(store.filePath, bytes);
    expect(() => store.read()).toThrow(/invalid attempt schema/);
    expect(() => store.resolve(attempt.id, "deployed")).toThrow(/invalid attempt schema/);
    expect(fs.readFileSync(store.filePath, "utf8")).toBe(bytes);
  });

  it("late completion cannot reverse resolution; reads and identical resolution do not repeat audit events", () => {
    const audit = vi.fn();
    const store = createManagedUpdateAttempts({ managedDir: dir, onTransition: audit });
    const { id } = store.begin(kTarget);
    store.transition(id, ["submitting"], "unknown");
    store.resolve(id, "not_deployed");
    store.resolve(id, "not_deployed");
    store.read(); store.read();
    expect(store.transition(id, ["submitting"], "accepted")).toBeNull();
    expect(store.read().state).toBe("resolved");
    expect(audit).toHaveBeenCalledTimes(3);
  });

  const auditToDatabase = (attempt) => watchdogDb.insertWatchdogEvent({ eventType: "managed_update",
    source: "alphaclaw_update", status: attempt.state, correlationId: attempt.id,
    details: { attemptId: attempt.id, state: attempt.state,
      ...(attempt.resolution ? { resolution: attempt.resolution } : {}) } });
  const readAudits = () => {
    const database = new DatabaseSync(path.join(dir, "db", "watchdog.db"));
    try { return database.prepare("SELECT status, correlation_id, details FROM watchdog_events WHERE event_type = 'managed_update' ORDER BY id").all(); }
    finally { database.close(); }
  };

  it("replays every unrecorded state after SQLite recovers, without exposing the durable audit backlog", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createManagedUpdateAttempts({ managedDir: dir, onTransition: auditToDatabase });
    // The real sink is unavailable until init, rather than a callback that
    // merely returns a fake rejection after recording a successful event.
    const { id } = store.begin({ ...kTarget, token: kEnv.ALPHACLAW_MANAGED_UPDATE_TOKEN });
    store.transition(id, ["submitting"], "unknown");
    store.resolve(id, "not_deployed");
    const doc = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    expect(doc.pendingAudit.map((attempt) => attempt.state)).toEqual(["submitting", "unknown", "resolved"]);
    expect(JSON.stringify(doc)).not.toContain(kEnv.ALPHACLAW_MANAGED_UPDATE_TOKEN);
    watchdogDb.initWatchdogDb({ rootDir: dir });
    const restarted = createManagedUpdateAttempts({ managedDir: dir, onTransition: auditToDatabase });
    expect(restarted.recover()).toMatchObject({ id, state: "resolved" });
    expect(restarted.read()).not.toHaveProperty("pendingAudit");
    expect(readAudits().map((row) => row.status)).toEqual(["submitting", "unknown", "resolved"]);
    expect(readAudits().every((row) => row.correlation_id === id)).toBe(true);
    expect(JSON.parse(fs.readFileSync(store.filePath, "utf8")).pendingAudit).toEqual([]);
    restarted.read(); restarted.resolve(id, "not_deployed");
    expect(readAudits()).toHaveLength(3);
  });

  it.each(["before_insert", "after_insert"])("real process death %s replays the transition once and never resends", (phase) => {
    const attemptModule = require.resolve("../../lib/server/managed-update-attempts");
    const dbModule = require.resolve("../../lib/server/db/watchdog");
    const script = `const db = require(${JSON.stringify(dbModule)});
      db.initWatchdogDb({rootDir:process.argv[1]});
      require(${JSON.stringify(attemptModule)}).createManagedUpdateAttempts({managedDir:process.argv[1],onTransition:attempt=>{
        if(process.argv[2] === 'after_insert') db.insertWatchdogEvent({eventType:'managed_update',source:'alphaclaw_update',
          status:attempt.state,correlationId:attempt.id,details:{attemptId:attempt.id,state:attempt.state}});
        process.exit(0);
      }}).begin(${JSON.stringify(kTarget)});`;
    execFileSync(process.execPath, ["-e", script, dir, phase], { timeout: 5000, stdio: "pipe" });
    const filePath = path.join(dir, "managed-update-attempt.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).pendingAudit).toHaveLength(1);
    // The writer really died holding the lock. Advance only its filesystem
    // age past the existing stale-lock delay; keep the recorded dead PID.
    fs.utimesSync(`${filePath}.lock`, new Date(0), new Date(0));
    watchdogDb.initWatchdogDb({ rootDir: dir });
    const { service, fetchImpl } = makeService({ insertWatchdogEvent: watchdogDb.insertWatchdogEvent });
    expect(service.isDeploymentMutationBlocked()).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readAudits().map((row) => row.status)).toEqual(["submitting", "unknown"]);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).pendingAudit).toEqual([]);
  });

  it("replays an INSERT whose acknowledgement write failed without repeating its SQLite audit", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    watchdogDb.initWatchdogDb({ rootDir: dir });
    let failAcknowledgement = false;
    const fsModule = { ...fs, writeFileSync: (file, bytes, ...args) => {
      if (failAcknowledgement && String(file).endsWith(".tmp")) {
        throw Object.assign(new Error("ack disk failure"), { code: "EIO" });
      }
      return fs.writeFileSync(file, bytes, ...args);
    } };
    const store = createManagedUpdateAttempts({ managedDir: dir, fsModule, onTransition: (attempt) => {
      auditToDatabase(attempt);
      failAcknowledgement = true;
    } });
    const { id } = store.begin(kTarget);
    expect(readAudits()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(store.filePath, "utf8")).pendingAudit).toHaveLength(1);
    const restarted = createManagedUpdateAttempts({ managedDir: dir, onTransition: auditToDatabase });
    expect(restarted.recover()).toMatchObject({ id, state: "unknown" });
    expect(readAudits().map((row) => row.status)).toEqual(["submitting", "unknown"]);
    expect(JSON.parse(fs.readFileSync(store.filePath, "utf8")).pendingAudit).toEqual([]);
  });

  it("bounds failed audit storage while reserving finalization and resolution for the current attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createManagedUpdateAttempts({ managedDir: dir, onTransition: () => { throw new Error("sink down"); } });
    for (let i = 0; i < 9; i += 1) {
      const { id } = store.begin(kTarget);
      store.transition(id, ["submitting"], "unknown");
      store.resolve(id, "not_deployed");
    }
    const noop = store.begin(kTarget);
    store.transition(noop.id, ["submitting"], "noop");
    expect(JSON.parse(fs.readFileSync(store.filePath, "utf8")).pendingAudit).toHaveLength(29);
    const current = store.begin(kTarget);
    store.transition(current.id, ["submitting"], "accepted");
    expect(store.resolve(current.id, "deployed").state).toBe("resolved");
    expect(JSON.parse(fs.readFileSync(store.filePath, "utf8")).pendingAudit).toHaveLength(32);
    expect(() => store.begin(kTarget)).toThrow(expect.objectContaining({ status: 409, code: "managed_update_audit_pending" }));
    expect(store.read()).toMatchObject({ id: current.id, state: "resolved" });
    const { service, fetchImpl } = makeService({ managedAttemptStore: store });
    expect(await service.updateAlphaclaw()).toMatchObject({ status: 409, body: {
      code: "managed_update_audit_pending", managedUpdateAttempt: { id: current.id, state: "resolved" },
    } });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    const sink = vi.fn();
    const restarted = createManagedUpdateAttempts({ managedDir: dir, onTransition: sink });
    restarted.recover();
    expect(sink).toHaveBeenCalledTimes(32);
    expect(restarted.begin(kTarget).state).toBe("submitting");
  });

  it.each([null, {}, [{}]])("fails closed on malformed durable audit data: %j", (pendingAudit) => {
    const store = createManagedUpdateAttempts({ managedDir: dir, onTransition: vi.fn() });
    const attempt = store.begin(kTarget);
    const bytes = JSON.stringify({ schemaVersion: 1, attempt, pendingAudit });
    fs.writeFileSync(store.filePath, bytes);
    expect(() => store.read()).toThrow(expect.objectContaining({ code: "MANAGED_UPDATE_ATTEMPT_UNREADABLE" }));
    expect(fs.readFileSync(store.filePath, "utf8")).toBe(bytes);
  });

  it("deduplicates valid legacy audits while tolerating malformed rows and preserving successors", () => {
    watchdogDb.initWatchdogDb({ rootDir: dir });
    const store = createManagedUpdateAttempts({ managedDir: dir });
    const first = store.begin(kTarget);
    watchdogDb.insertWatchdogEvent({ eventType: "managed_update", source: "alphaclaw_update",
      details: "{legacy broken" });
    // Legacy JSON text went through the old INSERT path. It still counts as
    // the transition's audit when a durable obligation is replayed later.
    watchdogDb.insertWatchdogEvent({ eventType: "managed_update", source: "alphaclaw_update",
      status: first.state, correlationId: first.id,
      details: JSON.stringify({ attemptId: first.id, state: first.state }) });
    const restarted = createManagedUpdateAttempts({ managedDir: dir, onTransition: auditToDatabase });
    restarted.recover();
    restarted.resolve(first.id, "not_deployed");
    const second = restarted.begin(kTarget);
    const valid = readAudits().filter((row) => row.details !== "{legacy broken");
    expect(valid.map((row) => [row.correlation_id, row.status])).toEqual([
      [first.id, "submitting"], [first.id, "unknown"], [first.id, "resolved"], [second.id, "submitting"],
    ]);
  });

  it("a metadata timeout releases admission without creating an attempt or dispatching a late POST", async () => {
    const pending = deferred();
    const fetchImpl = vi.fn(() => pending.promise);
    const { service } = makeService({ fetchImpl, metadataTimeoutMs: 15 });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      const result = await service.updateAlphaclaw();
      expect(result.body.code).toBe("managed_update_preflight_failed");
      expect(service.isUpdateInProgress()).toBe(false);
      pending.resolve(response({ dependencies: { alphaclaw: "0.9.85", openclaw: "2026.9.3" } }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(dir, "managed-update-attempt.json"))).toBe(false);
    } finally { clearTimeout(keepAlive); }
  });

  it("a durable pre-POST write failure submits nothing and remains retryable once storage recovers", async () => {
    const fsModule = { ...fs, writeFileSync: (file, ...args) => {
      if (String(file).endsWith(".tmp")) throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
      return fs.writeFileSync(file, ...args);
    } };
    const attempts = createManagedUpdateAttempts({ managedDir: dir, fsModule });
    const { service, fetchImpl } = makeService({ managedAttemptStore: attempts });
    expect((await service.updateAlphaclaw()).status).toBe(503);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(service.isUpdateInProgress()).toBe(false);
    fsModule.writeFileSync = fs.writeFileSync;
    expect((await service.updateAlphaclaw()).status).toBe(200);
  });
});
