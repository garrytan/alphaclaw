// OpenClaw side of AlphaClaw's AgentRun reporter (GST-2907): turns the
// plugin's spool files into queue rows. This is where the privacy policy is
// applied: a turn keeps its text only when both the plugin and this module
// class its session as an isolated cron session AND its job id is on
// ALPHACLAW_AGENTRUN_CONTENT_CRON. The cron input is the job's own configured
// message, never the model-boundary prompt (which carries memory and brain
// context other plugins inject). No chat id, user id or raw session key ever
// reaches a row: the session label is the class, the channel and an HMAC.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { classifySession, mayCarryContents } = require("../../plugin/agentrun-reporter/classify");
const { resolveProcessVerdict } = require("../gateway-identity");
const { cut } = require("./bodies");

const kSpoolDirName = "agentrun-spool";
const kMaxIngestPerTick = 500;
const kMaxIngestTries = 5;
const kWarnEveryMs = 60 * 60 * 1000;
// A live gateway's run file whose end record is this old is read as finished
// even though the plugin never renamed it: OpenClaw sends the attempt's
// llm_output after agent_end, and some attempts send none.
const kEndedSettleMs = 30_000;
const kTitleWhatMax = 60;

const kClassTitles = {
  main: "Main session",
  heartbeat: "Heartbeat",
  relay: "Relay",
  hook: "Hook",
  subagent: "Subagent",
  unknown: "Turn",
};
const channelName = (channel) => {
  const name = String(channel || "").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Chat";
};

const readLines = (file, fsModule) =>
  fsModule
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record && typeof record === "object");

const loadSalt = ({ rootDir, fsModule }) => {
  const file = path.join(rootDir, "db", "agentrun-reporter.salt");
  try {
    const existing = fsModule.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const salt = crypto.randomBytes(32).toString("hex");
  fsModule.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fsModule.writeFileSync(file, salt, { mode: 0o600 });
  return salt;
};

const describeDuration = (ms) => (Number.isFinite(ms) && ms > 0 ? `${Math.round(ms / 100) / 10}s` : "unknown duration");

// AgentRun titles an SDK run with the first 80 characters of its input,
// whitespace collapsed, so the input opens with what ran, how long and how it
// ended, and the rest follows after a dash.
const runSummary = ({ what, durationMs, status, reason, details }) =>
  `${what} · ${describeDuration(durationMs)} · ${status}${reason ? ` (${reason})` : ""} — ${details}`;

const createOpenclawSource = ({
  rootDir,
  outbox,
  getContentCronJobs = () => new Set(),
  readCronJobs = () => [],
  scrub = (text) => text,
  fsModule = fs,
  logger = console,
  now = () => Date.now(),
  isProcessAlive = (pid, startTicks) => resolveProcessVerdict(pid, startTicks).verdict !== "gone",
}) => {
  const spoolRoot = path.join(rootDir, kSpoolDirName);
  const readFailures = new Map();
  const undeletable = new Set();
  let salt = null;
  const labelOf = (cls, channel, sessionKey) => {
    if (!salt) salt = loadSalt({ rootDir, fsModule });
    const digest = crypto.createHmac("sha256", salt).update(String(sessionKey || "")).digest("hex").slice(0, 12);
    return ["openclaw", cls, channel, digest].filter(Boolean).join(":");
  };

  // A turn row from one spool file's records, or null when it holds no open
  // record. interrupted: the file belongs to an earlier gateway process.
  const turnOf = (records, { interrupted, cronJobs, contentJobs }) => {
    const opens = records.filter((record) => record.t === "open");
    const open = opens[opens.length - 1];
    if (!open || !open.runId) return null;
    const end = records.find((record) => record.t === "end");
    const llm = records.filter((record) => record.t === "llm");
    const tools = records.filter((record) => record.t === "tool").map((record) => ({ name: String(record.name || "tool"), ok: record.ok !== false }));
    const verdict = classifySession({ sessionKey: open.sessionKey, trigger: open.trigger, jobId: open.jobId });
    const cls = verdict.class === open.class ? verdict.class : "unknown";
    const jobId = cls === "cron" ? verdict.jobId : "";
    const job = jobId ? cronJobs.find((entry) => String(entry?.id || "") === jobId) : null;
    const contents = mayCarryContents(cls) && contentJobs.has(jobId);
    const startedAt = Number(opens[0].at) || null;
    const endedAt = Number(end?.at) || Number(records[records.length - 1]?.at) || startedAt;
    const status = interrupted && !end ? "cancelled" : String(end?.status || "completed");
    const model = String(
      llm.map((record) => record.model).filter(Boolean).pop() ||
        records
          .filter((record) => record.t === "model")
          .map((record) => record.model)
          .filter(Boolean)
          .pop() ||
        "",
    );
    const sum = (key) => llm.reduce((total, record) => total + (Number(record[key]) || 0), 0);
    const cost = sum("costUsd");
    const usage = {
      input_tokens: sum("input"),
      output_tokens: sum("output"),
      cache_read_tokens: sum("cacheRead"),
      cache_write_tokens: sum("cacheWrite"),
      cost_usd: cost > 0 ? cost : null,
    };
    const agentId = String(open.agentId || verdict.agentId || "unknown");
    const channel = cls === "dm" || cls === "group" ? String(verdict.channel || open.channel || "") : "";
    const durationMs = Number(end?.durationMs) || (endedAt && startedAt ? endedAt - startedAt : 0);
    const reason = interrupted && !end ? "interrupted by gateway restart" : end?.reason === "stopped" ? "stopped" : "";
    const agentName = cls === "cron" ? (contentJobs.has(jobId) && job?.name ? `Cron: ${job.name}` : `Cron job ${jobId}`) : `OpenClaw agent ${agentId}`;
    const what =
      cls === "cron"
        ? agentName
        : cls === "dm"
          ? `${channelName(channel)} DM (${agentId})`
          : cls === "group"
            ? `${channelName(channel)} group (${agentId})`
            : `${kClassTitles[cls] || kClassTitles.unknown} (${agentId})`;
    const metadataLine = runSummary({
      what: cut(what, kTitleWhatMax),
      durationMs,
      status,
      reason,
      details: `${tools.length} tool call${tools.length === 1 ? "" : "s"}; started ${startedAt ? new Date(startedAt).toISOString() : "unknown"}; OpenClaw ${cls} turn of agent ${agentId}.`,
    });
    const texts = contents ? llm.map((record) => (typeof record.text === "string" ? scrub(record.text) : "")).filter(Boolean) : [];
    const cronMessage = contents ? String(job?.payload?.message || "").trim() : "";
    const agentKey = cls === "cron" ? `openclaw-cron-${jobId}` : `openclaw-agent-${agentId}`;
    return {
      source: "openclaw",
      sourceRunId: String(open.runId),
      agentKey,
      agentName,
      agentDescription: cls === "cron" ? "An OpenClaw cron job's runs, reported by AlphaClaw." : "An OpenClaw agent's turns, reported by AlphaClaw.",
      class: cls,
      contents,
      sessionLabel: labelOf(cls, channel, open.sessionKey),
      startedAt,
      endedAt,
      status,
      model,
      inputText: contents && cronMessage ? `${metadataLine}\n\n${scrub(cronMessage)}` : metadataLine,
      texts,
      answerText: texts.length ? texts[texts.length - 1] : "",
      errorText: contents && end?.error ? scrub(String(end.error)) : status === "failed" ? "The turn failed (details withheld)." : reason,
      tools,
      usage,
      evidenceComplete: contents && !interrupted && Boolean(end),
    };
  };

  // A spool directory is named <ms>-<pid>-<start ticks> for the gateway
  // process that wrote it, so it is live while that process is (a pid
  // AlphaClaw cannot judge counts as live). The start ticks tell a pid reused
  // after a container restart from the original; a <ms>-<pid> name is judged
  // by its pid alone. Only a dead process's open .jsonl files are read as
  // interrupted runs; the clock never decides it. A name without a pid falls
  // back to "the newest directory is live".
  const ownerAlive = (generation) => {
    const match = /^\d+-(\d+)(?:-(\d+))?$/.exec(generation);
    return match ? isProcessAlive(Number(match[1]), match[2] === undefined ? null : Number(match[2])) : null;
  };

  const warnedAt = new Map();
  const warnLimited = (key, line) => {
    const at = now();
    if (warnedAt.has(key) && at - warnedAt.get(key) < kWarnEveryMs) return;
    warnedAt.set(key, at);
    logger.warn?.(`[alphaclaw] agentrun-reporter ${line}`);
  };
  const reason = (error) => String(error?.code || error?.message || error).slice(0, 200);
  const endedLongAgo = (records) => {
    const last = records[records.length - 1];
    return last?.t === "end" && now() - (Number(last.at) || 0) >= kEndedSettleMs;
  };

  // Moves finished spool files (and files left by an earlier gateway process)
  // into the queue. Returns { added, files }. A directory or file it cannot
  // read or delete is logged at most once an hour and never stops the tick.
  const ingest = () => {
    let generations;
    try {
      generations = fsModule
        .readdirSync(spoolRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => (Number.parseInt(a, 10) || 0) - (Number.parseInt(b, 10) || 0) || a.localeCompare(b));
    } catch (error) {
      if (error?.code !== "ENOENT") warnLimited("spool", `capture_error op=ingest dir=${kSpoolDirName} ${reason(error)} (nothing read this tick)`);
      return { added: 0, files: 0 };
    }
    const newest = generations[generations.length - 1];
    let cronJobs = null;
    const contentJobs = getContentCronJobs();
    let added = 0;
    let files = 0;
    for (const generation of generations) {
      const dir = path.join(spoolRoot, generation);
      const alive = ownerAlive(generation);
      const interrupted = alive === null ? generation !== newest : !alive;
      let names;
      try {
        names = fsModule.readdirSync(dir).filter((name) => name.endsWith(".done") || name.endsWith(".jsonl")).sort();
      } catch (error) {
        warnLimited(`dir:${generation}`, `capture_error op=ingest dir=${generation} ${reason(error)} (skipped this tick)`);
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        if (undeletable.has(file)) continue;
        if (files >= kMaxIngestPerTick) return { added, files };
        files += 1;
        let turn = null;
        try {
          const records = readLines(file, fsModule);
          // A live gateway's open file is read only once its turn ended long
          // enough ago that its late llm_output would have come.
          if (!interrupted && name.endsWith(".jsonl") && !endedLongAgo(records)) {
            files -= 1;
            continue;
          }
          if (cronJobs === null) {
            try {
              cronJobs = readCronJobs() || [];
            } catch {
              cronJobs = [];
            }
          }
          turn = turnOf(records, { interrupted: interrupted && name.endsWith(".jsonl"), cronJobs, contentJobs });
        } catch (error) {
          // A live gateway's open file may still be written; it is read again
          // next tick and never counted toward a drop.
          if (!interrupted && name.endsWith(".jsonl")) {
            files -= 1;
            continue;
          }
          const tries = (readFailures.get(file) || 0) + 1;
          const kept = tries < kMaxIngestTries;
          if (kept) readFailures.set(file, tries);
          else readFailures.delete(file);
          logger.warn?.(
            `[alphaclaw] agentrun-reporter capture_error op=ingest file=${name} ${String(error?.message || error).slice(0, 200)} (${kept ? "kept for the next tick" : `dropped after ${tries} tries`})`,
          );
          if (kept) continue;
        }
        readFailures.delete(file);
        if (turn) {
          // A queue write that fails keeps the file for the next tick.
          try {
            // OpenClaw ends each model-fallback attempt with its own agent_end,
            // so a later attempt of a run arrives as a second file. The run is
            // reported as its first attempt; re-reading a file is a no-op.
            if (outbox.addTurn(turn)) added += 1;
            else logger.warn?.(`[alphaclaw] agentrun-reporter late_attempt op=ingest file=${name} (the run is already queued; this attempt is not reported)`);
          } catch (error) {
            logger.warn?.(`[alphaclaw] agentrun-reporter queue_error op=ingest file=${name} ${String(error?.message || error).slice(0, 200)} (kept for the next tick)`);
            continue;
          }
        }
        try {
          fsModule.rmSync(file, { force: true });
        } catch (error) {
          undeletable.add(file);
          warnLimited(`rm:${generation}`, `capture_error op=ingest file=${name} ${reason(error)} (already queued; skipped until AlphaClaw restarts)`);
        }
      }
      if (interrupted) {
        try {
          if (fsModule.readdirSync(dir).length === 0) fsModule.rmdirSync(dir);
        } catch {}
      }
    }
    return { added, files };
  };

  return { ingest, spoolRoot };
};

// Whether a queued OpenClaw row may still carry its contents: a cron job's
// row, and that job still on ALPHACLAW_AGENTRUN_CONTENT_CRON.
const contentStillAllowed = (row, contentJobs) =>
  row.class === "cron" && String(row.agent_key || "").startsWith("openclaw-cron-") && contentJobs.has(String(row.agent_key).slice("openclaw-cron-".length));

module.exports = { createOpenclawSource, contentStillAllowed, kSpoolDirName };
