const realFs = require("fs");
const path = require("path");
const { syncBootstrapPromptFiles } = require("../../lib/server/onboarding/workspace");
const { OPENCLAW_DIR, WORKSPACE_DIR, kSetupDir } = require("../../lib/server/constants");
const { kRegistryPath, renderTopicRegistryMarkdown } = require("../../lib/server/topic-registry");
const { findTruncatedSections } = require("../../lib/server/doctor/context-profiles");

// The merged bootstrap file outgrew OpenClaw's 20,000-char per-file cap on a
// box with a large topic registry, and OpenClaw cut its middle. These tests
// pin the split (rules file, reference file) and the reference budget.
describe("bootstrap files stay under OpenClaw's per-file cap", () => {
  const kToolsTemplatePath = path.join(kSetupDir, "core-prompts", "TOOLS.md");
  const kAgentsTemplatePath = path.join(kSetupDir, "core-prompts", "AGENTS.md");
  const kConfigPath = path.join(OPENCLAW_DIR, "openclaw.json");
  const kGoogleStatePath = path.join(OPENCLAW_DIR, "gogcli", "state.json");
  const kRulesPath = path.join(WORKSPACE_DIR, "hooks", "bootstrap", "AGENTS.md");
  const kReferencePath = path.join(WORKSPACE_DIR, "hooks", "bootstrap", "reference", "AGENTS.md");

  // 6 groups x 60 named topics (50 render per group) + 15 discovered each.
  const buildLargeRegistry = () => {
    const groups = {};
    for (let g = 0; g < 6; g += 1) {
      const topics = {};
      for (let t = 0; t < 60; t += 1) {
        topics[String(1000 + t)] = { name: "Project workstream " + g + "-" + t + " planning and review" };
      }
      for (let d = 0; d < 15; d += 1) {
        topics[String(5000 + d)] = { discovered: true, lastSeenAt: 1700000000000 + d, seenAgentId: "main" };
      }
      groups["-100200300" + g] = { channel: "telegram", name: "Operations group " + g, topics };
    }
    return { version: 2, meta: { sweepWatermark: 0 }, groups };
  };

  const googleState = JSON.stringify({
    version: 2,
    accounts: Array.from({ length: 6 }, (_, i) => ({
      id: "acc" + i,
      email: "person" + i + "@example.com",
      client: "default",
      personal: i % 2 === 0,
      authenticated: true,
      services: ["gmail:read", "calendar:read", "drive:read"],
    })),
    gmailPush: { token: "", topics: {} },
  });

  const telegramGroups = Object.fromEntries(
    Array.from({ length: 6 }, (_, g) => ["-100200300" + g, { enabled: true }]),
  );

  const makeFs = (config) => ({
    readFileSync: vi.fn((target) => {
      if (target === kToolsTemplatePath || target === kAgentsTemplatePath) {
        return realFs.readFileSync(target, "utf8");
      }
      if (target === kConfigPath) return JSON.stringify(config);
      if (target === kGoogleStatePath) return googleState;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    existsSync: vi.fn((target) => target === kGoogleStatePath),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  });
  const written = (mockFs, target) =>
    mockFs.writeFileSync.mock.calls.find(([filePath]) => filePath === target)?.[1];

  beforeEach(() => {
    const registry = JSON.stringify(buildLargeRegistry());
    const original = realFs.readFileSync;
    vi.spyOn(realFs, "readFileSync").mockImplementation((target, ...rest) =>
      target === kRegistryPath ? registry : original.call(realFs, target, ...rest),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a large registry would overflow one file on its own", () => {
    const fullSection = renderTopicRegistryMarkdown({ includeSyncGuidance: true, telegramEnabled: true });
    expect(fullSection.length).toBeGreaterThan(20000);
  });

  it("keeps the rules file and the reference file under the cap with margin", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onOverCap = vi.fn();
    const mockFs = makeFs({ channels: { telegram: { groups: telegramGroups } } });

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
      onOverCap,
    });

    const rules = written(mockFs, kRulesPath);
    const reference = written(mockFs, kReferencePath);
    expect(rules.length).toBeLessThan(17000);
    expect(reference.length).toBeLessThanOrEqual(17000);
    expect(findTruncatedSections(rules, 20000)).toEqual([]);
    expect(findTruncatedSections(reference, 20000)).toEqual([]);
    expect(onOverCap).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("per-file injection cap"));

    // Safety and git rules open the rules file; operator data lives only in
    // the reference file.
    expect(rules.indexOf("git pull --ff-only")).toBeGreaterThan(-1);
    expect(rules.indexOf("git pull --ff-only")).toBeLessThan(rules.indexOf("## AlphaClaw Harness"));
    expect(rules).not.toContain("## Topic Registry");
    expect(rules).not.toContain("person0@example.com");

    // The reference file keeps every Google account, the sync rules and as
    // many topics as fit, and says how to list the rest.
    for (let i = 0; i < 6; i += 1) expect(reference).toContain("person" + i + "@example.com");
    expect(reference).toContain("### Sync Rules");
    expect(reference).toContain("| Operations group 0 (-1002003000) | Project workstream 0-0 planning and review | 1000 |");
    expect(reference).toMatch(/\(\d+ more topics not shown — run `alphaclaw telegram topics list` for the full set\.\)/);
  });

  it("honors a lowered bootstrapMaxChars and reports the rules sections OpenClaw would cut", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onOverCap = vi.fn();
    const mockFs = makeFs({
      channels: { telegram: { groups: telegramGroups } },
      agents: { defaults: { bootstrapMaxChars: 6000 } },
    });

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
      onOverCap,
    });

    // The reference file shrinks to fit 85% of the lowered cap...
    const reference = written(mockFs, kReferencePath);
    expect(reference.length).toBeLessThanOrEqual(5100);
    expect(findTruncatedSections(reference, 6000)).toEqual([]);
    // ...but the rules file cannot, so it is reported once, by section.
    expect(onOverCap).toHaveBeenCalledTimes(1);
    const report = onOverCap.mock.calls[0][0];
    expect(report).toMatchObject({ path: "hooks/bootstrap/AGENTS.md", capChars: 6000 });
    expect(report.chars).toBeGreaterThan(6000);
    expect(report.sections.length).toBeGreaterThan(0);
    expect(report.sections).toEqual(findTruncatedSections(written(mockFs, kRulesPath), 6000));
  });
});

describe("findTruncatedSections", () => {
  const doc = ["# Rules", "r".repeat(400), "## Middle", "m".repeat(400), "## End", "e".repeat(150)].join("\n");

  it("returns nothing for a file within the cap", () => {
    expect(findTruncatedSections(doc, doc.length)).toEqual([]);
    expect(findTruncatedSections(doc + "\n\n\n", doc.length)).toEqual([]);
  });

  it("uses OpenClaw's AGENTS.md split: 45% head, 15% tail", () => {
    // cap 900: head 405 ends just inside Rules; tail 135 starts inside End.
    expect(findTruncatedSections(doc, 900)).toEqual(["Rules", "Middle", "End"]);
    // cap 960: head 432 covers Rules; tail 144 starts inside End.
    expect(findTruncatedSections(doc, 960)).toEqual(["Middle", "End"]);
  });

  it("uses the 75/25 split for other basenames and ignores headings in code fences", () => {
    const fenced = ["## Keep", "k".repeat(500), "```", "## Not a heading", "```", "## Cut", "c".repeat(500)].join("\n");
    expect(findTruncatedSections(fenced, 800, "SOUL.md")).toEqual(["Cut"]);
  });
});
