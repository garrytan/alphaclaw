const fs = require("fs");
const os = require("os");
const path = require("path");
const { classifyAnchor } = require("../../lib/plugin/relay-guard/confirm");
const { setup } = require("./helpers/relay-attested-harness");

// GST-3258: a relative write, edit or patch path lands in the agent's
// workspace, and OpenClaw reads that workspace from its config with $include
// resolved. The relay guard has to find it the same way, or a relative path
// whose workspace sits inside the trust anchor through an included file is
// judged against the wrong folder.
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

describe("relay guard: relative paths and an included workspace (GST-3258)", () => {
  let rootDir;
  let elsewhere;
  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-include-ws-")));
    elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-include-cwd-")));
    vi.spyOn(process, "cwd").mockReturnValue(elsewhere);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
  const openclawJson = () => path.join(rootDir, ".openclaw", "openclaw.json");
  const relativeCalls = [
    ["write", { path: "tool.js", content: "x" }],
    ["edit", { path: "tool.js", old_string: "a", new_string: "b" }],
    ["apply_patch", { input: "*** Begin Patch\n*** Add File: tool.js\n+x\n*** End Patch" }],
  ];

  it("judges a relative path against an agent workspace that comes from an included file", () => {
    writeJson(path.join(rootDir, ".openclaw", "agents.json"), { list: [{ id: "main", workspace: path.join(rootDir, "relay") }] });
    writeJson(openclawJson(), { agents: { $include: "agents.json" } });
    for (const [toolName, params] of relativeCalls) {
      expect(classifyAnchor({ toolName, params, rootDir, agentId: "main" }), toolName).toMatchObject({ action: toolName + " tool.js" });
    }
  });

  it("judges it against an included agents.defaults workspace too", () => {
    writeJson(path.join(rootDir, ".openclaw", "defaults.json"), { workspace: path.join(rootDir, "relay") });
    writeJson(openclawJson(), { agents: { defaults: { $include: "defaults.json" } } });
    expect(classifyAnchor({ toolName: "write", params: { path: "tool.js", content: "x" }, rootDir, agentId: "main" })).toMatchObject({ action: "write tool.js" });
  });

  it("still judges the inline workspace, and lets a relative path in an ordinary workspace through", () => {
    writeJson(openclawJson(), { agents: { list: [{ id: "main", workspace: path.join(rootDir, "relay") }] } });
    expect(classifyAnchor({ toolName: "write", params: { path: "tool.js", content: "x" }, rootDir, agentId: "main" })).toMatchObject({ action: "write tool.js" });
    writeJson(path.join(rootDir, ".openclaw", "agents.json"), { list: [{ id: "main", workspace: path.join(rootDir, "ws") }] });
    writeJson(openclawJson(), { agents: { $include: "agents.json" } });
    for (const [toolName, params] of relativeCalls) expect(classifyAnchor({ toolName, params, rootDir, agentId: "main" }), toolName).toBeNull();
  });

  it("still judges the inline workspace when an unrelated $include is broken", () => {
    writeJson(openclawJson(), { agents: { list: [{ id: "main", workspace: path.join(rootDir, "relay") }] }, plugins: { $include: "missing.json" } });
    expect(classifyAnchor({ toolName: "write", params: { path: "tool.js", content: "x" }, rootDir, agentId: "main" })).toMatchObject({ action: "write tool.js" });
  });

  it("refuses the owner's attested thread a relative write into an included workspace inside the anchor", async () => {
    const ctx = setup();
    try {
      const config = JSON.parse(fs.readFileSync(ctx.openclawJson, "utf8"));
      writeJson(path.join(path.dirname(ctx.openclawJson), "agents.json"), { list: [{ id: "main", workspace: path.join(ctx.rootDir, "relay") }] });
      fs.writeFileSync(ctx.openclawJson, JSON.stringify({ ...config, agents: { $include: "agents.json" } }));
      const run = await ctx.deliver((await ctx.attestedAgent()).agent);
      const result = await ctx.call(run, "write", { path: "tool.js", content: "x" });
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("would change what decides relay trust on this box");
      expect(ctx.confirmationCount()).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });
});
