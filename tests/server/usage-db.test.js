const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { deriveCostBreakdown } = require("../../lib/server/cost-utils");

const loadUsageDb = () => {
  const modulePath = require.resolve("../../lib/server/db/usage");
  delete require.cache[modulePath];
  return require(modulePath);
};

let currentUsageDb = null;
let currentDatabase = null;
let currentRootDir = "";

const createUsageDbContext = (prefix) => {
  currentRootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  currentUsageDb = loadUsageDb();
  const { path: dbPath } = currentUsageDb.initUsageDb({ rootDir: currentRootDir });
  currentDatabase = new DatabaseSync(dbPath);
  return {
    ...currentUsageDb,
    database: currentDatabase,
    rootDir: currentRootDir,
  };
};

describe("server/usage-db", () => {
  afterEach(() => {
    if (currentDatabase) {
      currentDatabase.close();
      currentDatabase = null;
    }
    if (currentUsageDb?.closeUsageDb) {
      currentUsageDb.closeUsageDb();
      currentUsageDb = null;
    }
    if (currentRootDir) {
      fs.rmSync(currentRootDir, { recursive: true, force: true });
      currentRootDir = "";
    }
  });

  it("sums per-model costs for session detail totals", () => {
    const { database, getSessionDetail } = createUsageDbContext("usage-db-cost-");

    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp,
        session_id,
        session_key,
        run_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens
      ) VALUES (
        $timestamp,
        $session_id,
        $session_key,
        $run_id,
        $provider,
        $model,
        $input_tokens,
        $output_tokens,
        $cache_read_tokens,
        $cache_write_tokens,
        $total_tokens
      )
    `);

    insertUsageEvent.run({
      $timestamp: Date.now() - 1000,
      $session_id: "raw-session-1",
      $session_key: "session-1",
      $run_id: "run-1",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 1_000_000,
      $output_tokens: 0,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });
    insertUsageEvent.run({
      $timestamp: Date.now(),
      $session_id: "raw-session-1",
      $session_key: "session-1",
      $run_id: "run-2",
      $provider: "anthropic",
      $model: "claude-opus-4-6",
      $input_tokens: 0,
      $output_tokens: 1_000_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });

    const detail = getSessionDetail({ sessionId: "session-1" });
    const expectedCost =
      deriveCostBreakdown({
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }).totalCost +
      deriveCostBreakdown({
        provider: "anthropic",
        model: "claude-opus-4-6",
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }).totalCost;
    const summedBreakdownCost = detail.modelBreakdown.reduce(
      (sum, row) => sum + Number(row.totalCost || 0),
      0,
    );

    expect(detail).toBeTruthy();
    expect(detail.totalCost).toBeCloseTo(expectedCost, 8);
    expect(detail.totalCost).toBeCloseTo(summedBreakdownCost, 8);
  });

  it("returns cost distribution by agent and source", () => {
    const { database, getDailySummary } = createUsageDbContext("usage-db-agent-breakdown-");
    const now = Date.now();

    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp,
        session_id,
        session_key,
        run_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens
      ) VALUES (
        $timestamp,
        $session_id,
        $session_key,
        $run_id,
        $provider,
        $model,
        $input_tokens,
        $output_tokens,
        $cache_read_tokens,
        $cache_write_tokens,
        $total_tokens
      )
    `);

    insertUsageEvent.run({
      $timestamp: now - 2_000,
      $session_id: "raw-a",
      $session_key: "agent:main:telegram:direct:123",
      $run_id: "run-a",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 1_000_000,
      $output_tokens: 0,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });
    insertUsageEvent.run({
      $timestamp: now - 1_000,
      $session_id: "raw-b",
      $session_key: "agent:main:hook:gmail:abc123",
      $run_id: "run-b",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 0,
      $output_tokens: 1_000_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });
    insertUsageEvent.run({
      $timestamp: now - 500,
      $session_id: "raw-c",
      $session_key: "agent:ops:cron:nightly",
      $run_id: "run-c",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 0,
      $output_tokens: 1_000_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });

    const summary = getDailySummary({ days: 7, timeZone: "UTC" });

    expect(summary?.costByAgent).toBeTruthy();
    expect(Array.isArray(summary.costByAgent.agents)).toBe(true);
    expect(Array.isArray(summary.daily)).toBe(true);
    expect(summary.daily.length).toBeGreaterThan(0);
    expect(Array.isArray(summary.daily[0].sources)).toBe(true);
    expect(Array.isArray(summary.daily[0].agents)).toBe(true);

    const mainAgent = summary.costByAgent.agents.find((row) => row.agent === "main");
    const opsAgent = summary.costByAgent.agents.find((row) => row.agent === "ops");

    expect(mainAgent).toBeTruthy();
    expect(opsAgent).toBeTruthy();
    expect(mainAgent.totalCost).toBeCloseTo(12.5, 8);
    expect(opsAgent.totalCost).toBeCloseTo(10, 8);

    const mainChat = mainAgent.sourceBreakdown.find((row) => row.source === "chat");
    const mainHooks = mainAgent.sourceBreakdown.find((row) => row.source === "hooks");
    const mainCron = mainAgent.sourceBreakdown.find((row) => row.source === "cron");

    expect(mainChat.totalCost).toBeCloseTo(2.5, 8);
    expect(mainHooks.totalCost).toBeCloseTo(10, 8);
    expect(mainCron.totalCost).toBeCloseTo(0, 8);

    const opsCron = opsAgent.sourceBreakdown.find((row) => row.source === "cron");
    expect(opsCron.totalCost).toBeCloseTo(10, 8);

    const dailySources = summary.daily[0].sources;
    const dailyAgents = summary.daily[0].agents;
    const dailyChat = dailySources.find((row) => row.source === "chat");
    const dailyHooks = dailySources.find((row) => row.source === "hooks");
    const dailyCron = dailySources.find((row) => row.source === "cron");
    const dailyMain = dailyAgents.find((row) => row.agent === "main");
    const dailyOps = dailyAgents.find((row) => row.agent === "ops");

    expect(dailyChat.totalCost).toBeCloseTo(2.5, 8);
    expect(dailyHooks.totalCost).toBeCloseTo(10, 8);
    expect(dailyCron.totalCost).toBeCloseTo(10, 8);
    expect(dailyMain.totalCost).toBeCloseTo(12.5, 8);
    expect(dailyOps.totalCost).toBeCloseTo(10, 8);

    expect(summary.costByAgent.totals.totalCost).toBeCloseTo(22.5, 8);
  });

  it("applies tiered pricing per event, not aggregated totals", () => {
    const { database, getSessionDetail } = createUsageDbContext("usage-db-tiered-event-");
    const now = Date.now();

    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp,
        session_id,
        session_key,
        run_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens
      ) VALUES (
        $timestamp,
        $session_id,
        $session_key,
        $run_id,
        $provider,
        $model,
        $input_tokens,
        $output_tokens,
        $cache_read_tokens,
        $cache_write_tokens,
        $total_tokens
      )
    `);

    // Each event stays below the 200k threshold, so both should use 25/M output rate.
    insertUsageEvent.run({
      $timestamp: now - 1000,
      $session_id: "raw-tier-1",
      $session_key: "session-tier-1",
      $run_id: "run-tier-1",
      $provider: "anthropic",
      $model: "claude-opus-4-6",
      $input_tokens: 0,
      $output_tokens: 150_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 150_000,
    });
    insertUsageEvent.run({
      $timestamp: now,
      $session_id: "raw-tier-1",
      $session_key: "session-tier-1",
      $run_id: "run-tier-2",
      $provider: "anthropic",
      $model: "claude-opus-4-6",
      $input_tokens: 0,
      $output_tokens: 150_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 150_000,
    });

    const detail = getSessionDetail({ sessionId: "session-tier-1" });

    expect(detail).toBeTruthy();
    expect(detail.totalCost).toBeCloseTo(7.5, 8);
  });

  it("aggregates usage by session key pattern", () => {
    const { database, getSessionUsageByKeyPattern } = createUsageDbContext("usage-db-pattern-");
    const now = Date.now();

    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp,
        session_id,
        session_key,
        run_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens
      ) VALUES (
        $timestamp,
        $session_id,
        $session_key,
        $run_id,
        $provider,
        $model,
        $input_tokens,
        $output_tokens,
        $cache_read_tokens,
        $cache_write_tokens,
        $total_tokens
      )
    `);

    insertUsageEvent.run({
      $timestamp: now - 1000,
      $session_id: "raw-1",
      $session_key: "agent:main:cron:job-123:run:1",
      $run_id: "run-1",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 1_000_000,
      $output_tokens: 0,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 1_000_000,
    });
    insertUsageEvent.run({
      $timestamp: now,
      $session_id: "raw-2",
      $session_key: "agent:main:cron:job-123:run:2",
      $run_id: "run-2",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 0,
      $output_tokens: 500_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 500_000,
    });
    insertUsageEvent.run({
      $timestamp: now,
      $session_id: "raw-3",
      $session_key: "agent:main:cron:job-999:run:1",
      $run_id: "run-x",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 200_000,
      $output_tokens: 0,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 200_000,
    });

    const usage = getSessionUsageByKeyPattern({
      keyPattern: "%:cron:job-123%",
      sinceMs: now - 10_000,
    });

    expect(usage.totals.totalTokens).toBe(1_500_000);
    expect(usage.totals.runCount).toBe(2);
    expect(usage.totals.totalCost).toBeCloseTo(7.5, 8);
    expect(usage.modelBreakdown).toHaveLength(1);
    expect(usage.modelBreakdown[0].model).toBe("gpt-4o");
  });

  it("counts distinct cron runs correctly across multi-model events", () => {
    const { database, getSessionUsageByKeyPattern } =
      createUsageDbContext("usage-db-pattern-run-count-");
    const now = Date.now();

    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp,
        session_id,
        session_key,
        run_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens
      ) VALUES (
        $timestamp,
        $session_id,
        $session_key,
        $run_id,
        $provider,
        $model,
        $input_tokens,
        $output_tokens,
        $cache_read_tokens,
        $cache_write_tokens,
        $total_tokens
      )
    `);

    // Same run_id/session_key appears in multiple model rows (one cron run with tool/model fan-out).
    insertUsageEvent.run({
      $timestamp: now - 500,
      $session_id: "raw-run-shared",
      $session_key: "agent:main:cron:daily-creative:shared",
      $run_id: "run-shared",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 100_000,
      $output_tokens: 0,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 100_000,
    });
    insertUsageEvent.run({
      $timestamp: now - 400,
      $session_id: "raw-run-shared",
      $session_key: "agent:main:cron:daily-creative:shared",
      $run_id: "run-shared",
      $provider: "anthropic",
      $model: "claude-sonnet-4-6",
      $input_tokens: 40_000,
      $output_tokens: 10_000,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 50_000,
    });
    insertUsageEvent.run({
      $timestamp: now - 300,
      $session_id: "raw-run-next",
      $session_key: "agent:main:cron:daily-creative:next",
      $run_id: "run-next",
      $provider: "openai",
      $model: "gpt-4o",
      $input_tokens: 50_000,
      $output_tokens: 0,
      $cache_read_tokens: 0,
      $cache_write_tokens: 0,
      $total_tokens: 50_000,
    });

    const usage = getSessionUsageByKeyPattern({
      keyPattern: "%:cron:daily-creative:%",
      sinceMs: now - 10_000,
    });

    expect(usage.totals.eventCount).toBe(3);
    expect(usage.totals.runCount).toBe(2);
    expect(usage.totals.totalTokens).toBe(200_000);
  });

  it("getSessionsList reads every selected session's events in ONE query and keeps per-event costing (fix wave F076)", () => {
    const { database } = createUsageDbContext("usage-db-sessions-1n-");
    const sessions = require("../../lib/server/db/usage/sessions");
    const insertUsageEvent = database.prepare(`
      INSERT INTO usage_events (
        timestamp, session_id, session_key, run_id, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens
      ) VALUES (
        $timestamp, $session_id, $session_key, $run_id, $provider, $model,
        $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $total_tokens
      )
    `);
    const now = Date.now();
    const events = [
      { session_key: "s-a", session_id: "", model: "anthropic/claude-opus-4.7", input: 1000, output: 100, ts: now - 5000 },
      { session_key: "s-a", session_id: "", model: "openai/gpt-5.6", input: 500, output: 50, ts: now - 4000 },
      { session_key: "", session_id: "raw-b", model: "anthropic/claude-opus-4.7", input: 200, output: 20, ts: now - 3000 },
      { session_key: "s-c", session_id: "raw-c", model: "openai/gpt-5.6", input: 300, output: 30, ts: now - 2000 },
    ];
    for (const event of events) {
      insertUsageEvent.run({
        $timestamp: event.ts,
        $session_id: event.session_id,
        $session_key: event.session_key,
        $run_id: "run",
        $provider: event.model.split("/")[0],
        $model: event.model,
        $input_tokens: event.input,
        $output_tokens: event.output,
        $cache_read_tokens: 0,
        $cache_write_tokens: 0,
        $total_tokens: event.input + event.output,
      });
    }

    const prepareSpy = vi.spyOn(database, "prepare");
    const list = sessions.getSessionsList({ database, limit: 10 });
    // One aggregate query + one events query — never one per session row.
    expect(prepareSpy).toHaveBeenCalledTimes(2);
    prepareSpy.mockRestore();

    expect(list.map((row) => row.sessionId)).toEqual(["s-c", "raw-b", "s-a"]);
    const sessionA = list.find((row) => row.sessionId === "s-a");
    expect(sessionA.turnCount).toBe(2);
    expect(sessionA.totalTokens).toBe(1650);
    expect(sessionA.dominantModel).toBe("anthropic/claude-opus-4.7");
    const expectedCostA =
      deriveCostBreakdown({ provider: "anthropic", model: "anthropic/claude-opus-4.7", inputTokens: 1000, outputTokens: 100 }).totalCost +
      deriveCostBreakdown({ provider: "openai", model: "openai/gpt-5.6", inputTokens: 500, outputTokens: 50 }).totalCost;
    expect(sessionA.totalCost).toBeCloseTo(expectedCostA, 10);
    const sessionB = list.find((row) => row.sessionId === "raw-b");
    expect(sessionB.rawSessionId).toBe("raw-b");
    expect(sessionB.turnCount).toBe(1);
  });

  it("getSessionsList with no sessions issues a single query and returns []", () => {
    const { database } = createUsageDbContext("usage-db-sessions-empty-");
    const sessions = require("../../lib/server/db/usage/sessions");
    const prepareSpy = vi.spyOn(database, "prepare");
    expect(sessions.getSessionsList({ database, limit: 10 })).toEqual([]);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    prepareSpy.mockRestore();
  });

  it("the schema carries the session-ref expression index (fix wave F076)", () => {
    const { database } = createUsageDbContext("usage-db-sessions-index-");
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("idx_usage_events_session_ref");
  });
});

// withStaleOnBusy: reads that hit SQLITE_BUSY after the 250ms busy_timeout
// serve the previous result for the same args instead of 500ing. The module's
// db handle is a DatabaseSync instance, so a prototype spy on prepare() is the
// deterministic injection point for busy errors — no cross-process writer.
describe("server/usage-db stale-on-busy reads", () => {
  const insertCronEvent = (database) => {
    database
      .prepare(
        `INSERT INTO usage_events (
           timestamp, session_id, session_key, run_id, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           total_tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        "raw-busy",
        "agent:main:cron:busy-job:run:1",
        "run-busy",
        "openai",
        "gpt-4o",
        1_000,
        0,
        0,
        0,
        1_000,
      );
  };

  const makeBusyPrepareSpy = (error) =>
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(() => {
      throw error;
    });

  it("returns the previous (stale) result when a repeat read hits SQLITE_BUSY", () => {
    const { database, getSessionUsageByKeyPattern } =
      createUsageDbContext("usage-db-busy-stale-");
    insertCronEvent(database);
    const options = { keyPattern: "%:cron:busy-job%", sinceMs: 0 };

    const fresh = getSessionUsageByKeyPattern(options);
    expect(fresh.totals.totalTokens).toBe(1_000);

    const prepareSpy = makeBusyPrepareSpy(new Error("database is locked"));
    const stale = getSessionUsageByKeyPattern(options);

    expect(prepareSpy).toHaveBeenCalled();
    // The exact cached result object: served as-is, not recomputed.
    expect(stale).toBe(fresh);
  });

  it("rethrows SQLITE_BUSY on a first-ever call with no cached value", () => {
    const { database, getSessionUsageByKeyPattern } =
      createUsageDbContext("usage-db-busy-first-");
    insertCronEvent(database);

    makeBusyPrepareSpy(new Error("database is locked"));

    expect(() =>
      getSessionUsageByKeyPattern({ keyPattern: "%:cron:busy-job%", sinceMs: 0 }),
    ).toThrow(/locked/);
  });

  it("rethrows non-busy errors even when a stale value is cached", () => {
    const { database, getSessionUsageByKeyPattern } =
      createUsageDbContext("usage-db-nonbusy-");
    insertCronEvent(database);
    const options = { keyPattern: "%:cron:busy-job%", sinceMs: 0 };

    getSessionUsageByKeyPattern(options);
    makeBusyPrepareSpy(new Error("database disk image is malformed"));

    expect(() => getSessionUsageByKeyPattern(options)).toThrow(/malformed/);
  });

  it("treats errcode 5 as busy even when the message never says busy/locked", () => {
    const { database, getSessionUsageByKeyPattern } =
      createUsageDbContext("usage-db-errcode-");
    insertCronEvent(database);
    const options = { keyPattern: "%:cron:busy-job%", sinceMs: 0 };

    const fresh = getSessionUsageByKeyPattern(options);
    // node:sqlite surfaces the structured code; the message alone would NOT
    // match the /busy|locked/ fallback regex.
    makeBusyPrepareSpy(
      Object.assign(new Error("operation failed"), { errcode: 5 }),
    );

    expect(getSessionUsageByKeyPattern(options)).toBe(fresh);
  });

  it("closeUsageDb clears the fallback cache: a busy read after reinit rethrows", () => {
    const context = createUsageDbContext("usage-db-cache-clear-");
    const { database, getSessionUsageByKeyPattern, closeUsageDb, initUsageDb } =
      context;
    insertCronEvent(database);
    const options = { keyPattern: "%:cron:busy-job%", sinceMs: 0 };

    const fresh = getSessionUsageByKeyPattern(options);
    expect(fresh.totals.totalTokens).toBe(1_000);

    closeUsageDb();
    initUsageDb({ rootDir: context.rootDir });

    // Same args as the previously-cached read, but close cleared the cache:
    // busy must surface instead of resurrecting a pre-close result.
    makeBusyPrepareSpy(new Error("database is locked"));
    expect(() => getSessionUsageByKeyPattern(options)).toThrow(/locked/);
  });
});
