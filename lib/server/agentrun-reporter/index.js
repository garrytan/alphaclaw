// AlphaClaw's AgentRun reporter (GST-2907): every 15 s, moves finished turns
// from the OpenClaw plugin's spool into the queue, follows live runs (started
// in AgentRun while they run) and sends due rows to AgentRun as SDK runs. Off unless ALPHACLAW_AGENTRUN_URL is set; captured
// rows wait (bounded) until ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN is set too.
// Nothing here runs on an OpenClaw turn's path. Contract and log codes:
// docs/designs/agentrun-reporter.md.
const path = require("path");
const { resolveAgentrunReporterConfig } = require("./config");
const { openOutbox } = require("./outbox");
const { createOpenclawSource, contentStillAllowed } = require("./openclaw-source");
const { createAgentrunClient } = require("./agentrun-client");
const { createSender } = require("./sender");
const { cut } = require("./bodies");

const kTickMs = 15000;
const kPruneEveryTicks = 40;
const kIngestErrorLogEveryMs = 60 * 60 * 1000;
// GET /capabilities is read again at most this often.
const kFeaturesEveryMs = 60 * 60 * 1000;
const kTitleMax = 200;

const createAgentrunReporter = ({
  env = process.env,
  rootDir,
  readCronJobs = () => [],
  readOpenclawConfig = () => null,
  scrub = (text) => text,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = console,
  tickMs = kTickMs,
} = {}) => {
  const settings = resolveAgentrunReporterConfig(env);
  const { token } = settings;
  let outbox = null;
  let source = null;
  let sender = null;
  let timer = null;
  let running = null;
  let ticks = 0;
  let warnedNoToken = false;
  let lastIngestErrorAt = -Infinity;
  let client = null;
  // What this AgentRun advertises: features.sdk_runs lifts the one-hour
  // window and takes started_at, title and labels on a start.
  const features = { sdkRuns: false };
  let featuresReadAt = -Infinity;

  // The cron job list, read at most once a tick for agent names.
  let jobsOfTick = null;
  const currentJobs = () => {
    if (jobsOfTick === null) {
      try {
        jobsOfTick = readCronJobs() || [];
      } catch {
        jobsOfTick = [];
      }
    }
    return jobsOfTick;
  };

  const log = (line) => logger.warn?.(`[alphaclaw] agentrun-reporter ${line}`);

  const ensureOpen = () => {
    if (outbox) return;
    outbox = openOutbox({ dbPath: path.join(rootDir, "db", "agentrun-outbox.db"), now });
    client = createAgentrunClient({ baseUrl: settings.url, fetchImpl });
    source = createOpenclawSource({
      rootDir,
      outbox,
      getContentCronJobs: () => settings.contentCronJobs,
      getHiddenCronNames: () => settings.hiddenCronNames,
      readCronJobs,
      readOpenclawConfig,
      getLive: () => settings.live,
      getFeatures: () => features,
      scrub,
      logger,
      now,
    });
    sender = createSender({
      outbox,
      client,
      token,
      getRuntime: () => settings.runtime,
      contentAllowed: (row) => contentStillAllowed(row, settings.contentCronJobs),
      agentNameOf: (row) => source.agentNameOf(row, currentJobs()),
      startFieldsOf,
      now,
      logger,
      source: "openclaw",
    });
  };

  // With features.sdk_runs a start carries the run's start time, its title
  // line and labels; a server without it refuses them (the sender then
  // rebuilds the start once without them).
  const startFieldsOf = (row) => {
    if (!features.sdkRuns) return {};
    return {
      ...(row.started_at ? { started_at: new Date(Number(row.started_at)).toISOString() } : {}),
      title: cut(String(row.input_text || "").split("\n")[0].split(" — ")[0], kTitleMax),
      labels: ["source:openclaw", `class:${row.class}`],
    };
  };

  const refreshFeatures = async () => {
    if (now() - featuresReadAt < kFeaturesEveryMs) return;
    featuresReadAt = now();
    const got = await client.call({ method: "GET", path: "/capabilities", token });
    if (got.kind === "ok") features.sdkRuns = Boolean(got.body?.features?.sdk_runs);
  };

  const tick = async () => {
    if (!settings.enabled) return null;
    if (running) return running;
    running = (async () => {
      ensureOpen();
      jobsOfTick = null;
      if (settings.token) await refreshFeatures().catch(() => {});
      let ingested = null;
      try {
        ingested = source.ingest();
      } catch (error) {
        if (now() - lastIngestErrorAt >= kIngestErrorLogEveryMs) {
          lastIngestErrorAt = now();
          log(`capture_error op=ingest ${String(error?.message || error).slice(0, 200)} (sending continues)`);
        }
      }
      ticks += 1;
      if (ticks % kPruneEveryTicks === 1) {
        const pruned = outbox.prune();
        if (pruned.dropped) log(`queue_overflow op=prune count=${pruned.dropped} (oldest unsent turns gone; check that AgentRun is reachable and the token is set)`);
      }
      if (!settings.token) {
        if (!warnedNoToken) {
          warnedNoToken = true;
          log("token_missing op=send fix=set ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN in the deployment env (turns are kept, bounded, until then)");
        }
        return { ingested, sent: null };
      }
      const sent = await sender.sendDue();
      return { ingested, sent, archived: await sender.archiveDue() };
    })()
      .catch((error) => {
        log(`send_error op=tick ${String(error?.message || error).slice(0, 200)}`);
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const start = () => {
    if (!settings.enabled || timer) return false;
    if (!settings.runtimeValid) log("runtime_invalid fix=ALPHACLAW_AGENTRUN_RUNTIME must be a runtime name such as claude-agent-sdk or openclaw; using claude-agent-sdk");
    if (!settings.liveValid) log("live_invalid fix=set ALPHACLAW_AGENTRUN_LIVE to on or off in the deployment env; keeping it on");
    logger.log?.(`[alphaclaw] agentrun-reporter on: runtime=${settings.runtime} contentCronJobs=${settings.contentCronJobs.size} live=${settings.live ? "on" : "off"}`);
    timer = setInterval(() => void tick(), tickMs);
    timer.unref?.();
    return true;
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      outbox?.close();
    } catch {}
    outbox = null;
  };

  return { start, stop, tick, settings, features, status: () => (outbox ? outbox.counts() : {}) };
};

module.exports = { createAgentrunReporter };
