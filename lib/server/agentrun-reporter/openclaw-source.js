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
    const metadataLine = runSummary({
      what: cut(what, kTitleWhatMax),
      durationMs,
      status,
      reason,
      details: `${tools.length} tool call${tools.length === 1 ? "" : "s"}; started ${startedAt ? new Date(startedAt).toISOString() : "unknown"}; OpenClaw ${cls} turn of agent ${agentId}${parent ? `; spawned by ${labelOf(parent.class, parent.channel, open.parentSessionKey)}` : ""}.`,
    });
    const texts = contents ? llm.map((record) => (typeof record.text === "string" ? scrub(record.text) : "")).filter(Boolean) : [];
    const cronMessage = contents ? String(job?.payload?.message || "").trim() : "";
    const agentKey = cronAgent ? cronAgent.agentKey : `openclaw-agent-${agentId}`;
    return {
      source: "openclaw",
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
      evidenceComplete: contents && !interrupted && Boolean(end),
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
    const metadataLine = runSummary({
      what: cut(cronAgent.what, kTitleWhatMax),
      durationMs,
      status,
      reason,
      details: `${tools.length} tool call${tools.length === 1 ? "" : "s"}; started ${startedAt ? new Date(startedAt).toISOString() : "unknown"}; OpenClaw cron ${kind} of job ${shortJobId(jobId)}${lead ? `, with a ${cls} turn of agent ${agentId}` : ""}.`,
    });
    const cronMessage = contents ? String(job?.payload?.message || "").trim() : "";
    return {
      source: "openclaw-cron",
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
    const jobs = () => {
      if (cronJobs === null) {
        try {
          cronJobs = readCronJobs() || [];
        } catch {
          cronJobs = [];
        }
      }
      return cronJobs;
    };
    const contentJobs = getContentCronJobs();
    let added = 0;
    let files = 0;
    // A file that cannot be read or turned into a row is kept for
    // kMaxIngestTries ticks, then dropped. Returns whether it is kept.
    const failed = (file, name, error) => {
      const tries = (readFailures.get(file) || 0) + 1;
      const kept = tries < kMaxIngestTries;
      if (kept) readFailures.set(file, tries);
      else readFailures.delete(file);
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
    // A queue write that fails keeps the file for the next tick.
    const queue = (row, name) => {
      try {
        // OpenClaw ends each model-fallback attempt with its own agent_end,
        // so a later attempt of a run arrives as a second file. The run is
        // reported as its first attempt; re-reading a file is a no-op.
        if (outbox.addTurn(row)) added += 1;
        else logger.warn?.(`[alphaclaw] agentrun-reporter late_attempt op=ingest file=${name} (the run is already queued; this attempt is not reported)`);
        return true;
      } catch (error) {
        logger.warn?.(`[alphaclaw] agentrun-reporter queue_error op=ingest file=${name} ${String(error?.message || error).slice(0, 200)} (kept for the next tick)`);
        return false;
      }
    };
    // Every record of a file, or null when it is not read this tick (a live
    // gateway's open file may still be written; it is never counted toward
    // a drop) or was dropped.
    const load = (file, name, interrupted, generation) => {
      try {
        return readLines(file, fsModule);
      } catch (error) {
        if (!interrupted && name.endsWith(".jsonl")) return null;
        if (!failed(file, name, error)) remove(file, name, generation);
        return null;
      }
    };
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

      // Agent turns. A live gateway's open file is read only once its turn
      // ended long enough ago that its late llm_output would have come.
      const turnFiles = [];
      for (const name of readable.filter((entry) => !entry.startsWith("@"))) {
        const file = path.join(dir, name);
        const records = load(file, name, interrupted, generation);
        if (!records) continue;
        const openFile = interrupted && name.endsWith(".jsonl");
        turnFiles.push({ name, file, records, interrupted: openFile, settled: interrupted || name.endsWith(".done") || endedLongAgo(records) });
      }

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
      for (const { name, file, run } of cronFiles) {
        if (!run.end) {
          // A start with a later start of the same job never got its finish.
          const superseded = run.runAtMs < latestStart.get(run.jobId);
          if (superseded || (!interrupted && now() - (Number(run.start?.at) || 0) >= kCronPendingMaxMs)) {
            remove(file, name, generation);
            continue;
          }
          if (!interrupted) {
            waiting.push(run);
            continue;
          }
        }
        const matches = turnFiles.filter((turnFile) => !consumed.has(turnFile.file) && turnBelongsTo(run, turnFile.records));
        if (matches.some((match) => !match.settled) && now() - (Number((run.end || run.start)?.at) || 0) < kCronFoldWaitMs) {
          waiting.push(run);
          continue;
        }
        if (files >= kMaxIngestPerTick) return { added, files };
        files += 1;
        const folded = matches.filter((match) => match.settled);
        let row;
        try {
          const turns = folded.map((match) => turnOf(match.records, { interrupted: match.interrupted, cronJobs: jobs(), contentJobs })).filter(Boolean);
          row = cronRowOf(run, turns, { interrupted, cronJobs: jobs(), contentJobs });
        } catch (error) {
          if (!failed(file, name, error)) remove(file, name, generation);
          continue;
        }
        if (!queue(row, name)) continue;
        for (const match of folded) {
          consumed.add(match.file);
          remove(match.file, match.name, generation);
        }
        remove(file, name, generation);
      }

      // Turns no cron run took. One that a cron run still in progress will
      // take waits for it.
      for (const turnFile of turnFiles) {
        if (consumed.has(turnFile.file) || !turnFile.settled) continue;
        if (waiting.some((run) => turnBelongsTo(run, turnFile.records))) continue;
        if (files >= kMaxIngestPerTick) return { added, files };
        files += 1;
        let turn;
        try {
          turn = turnOf(turnFile.records, { interrupted: turnFile.interrupted, cronJobs: jobs(), contentJobs });
        } catch (error) {
          if (!failed(turnFile.file, turnFile.name, error)) remove(turnFile.file, turnFile.name, generation);
          continue;
        }
        if (turn && !queue(turn, turnFile.name)) continue;
        remove(turnFile.file, turnFile.name, generation);
      }
      if (interrupted) {
        try {
          if (fsModule.readdirSync(dir).length === 0) fsModule.rmdirSync(dir);
        } catch {}
      }
    }
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
