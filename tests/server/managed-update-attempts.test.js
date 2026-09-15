const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { createManagedUpdateAttempts } = require("../../lib/server/managed-update-attempts");
const { createAlphaclawVersionService } = require("../../lib/server/alphaclaw-version");

const kTarget = { repo: "owner/template", ref: "abc123", alphaclawVersion: "0.9.85", openclawVersion: "2026.9.3" };
const kEnv = { ALPHACLAW_MANAGED_UPDATE_URL: "https://bridge.example/private-update",
  ALPHACLAW_MANAGED_UPDATE_TOKEN: "never-expose-this-token", ALPHACLAW_TEMPLATE_REPO_URL: "https://github.com/owner/template.git" };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe("durable managed deployment attempts", () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-attempt-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
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
    const second = await service.updateAlphaclaw();
    expect(second.body.managedUpdateAttempt.id).not.toBe(first.body.managedUpdateAttempt.id);
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
