const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildDeterministicCards } = require("../../lib/server/doctor/deterministic-checks");
const { analyzeBootstrapContext } = require("../../lib/server/doctor/bootstrap-context");
const {
  kBeta81Profile,
  kStableProfile,
} = require("../../lib/server/doctor/context-profiles");

describe("server/doctor/deterministic-checks", () => {
  let workspaceRoot;
  let managedRoot;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-det-ws-"));
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-det-managed-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(managedRoot, { recursive: true, force: true });
  });

  const write = (rootDir, relativePath, content) => {
    const fullPath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  };

  const build = (overrides = {}) =>
    buildDeterministicCards({
      workspaceRoot,
      managedRoot,
      profile: kStableProfile,
      bootstrapContext: analyzeBootstrapContext({
        workspaceRoot,
        profile: overrides.profile || kStableProfile,
        ...(overrides.bootstrapArgs || {}),
      }),
      onboarded: true,
      releaseChannel: "stable",
      ...overrides,
    });

  const findCard = (cards, sourceKey) =>
    cards.find((card) => card.sourceKey === sourceKey);

  it("flags retired root files on the beta profile only", () => {
    write(workspaceRoot, "TOOLS.md", "tool notes");
    write(workspaceRoot, "HEARTBEAT.md", "beat");

    const betaCards = build({ profile: kBeta81Profile });
    expect(findCard(betaCards, "det:retired:TOOLS.md")).toMatchObject({
      priority: "P1",
      source: "deterministic",
    });
    expect(findCard(betaCards, "det:retired:HEARTBEAT.md")).toBeTruthy();

    const stableCards = build({ profile: kStableProfile });
    expect(findCard(stableCards, "det:retired:TOOLS.md")).toBeUndefined();
  });

  it("raises the hardening P0 when the bootstrap context reports blocked", () => {
    write(workspaceRoot, "hooks/bootstrap/TOOLS.md", "hardening tools");
    const cards = build({
      profile: kBeta81Profile,
      bootstrapArgs: {
        extraFilePaths: ["hooks/bootstrap/TOOLS.md"],
        hooksEnabled: true,
      },
    });
    const hardening = findCard(cards, "det:hardening");
    expect(hardening).toMatchObject({ priority: "P0", category: "project context" });
    // Advisory-only fixPrompt: never targets the locked hooks/bootstrap path.
    expect(hardening.fixPrompt).toContain("Do not edit files under hooks/bootstrap/");
    expect(hardening.targetPaths).toEqual([]);
  });

  it("raises the hardening P0 when extras are starved by the total budget", () => {
    write(workspaceRoot, "AGENTS.md", "A".repeat(200));
    write(workspaceRoot, "hooks/bootstrap/AGENTS.md", "H".repeat(100));
    const cards = build({
      profile: kBeta81Profile,
      bootstrapArgs: {
        extraFilePaths: ["hooks/bootstrap/AGENTS.md"],
        hooksEnabled: true,
        bootstrapMaxChars: 300,
        bootstrapTotalMaxChars: 220,
      },
    });
    expect(findCard(cards, "det:hardening")).toMatchObject({ priority: "P0" });
  });

  it("flags non-AlphaClaw invalid extras as P1", () => {
    write(workspaceRoot, "notes/EXTRA.md", "user extra");
    const cards = build({
      profile: kBeta81Profile,
      bootstrapArgs: {
        extraFilePaths: ["notes/EXTRA.md"],
        hooksEnabled: true,
      },
    });
    expect(findCard(cards, "det:extra-invalid:notes/EXTRA.md")).toMatchObject({
      priority: "P1",
    });
    expect(findCard(cards, "det:hardening")).toBeUndefined();
  });

  it("grades MEMORY.md budget pressure as near (P2) then over (P1)", () => {
    write(workspaceRoot, "MEMORY.md", "M".repeat(90));
    const nearCards = build({
      bootstrapArgs: { bootstrapMaxChars: 100, bootstrapTotalMaxChars: 60000 },
    });
    expect(findCard(nearCards, "det:memory-budget")).toMatchObject({
      priority: "P2",
      category: "memory hygiene",
    });

    write(workspaceRoot, "MEMORY.md", "M".repeat(150));
    const overCards = build({
      bootstrapArgs: { bootstrapMaxChars: 100, bootstrapTotalMaxChars: 60000 },
    });
    expect(findCard(overCards, "det:memory-budget")).toMatchObject({ priority: "P1" });
  });

  it("flags MEMORY.md and memory.md coexisting", () => {
    write(workspaceRoot, "MEMORY.md", "curated");
    write(workspaceRoot, "memory.md", "legacy");
    const cards = build({});
    expect(findCard(cards, "det:memory-case")).toMatchObject({
      priority: "P1",
      targetPaths: [{ path: "memory.md" }],
    });
  });

  it("flags a BOOTSTRAP.md leftover only after onboarding", () => {
    write(workspaceRoot, "BOOTSTRAP.md", "ritual");
    expect(findCard(build({}), "det:bootstrap-leftover")).toMatchObject({
      priority: "P2",
    });
    expect(
      findCard(build({ onboarded: false }), "det:bootstrap-leftover"),
    ).toBeUndefined();
  });

  it("estimates skills prompt bloat and fires at the 85% band", () => {
    // 12 skills x (97 overhead + ~1400 desc) ≈ 18k — over the char limit.
    for (let index = 0; index < 12; index += 1) {
      write(
        workspaceRoot,
        `skills/skill-${index}/SKILL.md`,
        `---\nname: skill-${index}\ndescription: ${"d".repeat(1400)}\n---\nbody`,
      );
    }
    const overCards = build({});
    expect(findCard(overCards, "det:skills-bloat")).toMatchObject({
      priority: "P1",
      category: "skills",
    });

    // 3 small skills: far below every threshold — no card.
    fs.rmSync(path.join(workspaceRoot, "skills"), { recursive: true, force: true });
    for (let index = 0; index < 3; index += 1) {
      write(
        workspaceRoot,
        `skills/small-${index}/SKILL.md`,
        `---\nname: small-${index}\ndescription: tiny\n---\nbody`,
      );
    }
    expect(findCard(build({}), "det:skills-bloat")).toBeUndefined();

    // Custom lower limits via config overrides push the small set over.
    expect(
      findCard(
        build({ skillsLimits: { maxSkillsInPrompt: 3 } }),
        "det:skills-bloat",
      ),
    ).toMatchObject({ priority: "P1" });
  });

  it("caps the skills scan depth and candidate count", () => {
    // A SKILL.md nested deeper than 6 levels is ignored.
    write(
      workspaceRoot,
      "skills/a/b/c/d/e/f/g/SKILL.md",
      "---\nname: deep\ndescription: x\n---\n",
    );
    expect(findCard(build({}), "det:skills-bloat")).toBeUndefined();
  });

  it("flags disabled git sync from the managed cron state", () => {
    write(managedRoot, "cron/system-sync.json", JSON.stringify({ enabled: false }));
    expect(findCard(build({}), "det:git-sync-disabled")).toMatchObject({
      priority: "P1",
      category: "workspace state",
    });

    write(managedRoot, "cron/system-sync.json", JSON.stringify({ enabled: true }));
    expect(findCard(build({}), "det:git-sync-disabled")).toBeUndefined();
  });

  it("tolerates unreadable git sync state", () => {
    write(managedRoot, "cron/system-sync.json", "{not json");
    expect(() => build({})).not.toThrow();
  });

  it("emits the dev-channel contract card only on the dev channel", () => {
    expect(
      findCard(build({ releaseChannel: "dev" }), "det:dev-contract-unverified"),
    ).toMatchObject({ priority: "P2" });
    expect(
      findCard(build({ releaseChannel: "beta" }), "det:dev-contract-unverified"),
    ).toBeUndefined();
  });

  it("marks every card as open, deterministic-sourced, with a stable sourceKey", () => {
    write(workspaceRoot, "BOOTSTRAP.md", "ritual");
    write(workspaceRoot, "MEMORY.md", "curated");
    write(workspaceRoot, "memory.md", "legacy");
    for (const card of build({})) {
      expect(card.status).toBe("open");
      expect(card.source).toBe("deterministic");
      expect(card.sourceKey.startsWith("det:")).toBe(true);
      expect(card.fixPrompt.length).toBeGreaterThan(0);
    }
  });
});
