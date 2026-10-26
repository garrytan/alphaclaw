// LIVE TIER — the generated alphaclaw-admin skill on a REAL pinned OpenClaw
// gateway with a scripted model (ALPH-42). SKILL.md is a short index and each
// domain's operations live in references/<domain>.md next to it, so the agent
// must be able to find the skill in its catalog, read the index, and then open
// a domain file with its own read tool. This drives exactly that through the
// real agent loop: the model fixture answers an admin question the way a
// working model does (read the listed SKILL.md, follow the index's link for
// the domain, answer from that file), and OpenClaw's real catalog, read tool
// and path policy decide whether each step works. A scripted model cannot show
// that a real model chooses to open the file; it shows the file is listed,
// linked, readable through the tool the agent has, and carries the answer.
// When this tier fails but the hermetic suite is green, suspect upstream
// OpenClaw drift first (AGENTS.md "test:live" note).
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-admin-skill-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
const kCandidateBinDir = process.env.OPENCLAW_CONTRACT_INSTALL_DIR
  ? path.resolve(process.env.OPENCLAW_CONTRACT_INSTALL_DIR, "node_modules", ".bin")
  : null;
process.env.PATH = [kCandidateBinDir, liveHelpers.repoBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);

const { kLiveEnabled, waitFor, readDeclaredPin } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kCaseTimeoutMs = 6 * 60 * 1000;
const kQuestion = "Admin question: which command lists our webhooks?";
const kWebhooksCommand = "`alphaclaw admin GET /api/webhooks`";
const kSkillLocationPattern = /<name>alphaclaw-admin<\/name>[\s\S]*?<location>([^<]+)<\/location>/;
const kWebhooksLinkPattern = /\]\((references\/webhooks\.md)\)/;

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";

describeLive(`LIVE alphaclaw-admin skill index and domain files against the ${kCandidateBinDir ? "candidate" : readDeclaredPin()} pin`, () => {
  let gateway;
  let model;
  let port;
  let call;
  const requests = [];
  const reads = [];

  const readyzOk = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    model = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {}
        const messages = payload.messages || [];
        const last = messages[messages.length - 1] || {};
        const prompt = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
        const toolNames = (payload.tools || []).map((tool) => tool.function?.name || tool.name).filter(Boolean);
        const location = prompt.match(kSkillLocationPattern)?.[1]?.trim() || null;
        const asked = messages.some((m) => m.role === "user" && textOf(m.content).includes(kQuestion));
        requests.push({ asked, location, toolNames });
        let toolCall = null;
        let reply = "pong";
        if (asked && last.role === "tool") {
          const answered = messages.flatMap((m) => m.tool_calls || []).find((c) => c.id === last.tool_call_id);
          const args = JSON.parse(answered?.function?.arguments || "{}");
          const text = textOf(last.content);
          reads.push({ tool: answered?.function?.name, args, text });
          const link = text.match(kWebhooksLinkPattern)?.[1];
          if (link && location) {
            toolCall = { name: "read", arguments: { path: path.posix.join(path.posix.dirname(location), link) } };
          } else if (text.includes(kWebhooksCommand)) {
            reply = `Answer from the domain file: ${kWebhooksCommand}`;
          } else {
            reply = "the read did not lead to the webhooks operations";
          }
        } else if (asked) {
          if (location && toolNames.includes("read")) toolCall = { name: "read", arguments: { path: location } };
          else reply = `no admin skill to read (listed: ${Boolean(location)}, tools: ${toolNames.join(",")})`;
        }
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({ id: "admin-skill-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (toolCall) {
          const tool = { index: 0, id: `call_${Date.now()}_${requests.length}`, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } };
          res.write(chunk({ role: "assistant", content: null, tool_calls: [tool] }));
          res.write(chunk({}, "tool_calls"));
        } else {
          res.write(chunk({ role: "assistant", content: reply }));
          res.write(chunk({}, "stop"));
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19800 + Math.floor(Math.random() * 90);
    const token = "live-admin-skill-token-0000000000000000";
    const workspace = path.join(OPENCLAW_DIR, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    const { ensureManagedOpenclawExecDefaults } = require("../../lib/server/exec-defaults-config");
    const { config } = ensureManagedOpenclawExecDefaults({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace, model: { primary: "fixture/fixture" } } },
      models: { providers: { fixture: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      channels: {},
    });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(config));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));

    // The skill exactly as AlphaClaw installs it at boot: flag on, token minted.
    const { updateAgentAdminFeature } = require("../../lib/server/alphaclaw-config");
    const tokenStore = require("../../lib/server/agent-admin/token-store");
    const { installAlphaclawAdminSkill } = require("../../lib/server/agent-admin/skill");
    updateAgentAdminFeature({ fsModule: fs, openclawDir: OPENCLAW_DIR, enabled: true });
    tokenStore.ensureToken({ fsModule: fs, openclawDir: OPENCLAW_DIR });
    expect(installAlphaclawAdminSkill({ fs, openclawDir: OPENCLAW_DIR }).installed).toBe(true);

    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
    const { clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
    const { shellEscapeArg } = require("../../lib/server/agents/shared");
    call = async (method, params) => {
      const result = await clawCmd(`gateway call ${shellEscapeArg(method)} --params ${shellEscapeArg(JSON.stringify(params))} --json`, { quiet: true, timeoutMs: 30_000 });
      let parsed = null;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {}
      return { body: parsed, stderr: String(result.stderr || "") };
    };
    await gateway.startGateway();
    await waitFor(readyzOk, 180_000, "gateway /readyz 200");
  }, 6 * 60 * 1000);

  afterAll(async () => {
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    for (const pid of require("../../lib/server/gateway-identity").findPortListenerPids?.(port) || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    model?.close();
  });

  it("lists the skill, serves the index whole, and the agent answers an admin question from a domain file", async () => {
    const sessionKey = `agent:main:admin-skill-${Math.random().toString(36).slice(2, 8)}`;
    const sent = await call("chat.send", { sessionKey, message: kQuestion, idempotencyKey: `${sessionKey}-send`, deliver: false });
    expect(sent.body?.status, sent.stderr).toBe("started");

    let history = [];
    await waitFor(async () => {
      history = (await call("chat.history", { sessionKey, limit: 30 })).body?.messages || [];
      const finalText = textOf([...history].reverse().find((m) => m.role === "assistant")?.content);
      return /Answer from the domain file|did not lead|no admin skill/.test(finalText);
    }, 180_000, "the admin turn finished");
    const finalText = textOf([...history].reverse().find((m) => m.role === "assistant")?.content);

    // Listed: OpenClaw's catalog names the skill at its managed location, and
    // the read tool is offered.
    const first = requests.find((r) => r.asked);
    expect(first?.location, "alphaclaw-admin is in <available_skills>").toMatch(/skills\/alphaclaw-admin\/SKILL\.md$/);
    expect(first.toolNames).toContain("read");

    // Loadable: the index arrives whole and names the domain file but not its
    // operations; the domain file, opened relative to the index, has them.
    expect(reads.map((r) => r.args.path)).toEqual([
      first.location,
      path.posix.join(path.posix.dirname(first.location), "references/webhooks.md"),
    ]);
    const [index, domainFile] = reads;
    expect(index.text).toContain("## Domains");
    expect(index.text).toContain("[references/webhooks.md](references/webhooks.md)");
    expect(index.text).not.toContain(kWebhooksCommand);
    expect(domainFile.text).toContain("# Webhooks");
    expect(domainFile.text).toContain(kWebhooksCommand);
    expect(finalText).toBe(`Answer from the domain file: ${kWebhooksCommand}`);
  }, kCaseTimeoutMs);
});
