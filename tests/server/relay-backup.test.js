const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { backupRelay } = require("../../lib/server/relay/backup");
const { relayPaths } = require("../../lib/server/relay/constants");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { planRetention } = require("../../lib/server/copy-retention");
const { provisionRelay } = require("../../lib/server/relay/provision");

describe("relay backup", () => {
  let root;
  let paths;
  let backupsDir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-backup-"));
    paths = relayPaths(root);
    backupsDir = path.join(root, "backups", "openclaw");
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(backupsDir, { recursive: true });
    const engineDb = new DatabaseSync(paths.engineDb);
    engineDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages (id TEXT, text TEXT); INSERT INTO messages VALUES ('1', 'hello');");
    engineDb.close();
    const store = openBridgeStore({ dbPath: paths.bridgeDb });
    store.insert({ messageId: "1", sender: "capy-1", conversationId: "dm", threadRoot: "1", sessionKey: "agent:main:relay-capy-1" });
    store.close();
    fs.writeFileSync(paths.secretsFile, JSON.stringify({ version: 1, state: "ready", workspaceId: "ws", workspaceKey: "rk_live_x", boxAgent: "wintermute", agents: { wintermute: { token: "at_live_x" } } }), { mode: 0o600 });
    fs.writeFileSync(paths.internalSecretFile, "a".repeat(64), { mode: 0o600 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes verified copies of both databases and the keys beside the archive, private", () => {
    const archivePath = path.join(backupsDir, "2026-11-06T10-00-00.000Z-openclaw-backup.tar.gz");
    const result = backupRelay({ paths, backupsDir, archivePath });
    expect(result.ok).toBe(true);
    expect(path.basename(result.path)).toBe("2026-11-06T10-00-00.000Z-relay-backup");
    expect(Object.keys(result.files).sort()).toEqual(["bridge.db", "internal.secret", "relaycast.db", "secrets.json"]);
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o700);
    for (const name of Object.keys(result.files)) expect(fs.statSync(path.join(result.path, name)).mode & 0o777).toBe(0o600);
    const copy = new DatabaseSync(path.join(result.path, "relaycast.db"), { readOnly: true });
    expect(copy.prepare("SELECT text FROM messages").get().text).toBe("hello");
    copy.close();
    expect(fs.readdirSync(backupsDir).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("is skipped before the relay was ever provisioned", () => {
    fs.rmSync(paths.secretsFile);
    expect(backupRelay({ paths, backupsDir })).toEqual({ ok: true, skipped: "not_provisioned" });
  });

  it("restores: the copied files bring back the same workspace, without secrets_missing", async () => {
    const { path: backupDir } = backupRelay({ paths, backupsDir, archivePath: null });
    const restoredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-restore-"));
    const restored = relayPaths(restoredRoot);
    fs.mkdirSync(restored.dir, { recursive: true, mode: 0o700 });
    for (const name of ["relaycast.db", "bridge.db", "secrets.json", "internal.secret"]) {
      fs.copyFileSync(path.join(backupDir, name), path.join(restored.dir, name));
    }
    const client = { inbox: async () => ({}), createWorkspace: vi.fn(), registerAgent: vi.fn() };
    const auth = await provisionRelay({ client, paths: restored, agentName: "wintermute", engineDbExistedAtStart: true, logger: { log() {}, warn() {} } });
    expect(auth).toMatchObject({ workspaceKey: "rk_live_x", agentToken: "at_live_x" });
    expect(client.createWorkspace).not.toHaveBeenCalled();
    const store = openBridgeStore({ dbPath: restored.bridgeDb });
    expect(store.get("1").sender).toBe("capy-1");
    store.close();
    fs.rmSync(restoredRoot, { recursive: true, force: true });
  });

  it("old relay backups are swept with the archives; a look-alike directory without the marker is kept", () => {
    const old = Date.parse("2026-10-01T00:00:00Z");
    const names = [];
    for (let index = 0; index < 5; index += 1) {
      const { path: dir } = backupRelay({ paths, backupsDir, now: () => old + index * 1000 });
      fs.utimesSync(path.join(dir, "manifest.json"), (old + index * 1000) / 1000, (old + index * 1000) / 1000);
      names.push(path.basename(dir));
    }
    const lookAlike = path.join(backupsDir, "2026-01-01T00-00-00.000Z-relay-backup");
    fs.mkdirSync(lookAlike);
    const plan = planRetention({ backupsDir, env: {}, nowMs: Date.parse("2026-11-06T00:00:00Z") });
    const family = plan.families.find((entry) => entry.id === "relay_backups");
    const verdicts = Object.fromEntries(family.entries.map((entry) => [entry.name, entry.verdict]));
    expect(names.slice(2).map((name) => verdicts[name])).toEqual(["kept_newest", "kept_newest", "kept_newest"]);
    expect(names.slice(0, 2).map((name) => verdicts[name])).toEqual(["due", "due"]);
    expect(verdicts[path.basename(lookAlike)]).toBe("not_managed");
  });
});
