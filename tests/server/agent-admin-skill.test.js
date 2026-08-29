const fs = require("fs");
const os = require("os");
const path = require("path");
const { getManifest } = require("../../lib/server/admin-manifest");
const {
  buildAdminSkillContent,
  installAlphaclawAdminSkill,
  renderToolsStanza,
  maskTarget,
} = require("../../lib/server/agent-admin/skill");
const tokenStore = require("../../lib/server/agent-admin/token-store");
const {
  updateAgentAdminFeature,
} = require("../../lib/server/alphaclaw-config");

const makeOpenclawDir = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-admin-skill-"));
  const openclawDir = path.join(root, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  return openclawDir;
};

describe("agent-admin skill builder", () => {
  it("builds a SKILL.md with frontmatter, ground rules, and op tables", () => {
    const content = buildAdminSkillContent({
      fs,
      manifest: getManifest(),
      liveState: { adminTargets: [], activeChannels: [], releaseChannel: "stable" },
    });
    expect(content.startsWith("---\nname: alphaclaw-admin")).toBe(true);
    expect(content).toContain("# AlphaClaw Administration");
    expect(content).toContain("manifestVersion:");
    expect(content).toContain("alphaclaw admin GET /api/status");
    // A denied op still renders (unavailable > omitted, A40) with its hint.
    expect(content).toContain("not available to you");
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
  // budget; this guard just keeps context cost bounded as domains grow. A
  // typical deployment renders ~27-35k; the maximal fixture (all 18 domains,
  // 10 admins, every channel) is ~47k. 52k leaves headroom without cutting the
  // op tables, which are the load-bearing content.
  it("stays within the on-demand size budget on a maximal fixture", () => {
    const adminTargets = Array.from({ length: 10 }, (_, i) => ({
      channel: "telegram",
      label: `ops-${i}`,
      target: `55500000${i}`,
    }));
    const content = buildAdminSkillContent({
      fs,
      manifest: getManifest(),
      liveState: {
        adminTargets,
        activeChannels: ["telegram", "discord", "slack", "whatsapp"],
        releaseChannel: "beta",
        restartRequired: true,
      },
    });
    expect(content.length).toBeLessThan(52000);
  });

  it("installs the skill only when the flag is on AND a token exists", () => {
    const openclawDir = makeOpenclawDir();
    const skillPath = path.join(openclawDir, "skills", "alphaclaw-admin", "SKILL.md");

    // Flag off → no skill.
    let result = installAlphaclawAdminSkill({ fs, openclawDir });
    expect(result.installed).toBe(false);
    expect(fs.existsSync(skillPath)).toBe(false);

    // Flag on, token present → installed.
    updateAgentAdminFeature({ fsModule: fs, openclawDir, enabled: true });
    tokenStore.ensureToken({ fsModule: fs, openclawDir });
    result = installAlphaclawAdminSkill({ fs, openclawDir });
    expect(result.installed).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(true);

    // Flag back off → skill removed.
    updateAgentAdminFeature({ fsModule: fs, openclawDir, enabled: false });
    result = installAlphaclawAdminSkill({ fs, openclawDir });
    expect(result.installed).toBe(false);
    expect(fs.existsSync(skillPath)).toBe(false);
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
