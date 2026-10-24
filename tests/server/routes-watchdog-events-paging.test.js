const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerWatchdogRoutes } = require("../../lib/server/routes/watchdog");

// GET /api/watchdog/events over HTTP against a real watchdog.db: the query
// contract (validation codes, opaque cursor round trip) and the page shape.

let rootDir = "";
let watchdogDb = null;

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerWatchdogRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    watchdog: {},
    getRecentEvents: watchdogDb.getRecentEvents,
    readLogTail: () => "",
  });
  return app;
};

const insert = (eventType = "crash", source = "exit_event", status = "failed") =>
  watchdogDb.insertWatchdogEvent({ eventType, source, status, details: {} });

describe("GET /api/watchdog/events paging (route + real db)", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-events-route-"));
    vi.resetModules();
    watchdogDb = require("../../lib/server/db/watchdog");
    watchdogDb.initWatchdogDb({ rootDir });
  });
  afterEach(() => {
    watchdogDb.closeWatchdogDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("pages with an opaque cursor, newest first, across inserts", async () => {
    for (let i = 0; i < 5; i += 1) insert();
    const app = createApp();
    const first = await request(app).get("/api/watchdog/events?limit=2");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, hasMore: true, limit: 2 });
    expect(typeof first.body.nextCursor).toBe("string");
    expect(first.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    insert("repair", "crash_loop", "ok");
    const ids = first.body.events.map((event) => event.id);
    let cursor = first.body.nextCursor;
    while (cursor) {
      const page = await request(app).get(`/api/watchdog/events?limit=2&cursor=${cursor}`);
      expect(page.status).toBe(200);
      ids.push(...page.body.events.map((event) => event.id));
      cursor = page.body.nextCursor;
      expect(Boolean(cursor)).toBe(page.body.hasMore);
    }
    expect(ids).toEqual([5, 4, 3, 2, 1]);
  });

  it("filters by comma-separated eventType and source", async () => {
    insert("crash", "exit_event");
    insert("repair", "crash_loop", "ok");
    insert("memory", "memory-monitor", "warning");
    const app = createApp();
    const byType = await request(app).get("/api/watchdog/events?eventType=crash,memory");
    expect(byType.body.events.map((event) => event.eventType)).toEqual(["memory", "crash"]);
    const bySource = await request(app).get("/api/watchdog/events?source=crash_loop");
    expect(bySource.body.events.map((event) => event.source)).toEqual(["crash_loop"]);
    expect(bySource.body.hasMore).toBe(false);
  });

  it("accepts zoned ISO-8601 and bare dates for since/until", async () => {
    insert();
    const app = createApp();
    const wide = await request(app).get(
      "/api/watchdog/events?since=2000-01-01&until=2999-01-01T00:00:00%2B02:00",
    );
    expect(wide.status).toBe(200);
    expect(wide.body.events).toHaveLength(1);
    const future = await request(app).get("/api/watchdog/events?since=2999-01-01T00:00:00Z");
    expect(future.body).toMatchObject({ ok: true, events: [], hasMore: false, nextCursor: null });
  });

  it("rejects a valid cursor with trailing bytes the decoder would ignore", async () => {
    for (let i = 0; i < 3; i += 1) insert();
    const app = createApp();
    const first = await request(app).get("/api/watchdog/events?limit=1");
    const ok = await request(app).get(`/api/watchdog/events?limit=1&cursor=${first.body.nextCursor}`);
    expect(ok.status).toBe(200);
    const padded = await request(app).get(`/api/watchdog/events?limit=1&cursor=${first.body.nextCursor}!!!`);
    expect(padded.status).toBe(400);
    expect(padded.body.code).toBe("invalid_cursor");
  });

  it.each([
    ["since=2026-10-24T10:00:00", "invalid_since"],
    ["since=yesterday", "invalid_since"],
    ["until=2026-13-40T00:00:00Z", "invalid_until"],
    ["since=2026-10-24T00:00:00Z&until=2026-10-24T00:00:00Z", "invalid_range"],
    ["cursor=not-a-cursor", "invalid_cursor"],
    [`cursor=${Buffer.from(JSON.stringify(["2026-10-24", 1])).toString("base64url")}`, "invalid_cursor"],
    [`cursor=${Buffer.from(JSON.stringify(["2026-10-24T00:00:00.000Z", -1])).toString("base64url")}`, "invalid_cursor"],
    ["eventType=crash;drop", "invalid_eventType"],
    ["eventType=,,", "invalid_eventType"],
    [`source=${Array.from({ length: 21 }, (_, i) => `s${i}`).join(",")}`, "invalid_source"],
    ["since=2026-10-24&since=2026-10-25", "invalid_since"],
    ["until=2026-10-24T00:00:00.000000001Z", "invalid_until"],
    ["since=2026-02-30", "invalid_since"],
    ["since=2026-10-24T24:00:00Z", "invalid_since"],
    [`cursor=${Buffer.from(JSON.stringify(["2026-99-99T99:99:99.999Z", 1])).toString("base64url")}`, "invalid_cursor"],
  ])("rejects %s with 400 %s", async (query, code) => {
    const res = await request(createApp()).get(`/api/watchdog/events?${query}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, code });
    expect(typeof res.body.error).toBe("string");
  });
});
