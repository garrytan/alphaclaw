import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = path.resolve("node_modules/openclaw/dist");
const loadExport = async (prefix, symbol) => {
  for (const name of fs.readdirSync(dist).filter((name) => name.startsWith(prefix) && name.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(dist, name), "utf8");
    const match = source.match(new RegExp(`\\b${symbol} as ([\\w$]+)[, }]`));
    if (match) return (await import(pathToFileURL(path.join(dist, name))))[match[1]];
  }
  throw new Error(`Pinned OpenClaw export not found: ${symbol}`);
};

const CronService = await loadExport("service-", "CronService");
const readHistory = await loadExport("jobs-", "readCronTaskRunHistoryPage");
const root = process.env.OPENCLAW_STATE_DIR;
const storePath = path.join(root, "cron", "jobs.json");
const events = [];
let queued = 0;
const cron = new CronService({
  storePath,
  cronEnabled: true,
  defaultAgentId: "main",
  log: { info() {}, debug() {}, warn: (...args) => console.error(...args), error: (...args) => console.error(...args) },
  enqueueSystemEvent: () => { queued += 1; },
  requestHeartbeat: () => {},
  onEvent: (event) => events.push(event),
});
try {
  const job = await cron.add({
    name: "Pinned runtime cron proof", enabled: true, agentId: "main",
    schedule: { kind: "every", everyMs: 3600000 },
    sessionTarget: "main", wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Pinned runtime cron outcome" },
  });
  const result = await cron.run(job.id, "force");
  const history = readHistory({ storeKey: storePath, jobId: job.id });
  const version = JSON.parse(fs.readFileSync("node_modules/openclaw/package.json", "utf8")).version;
  fs.writeFileSync(process.argv[2], JSON.stringify({ version, jobId: job.id, result, queued, history, events }));
} finally {
  cron.stop();
}
