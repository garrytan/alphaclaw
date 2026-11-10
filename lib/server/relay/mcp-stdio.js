#!/usr/bin/env node
// The box agent's relay tools, as a stdio MCP server that OpenClaw starts
// from openclaw.json (mcp.servers.relay). The config entry carries no secret:
// only this file, the relay directory and the engine port. The agent token is
// read from relay/secrets.json (0600) on every call, so a token rotated by
// provisioning is picked up without a restart, and until provisioning is done
// every tool answers provisioning_pending.
const path = require("path");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { createEngineClient } = require("./engine-client");
const { createRelayTools, kMaxLongTextChars } = require("./mcp-tools");
const { readInternalSecret, readRelaySecrets } = require("./provision");
const { RelayError } = require("./errors");
const { kRelayEngineVersion, relayPaths } = require("./constants");

const kMaskTimeoutMs = 5000;

// Every text the box agent sends is masked by AlphaClaw's own server first
// (POST /relay/internal/mask, loopback only, the relay's 0600 internal secret
// as the bearer): OpenClaw starts this process with only a default env, so
// the deployment env's secrets are visible only to AlphaClaw. Fails closed:
// no masked answer, no send (masking_unavailable).
const createAppMasker = ({ relayDir, appPort, fetchImpl = globalThis.fetch }) => async (text) => {
  let body = null;
  try {
    const secret = readInternalSecret(relayPaths(path.dirname(relayDir)));
    const response = await fetchImpl("http://127.0.0.1:" + appPort + "/relay/internal/mask", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(kMaskTimeoutMs),
    });
    if (response.ok) body = await response.json().catch(() => null);
  } catch {}
  if (body?.ok !== true || typeof body.text !== "string") throw new RelayError("masking_unavailable");
  return body.text;
};

// What a masked text leaves the box as (POST /relay/internal/outbound, the
// same loopback caller rule): a long text to a Capy thread goes as its first
// part with a result_ref, and a turn the owner started gets its signed
// owner-provenance statement. Fails closed like the masker; a refusal
// (a long text to an agent that cannot read parts) is the tool's error.
const createAppOutbound = ({ relayDir, appPort, fetchImpl = globalThis.fetch }) => async ({ to, text, provenanceRef }) => {
  let response = null;
  let body = null;
  try {
    const secret = readInternalSecret(relayPaths(path.dirname(relayDir)));
    response = await fetchImpl("http://127.0.0.1:" + appPort + "/relay/internal/outbound", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ to, text, ...(provenanceRef ? { provenance_ref: provenanceRef } : {}) }),
      signal: AbortSignal.timeout(kMaskTimeoutMs),
    });
    body = await response.json().catch(() => null);
  } catch {}
  if (response?.status === 400 && body?.error === "invalid_input") throw new RelayError("invalid_input", String(body.message || "The message was refused."));
  if (body?.ok !== true || typeof body.text !== "string") throw new RelayError("masking_unavailable");
  return { text: body.text, metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {}, provenance: body.provenance === true };
};

// The hop for a message the box agent sends now: one past the highest hop of
// the relay runs in flight (bridge.db, read-only), 0 when none is running.
// It over-counts when an owner turn overlaps a relay run, which only trips
// the hop limit sooner.
const readNextHop = (bridgeDb) => {
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(bridgeDb, { readOnly: true });
    const row = db
      .prepare("SELECT MAX(hop) AS hop FROM relay_messages WHERE state IN ('dispatched', 'completing', 'reconciling')")
      .get();
    return Number.isInteger(row?.hop) ? row.hop + 1 : 0;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {}
  }
};

const parseArgs = (argv) => {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--relay-dir") out.relayDir = value;
    if (key === "--port") out.port = Number(value);
    if (key === "--app-port") out.appPort = Number(value);
  }
  return out;
};

const createRelayMcpServer = ({ relayDir, port, appPort, fetchImpl }) => {
  const paths = { secretsFile: path.join(relayDir, "secrets.json") };
  const engine = createEngineClient({ baseUrl: "http://127.0.0.1:" + port, ...(fetchImpl ? { fetchImpl } : {}) });
  const getAuth = () => {
    const secrets = readRelaySecrets(paths);
    const agentName = secrets?.boxAgent;
    const agentToken = agentName ? secrets?.agents?.[agentName]?.token : null;
    if (!secrets?.workspaceKey || !agentToken) throw new RelayError("provisioning_pending", "The relay has not finished provisioning.");
    return { workspaceKey: secrets.workspaceKey, agentName, agentToken };
  };
  const bridgeDb = path.join(relayDir, "bridge.db");
  const tools = createRelayTools({
    engine,
    getAuth,
    nextHop: () => readNextHop(bridgeDb),
    maskText: createAppMasker({ relayDir, appPort, ...(fetchImpl ? { fetchImpl } : {}) }),
    shapeOutbound: createAppOutbound({ relayDir, appPort, ...(fetchImpl ? { fetchImpl } : {}) }),
    maxTextChars: kMaxLongTextChars,
    boxTools: true,
  });
  const server = new Server({ name: "alphaclaw-relay", version: kRelayEngineVersion }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => tools.call(request.params.name, request.params.arguments || {}));
  return server;
};

if (require.main === module) {
  const { relayDir, port, appPort } = parseArgs(process.argv.slice(2));
  if (!relayDir || !Number.isInteger(port) || !Number.isInteger(appPort)) {
    process.stderr.write("usage: mcp-stdio.js --relay-dir <dir> --port <port> --app-port <port>\n");
    process.exit(2);
  }
  const server = createRelayMcpServer({ relayDir, port, appPort });
  server.connect(new StdioServerTransport()).catch((error) => {
    process.stderr.write("[relay] mcp server failed: " + (error?.message || error) + "\n");
    process.exit(1);
  });
}

module.exports = { createRelayMcpServer, createAppMasker, createAppOutbound, parseArgs, readNextHop };
