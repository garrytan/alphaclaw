import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createReliabilityFixture } from "./reliability-fixture.mjs";

export const blockedPreflightFixture = {
  ok: true, blocked: true, reason: "Selected state exceeds the 200,000-entry backup budget. Review the largest paths before retrying.",
  diagnosis: { fileCount: 245000, copySetBytes: 4500000000, directories: {
    complete: true, measurementComplete: true, entries: 407321, selectedEntries: 245000, bytes: 12884901888,
    rootSymlink: true, stateDir: "/fixture/consolidated/agent", absoluteSymlinkCount: 3,
    absoluteSymlinks: [{ path: ".env", target: "/fixture/.env" }, { path: "wiki/index", target: "/fixture/wiki/home.md" }, { path: "wiki/reference", target: "/fixture/wiki/reference.md" }],
    topLevel: [{ path: "worktrees", entries: 152243, bytes: 6227702579 }, { path: "workspace", entries: 210000, bytes: 3758096384 },
      { path: "state", entries: 26015, bytes: 2899102492 }, { path: "wiki", entries: 19056, bytes: 433 }, { path: "logs", entries: 6, bytes: 5120 }, { path: ".env", entries: 1, bytes: 0 }],
    topEntries: [{ path: "workspace/.openclaw", entries: 210000, bytes: 3758096384 }, { path: "worktrees", entries: 152243, bytes: 6227702579 }],
    topBytes: [{ path: "worktrees", entries: 152243, bytes: 6227702579 }, { path: "workspace/.openclaw", entries: 210000, bytes: 3758096384 }],
    selection: { assetCount: 245000, assetBytes: 4500000000, excludedFiles: 162321, excludedBytes: 8384901888 },
  } },
};

const artifacts = path.resolve(process.env.PREFLIGHT_BROWSER_ARTIFACTS || ".context/backup-preflight-browser");
fs.mkdirSync(artifacts, { recursive: true });
const fixture = await createReliabilityFixture();
fixture.state.backupPreflight = blockedPreflightFixture;
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
page.setDefaultTimeout(12_000);
const pageErrors = [], checks = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.route("**/*", (route) => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
const mutations = () => fixture.requests.filter((request) => request.method === "POST" && ["/api/openclaw/apply", "/api/openclaw/backup"].includes(request.path));
const mark = (name) => { checks.push(name); console.log(`PASS: ${name}`); };
let failure;
try {
  await page.goto(`${fixture.url}/upgrade`);
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review backup preflight", exact: true });
  await dialog.getByText("Backup blocked before gateway pause", { exact: true }).waitFor();
  assert.equal(mutations().length, 0);
  assert.equal(await dialog.getByRole("button", { name: "Continue", exact: true }).isDisabled(), true);
  assert.match(await dialog.textContent(), /407,321 entries/);
  assert.match(await dialog.textContent(), /152,243/);
  await dialog.getByText("Top offenders by entries and bytes", { exact: true }).click();
  await dialog.getByText("Absolute-target symlinks (3)", { exact: true }).click();
  await dialog.getByText(".env → /fixture/.env", { exact: true }).waitFor();
  assert.match(await dialog.textContent(), /\.env → \/fixture\/\.env/);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await dialog.getByRole("button", { name: "Continue", exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await dialog.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 960);
    await page.screenshot({ path: path.join(artifacts, `blocked-preflight-${width}.png`), fullPage: true });
  }
  mark("blocked preflight shows complete counts, symlinks and rankings before any mutation on desktop and mobile");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 960 });
  const card = page.getByRole("region", { name: "Backup preflight", exact: true });
  await card.getByText("Top offenders by entries and bytes", { exact: true }).click();
  await card.getByText("Absolute-target symlinks (3)", { exact: true }).click();
  await card.getByText(".env → /fixture/.env", { exact: true }).waitFor();
  await card.screenshot({ path: path.join(artifacts, "backup-preflight-diagnosis.png") });

  await page.getByRole("button", { name: "Upgrade", exact: true }).first().click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await dialog.getByText("Backup blocked before gateway pause", { exact: true }).waitFor();
  assert.equal(mutations().length, 0);
  mark("applying a release also requires the before-pause preflight review");

  fixture.state.backupPreflightError = true;
  await dialog.getByRole("button", { name: "Check again", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "source scan failed" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Continue", exact: true }).isDisabled(), true);
  assert.equal(mutations().length, 0);
  await dialog.screenshot({ path: path.join(artifacts, "backup-preflight-error.png") });
  fixture.state.backupPreflightError = false;
  fixture.state.backupPreflight = { ...blockedPreflightFixture, blocked: false, reason: null };
  await dialog.getByRole("button", { name: "Retry preflight", exact: true }).click();
  await dialog.getByText("Backup preflight passed", { exact: true }).waitFor();
  assert.equal(mutations().length, 0);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Fixture build failed", { exact: true }).waitFor();
  assert.equal(mutations().length, 1);
  mark("failed reads are retryable and success still waits for explicit Continue before the apply POST");
  assert.deepEqual(pageErrors, []);
} catch (error) {
  failure = error;
  await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(error);
} finally {
  fs.writeFileSync(path.join(artifacts, "report.json"), JSON.stringify({ checks, pageErrors, requests: fixture.requests, failure: failure?.stack || null }, null, 2));
  await browser.close(); await fixture.close();
}
if (failure) process.exitCode = 1;
