// LIVE TIER — what the REAL pinned OpenClaw actually sends the model from
// AlphaClaw's bootstrap files (ALPH-58, GST-175). AlphaClaw's real sync writes
// the rules file, the reference file and the Setup UI map into a workspace,
// the real gateway runs one chat turn against a capturing mock model, and the
// test reads the system prompt the model received: the whole rules file is in
// it (so every protected clause reached the model), the Setup UI tab table is
// not, the pointer to setup-ui.md is, and OpenClaw's own run report
// (sessions.usage with includeContextWeight) says the rules file was injected
// whole. The same turn against a copy of v0.10.161's two templates logs the
// before and after sizes.
// When this tier fails but the hermetic suite is green, suspect upstream
// OpenClaw drift first (AGENTS.md "test:live" note).
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-injected-context-root-");
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
const kSetupUrl = "https://setup.example.com";
const kRulesRelative = "hooks/bootstrap/AGENTS.md";
const kReferenceRelative = "hooks/bootstrap/reference/AGENTS.md";
const kSetupUiRelative = "hooks/bootstrap/reference/setup-ui.md";
const kPreviousTemplatesDir = path.join(__dirname, "fixtures", "bootstrap-templates-v0.10.161");

// One anchor per protected clause that renders on this install (Telegram is
// off here, so P11 is covered by the hermetic fixture only).
const kAnchors = {
  P1: "**NEVER** make risky system changes",
  P2: "**wait for the user's sign-off** before proceeding",
  P3: "- Never persist `plugins.load.paths` entries that point at temp directories.",
  P4: "- Before you start, update only with `git pull --ff-only`.",
  P5: "end your message with a **Changes committed** summary",
  P6: "Do not deflect actionable requests to the Setup UI.",
  P7: "Changes to env vars are made through the **Envars** tab (`" + kSetupUrl + "#envars`).",
  P8: "- **Links:** Use markdown syntax `[text](URL)`",
  P9: "- Never create transform files outside of hooks/transforms/",
  P10: "Only act for admins listed\nin that skill; changes are audited and admins are notified.",
};
const kPointer =
  "Setup UI map (tab URLs and what each does): read `hooks/bootstrap/reference/setup-ui.md` when someone " +
  "needs to find something in the UI.";
const kTabTableRow = "| Cron     | `" + kSetupUrl + "#cron`";

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";

describeLive("LIVE injected bootstrap context against the " + (kCandidateBinDir ? "candidate" : readDeclaredPin()) + " pin", () => {
  let gateway;
  let model;
  let port;
  let call;
  let workspace;
  const requests = [];

  const readyzOk = async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port + "/readyz")).status === 200;
    } catch {
      return false;
    }
  };

  // AlphaClaw's real sync on the real fs. previousTemplates swaps in the
  // v0.10.161 copies of core-prompts TOOLS.md and AGENTS.md.
  const syncPromptFiles = ({ previousTemplates = false } = {}) => {
    const { kSetupDir } = require("../../lib/server/constants");
    const { syncBootstrapPromptFiles } = require("../../lib/server/onboarding/workspace");
    const swapped = new Map(
      ["TOOLS.md", "AGENTS.md"].map((name) => [
        path.join(kSetupDir, "core-prompts", name),
        path.join(kPreviousTemplatesDir, name),
      ]),
    );
    const syncFs = previousTemplates
      ? { ...fs, readFileSync: (target, ...rest) => fs.readFileSync(swapped.get(target) || target, ...rest) }
      : fs;
    syncBootstrapPromptFiles({ fs: syncFs, workspaceDir: workspace, baseUrl: kSetupUrl });
    return fs.readFileSync(path.join(workspace, ...kRulesRelative.split("/")), "utf8");
  };

  const runTurn = async (label) => {
    const nonce = label + "-" + Math.random().toString(36).slice(2, 8);
    const sessionKey = "agent:main:injected-" + nonce;
    const sent = await call("chat.send", { sessionKey, message: "ping " + nonce, idempotencyKey: sessionKey + "-send", deliver: false });
    expect(sent.body?.status, sent.stderr).toBe("started");
    await waitFor(async () => {
      const history = (await call("chat.history", { sessionKey, limit: 10 })).body?.messages || [];
      return history.some((m) => m.role === "assistant" && textOf(m.content).includes("pong"));
    }, 180_000, "the " + label + " turn finished");
    const request = requests.find((r) => r.userText.includes(nonce));
    expect(request, "the mock model saw the " + label + " turn").toBeTruthy();
    const usage = await call("sessions.usage", { agentId: "main", key: sessionKey, includeContextWeight: true });
    return { prompt: request.systemPrompt, usage: usage.body, usageStderr: usage.stderr };
  };

  // OpenClaw's run report, wherever this pin nests it.
  const findInjectedFile = (usage, relativePath) => {
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) return null;
      seen.add(node);
      if (Array.isArray(node.injectedWorkspaceFiles)) {
        const file = node.injectedWorkspaceFiles.find((entry) =>
          String(entry?.path || entry?.name || "").split(path.sep).join("/").endsWith(relativePath),
        );
        if (file) return file;
      }
      for (const value of Object.values(node)) {
        const found = walk(value);
        if (found) return found;
      }
      return null;
    };
    return walk(usage);
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
        requests.push({
          systemPrompt: messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n"),
          userText: messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n"),
        });
        const chunk = (delta, finish = null) =>
          "data: " + JSON.stringify({ id: "injected-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: "pong" }));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19700 + Math.floor(Math.random() * 90);
    const token = "live-injected-context-token-000000000000";
    workspace = path.join(OPENCLAW_DIR, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    const { ensureManagedOpenclawExecDefaults } = require("../../lib/server/exec-defaults-config");
    const { config } = ensureManagedOpenclawExecDefaults({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace, model: { primary: "fixture/fixture" } } },
      models: { providers: { fixture: {
        baseUrl: "http://127.0.0.1:" + model.address().port + "/v1",
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      channels: {},
    });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(config));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));

    // The admin stanza (P10) renders only with the skill installed.
    const { updateAgentAdminFeature } = require("../../lib/server/alphaclaw-config");
    const tokenStore = require("../../lib/server/agent-admin/token-store");
    const { installAlphaclawAdminSkill } = require("../../lib/server/agent-admin/skill");
    updateAgentAdminFeature({ fsModule: fs, openclawDir: OPENCLAW_DIR, enabled: true });
    tokenStore.ensureToken({ fsModule: fs, openclawDir: OPENCLAW_DIR });
    expect(installAlphaclawAdminSkill({ fs, openclawDir: OPENCLAW_DIR }).installed).toBe(true);

    syncPromptFiles();
    const written = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), "utf8"));
    expect(written.hooks.internal.entries["bootstrap-extra-files"].paths).toEqual([kRulesRelative, kReferenceRelative]);

    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
    const { clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
    const { shellEscapeArg } = require("../../lib/server/agents/shared");
    call = async (method, params) => {
      const result = await clawCmd("gateway call " + shellEscapeArg(method) + " --params " + shellEscapeArg(JSON.stringify(params)) + " --json", { quiet: true, timeoutMs: 30_000 });
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

  it("the model receives every rules-file clause and the pointer, never the tab table, and the rules file whole", async () => {
    const rules = syncPromptFiles();
    for (const [id, anchor] of Object.entries(kAnchors)) expect(rules, id).toContain(anchor);
    expect(rules).toContain(kPointer);
    expect(rules).not.toContain(kTabTableRow);
    const setupUi = fs.readFileSync(path.join(workspace, ...kSetupUiRelative.split("/")), "utf8");
    expect(setupUi).toContain(kTabTableRow);

    const after = await runTurn("after");
    expect(after.prompt).toContain(rules.trim());
    expect(after.prompt).toContain(kPointer);
    expect(after.prompt).not.toContain(kTabTableRow);
    expect(after.prompt).not.toContain("# AlphaClaw Setup UI map");

    const rulesReport = findInjectedFile(after.usage, kRulesRelative);
    expect(rulesReport, "sessions.usage contextWeight lists the rules file: " + after.usageStderr).toBeTruthy();
    expect(rulesReport.truncated).toBe(false);
    expect(rulesReport.rawChars).toBe(rules.trimEnd().length);
    expect(rulesReport.injectedChars).toBe(rulesReport.rawChars);
    expect(findInjectedFile(after.usage, kSetupUiRelative)).toBeNull();

    // Before: the same sync and the same gateway, v0.10.161's templates.
    const previousRules = syncPromptFiles({ previousTemplates: true });
    expect(previousRules).toContain("### Tabs");
    const before = await runTurn("before");
    expect(before.prompt).toContain(previousRules.trim());
    const previousReport = findInjectedFile(before.usage, kRulesRelative);

    // eslint-disable-next-line no-console
    console.log(
      "[live] injected context before/after (v0.10.161 templates → this branch): " +
        JSON.stringify({
          rulesFileChars: { before: previousRules.trimEnd().length, after: rules.trimEnd().length },
          rulesInjectedChars: { before: previousReport?.injectedChars ?? null, after: rulesReport.injectedChars },
          systemPromptChars: { before: before.prompt.length, after: after.prompt.length },
        }),
    );
    expect(after.prompt.length).toBeLessThan(before.prompt.length);
    syncPromptFiles();
  }, kCaseTimeoutMs);
});
