// An in-memory AgentRun /v2 for the reporter tests, following AgentRun's own
// rules for SDK runs (packages/serve/src/sdk/runs.ts, checked against a real
// agentrun-serve 0.1.0-beta.41): a repeated start key returns the same run
// and token before any other check; a different body under a key is
// idempotency_mismatch; a runtime other than the agent's is input_invalid;
// event batches are contiguous from 1, exact retries accepted; completion is
// immutable; evidence more than an hour after the start is not_continuable.
const crypto = require("crypto");

const createFakeAgentrun = ({ token = "t".repeat(40), now = () => Date.now() } = {}) => {
  const agents = new Map();
  const agentKeys = new Map();
  const runs = new Map();
  const startKeys = new Map();
  const requests = [];
  const state = { down: false, failNext: [] };
  const error = (status, code, message = code) => ({ status, body: { error: { code, message, retryable: false } } });

  const handle = (method, path, headers, body) => {
    if (state.down) throw new TypeError("fetch failed");
    const injected = state.failNext.shift();
    if (injected) return injected;
    const auth = String(headers.authorization || "").replace(/^Bearer /, "");
    let match;
    if ((match = /^\/sdk-runs\/([^/]+)\/(events|complete)$/.exec(path)) && method === "POST") {
      const run = runs.get(match[1]);
      if (!run) return error(404, "not_found");
      if (auth !== run.token) return error(401, "unauthenticated");
      if (match[2] === "events") {
        const known = run.batches.find((batch) => batch.sequence === body.sequence);
        if (known) return JSON.stringify(known) === JSON.stringify(body) ? { status: 200, body: { accepted: true } } : error(409, "idempotency_mismatch");
        if (run.completion || now() > run.startedAt + 3600000) return error(409, "not_continuable");
        if (body.sequence !== run.batches.length + 1) return error(409, "idempotency_mismatch");
        const ids = new Set();
        for (const event of [...run.batches.flatMap((batch) => batch.events), ...body.events]) {
          if (event.type === "tool" && event.status === "started") {
            if (ids.has(event.id)) return error(422, "input_invalid", "SDK tool start IDs must be unique within the run.");
            ids.add(event.id);
          }
        }
        run.batches.push(body);
        return { status: 200, body: { accepted: true } };
      }
      if (run.completion) return JSON.stringify(run.completion) === JSON.stringify(body) ? { status: 200, body: { accepted: true } } : error(409, "idempotency_mismatch");
      if (now() > run.startedAt + 3600000) return error(409, "not_continuable");
      run.completion = body;
      return { status: 200, body: { accepted: true } };
    }
    if (auth !== token) return error(401, "unauthenticated");
    if ((match = /^\/agents\/([^/]+)\/sdk-runs$/.exec(path)) && method === "POST") {
      const agent = agents.get(decodeURIComponent(match[1]));
      if (!agent) return error(404, "not_found");
      const key = headers["idempotency-key"];
      const fingerprint = JSON.stringify(body);
      const known = startKeys.get(key);
      if (known) {
        if (known.fingerprint !== fingerprint) return error(409, "idempotency_mismatch");
        const run = runs.get(known.runId);
        return { status: 201, body: { run_id: run.id, agent_id: agent.agent_id, token: run.token } };
      }
      if (body.runtime !== agent.definition.sdk.runtime) return error(422, "input_invalid", "The SDK runtime must match the registered agent.");
      const id = crypto.randomUUID();
      const run = { id, agentId: agent.agent_id, start: body, token: "ar_sdk_" + crypto.randomBytes(8).toString("hex"), batches: [], completion: null, startedAt: now() };
      runs.set(id, run);
      startKeys.set(key, { fingerprint, runId: id });
      return { status: 201, body: { run_id: id, agent_id: agent.agent_id, token: run.token } };
    }
    if ((match = /^\/agents\/([^/]+)\/definition$/.exec(path)) && method === "PUT") {
      const agent = agents.get(decodeURIComponent(match[1]));
      if (!agent) return error(404, "not_found");
      if (body.definition.description !== agent.definition.description) return error(422, "input_invalid", "description is kept from creation");
      agent.definition = { ...body.definition };
      agent.revisions += 1;
      return { status: 200, body: agent };
    }
    if ((match = /^\/agents\/([^/]+)$/.exec(path)) && method === "GET") {
      const agent = agents.get(decodeURIComponent(match[1]));
      return agent ? { status: 200, body: agent, etag: '"' + agent.revisions + '"' } : error(404, "not_found");
    }
    if (path === "/agents" && method === "POST") {
      const key = headers["idempotency-key"];
      const id = body.definition.id;
      if (agentKeys.has(key)) return { status: 201, body: agents.get(agentKeys.get(key)) };
      if (agents.has(id)) return error(409, "agent_exists");
      const agent = { agent_id: id, definition: { ...body.definition }, revisions: 1 };
      agents.set(id, agent);
      agentKeys.set(key, id);
      return { status: 201, body: agent };
    }
    return error(404, "not_found");
  };

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v2/, "");
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method || "GET", path, body: init.body || "", headers: { ...headers, authorization: headers.authorization ? "<set>" : "" } });
    const answer = handle(init.method || "GET", path, headers, body);
    return {
      status: answer.status,
      headers: { get: (name) => (name.toLowerCase() === "etag" ? answer.etag || null : null) },
      json: async () => answer.body,
    };
  };

  return { fetchImpl, agents, runs, requests, state, token };
};

module.exports = { createFakeAgentrun };
