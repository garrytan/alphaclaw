const fs = require("fs");
const os = require("os");
const path = require("path");
const { getDomains, getManifest } = require("../../lib/server/admin-manifest");
const {
  buildAdminSkillFiles,
  gatherLiveState,
  installAlphaclawAdminSkill,
  renderToolsStanza,
  maskTarget,
} = require("../../lib/server/agent-admin/skill");
const tokenStore = require("../../lib/server/agent-admin/token-store");
const {
  updateAgentAdminFeature,
} = require("../../lib/server/alphaclaw-config");

const kFragmentsDir = path.join(__dirname, "..", "..", "lib", "setup", "skills", "alphaclaw-admin");

// The index alone, the way most assertions read it.
const buildAdminSkillContent = (args) => buildAdminSkillFiles(args)["SKILL.md"];

const referenceEntries = (files) =>
  Object.entries(files).filter(([name]) => name !== "SKILL.md");

const buildMaximalFiles = () =>
  buildAdminSkillFiles({
    fs,
    manifest: getManifest(),
    liveState: {
      adminTargets: Array.from({ length: 10 }, (_, i) => ({
        channel: "telegram",
        label: `ops-${i}`,
        target: `55500000${i}`,
      })),
      activeChannels: ["telegram", "discord", "slack", "whatsapp"],
      releaseChannel: "beta",
      restartRequired: true,
      machine: {
        tier: "medium",
        memoryGb: 4.0,
        cores: 2,
        gpuLabel: "NVIDIA A10G",
        autotuneEnabled: true,
        agentConcurrencyCap: 32,
      },
    },
  });

const makeOpenclawDir = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-admin-skill-"));
  const openclawDir = path.join(root, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  return openclawDir;
};

describe("agent-admin skill builder", () => {
  it("builds a SKILL.md index with frontmatter and ground rules, and one reference file per domain", () => {
    const files = buildAdminSkillFiles({
      fs,
      manifest: getManifest(),
      liveState: { adminTargets: [], activeChannels: [], releaseChannel: "stable" },
    });
    const content = files["SKILL.md"];
    expect(content.startsWith("---\nname: alphaclaw-admin")).toBe(true);
    expect(content).toContain("# AlphaClaw Administration");
    expect(content).toContain("manifestVersion:");
    expect(content).toContain("## Ground Rules");
    // Op tables live in the domain files, not the index.
    expect(content).not.toContain("| Operation | Command | Tier | Notes |");
    const system = files["references/system.md"];
    expect(system.startsWith("# System & Gateway\n")).toBe(true);
    expect(system).toContain("manifestVersion:");
    expect(system).toContain("`alphaclaw admin GET /api/status` |");
    // A denied op still renders (unavailable > omitted, A40) with its hint.
    expect(files["references/watchdog.md"]).toContain("not available to you");
    expect(files["references/errors.md"]).toContain("`confirm_required` (HTTP 428)");
  });

  it("masks admin targets to the last 4 chars (A5)", () => {
    expect(maskTarget("123456789")).toBe("••6789");
    expect(maskTarget("")).toBe("(unset)");
    const content = buildAdminSkillContent({
      fs,
      manifest: getManifest(),
      liveState: {
        adminTargets: [{ channel: "telegram", label: "ops", target: "987654321" }],
      },
    });
    expect(content).toContain("••4321");
    expect(content).not.toContain("987654321");
  });

  it("renders the no-admin-targets notice when none configured", () => {
    const content = buildAdminSkillContent({
      fs,
      manifest: getManifest(),
      liveState: { adminTargets: [] },
    });
    expect(content).toContain("No admin notification targets are configured");
  });

  // On-demand skills are NOT under the 20k/150k always-injected bootstrap
  // budget; these caps keep context cost bounded as domains grow. The skill
  // used to be one SKILL.md capped at 63k, so every new op had to trim another
  // domain's text. Now SKILL.md is a short index (rules, admins, live state,
  // recipes, one line per domain) and each domain is its own reference file
  // the agent reads only when it needs it: a new op spends only its own
  // domain's budget, and a new domain adds one index row. On the maximal
  // fixture (10 admins, every channel) the index is about 11k and the largest
  // domain file (watchdog) about 6.7k.
  //
  // OpenClaw (2026.10.7) serves a skill file through the read tool only whole:
  // past max(32 KiB, 10% of the model's context at 4 chars per token) it
  // answers "Skill instructions cannot be partially served" instead. The old
  // 62.7 KB single file was refused that way for a 128k-context model, so every
  // file here also stays under the 32 KiB floor, which holds for any model.
  const kIndexMaxChars = 16000;
  const kReferenceFileMaxChars = 12000;
  const kOpenclawReadFloorBytes = 32 * 1024;

  it("keeps the index and every reference file within their own budgets on a maximal fixture", () => {
    const files = buildMaximalFiles();
    const content = files["SKILL.md"];
    // The machine + autotune lines render in Current State.
    expect(content).toContain(
      "- Machine: medium tier — 4.0 GB RAM, 2 vCPU, GPU: NVIDIA A10G",
    );
    expect(content).toContain(
      "- Resource autotune: on (agent concurrency cap 32) — details: `alphaclaw admin GET /api/autotune`",
    );
    expect(content.length).toBeLessThan(kIndexMaxChars);
    const oversized = referenceEntries(files)
      .filter(([, text]) => text.length >= kReferenceFileMaxChars)
      .map(([name, text]) => `${name}: ${text.length}`);
    expect(oversized).toEqual([]);
    for (const [name, text] of Object.entries(files)) {
      expect(Buffer.byteLength(text, "utf8"), name).toBeLessThan(kOpenclawReadFloorBytes);
    }
  });

  it("keeps every op reachable: each command is in its own domain's file, and each file is linked from the index", () => {
    const files = buildMaximalFiles();
    const index = files["SKILL.md"];
    const { ops } = getManifest();
    const missing = [];
    for (const op of ops) {
      const command = `\`alphaclaw admin ${op.method} ${op.path}\``;
      const owner = files[`references/${op.domain}.md`] || "";
      if (!owner.includes(command)) missing.push(op.id);
    }
    expect(missing).toEqual([]);

    const linked = Array.from(index.matchAll(/\]\((references\/[a-z0-9-]+\.md)\)/g), (m) => m[1]);
    const produced = referenceEntries(files).map(([name]) => name);
    expect(new Set(linked)).toEqual(new Set(produced));
    for (const domain of new Set(ops.map((op) => op.domain))) {
      expect(produced).toContain(`references/${domain}.md`);
    }
    // The cross-domain recipes stay in the index.
    expect(index).toContain("## Quick Recipes");
    expect(index).toContain("alphaclaw admin PATCH /api/env --data-stdin");
  });

  it("renders every fragment file somewhere in the skill", () => {
    const files = buildMaximalFiles();
    const domains = new Set(getManifest().ops.map((op) => op.domain));
    const sections = new Set(["_intro", "_calling", "_rules", "_recipes", "_errors"]);
    const orphans = fs
      .readdirSync(kFragmentsDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .filter((name) => !domains.has(name) && !sections.has(name));
    expect(orphans).toEqual([]);
    for (const domain of domains) {
      const fragmentPath = path.join(kFragmentsDir, `${domain}.md`);
      if (!fs.existsSync(fragmentPath)) continue;
      const firstLine = fs.readFileSync(fragmentPath, "utf8").split("\n").find((line) => line.trim());
      expect(files[`references/${domain}.md`]).toContain(firstLine.trim());
    }
  });

  it("names every domain in the index with its title and summary", () => {
    const index = buildMaximalFiles()["SKILL.md"];
    const domains = new Set(getManifest().ops.map((op) => op.domain));
    for (const { domain, title, summary } of getDomains()) {
      if (!domains.has(domain)) continue;
      expect(index).toContain(`| ${title} | [references/${domain}.md](references/${domain}.md) |`);
      expect(index).toContain(` | ${summary} |`);
    }
  });

  it("renders no-GPU/autotune-off machine state and omits the lines when machine is absent", () => {
    const content = buildAdminSkillContent({
      fs,
      manifest: getManifest(),
      liveState: {
        adminTargets: [],
        machine: {
          tier: "small",
          memoryGb: 2.0,
          cores: 1,
          gpuLabel: null,
          autotuneEnabled: false,
          agentConcurrencyCap: null,
        },
      },
    });
    expect(content).toContain("- Machine: small tier — 2.0 GB RAM, 1 vCPU, no GPU");
    // Off + no cap: no parenthetical, still points at the autotune API.
    expect(content).toContain(
      "- Resource autotune: off — details: `alphaclaw admin GET /api/autotune`",
    );

    // Fail-open: no machine object → no machine lines, skill still builds.
    const withoutMachine = buildAdminSkillContent({
      fs,
      manifest: getManifest(),
      liveState: { adminTargets: [] },
    });
    expect(withoutMachine).not.toContain("- Machine:");
    expect(withoutMachine).not.toContain("- Resource autotune:");
  });

  it("sanitizes a markdown-injection GPU name through toTableCell", () => {
    const content = buildAdminSkillContent({
      fs,
      manifest: getManifest(),
      liveState: {
        adminTargets: [],
        machine: {
          tier: "large",
          memoryGb: 8.0,
          cores: 4,
          gpuLabel: "NVIDIA | `evil` [x](y)",
          autotuneEnabled: true,
          agentConcurrencyCap: 32,
        },
      },
    });
    // Pipes escaped so a hostile nvidia-smi name cannot break table/markdown
    // structure; the rest survives as inert text.
    expect(content).toContain("GPU: NVIDIA \\| `evil` [x](y)");
    expect(content).not.toContain("GPU: NVIDIA | `evil`");
  });

  it("gathers a machine snapshot into live state (fail-open)", () => {
    const openclawDir = makeOpenclawDir();
    const state = gatherLiveState({ fs, openclawDir });
    // Real host profile: exact numbers vary, the shape and vocabulary don't.
    expect(state.machine).toBeTruthy();
    expect(["micro", "small", "medium", "large", "xl"]).toContain(
      state.machine.tier,
    );
    expect(typeof state.machine.autotuneEnabled).toBe("boolean");
  });

  it("installs the skill only when the flag is on AND a token exists", () => {
    const openclawDir = makeOpenclawDir();
    const skillPath = path.join(openclawDir, "skills", "alphaclaw-admin", "SKILL.md");

    // Flag off → no skill.
    let result = installAlphaclawAdminSkill({ fs, openclawDir });
    expect(result.installed).toBe(false);
    expect(fs.existsSync(skillPath)).toBe(false);

    // Flag on, token present → installed, index plus every reference file;
    // a reference file the manifest no longer produces is deleted.
    updateAgentAdminFeature({ fsModule: fs, openclawDir, enabled: true });
    tokenStore.ensureToken({ fsModule: fs, openclawDir });
    const referencesDir = path.join(path.dirname(skillPath), "references");
    fs.mkdirSync(referencesDir, { recursive: true });
    fs.writeFileSync(path.join(referencesDir, "retired-domain.md"), "# Retired\n");
    result = installAlphaclawAdminSkill({ fs, openclawDir });
    expect(result.installed).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(true);
    const index = fs.readFileSync(skillPath, "utf8");
    const linked = Array.from(index.matchAll(/\]\(references\/([a-z0-9-]+\.md)\)/g), (m) => m[1]);
    expect(linked.length).toBeGreaterThan(20);
    expect(fs.readdirSync(referencesDir).sort()).toEqual([...new Set(linked)].sort());
    expect(fs.readFileSync(path.join(referencesDir, "webhooks.md"), "utf8")).toContain(
      "`alphaclaw admin GET /api/webhooks`",
    );

    // Flag back off → skill and its reference files removed.
    updateAgentAdminFeature({ fsModule: fs, openclawDir, enabled: false });
    result = installAlphaclawAdminSkill({ fs, openclawDir });
    expect(result.installed).toBe(false);
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(fs.existsSync(referencesDir)).toBe(false);
  });

  it("does not install (or advertise) when the flag is on but the token is missing", () => {
    const openclawDir = makeOpenclawDir();
    updateAgentAdminFeature({ fsModule: fs, openclawDir, enabled: true });
    // No ensureToken → no token file.
    const result = installAlphaclawAdminSkill({ fs, openclawDir });
    expect(result.installed).toBe(false);
    expect(renderToolsStanza({ fs, openclawDir })).toBe("");
  });

  it("renders the TOOLS.md stanza only once the skill is installed", () => {
    const openclawDir = makeOpenclawDir();
    expect(renderToolsStanza({ fs, openclawDir })).toBe("");
    updateAgentAdminFeature({ fsModule: fs, openclawDir, enabled: true });
    tokenStore.ensureToken({ fsModule: fs, openclawDir });
    installAlphaclawAdminSkill({ fs, openclawDir });
    const stanza = renderToolsStanza({ fs, openclawDir });
    expect(stanza).toContain("### AlphaClaw Administration");
    expect(stanza).toContain("alphaclaw admin GET /api/status");
    expect(stanza.length).toBeLessThan(700);
  });
});
