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
const { createRelayTools } = require("./mcp-tools");
const { readRelaySecrets } = require("./provision");
const { RelayError } = require("./errors");
const { kRelayEngineVersion } = require("./constants");

const parseArgs = (argv) => {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--relay-dir") out.relayDir = value;
    if (key === "--port") out.port = Number(value);
  }
  return out;
};

const createRelayMcpServer = ({ relayDir, port, fetchImpl }) => {
  const paths = { secretsFile: path.join(relayDir, "secrets.json") };
  const engine = createEngineClient({ baseUrl: "http://127.0.0.1:" + port, ...(fetchImpl ? { fetchImpl } : {}) });
  const getAuth = () => {
    const secrets = readRelaySecrets(paths);
    const agentName = secrets?.boxAgent;
    const agentToken = agentName ? secrets?.agents?.[agentName]?.token : null;
    if (!secrets?.workspaceKey || !agentToken) throw new RelayError("provisioning_pending", "The relay has not finished provisioning.");
    return { workspaceKey: secrets.workspaceKey, agentName, agentToken };
  };
  const tools = createRelayTools({ engine, getAuth });
  const server = new Server({ name: "alphaclaw-relay", version: kRelayEngineVersion }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => tools.call(request.params.name, request.params.arguments || {}));
  return server;
};

if (require.main === module) {
  const { relayDir, port } = parseArgs(process.argv.slice(2));
  if (!relayDir || !Number.isInteger(port)) {
    process.stderr.write("usage: mcp-stdio.js --relay-dir <dir> --port <port>\n");
    process.exit(2);
  }
  const server = createRelayMcpServer({ relayDir, port });
  server.connect(new StdioServerTransport()).catch((error) => {
    process.stderr.write("[relay] mcp server failed: " + (error?.message || error) + "\n");
    process.exit(1);
  });
}

module.exports = { createRelayMcpServer, parseArgs };
