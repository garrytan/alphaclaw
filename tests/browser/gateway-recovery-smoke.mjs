// Browser smoke for the collapsed gateway restart UX: one Restart/Start
// button (no confirmation), one confirmed Repair button, one server-timed
// status line while a restart runs, and a single sentence + Try again /
// View logs on failure. Drives the real Gateway card and the production
// app-shell controller against a deterministic HTTP/SSE fixture.
//
//   node tests/browser/gateway-recovery-smoke.mjs
//   GATEWAY_BROWSER_ARTIFACTS=/tmp/out node tests/browser/gateway-recovery-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { reduceGatewayState, kGatewayStateCatalog, actionsForState } = require("../../lib/server/gateway-state");
const artifacts = path.resolve(process.env.GATEWAY_BROWSER_ARTIFACTS || ".gstack/qa/gateway-recovery");
fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });

const entry = `
import { h, render } from "preact";
import { Gateway } from "./lib/public/js/components/gateway.js";
import { GlobalRestartBanner } from "./lib/public/js/components/global-restart-banner.js";
import { gatewayShellStore } from "./lib/public/js/components/restart-progress-card.js";
import { restartGatewayAsync } from "./lib/public/js/lib/api.js";
import { useAppShellController } from "./lib/public/js/hooks/use-app-shell-controller.js";
function ControllerPage() {
  useAppShellController({ location: "/general" });
  return h("div", null, h(GlobalRestartBanner), h(Gateway));
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
const base = () => ({ configExists: true, tcp: { running: false, observedAt: Date.now() }, watchdog: { lifecycle: "configuration_error", health: "unhealthy" } });
const healthy = () => ({ configExists: true, tcp: { running: true, observedAt: Date.now() }, watchdog: { lifecycle: "running", health: "healthy" } });

let state = { hasStatus: true, connectivityMode: "online", statusState: reduceGatewayState(base()), restartOperation: null };
let repairMode = "accepted";
const requests = [];
const checks = [];

// Controller-mode fixture: one shared operation, SSE replay of every event
// emitted so far (mirrors the server), phaseAt derived from the step stamps.
let controllerMode = false;
let restartMode = "accept"; // accept | refuse
let activeOperation = null;
let lastOperation = null;
let launchCount = 0;
let statusRevision = 0;
let gatewayUp = true;
const operationStreams = new Set();
const statusStreams = new Set();
let emitted = [];
const phaseAt = () => Object.fromEntries(emitted.filter((e) => e.event === "step" && e.data.status === "running").map((e) => [e.data.name, e.data.at]));
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const emit = (event, data) => {
  emitted.push({ event, data });
  for (const stream of operationStreams) stream.write(sse(event, data));
  if (event === "done") {
    lastOperation = { ...activeOperation, status: "succeeded", durationMs: data.durationMs, downtimeMs: data.downtimeMs, phaseAt: phaseAt() };
    activeOperation = null;
  } else if (event === "error") {
    lastOperation = { ...activeOperation, status: "failed", code: data.code, errorSummary: data.error, hint: data.hint, budgetMs: data.budgetMs, how: data.how, phaseAt: phaseAt() };
    activeOperation = null;
  }
};
const step = (name, status, extra = {}) => emit("step", { name, label: name, status, at: Date.now(), ...extra });
const controllerStatus = () => ({ gateway: gatewayUp ? "running" : "stopped", snapshotEpoch: "controller-fixture", snapshotRevision: ++statusRevision, timestamp: Date.now(),
  state: reduceGatewayState({ ...(gatewayUp ? healthy() : { ...base(), watchdog: { lifecycle: "stopped", health: "unhealthy" } }), operation: activeOperation ? { kind: "restart", label: "Restarting gateway", operationId: activeOperation.operationId } : null }) });
const pushStatus = () => { for (const stream of statusStreams) stream.write(sse("status", { status: controllerStatus(), watchdogStatus: { health: "healthy" } })); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (["/", "/controller"].includes(url.pathname)) { res.setHeader("Content-Type", "text/html"); return res.end('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="app" style="max-width:900px;margin:16px auto;padding:12px"></main><script type="module" src="/bundle.js"></script></body></html>'); }
  if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(bundle.outputFiles[0].text); }
  if (url.pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); return res.end(css); }
  let text = ""; for await (const chunk of req) text += chunk;
  requests.push({ method: req.method, path: url.pathname, body: text ? JSON.parse(text) : null });
  res.setHeader("Content-Type", "application/json");
  if (controllerMode && url.pathname === "/api/events/status") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse("status", { status: controllerStatus(), watchdogStatus: { health: "healthy" } }));
    statusStreams.add(res); res.on("close", () => statusStreams.delete(res)); return;
  }
  if (controllerMode && /^\/api\/operations\/[^/]+\/events$/.test(url.pathname)) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const entry of emitted) res.write(sse(entry.event, entry.data));
    operationStreams.add(res); res.on("close", () => operationStreams.delete(res)); return;
  }
  if (controllerMode && req.method === "GET") {
    if (url.pathname === "/api/restart-status") {
      return res.end(JSON.stringify({ restartRequired: false, restartInProgress: !!activeOperation, reasons: [],
        activeOperation: activeOperation ? { ...activeOperation, phaseAt: phaseAt() } : null, lastOperation }));
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
    if (restartMode === "refuse" && !activeOperation) { res.statusCode = 409; return res.end(JSON.stringify({ ok: false, code: "operation_in_progress", error: "Another operation is in progress", hint: "Wait for the running operation to finish, then restart." })); }
    const attached = !!activeOperation;
    if (!attached) { launchCount += 1; emitted = []; activeOperation = { operationId: `shared-operation-${launchCount}`, status: "running", startedAt: Date.now() }; }
    res.statusCode = 202;
    return res.end(JSON.stringify({ ok: true, operationId: activeOperation.operationId, attached }));
  }
  if (url.pathname === "/fixture/status") return res.end(JSON.stringify(state));
  if (req.method === "POST" && url.pathname === "/api/watchdog/repair") {
    if (repairMode === "refused") { res.statusCode = 409; return res.end(JSON.stringify({ ok: false, code: "operation_in_progress", error: "Another operation is in progress", notStarted: true })); }
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === "POST") return res.end(JSON.stringify({ ok: true, operationId: "restart-fixture-1" }));
  res.statusCode = 404; res.end(JSON.stringify({ ok: false }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const posts = () => requests.filter((request) => request.method === "POST");
const refresh = () => page.evaluate(() => window.refreshFixture());
const button = (name, tab = page) => tab.getByRole("button", { name, exact: true });
const shot = (name, tab = page) => tab.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
const kGone = ["Restart options", "Repair options", "Check again", "Refresh status", "Open human recovery tools", "Close options", "Current assessment", "Database findings", "Excluded temporary artifacts", "Show evidence", "Dismiss", "Confirm restart gateway"];
const assertNoOldControls = async (tab = page) => {
  const text = await tab.locator("body").innerText();
  for (const label of kGone) assert(!text.includes(label), `old control present: ${label}`);
};
try {
  await page.goto(origin);
  await page.getByText("Configuration error", { exact: true }).first().waitFor();
  await button("Restart").waitFor();
  await button("Repair").waitFor();
  await assertNoOldControls();
  assert.equal(posts().length, 0);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ["Repair", "Restart"]) {
        const bounds = await button(name).boundingBox();
        assert(bounds.height >= 28 && bounds.width >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, `${theme}/${width} ${name} ${JSON.stringify(bounds)}`);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width} overflow`);
      await shot(`config-error-${theme}-${width}`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  checks.push("Restart + Repair only; 8 theme/viewport cells without overflow; no legacy options panel");

  // Repair: confirmed, once, cancel runs nothing.
  await button("Repair").click();
  await page.getByRole("dialog", { name: "Run Doctor repair?" }).waitFor();
  await page.getByText("Doctor may change supported configuration and relaunch the gateway.").waitFor();
  await shot("repair-confirm");
  await button("Cancel").click();
  assert.equal(posts().length, 0);
  await button("Repair").click();
  await page.getByRole("dialog").getByRole("button", { name: "Repair", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
  assert.equal(posts().length, 1);
  assert.deepEqual(posts().at(-1), { method: "POST", path: "/api/watchdog/repair", body: null });
  repairMode = "refused";
  await button("Repair").click();
  await page.getByRole("dialog").getByRole("button", { name: "Repair", exact: true }).click();
  await page.getByText("Not started: Another operation is in progress").waitFor();
  assert.equal(posts().length, 2);
  repairMode = "accepted";
  await refresh();
  // Paused auto-repair → "Resume repair once" → force: true.
  state.statusState = reduceGatewayState({ ...base(), watchdog: { ...base().watchdog, autoRepairPaused: true } });
  await refresh();
  await button("Repair").click();
  await page.getByRole("dialog").getByRole("button", { name: "Resume repair once", exact: true }).waitFor();
  await shot("repair-confirm-resume-once");
  await page.getByRole("dialog").getByRole("button", { name: "Resume repair once", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
  assert.deepEqual(posts().at(-1), { method: "POST", path: "/api/watchdog/repair", body: { force: true } });
  checks.push("Repair confirms (cancel = no POST), posts once, refusal renders one line, paused → Resume repair once with force: true");

  // Restart: no confirmation, one POST.
  state.statusState = reduceGatewayState(base());
  await refresh();
  const beforeRestart = posts().length;
  const restartResponse = page.waitForResponse((response) => response.url().includes("/api/gateway/restart"));
  await button("Restart").click();
  await restartResponse;
  assert.equal(posts().length, beforeRestart + 1);
  assert.equal(posts().at(-1).path, "/api/gateway/restart");
  assert.equal(await page.getByRole("dialog").count(), 0);
  checks.push("Restart dispatches immediately with no confirmation");

  // Start label when stopped; stale guard disables both.
  state.statusState = reduceGatewayState({ ...base(), watchdog: { lifecycle: "stopped" } });
  await refresh();
  await button("Start").waitFor();
  assert.equal(await button("Restart").count(), 0);
  await shot("stopped-start");
  state.statusState = reduceGatewayState(healthy());
  state.statusFreshness = { mode: "stale", observedAtMs: Date.now() - 60_000 };
  await refresh();
  await page.getByText("Status isn't current. Refresh before restarting.").waitFor();
  await button("Restart").isDisabled().then((disabled) => assert.equal(disabled, true));
  await button("Repair").isDisabled().then((disabled) => assert.equal(disabled, true));
  await shot("stale-guard");
  state.statusFreshness = null;
  checks.push("Start label when stopped; stale status disables both controls behind one guard line");

  // Every catalog state renders both controls (enabled per the server's disposition).
  for (const name of Object.keys(kGatewayStateCatalog)) {
    state.statusState = { ...reduceGatewayState(base()), state: name, ...kGatewayStateCatalog[name] };
    state.statusState.actions = actionsForState(name, {});
    await refresh();
    await page.getByText(kGatewayStateCatalog[name].label, { exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: /^(Restart|Start)$/ }).count(), 1, name);
    await button("Repair").waitFor();
    await assertNoOldControls();
    await shot(`state-${name}`);
  }
  checks.push(`${Object.keys(kGatewayStateCatalog).length} catalog states render Restart/Start + Repair`);

  // Controller mode: two real tabs share one operation via the production hook.
  controllerMode = true;
  const beforeTwoTabs = posts().length;
  const secondTab = await page.context().newPage();
  secondTab.on("pageerror", (error) => errors.push(error.message));
  try {
    await Promise.all([page, secondTab].map((tab) => tab.goto(`${origin}/controller`)));
    for (const tab of [page, secondTab]) await tab.waitForFunction(() => window.fixtureShell?.().statusState?.state === "running");
    await Promise.all([page, secondTab].map((tab) => button("Restart", tab).click()));
    for (const tab of [page, secondTab]) {
      await tab.waitForFunction(() => window.fixtureShell().restartOperation?.operationId === "shared-operation-1");
      // The launching tab keeps its optimistic "contacting" line; the attached tab waits for the replay.
      await tab.locator(".ac-restart-line").getByText(/^Restarting: (contacting AlphaClaw…|preparing) · \d+s$/).waitFor();
      assert.equal(await button("Restart", tab).count(), 0);
      assert.equal(await button("Repair", tab).count(), 0);
    }
    assert.equal(launchCount, 1);
    assert.equal(posts().length, beforeTwoTabs + 2);
    const line = (tab = page) => tab.locator(".ac-restart-line");
    const expectLine = async (pattern) => { for (const tab of [page, secondTab]) await line(tab).getByText(pattern).waitFor(); };
    step("preparing_plugins", "running"); await expectLine(/^Restarting: checking plugins \(gateway still running\) · \d+s$/); await shot("progress-plugins");
    assert.equal(await line().getAttribute("aria-live"), "polite");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ac-restart-line")), true, "focus lands on the status line");
    step("preparing_plugins", "skipped");
    step("stopping", "running", { detail: { phase: "asking", activeWork: 2 } }); await expectLine(/^Restarting: asking OpenClaw to finish its current work \(2 tasks\) · \d+s$/); await shot("progress-asking");
    step("stopping", "running", { detail: { phase: "terminating" } }); await expectLine(/^Restarting: stopping OpenClaw · \d+s$/);
    step("stopping", "running", { detail: { phase: "forcing", graceSeconds: 10 } }); await expectLine(/^Restarting: OpenClaw didn't stop in 10s, forcing it \(active work may be interrupted\) · \d+s$/); await shot("progress-forcing");
    step("stopping", "done", { detail: { how: "sigkill" } });
    gatewayUp = false; pushStatus();
    step("launching", "running"); await expectLine(/^Restarting: starting OpenClaw · \d+s$/); await shot("progress-launching");
    step("waiting_ready", "running", { budgetMs: 300000, detail: { phase: "lock_wait" } }); await expectLine(/^Restarting: waiting for OpenClaw's state lock \(another OpenClaw process is finishing\) · \d+s$/); await shot("progress-lock-wait");
    // Reload mid-operation: the record's phaseAt + SSE replay rebuild the same line and timer.
    await secondTab.reload();
    await line(secondTab).getByText(/^Restarting: waiting for OpenClaw's state lock/).waitFor();
    assert.equal(await secondTab.evaluate(() => window.fixtureShell().restartOperation.operationId), "shared-operation-1");
    for (const tab of [page, secondTab]) assert.match(await tab.locator(".global-restart-banner").innerText(), /Restarting: waiting for OpenClaw's state lock/);
    step("waiting_ready", "running", { budgetMs: 300000 }); await expectLine(/^Restarting: checking readiness · \d+s$/); await shot("progress-readiness");
    step("ready", "done");
    gatewayUp = true; pushStatus();
    emit("done", { ok: true, durationMs: 3400, downtimeMs: 1200 });
    await expectLine("Running: restarted in 3s (down for 1s)");
    await shot("success");
    for (const tab of [page, secondTab]) assert.equal(await tab.locator('[role="status"]', { hasText: "Running: restarted" }).count(), 1);
    assert.equal(launchCount, 1);
    assert.equal(posts().length, beforeTwoTabs + 2);
    // The success line collapses on its own and the controls return.
    await button("Restart").waitFor({ timeout: 15000 });
    await button("Repair").waitFor();
    checks.push("Two tabs attach to one operation; every contract phase renders as one line (incl. forcing + lock_wait); reload rebuilds line + banner from phaseAt/replay; success line auto-collapses");

    // Failure: ready_timeout with the server budget → one sentence + Try again + View logs.
    await button("Restart").click();
    await page.waitForFunction(() => window.fixtureShell().restartOperation?.operationId === "shared-operation-2");
    step("stopping", "running"); step("stopping", "done", { detail: { how: "graceful" } }); step("launching", "running"); step("waiting_ready", "running", { budgetMs: 300000 });
    emit("error", { code: "ready_timeout", error: "gateway did not become ready within 300000ms", hint: "Check the gateway logs.", budgetMs: 300000, how: "graceful" });
    await page.getByText("OpenClaw started but wasn't ready within 5 min.", { exact: true }).waitFor();
    const alert = page.locator('[role="alert"]');
    assert.equal(await alert.count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "alert", "focus lands on the failure line");
    await button("Try again").waitFor(); await button("View logs").waitFor();
    assert.equal(await button("Restart").count(), 0);
    await assertNoOldControls();
    await shot("failure-ready-timeout");
    assert.match(await page.locator(".global-restart-banner").innerText(), /Gateway restart failed/);
    // Reload renders the same sentence from the persisted record.
    await secondTab.reload();
    await secondTab.getByText("OpenClaw started but wasn't ready within 5 min.", { exact: true }).waitFor();
    await button("Try again", secondTab).waitFor();
    // Try again → a new POST → attached operation; stop_refused offers View logs only.
    const beforeRetry = posts().length;
    await button("Try again").click();
    await page.waitForFunction(() => window.fixtureShell().restartOperation?.operationId === "shared-operation-3");
    assert.equal(posts().length, beforeRetry + 1);
    step("stopping", "running");
    emit("error", { code: "stop_refused", error: "could not identify the serving process", hint: null });
    await page.getByText("Couldn't safely identify the running gateway. Restart the container, or open View logs.", { exact: true }).waitFor();
    assert.equal(await button("Try again").count(), 0);
    await button("View logs").waitFor();
    await shot("failure-stop-refused");
    // View logs navigates to the Watchdog tab (no handler wired in this harness).
    await button("View logs").click();
    assert.equal(new URL(page.url()).hash, "#/watchdog");
    // Policy refusal on a fresh attempt: info line, no failure.
    await secondTab.reload();
    await button("View logs", secondTab).waitFor();
    restartMode = "refuse";
    await secondTab.evaluate(() => window.fixtureShell().actions.restart());
    await secondTab.getByText("Can't restart right now: Wait for the running operation to finish, then restart.").waitFor();
    assert.equal(await secondTab.locator('[role="alert"]').count(), 0);
    await button("Restart", secondTab).waitFor();
    await shot("policy-refusal", secondTab);
    restartMode = "accept";
    checks.push("ready_timeout renders the budgeted sentence (reload-stable) with Try again/View logs; Try again posts once; stop_refused hides Try again; View logs → #/watchdog; 409 → info line");
  } finally { await secondTab.close(); }
  assert.equal(errors.length, 0, errors.join("\n"));
  fs.writeFileSync(path.join(artifacts, "requests.json"), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(artifacts, "checks.json"), JSON.stringify({ checks, postCount: posts().length, sharedOperationLaunchCount: launchCount, limitations: ["HTTP admission/operation state is deterministic fixture data, not real gateway processes", "No novice, screen-reader, loaded-font or browser/text-only zoom claim"] }, null, 2));
  console.log(`PASS: ${checks.length} checks, ${posts().length} POSTs; ${artifacts}`);
} catch (error) {
  fs.writeFileSync(path.join(artifacts, "failure.txt"), await page.locator("body").innerText().catch(() => ""));
  await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  for (const stream of [...operationStreams, ...statusStreams]) stream.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
