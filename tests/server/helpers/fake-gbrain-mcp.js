const http = require("http");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

// A stand-in for gbrain's HTTP MCP server and OAuth token endpoint, the
// same stateless transport gbrain serves (serve-http-mcp.ts). Each tool call
// is recorded with the headers and _meta it arrived with; a test answers
// calls through handlers[name](args, call), which may throw { code } to
// answer isError with that code.
const startFakeGbrain = async ({ handlers = {} } = {}) => {
  const calls = [];
  const tokenRequests = [];
  const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/token") {
      tokenRequests.push(Object.fromEntries(new URLSearchParams(raw)));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ access_token: "tok-1", token_type: "bearer", expires_in: 3600 }));
    }
    if (req.url !== "/mcp") {
      res.writeHead(404);
      return res.end();
    }
    const mcp = new Server({ name: "fake-gbrain", version: "0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const call = {
        name: request.params.name,
        args: request.params.arguments || {},
        meta: request.params._meta || null,
        headers: {
          authorization: req.headers.authorization || null,
          onBehalfOf: req.headers["x-gbrain-on-behalf-of"] || null,
          agentLabel: req.headers["x-gbrain-agent-label"] || null,
        },
      };
      calls.push(call);
      const handler = handlers[call.name];
      if (!handler) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "unknown_tool" } }) }] };
      try {
        return answer(await handler(call.args, call));
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: error.code || "boom" } }) }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    base,
    calls,
    tokenRequests,
    handlers,
    credential: { mcp_url: base + "/mcp", token_url: base + "/token", client_id: "guest-broker", client_secret: "s3cret-value", owner_member: "owner1" },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

module.exports = { startFakeGbrain };
