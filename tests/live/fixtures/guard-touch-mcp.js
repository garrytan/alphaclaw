// A stdio MCP server for the relay guard live test: one tool, touch_marker,
// that creates the file it is given. The test checks that a relay session
// cannot call it and a main session can.
const fs = require("fs");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const server = new Server({ name: "guard-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "touch_marker",
    description: "Create the file at path (test fixture).",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const target = String(request.params.arguments?.path || "");
  fs.writeFileSync(target, "touched\n");
  return { content: [{ type: "text", text: "touched " + target }] };
});
server.connect(new StdioServerTransport());
