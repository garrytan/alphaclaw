// Balance the live tier into parallel legs (tests/live/shards.json) from
// measured per-file times: the vitest JSON report(s) a nightly uploads.
// Longest file first onto the lightest leg; every file that drives Chromium
// (it imports playwright or control-ui-live.js) goes to the one browser leg,
// the only leg that installs a browser. A file with no measured time counts
// as kUnmeasuredSeconds. Each leg's job limit is the larger of its budget x
// 2.5 and its longest declared test timeout plus a setup and artifact
// reserve, so the runner never ends a test before vitest's own timeout does
// (the timeouts are read by collecting the live files through vitest).
// Rerun when the nightly warns a leg ran over its budget.
//
// Usage: node scripts/ci/balance-live-shards.mjs [--legs 3] <report.json>... > tests/live/shards.json
//        node scripts/ci/balance-live-shards.mjs --check <leg>
// --check fails when a test in the leg now declares a timeout its job limit
// cannot cover; every live leg runs it before its tests.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const kRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const kLiveDir = path.join(kRoot, "tests", "live");
const kUnmeasuredSeconds = 120;
export const kBudgetFactor = 2.5;
export const kReserveSeconds = 600;
const kBrowserMarker = /require\(["'](playwright|\.\/control-ui-live)["']\)|from ["'](playwright|\.\/control-ui-live(\.js)?)["']/;

export const liveTestFiles = () =>
  readdirSync(kLiveDir)
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => `tests/live/${name}`)
    .sort();

export const isBrowserFile = (file) => kBrowserMarker.test(readFileSync(path.join(kRoot, file), "utf8"));

export const measuredSeconds = (reports) => {
  const seconds = {};
  for (const report of reports) {
    for (const result of report.testResults ?? []) {
      const file = `tests/live/${path.basename(result.name)}`;
      seconds[file] = Math.round(((result.endTime ?? 0) - (result.startTime ?? 0)) / 1000);
    }
  }
  return seconds;
};

export const balance = (files, seconds, { legs = 3, browser = () => false } = {}) => {
  const weight = (file) => seconds[file] ?? kUnmeasuredSeconds;
  const shards = Array.from({ length: legs }, (_, i) => ({ name: `leg${i + 1}`, files: [], budgetSeconds: 0, browser: false }));
  const browserFiles = files.filter(browser);
  const browserLeg = shards[legs - 1];
  browserLeg.browser = browserFiles.length > 0;
  for (const file of browserFiles) {
    browserLeg.files.push(file);
    browserLeg.budgetSeconds += weight(file);
  }
  for (const file of files.filter((f) => !browser(f)).sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((min, leg) => (leg.budgetSeconds < min.budgetSeconds ? leg : min));
    lightest.files.push(file);
    lightest.budgetSeconds += weight(file);
  }
  return Object.fromEntries(
    shards.map((leg) => [leg.name, { browser: leg.browser, budgetSeconds: leg.budgetSeconds, files: leg.files.sort() }]),
  );
};

export const declaredTimeoutSeconds = async () => {
  const { createVitest } = await import("vitest/node");
  process.env.OPENCLAW_LIVE_E2E = "1";
  const vitest = await createVitest("test", { watch: false, reporters: [] });
  try {
    const { testModules } = await vitest.collect(liveTestFiles());
    const seconds = {};
    for (const module of testModules) {
      const file = path.relative(kRoot, module.moduleId);
      seconds[file] = Math.max(0, ...[...module.children.allTests()].map((test) => Math.ceil((test.task.timeout ?? 0) / 1000)));
    }
    return seconds;
  } finally {
    await vitest.close();
  }
};

export const legTimeoutMinutes = ({ budgetSeconds, maxTestTimeoutSeconds }) =>
  Math.ceil(Math.max(budgetSeconds * kBudgetFactor, maxTestTimeoutSeconds + kReserveSeconds) / 60);

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const checkLeg = async (name) => {
  const { legs } = JSON.parse(readFileSync(path.join(kLiveDir, "shards.json"), "utf8"));
  const leg = legs[name];
  if (!leg) throw new Error(`no leg ${name} in tests/live/shards.json`);
  const timeouts = await declaredTimeoutSeconds();
  const maxTestTimeoutSeconds = Math.max(0, ...leg.files.map((file) => timeouts[file] ?? 0));
  const needed = legTimeoutMinutes({ budgetSeconds: leg.budgetSeconds, maxTestTimeoutSeconds });
  if (needed > leg.timeoutMinutes) {
    console.error(`leg ${name}: a test declares a ${maxTestTimeoutSeconds} s timeout, so its job limit must be at least ${needed} minutes (shards.json has ${leg.timeoutMinutes}); rerun this script and update live-e2e.yml`);
    process.exitCode = 1;
    return;
  }
  console.log(`leg ${name}: longest declared test timeout ${maxTestTimeoutSeconds} s fits the ${leg.timeoutMinutes}-minute limit`);
};

if (isMain && process.argv[2] === "--check") {
  await checkLeg(process.argv[3]);
} else if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--legs");
  const legs = i === -1 ? 3 : Number(args.splice(i, 2)[1]);
  const reports = args.map((file) => JSON.parse(readFileSync(file, "utf8")));
  const timeouts = await declaredTimeoutSeconds();
  const legsOut = balance(liveTestFiles(), measuredSeconds(reports), { legs, browser: isBrowserFile });
  for (const leg of Object.values(legsOut)) {
    leg.maxTestTimeoutSeconds = Math.max(0, ...leg.files.map((file) => timeouts[file] ?? 0));
    leg.timeoutMinutes = legTimeoutMinutes(leg);
  }
  const shards = {
    $comment:
      "Generated by scripts/ci/balance-live-shards.mjs from measured nightly times; live-e2e.yml runs one job per leg. Rerun it when the nightly warns that a leg ran over its budget.",
    legs: legsOut,
  };
  console.log(JSON.stringify(shards, null, 2));
}
