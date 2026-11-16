// Real Chromium on the shipped secret drop page: the real routes
// (routes/secret-drop.js), the real link records with their state file, the
// built bundle (npm run build:ui first) and a fake applier whose saves the
// test holds open or fails. Covers a double press, a reload after the save, a
// failed save with Retry, a connection that drops after the save landed and a
// link that outlives an AlphaClaw restart.
// Run: npm run build:ui && node tests/browser/secret-drop-page-smoke.mjs [screenshot-dir]
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import express from "express";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { registerSecretDropRoutes } = require("../../lib/server/routes/secret-drop.js");
const { createSecretDropRequests, kSecretDropStateFileName } = require("../../lib/server/secret-drop/requests.js");
const { createTeamStateStore } = require("../../lib/server/team/state.js");

const kCanary = "cnry7Q2xVb9LmZp4Wt8sK3dF";
const shotDir = process.argv[2] || "";
const publicDir = path.resolve("lib/public");
assert.ok(fs.existsSync(path.join(publicDir, "dist", "secret-drop.bundle.js")), "run npm run build:ui first");

const store = createTeamStateStore({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "secret-drop-smoke-")), fileName: kSecretDropStateFileName });
const applied = [];
const lines = [];
let hold = null;
let failNext = false;
const applier = {
  apply: async ({ name, rawValue }) => {
    applied.push({ name, value: rawValue });
    if (hold) await hold.promise;
    if (failNext) {
      failNext = false;
      throw new Error("boom");
    }
    return { status: "stored", stores: { env: true, store: true }, reach: { env: "next_gateway_start", storeKind: "secret" }, notices: [] };
  },
};
const holdSaves = () => {
  let release;
  hold = { promise: new Promise((resolve) => { release = resolve; }) };
  return () => { release(); hold = null; };
};

let port = 0;
let server = null;
let requests = null;
// One AlphaClaw process: fresh link records read from the state file.
const startServer = async () => {
  const app = express();
  const logger = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  requests = createSecretDropRequests({ store, logger });
  registerSecretDropRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    resolveRequestIdentity: () => ({ kind: "legacy", role: "admin" }),
    requests,
    applier,
    resolveSetupUrl: () => `http://127.0.0.1:${port}`,
    logger,
  });
  app.use(express.static(publicDir));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  port = server.address().port;
};
const stopServer = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
const newLink = (name) => {
  const created = requests.create({ name, reason: "smoke" });
  assert.ok(created.ok);
  return `http://127.0.0.1:${port}/secret/${created.token}`;
};
const shot = async (page, name) => {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, name), fullPage: true });
};

await startServer();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || execFileSync("which", ["google-chrome"], { encoding: "utf8" }).trim(), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (msg) => { if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) errors.push(msg.text()); });
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

  // 1. Double press: one save, a disabled button with a spinner, then the
  // saved state on the same page.
  await page.goto(newLink("GITHUB_TOKEN"));
  await page.getByLabel("Value of GITHUB_TOKEN").fill(kCanary);
  await shot(page, "1-form.png");
  const release = holdSaves();
  const button = page.locator("button[type=submit]");
  await button.click();
  await page.waitForFunction(() => document.querySelector("button[type=submit]")?.disabled === true);
  assert.equal(await button.locator(".ac-spinner").count(), 1, "the button shows an inline spinner while saving");
  await button.click({ force: true }).catch(() => {});
  await page.keyboard.press("Enter");
  await shot(page, "2-saving.png");
  release();
  await page.getByText(/Saved GITHUB_TOKEN at /).waitFor();
  assert.equal(applied.length, 1, "a double press saves once");
  assert.equal(await page.getByText("already running").count(), 0);
  assert.match(await page.locator("section").innerText(), /The gateway picks it up after its next start/);
  await shot(page, "3-saved.png");

  // 2. Reload after the save: the saved status, not a form or an error.
  await page.reload();
  await page.getByText(/Saved GITHUB_TOKEN at /).waitFor();
  assert.equal(await page.locator("input[type=password]").count(), 0);
  await shot(page, "4-reloaded.png");

  // 3. A failed save: an inline error with Retry, and Retry saves.
  await page.goto(newLink("MYSVC_API_KEY"));
  await page.getByLabel("Value of MYSVC_API_KEY").fill(kCanary);
  failNext = true;
  await page.locator("button[type=submit]").click();
  await page.getByText(/The save failed unexpectedly/).waitFor();
  assert.equal(await page.getByText(/open the link again/i).count(), 0, "never sends the person back to the link");
  await shot(page, "5-failed.png");
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByText(/Saved MYSVC_API_KEY at /).waitFor();

  // 4. The connection drops after the save landed: the page asks the link
  // and shows it saved instead of an error.
  await page.goto(newLink("DROPPED_API_KEY"));
  await page.getByLabel("Value of DROPPED_API_KEY").fill(kCanary);
  await page.route("**/secret/*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    return route.abort("connectionreset");
  });
  await page.locator("button[type=submit]").click();
  await page.getByText(/Saved DROPPED_API_KEY at /).waitFor();
  await page.unroute("**/secret/*");

  // 5. A restart between opening the link and pressing Save.
  await page.goto(newLink("RESTART_API_KEY"));
  await page.getByLabel("Value of RESTART_API_KEY").fill(kCanary);
  await stopServer();
  await startServer();
  await page.locator("button[type=submit]").click();
  await page.getByText(/Saved RESTART_API_KEY at /).waitFor();
  await shot(page, "6-after-restart.png");

  assert.deepEqual(errors, [], "no page errors");
  const fileText = fs.readFileSync(store.path, "utf8");
  assert.ok(!fileText.includes(kCanary.slice(0, 8)), "the state file never holds a value");
  assert.ok(!lines.join("\n").includes(kCanary.slice(0, 8)), "no log line holds a value");
  console.log("secret drop page smoke: ok (" + applied.length + " applies)");
} finally {
  await browser?.close();
  await stopServer();
}
