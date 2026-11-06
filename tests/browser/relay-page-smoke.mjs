// Real Chromium render of the shipped Relay page (RelayTab, its hook and the
// API client) against fixture /api/relay/* answers shaped like the routes'.
// Run: node tests/browser/relay-page-smoke.mjs [screenshot-dir]
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { chromium } from "playwright";

const result = await build({ write: false, bundle: true, format: "esm",
  stdin: { resolveDir: process.cwd(), contents: `
    import {h,render} from 'preact';
    import {RelayTab} from './lib/public/js/components/relay-tab/index.js';
    render(h(RelayTab),document.getElementById('app'));
  ` } });
const css = ["theme.css", "tailwind.generated.css", "shell.css"]
  .map((file) => fs.readFileSync(path.join("lib/public/css", file), "utf8")).join("\n");
const now = Date.now();
const iso = (agoMs) => new Date(now - agoMs).toISOString();
let exposedOn = ["169.254.0.21"];
const fixtures = {
  "/api/relay/status": () => ({ ok: true, enabled: true, phase: "ready", error: null, retryAt: null,
    engine: { version: "12.8.0", target: "linux-x64", port: 18787,
      process: { status: "running", pid: 4242, starts: 1, startedAt: iso(3_600_000), lastExit: null, crashLoop: null },
      exposure: { checkedAt: iso(60_000), exposedOn } },
    agentName: "wintermute", settings: { retentionDays: 90, maxConcurrent: 2, hourlyCap: 30, agentNameRejected: null },
    bridge: { running: true, lastPollAt: iso(1000), lastPollError: null, pollFailures: 0, cursor: 41,
      counts: { answered: 12, interrupted: 1, dispatched: 1 }, maxConcurrent: 2, hourlyCap: 30 },
    startedAt: iso(3_600_000), readyAt: iso(3_590_000),
    agents: [
      { name: "wintermute", online: true, lastSeen: iso(1000), createdAt: iso(86_400_000) },
      { name: "capy-alph-63", online: false, lastSeen: iso(300_000), createdAt: iso(7_200_000) },
    ],
    dbBytes: { engine: 2_400_000, bridge: 98_000 } }),
  "/api/relay/runs?limit=50": () => ({ ok: true, counts: { answered: 12, interrupted: 1, dispatched: 1 }, runs: [
    { messageId: "244494732885680128", from: "capy-alph-63", state: "dispatched", code: null, hop: 0, attempts: 1, receivedAt: iso(20_000), dispatchedAt: iso(19_000), endedAt: null, replyMessageId: null, sessionKey: "agent:main:relay-capy-alph-63" },
    { messageId: "244494317673701376", from: "capy-alph-63", state: "interrupted", code: "run_interrupted", hop: 0, attempts: 1, receivedAt: iso(900_000), dispatchedAt: iso(899_000), endedAt: iso(860_000), replyMessageId: "244494400000000000", sessionKey: "agent:main:relay-capy-alph-63" },
    { messageId: "244494274208129024", from: "capy-alph-63", state: "answered", code: null, hop: 0, attempts: 1, receivedAt: iso(1_000_000), dispatchedAt: iso(999_000), endedAt: iso(990_000), replyMessageId: "244494280000000000", sessionKey: "agent:main:relay-capy-alph-63" },
  ], nextBefore: null }),
  "/api/relay/remote": () => ({ ok: true, enabled: true, mcpUrl: "https://wintermute.example.com/relay/mcp", unavailable: null,
    clients: [{ clientId: "c1", name: "Capy", redirectHosts: ["capy.ai"], createdAt: now - 86_400_000, consentedAt: now - 86_000_000, revokedAt: null, activeGrants: 1 }],
    bindings: [
      { agent: "capy-62a929e44271", threadId: "jam_01M6RSW4R1H4GDKPTPZM1PH1BR", clientId: "c1", webhookHost: "api.capy.ai", until: now + 6 * 86_400_000, expired: false, deadAt: null, lastWakeAt: now - 60_000, lastWakeStatus: "delivered", createdAt: now - 3_600_000 },
      { agent: "capy-0a0b0c0d0e0f", threadId: "jam_01OLD", clientId: "c1", webhookHost: "api.capy.ai", until: now - 86_400_000, expired: true, deadAt: now - 90_000_000, lastWakeAt: null, lastWakeStatus: "dead_410", createdAt: now - 9 * 86_400_000 },
    ],
    wakes: { delivered: 4, dead: 1 }, audit: [] }),
  "/api/relay/messages?limit=50": () => ({ ok: true, nextBefore: null, messages: [
    { id: "9", messageId: "244494280000000001", from: "wintermute", to: "capy-alph-63", kind: "dm", conversationId: "c1", threadId: "244494274208129024", createdAt: iso(980_000), relayStatus: "answered", relayCode: null, text: "Restarting the gateway needs Garry's yes. I asked him in Telegram; that change awaits approval relay-0a1b2c3d." },
    { id: "8", messageId: "244494274208129024", from: "capy-alph-63", to: "wintermute", kind: "dm", conversationId: "c1", threadId: null, createdAt: iso(1_000_000), relayStatus: null, relayCode: null, text: "What does the watchdog say about last night's restart? Restart the gateway if it looks wedged." },
  ] }),
};
const server = http.createServer((req, res) => {
  const fixture = fixtures[req.url];
  if (fixture) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(fixture())); }
  else if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(result.outputFiles[0].contents); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); }
  else if (req.url.startsWith("/api/")) { res.statusCode = 404; res.end("{}"); }
  else { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="text-body" style="background:var(--bg-content)"><main id="app" class="p-4"></main><script type="module" src="/bundle.js"></script></body></html>'); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const shots = process.argv[2] || null;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || execFileSync("which", ["google-chrome"], { encoding: "utf8" }).trim(), args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText("wintermute", { exact: false }).first().waitFor();
  await page.getByText("relay-0a1b2c3d", { exact: false }).first().waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /Restart the gateway if it looks wedged/, "message text starts collapsed");
  await page.getByRole("button", { name: "Show message" }).last().click();
  const text = await page.locator("body").innerText();
  assert.match(text, /169\.254\.0\.21/, "exposure warning names the address");
  assert.match(text, /capy-alph-63/);
  assert.match(text, /run_interrupted|cut off|Interrupted/i);
  assert.match(text, /Restart the gateway if it looks wedged/, "the audit log shows message text to the signed-in owner");
  assert.match(text, /https:\/\/wintermute\.example\.com\/relay\/mcp/, "connections show the MCP URL");
  assert.match(text, /capy-62a929e44271[\s\S]*wake delivered/);
  assert.match(text, /webhook gone/);
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByText("loses access at once", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Cancel" }).click();
  if (shots) await page.screenshot({ path: path.join(shots, "relay-page-desktop.png"), fullPage: true });
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 1400 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow at ${width}px`);
  }
  if (shots) await page.screenshot({ path: path.join(shots, "relay-page-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: status, agents, needs-you approval, interrupted run, exposure warning, audit log text, desktop/mobile layout");
} finally {
  await browser?.close();
  server.close();
}
