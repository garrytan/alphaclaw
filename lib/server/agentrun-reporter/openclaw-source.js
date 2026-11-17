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
const { cut, eventBatches } = require("./bodies");

const kSpoolDirName = "agentrun-spool";
const kMaxIngestPerTick = 500;
const kMaxIngestTries = 5;
const kWarnEveryMs = 60 * 60 * 1000;
// A live gateway's run file whose end record is this old is read as finished
// even though the plugin never renamed it: OpenClaw sends the attempt's
// llm_output after agent_end, and some attempts send none. A file whose last
// record is that llm_output, this old, with no end record, is read as finished
// too: OpenClaw 2026.11.4 can drop agent_end ("Plugin invocation scope is
// closed") when the run's plugin scope closes before the hook is dispatched.
const kEndedSettleMs = 30_000;
const kStopReasonStatus = { error: "failed", timeout: "failed", aborted: "cancelled" };
const kTitleWhatMax = 60;
const kCronPrefix = "@cron.";
const kCronJobPrefix = "@cronjob.";
const kCronStatus = { ok: "completed", error: "failed", skipped: "cancelled" };
// A finished cron run waits this long for a turn of its own that is still
// settling, so the two are reported as one run; after that it goes alone.
const kCronFoldWaitMs = 10 * 60_000;
// A started cron run of a live gateway with no finish is let go after this
// long (OpenClaw sends no finish for a trigger check that did not fire).
const kCronPendingMaxMs = 24 * 60 * 60_000;
const kCronClockSlackMs = 1000;
const kCronNameMax = 120;
// Live runs: a run goes live (started in AgentRun while it runs) only while
// its timeout is under 50 minutes, unless AgentRun advertises
// features.sdk_runs (no one-hour window). OpenClaw's own default is 48 h.
const kLiveTimeoutMaxMs = 50 * 60_000;
const kDefaultTimeoutSeconds = 48 * 60 * 60;
// At most this many live rows open at once; past it a turn is reported when
// it ends (live_cap). Each open SDK run holds one AgentRun runner loop.
const kLiveCap = 15;
const kLiveCapLogEveryMs = 60 * 60_000;
const kCappedTtlMs = 24 * 60 * 60_000;
// A live row with no new record this long, or whose file is gone without an
// end, is completed as cancelled.
const kLiveIdleMs = 30 * 60_000;
const kAbandonedReason = "ended without a report";
// A failed attempt's run is completed this long after it ended unless a
// model-fallback attempt of the same run starts.
const kAttemptWaitMs = 30_000;
// With features.sdk_runs, a live row with no batch this long sends an empty one.
const kHeartbeatMs = 10 * 60_000;

const cronDescription = ({ agentKey }) =>
  agentKey.startsWith("openclaw-cron-oneshot-") ? "One-shot OpenClaw cron jobs of one agent, reported by AlphaClaw." : "An OpenClaw cron job's runs, reported by AlphaClaw.";
const shortJobId = (jobId) => String(jobId || "").slice(0, 8) || "unknown";
const isOneShot = (scheduleKind, job) => scheduleKind === "at" || job?.schedule?.kind === "at" || job?.deleteAfterRun === true;

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

const toolsOf = (records) => records.filter((record) => record.t === "tool").map((record) => ({ name: String(record.name || "tool"), ok: record.ok !== false }));
const runIdOf = (records) => String(records.filter((record) => record.t === "open").pop()?.runId || "");
const lastAtOf = (records) => Number(records[records.length - 1]?.at) || 0;
// The plugin marks the open record model_call_started writes as provisional;
// a run is decided once a later hook wrote one without the mark.
const isDecided = (records) => records.some((record) => record.t === "open" && !record.provisional);
const keyOf = (source, sourceRunId) => `${source}\u0000${sourceRunId}`;
const isoOf = (ms) => (ms ? new Date(ms).toISOString() : "unknown");

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
  getHiddenCronNames = () => new Set(),
  readCronJobs = () => [],
  readOpenclawConfig = () => null,
  getLive = () => false,
  getFeatures = () => ({}),
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
  // The cron job list and openclaw.json, read at most once per ingest.
  let cronJobsOfTick = null;
  let configOfTick;
  const jobs = () => {
    if (cronJobsOfTick === null) {
      try {
        cronJobsOfTick = readCronJobs() || [];
      } catch {
        cronJobsOfTick = [];
      }
    }
    return cronJobsOfTick;
  };
  const openclawConfig = () => {
    if (configOfTick === undefined) {
      try {
        configOfTick = readOpenclawConfig() || null;
      } catch {
        configOfTick = null;
      }
    }
    return configOfTick;
  };
  const labelOf = (cls, channel, sessionKey) => {
    if (!salt) salt = loadSalt({ rootDir, fsModule });
    const digest = crypto.createHmac("sha256", salt).update(String(sessionKey || "")).digest("hex").slice(0, 12);
    return ["openclaw", cls, channel, digest].filter(Boolean).join(":");
  };

  // A cron job's name as AgentRun shows it, or "" when it is hidden
  // (ALPHACLAW_AGENTRUN_HIDE_CRON_NAMES lists its id, or "*") or unknown.
  const nameHidden = (jobId) => {
    const hidden = getHiddenCronNames();
    return hidden.has("*") || hidden.has(String(jobId));
  };
  const cronJobName = (jobId, name) => {
    if (nameHidden(jobId)) return "";
    return cut(String(scrub(String(name || ""))).replace(/\s+/g, " ").trim(), kCronNameMax);
  };
  const cronAgentOf = ({ jobId, agentId, oneShot, name }) => {
    const shown = cronJobName(jobId, name);
    return oneShot
      ? { agentKey: `openclaw-cron-oneshot-${agentId}`, agentName: `One-shot jobs (${agentId})`, what: shown ? `One-shot: ${shown}` : `One-shot job ${shortJobId(jobId)}` }
      : { agentKey: `openclaw-cron-${jobId}`, agentName: shown ? `Cron: ${shown}` : `Cron job ${shortJobId(jobId)}`, what: shown ? `Cron: ${shown}` : `Cron job ${shortJobId(jobId)}` };
  };

  // A turn row from one spool file's records, or null when it holds no open
  // record. interrupted: the file belongs to an earlier gateway process.
  // prior: the row of the same run whose earlier attempts this one follows
  // (a model-fallback or restart-resumed attempt, or a live row); its tools,
  // usage and text come first and its start is the run's.
  const turnOf = (records, { interrupted, cronJobs, contentJobs, prior = null }) => {
    const opens = records.filter((record) => record.t === "open");
    const open = opens[opens.length - 1];
    if (!open || !open.runId) return null;
    const end = records.find((record) => record.t === "end");
    const llm = records.filter((record) => record.t === "llm");
    const tools = [...(prior?.tools || []), ...toolsOf(records)];
    const verdict = classifySession({ sessionKey: open.sessionKey, trigger: open.trigger, jobId: open.jobId });
    const cls = verdict.class === open.class ? verdict.class : "unknown";
    const jobId = cls === "cron" ? verdict.jobId : "";
    const job = jobId ? cronJobs.find((entry) => String(entry?.id || "") === jobId) : null;
    const contents = mayCarryContents(cls) && contentJobs.has(jobId);
    const attemptStartedAt = Number(opens[0].at) || null;
    const startedAt = Number(prior?.startedAt) || attemptStartedAt;
    const endedAt = Number(end?.at) || Number(records[records.length - 1]?.at) || attemptStartedAt;
    // No end record in a live gateway's file: OpenClaw dropped agent_end, and
    // the attempt's last llm_output says how it stopped.
    const lastStop = String(llm[llm.length - 1]?.stopReason || "");
    const endLost = !interrupted && !end;
    const status = interrupted && !end ? "cancelled" : end ? String(end.status || "completed") : Object.hasOwn(kStopReasonStatus, lastStop) ? kStopReasonStatus[lastStop] : "completed";
    const model = String(
      llm.map((record) => record.model).filter(Boolean).pop() ||
        records
          .filter((record) => record.t === "model")
          .map((record) => record.model)
          .filter(Boolean)
          .pop() ||
        prior?.model ||
        "",
    );
    const sum = (key, priorKey) => llm.reduce((total, record) => total + (Number(record[key]) || 0), Number(prior?.usage?.[priorKey]) || 0);
    const cost = sum("costUsd", "cost_usd");
    const usage = {
      input_tokens: sum("input", "input_tokens"),
      output_tokens: sum("output", "output_tokens"),
      cache_read_tokens: sum("cacheRead", "cache_read_tokens"),
      cache_write_tokens: sum("cacheWrite", "cache_write_tokens"),
      cost_usd: cost > 0 ? cost : null,
    };
    const agentId = String(open.agentId || verdict.agentId || "unknown");
    const channel = cls === "dm" || cls === "group" ? String(verdict.channel || open.channel || "") : "";
    const durationMs = (startedAt === attemptStartedAt && Number(end?.durationMs)) || (endedAt && startedAt ? endedAt - startedAt : 0);
    const reason = interrupted && !end ? "interrupted by gateway restart" : endLost ? "end not recorded" : end?.reason === "stopped" ? "stopped" : "";
    const cronAgent = cls === "cron" ? cronAgentOf({ jobId, agentId, oneShot: isOneShot("", job), name: job?.name }) : null;
    const agentName = cronAgent ? cronAgent.agentName : `OpenClaw agent ${agentId}`;
    const parent = cls === "subagent" && open.parentSessionKey ? classifySession({ sessionKey: open.parentSessionKey }) : null;
    const what =
      cls === "cron"
        ? cronAgent.what
        : cls === "dm"
          ? `${channelName(channel)} DM (${agentId})`
          : cls === "group"
            ? `${channelName(channel)} group (${agentId})`
            : `${kClassTitles[cls] || kClassTitles.unknown} (${agentId})`;
    const title = cut(what, kTitleWhatMax);
    const metadataLine = runSummary({
      what: title,
      durationMs,
      status,
      reason,
      details: `${tools.length} tool call${tools.length === 1 ? "" : "s"}; started ${startedAt ? new Date(startedAt).toISOString() : "unknown"}; OpenClaw ${cls} turn of agent ${agentId}${parent ? `; spawned by ${labelOf(parent.class, parent.channel, open.parentSessionKey)}` : ""}.`,
    });
    const texts = contents ? [...(prior?.texts || []), ...llm.map((record) => (typeof record.text === "string" ? scrub(record.text) : "")).filter(Boolean)] : [];
    const cronMessage = contents ? String(job?.payload?.message || "").trim() : "";
    const agentKey = cronAgent ? cronAgent.agentKey : `openclaw-agent-${agentId}`;
    return {
      source: "openclaw",
      title,
      sourceRunId: String(open.runId),
      jobId,
      agentId,
      agentKey,
      agentName,
      agentDescription: cronAgent ? cronDescription(cronAgent) : "An OpenClaw agent's turns, reported by AlphaClaw.",
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
      evidenceComplete: (prior ? prior.evidenceComplete : true) && contents && !interrupted && Boolean(end),
    };
  };

  // A cron run's start and finish records. runAtMs is the same on both.
  const cronRunOf = (records) => {
    const start = records.find((record) => record.t === "cron-start") || null;
    const end = records.find((record) => record.t === "cron-end") || null;
    const info = { ...(start || {}), ...(end || {}) };
    return { start, end, info, jobId: String(info.jobId || ""), runAtMs: Number(info.runAtMs) || Number(info.at) || 0 };
  };

  // Whether a turn's records belong to a cron run: an isolated job's turn
  // (class cron, the same job, in the session the finish names) started
  // inside the run; a turn in another session only when the job woke it now,
  // it is a heartbeat turn of the job's agent, and it started inside the run
  // (or, before the finish, within kCronFoldWaitMs of its start).
  const turnBelongsTo = (run, records) => {
    const opens = records.filter((record) => record.t === "open");
    const open = opens[opens.length - 1];
    if (!open || !run.jobId) return false;
    const startedAt = Number(opens[0].at) || 0;
    const { info, end } = run;
    const verdict = classifySession({ sessionKey: open.sessionKey, trigger: open.trigger, jobId: open.jobId });
    const isolated = verdict.class === "cron" && open.class === "cron";
    const until = end ? run.runAtMs + (Number(info.durationMs) || 0) + kCronClockSlackMs : isolated ? Infinity : run.runAtMs + kCronFoldWaitMs;
    if (startedAt < run.runAtMs - kCronClockSlackMs || startedAt > until) return false;
    if (isolated) return verdict.jobId === run.jobId && (!info.sessionKey || info.sessionKey === open.sessionKey);
    if (info.wakeMode !== "now" || String(open.trigger || "") !== "heartbeat") return false;
    return !info.agentId || !open.agentId || String(info.agentId) === String(open.agentId);
  };

  // One queue row for a cron run, with the turns folded into it. A folded
  // turn in another session keeps its class, so it carries no contents; a
  // script run carries none either.
  const cronRowOf = (run, turns, { interrupted, cronJobs, contentJobs }) => {
    const { info, end, jobId, runAtMs } = run;
    const job = cronJobs.find((entry) => String(entry?.id || "") === jobId) || null;
    const lead = turns[0] || null;
    const cls = lead ? lead.class : "cron";
    const isolated = lead ? turns.every((turn) => turn.class === "cron") : String(info.sessionTarget || "") === "isolated";
    const contents = mayCarryContents(cls) && isolated && info.payloadKind !== "command" && contentJobs.has(jobId);
    const agentId = String(info.agentId || job?.agentId || lead?.agentId || "main");
    const cronAgent = cronAgentOf({ jobId, agentId, oneShot: isOneShot(info.scheduleKind, job), name: job?.name || info.name });
    const endStatus = String(end?.status || "");
    const status = !end ? "cancelled" : Object.hasOwn(kCronStatus, endStatus) ? kCronStatus[endStatus] : lead?.status || "completed";
    const reason = !end ? (interrupted ? "interrupted by gateway restart" : "") : endStatus === "skipped" ? "skipped" : "";
    const durationMs = end ? Number(end.durationMs) || 0 : 0;
    const startedAt = runAtMs || null;
    const endedAt = end ? runAtMs + durationMs : Math.max(runAtMs, ...turns.map((turn) => Number(turn.endedAt) || 0)) || startedAt;
    const tools = turns.flatMap((turn) => turn.tools);
    const sum = (key) => turns.reduce((total, turn) => total + (Number(turn.usage?.[key]) || 0), 0);
    const cost = sum("cost_usd");
    const usage = turns.length
      ? { input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), cache_read_tokens: sum("cache_read_tokens"), cache_write_tokens: sum("cache_write_tokens"), cost_usd: cost > 0 ? cost : null }
      : null;
    const texts = contents ? turns.flatMap((turn) => turn.texts) : [];
    const kind = info.payloadKind === "command" ? "script run" : "run";
    const title = cut(cronAgent.what, kTitleWhatMax);
    const metadataLine = runSummary({
      what: title,
      durationMs,
      status,
      reason,
      details: `${tools.length} tool call${tools.length === 1 ? "" : "s"}; started ${startedAt ? new Date(startedAt).toISOString() : "unknown"}; OpenClaw cron ${kind} of job ${shortJobId(jobId)}${lead ? `, with a ${cls} turn of agent ${agentId}` : ""}.`,
    });
    const cronMessage = contents ? String(job?.payload?.message || "").trim() : "";
    return {
      source: "openclaw-cron",
      title,
      sourceRunId: `${jobId}:${runAtMs}`,
      jobId,
      agentKey: cronAgent.agentKey,
      agentName: cronAgent.agentName,
      agentDescription: cronDescription(cronAgent),
      class: cls,
      contents,
      sessionLabel: lead ? lead.sessionLabel : labelOf("cron", "", `cron:${jobId}`),
      startedAt,
      endedAt,
      status,
      model: String(end?.model || turns.map((turn) => turn.model).filter(Boolean).pop() || ""),
      inputText: contents && cronMessage ? `${metadataLine}\n\n${scrub(cronMessage)}` : metadataLine,
      texts,
      answerText: texts.length ? texts[texts.length - 1] : "",
      errorText: status === "failed" ? (contents && lead?.errorText) || "The cron run failed (details withheld)." : reason,
      tools,
      usage,
      evidenceComplete: contents && Boolean(end) && turns.length > 0 && turns.every((turn) => turn.evidenceComplete),
    };
  };

  // Live runs. A live row is started in AgentRun while its run goes on: its
  // start carries the title and start time only (never a status or
  // contents), each tick's new tools go out as one more stored, numbered
  // batch (an earlier batch is never rewritten, so a retry sends the same
  // bytes), and its end stores the completion. A listed cron job's message
  // and text go out only after the end.
  const capped = new Map();
  let cappedUnlogged = 0;
  let capLoggedAt = -Infinity;

  const cronMessageOf = (jobId) => {
    const job = jobs().find((entry) => String(entry?.id || "") === String(jobId || ""));
    const message = String(job?.payload?.message || "").trim();
    return message ? scrub(message) : "";
  };

  // A run's timeout: its cron job's payload.timeoutSeconds, else
  // agents.defaults.timeoutSeconds, else OpenClaw's 48 h.
  const timeoutMsOf = (jobId) => {
    const job = jobId ? jobs().find((entry) => String(entry?.id || "") === jobId) : null;
    const own = Number(job?.payload?.timeoutSeconds);
    if (own > 0) return own * 1000;
    const configured = Number(openclawConfig()?.agents?.defaults?.timeoutSeconds);
    return (configured > 0 ? configured : kDefaultTimeoutSeconds) * 1000;
  };
  const mayGoLive = (jobId) => getLive() && (Boolean(getFeatures()?.sdkRuns) || timeoutMsOf(jobId) < kLiveTimeoutMaxMs);

  // Past kLiveCap open live rows a new run waits and is reported when it
  // ends; it does not go live later.
  const admitLive = (key) => {
    if (capped.has(key)) return false;
    if (outbox.countLive() < kLiveCap) return true;
    capped.set(key, now());
    cappedUnlogged += 1;
    if (now() - capLoggedAt >= kLiveCapLogEveryMs) {
      capLoggedAt = now();
      logger.warn?.(
        `[alphaclaw] agentrun-reporter live_cap op=ingest count=${cappedUnlogged} open=${kLiveCap} (these runs are reported when they end) fix=nothing to do if it is rare; if it repeats, check AgentRun's CPU and store latency on the box before raising the cap`,
      );
      cappedUnlogged = 0;
    }
    return false;
  };

  const priorOf = (row) => ({
    tools: JSON.parse(row.tools_json || "[]"),
    usage: JSON.parse(row.usage_json || "null"),
    texts: JSON.parse(row.texts_json || "[]"),
    startedAt: Number(row.started_at) || null,
    model: row.model,
    evidenceComplete: row.evidence_complete === 1,
  });

  const rowFieldsOf = (turn) => ({
    contents: turn.contents ? 1 : 0,
    session_label: turn.sessionLabel || "",
    ended_at: turn.endedAt ?? null,
    status: turn.status,
    model: turn.model || "",
    input_text: turn.inputText || "",
    texts_json: JSON.stringify(turn.texts || []),
    answer_text: turn.answerText || "",
    error_text: turn.errorText || "",
    tools_json: JSON.stringify(turn.tools || []),
    usage_json: JSON.stringify(turn.usage ?? null),
    evidence_complete: turn.evidenceComplete ? 1 : 0,
  });

  // The queue row a live run starts with: its title, "Started <ISO>", no
  // status and no contents.
  const liveRowOf = (turn, lastRecordAt) => ({
    ...turn,
    status: "running",
    inputText: `${turn.title}\nStarted ${isoOf(turn.startedAt)}`,
    texts: [],
    answerText: "",
    errorText: "",
    tools: [],
    usage: null,
    evidenceComplete: turn.contents,
    live: true,
    ended: false,
    lastRecordAt,
  });

  // Batches appended after a row's stored ones. heartbeat: one empty batch.
  const appendedBatches = (row, { tools = [], texts = [], heartbeat = false } = {}) => {
    const batches = JSON.parse(row.batches_json || "[]");
    const firstTool = Number(row.tools_batched) || 0;
    const more = heartbeat
      ? [{ sequence: batches.length + 1, events: [] }]
      : eventBatches({ rowId: `${row.source}-${row.id}`, sessionLabel: batches.length ? "" : row.session_label, texts, tools, firstTool, firstSequence: batches.length + 1 });
    if (!more.length) return {};
    return { batches_json: JSON.stringify([...batches, ...more]), tools_batched: firstTool + tools.length, last_batch_at: now() };
  };

  // A running run's newest records: a live row gets its new tools as a batch,
  // or, with features.sdk_runs and no batch for kHeartbeatMs, an empty one.
  const follow = (row, tools, lastRecordAt, extra = {}) => {
    const fields = { ...extra, last_record_at: Math.max(Number(row.last_record_at) || 0, lastRecordAt) };
    if (row.live === 1) {
      const fresh = tools.slice(Number(row.tools_batched) || 0);
      if (fresh.length) Object.assign(fields, appendedBatches(row, { tools: fresh }));
      else if (getFeatures()?.sdkRuns && now() - (Number(row.last_batch_at) || Number(row.created_at) || 0) >= kHeartbeatMs) Object.assign(fields, appendedBatches(row, { heartbeat: true }));
    }
    outbox.update(row.id, fields);
  };

  // A row's run ended. A live row's remaining tools, and for a listed cron
  // job its message and the run's text, go out as further batches now.
  const endRow = (row, fields = {}) => {
    const next = { ...row, ...fields };
    const update = { ...fields, ended: 1, attempt_ended_at: 0 };
    if (row.live === 1) {
      const message = next.contents === 1 ? cronMessageOf(jobIdOfRow(next)) : "";
      const texts = next.contents === 1 ? [message ? `Job message: ${message}` : "", ...JSON.parse(next.texts_json || "[]")].filter(Boolean) : [];
      Object.assign(update, appendedBatches(row, { tools: JSON.parse(next.tools_json || "[]").slice(Number(row.tools_batched) || 0), texts }));
    }
    outbox.update(row.id, update);
  };

  // An attempt of an open run ended (turn already carries the run's earlier
  // attempts). A completed attempt ends the run; a failed or stopped one waits
  // kAttemptWaitMs for a model-fallback or restart-resumed attempt.
  const settleAttempt = (row, turn) => {
    const fields = rowFieldsOf(turn);
    if (turn.status === "completed") return endRow(row, fields);
    outbox.update(row.id, { ...fields, attempt_ended_at: now(), ...(row.live === 1 ? appendedBatches(row, { tools: turn.tools.slice(Number(row.tools_batched) || 0) }) : {}) });
  };

  const abandon = (row) => {
    const startedAt = Number(row.started_at) || 0;
    const endedAt = Number(row.last_record_at) || now();
    const count = Math.max(JSON.parse(row.tools_json || "[]").length, Number(row.tools_batched) || 0);
    endRow(row, {
      status: "cancelled",
      ended_at: endedAt,
      error_text: kAbandonedReason,
      evidence_complete: 0,
      input_text: runSummary({
        what: String(row.input_text || "").split("\n")[0].split(" · ")[0],
        durationMs: startedAt ? endedAt - startedAt : 0,
        status: "cancelled",
        reason: kAbandonedReason,
        details: `${count} tool call${count === 1 ? "" : "s"}; started ${isoOf(startedAt)}; no end was recorded.`,
      }),
    });
  };

  // An agent turn still running in a live gateway: its open row follows it,
  // or it goes live once its class is decided and the gate and cap allow.
  const followTurn = (records) => {
    const turn = turnOf(records, { interrupted: false, cronJobs: jobs(), contentJobs: getContentCronJobs() });
    if (!turn) return;
    const existing = outbox.rowOf("openclaw", turn.sourceRunId);
    if (existing) {
      if (existing.state === "queued" && existing.ended === 0) follow(existing, [...JSON.parse(existing.tools_json || "[]"), ...turn.tools], lastAtOf(records), { attempt_ended_at: 0 });
      return;
    }
    if (!isDecided(records) || !mayGoLive(turn.jobId) || !admitLive(keyOf("openclaw", turn.sourceRunId))) return;
    outbox.addTurn(liveRowOf(turn, lastAtOf(records)));
    const row = outbox.rowOf("openclaw", turn.sourceRunId);
    if (row) follow(row, turn.tools, lastAtOf(records));
  };

  // A cron run still going in a live gateway: its live row follows the turns
  // folded into it, or the run goes live from its start record.
  const followCron = (run, matches) => {
    const sourceRunId = `${run.jobId}:${run.runAtMs}`;
    const turns = matches.map((match) => turnOf(match.records, { interrupted: false, cronJobs: jobs(), contentJobs: getContentCronJobs() })).filter(Boolean);
    const lastRecordAt = Math.max(Number((run.end || run.start)?.at) || 0, ...matches.map((match) => lastAtOf(match.records)));
    const existing = outbox.rowOf("openclaw-cron", sourceRunId);
    if (existing) {
      if (existing.state === "queued" && existing.ended === 0) follow(existing, turns.flatMap((turn) => turn.tools), lastRecordAt);
      return;
    }
    if (!mayGoLive(run.jobId) || !admitLive(keyOf("openclaw-cron", sourceRunId))) return;
    const row = cronRowOf(run, turns, { interrupted: false, cronJobs: jobs(), contentJobs: getContentCronJobs() });
    outbox.addTurn(liveRowOf(row, lastRecordAt));
    const added = outbox.rowOf("openclaw-cron", sourceRunId);
    if (added) follow(added, row.tools, lastRecordAt);
  };

  // After a pass that read every file: an open row whose failed attempt had
  // no successor for kAttemptWaitMs ends with that attempt's outcome; one
  // with no record for kLiveIdleMs, or whose file is gone without an end
  // (OpenClaw fires no agent_end for some attempts, and the plugin forgets a
  // run idle for 6 h), is completed as cancelled.
  const sweepOpen = (seen) => {
    for (const row of outbox.openRows()) {
      if (seen.has(keyOf(row.source, row.source_run_id))) {
        if (now() - (Number(row.last_record_at) || 0) >= kLiveIdleMs) abandon(row);
        continue;
      }
      if (Number(row.attempt_ended_at) > 0) {
        if (now() - row.attempt_ended_at >= kAttemptWaitMs) endRow(row);
        continue;
      }
      abandon(row);
    }
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
    return (last?.t === "end" || last?.t === "llm") && now() - (Number(last.at) || 0) >= kEndedSettleMs;
  };

  // Moves finished spool files (and files left by an earlier gateway process)
  // into the queue, and follows the runs still going in a live gateway's
  // directory (live rows). Returns { added, files }. A directory or file it
  // cannot read or delete is logged at most once an hour and never stops the
  // tick.
  const ingest = () => {
    let generations;
    try {
      generations = fsModule
        .readdirSync(spoolRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => (Number.parseInt(a, 10) || 0) - (Number.parseInt(b, 10) || 0) || a.localeCompare(b));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        warnLimited("spool", `capture_error op=ingest dir=${kSpoolDirName} ${reason(error)} (nothing read this tick)`);
        return { added: 0, files: 0 };
      }
      generations = [];
    }
    const newest = generations[generations.length - 1];
    cronJobsOfTick = null;
    configOfTick = undefined;
    for (const [key, at] of capped) if (now() - at > kCappedTtlMs) capped.delete(key);
    const contentJobs = getContentCronJobs();
    let added = 0;
    let files = 0;
    // Open rows whose run this pass saw still going. Rows not seen are ended
    // only after a pass that read every file (complete).
    const seen = new Set();
    let complete = true;
    // A file that cannot be read or turned into a row is kept for
    // kMaxIngestTries ticks, then dropped. Returns whether it is kept.
    const failed = (file, name, error) => {
      const tries = (readFailures.get(file) || 0) + 1;
      const kept = tries < kMaxIngestTries;
      if (kept) readFailures.set(file, tries);
      else readFailures.delete(file);
      complete = false;
      logger.warn?.(
        `[alphaclaw] agentrun-reporter capture_error op=ingest file=${name} ${String(error?.message || error).slice(0, 200)} (${kept ? "kept for the next tick" : `dropped after ${tries} tries`})`,
      );
      return kept;
    };
    const remove = (file, name, generation) => {
      readFailures.delete(file);
      try {
        fsModule.rmSync(file, { force: true });
      } catch (error) {
        undeletable.add(file);
        warnLimited(`rm:${generation}`, `capture_error op=ingest file=${name} ${reason(error)} (already queued; skipped until AlphaClaw restarts)`);
      }
    };
    const openOf = (source, sourceRunId) => {
      const row = sourceRunId ? outbox.rowOf(source, sourceRunId) : null;
      return row && row.state === "queued" && row.ended === 0 ? row : null;
    };
    // A queue write that fails keeps the file for the next tick. An open row
    // of the same run (live, or waiting for a fallback attempt) takes this
    // attempt or end. OpenClaw ends each model-fallback attempt with its own
    // agent_end, so a later attempt of a run arrives as a second file: with
    // live runs on, a failed attempt waits kAttemptWaitMs for it; otherwise
    // (or once the run ended) the later attempt is not reported, and
    // re-reading a file is a no-op.
    const queue = (row, name, open = null) => {
      try {
        if (open) {
          if (open.source === "openclaw") settleAttempt(open, row);
          else endRow(open, rowFieldsOf(row));
          return true;
        }
        const waits = getLive() && row.source === "openclaw" && row.status !== "completed";
        if (outbox.addTurn(waits ? { ...row, ended: false, attemptEndedAt: now() } : row)) added += 1;
        else logger.warn?.(`[alphaclaw] agentrun-reporter late_attempt op=ingest file=${name} (the run is already queued; this attempt is not reported)`);
        return true;
      } catch (error) {
        complete = false;
        logger.warn?.(`[alphaclaw] agentrun-reporter queue_error op=ingest file=${name} ${String(error?.message || error).slice(0, 200)} (kept for the next tick)`);
        return false;
      }
    };
    // Following a live run never stops the tick.
    const guard = (generation, step) => {
      try {
        step();
      } catch (error) {
        complete = false;
        warnLimited(`live:${generation}`, `capture_error op=live dir=${generation} ${reason(error)} (tried again next tick)`);
      }
    };
    // Every record of a file, or null when it is not read this tick (a live
    // gateway's open file may still be written; it is never counted toward
    // a drop) or was dropped.
    const load = (file, name, interrupted, generation) => {
      try {
        return readLines(file, fsModule);
      } catch (error) {
        complete = false;
        if (!interrupted && name.endsWith(".jsonl")) return null;
        if (!failed(file, name, error)) remove(file, name, generation);
        return null;
      }
    };
    // Returns false when it stopped at kMaxIngestPerTick.
    const walk = () => {
      for (const generation of generations) {
        const dir = path.join(spoolRoot, generation);
        const alive = ownerAlive(generation);
        const interrupted = alive === null ? generation !== newest : !alive;
        let names;
        try {
          names = fsModule.readdirSync(dir).filter((name) => name.endsWith(".done") || name.endsWith(".jsonl")).sort();
        } catch (error) {
          complete = false;
          warnLimited(`dir:${generation}`, `capture_error op=ingest dir=${generation} ${reason(error)} (skipped this tick)`);
          continue;
        }
        const readable = names.filter((name) => !undeletable.has(path.join(dir, name)));

        // A removed recurring job's agent is archived once its queued runs are sent.
        for (const name of readable.filter((entry) => entry.startsWith(kCronJobPrefix))) {
          const file = path.join(dir, name);
          const records = load(file, name, interrupted, generation);
          if (!records) continue;
          const removed = records.find((record) => record.t === "cron-removed");
          try {
            if (removed?.jobId && removed.scheduleKind !== "at") outbox.requestArchive(`openclaw-cron-${removed.jobId}`);
          } catch (error) {
            if (failed(file, name, error)) continue;
          }
          remove(file, name, generation);
        }

        // Agent turns, oldest start first, so a run's attempts are read in
        // order. A live gateway's open file is read as finished only once its
        // turn ended long enough ago that its late llm_output would have come.
        const turnFiles = [];
        for (const name of readable.filter((entry) => !entry.startsWith("@"))) {
          const file = path.join(dir, name);
          const records = load(file, name, interrupted, generation);
          if (!records) continue;
          const openFile = interrupted && name.endsWith(".jsonl");
          turnFiles.push({ name, file, records, interrupted: openFile, settled: interrupted || name.endsWith(".done") || endedLongAgo(records) });
        }
        turnFiles.sort((a, b) => (Number(a.records[0]?.at) || 0) - (Number(b.records[0]?.at) || 0) || a.name.localeCompare(b.name));

        // Cron runs, each with the turns it ran folded in.
        const cronFiles = [];
        for (const name of readable.filter((entry) => entry.startsWith(kCronPrefix))) {
          const file = path.join(dir, name);
          const records = load(file, name, interrupted, generation);
          if (!records) continue;
          const run = cronRunOf(records);
          if (run.jobId) cronFiles.push({ name, file, run });
          else remove(file, name, generation);
        }
        const latestStart = new Map();
        for (const { run } of cronFiles) if (run.runAtMs > (latestStart.get(run.jobId) || 0)) latestStart.set(run.jobId, run.runAtMs);
        const waiting = [];
        const consumed = new Set();
        const matchesOf = (run) => turnFiles.filter((turnFile) => !consumed.has(turnFile.file) && turnBelongsTo(run, turnFile.records));
        const stillGoing = (run) => {
          seen.add(keyOf("openclaw-cron", `${run.jobId}:${run.runAtMs}`));
          waiting.push(run);
          guard(generation, () => followCron(run, matchesOf(run)));
        };
        for (const { name, file, run } of cronFiles) {
          if (!run.end) {
            // A start with a later start of the same job never got its finish.
            const superseded = run.runAtMs < latestStart.get(run.jobId);
            if (superseded || (!interrupted && now() - (Number(run.start?.at) || 0) >= kCronPendingMaxMs)) {
              remove(file, name, generation);
              continue;
            }
            if (!interrupted) {
              stillGoing(run);
              continue;
            }
          }
          const matches = matchesOf(run);
          if (matches.some((match) => !match.settled) && now() - (Number((run.end || run.start)?.at) || 0) < kCronFoldWaitMs) {
            stillGoing(run);
            continue;
          }
          if (files >= kMaxIngestPerTick) return false;
          files += 1;
          const folded = matches.filter((match) => match.settled);
          let row;
          let open;
          try {
            open = openOf("openclaw-cron", `${run.jobId}:${run.runAtMs}`);
            const turns = folded.map((match) => turnOf(match.records, { interrupted: match.interrupted, cronJobs: jobs(), contentJobs })).filter(Boolean);
            row = cronRowOf(run, turns, { interrupted, cronJobs: jobs(), contentJobs });
          } catch (error) {
            if (!failed(file, name, error)) remove(file, name, generation);
            continue;
          }
          if (!queue(row, name, open)) continue;
          for (const match of folded) {
            consumed.add(match.file);
            remove(match.file, match.name, generation);
          }
          remove(file, name, generation);
        }

        // Turns no cron run took. One that a cron run still in progress will
        // take waits for it; one still running in a live gateway is followed.
        for (const turnFile of turnFiles) {
          if (consumed.has(turnFile.file)) continue;
          if (!turnFile.settled) {
            const runId = runIdOf(turnFile.records);
            if (runId) seen.add(keyOf("openclaw", runId));
            if (!interrupted && !waiting.some((run) => turnBelongsTo(run, turnFile.records))) guard(generation, () => followTurn(turnFile.records));
            continue;
          }
          if (waiting.some((run) => turnBelongsTo(run, turnFile.records))) continue;
          if (files >= kMaxIngestPerTick) return false;
          files += 1;
          let turn;
          let open;
          try {
            open = openOf("openclaw", runIdOf(turnFile.records));
            turn = turnOf(turnFile.records, { interrupted: turnFile.interrupted, cronJobs: jobs(), contentJobs, prior: open && priorOf(open) });
          } catch (error) {
            if (!failed(turnFile.file, turnFile.name, error)) remove(turnFile.file, turnFile.name, generation);
            continue;
          }
          if (turn && !queue(turn, turnFile.name, open)) continue;
          remove(turnFile.file, turnFile.name, generation);
        }
        if (interrupted) {
          try {
            if (fsModule.readdirSync(dir).length === 0) fsModule.rmdirSync(dir);
          } catch {}
        }
      }
      return true;
    };
    if (walk() && complete) guard("sweep", () => sweepOpen(seen));
    return { added, files };
  };

  // The agent name sent with a row: a recurring cron job's agent is named
  // from the job list and hide list current when each run is sent, so a
  // rename or a hide updates the agent once.
  const agentNameOf = (row, jobsNow = []) => {
    const key = String(row.agent_key || "");
    if (!key.startsWith("openclaw-cron-") || key.startsWith("openclaw-cron-oneshot-")) return row.agent_name;
    const jobId = jobIdOfRow(row);
    const job = jobsNow.find((entry) => String(entry?.id || "") === jobId);
    if (job) return cronAgentOf({ jobId, agentId: "", oneShot: false, name: job.name }).agentName;
    return nameHidden(jobId) ? `Cron job ${shortJobId(jobId)}` : row.agent_name;
  };

  return { ingest, spoolRoot, agentNameOf };
};

// Whether a queued OpenClaw row may still carry its contents: a cron job's
// row, and that job still on ALPHACLAW_AGENTRUN_CONTENT_CRON.
const jobIdOfRow = (row) => {
  const key = String(row.agent_key || "");
  return String(row.job_id || "") || (key.startsWith("openclaw-cron-") && !key.startsWith("openclaw-cron-oneshot-") ? key.slice("openclaw-cron-".length) : "");
};
const contentStillAllowed = (row, contentJobs) => row.class === "cron" && Boolean(jobIdOfRow(row)) && contentJobs.has(jobIdOfRow(row));

module.exports = { createOpenclawSource, contentStillAllowed, kSpoolDirName };
