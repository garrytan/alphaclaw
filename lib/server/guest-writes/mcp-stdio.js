#!/usr/bin/env node
// The guest_save tool, as a stdio MCP server OpenClaw starts from
// openclaw.json (mcp.servers.guest_notes). The config entry carries no
// secret: this file, AlphaClaw's root dir and port. Each call is posted to
// AlphaClaw's own server (POST /internal/guest-writes/save, loopback, the
// guest-writes internal secret as the bearer), which decides everything.
// claim_ref is whatever the box's guard wrote into the call; a model's own
// value never survives the guard, and the broker checks it against its
// store either way.
const path = require("path");
const fs = require("fs");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { kGuestSaveToolName, kGuestErrors, kMaxTitleChars, kGuestNotesDefaults, guestWritesPaths } = require("./constants");

const kSaveTimeoutMs = 90 * 1000;

const kGuestSaveTool = {
  name: kGuestSaveToolName,
  description:
    "Save a group member's note or file as an outside-guest note in the owner's brain. Use it when a member (not the owner) asks you to write something down, remember it, or keep a file. " +
    "The saved page is tagged as an outside guest's words and is never mixed into the owner's own pages. In the owner's own turns this tool is refused; write normally there.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["note", "file"], description: "note: save text. file: save a file from the member's scratch folder." },
      title: { type: "string", minLength: 1, maxLength: kMaxTitleChars, description: "A short title for the note." },
      text: { type: "string", description: "kind=note: the text to save, verbatim, at most " + kGuestNotesDefaults.maxNoteBytes + " bytes." },
      file_path: { type: "string", description: "kind=file: absolute path of a file inside the member's own scratch folder ($SCRATCH)." },
      claim_ref: { type: "string", description: "Filled in by the system. Leave it empty." },
    },
    required: ["kind", "title"],
    additionalProperties: false,
  },
};

const refusal = (code) => {
  const known = kGuestErrors[code] ? code : "guest_save_failed";
  const body = { code: known, ...kGuestErrors[known] };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
};

const createGuestSaveCaller = ({ rootDir, appPort, fetchImpl = globalThis.fetch, fsModule = fs }) => async (args) => {
  let secret = "";
  try {
    secret = fsModule.readFileSync(guestWritesPaths(rootDir).secretFile, "utf8").trim();
  } catch {
    return refusal("guest_saves_unavailable");
  }
  let response = null;
  let body = null;
  try {
    response = await fetchImpl("http://127.0.0.1:" + appPort + "/internal/guest-writes/save", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        kind: args?.kind,
        title: args?.title,
        text: args?.text,
        file_path: args?.file_path,
        claim_ref: typeof args?.claim_ref === "string" ? args.claim_ref : "",
      }),
      signal: AbortSignal.timeout(kSaveTimeoutMs),
    });
    body = await response.json().catch(() => null);
  } catch {
    return refusal("guest_save_retry");
  }
  if (body?.ok !== true) return refusal(typeof body?.code === "string" ? body.code : "guest_save_failed");
  const result = { status: body.status, slug: body.slug, say: body.say };
  return { isError: false, content: [{ type: "text", text: body.say }], structuredContent: result };
};

const parseArgs = (argv) => {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === "--root-dir") out.rootDir = argv[index + 1];
    if (argv[index] === "--app-port") out.appPort = Number(argv[index + 1]);
  }
  return out;
};

const createGuestNotesMcpServer = ({ rootDir, appPort, fetchImpl }) => {
  const callSave = createGuestSaveCaller({ rootDir, appPort, ...(fetchImpl ? { fetchImpl } : {}) });
  const server = new Server({ name: "alphaclaw-guest-notes", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [kGuestSaveTool] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== kGuestSaveToolName) return refusal("invalid_input");
    return callSave(request.params.arguments || {});
  });
  return server;
};

if (require.main === module) {
  const { rootDir, appPort } = parseArgs(process.argv.slice(2));
  if (!rootDir || !path.isAbsolute(rootDir) || !Number.isInteger(appPort)) {
    process.stderr.write("usage: mcp-stdio.js --root-dir <dir> --app-port <port>\n");
    process.exit(2);
  }
  createGuestNotesMcpServer({ rootDir, appPort })
    .connect(new StdioServerTransport())
    .catch((error) => {
      process.stderr.write("[guest-notes] mcp server failed: " + (error?.message || error) + "\n");
      process.exit(1);
    });
}

module.exports = { createGuestNotesMcpServer, createGuestSaveCaller, parseArgs, kGuestSaveTool, refusal };
