const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createCronService } = require("../../lib/server/cron-service");
const express = require("express");
const request = require("supertest");
const { registerCronRoutes } = require("../../lib/server/routes/cron");
const { beginStateDbQuiet, getStateDbHandleCount } = require("../../lib/server/state-db-quiet");

const roots = [];
const makeFixture = ({ version = "2026.9.5" } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-runs-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "state"));
  fs.mkdirSync(path.join(root, "cron", "runs"), { recursive: true });
  fs.writeFileSync(path.join(root, "cron", "jobs.json"), JSON.stringify({ jobs: [{ id: "job-a" }] }));
  const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
  db.exec(`
    PRAGMA user_version = 17;
    CREATE TABLE task_runs (
      task_id TEXT PRIMARY KEY, runtime TEXT, source_id TEXT, created_at INTEGER,
      ended_at INTEGER, last_event_at INTEGER, child_session_key TEXT,
      error TEXT, terminal_summary TEXT, detail_json TEXT
    );
    CREATE INDEX idx_task_runs_runtime_source_ended
      ON task_runs(runtime, source_id, ended_at, created_at, task_id);
    CREATE INDEX idx_task_runs_runtime_ended
      ON task_runs(runtime, ended_at, created_at, task_id);
  `);
  const insert = (id, detail = {}, options = {}) => db.prepare(`
    INSERT INTO task_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, options.runtime || "cron", options.jobId || "job-a", options.createdAt ?? 1,
    options.ts ?? Date.now(), options.lastEventAt ?? null, "agent:main:cron:job-a:run:fixture",
    null, null, JSON.stringify({ kind: "cron-run", storeKey: path.join(root, "cron", "jobs.json"), status: "ok", ...detail }));
  const clawCmd = vi.fn();
  const service = createCronService({ OPENCLAW_DIR: root, clawCmd, getInstalledVersion: () => version, getSessionUsageByKeyPattern: () => ({}) });
  return { root, db, insert, service, clawCmd };
};

const legacySchema = `
  CREATE TABLE cron_run_logs (
    store_key TEXT NOT NULL, job_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
    status TEXT, error TEXT, summary TEXT, diagnostics_summary TEXT, delivery_status TEXT,
    delivery_error TEXT, delivered INTEGER, session_id TEXT, session_key TEXT, run_id TEXT,
    run_at_ms INTEGER, duration_ms INTEGER, next_run_at_ms INTEGER, model TEXT, provider TEXT,
    total_tokens INTEGER, entry_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (store_key, job_id, seq)
  );
  CREATE INDEX idx_cron_run_logs_store_ts ON cron_run_logs(store_key, ts DESC, seq DESC);
  CREATE INDEX idx_cron_run_logs_job_status ON cron_run_logs(store_key, job_id, status, ts DESC, seq DESC);
  CREATE INDEX idx_cron_run_logs_delivery ON cron_run_logs(store_key, delivery_status, ts DESC, seq DESC) WHERE delivery_status IS NOT NULL;
`;
const appFor = (service) => {
  const app = express();
  registerCronRoutes({ app, requireAuth: (_req, _res, next) => next(), cronService: service });
  return app;
};
const historyUrls = [
  "/api/cron/jobs/job-a/runs", "/api/cron/jobs/job-a/trends", "/api/cron/jobs/job-a/usage",
  "/api/cron/runs/bulk", "/api/cron/usage/bulk",
];

afterEach(() => {
  const { closeCronStoreDb } = require("../../lib/server/cron-store");
  closeCronStoreDb();
  vi.useRealTimers();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("authoritative cron outcomes", () => {
  it("reads current task-run detail, not stale JSONL or generic task vocabulary", () => {
    const { root, db, insert, service, clawCmd } = makeFixture();
    insert("task-a", { status: "skipped", deliveryStatus: "not-requested", durationMs: 123,
      summary: "current task result", usage: { input_tokens: 5, output_tokens: 7 } });
    db.close();
    fs.writeFileSync(path.join(root, "cron", "runs", "job-a.jsonl"), JSON.stringify({
      action: "finished", jobId: "job-a", ts: Date.now(), status: "error", summary: "stale file",
    }));
    expect(service.getJobRuns({ jobId: "job-a" })).toMatchObject({ total: 1, entries: [{
      status: "skipped", summary: "current task result", durationMs: 123,
      deliveryStatus: "not-requested", usage: { input_tokens: 5, output_tokens: 7 },
    }] });
    expect(service.getJobUsage({ jobId: "job-a" }).totals).toMatchObject({ totalDurationMs: 123, durationSamples: 1 });
    expect(service.getJobRunTrends({ jobId: "job-a" }).points.reduce((sum, point) => sum + point.totalTokens, 0)).toBe(12);
    expect(service.getBulkJobRuns().byJobId["job-a"].entries[0].summary).toBe("current task result");
    expect(clawCmd).not.toHaveBeenCalled();
  });

  it("preserves filters, Unicode text search, stable tied pagination, and partition isolation", () => {
    const { db, insert, service } = makeFixture();
    for (const id of ["c", "a", "b"]) insert(id, { summary: `Éclair ${id}`, model: "gpt-4o", provider: "OpenAI", deliveryStatus: "delivered", delivered: true, status: "error" }, { ts: 100 });
    insert("other-store", { storeKey: "/other/jobs.json", summary: "Éclair other" }, { ts: 100 });
    insert("other-runtime", {}, { runtime: "subagent", ts: 100 });
    insert("quiet-trigger", { kind: undefined }, { ts: 100 });
    insert("other-job", {}, { jobId: "other", ts: 100 });
    insert("later-created", { summary: "Éclair d", status: "skipped" }, { ts: 100, createdAt: 2 });
    db.close();
    expect(service.getJobRuns({ jobId: "job-a", limit: 2 }).entries.map((entry) => entry.summary)).toEqual(["Éclair d", "Éclair c"]);
    expect(service.getJobRuns({ jobId: "job-a", limit: 2, offset: 2 })).toMatchObject({ total: 4, hasMore: false, nextOffset: null, entries: [{ summary: "Éclair b" }, { summary: "Éclair a" }] });
    expect(service.getJobRuns({ jobId: "job-a", sortDir: "asc", status: "error", deliveryStatus: "delivered", query: "éCLAIR" })).toMatchObject({ total: 3, entries: [{ summary: "Éclair a" }, { summary: "Éclair b" }, { summary: "Éclair c" }] });
    expect(service.getJobRuns({ jobId: "job-a", query: "GPT-4O OPENAI" }).total).toBe(3);
    expect(service.getJobRuns({ jobId: "job-a", deliveryStatus: "not-requested" }).total).toBe(1);
    expect(service.getJobRuns({ jobId: "job-a", offset: 20 })).toMatchObject({ total: 4, offset: 20, entries: [] });
  });

  it("uses the task timestamp fallback and never infers cron status from lifecycle fields", () => {
    const { db, insert, service } = makeFixture();
    insert("last-event", { status: "ok" }, { lastEventAt: 200 });
    insert("created", { status: "skipped" }, { createdAt: 150 });
    db.exec("UPDATE task_runs SET ended_at = NULL");
    db.close();
    expect(service.getJobRuns({ jobId: "job-a" }).entries.map(({ ts, status }) => ({ ts, status }))).toEqual([{ ts: 200, status: "ok" }, { ts: 150, status: "skipped" }]);
  });

  it("keeps optional malformed detail fields out of filters and duration aggregates consistently", () => {
    const { db, insert, service } = makeFixture();
    insert("bad-optional", { summary: 31415, deliveryStatus: false, durationMs: 1.5 });
    insert("good", { durationMs: 0 });
    db.close();
    expect(service.getJobRuns({ jobId: "job-a", query: "31415" }).total).toBe(0);
    expect(service.getJobRuns({ jobId: "job-a", deliveryStatus: "not-requested" }).total).toBe(2);
    expect(service.getJobUsage({ jobId: "job-a" }).totals).toMatchObject({ totalDurationMs: 0, durationSamples: 1 });
    expect(service.getJobRunTrends({ jobId: "job-a" }).points.reduce((sum, point) => sum + point.durationSamples, 0)).toBe(1);
  });

  it("reads the actual older cron_run_logs shape even while generic task_runs exists", async () => {
    const { root, db, insert, service } = makeFixture({ version: "2026.7.1-2" });
    insert("ignored-task", { summary: "not the old authority" });
    db.exec(`PRAGMA user_version = 1; ${legacySchema}`);
    const entry = { action: "finished", jobId: "job-a", ts: 100, status: "ok", summary: "old summary", durationMs: 8, usage: { total_tokens: 20 } };
    db.prepare(`INSERT INTO cron_run_logs (store_key, job_id, seq, ts, status, summary, delivered, delivery_status, duration_ms, entry_json, created_at) VALUES (?, 'job-a', 1, ?, 'error', 'projected summary', 0, 'not-delivered', 42, ?, 1)`).run(path.join(root, "cron", "jobs.json"), Date.now(), JSON.stringify(entry));
    db.close();
    const response = await request(appFor(service)).get(historyUrls[0]);
    expect(response.status).toBe(200);
    expect(response.body.runs).toMatchObject({ total: 1, entries: [{ status: "error", summary: "projected summary", delivered: false, deliveryStatus: "not-delivered", durationMs: 42, usage: { total_tokens: 20 } }] });
    expect(service.getJobUsage({ jobId: "job-a" }).totals).toMatchObject({ totalDurationMs: 42, durationSamples: 1 });
    expect(service.getJobRunTrends({ jobId: "job-a" }).points.reduce((sum, point) => sum + point.totalTokens, 0)).toBe(20);
    expect(service.getBulkJobRuns().byJobId["job-a"].entries[0].summary).toBe("projected summary");
  });

  it.each(["task", "legacy"])("keeps an empty %s authority empty despite stale JSONL", (kind) => {
    const { root, db, service } = makeFixture({ version: kind === "legacy" ? "2026.7.1-2" : "2026.9.5" });
    if (kind === "legacy") db.exec(legacySchema);
    db.close();
    fs.writeFileSync(path.join(root, "cron", "runs", "job-a.jsonl"), `${JSON.stringify({ action: "finished", jobId: "job-a", ts: 100, summary: "stale" })}\n`);
    expect(service.getJobRuns({ jobId: "job-a" }).total).toBe(0);
    expect(service.getJobUsage({ jobId: "job-a" }).totals.durationSamples).toBe(0);
  });

  it.each(["2026.7.2-beta.1", "2026.8.1", "2026.9.5"])("keeps task runs authoritative on %s despite a stale legacy table at schema 17", (version) => {
    const { root, db, insert, service } = makeFixture({ version });
    db.exec(legacySchema);
    db.prepare("INSERT INTO cron_run_logs (store_key, job_id, seq, ts, entry_json, created_at) VALUES (?, 'job-a', 1, 100, ?, 1)")
      .run(path.join(root, "cron", "jobs.json"), JSON.stringify({ action: "finished", jobId: "job-a", ts: 100, summary: "stale legacy" }));
    expect(service.getJobRuns({ jobId: "job-a" }).total).toBe(0);
    insert("current", { summary: "current authority" });
    expect(service.getJobRuns({ jobId: "job-a" }).entries.map((entry) => entry.summary)).toEqual(["current authority"]);
    db.exec("ALTER TABLE task_runs RENAME COLUMN detail_json TO renamed_detail");
    expect(() => service.getJobRuns({ jobId: "job-a" })).toThrow(/unavailable/);
    db.close();
  });

  it.each(["2026.9.5", null])("refuses a partial or ambiguous migration rather than selecting the legacy table (%s)", (version) => {
    const { db, service } = makeFixture({ version });
    db.exec(legacySchema);
    if (version) db.exec("DROP TABLE task_runs");
    expect(() => service.getJobRuns({ jobId: "job-a" })).toThrow(/unavailable/);
    db.close();
  });

  it("does not substitute generic task history for a missing older-runtime cron table", () => {
    const { db, insert, service } = makeFixture({ version: "2026.7.1-2" });
    insert("mirror", { summary: "not the old authority" });
    db.close();
    expect(() => service.getJobRuns({ jobId: "job-a" })).toThrow(/unavailable/);
  });

  it("keeps genuine file-era API reads, pagination, and the bounded tail contract", async () => {
    const { root, db, service } = makeFixture({ version: "2026.5.28" });
    db.close();
    fs.unlinkSync(path.join(root, "state", "openclaw.sqlite"));
    const rows = Array.from({ length: 4000 }, (_, index) => ({ action: "finished", jobId: "job-a", ts: index + 1, status: "ok", summary: "x".repeat(100), durationMs: 10 }));
    fs.writeFileSync(path.join(root, "cron", "runs", "job-a.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const response = await request(appFor(service)).get(`${historyUrls[0]}?limit=2`);
    expect(response.status).toBe(200);
    expect(response.body.runs.total).toBeLessThan(4000);
    expect(response.body.runs.entries.map((entry) => entry.ts)).toEqual([4000, 3999]);
    expect(service.getJobRuns({ jobId: "missing" }).total).toBe(0);
  });

  it("respects a verified file-era runtime even if an old database remains after downgrade", () => {
    const { root, db, insert } = makeFixture();
    insert("stale-database", { summary: "stale database" });
    db.close();
    fs.writeFileSync(path.join(root, "cron", "runs", "job-a.jsonl"), `${JSON.stringify({ action: "finished", jobId: "job-a", ts: 100, summary: "file authority" })}\n`);
    const service = createCronService({ OPENCLAW_DIR: root, getInstalledVersion: () => "2026.5.28" });
    expect(service.getJobRuns({ jobId: "job-a" }).entries[0].summary).toBe("file authority");
  });

  it.each(["2026.5.30-beta.1", "2026.6.1", "2026.7.1-2", "2026.9.5", "dev-sha", null])("never falls back on a missing DB with a non-file runtime hint %s", (version) => {
    const { root, db } = makeFixture();
    db.close();
    fs.unlinkSync(path.join(root, "state", "openclaw.sqlite"));
    const service = createCronService({ OPENCLAW_DIR: root, getInstalledVersion: () => version });
    expect(() => service.getJobRuns({ jobId: "job-a" })).toThrow(/unavailable/);
  });

  it("reports an unreadable file-era log instead of treating it as missing", async () => {
    const { root, db, service } = makeFixture({ version: "2026.5.28" });
    db.close();
    fs.unlinkSync(path.join(root, "state", "openclaw.sqlite"));
    fs.mkdirSync(path.join(root, "cron", "runs", "job-a.jsonl"));
    for (const url of historyUrls.filter((url) => !url.endsWith("usage/bulk"))) {
      const response = await request(appFor(service)).get(url);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("cron_history_unavailable");
    }
  });

  it("recovers after an exclusive writer without serving a stale file during SQLITE_BUSY", () => {
    const { db, insert, service } = makeFixture();
    insert("ready", { summary: "current" });
    db.exec("BEGIN EXCLUSIVE");
    try {
      expect(() => service.getJobRuns({ jobId: "job-a" })).toThrow(/unavailable/);
      expect(getStateDbHandleCount()).toBe(0);
    } finally {
      db.exec("ROLLBACK");
      db.close();
    }
    expect(service.getJobRuns({ jobId: "job-a" }).entries[0].summary).toBe("current");
  });

  it.each(["malformed detail", "unsupported schema", "missing index", "corrupt database", "missing modern database"])("reports %s as unavailable, never empty or stale", async (failure) => {
    const { root, db, insert } = makeFixture();
    insert("bad");
    if (failure === "malformed detail") db.exec("UPDATE task_runs SET detail_json = '{broken'");
    if (failure === "unsupported schema") db.exec("ALTER TABLE task_runs RENAME COLUMN detail_json TO renamed_detail");
    if (failure === "missing index") db.exec("DROP INDEX idx_task_runs_runtime_source_ended");
    db.close();
    if (failure === "corrupt database") fs.writeFileSync(path.join(root, "state", "openclaw.sqlite"), "not SQLite");
    if (failure === "missing modern database") fs.unlinkSync(path.join(root, "state", "openclaw.sqlite"));
    fs.writeFileSync(path.join(root, "cron", "runs", "job-a.jsonl"), `${JSON.stringify({ action: "finished", jobId: "job-a", ts: 100 })}\n`);
    const service = createCronService({ OPENCLAW_DIR: root, clawCmd: vi.fn(), getInstalledVersion: () => "2026.9.5", getSessionUsageByKeyPattern: () => ({}) });
    for (const url of historyUrls.filter((url) => failure !== "malformed detail" || !url.endsWith("usage/bulk"))) {
      const response = await request(appFor(service)).get(url);
      expect(response.status, url).toBe(503);
      expect(response.body).toMatchObject({ ok: false, code: "cron_history_unavailable" });
      expect(response.body.error).not.toContain(root);
    }
    require("../../lib/server/cron-store").closeCronStoreDb();
    expect(getStateDbHandleCount()).toBe(0);
  });

  it("closes tracked handles before quiet, refuses all reads, and resumes on the replaced database", async () => {
    const first = makeFixture();
    first.insert("before", { summary: "before" });
    first.db.close();
    expect(first.service.getJobRuns({ jobId: "job-a" }).entries[0].summary).toBe("before");
    expect(getStateDbHandleCount()).toBe(0);
    const quiet = await beginStateDbQuiet({ owner: "cron-test", maxMs: 10000 });
    try {
      for (const url of historyUrls) {
        const response = await request(appFor(first.service)).get(url);
        expect(response.status).toBe(409);
        expect(response.body.code).toBe("backup_in_progress");
        expect(response.headers["retry-after"]).toBe("120");
      }
      expect(getStateDbHandleCount()).toBe(0);
      const second = makeFixture();
      second.insert("after", { summary: "after", storeKey: path.join(first.root, "cron", "jobs.json") });
      second.db.close();
      fs.renameSync(path.join(second.root, "state", "openclaw.sqlite"), path.join(first.root, "state", "openclaw.sqlite"));
    } finally {
      quiet.release();
    }
    expect(first.service.getJobRuns({ jobId: "job-a" }).entries[0].summary).toBe("after");
    fs.unlinkSync(path.join(first.root, "state", "openclaw.sqlite"));
    expect(() => first.service.getJobRuns({ jobId: "job-a" })).toThrow(/unavailable/);
  });

  it("refreshes the cached job list as well as outcomes immediately after a database swap without quiet", () => {
    const first = makeFixture();
    const second = makeFixture();
    const storeKey = path.join(first.root, "cron", "jobs.json");
    for (const [fixture, id] of [[first, "old-job"], [second, "new-job"]]) {
      fixture.db.exec("CREATE TABLE cron_jobs (store_key TEXT, job_id TEXT, job_json TEXT, state_json TEXT, updated_at INTEGER, sort_order INTEGER)");
      fixture.db.prepare("INSERT INTO cron_jobs VALUES (?, ?, ?, '{}', 1, 0)").run(storeKey, id, JSON.stringify({ id }));
      fixture.insert(id, { storeKey, summary: id }, { jobId: id });
      fixture.db.close();
    }
    expect(Object.keys(first.service.getBulkJobRuns().byJobId)).toEqual(["old-job"]);
    fs.renameSync(path.join(second.root, "state", "openclaw.sqlite"), path.join(first.root, "state", "openclaw.sqlite"));
    expect(first.service.getBulkJobRuns().byJobId).toEqual({ "new-job": { entries: [expect.objectContaining({ summary: "new-job" })], total: 1 } });
  });

  it("preserves the bulk contract of filtering sinceMs after the bounded sorted page", () => {
    const { db, insert, service } = makeFixture();
    for (let index = 1; index <= 5; index++) insert(`task-${index}`, { summary: String(index), status: index === 3 ? "error" : "ok" }, { ts: index });
    db.close();
    expect(service.getBulkJobRuns({ sortDir: "asc", sinceMs: 3, limitPerJob: 2 }).byJobId["job-a"].entries).toEqual([]);
    expect(service.getBulkJobRuns({ sortDir: "desc", sinceMs: 3, limitPerJob: 2 }).byJobId["job-a"].entries.map((entry) => entry.ts)).toEqual([5, 4]);
    expect(service.getBulkJobRuns({ status: "error" }).byJobId["job-a"].entries.map((entry) => entry.ts)).toEqual([3]);
  });

  it("uses the older database's existing indexes and stable sequence ties at scale", () => {
    const { root, db, service } = makeFixture({ version: "2026.7.1-2" });
    db.exec(legacySchema);
    const write = db.prepare("INSERT INTO cron_run_logs (store_key, job_id, seq, ts, entry_json, created_at) VALUES (?, ?, ?, ?, ?, 1)");
    db.exec("BEGIN");
    for (let index = 1; index <= 10000; index++) {
      const jobId = index % 2 ? "job-a" : "other-job";
      write.run(path.join(root, "cron", "jobs.json"), jobId, index, 100, JSON.stringify({ action: "finished", jobId, ts: 100, status: "ok", summary: String(index) }));
    }
    db.exec("COMMIT");
    db.close();
    const plans = [];
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
      const statement = prepare.call(this, sql);
      if (/^SELECT/.test(sql) && /FROM cron_run_logs/.test(sql)) {
        const method = sql.includes("SUM(count)") ? "get" : "all";
        const native = statement[method].bind(statement);
        statement[method] = (...params) => {
          plans.push(...prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail));
          return native(...params);
        };
      }
      return statement;
    });
    expect(service.getJobRuns({ jobId: "job-a", limit: 2 })).toMatchObject({ total: 5000, entries: [{ summary: "9999" }, { summary: "9997" }] });
    expect(service.getJobRuns({ jobId: "job-a", limit: 2, sortDir: "asc" }).entries.map((entry) => entry.summary)).toEqual(["1", "3"]);
    expect(plans.some((line) => /^SCAN cron_run_logs/.test(line))).toBe(false);
    expect(plans.some((line) => /SEARCH cron_run_logs USING INDEX/.test(line))).toBe(true);
  });

  it("uses client-zone day boundaries across DST for SQLite trends through the API", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-09T19:00:00Z"));
    const { db, insert, service } = makeFixture();
    insert("before-midnight", { durationMs: 10, usage: { input_tokens: 3, output_tokens: 4 } }, { ts: Date.parse("2026-03-08T07:59:59Z") });
    insert("dst-day", { durationMs: 20 }, { ts: Date.parse("2026-03-08T08:00:00Z") });
    insert("after-dst", { durationMs: 30, status: "error" }, { ts: Date.parse("2026-03-09T07:00:00Z") });
    db.close();
    const response = await request(appFor(service)).get(`${historyUrls[1]}?range=7d`).set("x-client-timezone", "America/Los_Angeles");
    expect(response.status).toBe(200);
    expect(response.headers.vary).toBe("x-client-timezone");
    const days = response.body.trends.points.slice(-3);
    expect(days.map((day) => day.totalRuns)).toEqual([1, 1, 1]);
    expect(days.map((day) => day.totalDurationMs)).toEqual([10, 20, 30]);
    expect(days[1].endMs - days[1].startMs).toBe(23 * 3600000);
    expect(days[0].totalTokens).toBe(7);
  });

  it("uses indexed bounded pages and batched bulk reads on a large task history", () => {
    const { root, db, insert, service } = makeFixture();
    const jobs = Array.from({ length: 60 }, (_, index) => ({ id: `job-${index}` }));
    fs.writeFileSync(path.join(root, "cron", "jobs.json"), JSON.stringify({ jobs }));
    db.exec("BEGIN");
    for (let index = 0; index < 30000; index++) insert(`task-${index}`, { durationMs: 1 }, { jobId: `job-${index % 60}`, ts: index + 1 });
    db.exec("COMMIT");
    db.close();
    const queries = [];
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
      if (/^SELECT/.test(sql) && /FROM task_runs/.test(sql)) {
        const statement = prepare.call(this, sql);
        const method = sql.includes("SUM(count)") || sql.includes("SUM(duration)") ? "get" : "all";
        const native = statement[method].bind(statement);
        statement[method] = (...params) => {
          const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail);
          const result = native(...params);
          queries.push({ sql, plan, rows: Array.isArray(result) ? result.length : 1 });
          return result;
        };
        return statement;
      }
      return prepare.call(this, sql);
    });
    expect(service.getJobRuns({ jobId: "job-1", limit: 5 }).total).toBe(500);
    expect(service.getJobUsage({ jobId: "job-1", sinceMs: 10000 }).totals.durationSamples).toBe(333);
    const beforeBulk = queries.length;
    expect(Object.keys(service.getBulkJobRuns({ limitPerJob: 3 }).byJobId)).toHaveLength(60);
    expect(queries.slice(beforeBulk)).toHaveLength(2);
    expect(queries.slice(beforeBulk).map((query) => query.rows)).toEqual([150, 30]);
    expect(queries.every((query) => query.plan.some((line) => line.includes("idx_task_runs_runtime_source_ended")))).toBe(true);
    expect(queries.flatMap((query) => query.plan).some((line) => /^SCAN task_runs/.test(line))).toBe(false);
    expect(queries.filter((query) => !query.sql.includes("SUM(")).every((query) => query.sql.includes("LIMIT ? OFFSET ?"))).toBe(true);
    expect(getStateDbHandleCount()).toBe(1);
  });
});
