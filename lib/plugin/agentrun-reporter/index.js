const fs = require("fs");
const os = require("os");
const path = require("path");
const { classifySession, isIncognitoSessionKey, mayCarryContents, googleToolOf } = require("./classify");

// AlphaClaw's AgentRun reporter, capture side (GST-2907). It never opens a
// database and never touches the network: each hook appends one JSON line to
// <rootDir>/agentrun-spool/<generation>/<run>.jsonl and the terminal hook
// renames the file to .done. The AlphaClaw server reads those files, applies
// its privacy policy and posts finished turns to AgentRun. Every handler is
// void, synchronous, wrapped in try/catch and never throws into OpenClaw. A
// turn's prompt, tool inputs and tool outputs are never written; assistant
// text only for an isolated cron session.
const kPluginId = "agentrun-reporter";
const kMarker = "[agentrun-reporter]";
const kSpoolDirName = "agentrun-spool";
const kMaxTextChars = 16000;
const kMaxErrorChars = 2000;
const kMaxToolsPerRun = 500;
const kErrorLogLimitPerMinute = 10;
// OpenClaw 2026.11.4 fires agent_end before the attempt's llm_output (which
// carries the usage), so an ended run waits for it. An ended run that never
// gets one is forgotten after this long; the server reads its file once the
// end record is older than its own settle time.
const kEndingTtlMs = 60_000;
const kRecentlyClosedTtlMs = 10 * 60_000;
// A run whose agent_end never came (OpenClaw can drop it when the run's plugin
// scope closes first) is forgotten after this long without a hook.
const kIdleTtlMs = 6 * 60 * 60_000;
const kMaxParents = 1000;

const safeName = (value) => String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
const cut = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + " [cut]" : text;
};
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

// This process's start time in clock ticks (/proc/self/stat field 22), so the
// server can tell this gateway from a later process that reuses its pid. ""
// where /proc is unreadable.
const selfStartTicks = (fsModule) => {
  try {
    const raw = String(fsModule.readFileSync("/proc/self/stat", "utf8"));
    const ticks = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(ticks || "") ? ticks : "";
  } catch {
    return "";
  }
};

const createAgentrunReporterPlugin = ({
  fsModule = fs,
  now = () => Date.now(),
  generationId = () => [now(), process.pid, selfStartTicks(fsModule)].filter(Boolean).join("-"),
} = {}) => ({
  id: kPluginId,
  name: "AlphaClaw AgentRun Reporter",
  description: "Records finished agent turns for AlphaClaw to report to AgentRun; contents only for isolated cron sessions",
  register: (api) => {
    const logger = api?.logger;
    const pluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
    const rootDir = String(pluginConfig.rootDir || process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), ".alphaclaw"));
    const spoolRoot = path.join(rootDir, kSpoolDirName);
    const generation = safeName(generationId());
    const runs = new Map();
    // Runs whose file is closed, so a hook that arrives after it does not
    // open a second file that is never closed. A new attempt clears its entry.
    const recentlyClosed = new Map();
    // A spawned subagent's session -> the session that spawned it, so its
    // run names its parent's session label. Newest kMaxParents only.
    const parents = new Map();
    let errorWindowStart = 0;
    let errorsInWindow = 0;
    let errorsUnlogged = 0;

    const logError = (where, error) => {
      const at = now();
      if (at - errorWindowStart > 60_000) {
        if (errorsUnlogged > 0) logger?.warn?.(`${kMarker} capture_error unlogged=${errorsUnlogged}`);
        errorWindowStart = at;
        errorsInWindow = 0;
        errorsUnlogged = 0;
      }
      if (errorsInWindow >= kErrorLogLimitPerMinute) {
        errorsUnlogged += 1;
        return;
      }
      errorsInWindow += 1;
      logger?.warn?.(`${kMarker} capture_error hook=${where} ${cut(error?.message || error, 200)}`);
    };

    const fileOf = (runId) => path.join(spoolRoot, generation, `${safeName(runId)}.jsonl`);
    const forget = (runId) => {
      runs.delete(runId);
      recentlyClosed.set(runId, now());
    };
    const append = (runId, record) => {
      const state = runs.get(runId);
      const file = fileOf(runId);
      // The server reads and deletes a live gateway's file once its turn has
      // settled; a hook after that would start a file with no open record.
      if (state?.opened && !fsModule.existsSync(file)) {
        forget(runId);
        return;
      }
      fsModule.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fsModule.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
      if (state) {
        state.opened = true;
        state.lastAt = now();
      }
    };

    // The first record of a run carries its class. model_call_started's
    // context has no trigger or job id, so the class it gives is provisional
    // (marked, so the server never starts a live run from it): the first hook
    // that carries them (llm_output, after_tool_call, agent_end) decides it
    // once and appends a second open record.
    const ensureRun = (runId, ctx, { provisional = false } = {}) => {
      const known = runs.get(runId);
      if (known && (known.skip || !known.provisional || provisional)) return known;
      const sessionKey = String(ctx?.sessionKey || "");
      if (isIncognitoSessionKey(sessionKey)) {
        const skipped = { skip: true };
        runs.set(runId, skipped);
        return skipped;
      }
      const verdict = classifySession({ sessionKey, trigger: ctx?.trigger, jobId: ctx?.jobId });
      const state = known || { skip: false, tools: 0, closed: false };
      state.class = verdict.class;
      state.provisional = provisional;
      runs.set(runId, state);
      append(runId, {
        t: "open",
        at: now(),
        runId,
        sessionKey,
        class: verdict.class,
        agentId: String(ctx?.agentId || verdict.agentId || ""),
        jobId: verdict.jobId,
        channel: verdict.channel || String(ctx?.channel || ctx?.messageProvider || ""),
        trigger: String(ctx?.trigger || ""),
        ...(provisional ? { provisional: true } : {}),
        ...(parents.has(sessionKey) ? { parentSessionKey: parents.get(sessionKey) } : {}),
      });
      return state;
    };

    const guarded = (where, handler) => (event, ctx) => {
      try {
        handler(event || {}, ctx || {});
      } catch (error) {
        logError(where, error);
      }
      return undefined;
    };

    const runIdOf = (event, ctx) => String(event?.runId || ctx?.runId || "").trim();

    const sweep = () => {
      const at = now();
      for (const [runId, state] of runs) {
        if (!state.lastAt) state.lastAt = at;
        if (state.ending ? at - state.endedAt > kEndingTtlMs : at - (state.lastAt || at) > kIdleTtlMs) forget(runId);
      }
      for (const [runId, closedAt] of recentlyClosed) if (at - closedAt > kRecentlyClosedTtlMs) recentlyClosed.delete(runId);
    };

    const isLate = (runId) => !runs.has(runId) && recentlyClosed.has(runId);

    const finish = (runId) => {
      const file = fileOf(runId);
      // A model-fallback attempt ends with its own agent_end under the same
      // run id; never overwrite an earlier attempt's file ("~" sorts after ".").
      if (fsModule.existsSync(file)) {
        let target = file.replace(/\.jsonl$/, ".done");
        for (let attempt = 1; fsModule.existsSync(target); attempt += 1) target = file.replace(/\.jsonl$/, `~${String(attempt).padStart(3, "0")}.done`);
        fsModule.renameSync(file, target);
      }
      forget(runId);
    };

    // The end record is written at agent_end. The file is closed then only if
    // the attempt's llm_output already came; otherwise at that llm_output.
    const close = (runId, ctx, record) => {
      const state = ensureRun(runId, ctx);
      if (state.skip || state.closed) {
        runs.delete(runId);
        return;
      }
      state.closed = true;
      append(runId, { t: "end", at: now(), ...record });
      if (state.llmSeen) {
        finish(runId);
        return;
      }
      state.ending = true;
      state.endedAt = now();
      sweep();
    };

    // The generation is this gateway process's, set when the plugin loads; a
    // turn already running when gateway_start fires keeps its file and state.
    // gateway_start only creates the directory, so the server can tell an
    // earlier process's files from this one's before the first turn.
    api.on("gateway_start", guarded("gateway_start", () => {
      fsModule.mkdirSync(path.join(spoolRoot, generation), { recursive: true, mode: 0o700 });
    }));

    api.on("model_call_started", guarded("model_call_started", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      if (!runId) return;
      // A new attempt of a run: an earlier attempt still waiting for its
      // llm_output is closed as it is, so this attempt gets its own file.
      if (runs.get(runId)?.ending) finish(runId);
      // A new pass of a run that has not ended (a before_agent_finalize
      // revision) is marked, so its earlier llm_output is not read as an end.
      const pass = runs.get(runId);
      if (pass && !pass.closed && pass.llmSeen) {
        pass.llmSeen = false;
        append(runId, { t: "pass", at: now() });
      }
      recentlyClosed.delete(runId);
      if (!runs.has(runId)) sweep();
      ensureRun(runId, { ...ctx, sessionKey: ctx?.sessionKey || event?.sessionKey }, { provisional: true });
    }));

    api.on("model_call_ended", guarded("model_call_ended", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      const state = runs.get(runId);
      if (!state || state.skip || state.closed) return;
      const model = cut([event?.provider, event?.model].filter(Boolean).join("/"), 200);
      if (!model || model === state.lastModel) return;
      state.lastModel = model;
      append(runId, { t: "model", at: now(), model });
    }));

    api.on("llm_output", guarded("llm_output", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      if (!runId || isLate(runId)) return;
      const state = ensureRun(runId, ctx);
      if (state.skip) return;
      if (state.closed && !state.ending) return;
      const usage = event?.usage && typeof event.usage === "object" ? event.usage : {};
      const record = {
        t: "llm",
        at: now(),
        provider: cut(event?.provider, 100),
        model: cut(event?.resolvedRef || event?.model, 200),
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        cacheWrite: num(usage.cacheWrite),
        costUsd: num(usage?.cost?.total ?? usage?.costUsd),
        stopReason: cut(event?.lastAssistant && typeof event.lastAssistant === "object" ? event.lastAssistant.stopReason || "" : "", 40),
      };
      if (mayCarryContents(state.class) && !state.google && Array.isArray(event?.assistantTexts)) {
        record.text = cut(event.assistantTexts.filter((part) => typeof part === "string").join("\n"), kMaxTextChars);
      }
      append(runId, record);
      state.llmSeen = true;
      if (state.ending) finish(runId);
    }));

    api.on("after_tool_call", guarded("after_tool_call", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      if (!runId || isLate(runId)) return;
      const state = ensureRun(runId, ctx);
      const toolName = event?.toolName || ctx?.toolName;
      const google = googleToolOf(toolName, event?.params);
      if (google) state.google = true;
      if (state.skip || state.closed || state.tools >= kMaxToolsPerRun) return;
      state.tools += 1;
      append(runId, {
        t: "tool",
        at: now(),
        name: cut(google || toolName, 200),
        ok: !event?.error,
        durationMs: num(event?.durationMs),
      });
    }));

    api.on("agent_end", guarded("agent_end", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      if (!runId || isLate(runId)) return;
      const state = ensureRun(runId, ctx);
      // OpenClaw reports a stopped (aborted) run as success false with no error.
      const stopped = event?.success === false && !event?.error;
      const record = {
        status: stopped ? "cancelled" : event?.success === false ? "failed" : "completed",
        ...(stopped ? { reason: "stopped" } : {}),
        durationMs: num(event?.durationMs),
        modelIterations: num(event?.modelIterations),
      };
      if (event?.error && mayCarryContents(state.class) && !state.google) record.error = cut(event.error, kMaxErrorChars);
      close(runId, ctx, record);
    }));

    api.on("subagent_spawned", guarded("subagent_spawned", (event, ctx) => {
      const child = String(event?.childSessionKey || ctx?.childSessionKey || "").trim();
      const requester = String(ctx?.requesterSessionKey || "").trim();
      if (!child || !requester) return;
      parents.delete(child);
      parents.set(child, cut(requester, 400));
      if (parents.size > kMaxParents) parents.delete(parents.keys().next().value);
    }));

    // A cron run's start and finish, keyed by job and start time (OpenClaw
    // gives both events the same runAtMs), in their own file that the finish
    // closes. Only the job's id, name, schedule kind, target, wake mode and the
    // run's status, duration, model, run id and session key are kept, never
    // its summary, error text or payload. A removed job leaves a closed file
    // so the server can archive its agent.
    api.on("cron_changed", guarded("cron_changed", (event) => {
      const action = String(event?.action || "");
      const jobId = String(event?.jobId || "").trim();
      if (!jobId || !["started", "finished", "removed"].includes(action)) return;
      const job = event.job && typeof event.job === "object" ? event.job : {};
      const at = now();
      const runAtMs = Math.round(num(event.runAtMs)) || at;
      const record = {
        t: action === "started" ? "cron-start" : action === "finished" ? "cron-end" : "cron-removed",
        at,
        jobId: cut(jobId, 200),
        name: cut(job.name, 200),
        scheduleKind: cut(job.schedule?.kind, 40),
        payloadKind: cut(job.payload?.kind, 40),
        sessionTarget: cut(event.sessionTarget ?? job.sessionTarget, 200),
        wakeMode: cut(job.wakeMode, 40),
        agentId: cut(event.agentId ?? job.agentId, 200),
      };
      if (action === "finished") {
        Object.assign(record, {
          status: cut(event.status, 20),
          durationMs: num(event.durationMs),
          runId: cut(event.runId, 200),
          sessionKey: cut(event.sessionKey, 400),
          model: cut([event.provider, event.model].filter(Boolean).join("/"), 200),
        });
      }
      if (action !== "removed") record.runAtMs = runAtMs;
      const base = path.join(spoolRoot, generation, action === "removed" ? `@cronjob.${safeName(jobId)}.${at}` : `@cron.${safeName(jobId)}.${runAtMs}`);
      fsModule.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
      if (action === "started") {
        fsModule.appendFileSync(`${base}.jsonl`, JSON.stringify(record) + "\n", { mode: 0o600 });
        return;
      }
      if (action === "removed") {
        fsModule.writeFileSync(`${base}.done`, JSON.stringify(record) + "\n", { mode: 0o600 });
        return;
      }
      fsModule.appendFileSync(`${base}.jsonl`, JSON.stringify(record) + "\n", { mode: 0o600 });
      let target = `${base}.done`;
      for (let attempt = 1; fsModule.existsSync(target); attempt += 1) target = `${base}~${String(attempt).padStart(3, "0")}.done`;
      fsModule.renameSync(`${base}.jsonl`, target);
    }));

    logger?.info?.(`${kMarker} active: recording finished turns and cron runs for AgentRun (contents only for isolated cron sessions)`);
  },
});

const plugin = createAgentrunReporterPlugin();
module.exports = plugin;
module.exports.default = plugin;
module.exports.createAgentrunReporterPlugin = createAgentrunReporterPlugin;
module.exports.kAgentrunReporterPluginId = kPluginId;
module.exports.kSpoolDirName = kSpoolDirName;
