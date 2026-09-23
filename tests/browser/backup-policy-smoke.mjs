// Real Preact + Chromium over the repository's deterministic HTTP fixture.
// Run: node tests/browser/backup-policy-smoke.mjs (supported Node, npm install).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createReliabilityFixture } from "./reliability-fixture.mjs";

const artifacts = path.resolve(process.env.BACKUP_BROWSER_ARTIFACTS || ".context/backup-browser");
fs.mkdirSync(artifacts, { recursive: true });
const fixture = await createReliabilityFixture();
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
page.setDefaultTimeout(12_000);
const pageErrors = [], checks = [], failures = [];
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
page.on("response", (response) => { if (response.status() >= 400) failures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
await page.route("**/*", (route) => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
const mark = (name) => { checks.push(name); console.log(`PASS: ${name}`); };
const shot = (name) => page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
let failure;
try {
  await page.goto(`${fixture.url}/upgrade`);
  await page.getByText("Backup exclusions", { exact: true }).click();
  const workspace = page.getByLabel("Workspace exclusions", { exact: false });
  const root = page.getByLabel("State-root exclusions", { exact: false });
  await workspace.waitFor();
  await page.waitForFunction(() => document.querySelector("textarea")?.disabled === false);
  assert.match(await workspace.inputValue(), /node_modules/);
  await root.fill("state");
  await page.getByRole("button", { name: "Save exclusions", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Nothing was changed" }).waitFor();
  assert.equal(await root.inputValue(), "state");
  assert.deepEqual(fixture.state.backupPolicy.rootExcludes, []);
  await shot("invalid-rule-preserved");
  mark("unsafe exclusion stays editable with inline refusal; policy is unchanged");

  await root.fill("state/security-planning/stronghold-*");
  await workspace.fill("");
  await page.getByRole("button", { name: "Save exclusions", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved for the next backup" }).waitFor();
  assert.deepEqual(fixture.state.backupPolicy, { excludes: [], rootExcludes: ["state/security-planning/stronghold-*"] });
  await page.reload();
  await page.getByText("Backup exclusions", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector("textarea")?.disabled === false);
  assert.equal(await workspace.inputValue(), "");
  assert.equal(await root.inputValue(), "state/security-planning/stronghold-*");
  await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
  assert.match(await workspace.inputValue(), /node_modules/);
  assert.equal(await root.inputValue(), "");
  assert.deepEqual(fixture.state.backupPolicy.excludes, []);
  await page.getByRole("button", { name: "Save exclusions", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved for the next backup" }).waitFor();
  mark("empty lists persist after reload; Restore defaults requires Save");

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.getByRole("button", { name: "Save exclusions", exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `policy overflow at ${width}`);
    await shot(`policy-${width}`);
  }
  mark("policy controls remain readable and reachable on desktop and mobile");
  await page.setViewportSize({ width: 1280, height: 960 });
  fixture.state.backupProfile = "migration-minimal";
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Migration-only backup completed", exact: true }).waitFor();
  await page.getByText("migration-only — workspace and other state omitted; not reusable by a later update", { exact: true }).first().waitFor();
  await page.getByText("Last manual backup:", { exact: false }).filter({ hasText: "migration-only" }).waitFor();
  await shot("minimal-quick-result");
  mark("quick manual result, inventory and last-backup line disclose migration-only coverage");
  await page.getByRole("button", { name: "Dismiss", exact: true }).first().click();
  fixture.state.backupStreamed = true;
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Migration-only backup completed", exact: true }).waitFor();
  await page.getByText("Verified migration-only backup; workspace and other state omitted", { exact: true }).waitFor();
  await shot("minimal-streamed-result");
  await page.reload();
  await page.getByText("Last manual backup:", { exact: false }).filter({ hasText: "migration-only" }).waitFor();
  mark("streamed completion and reload retain the migration-only warning");

  fixture.state.applyFailureCode = "backup_failed";
  fixture.state.applyFailureMessage = "Fixture backup failed";
  await page.getByRole("button", { name: "Upgrade", exact: true }).first().click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Fixture backup failed", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry backup", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Migration-only backup completed", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry update to 2026.9.4", exact: true }).waitFor();
  await page.getByText("Retrying the update will run a fresh backup", { exact: false }).waitFor();
  await shot("minimal-retry-update");
  mark("retry-update CTA explains that the later update needs a fresh backup");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failures.filter((entry) => !(entry.path === "/api/openclaw/backup-policy" && entry.status === 400)), []);
} catch (error) {
  failure = error;
  await shot("failure").catch(() => {});
  console.error(error);
} finally {
  fs.writeFileSync(path.join(artifacts, "report.json"), JSON.stringify({ checks, pageErrors, httpFailures: failures, failure: failure?.stack || null }, null, 2));
  fs.writeFileSync(path.join(artifacts, "requests.json"), JSON.stringify(fixture.requests, null, 2));
  await browser.close(); await fixture.close();
}
if (failure) process.exitCode = 1;
