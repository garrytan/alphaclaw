// Browser smoke for honest boot status (v0.10.8): the real Gateway card and
// global banner rendered from frames the real boot timeline produced, plus
// the real boot placeholder page. Screenshots every stage, a success, a
// failure, the "keeps restarting" state and the placeholder (dark, light,
// stuck) at 1280 and 375 px.
//
//   CHROME_BIN=/usr/local/bin/chromium node tests/browser/boot-progress-smoke.mjs
//   BOOT_BROWSER_ARTIFACTS=/tmp/out node tests/browser/boot-progress-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { reduceGatewayState } = require("../../lib/server/gateway-state");
const { createBootTimeline } = require("../../lib/server/boot-progress/timeline");
const { projectBootProgressHuman, projectBootOverlay } = require("../../lib/server/boot-progress/projections");
const { createBootPlaceholderHandler } = require("../../lib/boot-placeholder");
const artifacts = path.resolve(process.env.BOOT_BROWSER_ARTIFACTS || ".gstack/qa/boot-progress");
fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });

const entry = `
import { h, render } from "preact";
import { Gateway } from "./lib/public/js/components/gateway.js";
import { GlobalRestartBanner } from "./lib/public/js/components/global-restart-banner.js";
import { gatewayShellStore } from "./lib/public/js/components/restart-progress-card.js";
const refresh = async () => {
  const shell = await (await fetch('/fixture/status')).json();
  gatewayShellStore.publish({ ...shell, actions: { refresh, restart: async () => ({}), openSetup: () => {} } });
};
window.refreshFixture = refresh;
render(h("div", null, h(GlobalRestartBanner), h(Gateway)), document.getElementById('app'));
refresh();
`;
const bundle = await build({ bundle: true, write: false, format: "esm", stdin: { contents: entry, resolveDir: process.cwd() } });
const css = ["theme.css", "tailwind.generated.css", "shell.css"].map((file) => fs.readFileSync(`lib/public/css/${file}`, "utf8")).join("\n");

// A real timeline driven through the startup steps on a controllable clock.
const t0 = Date.now() - 1_000;
let clock = t0;
const quiet = { log: () => {}, warn: () => {} };
const bootAt = ({ kind = "restarting", estimateMs = null, steps = [], doctor = false, output = [], observe = null, elapsedMs = 0 }) => {
  clock = t0;
  const timeline = createBootTimeline({
    bootId: "smoke:" + Math.random(),
    startedAtMs: t0,
    kind,
    now: () => clock,
    readVersions: () => ({ alphaclaw: "0.10.8", openclaw: "2026.10.4" }),
    estimateFor: () => (estimateMs ? { estimateMs, samples: 3, basis: "same_kind" } : null),
    logger: quiet,
  });
  clock += 3_000;
  for (const id of ["lock_contention", "restart_reconcile", "boot_report", "config_normalize"]) timeline.step(id);
  if (doctor) {
    clock += 2_000;
    timeline.noteDoctorStart({ fromVersion: "2026.10.2", toVersion: "2026.10.4" });
  }
  for (const id of steps) {
    clock += 1_500;
    timeline.step(id);
  }
  for (const line of output) {
    clock += 1_000;
    timeline.noteGatewayOutput(line);
  }
  if (observe) {
    clock += 2_000;
    timeline.observe(observe);
  }
  clock = Math.max(clock, t0 + elapsedMs);
  return timeline.snapshot();
};
const kLaunchSteps = ["native_maintenance", "autotune", "config_ensure", "prompt_sync", "channel_sync", "proxy_config", "report_finalize", "gateway_launch"];
const tcpDown = { running: false, observedAt: Date.now() };
const tcpUp = { running: true, observedAt: Date.now() };
const wdHealthy = { lifecycle: "running", health: "healthy", safeMode: false, suppressedChannels: [], crashCountInWindow: 0, gatewayPid: 4242 };
const shellFor = ({ snapshot, reducer, connectivityMode = "online", bootReconnect = null }) => {
  const now = clock;
  const bootProgress = snapshot ? projectBootProgressHuman(snapshot, { now }) : null;
  const statusState = reduceGatewayState({ configExists: true, now: Date.now(), operation: null, ...reducer, boot: projectBootOverlay(snapshot) });
  return {
    hasStatus: true,
    connectivityMode,
    statusState,
    bootProgress,
    bootReconnect,
    statusFreshness: { mode: "fresh", observedAtMs: now, receivedAtMs: Date.now() },
    restartOperation: null,
  };
};

const scenarios = {
  "1-preparing": () => shellFor({ snapshot: bootAt({ elapsedMs: 4_000 }), reducer: { tcp: tcpDown, watchdog: null, bootPhase: { phase: "starting_gateway" } } }),
  "2-upgrading": () => shellFor({ snapshot: bootAt({ kind: "updating_alphaclaw", doctor: true, elapsedMs: 42_000 }), reducer: { tcp: tcpDown, watchdog: null, bootPhase: { phase: "starting_gateway" } } }),
  "3-gateway-estimate": () => shellFor({
    snapshot: bootAt({ estimateMs: 85_000, steps: kLaunchSteps, output: ["[gateway] startup phase: cli.bootstrap.admission.database-readiness starting total=2888.3ms\n"], elapsedMs: 40_000 }),
    reducer: { tcp: tcpDown, watchdog: { ...wdHealthy, lifecycle: "restarting", health: "unknown" }, bootPhase: { phase: "starting_gateway" } },
  }),
  "4-gateway-longer": () => shellFor({
    snapshot: bootAt({ estimateMs: 85_000, steps: kLaunchSteps, elapsedMs: 123_000 }),
    reducer: { tcp: tcpDown, watchdog: { ...wdHealthy, lifecycle: "restarting", health: "unknown" }, bootPhase: { phase: "starting_gateway" } },
  }),
  "5-channels": () => shellFor({
    snapshot: bootAt({ steps: kLaunchSteps, output: ["[gateway] startup phase: http.bound 0.0ms total=11552.8ms\n"], elapsedMs: 52_000 }),
    reducer: { tcp: tcpUp, watchdog: { ...wdHealthy, readiness: "not_ready", readinessStatus: "starting" }, bootPhase: { phase: "ready" } },
  }),
  "6-ready": () => {
    const snapshot = bootAt({ steps: kLaunchSteps, observe: { bootPhase: { phase: "ready" }, watchdog: { ...wdHealthy, readiness: "ready", replacementPending: null } }, elapsedMs: 0 });
    clock = snapshot.endedAt + 2_000;
    return shellFor({ snapshot, reducer: { tcp: tcpUp, watchdog: wdHealthy, bootPhase: { phase: "ready" } } });
  },
  "7-failed": () => {
    const watchdog = { ...wdHealthy, health: "degraded", readiness: "not_ready", readinessReason: "state-db" };
    const snapshot = bootAt({ steps: kLaunchSteps, observe: { bootPhase: { phase: "ready" }, watchdog } });
    return shellFor({ snapshot, reducer: { tcp: tcpUp, watchdog, bootPhase: { phase: "ready" } } });
  },
  "8-keeps-restarting": () => shellFor({ snapshot: null, reducer: { tcp: tcpDown, watchdog: null, bootPhase: { phase: "starting_gateway" } }, connectivityMode: "restart_loop", bootReconnect: { mode: "restart_loop", count: 4, label: "Restarting", stageLabel: "Preparing" } }),
};

let current = null;
const placeholder = { dark: createBootPlaceholderHandler({ bootId: "ph" }), stuck: createBootPlaceholderHandler({ bootId: "ph", startedAtMs: Date.now() - 3_600_000, maxUpdatingWindowMs: 60_000 }) };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") { res.setHeader("Content-Type", "text/html"); return res.end('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="app" style="max-width:900px;margin:16px auto;padding:12px"></main><script type="module" src="/bundle.js"></script></body></html>'); }
  if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(bundle.outputFiles[0].text); }
  if (url.pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); return res.end(css); }
  if (url.pathname === "/fixture/status") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(current)); }
  if (url.pathname.startsWith("/placeholder")) {
    const handler = url.pathname.endsWith("stuck") ? placeholder.stuck : placeholder.dark;
    return handler({ url: "/", headers: { accept: "text/html" } }, res);
  }
  res.setHeader("Content-Type", "application/json");
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const errors = [];
const checks = [];
try {
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/");
    for (const [name, make] of Object.entries(scenarios)) {
      current = make();
      await page.evaluate(() => window.refreshFixture());
      await page.waitForTimeout(150);
      const text = await page.locator("#app").innerText();
      assert.doesNotMatch(text, /usually under|under a minute|couple of minutes/i, name);
      if (name === "2-upgrading") assert.match(text, /Updating AlphaClaw|Upgrading OpenClaw/);
      if (name === "3-gateway-estimate") assert.match(text, /Usually about 1m 25s/);
      if (name === "4-gateway-longer") assert.match(text, /Taking longer than usual/);
      if (name === "5-channels") { assert.match(text, /Running/); assert.match(text, /Connecting channels/); }
      if (name === "6-ready") assert.match(text, /Ready in/);
      if (name === "7-failed") assert.match(text, /Last boot stopped at Starting the gateway/);
      if (name === "8-keeps-restarting") assert.match(text, /AlphaClaw keeps restarting/);
      if (width === 375) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${name} overflows 375px by ${overflow}px`);
      }
      // No ticking clock inside a live region.
      const liveClock = await page.evaluate(() => [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].some((el) => /\d+s so far|\d+:\d\d/.test(el.textContent || "")));
      assert.equal(liveClock, false, `${name}: clock inside a live region`);
      await page.screenshot({ path: path.join(artifacts, `card-${name}-${width}.png`), fullPage: true });
      checks.push(`card ${name} @${width}`);
    }
    await context.close();
    for (const scheme of ["dark", "light"]) {
      const ctx = await browser.newContext({ viewport: { width, height: 700 }, colorScheme: scheme, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      for (const variant of ["placeholder", "placeholder-stuck"]) {
        await page.goto(origin + "/" + variant);
        const text = await page.locator("body").innerText();
        assert.match(text, /AlphaClaw is restarting/);
        assert.match(text, /Preparing/);
        assert.doesNotMatch(text, /Starting the gateway|Connecting channels|\d{4}\.\d+\.\d+/);
        if (variant.endsWith("stuck")) assert.match(text, /host/i);
        await page.screenshot({ path: path.join(artifacts, `${variant}-${scheme}-${width}.png`), fullPage: true });
        checks.push(`${variant} ${scheme} @${width}`);
      }
      await ctx.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(`boot-progress smoke ok: ${checks.length} checks, screenshots in ${artifacts}`);
} finally {
  await browser.close();
  server.close();
}
