const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { createAgentDeleter } = require("../../lib/server/agents/delete-agent");
const { classifyDeletion } = require("../../lib/server/agents/delete-agent/read-back");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { updateOpenclawConfig, readOpenclawConfig } = require("../../lib/server/openclaw-config");

const kSilent = { log() {}, warn() {}, error() {} };

// A box on disk: openclaw.json, OpenClaw's state database with the two
// tables the deleter reads, and an agent "ops" with a database, transcripts
// and a workspace. The fake CLI below plays OpenClaw's part (it is the only
// thing that changes the state directory).
const makeBox = ({ agents = null, registered = null, extraConfig = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deleter-"));
  const openclawDir = path.join(root, ".openclaw");
  const archivesRoot = path.join(root, "archives", "agents");
  fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
  fs.mkdirSync(path.join(openclawDir, "workspace"), { recursive: true });
  const opsWorkspace = path.join(openclawDir, "workspace-ops");
  fs.mkdirSync(path.join(opsWorkspace, "notes"), { recursive: true });
  fs.writeFileSync(path.join(opsWorkspace, "NOTE.md"), "hello\n");
  fs.writeFileSync(path.join(opsWorkspace, "notes", "a.txt"), "a\n");
  fs.symlinkSync("NOTE.md", path.join(opsWorkspace, "link.md"));
  const agentDir = path.join(openclawDir, "agents", "ops", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "openclaw-agent.sqlite"), Buffer.alloc(4096, 1));
  fs.mkdirSync(path.join(openclawDir, "agents", "ops", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "agents", "ops", "sessions", "cold.zst"), Buffer.alloc(2048, 2));
  const config = {
    agents: agents || { list: [{ id: "main", default: true }, { id: "ops", name: "Ops", workspace: opsWorkspace }] },
    bindings: [{ agentId: "ops", match: { channel: "telegram" } }, { agentId: "main", match: { channel: "telegram" } }],
    ...extraConfig,
  };
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify(config, null, 2));
  const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
  db.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT, schema_version INTEGER, last_seen_at INTEGER, size_bytes INTEGER)");
  db.exec("CREATE TABLE agent_deletion_journal (agent_id TEXT PRIMARY KEY, operation_id TEXT, agent_dir TEXT, workspace_dir TEXT, sessions_dir TEXT, database_paths_json TEXT, cleanup_paths_json TEXT, created_at INTEGER, cleanup_completed INTEGER, delete_files INTEGER)");
  for (const row of registered || [["main", "agents/main/agent/openclaw-agent.sqlite"], ["ops", "agents/ops/agent/openclaw-agent.sqlite"]]) {
    db.prepare("INSERT INTO agent_databases (agent_id, path) VALUES (?, ?)").run(...row);
  }
  db.close();
  const exec = (sql, ...args) => {
    const handle = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    try {
      handle.prepare(sql).run(...args);
    } finally {
      handle.close();
    }
  };
  return { root, openclawDir, archivesRoot, opsWorkspace, agentDir, exec, readConfig: () => JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")) };
};

// What OpenClaw's agents.delete does to the box, as far as the deleter can see.
const openclawDeletes = (box, agentId, { complete = true } = {}) => {
  const cfg = box.readConfig();
  if (cfg.agents.list) cfg.agents.list = cfg.agents.list.filter((entry) => entry.id !== agentId);
  if (cfg.agents.entries) delete cfg.agents.entries[agentId];
  cfg.bindings = (cfg.bindings || []).filter((binding) => binding.agentId !== agentId);
  fs.writeFileSync(path.join(box.openclawDir, "openclaw.json"), JSON.stringify(cfg));
  box.exec("DELETE FROM agent_databases WHERE agent_id = ?", agentId);
  box.exec("INSERT OR REPLACE INTO agent_deletion_journal (agent_id, operation_id, cleanup_completed, delete_files) VALUES (?, 'op', ?, 1)", agentId, complete ? 1 : 0);
};

const makeCli = (box, { onDelete = null, onCreate = null, onVerify = null } = {}) => {
  const calls = [];
  const execFileCmd = vi.fn(async (file, args, opts = {}) => {
    calls.push({ file, args, opts });
    if (args[0] === "backup" && args[2] === "create") {
      if (onCreate) return onCreate(args);
      const repository = args[args.indexOf("--repository") + 1];
      const snapshotPath = path.join(repository, "2026-10-28T00-00-00-000Z-snap");
      fs.mkdirSync(snapshotPath, { recursive: true });
      fs.writeFileSync(path.join(snapshotPath, "database.sqlite"), Buffer.alloc(1000));
      return JSON.stringify({ ok: true, snapshotPath, manifest: { snapshotId: "snap", artifact: { sha256: "abc", sizeBytes: 1000 } } });
    }
    if (args[0] === "backup" && args[2] === "verify") {
      if (onVerify) return onVerify(args);
      return JSON.stringify({ ok: true, manifest: { artifact: { sha256: "abc", sizeBytes: 1000 } } });
    }
    if (args[0] === "gateway" && args[2] === "agents.delete") {
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      if (onDelete) return onDelete(params, opts);
      openclawDeletes(box, params.agentId);
      return JSON.stringify({ ok: true, agentId: params.agentId, removedBindings: 1, removed: [{ path: "x", method: "trash" }], failed: [] });
    }
    throw new Error("unexpected call " + args.join(" "));
  });
  return { execFileCmd, calls };
};

const makeDeleter = (box, overrides = {}) => {
  const lifecycleLock = overrides.lifecycleLock || createGatewayLifecycleLock({ logger: kSilent });
  const cli = overrides.cli || makeCli(box);
  const insertEvent = vi.fn();
  const notify = vi.fn(async () => ({ ok: true }));
  const deleter = createAgentDeleter({
    openclawDir: box.openclawDir,
    archivesRoot: box.archivesRoot,
    execFileCmd: cli.execFileCmd,
    gatewayEnv: () => ({ PATH: process.env.PATH }),
    isGatewayRunning: async () => true,
    lifecycleLock,
    countCronJobs: () => 1,
    insertEvent,
    notify,
    logger: kSilent,
    sleep: async () => {},
    settleMs: 0,
    lockWaitMs: 200,
    ...overrides.options,
  });
  return { deleter, cli, insertEvent, notify, lifecycleLock };
};

const listArchives = (box) => {
  try {
    return fs.readdirSync(box.archivesRoot).filter((name) => name !== ".operations");
  } catch {
    return [];
  }
};

describe("agent deleter (OpenClaw's agents.delete on the serving gateway)", () => {
  it("snapshot on: snapshot, check, workspace copy, then one gateway call with deleteFiles:true; archive published and recorded", async () => {
    const box = makeBox();
    const { deleter, cli, insertEvent } = makeDeleter(box);
    const result = await deleter.deleteAgent("ops", { snapshot: true, actor: "human" });

    expect(result.outcome).toBe("deleted");
    expect(cli.calls.map((call) => call.args.slice(0, 3).join(" "))).toEqual([
      "backup sqlite create",
      "backup sqlite verify",
      "gateway call agents.delete",
    ]);
    for (const call of cli.calls) {
      expect(call.file).toBe("openclaw");
      expect(call.opts.processGroup).toBe(true);
      expect(call.opts.timeoutMs).toBeGreaterThan(0);
    }
    const deleteCall = cli.calls[2];
    expect(JSON.parse(deleteCall.args[deleteCall.args.indexOf("--params") + 1])).toEqual({ agentId: "ops", deleteFiles: true });
    expect(deleteCall.args).toContain("--json");
    expect(deleteCall.args).toContain("--timeout");

    const [archive] = listArchives(box);
    expect(archive).toMatch(/^\d{4}-\d{2}-\d{2}-ops-[0-9a-f]{6}$/);
    expect(result.archive.name).toBe(archive);
    const archiveDir = path.join(box.archivesRoot, archive);
    expect(fs.statSync(archiveDir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(archiveDir, "workspace", "NOTE.md"), "utf8")).toBe("hello\n");
    expect(fs.readFileSync(path.join(archiveDir, "workspace", "notes", "a.txt"), "utf8")).toBe("a\n");
    expect(fs.lstatSync(path.join(archiveDir, "workspace", "link.md")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, ".scratch"))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      schema: "alphaclaw.agent-archive/1",
      agentId: "ops",
      name: "Ops",
      counts: { bindings: 1, cronJobs: 1 },
      database: { snapshotId: "2026-10-28T00-00-00-000Z-snap" },
      workspace: { included: true, retainedBy: null, files: 2 },
      delete: { outcome: "deleted" },
    });
    const op = JSON.parse(fs.readFileSync(path.join(box.archivesRoot, ".operations", result.opId + ".json"), "utf8"));
    expect(op).toMatchObject({ agentId: "ops", phase: "settled", outcome: "deleted", archive });
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "agent_delete", status: "ok", details: expect.objectContaining({ agentId: "ops", outcome: "deleted", archive }) }));
  });

  it("snapshot off: no snapshot calls, no archive, still OpenClaw's delete", async () => {
    const box = makeBox();
    const { deleter, cli } = makeDeleter(box);
    const result = await deleter.deleteAgent("ops", { snapshot: false });
    expect(result).toMatchObject({ outcome: "deleted", archive: null });
    expect(cli.calls.map((call) => call.args[0])).toEqual(["gateway"]);
    expect(listArchives(box)).toEqual([]);
  });

  it("AlphaClaw itself mutates nothing under the state directory (JavaScript fs calls; OpenClaw's fake is excluded)", async () => {
    const box = makeBox();
    const mutations = [];
    const kMutating = new Set(["rm", "rmSync", "unlink", "unlinkSync", "rename", "renameSync", "writeFile", "writeFileSync", "mkdir", "mkdirSync", "copyFile", "symlink", "rmdir", "rmdirSync", "chmod", "chmodSync", "openSync", "open"]);
    const spy = (target) =>
      new Proxy(target, {
        get(object, key) {
          const value = object[key];
          if (typeof value !== "function") return value;
          return (...args) => {
            if (!kMutating.has(key)) return value.apply(object, args);
            if (key === "openSync" || key === "open") {
              if (/[wa+]/.test(String(args[1] || "r"))) mutations.push([key, String(args[0])]);
            } else if (key === "copyFile" || key === "symlink") {
              mutations.push([key, String(args[1])]);
            } else if (key === "rename" || key === "renameSync") {
              mutations.push([key, String(args[0])], [key, String(args[1])]);
            } else {
              mutations.push([key, String(args[0])]);
            }
            return value.apply(object, args);
          };
        },
      });
    const { deleter } = makeDeleter(box, { options: { fsModule: spy(fs), fsp: spy(fs.promises) } });
    await deleter.deleteAgent("ops", { snapshot: true });
    const underState = mutations.filter(([, target]) => target.startsWith(box.openclawDir + path.sep) || target === box.openclawDir);
    expect(underState).toEqual([]);
    expect(mutations.length).toBeGreaterThan(0);
  });

  it.each([
    ["the snapshot fails", { onCreate: () => Promise.reject(Object.assign(new Error("x"), { stdout: JSON.stringify({ ok: false, error: { message: "disk read failed" } }) })) }, /snapshot failed: disk read failed/],
    ["the snapshot check fails", { onVerify: () => Promise.reject(Object.assign(new Error("x"), { stderr: "integrity check failed" })) }, /snapshot check failed: integrity check failed/],
    ["the check doesn't match the snapshot", { onVerify: () => JSON.stringify({ ok: true, manifest: { artifact: { sha256: "other" } } }) }, /didn't match/],
    ["the snapshot answer isn't JSON", { onCreate: () => "Banner\n{" }, /didn't report success/],
  ])("nothing is deleted when %s: no gateway call, no archive, config untouched", async (_label, hooks, message) => {
    const box = makeBox();
    const before = fs.readFileSync(path.join(box.openclawDir, "openclaw.json"), "utf8");
    const cli = makeCli(box, hooks);
    const { deleter } = makeDeleter(box, { cli });
    await expect(deleter.deleteAgent("ops")).rejects.toThrow(message);
    expect(cli.calls.some((call) => call.args[0] === "gateway")).toBe(false);
    expect(listArchives(box)).toEqual([]);
    expect(fs.readFileSync(path.join(box.openclawDir, "openclaw.json"), "utf8")).toBe(before);
  });

  it("refuses a snapshot that wouldn't fit, before anything runs (507)", async () => {
    const box = makeBox();
    const fsp = { ...fs.promises, statfs: async () => ({ bavail: 1, bsize: 4096 }) };
    const { deleter, cli } = makeDeleter(box, { options: { fsp } });
    await expect(deleter.deleteAgent("ops")).rejects.toMatchObject({ status: 507, code: "snapshot_no_space" });
    expect(cli.calls).toEqual([]);
    expect(listArchives(box)).toEqual([]);
  });

  it("a full disk mid-copy is a 507 and leaves nothing behind", async () => {
    const box = makeBox();
    const fsp = { ...fs.promises, copyFile: async () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } };
    const { deleter, cli } = makeDeleter(box, { options: { fsp } });
    await expect(deleter.deleteAgent("ops")).rejects.toMatchObject({ status: 507 });
    expect(cli.calls.some((call) => call.args[0] === "gateway")).toBe(false);
    expect(listArchives(box)).toEqual([]);
  });

  it.each([
    ["two registered databases", { registered: [["ops", "agents/ops/agent/openclaw-agent.sqlite"], ["ops", "agents/ops/old/openclaw-agent.sqlite"]] }, /more than one database/],
    ["a relocated registration", { registered: [["ops", "elsewhere/openclaw-agent.sqlite"]] }, /standard place/],
    ["history kept in another agent's store", { extraConfig: {}, agentsDefaults: { sessionStore: { agentId: "main" } } }, /stored with agent main/],
  ])("refuses the snapshot for %s (409), and deleting without one still works", async (_label, setup, message) => {
    const box = makeBox({ registered: setup.registered });
    if (setup.agentsDefaults) {
      const cfg = box.readConfig();
      cfg.agents.defaults = setup.agentsDefaults;
      fs.writeFileSync(path.join(box.openclawDir, "openclaw.json"), JSON.stringify(cfg));
    }
    const { deleter } = makeDeleter(box);
    const preview = await deleter.preview("ops");
    expect(preview.snapshot).toMatchObject({ available: false, reason: expect.stringMatching(message) });
    await expect(deleter.deleteAgent("ops", { snapshot: true })).rejects.toMatchObject({ status: 409, code: "snapshot_unavailable" });
    await expect(deleter.deleteAgent("ops", { snapshot: false })).resolves.toMatchObject({ outcome: "deleted" });
  });

  it("an agent with no database yet keeps its workspace only", async () => {
    const box = makeBox({ registered: [["main", "agents/main/agent/openclaw-agent.sqlite"]] });
    fs.rmSync(path.join(box.agentDir, "openclaw-agent.sqlite"));
    const { deleter, cli } = makeDeleter(box);
    const preview = await deleter.preview("ops");
    expect(preview.history.hasDatabase).toBe(false);
    const result = await deleter.deleteAgent("ops");
    expect(result.archive).toMatchObject({ noChatHistory: true, workspaceIncluded: true });
    expect(cli.calls.map((call) => call.args[0])).toEqual(["gateway"]);
  });

  it("copies a custom workspace outside the state dir, and leaves one a surviving agent uses where it is", async () => {
    const box = makeBox();
    const custom = path.join(box.root, "elsewhere", "ops-ws");
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, "x.md"), "x");
    const cfg = box.readConfig();
    cfg.agents.list[1].workspace = custom;
    fs.writeFileSync(path.join(box.openclawDir, "openclaw.json"), JSON.stringify(cfg));
    const { deleter } = makeDeleter(box);
    const result = await deleter.deleteAgent("ops");
    expect(fs.readFileSync(path.join(box.archivesRoot, result.archive.name, "workspace", "x.md"), "utf8")).toBe("x");

    const shared = makeBox();
    const sharedCfg = shared.readConfig();
    sharedCfg.agents.list[1].workspace = path.join(shared.openclawDir, "workspace", "ops");
    fs.mkdirSync(sharedCfg.agents.list[1].workspace, { recursive: true });
    fs.writeFileSync(path.join(shared.openclawDir, "openclaw.json"), JSON.stringify(sharedCfg));
    const sharedDeleter = makeDeleter(shared).deleter;
    expect((await sharedDeleter.preview("ops")).workspace.retainedBy).toBe("main");
    const sharedResult = await sharedDeleter.deleteAgent("ops");
    expect(sharedResult.archive.workspaceIncluded).toBe(false);
    expect(fs.existsSync(path.join(shared.archivesRoot, sharedResult.archive.name, "workspace"))).toBe(false);
  });

  it("skips sockets and FIFOs in the workspace and lists them", async () => {
    const box = makeBox();
    require("child_process").execFileSync("mkfifo", [path.join(box.opsWorkspace, "pipe")]);
    const { deleter } = makeDeleter(box);
    const result = await deleter.deleteAgent("ops");
    const manifest = JSON.parse(fs.readFileSync(path.join(box.archivesRoot, result.archive.name, "manifest.json"), "utf8"));
    expect(manifest.workspace.skipped).toEqual([{ path: "pipe", reason: "fifo" }]);
  });

  it("keeps AlphaClaw's refusals in front, with the messages the Agents tab has always shown", async () => {
    const box = makeBox({
      agents: {
        defaults: { authInheritance: { agentId: "auth" }, sessionStore: { agentId: "store" } },
        list: [{ id: "main" }, { id: "ops", default: true }, { id: "auth" }, { id: "store" }, { id: "free" }],
      },
    });
    const { deleter, cli } = makeDeleter(box);
    await expect(deleter.deleteAgent("main")).rejects.toMatchObject({ status: 400, message: "The default main agent cannot be deleted" });
    await expect(deleter.deleteAgent("ops")).rejects.toMatchObject({ status: 400, message: "Default agent cannot be deleted" });
    await expect(deleter.deleteAgent("auth")).rejects.toThrow('Agent "auth" owns agents.defaults.authInheritance and cannot be deleted');
    await expect(deleter.deleteAgent("store")).rejects.toThrow('Agent "store" owns agents.defaults.sessionStore and cannot be deleted');
    await expect(deleter.deleteAgent("ghost")).rejects.toMatchObject({ status: 404 });
    await expect(deleter.deleteAgent("../x")).rejects.toMatchObject({ status: 404 });
    expect(cli.calls).toEqual([]);
  });

  it("409 while the gateway isn't serving or a lifecycle operation is running; no CLI call", async () => {
    const box = makeBox();
    const down = makeDeleter(box, { options: { isGatewayRunning: async () => false } });
    await expect(down.deleter.deleteAgent("ops")).rejects.toMatchObject({ status: 409, code: "gateway_not_serving" });
    expect(down.cli.calls).toEqual([]);

    const lifecycleLock = createGatewayLifecycleLock({ logger: kSilent });
    const release = await lifecycleLock.acquire("restart");
    const busy = makeDeleter(box, { lifecycleLock });
    await expect(busy.deleter.deleteAgent("ops")).rejects.toMatchObject({ status: 409, code: "gateway_not_serving" });
    release();
  });

  it("a lifecycle hold that outlasts the bounded wait after the snapshot: 409, archive removed, nothing sent", async () => {
    const box = makeBox();
    const lifecycleLock = createGatewayLifecycleLock({ logger: kSilent });
    let release = null;
    const cli = makeCli(box, {
      onVerify: async () => {
        release = await lifecycleLock.acquire("restart");
        return JSON.stringify({ ok: true, manifest: { artifact: { sha256: "abc" } } });
      },
    });
    const { deleter } = makeDeleter(box, { lifecycleLock, cli });
    await expect(deleter.deleteAgent("ops")).rejects.toMatchObject({ status: 409, code: "lifecycle_busy" });
    expect(cli.calls.some((call) => call.args[0] === "gateway")).toBe(false);
    expect(listArchives(box)).toEqual([]);
    release();
  });

  it("re-checks the config after taking the lock: an agent made default during the snapshot isn't deleted", async () => {
    const box = makeBox();
    const cli = makeCli(box, {
      onVerify: async () => {
        const cfg = box.readConfig();
        cfg.agents.list = cfg.agents.list.map((entry) => ({ ...entry, default: entry.id === "ops" }));
        fs.writeFileSync(path.join(box.openclawDir, "openclaw.json"), JSON.stringify(cfg));
        return JSON.stringify({ ok: true, manifest: { artifact: { sha256: "abc" } } });
      },
    });
    const { deleter } = makeDeleter(box, { cli });
    await expect(deleter.deleteAgent("ops")).rejects.toThrow("Default agent cannot be deleted");
    expect(cli.calls.some((call) => call.args[0] === "gateway")).toBe(false);
    expect(listArchives(box)).toEqual([]);
  });

  it("holds AlphaClaw's config writes off (409) from the lock until the read-back, then lets them through", async () => {
    const box = makeBox();
    let blocked = null;
    const cli = makeCli(box, {
      onDelete: (params) => {
        try {
          updateOpenclawConfig({ openclawDir: box.openclawDir, mutate: (cfg) => { cfg.touched = true; } });
        } catch (error) {
          blocked = error;
        }
        openclawDeletes(box, params.agentId);
        return JSON.stringify({ ok: true, removed: [], failed: [] });
      },
    });
    const { deleter } = makeDeleter(box, { cli });
    await deleter.deleteAgent("ops", { snapshot: false });
    expect(blocked).toMatchObject({ code: "OPENCLAW_CONFIG_WRITE_BLOCKED", status: 409, message: "An agent is being deleted. Try again in a moment." });
    updateOpenclawConfig({ openclawDir: box.openclawDir, mutate: (cfg) => { cfg.touched = true; } });
    expect(readOpenclawConfig({ openclawDir: box.openclawDir }).touched).toBe(true);
  });

  it("one delete at a time", async () => {
    const box = makeBox({ agents: { list: [{ id: "main", default: true }, { id: "ops" }, { id: "ops2" }] } });
    let unblock;
    const cli = makeCli(box, {
      onDelete: async (params) => {
        await new Promise((resolve) => { unblock = resolve; });
        openclawDeletes(box, params.agentId);
        return JSON.stringify({ ok: true, removed: [], failed: [] });
      },
    });
    const { deleter } = makeDeleter(box, { cli });
    const first = deleter.deleteAgent("ops", { snapshot: false });
    await vi.waitFor(() => expect(unblock).toBeTypeOf("function"));
    await expect(deleter.deleteAgent("ops2", { snapshot: false })).rejects.toMatchObject({ status: 409, code: "delete_running" });
    await expect(deleter.deleteAgent("ops", { snapshot: false })).rejects.toThrow("This agent is already being deleted.");
    expect(deleter.listDeletions().running).toEqual({ agentId: "ops" });
    unblock();
    await expect(first).resolves.toMatchObject({ outcome: "deleted" });
  });

  it("an explicit OpenClaw refusal with the agent still configured is not_deleted; the archive is kept and labelled", async () => {
    const box = makeBox();
    const cli = makeCli(box, {
      onDelete: () => Promise.reject(Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ ok: false, error: { code: "INVALID_REQUEST", message: 'agent "ops" is the only configured agent' } }) })),
    });
    const { deleter } = makeDeleter(box, { cli });
    const result = await deleter.deleteAgent("ops");
    expect(result.outcome).toBe("not_deleted");
    expect(result.message).toContain("is the only configured agent");
    const manifest = JSON.parse(fs.readFileSync(path.join(box.archivesRoot, result.archive.name, "manifest.json"), "utf8"));
    expect(manifest.delete.outcome).toBe("not_deleted");
  });

  it("decides from the read-back: a timed-out call the gateway finished is deleted, an error after commit is deleted", async () => {
    const timedOut = makeBox();
    const slow = makeCli(timedOut, {
      onDelete: (params) => {
        openclawDeletes(timedOut, params.agentId);
        return Promise.reject(Object.assign(new Error("timeout"), { timedOut: true }));
      },
    });
    expect((await makeDeleter(timedOut, { cli: slow }).deleter.deleteAgent("ops", { snapshot: false })).outcome).toBe("deleted");

    const uncertain = makeBox();
    const saved = makeCli(uncertain, {
      onDelete: (params) => {
        openclawDeletes(uncertain, params.agentId);
        return Promise.reject(Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ ok: false, error: { code: "UNAVAILABLE", message: "config saved but its application to the active Gateway was not confirmed" } }) }));
      },
    });
    expect((await makeDeleter(uncertain, { cli: saved }).deleter.deleteAgent("ops", { snapshot: false })).outcome).toBe("deleted");
  });

  it("a timed-out call with no deletion record after the settle window is not_deleted; one still in progress is unknown until it settles", async () => {
    const box = makeBox();
    const lost = makeCli(box, { onDelete: () => Promise.reject(Object.assign(new Error("t"), { timedOut: true })) });
    expect((await makeDeleter(box, { cli: lost }).deleter.deleteAgent("ops", { snapshot: false })).outcome).toBe("not_deleted");

    const facts = { configured: false, stateReadable: true, journal: { complete: false } };
    expect(classifyDeletion({ facts, answer: { kind: "none" } })).toBe("unknown");
    expect(classifyDeletion({ facts, answer: { kind: "none" }, settled: true })).toBe("cleanup_incomplete");
    expect(classifyDeletion({ facts: { configured: null, stateReadable: true }, answer: { kind: "ok" }, settled: true })).toBe("unknown");
    expect(classifyDeletion({ facts: { configured: false, stateReadable: true, journal: null }, answer: { kind: "ok" } })).toBe("config_only");
  });

  it("a purge OpenClaw couldn't finish is cleanup_incomplete; Finish deleting resends without a new snapshot", async () => {
    const box = makeBox();
    let first = true;
    const cli = makeCli(box, {
      onDelete: (params) => {
        openclawDeletes(box, params.agentId, { complete: !first });
        const purgeFailed = first;
        first = false;
        return JSON.stringify({ ok: true, removed: [], failed: [], ...(purgeFailed ? { purgeFailed: true } : {}) });
      },
    });
    const { deleter } = makeDeleter(box, { cli });
    expect((await deleter.deleteAgent("ops")).outcome).toBe("cleanup_incomplete");
    expect(await deleter.preview("ops")).toMatchObject({ state: "cleanup_incomplete" });
    expect(deleter.listDeletions().deletions).toEqual([expect.objectContaining({ agentId: "ops", outcome: "cleanup_incomplete" })]);
    const callsBefore = cli.calls.length;
    expect((await deleter.finishDelete("ops")).outcome).toBe("deleted");
    expect(cli.calls.slice(callsBefore).map((call) => call.args[0])).toEqual(["gateway"]);
    expect(listArchives(box)).toHaveLength(1);
    await expect(deleter.finishDelete("ops")).rejects.toMatchObject({ status: 409, code: "nothing_to_finish" });
  });

  it("lists deletions OpenClaw journaled but didn't finish, whoever started them", async () => {
    const box = makeBox();
    box.exec("INSERT INTO agent_deletion_journal (agent_id, operation_id, cleanup_completed, delete_files) VALUES ('old', 'x', 0, 1)");
    const { deleter } = makeDeleter(box);
    expect(deleter.listDeletions().deletions).toEqual([expect.objectContaining({ agentId: "old", outcome: "cleanup_incomplete", opId: null })]);
  });

  it("after a restart: settles a delete that was sent but never answered, from OpenClaw's facts, and tells the owner once", async () => {
    const box = makeBox();
    const cli = makeCli(box, { onDelete: () => new Promise(() => {}) });
    const first = makeDeleter(box, { cli });
    first.deleter.deleteAgent("ops").catch(() => {});
    await vi.waitFor(() => expect(cli.calls.some((call) => call.args[0] === "gateway")).toBe(true));
    openclawDeletes(box, "ops");
    fs.mkdirSync(path.join(box.archivesRoot, ".staging-2026-10-28-x-abcdef"));

    const restarted = makeDeleter(box);
    expect(restarted.deleter.cleanupStaging()).toBe(1);
    const settled = await restarted.deleter.reconcileInterrupted();
    expect(settled).toEqual([expect.objectContaining({ agentId: "ops", outcome: "deleted", interrupted: true })]);
    expect(restarted.notify).toHaveBeenCalledTimes(1);
    expect(restarted.notify.mock.calls[0][0]).toMatch(/restarted while deleting agent ops\. Deleted ops\. Its snapshot was kept as \d{4}-\d{2}-\d{2}-ops-/);
    expect(await restarted.deleter.reconcileInterrupted()).toEqual([]);
    expect(listArchives(box)).toHaveLength(1);
  });

  it("preview: counts, sizes, workspace and snapshot verdict", async () => {
    const box = makeBox();
    const { deleter } = makeDeleter(box);
    const preview = await deleter.preview("ops");
    expect(preview).toMatchObject({
      agentId: "ops",
      name: "Ops",
      state: "configured",
      refusal: null,
      gatewayServing: true,
      busy: false,
      counts: { bindings: 1, cronJobs: 1 },
      history: { hasDatabase: true, bytes: 4096 + 2048 },
      workspace: { path: box.opsWorkspace, exists: true, files: 2, retainedBy: null },
      snapshot: { available: true, reason: null },
    });
    expect(preview.snapshot.neededBytes).toBeGreaterThan(2 * (4096 + 2048));
    expect((await deleter.preview("main")).refusal).toBe("The default main agent cannot be deleted");
    await expect(deleter.preview("ghost")).rejects.toMatchObject({ status: 404 });
  });
});
