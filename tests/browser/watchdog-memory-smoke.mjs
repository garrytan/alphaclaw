// Real Chromium interaction with the shipped Resources components and CSS.
// Run: node tests/browser/watchdog-memory-smoke.mjs (after npm run build:ui).
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
    import {useState} from 'preact/hooks';
    import {WatchdogResourcesCard} from './lib/public/js/components/watchdog-tab/resources/index.js';
    const gb=1024**3;
    const resources={memory:{usedBytes:2.6*gb,totalBytes:8*gb,percent:32.5},
      disk:{usedBytes:1,totalBytes:10,percent:10},cpu:{percent:12,cores:4},
      gatewayMemory:{process:{status:'fresh',atMs:Date.now(),root:{pid:10},worker:{pid:11},
        groupRssBytes:4.9*gb,workerRssBytes:1.5*gb,childRssBytes:3.4*gb,childCount:18,
        launcherRssBytes:0,launcherCount:1,pss:{status:'fresh',atMs:Date.now(),pssBytes:2.6*gb,readCount:20,processCount:20}},
        telemetry:{status:'unavailable'},attribution:{state:'attributed',causes:['child_accumulation'],coverage:{sampleCount:60,gcCount:3}}},
      gatewayMemoryTrend:{state:'leak_suspected',rssMb:5018,effectiveCapMb:4288,capSource:'derived_group_budget',
        container:{state:'critical',sampleStatus:'stale',usedBytes:7.5*gb,limitBytes:8*gb}}};
    function App(){const [expanded,setExpanded]=useState(false);return h(WatchdogResourcesCard,
      {resources,memoryExpanded:expanded,onSetMemoryExpanded:setExpanded});}
    render(h(App),document.getElementById('app'));
  ` } });
const css = ["theme.css", "tailwind.generated.css", "shell.css"]
  .map((file) => fs.readFileSync(path.join("lib/public/css", file), "utf8")).join("\n");
const server = http.createServer((req, res) => {
  if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(result.outputFiles[0].contents); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); }
  else { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="bg-surface text-fg"><main id="app" class="p-4"></main><script type="module" src="/bundle.js"></script></body></html>'); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || execFileSync("which", ["google-chrome"], { encoding: "utf8" }).trim(), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText("Container memory critical", { exact: true }).waitFor();
  assert.equal(await page.getByText("How much memory?", { exact: true }).count(), 0);
  const toggle = page.getByRole("button", { name: /Memory/ }).first();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.getByText("How much memory?", { exact: true }).waitFor();
  assert.match(await page.locator("body").innerText(), /Child-process count and RSS grew/);
  assert.match(await page.locator("body").innerText(), /Heap telemetry unavailable until next gateway launch/);
  assert.doesNotMatch(await page.locator("body").innerText(), /Other\s+[\d.]+/);
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow at ${width}px`);
  }
  await page.getByRole("button", { name: /Memory/ }).first().click();
  assert.equal(await page.getByText("How much memory?", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: memory expansion, keyboard access, collapsed critical warning, scoped values, unavailable heap, desktop/mobile layout");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
