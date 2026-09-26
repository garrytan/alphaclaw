const { createBackupRiskConsentStore, fingerprintDatabase, kConsentTtlMs } = require("../../lib/server/backup-risk-consent");

describe("bounded database consent fingerprints", () => {
  const harness = () => {
    const files = Object.fromEntries(["", "-wal", "-journal"].map((suffix, index) => [`/state/db${suffix}`, {
      bytes: Buffer.alloc(128, index),
      stat: { dev: 1, ino: index + 1, size: 128, mtimeMs: 10, ctimeMs: 20, mode: 0o100600, nlink: 1 },
    }]));
    let afterRead = () => {};
    const stat = (file) => ({ ...files[file].stat, isFile: () => true });
    const fsModule = { promises: {
      stat: async (file) => stat(file),
      open: async (file) => ({ stat: async () => stat(file), close: async () => {},
        read: async (buffer, offset, length, position) => {
          const bytesRead = files[file].bytes.copy(buffer, offset, position, position + length);
          afterRead(file);
          return { bytesRead };
        },
      }),
    } };
    return { files, fingerprint: () => fingerprintDatabase("/state/db", { fsModule }),
      onRead: (callback) => { afterRead = callback; } };
  };

  it("ignores only WAL ctime changes made by a read-only SQLite open", async () => {
    const h = harness();
    const before = await h.fingerprint();
    h.onRead((file) => { if (file.endsWith("-wal")) h.files[file].stat.ctimeMs += 1; });
    expect(await h.fingerprint()).toEqual(before);
  });

  it.each(["dev", "ino", "size", "mtimeMs", "mode", "nlink"])("still binds WAL %s changes", async (field) => {
    const h = harness();
    const before = await h.fingerprint();
    h.files["/state/db-wal"].stat[field] += 1;
    expect(await h.fingerprint()).not.toEqual(before);
    h.onRead((file) => { if (file.endsWith("-wal")) h.files[file].stat[field] += 1; });
    await expect(h.fingerprint()).rejects.toMatchObject({ code: "state_db_changed" });
  });

  it.each(["", "-journal"])("still binds ctime for database or rollback journal %s", async (suffix) => {
    const h = harness();
    const before = await h.fingerprint();
    h.files[`/state/db${suffix}`].stat.ctimeMs += 1;
    expect(await h.fingerprint()).not.toEqual(before);
  });

  it("binds the bounded WAL header bytes independently of metadata", async () => {
    const h = harness();
    const before = await h.fingerprint();
    h.files["/state/db-wal"].bytes[0] += 1;
    expect(await h.fingerprint()).not.toEqual(before);
  });
});

describe("backup risk consent tokens", () => {
  const facts = { source: { buildId: "a".repeat(40) }, target: { buildId: "b".repeat(40), schemas: { state: 15, agent: 19 } } };
  const seed = (store, operationId = "failed-run") => {
    store.offer({ operationId, sessionId: "human-a", facts, backup: { noBackup: true }, preflight: null });
    return store.issue({ operationId, sessionId: "human-a", facts }).token;
  };

  it("binds the human, failed run, and exact facts, then consumes once", () => {
    const store = createBackupRiskConsentStore();
    const token = seed(store);
    expect(store.peek(token, "human-b")).toBeNull();
    expect(store.issue({ operationId: "another-run", sessionId: "human-a", facts })).toBeNull();
    expect(store.consume({ token, sessionId: "human-a", facts: { ...facts, target: { buildId: "changed" } } })).toBeNull();
    expect(store.consume({ token, sessionId: "human-a", facts }).operationId).toBe("failed-run");
    expect(store.consume({ token, sessionId: "human-a", facts })).toBeNull();
  });

  it("expires while a caller is queued and disappears on process restart", () => {
    let now = 1000;
    const store = createBackupRiskConsentStore({ now: () => now });
    const token = seed(store);
    expect(store.peek(token, "human-a")).not.toBeNull();
    expect(createBackupRiskConsentStore().peek(token, "human-a")).toBeNull();
    now += kConsentTtlMs;
    expect(store.consume({ token, sessionId: "human-a", facts })).toBeNull();
    expect(store.size()).toEqual({ offers: 0, tokens: 0 });
  });

  it("cannot retarget an issued token by replacing the failed run's offer", () => {
    const store = createBackupRiskConsentStore();
    const token = seed(store);
    const changed = { ...facts, target: { buildId: "c".repeat(40) } };
    store.offer({ operationId: "failed-run", sessionId: "human-a", facts: changed,
      backup: { noBackup: true }, preflight: null });
    expect(store.peek(token, "human-a")).toBeNull();
    expect(store.consume({ token, sessionId: "human-a", facts: changed })).toBeNull();
    const fresh = store.issue({ operationId: "failed-run", sessionId: "human-a", facts: changed });
    expect(store.consume({ token: fresh.token, sessionId: "human-a", facts: changed })).not.toBeNull();
  });

  it("invalidates every token for a consumed offer and bounds both maps", () => {
    const store = createBackupRiskConsentStore({ maxEntries: 2 });
    const first = seed(store, "one");
    const twin = store.issue({ operationId: "one", sessionId: "human-a", facts }).token;
    expect(store.consume({ token: first, sessionId: "human-a", facts })).not.toBeNull();
    expect(store.peek(twin, "human-a")).toBeNull();
    seed(store, "two"); seed(store, "three"); seed(store, "four");
    expect(store.size()).toEqual({ offers: 2, tokens: 2 });
  });

  it("refuses an oversized offer instead of retaining unbounded failed-run diagnostics", () => {
    const store = createBackupRiskConsentStore();
    expect(store.offer({ operationId: "large", sessionId: "human-a", facts, backup: { diagnosis: "x".repeat(256 * 1024) } })).toBe(false);
    expect(store.size()).toEqual({ offers: 0, tokens: 0 });
  });
});
