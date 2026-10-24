const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// GET /api/watchdog/events paging contract at the storage layer: the
// (created_at, id) keyset, since/until boundaries, the limit clamp, the
// hasMore probe and the filters.

const kModulePath = "../../lib/server/db/watchdog";

let rootDir = "";
let watchdogDb = null;
let rawDb = null;

const setup = () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-events-paging-"));
  vi.resetModules();
  watchdogDb = require(kModulePath);
  const { path: dbPath } = watchdogDb.initWatchdogDb({ rootDir });
  rawDb = new DatabaseSync(dbPath);
};

const insertAt = (createdAt, { eventType = "crash", source = "exit_event", status = "failed" } = {}) =>
  Number(
    rawDb
      .prepare(`
        INSERT INTO watchdog_events (event_type, source, status, details, correlation_id, created_at)
        VALUES ($event_type, $source, $status, '{}', '', $created_at)
      `)
      .run({ $event_type: eventType, $source: source, $status: status, $created_at: createdAt })
      .lastInsertRowid,
  );

const ts = (second) => new Date(Date.UTC(2026, 9, 24, 12, 0, second)).toISOString();

const pageAll = ({ cursor: startCursor = null, ...options }) => {
  const seen = [];
  let cursor = startCursor;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = watchdogDb.getRecentEvents({ ...options, cursor });
    seen.push(...page.events.map((event) => event.id));
    if (!page.hasMore) {
      expect(page.nextCursor).toBeNull();
      return seen;
    }
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
};

describe("watchdog events paging (storage)", () => {
  beforeEach(setup);
  afterEach(() => {
    rawDb?.close();
    rawDb = null;
    watchdogDb?.closeWatchdogDb();
    watchdogDb = null;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns newest first and reports hasMore only when a row exists past the page", () => {
    const ids = [1, 2, 3].map((second) => insertAt(ts(second)));
    const exact = watchdogDb.getRecentEvents({ limit: 3 });
    expect(exact.events.map((event) => event.id)).toEqual([...ids].reverse());
    expect(exact.hasMore).toBe(false);
    expect(exact.nextCursor).toBeNull();

    const short = watchdogDb.getRecentEvents({ limit: 2 });
    expect(short.events.map((event) => event.id)).toEqual([ids[2], ids[1]]);
    expect(short.hasMore).toBe(true);
    expect(short.nextCursor).toEqual({ createdAt: ts(2), id: ids[1] });

    const rest = watchdogDb.getRecentEvents({ limit: 2, cursor: short.nextCursor });
    expect(rest.events.map((event) => event.id)).toEqual([ids[0]]);
    expect(rest.hasMore).toBe(false);
  });

  it("clamps limit to 1..200 (default 20) and echoes the effective value", () => {
    for (let i = 0; i < 205; i += 1) insertAt(new Date(Date.UTC(2026, 9, 24) + i).toISOString());
    expect(watchdogDb.getRecentEvents({}).limit).toBe(20);
    expect(watchdogDb.getRecentEvents({ limit: -5 }).events).toHaveLength(1);
    const capped = watchdogDb.getRecentEvents({ limit: 999 });
    expect(capped.limit).toBe(200);
    expect(capped.events).toHaveLength(200);
    expect(capped.hasMore).toBe(true);
  });

  it("treats since as inclusive and until as exclusive at exact timestamps", () => {
    const [a, b, c, d] = [1, 2, 3, 4].map((second) => insertAt(ts(second)));
    const ids = (options) => watchdogDb.getRecentEvents(options).events.map((event) => event.id);
    expect(ids({ since: ts(2) })).toEqual([d, c, b]);
    expect(ids({ until: ts(3) })).toEqual([b, a]);
    expect(ids({ since: ts(2), until: ts(4) })).toEqual([c, b]);
    expect(ids({ since: ts(5) })).toEqual([]);
  });

  it("breaks created_at ties by id so equal timestamps page without repeats or gaps", () => {
    const ids = Array.from({ length: 7 }, () => insertAt(ts(1)));
    expect(pageAll({ limit: 2 })).toEqual([...ids].reverse());
  });

  it("keeps a cursor stable while new rows are inserted between pages", () => {
    const original = Array.from({ length: 9 }, (_, i) => insertAt(ts(i)));
    const first = watchdogDb.getRecentEvents({ limit: 4 });
    const newer = [insertAt(ts(30)), insertAt(ts(31))];
    // A writer whose clock stepped back lands between the cursor and the end;
    // it may show up later, but no pre-existing row is repeated or skipped.
    const late = insertAt(ts(2));
    const second = watchdogDb.getRecentEvents({ limit: 4, cursor: first.nextCursor });
    const rest = pageAll({ limit: 4, cursor: second.nextCursor });

    const paged = [...first.events, ...second.events].map((event) => event.id).concat(rest);
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged.filter((id) => original.includes(id))).toEqual([...original].reverse());
    expect(paged.some((id) => newer.includes(id))).toBe(false);
    expect(paged).toContain(late);

    const fresh = watchdogDb.getRecentEvents({ limit: 2 });
    expect(fresh.events.map((event) => event.id)).toEqual([newer[1], newer[0]]);
  });

  it("filters by event type and source, and hides routine ok health checks unless asked", () => {
    const crash = insertAt(ts(1), { eventType: "crash", source: "exit_event" });
    const repair = insertAt(ts(2), { eventType: "repair", source: "crash_loop", status: "ok" });
    const routine = insertAt(ts(3), { eventType: "health_check", source: "health_timer", status: "ok" });
    const failedCheck = insertAt(ts(4), { eventType: "health_check", source: "health_timer", status: "failed" });
    const ids = (options) => watchdogDb.getRecentEvents(options).events.map((event) => event.id);

    expect(ids({ eventTypes: ["crash", "repair"] })).toEqual([repair, crash]);
    expect(ids({ sources: ["crash_loop"] })).toEqual([repair]);
    expect(ids({ eventTypes: ["health_check"] })).toEqual([failedCheck]);
    expect(ids({ eventTypes: ["health_check"], includeRoutine: true })).toEqual([failedCheck, routine]);
    expect(ids({ eventTypes: ["crash"], sources: ["crash_loop"] })).toEqual([]);
  });
});
