const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const loadWatchdogDb = () => {
  const modulePath = require.resolve("../../lib/server/db/watchdog");
  delete require.cache[modulePath];
  return require(modulePath);
};

const sleep = async (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let currentWatchdogDb = null;
let currentDatabase = null;
let currentRootDir = "";

const createWatchdogDbContext = (prefix, pruneDays = 30) => {
  currentRootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  currentWatchdogDb = loadWatchdogDb();
  const dbResult = currentWatchdogDb.initWatchdogDb({ rootDir: currentRootDir, pruneDays });
  return {
    ...currentWatchdogDb,
    ...dbResult,
    rootDir: currentRootDir,
  };
};

describe("server/watchdog-db", () => {
  afterEach(() => {
    if (currentDatabase) {
      currentDatabase.close();
      currentDatabase = null;
    }
    if (currentWatchdogDb?.closeWatchdogDb) {
      currentWatchdogDb.closeWatchdogDb();
      currentWatchdogDb = null;
    }
    if (currentRootDir) {
      fs.rmSync(currentRootDir, { recursive: true, force: true });
      currentRootDir = "";
    }
  });

  it("initializes watchdog.db under root db directory", () => {
    const result = createWatchdogDbContext("watchdog-db-init-");

    expect(result.path).toBe(path.join(result.rootDir, "db", "watchdog.db"));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it("returns filtered events up to limit when routine checks are excluded", async () => {
    const { insertWatchdogEvent, getRecentEvents } = createWatchdogDbContext(
      "watchdog-db-filter-",
    );

    insertWatchdogEvent({
      eventType: "crash",
      source: "exit_event",
      status: "failed",
      details: { code: 1 },
    });
    await sleep(2);
    insertWatchdogEvent({
      eventType: "repair",
      source: "crash_loop",
      status: "ok",
      details: { started: true },
    });
    await sleep(2);
    insertWatchdogEvent({
      eventType: "health_check",
      source: "health_timer",
      status: "ok",
      details: { skipped: false },
    });
    await sleep(2);
    insertWatchdogEvent({
      eventType: "health_check",
      source: "health_timer",
      status: "ok",
      details: { skipped: false },
    });

    const filtered = getRecentEvents({ limit: 2, includeRoutine: false });
    const unfiltered = getRecentEvents({ limit: 2, includeRoutine: true });

    expect(filtered).toHaveLength(2);
    expect(filtered.every((event) => !(event.eventType === "health_check" && event.status === "ok")))
      .toBe(true);
    expect(unfiltered).toHaveLength(2);
    expect(
      unfiltered.every((event) => event.eventType === "health_check" && event.status === "ok"),
    ).toBe(true);
  });

  it("uses the partial notable-events index for the filtered query", () => {
    const { path: dbPath, kNotableEventsPredicateSql } = createWatchdogDbContext(
      "watchdog-db-index-",
    );
    currentDatabase = new DatabaseSync(dbPath);

    // Same predicate constant getRecentEvents interpolates — SQLite only uses
    // a partial index when the query's WHERE text matches its predicate.
    const plan = currentDatabase
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT id, event_type, source, status, details, correlation_id, created_at
        FROM watchdog_events
        WHERE ${kNotableEventsPredicateSql}
        ORDER BY created_at DESC
        LIMIT 20
      `)
      .all();

    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_watchdog_events_notable");
  });

  it("returns notable events fast from a table dominated by routine rows", () => {
    const { path: dbPath, getRecentEvents } = createWatchdogDbContext(
      "watchdog-db-timing-",
    );
    currentDatabase = new DatabaseSync(dbPath);
    const insert = currentDatabase.prepare(`
      INSERT INTO watchdog_events (
        event_type, source, status, details, correlation_id, created_at
      ) VALUES ($event_type, $source, $status, '{}', '', $created_at)
    `);
    const baseTs = Date.parse("2026-08-01T00:00:00Z");
    const routineRows = 30000;
    // One transaction: 30k auto-committed inserts would fsync 30k times.
    currentDatabase.exec("BEGIN");
    for (let i = 0; i < routineRows; i += 1) {
      const notable = i % 6000 === 0; // 5 notable rows spread through the table
      insert.run({
        $event_type: notable ? "crash" : "health_check",
        $source: notable ? "exit_event" : "health_timer",
        $status: notable ? "failed" : "ok",
        $created_at: new Date(baseTs + i).toISOString(),
      });
    }
    currentDatabase.exec("COMMIT");

    const startedAt = performance.now();
    const events = getRecentEvents({ limit: 20 });
    const elapsedMs = performance.now() - startedAt;

    expect(events).toHaveLength(5);
    expect(
      events.every(
        (event) => !(event.eventType === "health_check" && event.status === "ok"),
      ),
    ).toBe(true);
    expect(elapsedMs).toBeLessThan(250);
  });

  it("prunes old events based on retention days", () => {
    const { path: dbPath, pruneWatchdogEvents } = createWatchdogDbContext(
      "watchdog-db-prune-",
      365,
    );
    currentDatabase = new DatabaseSync(dbPath);
    const database = currentDatabase;
    database
      .prepare(`
        INSERT INTO watchdog_events (
          event_type,
          source,
          status,
          details,
          correlation_id,
          created_at
        ) VALUES (
          $event_type,
          $source,
          $status,
          $details,
          $correlation_id,
          $created_at
        )
      `)
      .run({
        $event_type: "crash",
        $source: "exit_event",
        $status: "failed",
        $details: "{}",
        $correlation_id: "",
        $created_at: "2000-01-01T00:00:00.000Z",
      });
    database
      .prepare(`
        INSERT INTO watchdog_events (
          event_type,
          source,
          status,
          details,
          correlation_id,
          created_at
        ) VALUES (
          $event_type,
          $source,
          $status,
          $details,
          $correlation_id,
          $created_at
        )
      `)
      .run({
        $event_type: "health_check",
        $source: "health_timer",
        $status: "ok",
        $details: "{}",
        $correlation_id: "",
        $created_at: "2100-01-01T00:00:00.000Z",
      });

    const removed = pruneWatchdogEvents(30);
    const remaining = database
      .prepare("SELECT COUNT(*) AS count FROM watchdog_events")
      .get().count;

    expect(removed).toBe(1);
    expect(remaining).toBe(1);
  });
});
