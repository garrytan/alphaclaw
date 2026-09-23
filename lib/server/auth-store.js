const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { OPENCLAW_DIR } = require("./constants");
const { isValidAgentId } = require("./agents/shared");
const { writeFileAtomic, withFileLockSync } = require("./utils/safe-file");
const {
  resolveOpenclawStateDbPath,
  openTrackedReadonlyDatabase,
  openWritableOpenclawStateDb,
} = require("./openclaw-state-db");
const { readAuthSharedStoreLocation, tableHasColumns } = require("./openclaw-state-era");
const { isStateDbQuiet, StateDbQuietError, kBackupInProgressCode, enterStateDbHandle, exitStateDbHandle } = require("./state-db-quiet");

const resolveAgentDir = (agentId = "main") => {
  if (!isValidAgentId(agentId)) throw new Error(`Invalid agent id: ${JSON.stringify(String(agentId))}`);
  return path.join(OPENCLAW_DIR, "agents", String(agentId).trim(), "agent");
};
const statePath = () => resolveOpenclawStateDbPath({ openclawDir: OPENCLAW_DIR });
const unreadable = (filePath) => Object.assign(
  new Error(`Could not read or update the ${filePath === statePath() ? "shared OpenClaw" : "agent"} auth store — retry shortly or repair the store with OpenClaw Doctor`),
  { code: "AUTH_STORE_UNREADABLE", filePath },
);
const assertAvailable = () => {
  if (isStateDbQuiet()) throw new StateDbQuietError();
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const parseCell = (raw) => {
  if (raw === undefined) return {};
  const value = JSON.parse(raw);
  if (!isObject(value)) throw new Error("Auth store cell is not an object");
  return value;
};
const validateStore = (store) => {
  if (store.profiles !== undefined && !isObject(store.profiles)) throw new Error("Invalid profiles map");
  for (const key of ["order", "lastGood", "usageStats"]) {
    if (store[key] !== undefined && !isObject(store[key])) throw new Error(`Invalid auth ${key}`);
  }
  return { ...store, version: store.version ?? 1, profiles: store.profiles ?? {} };
};
const sharedLayout = (db) => {
  const version = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (version >= 13 && version <= 17 && tableHasColumns(db, "config_machine_state", ["state_key", "value_json", "updated_at_ms"])) {
    return [
      ["config_machine_state", "state_key", "value_json", "updated_at_ms", "authProfiles.store"],
      ["config_machine_state", "state_key", "value_json", "updated_at_ms", "authProfiles.state"],
    ];
  }
  if (version === 12 && tableHasColumns(db, "auth_profile_stores", ["store_key", "store_json", "updated_at"]) &&
      tableHasColumns(db, "auth_profile_state", ["store_key", "state_json", "updated_at"])) {
    return [
      ["auth_profile_stores", "store_key", "store_json", "updated_at", "shared"],
      ["auth_profile_state", "store_key", "state_json", "updated_at", "shared"],
    ];
  }
  throw new Error("Unsupported shared auth schema");
};
const agentLayout = (db) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE name IN (?, ?)").all("auth_profile_store", "auth_profile_state");
  if (!tables.length) {
    if (Number(db.prepare("PRAGMA user_version").get().user_version) > 0) throw new Error("Missing agent auth tables");
    return null;
  }
  if (!tableHasColumns(db, "auth_profile_store", ["store_key", "store_json", "updated_at"]) ||
      !tableHasColumns(db, "auth_profile_state", ["state_key", "state_json", "updated_at"])) throw new Error("Unsupported agent auth schema");
  return [
    ["auth_profile_store", "store_key", "store_json", "updated_at", "primary"],
    ["auth_profile_state", "state_key", "state_json", "updated_at", "primary"],
  ];
};
const readDatabaseStore = (db, layout) => {
  const [secrets, state] = layout.map(([table, key, column, , id]) =>
    parseCell(db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${key} = ?`).get(id)?.value));
  return { secrets, state, store: validateStore({ ...secrets, ...state, version: secrets.version ?? state.version, profiles: secrets.profiles }) };
};
const writeDatabaseStore = (db, layout, loaded) => {
  const { store, secrets, state } = loaded;
  const nextSecrets = { ...secrets, version: store.version, profiles: store.profiles };
  const nextState = { ...state, version: state.version ?? store.version };
  for (const key of ["order", "lastGood", "usageStats"]) {
    if (store[key] !== undefined) nextState[key] = store[key];
    else delete nextState[key];
  }
  [nextSecrets, nextState].forEach((value, index) => {
    const [table, key, column, updated, id] = layout[index];
    db.prepare(`INSERT INTO ${table} (${key}, ${column}, ${updated}) VALUES (?, ?, ?)
      ON CONFLICT(${key}) DO UPDATE SET ${column} = excluded.${column}, ${updated} = excluded.${updated}`)
      .run(id, JSON.stringify(value), Date.now());
  });
};
const resolveBackend = (agentId) => {
  const agentDir = resolveAgentDir(agentId);
  if (agentId === "main") {
    const location = readAuthSharedStoreLocation({ openclawDir: OPENCLAW_DIR });
    if (location === "unreadable") {
      const error = unreadable(statePath());
      error.message = "Could not determine the OpenClaw auth store location — retry shortly or repair the store with OpenClaw Doctor";
      throw error;
    }
    if (location === "state-db") return { filePath: statePath(), shared: true };
  }
  return { filePath: path.join(agentDir, "openclaw-agent.sqlite"), shared: false };
};
const loadFileStore = (filePath) => {
  try {
    return validateStore(parseCell(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, profiles: {} };
    throw unreadable(filePath, error);
  }
};
const loadAuthStore = (agentId = "main", { strict = false } = {}) => {
  let filePath;
  try {
    assertAvailable();
    const backend = resolveBackend(agentId);
    filePath = backend.filePath;
    if (fs.existsSync(filePath)) {
      const db = openTrackedReadonlyDatabase(filePath);
      try {
        db.exec("BEGIN");
        const layout = backend.shared ? sharedLayout(db) : agentLayout(db);
        if (layout) return readDatabaseStore(db, layout).store;
      } finally { db.close(); }
    } else if (backend.shared) throw unreadable(filePath);
    return loadFileStore(path.join(resolveAgentDir(agentId), "auth-profiles.json"));
  } catch (error) {
    if (!filePath && error.code !== "AUTH_STORE_UNREADABLE" && !(error instanceof StateDbQuietError)) throw error;
    if (strict) throw error.code === "AUTH_STORE_UNREADABLE" || error instanceof StateDbQuietError ? error : unreadable(filePath, error);
    return { version: 1, profiles: {}, unavailable: true, reason: error instanceof StateDbQuietError ? kBackupInProgressCode : "AUTH_STORE_UNREADABLE" };
  }
};
const prepareFreshAuthStore = (agentId) => {
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "initialize-openclaw-auth.js"), agentId], {
    env: { ...process.env, OPENCLAW_STATE_DIR: OPENCLAW_DIR, OPENCLAW_CONFIG_PATH: path.join(OPENCLAW_DIR, "openclaw.json") },
    stdio: "pipe",
    timeout: 30_000,
  });
};
const needsFreshInitialization = (backend, jsonPath) => {
  if (backend.shared || fs.existsSync(jsonPath)) return false;
  if (!fs.existsSync(backend.filePath)) return true;
  const db = openTrackedReadonlyDatabase(backend.filePath);
  try {
    return !agentLayout(db) || !db.prepare("SELECT 1 FROM auth_profile_store WHERE store_key = ?").get("primary");
  } finally { db.close(); }
};
const mutateAuthStore = (agentId, mutate, prepareFreshStore = prepareFreshAuthStore) => {
  assertAvailable();
  let backend = resolveBackend(agentId);
  const jsonPath = path.join(resolveAgentDir(agentId), "auth-profiles.json");
  try {
    if (needsFreshInitialization(backend, jsonPath)) {
      prepareFreshStore(agentId);
      backend = resolveBackend(agentId);
    }
  } catch (error) { throw unreadable(backend.filePath, error); }
  if (fs.existsSync(backend.filePath)) {
    let db;
    try {
      db = backend.shared ? openWritableOpenclawStateDb({ openclawDir: OPENCLAW_DIR })?.db : new DatabaseSync(backend.filePath);
      if (!db) throw unreadable(backend.filePath);
      db.exec("PRAGMA busy_timeout = 3000;");
      db.exec("BEGIN IMMEDIATE");
      if (backend.shared) {
        const owner = parseCell(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?").get("auth.sharedStore")?.value_json);
        if (owner.location !== "state-db") throw new Error("Auth store owner changed; retry");
      } else if (resolveBackend(agentId).shared) throw new Error("Auth store owner changed; retry");
      const layout = backend.shared ? sharedLayout(db) : agentLayout(db);
      if (layout) {
        const loaded = readDatabaseStore(db, layout);
        const result = mutate(loaded.store);
        if (result !== false) writeDatabaseStore(db, layout, loaded);
        db.exec("COMMIT");
        return result;
      }
      db.exec("ROLLBACK");
    } catch (error) {
      try { db?.exec("ROLLBACK"); } catch {}
      if (error instanceof StateDbQuietError) throw error;
      throw unreadable(backend.filePath, error);
    } finally { db?.close(); }
  } else if (backend.shared) throw unreadable(backend.filePath);
  return withFileLockSync(jsonPath, () => {
    assertAvailable();
    if (resolveBackend(agentId).shared) throw unreadable(jsonPath);
    const store = loadFileStore(jsonPath);
    const result = mutate(store);
    if (result !== false) writeFileAtomic(jsonPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    return result;
  });
};

const refreshAuthStoreRuntime = async (agentId = "main") => {
  resolveAgentDir(agentId);
  if (isStateDbQuiet()) return { refreshed: false };
  enterStateDbHandle();
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, "..", "scripts", "refresh-openclaw-auth.js"), agentId], {
      env: { ...process.env, OPENCLAW_STATE_DIR: OPENCLAW_DIR, OPENCLAW_CONFIG_PATH: path.join(OPENCLAW_DIR, "openclaw.json") },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return { refreshed: JSON.parse(stdout).refreshed === true };
  } catch {
    return { refreshed: false };
  } finally { exitStateDbHandle(); }
};

module.exports = { loadAuthStore, mutateAuthStore, refreshAuthStoreRuntime };
