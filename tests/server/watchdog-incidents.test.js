const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  createWatchdogIncidentTracker,
  classifyEvent,
} = require("../../lib/server/watchdog-incidents");

const loadWatchdogDb = () => {
  const modulePath = require.resolve("../../lib/server/db/watchdog");
  delete require.cache[modulePath];
  return require(modulePath);
};

let db = null;
let rootDir = "";

const initContext = () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-incidents-"));
  db = loadWatchdogDb();
  db.initWatchdogDb({ rootDir, pruneDays: 30 });
  return db;
};

const quietLogger = { error: () => {} };

const createTracker = (overrides = {}) =>
  createWatchdogIncidentTracker({
    db,
    getStatus: () => ({ health: "healthy", phase: "healthy", gatewayPid: 42 }),
    getResourceSample: () => ({ memory: { percent: 10 } }),
    logger: quietLogger,
    ...overrides,
  });

const wrapped = (tracker) => tracker.wrapInsertEvent(db.insertWatchdogEvent);

const crashEvent = (overrides = {}) => ({
  eventType: "crash",
  source: "exit_event",
  status: "failed",
  details: { code: 1 },
  correlationId: "c1",
  ...overrides,
});

const recoveryEvent = () => ({
  eventType: "recovery",
  source: "health_timer",
  status: "ok",
  details: { health: "healthy" },
  correlationId: "c2",
});

afterEach(() => {
  if (db?.closeWatchdogDb) db.closeWatchdogDb();
  db = null;
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  rootDir = "";
});

describe("classifyEvent transition table", () => {
  it("is exhaustive over the documented rules", () => {
    expect(classifyEvent({ eventType: "crash", status: "failed" })).toBe("open");
    expect(classifyEvent({ eventType: "config_error", status: "failed" })).toBe("open");
    expect(classifyEvent({ eventType: "health_check", status: "failed" })).toBe("open");
    expect(
      classifyEvent({ eventType: "health_check", status: "ok", details: {} }),
    ).toBe("close");
    // Grace/expected-restart window probes carry skipped:true and must NEVER
    // close an incident.
    expect(
      classifyEvent({
        eventType: "health_check",
        status: "ok",
        details: { skipped: true, startupGraceActive: true },
      }),
    ).toBe("append");
    expect(classifyEvent({ eventType: "recovery", status: "ok" })).toBe("close");
    expect(
      classifyEvent({ eventType: "safe_mode", status: "failed", details: {} }),
    ).toBe("open");
    expect(
      classifyEvent({
        eventType: "safe_mode",
        status: "ok",
        details: { recovered: true },
      }),
    ).toBe("close_safe_mode");
    for (const eventType of [
      "notification",
      "restart",
      "repair",
      "channel_rollback",
      "crash_loop",
      "safe_mode_resume",
      "totally_unknown_type",
    ]) {
      expect(classifyEvent({ eventType, status: "ok" })).toBe("append");
    }
  });
});

describe("schema migration", () => {
  it("is idempotent across repeat inits", () => {
    initContext();
    db.closeWatchdogDb();
    db.initWatchdogDb({ rootDir, pruneDays: 30 });
    db.closeWatchdogDb();
    db.initWatchdogDb({ rootDir, pruneDays: 30 });
    expect(db.listIncidents()).toEqual([]);
  });

  it("upgrades a pre-wave database (old schema, no incidents table/column)", () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-incidents-old-"));
    const dbDir = path.join(rootDir, "db");
    fs.mkdirSync(dbDir, { recursive: true });
    const legacy = new DatabaseSync(path.join(dbDir, "watchdog.db"));
    legacy.exec(`
      CREATE TABLE watchdog_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT,
        correlation_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT INTO watchdog_events (event_type, source, status)
      VALUES ('crash', 'exit_event', 'failed');
    `);
    legacy.close();
    db = loadWatchdogDb();
    db.initWatchdogDb({ rootDir, pruneDays: 30 });
    // Legacy rows survive, unstamped; new surfaces work.
    const events = db.getRecentEvents({ limit: 5 });
    expect(events).toHaveLength(1);
    expect(db.listIncidents()).toEqual([]);
    const tracker = createTracker();
    const insert = wrapped(tracker);
    insert(crashEvent());
    expect(db.listIncidents()).toHaveLength(1);
  });
});

describe("incident lifecycle through the wrapped sink", () => {
  it("opens on crash, stamps events, appends repeat triggers, closes on recovery with a rollup", () => {
    initContext();
    const tracker = createTracker();
    const insert = wrapped(tracker);

    insert(crashEvent());
    const openId = tracker.getActiveIncidentId();
    expect(openId).toBeGreaterThan(0);

    // Second open-trigger appends to the SAME incident.
    insert(crashEvent({ correlationId: "c1b" }));
    insert({
      eventType: "restart",
      source: "exit_event",
      status: "backoff",
      details: { backoffMs: 2000 },
    });
    // Skipped probe during the arc must not close it.
    insert({
      eventType: "health_check",
      source: "health_timer",
      status: "ok",
      details: { skipped: true, expectedRestartActive: true },
    });
    expect(tracker.getActiveIncidentId()).toBe(openId);

    insert(recoveryEvent());
    expect(tracker.getActiveIncidentId()).toBe(null);

    const incidents = db.listIncidents();
    expect(incidents).toHaveLength(1);
    const incident = incidents[0];
    expect(incident.id).toBe(openId);
    expect(incident.status).toBe("resolved");
    expect(incident.incidentKey).toBe("gateway_crash");
    expect(incident.eventCount).toBe(5);
    expect(incident.summary.v).toBe(1);
    expect(incident.summary.outcome).toBe("recovered");
    expect(incident.summary.severity).toBe("warning");
    expect(incident.summary.eventCounts.crash).toBe(2);
    expect(incident.summary.actions).toContain("restart");
    expect(incident.summary.statusSnapshot).toMatchObject({ phase: "healthy" });
    expect(incident.summary.resourceSample).toMatchObject({
      memory: { percent: 10 },
    });
    expect(typeof incident.summary.durationMs).toBe("number");

    const { events, totalCount } = db.getIncidentEvents(openId);
    expect(totalCount).toBe(5);
    expect(events).toHaveLength(5);
    expect(events.every((event) => event.createdAt)).toBe(true);
  });

  it("escalates severity to critical on crash_loop/channel_rollback", () => {
    initContext();
    const tracker = createTracker();
    const insert = wrapped(tracker);
    insert(crashEvent());
    insert({ eventType: "crash_loop", source: "exit_event", status: "failed" });
    insert({
      eventType: "channel_rollback",
      source: "crash_loop",
      status: "requested",
    });
    insert(recoveryEvent());
    const [incident] = db.listIncidents();
    expect(incident.summary.severity).toBe("critical");
    expect(incident.summary.actions).toContain("channel_rollback");
  });

  it("safe_mode recovered closes a safe-mode incident but not a crash incident", () => {
    initContext();
    const tracker = createTracker();
    const insert = wrapped(tracker);
    insert({
      eventType: "safe_mode",
      source: "health_timer",
      status: "failed",
      details: { suppressed: ["telegram"] },
    });
    insert({
      eventType: "safe_mode",
      source: "health_timer",
      status: "ok",
      details: { recovered: true },
    });
    expect(tracker.getActiveIncidentId()).toBe(null);
    expect(db.listIncidents()[0].incidentKey).toBe("safe_mode");

    insert(crashEvent());
    const crashIncidentId = tracker.getActiveIncidentId();
    insert({
      eventType: "safe_mode",
      source: "health_timer",
      status: "ok",
      details: { recovered: true },
    });
    expect(tracker.getActiveIncidentId()).toBe(crashIncidentId);
  });

  it("events outside any incident stay unstamped; foreign writers bypass the tracker entirely", () => {
    initContext();
    const tracker = createTracker();
    const insert = wrapped(tracker);
    insert({ eventType: "notification", source: "watchdog", status: "ok" });
    // Foreign writer path (unwrapped module function).
    db.insertWatchdogEvent({
      eventType: "channel_rollback",
      source: "release_channel",
      status: "requested",
    });
    expect(db.listIncidents()).toEqual([]);
    const { totalCount } = db.getIncidentEvents(9999);
    expect(totalCount).toBe(0);
  });

  it("fail-open: a throwing DB never blocks the event insert and inserts exactly once", () => {
    initContext();
    const failingDb = {
      ...db,
      withTransaction: () => {
        throw new Error("disk full");
      },
    };
    const tracker = createWatchdogIncidentTracker({
      db: failingDb,
      logger: quietLogger,
    });
    const insert = tracker.wrapInsertEvent(db.insertWatchdogEvent);
    const eventId = insert(crashEvent());
    expect(eventId).toBeGreaterThan(0);
    const events = db.getRecentEvents({ limit: 5 });
    expect(events).toHaveLength(1);
    expect(db.listIncidents()).toEqual([]);
    expect(tracker.getActiveIncidentId()).toBe(null);
  });

  it("withTransaction rolls back the incident row when the event insert throws mid-transaction", () => {
    initContext();
    const throwingInsert = () => {
      throw new Error("event insert exploded");
    };
    const tracker = createTracker();
    const insert = tracker.wrapInsertEvent(throwingInsert);
    expect(insert(crashEvent())).toBe(0);
    // Rollback: no orphaned incident row.
    expect(db.listIncidents()).toEqual([]);
  });
});

describe("one-open-incident invariant", () => {
  it("the partial unique index rejects a second open row", () => {
    initContext();
    db.insertIncident({ incidentKey: "gateway_crash" });
    expect(() => db.insertIncident({ incidentKey: "gateway_degraded" })).toThrow();
  });
});

describe("boot abandonment", () => {
  it("marks dangling open incidents abandoned with resolved_at = last event time", () => {
    initContext();
    const tracker = createTracker();
    const insert = wrapped(tracker);
    insert(crashEvent());
    const incidentId = tracker.getActiveIncidentId();
    insert({ eventType: "restart", source: "exit_event", status: "backoff" });

    // Simulate a fresh process: a new tracker scans on boot.
    const bootTracker = createTracker();
    const abandoned = bootTracker.abandonDanglingOnBoot();
    expect(abandoned).toEqual([incidentId]);
    const incident = db.getIncidentById(incidentId);
    expect(incident.status).toBe("abandoned");
    const { events } = db.getIncidentEvents(incidentId);
    expect(incident.resolvedAt).toBe(events[events.length - 1].createdAt);
  });

  it("is a no-op with nothing dangling and fail-open on DB errors", () => {
    initContext();
    expect(createTracker().abandonDanglingOnBoot()).toEqual([]);
    const failing = createWatchdogIncidentTracker({
      db: {
        abandonOpenIncidents: () => {
          throw new Error("locked");
        },
      },
      logger: quietLogger,
    });
    expect(failing.abandonDanglingOnBoot()).toEqual([]);
  });
});

describe("incident queries", () => {
  it("listIncidents paginates by id cursor and clamps limit", () => {
    initContext();
    const tracker = createTracker();
    const insert = wrapped(tracker);
    for (let i = 0; i < 4; i += 1) {
      insert(crashEvent({ correlationId: `arc-${i}` }));
      insert(recoveryEvent());
    }
    const firstPage = db.listIncidents({ limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(firstPage[0].id).toBeGreaterThan(firstPage[1].id);
    const secondPage = db.listIncidents({ limit: 2, before: firstPage[1].id });
    expect(secondPage).toHaveLength(2);
    expect(secondPage[0].id).toBeLessThan(firstPage[1].id);
    expect(db.listIncidents({ limit: 9999 })).toHaveLength(4);
    expect(db.listIncidents({ limit: "garbage" })).toHaveLength(4);
  });

  it("getIncidentEvents caps at 200 and reports the true total", () => {
    initContext();
    const tracker = createTracker();
    const insert = wrapped(tracker);
    insert(crashEvent());
    const incidentId = tracker.getActiveIncidentId();
    for (let i = 0; i < 210; i += 1) {
      insert({
        eventType: "restart",
        source: "exit_event",
        status: "backoff",
        details: { i },
      });
    }
    const { events, totalCount } = db.getIncidentEvents(incidentId);
    expect(totalCount).toBe(211);
    expect(events).toHaveLength(200);
    // Chronological: the opening crash is first.
    expect(events[0].eventType).toBe("crash");
  });

  it("safe-parses corrupt JSON blobs instead of throwing", () => {
    initContext();
    const incidentId = db.insertIncident({ incidentKey: "gateway_crash" });
    db.resolveIncident(incidentId, { summaryJson: { v: 1 } });
    // Corrupt both blobs directly.
    const raw = new DatabaseSync(path.join(rootDir, "db", "watchdog.db"));
    raw.exec(
      `UPDATE watchdog_incidents SET summary_json = '{broken', overseer_json = 'nope{' WHERE id = ${incidentId}`,
    );
    raw.close();
    const incident = db.getIncidentById(incidentId);
    expect(incident.summary).toEqual({ unreadable: true });
    expect(incident.overseer).toEqual({ unreadable: true });
  });

  it("pruneWatchdogIncidents removes old settled incidents but never open ones", () => {
    initContext();
    const oldId = db.insertIncident({ incidentKey: "gateway_crash" });
    db.resolveIncident(oldId, { summaryJson: { v: 1 } });
    const openId = (() => {
      // Backdate both, keep one open.
      const raw = new DatabaseSync(path.join(rootDir, "db", "watchdog.db"));
      raw.exec(
        `UPDATE watchdog_incidents SET opened_at = '2020-01-01T00:00:00.000Z' WHERE id = ${oldId}`,
      );
      raw.exec(`
        INSERT INTO watchdog_incidents (incident_key, status, opened_at)
        VALUES ('gateway_degraded', 'open', '2020-01-01T00:00:00.000Z')
      `);
      const row = raw
        .prepare("SELECT id FROM watchdog_incidents WHERE status = 'open'")
        .get();
      raw.close();
      return Number(row.id);
    })();
    expect(db.pruneWatchdogIncidents(30)).toBe(1);
    expect(db.getIncidentById(oldId)).toBe(null);
    expect(db.getIncidentById(openId)).not.toBe(null);
  });
});
