# Cron history fixtures

`cron-pinned-runtime.mjs` imports the installed, exactly pinned OpenClaw `CronService`, adds a system-event job, and executes it through the real scheduler and task-registry persistence. It compares the resulting upstream history projection with AlphaClaw's service and HTTP APIs in `tests/server/cron-pinned-runtime.test.js`. The system-event enqueue and heartbeat callbacks are local fixture boundaries: this proves real task-row generation and readback, not model inference or external delivery. No network or credential is needed.

The current schema and projection were checked against `openclaw@2026.9.5`'s `src/cron/task-run-detail.ts`, `src/cron/task-run-history.ts`, task schema, and `state:cron-run-logs-to-task-runs:v1` migration in its published distribution. The migration drops `cron_run_logs`. `task_runs.status` and `task_runs.delivery_status` use generic task vocabularies; the cron outcome and delivery fields come from `detail_json`.

Every OpenClaw AlphaClaw supports (2026.9.3 and later) records cron outcomes only in `task_runs`, so AlphaClaw reads nothing else (v0.10.29 retired the `cron_run_logs` reader and the JSONL fallback). The legacy DDL in `tests/server/cron-run-store.test.js` matches the published `openclaw@2026.7.1-2` distribution and is kept as a negative fixture: a stale legacy table never shadows `task_runs`, and a database with only the legacy table is unavailable. `user_version` is not the authority. No fixture schema is applied by production code.

A missing database, SQLite corruption, an unsupported schema or index shape and backup quiet periods are reported as unavailable, never as empty history and never by falling back to JSONL. SQLite pages use bounded `LIMIT` queries; trend aggregation streams a job/time-scoped cursor, and duration aggregation stays in SQL. The large fixture inspects the actual query plan, and the bulk test proves 60 jobs take two bounded data statements rather than 60 full scans.

Run the browser journey after `npm install` and `npx playwright install chromium`:

```sh
node tests/browser/cron-history-smoke.mjs
```

It generates another real pinned run, serves the shipped Cron tab against real AlphaClaw cron routes, checks filters/ranges/duration rendering, corrupts and restores only the disposable history detail to test visible unavailability and Retry, and checks a mobile viewport. Session-usage provider totals are empty fixture data because a system event performs no model call. Screenshots default to `.context/cron-browser`; set `CRON_BROWSER_ARTIFACTS` to keep them elsewhere. The fixture follows the existing reliability browser harness's esbuild/Preact/local-HTTP pattern.
