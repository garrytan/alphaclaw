const fs = require("fs");
const os = require("os");
const path = require("path");
const { classifySession, isIncognitoSessionKey, mayCarryContents } = require("./classify");

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

const safeName = (value) => String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
const cut = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + " [cut]" : text;
};
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const createAgentrunReporterPlugin = ({ fsModule = fs, now = () => Date.now(), generationId = () => `${now()}-${process.pid}` } = {}) => ({
  id: kPluginId,
  name: "AlphaClaw AgentRun Reporter",
  description: "Records finished agent turns for AlphaClaw to report to AgentRun; contents only for isolated cron sessions",
  register: (api) => {
    const logger = api?.logger;
    const pluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
    const rootDir = String(pluginConfig.rootDir || process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), ".alphaclaw"));
    const spoolRoot = path.join(rootDir, kSpoolDirName);
    let generation = safeName(generationId());
    const runs = new Map();
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
    const append = (runId, record) => {
      const file = fileOf(runId);
      fsModule.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fsModule.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
    };

    // The first record of a run carries its class. model_call_started's
    // context has no trigger or job id, so the class it gives is provisional:
    // the first hook that carries them (llm_output, after_tool_call,
    // agent_end) decides it once and appends a second open record.
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

    const close = (runId, ctx, record) => {
      const state = ensureRun(runId, ctx);
      if (state.skip || state.closed) {
        runs.delete(runId);
        return;
      }
      state.closed = true;
      append(runId, { t: "end", at: now(), ...record });
      const file = fileOf(runId);
      // A model-fallback attempt ends with its own agent_end under the same
      // run id; never overwrite an earlier attempt's file ("~" sorts after ".").
      let target = file.replace(/\.jsonl$/, ".done");
      for (let attempt = 1; fsModule.existsSync(target); attempt += 1) target = file.replace(/\.jsonl$/, `~${String(attempt).padStart(3, "0")}.done`);
      fsModule.renameSync(file, target);
      runs.delete(runId);
    };

    api.on("gateway_start", guarded("gateway_start", () => {
      generation = safeName(generationId());
      runs.clear();
      fsModule.mkdirSync(path.join(spoolRoot, generation), { recursive: true, mode: 0o700 });
    }));

    api.on("model_call_started", guarded("model_call_started", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      if (!runId) return;
      ensureRun(runId, { ...ctx, sessionKey: ctx?.sessionKey || event?.sessionKey }, { provisional: true });
    }));

    api.on("llm_output", guarded("llm_output", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      if (!runId) return;
      const state = ensureRun(runId, ctx);
      if (state.skip || state.closed) return;
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
      };
      if (mayCarryContents(state.class) && Array.isArray(event?.assistantTexts)) {
        record.text = cut(event.assistantTexts.filter((part) => typeof part === "string").join("\n"), kMaxTextChars);
      }
      append(runId, record);
    }));

    api.on("after_tool_call", guarded("after_tool_call", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      if (!runId) return;
      const state = ensureRun(runId, ctx);
      if (state.skip || state.closed || state.tools >= kMaxToolsPerRun) return;
      state.tools += 1;
      append(runId, {
        t: "tool",
        at: now(),
        name: cut(event?.toolName || ctx?.toolName, 200),
        ok: !event?.error,
        durationMs: num(event?.durationMs),
      });
    }));

    api.on("agent_end", guarded("agent_end", (event, ctx) => {
      const runId = runIdOf(event, ctx);
      if (!runId) return;
      const state = ensureRun(runId, ctx);
      // OpenClaw reports a stopped (aborted) run as success false with no error.
      const stopped = event?.success === false && !event?.error;
      const record = {
        status: stopped ? "cancelled" : event?.success === false ? "failed" : "completed",
        ...(stopped ? { reason: "stopped" } : {}),
        durationMs: num(event?.durationMs),
        modelIterations: num(event?.modelIterations),
      };
      if (event?.error && mayCarryContents(state.class)) record.error = cut(event.error, kMaxErrorChars);
      close(runId, ctx, record);
    }));

    logger?.info?.(`${kMarker} active: recording finished turns for AgentRun (contents only for isolated cron sessions)`);
  },
});

const plugin = createAgentrunReporterPlugin();
module.exports = plugin;
module.exports.default = plugin;
module.exports.createAgentrunReporterPlugin = createAgentrunReporterPlugin;
module.exports.kAgentrunReporterPluginId = kPluginId;
module.exports.kSpoolDirName = kSpoolDirName;
