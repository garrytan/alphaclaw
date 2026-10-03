const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  kOpenclawStateDbPath,
  resolveOpenclawStateDbPath,
  openReadonlyOpenclawStateDb,
  hasTable,
} = require("../../lib/server/openclaw-state-db");

describe("server/openclaw-state-db", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-state-db-"));
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createStateDb = () => {
    const databasePath = path.join(tempDir, kOpenclawStateDbPath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, payload TEXT)");
    db.close();
    return databasePath;
  };

  it("resolves state/openclaw.sqlite under the openclaw dir", () => {
    expect(resolveOpenclawStateDbPath({ openclawDir: tempDir })).toBe(
      path.join(tempDir, "state", "openclaw.sqlite"),
    );
  });

  it("returns null when the state db does not exist (fresh install)", () => {
    expect(openReadonlyOpenclawStateDb({ openclawDir: tempDir })).toBeNull();
  });

  it("opens the state db read-only and reports its path", () => {
    const databasePath = createStateDb();
    const handle = openReadonlyOpenclawStateDb({ openclawDir: tempDir });
    expect(handle).toBeTruthy();
    expect(handle.databasePath).toBe(databasePath);
    try {
      // Reads work…
      expect(hasTable(handle.db, "cron_jobs")).toBe(true);
      // …writes are refused (readOnly handle).
      expect(() =>
        handle.db.exec("INSERT INTO cron_jobs (id, payload) VALUES ('a', 'b')"),
      ).toThrow();
    } finally {
      handle.db.close();
    }
  });

  it("hasTable distinguishes present and missing tables", () => {
    createStateDb();
    const handle = openReadonlyOpenclawStateDb({ openclawDir: tempDir });
    try {
      expect(hasTable(handle.db, "cron_jobs")).toBe(true);
      expect(hasTable(handle.db, "plugin_state_entries")).toBe(false);
    } finally {
      handle.db.close();
    }
  });
});

describe("server/openclaw-state-db busy timeouts", () => {
  const {
    kReadonlyBusyTimeoutMs,
    kWritableBusyTimeoutMs,
    openWritableOpenclawStateDb,
    openReadonlyDatabase,
  } = require("../../lib/server/openclaw-state-db");

  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-state-db-busy-"));
    const databasePath = path.join(tempDir, kOpenclawStateDbPath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, payload TEXT)");
    db.close();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const busyTimeoutOf = (db) => db.prepare("PRAGMA busy_timeout").get().timeout;

  it("read-only opens ALWAYS arm busy_timeout = 2000 (pinned)", () => {
    expect(kReadonlyBusyTimeoutMs).toBe(2000);
    const handle = openReadonlyOpenclawStateDb({ openclawDir: tempDir });
    try {
      expect(busyTimeoutOf(handle.db)).toBe(2000);
    } finally {
      handle.db.close();
    }
    const tracked = openReadonlyDatabase(path.join(tempDir, kOpenclawStateDbPath));
    try {
      expect(busyTimeoutOf(tracked)).toBe(2000);
      expect(() => tracked.exec("INSERT INTO cron_jobs (id, payload) VALUES ('a', 'b')")).toThrow();
    } finally {
      tracked.close();
    }
  });

  it("writable opens arm busy_timeout = 3000 (pinned)", () => {
    expect(kWritableBusyTimeoutMs).toBe(3000);
    const handle = openWritableOpenclawStateDb({ openclawDir: tempDir });
    try {
      expect(busyTimeoutOf(handle.db)).toBe(3000);
    } finally {
      handle.db.close();
    }
  });
});
