// AlphaClaw's AgentRun reporter (GST-2907): every 15 s, moves finished turns
// from the OpenClaw plugin's spool into the queue and sends due rows to
// AgentRun as SDK runs. Off unless ALPHACLAW_AGENTRUN_URL is set; captured
// rows wait (bounded) until ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN is set too.
// Nothing here runs on an OpenClaw turn's path. Contract and log codes:
// docs/designs/agentrun-reporter.md.
const path = require("path");
const { resolveAgentrunReporterConfig } = require("./config");
const { openOutbox } = require("./outbox");
const { createOpenclawSource, contentStillAllowed } = require("./openclaw-source");
const { createAgentrunClient } = require("./agentrun-client");
const { createSender } = require("./sender");

const kTickMs = 15000;
const kPruneEveryTicks = 40;
const kIngestErrorLogEveryMs = 60 * 60 * 1000;

const createAgentrunReporter = ({
  env = process.env,
  rootDir,
  readCronJobs = () => [],
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
    source = createOpenclawSource({
      rootDir,
      outbox,
      getContentCronJobs: () => settings.contentCronJobs,
      getHiddenCronNames: () => settings.hiddenCronNames,
      readCronJobs,
      scrub,
      logger,
      now,
    });
    sender = createSender({
      outbox,
      client: createAgentrunClient({ baseUrl: settings.url, fetchImpl }),
      token,
      getRuntime: () => settings.runtime,
      contentAllowed: (row) => contentStillAllowed(row, settings.contentCronJobs),
      agentNameOf: (row) => source.agentNameOf(row, currentJobs()),
      now,
      logger,
      source: "openclaw",
    });
  };

  const tick = async () => {
    if (!settings.enabled) return null;
    if (running) return running;
    running = (async () => {
      ensureOpen();
      jobsOfTick = null;
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
    logger.log?.(`[alphaclaw] agentrun-reporter on: runtime=${settings.runtime} contentCronJobs=${settings.contentCronJobs.size}`);
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

  return { start, stop, tick, settings, status: () => (outbox ? outbox.counts() : {}) };
};

module.exports = { createAgentrunReporter };
