import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = path.resolve("node_modules/openclaw/dist");
const loadExport = async (prefixes, symbol) => {
  const names = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs"));
  for (const name of [].concat(prefixes).flatMap((prefix) => names.filter((name) => name.startsWith(prefix)))) {
    const source = fs.readFileSync(path.join(dist, name), "utf8");
    const match = source.match(new RegExp(`\\b${symbol} as ([\\w$]+)[, }]`));
    if (match) return (await import(pathToFileURL(path.join(dist, name))))[match[1]];
  }
  throw new Error(`Pinned OpenClaw export not found: ${symbol}`);
};

const CronService = await loadExport("service-", "CronService");
// 2026.9.7+ CronService requires the gateway's scheduler as a dependency.
const GatewayScheduler = await loadExport("gateway-scheduler-", "GatewayScheduler");
// 2026.9.7 retired the Tasks-era readCronTaskRunHistoryPage; the gateway's
// cron.runs handler now reads records and projects the page in two steps.
// 2026.11.5 split it in two, as its cron.runs handler reads: candidate rows
// for the job, then the full records for their ids.
const readCronRunRecords = await loadExport("read-only-", "readCronRunRecords").catch(() => null);
const readCronRunHistoryCandidates = readCronRunRecords ? null : await loadExport("read-only-", "readCronRunHistoryCandidates");
const readCronRunHistoryRecords = readCronRunRecords ? null : await loadExport("read-only-", "readCronRunHistoryRecords");
const readRuns = async (storePath, jobId) => {
  if (readCronRunRecords) return readCronRunRecords(storePath, jobId);
  const storeKey = path.resolve(storePath);
  const { records } = await readCronRunHistoryCandidates(storeKey, jobId);
  return readCronRunHistoryRecords(storeKey, records.map((record) => record.id));
};
// 2026.10.10 moved it from jobs-*.mjs to run-history-*.mjs.
const projectCronRunHistoryPage = await loadExport(["run-history-", "jobs-"], "projectCronRunHistoryPage");
const root = process.env.OPENCLAW_STATE_DIR;
const storePath = path.join(root, "cron", "jobs.json");
const events = [];
let queued = 0;
const scheduler = new GatewayScheduler();
const cron = new CronService({
  scheduler,
  storePath,
  cronEnabled: true,
  defaultAgentId: "main",
  log: { info() {}, debug() {}, warn: (...args) => console.error(...args), error: (...args) => console.error(...args) },
  enqueueSystemEvent: () => { queued += 1; },
  // 2026.11.5 runs a main-session job's text through the session controller
  // (runSessionEvent) instead of queueing it as a system event.
  runSessionEvent: async () => { queued += 1; return { status: "ok" }; },
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
  const history = projectCronRunHistoryPage(await readRuns(storePath, job.id), { storeKey: storePath, jobId: job.id });
  const version = JSON.parse(fs.readFileSync("node_modules/openclaw/package.json", "utf8")).version;
  fs.writeFileSync(process.argv[2], JSON.stringify({ version, jobId: job.id, result, queued, history, events }));
} finally {
  cron.stop();
}
