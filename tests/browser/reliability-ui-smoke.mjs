// Run with supported Node after npm install/build:ui:
// npm run test:ui:reliability
// Real Preact + fetch + EventSource + Chromium, deterministic local providers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createReliabilityFixture, makeManagedAttempt } from "./reliability-fixture.mjs";

const artifacts = path.resolve(process.env.WAVE_BROWSER_ARTIFACTS || `.context/wave-browser/reliability-${Date.now()}`);
fs.mkdirSync(artifacts, { recursive: true });
const fixture = await createReliabilityFixture();
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
const page = await context.newPage();
page.setDefaultTimeout(12_000);
const consoleEvents = [];
const pageErrors = [];
const failures = [];
const checks = [];
page.on("console", (event) => consoleEvents.push({ type: event.type(), text: event.text() }));
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
page.on("response", (response) => {
  if (response.status() >= 400) failures.push({ url: response.url(), status: response.status() });
});
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return url.origin === fixture.url ? route.continue() : route.abort("blockedbyclient");
});
const shot = async (name) => {
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
  assert.deepEqual(pageErrors, [], `uncaught browser error after ${name}`);
};
const hasText = async (text) => page.getByText(text, { exact: false }).first().waitFor();
const countPost = (endpoint) => fixture.requests.filter((r) => r.method === "POST" && r.path === endpoint).length;
const mark = (name) => { checks.push(name); console.log(`PASS: ${name}`); };
let failure = null;
try {
  // Start a real streamed apply from the shipped dialog, then choose the
  // shipped repair action. The repair stream closes without a terminal event.
  await page.goto(`${fixture.url}/upgrade`);
  await page.getByRole("button", { name: "Upgrade", exact: true }).first().click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 720 });
    const box = await page.locator(".bg-modal").last().boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 720, `long consent dialog must stay within ${width}x720 viewport`);
    await page.getByRole("button", { name: "Apply", exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).isVisible(), true);
  }
  await shot("upgrade-long-consent-mobile");
  mark("long consent dialog remains scrollable with reachable controls on desktop and mobile");
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await hasText("Fixture build failed");
  await page.getByRole("button", { name: "Run repair", exact: true }).click();
  await hasText("Repairing the dev build");
  await page.waitForResponse((response) => response.url().endsWith("/api/openclaw/runs/repair-current"));
  const repair = fixture.state.runs.find((run) => run.operationId === "repair-current");
  assert.ok(repair);
  assert.equal(countPost("/api/openclaw/repair"), 1);
  await shot("repair-lost-sse");
  mark("lost repair SSE follows the exact repair ledger ID");

  // Newer history and the former apply's success cannot complete this repair.
  fixture.state.lastUpdateRun = { ...fixture.state.lastUpdateRun, ok: true, state: "activated" };
  fixture.state.runs.unshift({ operationId: "newer-unrelated-failure", target: { channel: "stable", version: "2026.9.4" }, state: "failed", ok: false, finishedAt: Date.now(), startedAt: Date.now(), result: { message: "Unrelated historical failure" } });
  await page.reload();
  await hasText("Repairing the dev build");
  assert.equal(await page.getByRole("heading", { name: "Repair completed", exact: true }).count(), 0);
  const statusCallsBefore = fixture.requests.filter((r) => r.path === "/api/status").length;
  Object.assign(repair, { state: "completed", ok: true, finishedAt: Date.now(), result: { ok: true }, steps: [{ name: "repair", status: "completed", at: Date.now() }] });
  await page.getByRole("heading", { name: "Repair completed", exact: true }).waitFor();
  assert.equal(fixture.requests.filter((r) => r.path === "/api/status").length, statusCallsBefore, "repair must finish without probing an AlphaClaw restart");
  await shot("repair-completed-after-reload");
  mark("reload recovers repair and completes in place despite unrelated apply outcomes");

  fixture.state.catalogError = true;
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await hasText("Could not refresh the catalog");
  await page.getByText("2026.9.4", { exact: true }).first().waitFor();
  await shot("catalog-stale-error");
  fixture.state.catalogError = false;
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await page.getByText("Could not refresh the catalog", { exact: false }).waitFor({ state: "hidden" });
  mark("failed catalog GET retains rows and Check now recovers");

  await page.goto(`${fixture.url}/managed`);
  await page.getByRole("button", { name: "Update now", exact: true }).click();
  await hasText("Deployment request pending");
  assert.equal(await page.locator(".global-restart-banner").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Update now", exact: true }).isDisabled(), true);
  fixture.state.currentVersion = "1.1.0";
  await page.reload();
  await hasText("Deployment request pending");
  assert.equal(await page.getByRole("button", { name: "Update now", exact: true }).isDisabled(), true);
  await shot("managed-pending-after-version-change");
  mark("managed acknowledgement remains pending across reload and version change without restart banner");

  const verifyResolution = async (button, outcome, screenshot) => {
    const updates = countPost("/api/alphaclaw/update");
    await page.getByRole("button", { name: button, exact: true }).click();
    await hasText("Confirm provider status");
    const confirm = page.getByRole("button", { name: "Resolve this request", exact: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 720 });
      const box = await page.getByRole("dialog", { name: "Confirm provider status", exact: true }).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 720, `provider confirmation must stay within ${width}x720 viewport`);
      await confirm.scrollIntoViewIfNeeded();
      assert.equal(await confirm.isVisible(), true);
    }
    assert.equal(await confirm.isDisabled(), true);
    await page.getByRole("checkbox", { name: "I checked the provider: no deployment is pending.", exact: true }).check();
    await shot(screenshot);
    await confirm.click();
    await page.getByText("Confirm provider status", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(fixture.state.managedUpdateAttempt.state, "resolved");
    assert.equal(fixture.state.managedUpdateAttempt.resolution.outcome, outcome);
    assert.equal(countPost("/api/alphaclaw/update"), updates, "resolving may not dispatch another deployment");
    await page.setViewportSize({ width: 1280, height: 960 });
  };
  await verifyResolution("Provider finished the deployment", "deployed", "managed-provider-confirmation");
  mark("admin confirms completed deployment without a follow-up update POST");

  fixture.state.managedUpdateAttempt = makeManagedAttempt("unknown", "managed-unknown");
  await page.reload();
  await hasText("Deployment status unknown");
  await verifyResolution("Provider cancelled or did not deploy", "not_deployed", "managed-unknown-confirmation");
  mark("unknown deployment restores and resolves only with explicit provider confirmation");

  fixture.state.managedUpdateAttempt = makeManagedAttempt("unknown", "managed-member");
  fixture.state.role = "member";
  await page.reload();
  await hasText("An administrator must check the provider");
  assert.equal(await page.getByRole("button", { name: "Provider finished the deployment", exact: true }).count(), 0);
  await shot("managed-member-readonly");
  mark("member sees pending state without provider resolution controls");

  fixture.state.role = "admin";
  await page.goto(`${fixture.url}/google`);
  const expandAccount = async () => {
    await page.getByRole("button", { name: /operator@example.test/ }).click();
    await hasText("Incoming events");
  };
  await expandAccount();
  await page.getByText("Watching", { exact: true }).waitFor();
  fixture.state.gmailError = true;
  const gmailBox = page.locator('[role="button"]').filter({ has: page.getByText("🔔 Gmail", { exact: true }) });
  await gmailBox.locator("label.ac-toggle").click();
  await hasText("Couldn't refresh Gmail watch status. Showing the last known status.");
  assert.equal(fixture.state.gmail.enabled, false);
  await shot("gmail-stale-status");
  fixture.state.gmailError = false;
  await page.locator('[role="status"]').filter({ hasText: "Couldn't refresh Gmail watch status." }).getByRole("button", { name: "Retry", exact: true }).click();
  await hasText("Disabled · retry needed");
  await page.reload();
  await expandAccount();
  await hasText("Gmail is disabled locally; the remote stop needs a retry.");
  assert.equal(await gmailBox.locator("input[type=checkbox]").isChecked(), false);
  await shot("gmail-local-disabled-remote-failed-reload");
  mark("Gmail retains stale status honestly then restores local-disabled remote-failed state after reload");

  fixture.state.remoteStopFails = false;
  await page.locator('[role="status"]').filter({ hasText: "Gmail is disabled locally; the remote stop needs a retry." }).getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Stopped", { exact: true }).waitFor();
  assert.equal(countPost("/api/gmail/watch/stop"), 2);
  assert.equal(fixture.requests.some((request) => /send|notify/.test(request.path)), false);
  mark("explicit Gmail retry reconciles remote stop without sending email");

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 960 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Gmail overflow at ${width}`);
  }
  await shot("gmail-mobile-recovered");
  assert.deepEqual(pageErrors, []);
  const expectedFailures = new Set(["/api/openclaw/catalog", "/api/gmail/config", "/api/gmail/watch/stop"]);
  assert.deepEqual(failures.filter((entry) => entry.status !== 503 || !expectedFailures.has(new URL(entry.url).pathname)), [], "unexpected failed browser requests");
  assert.deepEqual(consoleEvents.filter((entry) => entry.type === "error" && !entry.text.includes("503 (Service Unavailable)")), [], "unexpected browser console errors");
} catch (error) {
  failure = error;
  await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(error);
} finally {
  fs.writeFileSync(path.join(artifacts, "report.json"), JSON.stringify({ checks, pageErrors, consoleEvents, httpFailures: failures, failure: failure?.stack || null }, null, 2));
  fs.writeFileSync(path.join(artifacts, "requests.json"), JSON.stringify(fixture.requests, null, 2));
  await context.close(); await browser.close(); await fixture.close();
}
if (failure) process.exitCode = 1;
else console.log(`PASS: ${checks.length} real Chromium reliability journeys; artifacts ${artifacts}`);
