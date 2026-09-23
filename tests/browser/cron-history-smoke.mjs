import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { createCronHistoryFixture } from "./cron-history-fixture.mjs";

const require = createRequire(import.meta.url);
const { scrubTestRunnerEnv } = require("../live/live-helpers");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-browser-"));
const artifacts = path.resolve(process.env.CRON_BROWSER_ARTIFACTS || ".context/cron-browser");
fs.mkdirSync(artifacts, { recursive: true });
let fixture;
let browser;
try {
  const resultPath = path.join(root, "result.json");
  execFileSync(process.execPath, ["tests/fixtures/cron-pinned-runtime.mjs", resultPath], {
    env: { ...scrubTestRunnerEnv(), OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json") },
    timeout: 20000, stdio: "pipe",
  });
  const { jobId } = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  fixture = await createCronHistoryFixture(root);
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  await page.goto(`${fixture.url}/cron/${jobId}`);
  await page.getByText("1 entries", { exact: true }).waitFor();
  await page.getByText("Model runs", { exact: true }).waitFor();
  assert.equal(await page.getByText("Total runs", { exact: true }).count(), 0);
  await page.locator(".ac-history-item summary").click();
  await page.getByText("Summary: Pinned runtime cron outcome", { exact: true }).waitFor();
  await page.getByRole("button", { name: "duration", exact: true }).click();
  await page.locator("canvas").waitFor();
  await page.screenshot({ path: path.join(artifacts, "pinned-history-trends.png"), fullPage: true });
  await page.getByRole("button", { name: "error", exact: true }).click();
  await page.getByText("No runs found.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "all", exact: true }).click();
  await page.getByText("1 entries", { exact: true }).waitFor();
  await page.getByRole("button", { name: "24h", exact: true }).click();
  await page.waitForResponse((response) => response.url().includes("/trends?range=24h"));
  const database = path.join(root, "state", "openclaw.sqlite");
  const db = new DatabaseSync(database);
  const detail = db.prepare("SELECT detail_json FROM task_runs WHERE source_id = ?").get(jobId).detail_json;
  db.prepare("UPDATE task_runs SET detail_json = '{broken' WHERE source_id = ?").run(jobId);
  db.close();
  await page.reload();
  await page.getByText("Couldn't load run history.", { exact: true }).waitFor();
  await page.getByText("Couldn't load trends.", { exact: true }).waitFor();
  assert.equal(await page.getByText("No runs found.", { exact: true }).count(), 0);
  assert.equal(await page.getByText("No run data in this window yet.", { exact: true }).count(), 0);
  await page.getByText("Couldn't load run history.", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, "unavailable-history.png"), fullPage: true });
  const restored = new DatabaseSync(database);
  restored.prepare("UPDATE task_runs SET detail_json = ? WHERE source_id = ?").run(detail, jobId);
  restored.close();
  await page.getByRole("button", { name: "Retry", exact: true }).first().click();
  await page.getByText("1 entries", { exact: true }).waitFor();
  await page.getByText("Couldn't load run history.", { exact: true }).waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("Avg tokens/model run", { exact: true }).waitFor();
  await page.getByText("Avg cost/model run", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole("button", { name: "duration", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, "history-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(fixture.requests.some((request) => request.method !== "GET"), false);
  console.log("PASS: pinned runtime history, duration chart, status filter, range, unavailable/retry, mobile, no page errors or mutations");
} finally {
  await browser?.close();
  await fixture?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
