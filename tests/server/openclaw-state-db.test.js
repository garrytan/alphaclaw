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

describe("server/openclaw-state-db quiet period + handle accounting", () => {
  const {
    kReadonlyBusyTimeoutMs,
    kWritableBusyTimeoutMs,
    openWritableOpenclawStateDb,
    openTrackedReadonlyDatabase,
  } = require("../../lib/server/openclaw-state-db");
  const {
    StateDbQuietError,
    beginStateDbQuiet,
    getStateDbHandleCount,
    resetStateDbQuietForTests,
  } = require("../../lib/server/state-db-quiet");

  let tempDir = "";

  beforeEach(() => {
    resetStateDbQuietForTests();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-state-db-quiet-"));
    const databasePath = path.join(tempDir, kOpenclawStateDbPath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, payload TEXT)");
    db.close();
  });

  afterEach(() => {
    resetStateDbQuietForTests();
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
    const tracked = openTrackedReadonlyDatabase(path.join(tempDir, kOpenclawStateDbPath));
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

  it("counts every open handle until its close(), without underflow on a double close", () => {
    expect(getStateDbHandleCount()).toBe(0);
    const reader = openReadonlyOpenclawStateDb({ openclawDir: tempDir });
    const writer = openWritableOpenclawStateDb({ openclawDir: tempDir });
    expect(getStateDbHandleCount()).toBe(2);
    reader.db.close();
    expect(getStateDbHandleCount()).toBe(1);
    writer.db.close();
    expect(getStateDbHandleCount()).toBe(0);
    // node:sqlite rejects a second close; the counter must not go negative.
    expect(() => writer.db.close()).toThrow();
    expect(getStateDbHandleCount()).toBe(0);
  });

  // Moved from the lane-X pin "a throwing native close() still releases the
  // handle count (finally)": releasing an OPEN handle made it an uncounted
  // reader invisible to the offline copy (its /proc fd scan skips this
  // process) — the false "exclusive" verdict the counter exists to prevent.
  // The count now follows the connection's real state: a one-shot throw is
  // retried and released; a connection that stays open stays counted.
  it("a one-shot throwing native close() is retried once: the successful retry releases the count and close() does not throw", () => {
    const closeSpy = vi
      .spyOn(DatabaseSync.prototype, "close")
      .mockImplementationOnce(function () {
        throw new Error("close exploded");
      });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const handle = openReadonlyOpenclawStateDb({ openclawDir: tempDir });
      expect(getStateDbHandleCount()).toBe(1);
      expect(() => handle.db.close()).not.toThrow();
      expect(handle.db.isOpen).toBe(false);
      expect(getStateDbHandleCount()).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/succeeded on retry/));
      // A double close surfaces node:sqlite's own error and never underflows.
      expect(() => handle.db.close()).toThrow();
      expect(getStateDbHandleCount()).toBe(0);
    } finally {
      closeSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("a native close() that keeps throwing while the connection stays open keeps the handle COUNTED (the offline copy's exclusivity gate must still see it) until a later close succeeds", () => {
    const original = DatabaseSync.prototype.close;
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function () {
      throw new Error("close exploded");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handle = openReadonlyOpenclawStateDb({ openclawDir: tempDir });
      expect(() => handle.db.close()).toThrow("close exploded");
      expect(closeSpy).toHaveBeenCalledTimes(2);
      expect(handle.db.isOpen).toBe(true);
      expect(getStateDbHandleCount()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/stays counted/));
      // The connection heals: the next close succeeds and releases the count.
      closeSpy.mockImplementation(function () {
        return original.call(this);
      });
      handle.db.close();
      expect(handle.db.isOpen).toBe(false);
      expect(getStateDbHandleCount()).toBe(0);
    } finally {
      closeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a close() that throws because the connection was already closed underneath the wrapper releases the count (isOpen is false)", () => {
    const handle = openReadonlyOpenclawStateDb({ openclawDir: tempDir });
    expect(getStateDbHandleCount()).toBe(1);
    DatabaseSync.prototype.close.call(handle.db);
    expect(() => handle.db.close()).toThrow(/not open/);
    expect(getStateDbHandleCount()).toBe(0);
  });

  it("while quiet: the read-only open returns null (the existing 'unavailable' fallback) without touching the db", async () => {
    const { token } = await beginStateDbQuiet({ owner: "test", maxMs: 60_000 });
    try {
      expect(openReadonlyOpenclawStateDb({ openclawDir: tempDir })).toBeNull();
      expect(getStateDbHandleCount()).toBe(0);
    } finally {
      token.release();
    }
    expect(openReadonlyOpenclawStateDb({ openclawDir: tempDir })).not.toBeNull();
  });

  it("while quiet: the writable open throws StateDbQuietError (code backup_in_progress)", async () => {
    const { token } = await beginStateDbQuiet({ owner: "test", maxMs: 60_000 });
    try {
      expect(() => openWritableOpenclawStateDb({ openclawDir: tempDir })).toThrow(StateDbQuietError);
      let caught = null;
      try {
        openWritableOpenclawStateDb({ openclawDir: tempDir });
      } catch (error) {
        caught = error;
      }
      expect(caught.code).toBe("backup_in_progress");
      expect(getStateDbHandleCount()).toBe(0);
    } finally {
      token.release();
    }
    const handle = openWritableOpenclawStateDb({ openclawDir: tempDir });
    handle.db.close();
  });

  it("begin waits for an open handle to close before forming the barrier", async () => {
    const handle = openReadonlyOpenclawStateDb({ openclawDir: tempDir });
    let settled = false;
    const pending = beginStateDbQuiet({ owner: "test", maxMs: 60_000 }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    handle.db.close();
    const { token } = await pending;
    expect(settled).toBe(true);
    token.release();
  });
});
