// The send loop of AlphaClaw's AgentRun reporters (GST-2907): queue rows
// become AgentRun SDK runs (start, events, complete) in one burst after the
// turn ended. Bodies are built at the first send attempt and stored, so a
// retry, a crash or a restart resends the same bytes under the same keys and
// AgentRun answers with the run it already has. A run is never restarted
// under a new key. Log lines: [alphaclaw] agentrun-reporter <code> ...,
// codes documented in docs/designs/agentrun-reporter.md.
const crypto = require("crypto");
const { agentDefinition, startBody, eventBatches, completeBody } = require("./bodies");

const kBackoffBaseMs = 15000;
const kBackoffMaxMs = 10 * 60 * 1000;
const kAuthPauseMs = 60 * 60 * 1000;
const kRefusalLogEveryMs = 60 * 60 * 1000;

const hashOf = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const backoffMs = (attempts, random = Math.random) =>
  Math.min(kBackoffMaxMs, kBackoffBaseMs * 2 ** Math.max(0, attempts - 1)) * (0.75 + random() * 0.5);

const createSender = ({ outbox, client, token, getRuntime, now = () => Date.now(), random = Math.random, logger = console, source = "openclaw" }) => {
  const runTokens = new Map();
  let pausedUntil = 0;
  let lastAuthLogAt = 0;

  const log = (line) => logger.warn?.(`[alphaclaw] agentrun-reporter ${line}`);

  const pauseForAuth = (op) => {
    pausedUntil = now() + kAuthPauseMs;
    if (now() - lastAuthLogAt >= kAuthPauseMs) {
      lastAuthLogAt = now();
      log(`token_rejected op=${op} source=${source} fix=check the reporter's AgentRun token (rows kept, retried in 1h)`);
    }
  };

  const retryLater = (row, result, op) => {
    const attempts = Number(row.attempts || 0) + 1;
    outbox.update(row.id, { attempts, next_attempt_at: now() + backoffMs(attempts, random), last_error: `${op}:${result.code || result.status}` });
  };

  // AgentRun refused an agent for good (an invalid definition, an id it keeps
  // for another agent, a runtime it will not run): that agent's turns are
  // dropped instead of retried, with one log line per agent per hour.
  const refusals = new Map();
  const refuse = (row, result, op) => {
    outbox.update(row.id, { state: "dropped", last_error: `${op}:${result.code || result.status}` });
    const seen = refusals.get(row.agent_key);
    if (seen && now() - seen.loggedAt < kRefusalLogEveryMs) {
      seen.unlogged += 1;
      return;
    }
    refusals.set(row.agent_key, { loggedAt: now(), unlogged: 0 });
    log(
      `agent_refused op=${op} source=${source} agent=${row.agent_key} code=${result.code || result.status} count=${1 + (seen?.unlogged || 0)} (turns for this agent are dropped, not retried) fix=check ALPHACLAW_AGENTRUN_RUNTIME and the agent in AgentRun`,
    );
  };

  const drop = (row, result, op) => {
    outbox.update(row.id, { state: "dropped", last_error: `${op}:${result.code || result.status}` });
    log(`row_dropped op=${op} source=${source} code=${result.code || result.status} count=1 (gone; not retried)`);
  };

  // Resolves the AgentRun agent for a row: { id }, or { outcome } when the
  // row was rescheduled, paused or dropped. A runtime or name change updates the agent's
  // definition; AgentRun keeps an agent's description from its creation.
  // Runs already started keep their runtime: AgentRun answers a repeated
  // start key before it checks the runtime.
  const ensureAgent = async (row) => {
    const runtime = getRuntime();
    const definition = agentDefinition({ agentId: row.agent_key, name: row.agent_name, description: row.agent_description, runtime });
    const definitionHash = hashOf(definition);
    const known = outbox.agentOf(row.agent_key);
    if (known && known.definition_hash === definitionHash) return { id: known.agent_id };
    const path = `/agents/${encodeURIComponent(row.agent_key)}`;
    const got = await client.call({ method: "GET", path, token });
    if (got.kind === "auth") return pauseForAuth("agent"), { outcome: "paused" };
    if (got.kind === "ok") {
      const current = got.body?.definition || {};
      if (current.sdk?.runtime !== runtime || current.name !== definition.name || current.learning !== false) {
        const put = await client.call({
          method: "PUT",
          path: `${path}/definition`,
          token,
          ifMatch: got.etag,
          body: { definition: { ...definition, description: String(current.description ?? definition.description) } },
        });
        if (put.kind === "auth") return pauseForAuth("agent"), { outcome: "paused" };
        if (put.kind === "refused") return refuse(row, put, "agent_update"), { outcome: "dropped" };
        if (put.kind !== "ok") return retryLater(row, put, "agent_update"), { outcome: "retry" };
      }
      const agentId = String(got.body?.agent_id || row.agent_key);
      outbox.saveAgent({ agentKey: row.agent_key, agentId, runtime, definitionHash });
      return { id: agentId };
    }
    if (got.kind === "refused") return refuse(row, got, "agent"), { outcome: "dropped" };
    if (got.kind !== "not_found") return retryLater(row, got, "agent"), { outcome: "retry" };
    const made = await client.call({
      method: "POST",
      path: "/agents",
      token,
      body: { definition },
      idempotencyKey: `alphaclaw-agent:${row.agent_key}:${definitionHash}`,
    });
    if (made.kind === "auth") return pauseForAuth("agent"), { outcome: "paused" };
    if (made.kind === "refused") return refuse(row, made, "agent_create"), { outcome: "dropped" };
    if (made.kind !== "ok") return retryLater(row, made, "agent_create"), { outcome: "retry" };
    const agentId = String(made.body?.agent_id || row.agent_key);
    outbox.saveAgent({ agentKey: row.agent_key, agentId, runtime, definitionHash });
    return { id: agentId };
  };

  const buildBodies = (row) => {
    const usage = JSON.parse(row.usage_json || "null");
    const contents = row.contents === 1;
    return {
      start_body: JSON.stringify(startBody({ runtime: getRuntime(), input: row.input_text, model: row.model })),
      batches_json: JSON.stringify(
        eventBatches({
          rowId: `${row.source}-${row.id}`,
          sessionLabel: row.session_label,
          texts: contents ? JSON.parse(row.texts_json || "[]") : [],
          tools: JSON.parse(row.tools_json || "[]"),
        }),
      ),
      complete_body: JSON.stringify(
        completeBody({
          status: row.status,
          answer: contents ? row.answer_text : "",
          error: row.error_text,
          model: row.model,
          sessionLabel: row.session_label,
          usage,
          evidenceComplete: row.evidence_complete === 1,
        }),
      ),
    };
  };

  const startRun = async (row, agentId) => {
    const result = await client.call({
      method: "POST",
      path: `/agents/${encodeURIComponent(agentId)}/sdk-runs`,
      token,
      body: row.start_body,
      idempotencyKey: `alphaclaw:${row.source}:${row.source_run_id}`,
    });
    if (result.kind === "ok" && result.body?.run_id && result.body?.token) {
      runTokens.set(row.id, String(result.body.token));
      if (row.agentrun_run_id !== result.body.run_id) outbox.update(row.id, { agentrun_run_id: String(result.body.run_id) });
      row.agentrun_run_id = String(result.body.run_id);
    }
    return result;
  };

  // One row through start, events and complete. Returns "sent" | "retry" |
  // "dropped" | "expired" | "paused". A start AgentRun refuses for its
  // runtime created no run under that key, so the row is rebuilt for the
  // agent's current runtime and started again once in the same pass.
  const sendRow = async (row, rebuilt = false) => {
    if (row.start_body === null || row.start_body === undefined) {
      Object.assign(row, buildBodies(row));
      outbox.update(row.id, { start_body: row.start_body, batches_json: row.batches_json, complete_body: row.complete_body });
    }
    const agent = await ensureAgent(row);
    if (!agent.id) return agent.outcome;
    const agentId = agent.id;
    if (!runTokens.has(row.id)) {
      const started = await startRun(row, agentId);
      if (started.kind === "auth") return pauseForAuth("start"), "paused";
      if (started.kind === "not_found") {
        outbox.forgetAgent(row.agent_key);
        return retryLater(row, started, "start"), "retry";
      }
      if (started.code === "input_invalid" && /runtime/i.test(started.message) && !row.agentrun_run_id) {
        outbox.update(row.id, { start_body: null, batches_json: null, complete_body: null });
        outbox.forgetAgent(row.agent_key);
        if (rebuilt) return refuse(row, started, "start_runtime"), "dropped";
        Object.assign(row, { start_body: null, batches_json: null, complete_body: null });
        return sendRow(row, true);
      }
      if (started.kind === "retry") return retryLater(row, started, "start"), "retry";
      if (started.kind !== "ok") return drop(row, started, "start"), "dropped";
    }
    const runToken = runTokens.get(row.id);
    const runPath = `/sdk-runs/${encodeURIComponent(row.agentrun_run_id)}`;
    const batches = JSON.parse(row.batches_json || "[]");
    for (let index = Number(row.batches_sent || 0); index < batches.length; index += 1) {
      const result = await client.call({ method: "POST", path: `${runPath}/events`, token: runToken, body: batches[index] });
      if (result.kind === "auth") {
        runTokens.delete(row.id);
        return retryLater(row, result, "events"), "retry";
      }
      if (result.kind === "expired") return expire(row), "expired";
      if (result.kind === "retry") return retryLater(row, result, "events"), "retry";
      if (result.kind !== "ok") return drop(row, result, "events"), "dropped";
      outbox.update(row.id, { batches_sent: index + 1 });
      row.batches_sent = index + 1;
    }
    const done = await client.call({ method: "POST", path: `${runPath}/complete`, token: runToken, body: row.complete_body });
    if (done.kind === "auth") {
      runTokens.delete(row.id);
      return retryLater(row, done, "complete"), "retry";
    }
    if (done.kind === "expired") return expire(row), "expired";
    if (done.kind === "retry") return retryLater(row, done, "complete"), "retry";
    if (done.kind !== "ok") return drop(row, done, "complete"), "dropped";
    outbox.update(row.id, { state: "sent", last_error: "" });
    runTokens.delete(row.id);
    return "sent";
  };

  const expire = (row) => {
    outbox.update(row.id, { state: "expired", last_error: "not_continuable" });
    runTokens.delete(row.id);
    log(`run_expired op=send source=${source} count=1 (AgentRun's 1-hour window passed; recorded there as unknown, not resent)`);
  };

  // Sends every due row, oldest first, until one asks to pause. Returns counts.
  const sendDue = async ({ limit = 50 } = {}) => {
    const counts = { sent: 0, retry: 0, dropped: 0, expired: 0, paused: 0 };
    if (!token || now() < pausedUntil) return counts;
    for (const row of outbox.due(limit)) {
      let outcome;
      try {
        outcome = await sendRow(row);
      } catch (error) {
        outcome = "retry";
        retryLater(row, { code: "exception" }, "send");
        log(`send_error op=send source=${source} ${String(error?.message || error).slice(0, 200)}`);
      }
      counts[outcome] += 1;
      if (outcome === "paused") break;
    }
    return counts;
  };

  return { sendDue, sendRow };
};

module.exports = { createSender, backoffMs };
