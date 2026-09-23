# Cron history fixtures

`cron-pinned-runtime.mjs` imports the installed, exactly pinned OpenClaw `CronService`, adds a system-event job, and executes it through the real scheduler and task-registry persistence. It compares the resulting upstream history projection with AlphaClaw's service and HTTP APIs in `tests/server/cron-pinned-runtime.test.js`. The system-event enqueue and heartbeat callbacks are local fixture boundaries: this proves real task-row generation and readback, not model inference or external delivery. No network or credential is needed.

The current schema and projection were checked against `openclaw@2026.9.5`'s `src/cron/task-run-detail.ts`, `src/cron/task-run-history.ts`, task schema, and `state:cron-run-logs-to-task-runs:v1` migration in its published distribution. The migration drops `cron_run_logs`. `task_runs.status` and `task_runs.delivery_status` use generic task vocabularies; the cron outcome and delivery fields come from `detail_json`.

The legacy DDL and indexes in `tests/server/cron-run-store.test.js` match the published `openclaw@2026.7.1-2` distribution. Its `cron_run_logs` remains authoritative even when the generic task table also exists. Published `2026.7.2-beta.1` has the task-detail codec, indexed task ledger and destructive cron-log migration; that is the task-authority boundary. Current runtimes never select a stale legacy table when both tables exist, and an unknown/dev runtime with both tables is unavailable rather than guessed. `user_version` alone is not the authority. Published `2026.5.28` still appends JSONL; `2026.5.30-beta.1` uses the SQLite writer. Those packages were inspected to set the missing-database era boundary. No fixture schema is applied by production code.

The tests retain the JSONL reader's bounded 256 KiB tail and tolerance of malformed individual lines. Missing files produce empty history; failed I/O does not. SQLite corruption, unsupported schema/index shape, missing modern storage, and backup quiet periods never trigger JSONL fallback. SQLite pages use bounded `LIMIT` queries; trend aggregation streams a job/time-scoped cursor, and duration aggregation stays in SQL. Large fixtures inspect the actual query plans for both table generations, and the bulk test proves 60 jobs take two bounded data statements rather than 60 full scans.

Run the browser journey after `npm install` and `npx playwright install chromium`:

```sh
node tests/browser/cron-history-smoke.mjs
```

It generates another real pinned run, serves the shipped Cron tab against real AlphaClaw cron routes, checks filters/ranges/duration rendering, corrupts and restores only the disposable history detail to test visible unavailability and Retry, and checks a mobile viewport. Session-usage provider totals are empty fixture data because a system event performs no model call. Screenshots default to `.context/cron-browser`; set `CRON_BROWSER_ARTIFACTS` to keep them elsewhere. The fixture follows the existing reliability browser harness's esbuild/Preact/local-HTTP pattern.
