const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const request = require("supertest");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-auth-kv-"));
process.env.ALPHACLAW_ROOT_DIR = root;
const { createAuthProfiles } = require("../../lib/server/auth-profiles");
const { registerCodexRoutes } = require("../../lib/server/routes/codex");
const { registerModelRoutes } = require("../../lib/server/routes/models");
const { beginStateDbQuiet, getStateDbHandleCount } = require("../../lib/server/state-db-quiet");
const ap = createAuthProfiles();
const databasePath = path.join(root, ".openclaw", "state", "openclaw.sqlite");
const secrets = () => ({ version: 1, future: { keep: [1, 2] }, profiles: {
  "openai-codex:default": { type: "oauth", provider: "openai", access: "synthetic-access", refresh: "synthetic-refresh", extension: "keep" },
  "other:oauth": { type: "oauth", provider: "other", access: "synthetic-old", refresh: "synthetic-other" },
  "anthropic:default": { type: "api_key", provider: "anthropic", key: "synthetic-key" },
} });
const state = () => ({ version: 1, futureState: { keep: true }, order: { other: ["other:oauth"] }, lastGood: { other: "other:oauth" }, usageStats: { "other:oauth": { lastUsed: 1, unknown: true } } });
const seed = (version = 17, { store = secrets(), runtime = state() } = {}) => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA user_version = ${version}; PRAGMA journal_mode = WAL;
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT`);
  db.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)").run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
  if (version === 12) {
    db.exec("CREATE TABLE auth_profile_stores (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT; CREATE TABLE auth_profile_state (store_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT");
    if (store !== undefined) db.prepare("INSERT INTO auth_profile_stores VALUES ('shared', ?, 1)").run(JSON.stringify(store));
    if (runtime !== undefined) db.prepare("INSERT INTO auth_profile_state VALUES ('shared', ?, 1)").run(JSON.stringify(runtime));
  } else {
    db.prepare("INSERT INTO config_machine_state VALUES ('authProfiles.store', ?, 1)").run(JSON.stringify(store));
    db.prepare("INSERT INTO config_machine_state VALUES ('authProfiles.state', ?, 1)").run(JSON.stringify(runtime));
  }
  db.close();
};
const read = (version = 17) => {
  const db = new DatabaseSync(databasePath);
  try {
    if (version === 12) return {
      store: JSON.parse(db.prepare("SELECT store_json FROM auth_profile_stores WHERE store_key = 'shared'").get().store_json),
      runtime: JSON.parse(db.prepare("SELECT state_json FROM auth_profile_state WHERE store_key = 'shared'").get().state_json),
    };
    return { store: JSON.parse(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get().value_json), runtime: JSON.parse(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.state'").get().value_json) };
  } finally { db.close(); }
};
afterEach(() => { fs.rmSync(path.join(root, ".openclaw"), { recursive: true, force: true }); });
afterAll(() => { delete process.env.ALPHACLAW_ROOT_DIR; fs.rmSync(root, { recursive: true, force: true }); });

describe.each([12, 13, 16, 17])("auth shared schema %s", (version) => {
  it.each([["api_key", "key", "keyRef"], ["token", "token", "tokenRef"]])("replaces inherited %s references only for a new nonempty inline source", (type, field, refField) => {
    seed(version);
    const id = "referenced:default";
    const firstRef = { source: "env", provider: "default", id: "SYNTHETIC_OLD_AUTH" };
    const explicitRef = { source: "env", provider: "default", id: "SYNTHETIC_EXPLICIT_AUTH" };
    ap.upsertProfile(id, { type, provider: "referenced", [refField]: firstRef, extension: { keep: true } });
    ap.upsertProfile(id, { type, provider: "referenced", email: "synthetic@example.invalid" });
    expect(ap.getProfile(id)[refField]).toEqual(firstRef);
    ap.upsertProfile(id, { type, provider: "referenced", [field]: " \n " });
    expect(ap.getProfile(id)[refField]).toEqual(firstRef);
    ap.upsertProfile(id, { type, provider: "referenced", [field]: "synthetic-inline", [refField]: explicitRef });
    expect(ap.getProfile(id)[refField]).toEqual(explicitRef);
    ap.upsertProfile(id, { type, provider: "referenced", [field]: " synthetic-edited\n " });
    const updated = read(version).store.profiles[id];
    expect(updated[field]).toBe("synthetic-edited");
    expect(updated).not.toHaveProperty(refField);
    expect(updated.extension).toEqual({ keep: true });
    expect(updated.email).toBe("synthetic@example.invalid");
    expect(read(version).store.profiles["other:oauth"]).toEqual(secrets().profiles["other:oauth"]);
  });

  it("reads connected credentials and all mutation callers preserve unrelated data and unknown fields", () => {
    seed(version);
    expect(ap.getCodexProfile().access).toBe("synthetic-access");
    expect(ap.getAuthStoreAvailability()).toEqual({ unavailable: false, reason: null });
    ap.upsertCodexProfile({ access: "synthetic-new", refresh: "synthetic-new-refresh", expires: 1 });
    ap.upsertApiKeyProfileForEnvVar("openai", "synthetic-api-key");
    ap.setAuthOrder("openai", ["openai:default"]);
    expect(ap.removeApiKeyProfileForEnvVar("anthropic")).toBe(true);
    expect(ap.removeProfile("openai:default")).toBe(true);
    let saved = read(version);
    expect(saved.store.future).toEqual(secrets().future);
    expect(saved.store.profiles["openai-codex:default"].extension).toBe("keep");
    expect(saved.store.profiles["other:oauth"]).toEqual(secrets().profiles["other:oauth"]);
    expect(saved.runtime).toEqual({ ...state(), order: { other: ["other:oauth"], openai: ["openai:default"] } });
    expect(ap.removeCodexProfiles()).toBe(true);
    saved = read(version);
    expect(Object.keys(saved.store.profiles)).toEqual(["other:oauth"]);
    expect(fs.existsSync(path.join(root, ".openclaw", "agents", "main", "agent", "auth-profiles.json"))).toBe(false);
  });
  it.each(["", "null", "false", "42", "[]", "{", '{"profiles":[]}', '{"profiles":null}'])("refuses malformed store %s without altering credentials or state", (raw) => {
    seed(version);
    const db = new DatabaseSync(databasePath);
    const update = version === 12 ? "UPDATE auth_profile_stores SET store_json = ?" : "UPDATE config_machine_state SET value_json = ? WHERE state_key = 'authProfiles.store'";
    db.prepare(update).run(raw);
    db.close();
    expect(ap.loadAuthStore()).toMatchObject({ unavailable: true, reason: "AUTH_STORE_UNREADABLE" });
    expect(ap.getAuthStoreAvailability().unavailable).toBe(true);
    for (const mutate of [
      () => ap.upsertCodexProfile({ access: "new", refresh: "new" }),
      () => ap.removeProfile("other:oauth"),
      () => ap.removeApiKeyProfileForEnvVar("anthropic"),
      () => ap.removeCodexProfiles(),
      () => ap.setAuthOrder("other", []),
    ]) expect(mutate).toThrow(expect.objectContaining({ code: "AUTH_STORE_UNREADABLE" }));
    const verify = new DatabaseSync(databasePath);
    expect(verify.prepare(version === 12 ? "SELECT store_json AS raw FROM auth_profile_stores" : "SELECT value_json AS raw FROM config_machine_state WHERE state_key = 'authProfiles.store'").get().raw).toBe(raw);
    verify.close();
  });
});

it("treats missing rows as empty, but rejects malformed runtime state and unknown schemas", () => {
  seed();
  let db = new DatabaseSync(databasePath);
  db.exec("DELETE FROM config_machine_state WHERE state_key IN ('authProfiles.store', 'authProfiles.state')");
  db.close();
  expect(ap.getAuthStoreAvailability().unavailable).toBe(false);
  ap.upsertProfile("openai:default", { type: "api_key", provider: "openai", key: "synthetic" });
  db = new DatabaseSync(databasePath);
  db.exec("UPDATE config_machine_state SET value_json = '[]' WHERE state_key = 'authProfiles.state'");
  db.close();
  expect(() => ap.setAuthOrder("openai", [])).toThrow(expect.objectContaining({ code: "AUTH_STORE_UNREADABLE" }));
  db = new DatabaseSync(databasePath);
  db.exec("PRAGMA user_version = 999");
  db.close();
  expect(ap.getAuthStoreAvailability().unavailable).toBe(true);
});

it("rolls back both documents when the second write fails", () => {
  seed();
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TRIGGER refuse_state BEFORE UPDATE ON config_machine_state WHEN NEW.state_key = 'authProfiles.state' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  db.close();
  expect(() => ap.upsertProfile("new", { type: "api_key", provider: "openai", key: "synthetic" })).toThrow(expect.objectContaining({ code: "AUTH_STORE_UNREADABLE" }));
  expect(read()).toEqual({ store: secrets(), runtime: state() });
  expect(getStateDbHandleCount()).toBe(0);
});

it("does not report malformed ownership or denied reads as disconnected", () => {
  seed();
  fs.chmodSync(databasePath, 0);
  try {
    expect(ap.getAuthStoreAvailability().unavailable).toBe(true);
    expect(() => ap.removeCodexProfiles()).toThrow(expect.objectContaining({ code: "AUTH_STORE_UNREADABLE" }));
  } finally { fs.chmodSync(databasePath, 0o600); }
  expect(read()).toEqual({ store: secrets(), runtime: state() });
  const db = new DatabaseSync(databasePath);
  for (const raw of ["null", "[]", "false", "{}", "", '{"location":"future"}']) {
    db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = 'auth.sharedStore'").run(raw);
    expect(ap.loadAuthStore()).toMatchObject({ unavailable: true, reason: "AUTH_STORE_UNREADABLE" });
    expect(() => ap.upsertProfile("x", { type: "token", provider: "x", token: "synthetic" })).toThrow(expect.objectContaining({ code: "AUTH_STORE_UNREADABLE" }));
  }
  db.close();
});

it("preserves extension fields when replacing a named credential", () => {
  seed();
  ap.upsertProfile("other:oauth", { type: "oauth", provider: "other", access: "new", refresh: "new", futureCredential: { keep: true } });
  ap.upsertProfile("other:oauth", { type: "oauth", provider: "other", access: "newer", refresh: "newer" });
  expect(read().store.profiles["other:oauth"]).toMatchObject({ access: "newer", futureCredential: { keep: true } });
});

it("refuses a malformed file-era store instead of erasing its bytes", () => {
  const dir = path.join(root, ".openclaw", "agents", "main", "agent");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "auth-profiles.json");
  const raw = '{"profiles":{"private":"synthetic-secret"}';
  fs.writeFileSync(file, raw);
  expect(ap.getAuthStoreAvailability().unavailable).toBe(true);
  let error;
  try { ap.upsertProfile("x", { type: "api_key", provider: "x", key: "new" }); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "AUTH_STORE_UNREADABLE" });
  expect(require("node:util").inspect(error)).not.toContain("synthetic-secret");
  expect(fs.readFileSync(file, "utf8")).toBe(raw);
});

it("preserves the quiet barrier for reads, every mutation, and initialization", async () => {
  seed();
  const { token } = await beginStateDbQuiet({ owner: "auth-test", maxMs: 60_000 });
  const restartRequiredState = { markRequired: vi.fn() };
  try {
    expect(ap.getAuthStoreAvailability()).toEqual({ unavailable: true, reason: "backup_in_progress" });
    expect(await ap.refreshGatewayAuth(undefined, restartRequiredState)).toMatchObject({ authRuntimeRefreshed: false, restartRequired: true });
    expect(restartRequiredState.markRequired).not.toHaveBeenCalled();
    expect(() => ap.removeApiKeyProfileForEnvVar("anthropic")).toThrow(expect.objectContaining({ code: "backup_in_progress" }));
    expect(read()).toEqual({ store: secrets(), runtime: state() });
  } finally { token.release(); }
  await vi.waitFor(() => expect(restartRequiredState.markRequired).toHaveBeenCalledWith("config_changed"));
});

it("distinguishes persisted credentials from failed gateway activation and preserves the saved store", async () => {
  seed();
  const refreshRuntime = vi.fn().mockResolvedValueOnce({ refreshed: false }).mockResolvedValueOnce({ refreshed: true });
  const local = createAuthProfiles({ refreshRuntime });
  const restartRequiredState = { markRequired: vi.fn() };
  local.upsertProfile("other:oauth", { type: "oauth", provider: "other", access: "updated", refresh: "updated" });
  expect(await local.refreshGatewayAuth("main", restartRequiredState)).toMatchObject({ authRuntimeRefreshed: false, restartRequired: true, warning: expect.stringContaining("Credential changes were saved") });
  expect(read().store.profiles["other:oauth"].access).toBe("updated");
  expect(restartRequiredState.markRequired).toHaveBeenCalledOnce();
  expect(await local.refreshGatewayAuth("main", restartRequiredState)).toEqual({ authRuntimeRefreshed: true });
  expect(restartRequiredState.markRequired).toHaveBeenCalledOnce();
});

it.each([true, false])("serializes an external refresh and mutation (external first: %s)", async (externalFirst) => {
  seed();
  const signal = new Int32Array(new SharedArrayBuffer(16));
  let worker;
  let finished;
  const start = () => {
    worker = new Worker(path.join(__dirname, "..", "helpers", "auth-refresh-worker.js"), { workerData: { databasePath, signal: signal.buffer, hold: externalFirst } });
    finished = new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", (code) => code ? reject(new Error(`worker exited ${code}`)) : resolve()); });
    finished.catch(() => {});
    const index = externalFirst ? 1 : 0;
    while (!Atomics.load(signal, index)) {
      if (Atomics.wait(signal, index, 0, 3000) === "timed-out") throw new Error("refresh worker did not start");
    }
  };
  const original = DatabaseSync.prototype.prepare;
  let intercepted = false;
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    if (!externalFirst && !intercepted && sql.startsWith("SELECT value_json AS value")) {
      intercepted = true;
      start();
      Atomics.wait(signal, 1, 0, 150);
      expect(Atomics.load(signal, 1)).toBe(0);
    }
    return original.call(this, sql);
  });
  try {
    if (externalFirst) { start(); Atomics.store(signal, 2, 1); Atomics.notify(signal, 2); }
    ap.upsertProfile("new:default", { type: "api_key", provider: "new", key: "synthetic-new" });
    await finished;
    expect(read().store.profiles["other:oauth"].access).toBe("synthetic-refreshed");
    expect(read().store.profiles["new:default"].key).toBe("synthetic-new");
  } finally { spy.mockRestore(); await worker?.terminate(); }
});

it("reports corruption as unavailable in Codex and Models routes and fails mutations closed", async () => {
  seed();
  const app = express();
  app.use(express.json());
  const changed = vi.fn();
  const markStale = vi.fn();
  registerCodexRoutes({ app, authProfiles: ap, onAuthChanged: changed });
  registerModelRoutes({ app, authProfiles: ap, modelCatalogCache: { markStale }, readEnvFile: () => [] });
  expect((await request(app).get("/api/codex/status")).body.connected).toBe(true);
  const db = new DatabaseSync(databasePath);
  db.exec("UPDATE config_machine_state SET value_json = '{' WHERE state_key = 'authProfiles.store'");
  db.close();
  for (const route of ["/api/codex/status", "/api/models/auth", "/api/models/config"]) {
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unavailable: true, reason: "AUTH_STORE_UNREADABLE" });
    expect(JSON.stringify(res.body)).not.toContain("synthetic-");
  }
  expect((await request(app).post("/api/codex/disconnect")).status).toBe(503);
  expect((await request(app).delete("/api/models/auth/other:oauth")).status).toBe(503);
  expect(changed).not.toHaveBeenCalled();
  expect(markStale).not.toHaveBeenCalled();
});
