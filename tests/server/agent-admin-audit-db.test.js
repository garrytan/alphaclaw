const fs = require("fs");
const os = require("os");
const path = require("path");

// getAgentAdminEvents scans the watchdog_events table for event_type =
// 'agent_admin', parses each row's JSON details, and filters/tallies in JS.
// These tests drive it against a real on-disk sqlite db.
const loadWatchdogDb = () => {
  const modulePath = require.resolve("../../lib/server/db/watchdog");
  delete require.cache[modulePath];
  return require(modulePath);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let db = null;
let rootDir = "";

// Convenience: an agent_admin row whose details carry op/tier/code.
const insertAdmin = ({ op, tier, code, status = "success" }) =>
  db.insertWatchdogEvent({
    eventType: "agent_admin",
    source: "agent-admin",
    status,
    details: { op, tier, code },
  });

describe("server/db/watchdog getAgentAdminEvents", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-admin-audit-"));
    fs.mkdirSync(path.join(rootDir, "db"), { recursive: true });
    db = loadWatchdogDb();
    db.initWatchdogDb({ rootDir, pruneDays: 30 });
  });

  afterEach(() => {
    if (db?.closeWatchdogDb) db.closeWatchdogDb();
    db = null;
    if (rootDir) {
      fs.rmSync(rootDir, { recursive: true, force: true });
      rootDir = "";
    }
  });

  it("filters by op", () => {
    insertAdmin({ op: "env.list", tier: "safe", code: "ok" });
    insertAdmin({ op: "env.update", tier: "write", code: "ok" });
    insertAdmin({ op: "agents.delete", tier: "dangerous", code: "ok" });

    const { events } = db.getAgentAdminEvents({ op: "env.list" });

    expect(events).toHaveLength(1);
    expect(events[0].details.op).toBe("env.list");
  });

  it("filters by tier", () => {
    insertAdmin({ op: "env.list", tier: "safe", code: "ok" });
    insertAdmin({ op: "env.update", tier: "write", code: "ok" });
    insertAdmin({ op: "agents.delete", tier: "dangerous", code: "ok" });

    const { events } = db.getAgentAdminEvents({ tier: "dangerous" });

    expect(events).toHaveLength(1);
    expect(events[0].details.tier).toBe("dangerous");
    expect(events[0].details.op).toBe("agents.delete");
  });

  it("filters by code", () => {
    insertAdmin({ op: "env.list", tier: "safe", code: "ok", status: "success" });
    insertAdmin({ op: "env.update", tier: "write", code: "denied", status: "failed" });
    insertAdmin({ op: "agents.delete", tier: "dangerous", code: "denied", status: "failed" });

    const { events } = db.getAgentAdminEvents({ code: "denied" });

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.details.code === "denied")).toBe(true);
  });

  it("filters by since (created_at >= cutoff)", async () => {
    insertAdmin({ op: "env.list", tier: "safe", code: "ok" });
    await sleep(15);
    const cutoff = new Date().toISOString();
    await sleep(15);
    insertAdmin({ op: "env.update", tier: "write", code: "ok" });

    const recent = db.getAgentAdminEvents({ since: cutoff });
    expect(recent.events).toHaveLength(1);
    expect(recent.events[0].details.op).toBe("env.update");

    // A cutoff before both rows returns everything; one after both returns none.
    expect(db.getAgentAdminEvents({ since: "2000-01-01T00:00:00.000Z" }).events).toHaveLength(2);
    expect(db.getAgentAdminEvents({ since: "2999-01-01T00:00:00.000Z" }).events).toHaveLength(0);
  });

  it("honors the request limit and clamps an over-large limit without error", () => {
    for (let i = 0; i < 5; i += 1) {
      insertAdmin({ op: `env.op${i}`, tier: "safe", code: "ok" });
    }

    // limit honored: slice(0, safeLimit) trims to the requested count.
    const one = db.getAgentAdminEvents({ limit: 1 });
    expect(one.events).toHaveLength(1);

    // limit 999 clamps to kAgentAdminMaxLimit (200) via the safeLimit math; with
    // only 5 rows present it simply returns all 5 (never throws, never > cap).
    const many = db.getAgentAdminEvents({ limit: 999 });
    expect(many.events).toHaveLength(5);
    expect(many.events.length).toBeLessThanOrEqual(200);
  });

  it("returns a summary with correct tallies when summary=1", () => {
    insertAdmin({ op: "env.list", tier: "safe", code: "ok", status: "success" });
    insertAdmin({ op: "env.list", tier: "safe", code: "denied", status: "failed" });
    insertAdmin({ op: "agents.delete", tier: "dangerous", code: "ok", status: "success" });

    const result = db.getAgentAdminEvents({ summary: true });

    expect(result.events).toBeUndefined();
    expect(result.summary).toEqual({
      total: 3,
      byOp: { "env.list": 2, "agents.delete": 1 },
      byCode: { ok: 2, denied: 1 },
      byTier: { safe: 2, dangerous: 1 },
      byStatus: { success: 2, failed: 1 },
    });
  });

  it("tolerates a row with corrupt (non-JSON) details and excludes non-agent_admin rows", () => {
    insertAdmin({ op: "env.list", tier: "safe", code: "ok" });
    // details stored verbatim as a raw non-JSON string → JSON.parse throws and
    // is swallowed, so details becomes null (not a crash).
    db.insertWatchdogEvent({
      eventType: "agent_admin",
      source: "agent-admin",
      status: "failed",
      details: "this-is-not-json{",
    });
    // A non-agent_admin row must never surface in these reads.
    db.insertWatchdogEvent({
      eventType: "health_check",
      source: "health_timer",
      status: "ok",
      details: { op: "env.list" },
    });

    // Unfiltered: both agent_admin rows come back (the corrupt one with null
    // details), the health_check row does not.
    const all = db.getAgentAdminEvents({});
    expect(all.events).toHaveLength(2);
    const corrupt = all.events.find((e) => e.details === null);
    expect(corrupt).toBeDefined();
    expect(corrupt.status).toBe("failed");

    // The corrupt row is skipped by any details-based filter, not thrown on.
    const filtered = db.getAgentAdminEvents({ op: "env.list" });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0].details.op).toBe("env.list");

    // Summary counts the corrupt row's missing fields under "(none)".
    const { summary } = db.getAgentAdminEvents({ summary: true });
    expect(summary.total).toBe(2);
    expect(summary.byOp).toEqual({ "env.list": 1, "(none)": 1 });
    expect(summary.byStatus).toEqual({ success: 1, failed: 1 });
  });
});
