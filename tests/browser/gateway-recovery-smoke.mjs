import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { reduceGatewayState, kGatewayStateCatalog, getGatewayRecoveryAction } = require("../../lib/server/gateway-state");
const artifacts = path.resolve(process.env.GATEWAY_BROWSER_ARTIFACTS || ".gstack/qa/gateway-recovery");
fs.mkdirSync(artifacts, { recursive: true });
for (const file of ["failure.png", "failure.txt", "checks.json", "requests.json", "contrast.json"]) fs.rmSync(path.join(artifacts, file), { force: true });
const entry = `
import { h, render } from "preact";
import { Gateway } from "./lib/public/js/components/gateway.js";
import { gatewayShellStore } from "./lib/public/js/components/restart-progress-card.js";
import { restartGatewayAsync } from "./lib/public/js/lib/api.js";
import { useAppShellController } from "./lib/public/js/hooks/use-app-shell-controller.js";
function ControllerPage() {
  useAppShellController({ location: "/general" });
  return h(Gateway);
}
const refresh = async () => {
  const shell = await (await fetch('/fixture/status')).json();
  gatewayShellStore.publish({ ...shell, actions: { refresh, restart: async (options) => { const data = await restartGatewayAsync(options); await refresh(); return data; }, openSetup: () => { location.hash = '/setup'; } } });
};
window.refreshFixture = refresh;
window.fixtureShell = () => gatewayShellStore.get();
render(h(location.pathname === '/controller' ? ControllerPage : Gateway), document.getElementById('app'));
if (location.pathname !== '/controller') refresh();
`;
const bundle = await build({ bundle: true, write: false, format: "esm", stdin: { contents: entry, resolveDir: process.cwd() } });
const css = ["theme.css", "tailwind.generated.css", "shell.css"].map((file) => fs.readFileSync(`lib/public/css/${file}`, "utf8")).join("\n");
const base = () => ({ configExists: true, tcp: { running: false, observedAt: Date.now() }, watchdog: { lifecycle: "configuration_error", health: "unhealthy" }, gatewayHeld: { reason: "state_db_unverified", at: Date.parse("2026-09-26T10:00:00Z") }, recoveryConfirmation: "fixture-observation-token" });
let state = { hasStatus: true, connectivityMode: "online", statusState: reduceGatewayState(base()), restartOperation: null };
let responseMode = "accepted";
const requests = [];
const checks = [];
let evidenceMode = "blocked";
let controllerMode = false;
let activeOperation = null;
let lastOperation = null;
let restartStatusUnavailable = false;
let launchCount = 0;
let statusRevision = 0;
const operationStreams = new Set();
const statusStreams = new Set();
let fullApp = false;
let onboarding = null;
const onboardingResponses = [];
const findings = [{ path: `agents/main/${"long-directory/".repeat(8)}state.sqlite`, code: "unknown_owner", problem: "Ownership is not verified", cause: "Unexpected owner metadata" }];
const controllerStatus = () => ({ gateway: "running", snapshotEpoch: "controller-fixture", snapshotRevision: ++statusRevision, timestamp: Date.now(),
  state: reduceGatewayState({ configExists: true, tcp: { running: true, observedAt: Date.now() }, watchdog: { lifecycle: "running", health: "healthy" }, operation: activeOperation ? { kind: "restart", label: "Restarting gateway", operationId: activeOperation.operationId } : null }) });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/dist/") && !url.pathname.includes("..")) {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(fs.readFileSync(path.join("lib/public", url.pathname)));
  }
  if (url.pathname === "/full-app") { res.setHeader("Content-Type", "text/html"); return res.end('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="app"></main><script type="module" src="/dist/app.bundle.js"></script></body></html>'); }
  if (["/", "/controller"].includes(url.pathname)) { res.setHeader("Content-Type", "text/html"); return res.end('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="app" style="max-width:900px;margin:16px auto;padding:12px"></main><script type="module" src="/bundle.js"></script></body></html>'); }
  if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(bundle.outputFiles[0].text); }
  if (url.pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); return res.end(css); }
  let text = ""; for await (const chunk of req) text += chunk;
  requests.push({ method: req.method, path: url.pathname, body: text ? JSON.parse(text) : null });
  res.setHeader("Content-Type", "application/json");
  if (controllerMode && url.pathname === "/api/events/status") {
    if (restartStatusUnavailable) { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: "Fixture status stream unavailable" })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: status\ndata: ${JSON.stringify({ status: controllerStatus(), watchdogStatus: { health: "healthy" } })}\n\n`);
    statusStreams.add(res); res.on("close", () => statusStreams.delete(res)); return;
  }
  if (controllerMode && /^\/api\/operations\/[^/]+\/events$/.test(url.pathname)) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('event: step\ndata: {"name":"starting","label":"Starting shared fixture operation","status":"running"}\n\n');
    operationStreams.add(res); res.on("close", () => operationStreams.delete(res)); return;
  }
  if (controllerMode && req.method === "GET") {
    if (url.pathname === "/api/status" && restartStatusUnavailable) { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: "Fixture status unavailable" })); }
    if (url.pathname === "/api/restart-status") {
      if (restartStatusUnavailable) { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: "Fixture restart status temporarily unavailable" })); }
      return res.end(JSON.stringify({ restartRequired: false, restartInProgress: !!activeOperation, reasons: [], activeOperation, lastOperation }));
    }
    const data = url.pathname === "/api/onboard/status" ? { onboarded: true }
      : url.pathname === "/api/status" ? controllerStatus()
        : url.pathname === "/api/auth/status" ? { authEnabled: false }
          : url.pathname === "/api/auth/identity" ? { ok: true, identity: { role: "admin" } }
            : url.pathname === "/api/watchdog/status" || url.pathname === "/api/doctor/status" ? { status: { health: "healthy" } }
              : { ok: true, currentVersion: "fixture" };
    return res.end(JSON.stringify(data));
  }
  if (controllerMode && req.method === "POST" && url.pathname === "/api/gateway/restart") {
    const attached = !!activeOperation;
    if (!attached) { launchCount += 1; activeOperation = { operationId: "shared-operation", status: "running", startedAt: Date.now() }; }
    res.statusCode = 202;
    return res.end(JSON.stringify({ ok: true, operationId: activeOperation.operationId, attached }));
  }
  if (fullApp && req.method === "GET") {
    if (url.pathname === "/api/onboard/status" && onboarding === null) { onboardingResponses.push(res); return; }
    const data = url.pathname === "/api/onboard/status" ? { onboarded: onboarding }
      : url.pathname === "/api/auth/status" ? { authEnabled: false }
        : url.pathname === "/api/auth/identity" ? { ok: true, identity: { role: "admin" } }
          : url.pathname === "/api/status" ? { gateway: "stopped", state: reduceGatewayState({ ...base(), configExists: false, gatewayHeld: false }) }
            : url.pathname === "/api/models" ? { models: [], providers: [] }
              : { ok: true };
    return res.end(JSON.stringify(data));
  }
  if (url.pathname === "/fixture/status") return res.end(JSON.stringify(state));
  if (url.pathname === "/api/diagnose") {
    const rows = evidenceMode === "none" ? [] : evidenceMode === "many" ? Array.from({ length: 24 }, (_, i) => ({ ...findings[0], path: `agents/agent-${i}/same-basename.sqlite`, nextAction: getGatewayRecoveryAction("unknown_owner") }))
      : evidenceMode === "partial" ? [{ path: "agents/unreadable", code: "recovery_inventory_unavailable", problem: "Discovery incomplete", cause: "Access could not be established", nextAction: getGatewayRecoveryAction("recovery_inventory_unavailable") }] : findings;
    return res.end(JSON.stringify({ ok: true, bundle: { summary: { recovery: { observedAt: new Date().toISOString(), assessment: evidenceMode === "partial" ? "partial" : "complete", databaseVerdict: ["none", "partial"].includes(evidenceMode) ? "not_assessed" : "blocked", gatewayReadiness: "not_ready" } }, sections: { stateDb: { data: { findings: rows, excludedArtifacts: evidenceMode === "blocked" ? [{ path: "agents/main/generation-lock.sqlite", reason: "verified_transient_contract" }] : [] } } } } }));
  }
  if (req.method === "POST") {
    if (responseMode === "lost") { res.writeHead(202); res.flushHeaders(); res.write('{"ok":'); return res.destroy(); }
    if (responseMode === "refused") { res.statusCode = 409; return res.end(JSON.stringify({ ok: false, code: "gateway_held", error: "Database hold changed; inspect current evidence" })); }
    if (responseMode === "skipped") return res.end(JSON.stringify({ ok: false, skipped: true, reason: "Another operation is in progress" }));
    if (responseMode === "repair_after_doctor") { res.statusCode = 409; return res.end(JSON.stringify({ ok: false, code: "gateway_held", message: "Doctor completed but relaunch was refused", result: { skipped: true } })); }
    return res.end(JSON.stringify({ ok: true, operationId: "restart-fixture-1" }));
  }
  res.statusCode = 404; res.end(JSON.stringify({ ok: false }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
const contrasts = [];
let checkRetainedFocus = null;
const runbook = fs.readFileSync("docs/upgrade-troubleshooting.md", "utf8");
const headings = [...runbook.matchAll(/^#{1,6} (.+)$/gm)];
const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const helpHtml = headings.map((heading, index) => {
  const anchor = heading[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  return `<section id="${anchor}"><h1>${escapeHtml(heading[1])}</h1><pre>${escapeHtml(runbook.slice(heading.index + heading[0].length, headings[index + 1]?.index))}</pre></section>`;
}).join("\n");
let helpUnavailable = false;
await page.context().route("https://github.com/garrytan/alphaclaw/blob/main/docs/upgrade-troubleshooting.md**", (route) => helpUnavailable
  ? route.abort("internetdisconnected") : route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>${helpHtml}</body></html>` }));
page.on("pageerror", (error) => errors.push(error.message));
const posts = () => requests.filter((request) => request.method === "POST");
const refresh = () => page.evaluate(() => window.refreshFixture());
const button = (name) => page.getByRole("button", { name, exact: true });
const open = async (name) => { await button(name).click(); await page.getByRole("heading", { name: `${name} options` }).waitFor(); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText(/Gateway held for database verification/).waitFor();
  await open("Repair");
  assert.equal((await page.locator("body").innerText()).includes(String(base().gatewayHeld.at)), false);
  assert.equal(posts().length, 0);
  await button("Check again").click();
  await page.getByRole("heading", { name: "Current assessment" }).waitFor();
  assert.equal(posts().length, 0);
  await page.getByText("Database findings (1)", { exact: true }).click();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d");
      const color = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const over = (fg, bg) => fg.slice(0, 3).map((value, index) => value * fg[3] / 255 + bg[index] * (1 - fg[3] / 255)).concat(255);
      const luminance = (rgb) => rgb.slice(0, 3).map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      const section = document.querySelector(".ac-recovery-options");
      const background = color(getComputedStyle(document.documentElement).getPropertyValue("--bg-content").trim());
      return { body: ratio(color(getComputedStyle(section).color), background), buttons: [...document.querySelectorAll(".ac-gateway-recovery-actions button")].map((button) => { const style = getComputedStyle(button); return ratio(color(style.color), over(color(style.backgroundColor), background)); }), focus: ratio(color(getComputedStyle(section).color), background) };
    });
    assert(contrast.body >= 4.5 && contrast.buttons.every((ratio) => ratio >= 4.5) && contrast.focus >= 3, JSON.stringify({ theme, contrast }));
    contrasts.push({ theme, ...contrast });
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ["Repair", "Restart"]) {
        const bounds = await button(name).boundingBox();
        assert(bounds.height >= 44 && bounds.width >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width} overflow`);
      await page.screenshot({ path: path.join(artifacts, `held-${theme}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 768, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/200% zoom overflow`);
    await page.screenshot({ path: path.join(artifacts, `held-${theme}-zoom200.png`), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  }
  checks.push("8 theme/viewport cells and 2 CSS-zoom cells; reduced motion, target sizes and contrast");
  for (const mode of ["many", "none", "partial"]) {
    evidenceMode = mode;
    await button("Check again").click();
    await button("Check again").waitFor();
    if (mode === "many") {
      const summary = page.getByText("Database findings (24)", { exact: true });
      await summary.waitFor();
      if (!await summary.evaluate((node) => node.parentElement.open)) await summary.click();
      await page.getByText("agents/agent-0/same-basename.sqlite", { exact: true }).waitFor();
      await page.getByText("agents/agent-23/same-basename.sqlite", { exact: true }).waitFor();
    } else {
      await page.getByText(mode === "partial" ? /partial; databases not_assessed/ : /complete; databases not_assessed/).waitFor();
      if (mode === "none") assert.equal(await page.locator("summary").filter({ hasText: "Database findings" }).count(), 0);
    }
    await page.setViewportSize({ width: 390, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode} evidence overflow`);
    await page.screenshot({ path: path.join(artifacts, `evidence-${mode}-390.png`), fullPage: true });
  }
  evidenceMode = "blocked";
  await button("Check again").click();
  await button("Check again").waitFor();
  await page.getByText("Database findings (1)", { exact: true }).waitFor();
  checkRetainedFocus = await button("Check again").evaluate((node) => document.activeElement === node);
  assert.equal(checkRetainedFocus, true, "Check again retains keyboard focus throughout observation");
  checks.push("24 same-basename findings, no findings, and partial evidence render without overflow or mutations");
  await page.keyboard.press("Escape");
  assert.equal(await button("Repair").evaluate((node) => document.activeElement === node), true);
  await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.textContent === "Restart options");
  assert.equal(await page.getByRole("heading", { name: "Restart options" }).evaluate((node) => document.activeElement === node), true);
  await page.keyboard.press("Escape"); await page.keyboard.press("Shift+Tab");
  assert.equal(await button("Repair").evaluate((node) => document.activeElement === node), true);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.activeElement?.textContent === "Repair options");
  checks.push("Check again retains focus; Tab, Shift-Tab, Enter, Space and Escape activate and return focus");
  await button("Open Upgrade / protection").click();
  assert.equal(new URL(page.url()).hash, "#/upgrade");
  await button("Close options").click();
  const helpReasons = ["state_db_unverified", "database_recovery_pending", "no_installation_evidence", "EACCES", "gateway_hold_unreadable", "unknown_owner", "SQLITE_CORRUPT", "unsupported_transient_artifact_contract", "database_schema_newer_than_target", "recovery_choice_required", "configuration_error", "operation_in_progress", "auto_repair_paused"];
  for (const reason of helpReasons) {
    const nextAction = getGatewayRecoveryAction(reason);
    state.statusState = reduceGatewayState(base());
    for (const action of state.statusState.actions.filter((action) => ["repair", "restart"].includes(action.id))) {
      action.nextAction = nextAction; action.reason = nextAction.description;
    }
    await refresh(); await open("Repair");
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Recovery instructions", exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    const anchor = nextAction.helpRef.split("#")[1];
    assert.equal(new URL(popup.url()).hash, `#${anchor}`);
    await popup.locator(`section[id="${anchor}"]`).waitFor();
    assert((await popup.locator(`section[id="${anchor}"]`).innerText()).length > 100);
    await popup.close();
    await button("Open Upgrade / protection").click();
    assert.equal(new URL(page.url()).hash, "#/upgrade");
    await button("Open human recovery tools").click();
    assert.equal(new URL(page.url()).hash, "#/watchdog");
    await button("Close options").click();
  }
  helpUnavailable = true;
  await open("Repair");
  const unavailablePopup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Recovery instructions", exact: true }).click();
  const unavailable = await unavailablePopup;
  await unavailable.waitForLoadState("domcontentloaded").catch(() => {});
  assert((await page.locator(".ac-recovery-options").innerText()).includes(getGatewayRecoveryAction("auto_repair_paused").description));
  await unavailable.close(); await button("Close options").click(); helpUnavailable = false;
  checks.push(`${helpReasons.length} hold/help mappings open matching repository runbook anchors; Upgrade/human-tool hashes and offline inline guidance remain available`);
  for (const mode of ["stale", "operation", "legacy"]) {
    state.statusState = mode === "legacy" ? null : reduceGatewayState(base());
    state.statusFreshness = mode === "stale" ? { mode: "stale", observedAtMs: Date.now() - 60_000 } : null;
    state.restartOperation = mode === "operation" ? { operationId: "existing-1", phase: "running", startedAt: Date.now(), steps: [{ name: "verify", label: "Verifying databases", status: "running" }] } : null;
    const before = posts().length;
    await refresh();
    for (const control of ["Repair", "Restart"]) {
      await open(control);
      assert.equal(await button("Verify and start").count(), 0);
      await button("Close options").click();
    }
    assert.equal(posts().length, before);
  }
  state.statusFreshness = null; state.restartOperation = null;
  for (const name of Object.keys(kGatewayStateCatalog)) {
    state.statusState = { ...reduceGatewayState({ ...base(), gatewayHeld: false }), state: name, ...kGatewayStateCatalog[name] };
    const { actionsForState } = require("../../lib/server/gateway-state");
    state.statusState.actions = actionsForState(name, {});
    await refresh();
    for (const control of ["Repair", "Restart"]) { await open(control); await button("Close options").click(); }
  }
  state.statusState = reduceGatewayState({ ...base(), gatewayHeld: false, watchdog: { lifecycle: "stopped" } });
  await refresh(); await open("Restart");
  await button("Start gateway").click();
  state.statusState = reduceGatewayState(base()); await refresh();
  await page.getByRole("alert").filter({ hasText: "Status changed" }).waitFor();
  assert.equal(posts().length, 0);
  for (const mode of ["refused", "skipped", "lost", "accepted"]) {
    responseMode = mode;
    await page.reload(); await button("Restart").waitFor();
    state.statusState = reduceGatewayState({ ...base(), gatewayHeld: false, watchdog: { lifecycle: "stopped" } });
    await refresh(); await open("Restart"); await button("Start gateway").click();
    const before = posts().length;
    await button("Confirm start gateway").dblclick();
    await page.getByText(mode === "lost" ? /Result unknown: the response was lost/ : mode === "accepted" ? /Request accepted/ : /Not started:/).waitFor();
    assert.equal(posts().length, before + 1, mode);
    await refresh(); assert.equal(posts().length, before + 1);
  }
  for (const mode of ["accepted", "repair_after_doctor"]) {
    responseMode = mode;
    await open("Repair"); await button("Run Doctor repair").click();
    const before = posts().length;
    await button("Confirm run doctor repair").click();
    await page.getByText(mode === "accepted" ? /Request accepted/ : /Configuration changes may already have been applied/).waitFor();
    assert.equal(posts().length, before + 1);
    assert.equal(posts().at(-1).path, "/api/watchdog/repair");
    await button("Close options").click();
  }
  responseMode = "accepted";
  checks.push("Restart 409/skipped/lost/accepted and Repair accepted/post-Doctor refusal execute once per deliberate confirmation");
  state.statusState = null; state.hasStatus = false; await refresh();
  await open("Repair"); await page.getByText(/Status is not current/).waitFor();
  state.hasStatus = true; state.statusState = reduceGatewayState(base()); await refresh();
  await page.getByRole("heading", { name: "Repair options" }).waitFor();
  state.statusState = reduceGatewayState({ ...base(), gatewayHeld: null, databaseRecoveryPending: { recoveryId: "prior-recovery", baseline: { identity: "original-databases" } } });
  await refresh(); await open("Restart");
  await page.getByText(/original databases still require fresh verification/).waitFor();
  await button("Verify and start").click();
  const beforeTokenChange = posts().length;
  for (const action of state.statusState.actions) {
    if (["repair", "restart"].includes(action.id)) action.recoveryConfirmation = "new-observation-token";
  }
  await refresh();
  await page.getByRole("alert").filter({ hasText: "Status changed" }).waitFor();
  assert.equal(posts().length, beforeTokenChange);
  await button("Verify and start").click();
  await button("Confirm verify and start").click();
  await page.getByText(/Request accepted/).waitFor();
  assert.equal(posts().at(-1).body.verifyDatabaseRecovery, true);
  assert.equal(posts().at(-1).body.recoveryConfirmation, "new-observation-token");
  controllerMode = true;
  const beforeTwoTabs = posts().length;
  const secondTab = await page.context().newPage();
  secondTab.on("pageerror", (error) => errors.push(error.message));
  try {
    await Promise.all([page, secondTab].map((tab) => tab.goto(`http://127.0.0.1:${server.address().port}/controller`)));
    for (const tab of [page, secondTab]) {
      await tab.waitForFunction(() => window.fixtureShell?.().statusState?.state === "running");
      await tab.getByRole("button", { name: "Restart", exact: true }).click();
      await tab.getByRole("button", { name: "Restart gateway", exact: true }).click();
    }
    await Promise.all([page, secondTab].map((tab) => tab.getByRole("button", { name: "Confirm restart gateway", exact: true }).click()));
    for (const tab of [page, secondTab]) {
      await tab.getByText("Starting shared fixture operation", { exact: true }).waitFor();
      assert.equal(await tab.evaluate(() => window.fixtureShell().restartOperation.operationId), "shared-operation");
    }
    const attachmentCopy = await Promise.all([page, secondTab].map((tab) => tab.locator("body").innerText()));
    assert(attachmentCopy.some((text) => text.includes("Viewing the existing operation. No second restart was started.")));
    assert.equal(launchCount, 1);
    assert.equal(posts().length, beforeTwoTabs + 2);
    await secondTab.reload();
    await secondTab.getByText("Starting shared fixture operation", { exact: true }).waitFor();
    assert.equal(await secondTab.evaluate(() => window.fixtureShell().restartOperation.operationId), "shared-operation");
    for (const name of ["Repair", "Restart"]) {
      await secondTab.getByRole("button", { name, exact: true }).click();
      assert.equal(await secondTab.getByRole("button", { name: "Restart gateway", exact: true }).count(), 0);
      await secondTab.getByRole("button", { name: "Close options", exact: true }).click();
    }
    assert.equal(posts().length, beforeTwoTabs + 2);
    restartStatusUnavailable = true;
    const unavailableReads = Promise.all([page, secondTab].map((tab) => tab.waitForResponse((response) => response.url().endsWith("/api/restart-status") && response.status() === 503)));
    for (const stream of [...operationStreams, ...statusStreams]) stream.end();
    await unavailableReads;
    assert.equal(posts().length, beforeTwoTabs + 2);
    lastOperation = { ...activeOperation, status: "succeeded", durationMs: 2500, downtimeMs: 1000 };
    activeOperation = null;
    restartStatusUnavailable = false;
    for (const tab of [page, secondTab]) await tab.getByRole("heading", { name: "Gateway restarted", exact: true }).waitFor();
    assert.equal(launchCount, 1);
    assert.equal(posts().length, beforeTwoTabs + 2);
    await page.screenshot({ path: path.join(artifacts, "two-tab-reconciled-operation.png"), fullPage: true });
    checks.push("Two real browser tabs attach to one operation via production app-shell hook; reload and lost SSE/status reconcile without POST replay");
  } finally { await secondTab.close(); }
  controllerMode = false;
  fullApp = true;
  const beforeOnboarding = posts().length;
  await page.goto(`http://127.0.0.1:${server.address().port}/full-app`);
  await open("Repair"); await button("Close options").click();
  await open("Restart"); await button("Close options").click();
  onboarding = false;
  for (const response of onboardingResponses.splice(0)) response.end(JSON.stringify({ onboarded: false }));
  await page.getByText("Start fresh", { exact: true }).waitFor();
  await open("Repair"); await button("Complete setup").click();
  await page.waitForFunction(() => document.activeElement?.id === "gateway-setup");
  await page.getByText("Start fresh", { exact: true }).waitFor();
  assert.equal(posts().length, beforeOnboarding);
  await page.screenshot({ path: path.join(artifacts, "full-app-not-onboarded.png"), fullPage: true });
  assert.equal(errors.length, 0, errors.join("\n"));
  fs.writeFileSync(path.join(artifacts, "requests.json"), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(artifacts, "contrast.json"), JSON.stringify(contrasts, null, 2));
  fs.writeFileSync(path.join(artifacts, "checks.json"), JSON.stringify({ checks, postCount: posts().length, sharedOperationLaunchCount: launchCount, checkRetainedFocus, limitations: ["HTTP admission/operation state is deterministic fixture data, not real gateway processes", "Runbook popups serve repository content through a browser route adapter, not live GitHub", "Upgrade/protection navigation is verified; target-bound consent submission is not exercised", "No novice, screen-reader, loaded-font or browser/text-only zoom claim"] }, null, 2));
  console.log(`PASS: recovery clicks, ${posts().length} deliberate POSTs, both themes and four widths; ${artifacts}`);
} catch (error) {
  fs.writeFileSync(path.join(artifacts, "failure.txt"), await page.locator("body").innerText());
  await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  for (const stream of [...operationStreams, ...statusStreams]) stream.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
