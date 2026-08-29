const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  analyzeBootstrapContext,
  buildBootstrapTruncationCards,
  createBootstrapContextAnalyzer,
  formatChars,
} = require("../../lib/server/doctor/bootstrap-context");
const {
  kBeta81Profile,
  kStableProfile,
} = require("../../lib/server/doctor/context-profiles");

describe("server/doctor/bootstrap-context", () => {
  let workspaceRoot;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bootstrap-ctx-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const write = (relativePath, content) => {
    const fullPath = path.join(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  };

  it("defaults to the verified upstream budgets (60k total, 0.85 near-limit)", () => {
    write("AGENTS.md", "short");
    const context = analyzeBootstrapContext({ workspaceRoot });
    expect(context.bootstrapMaxChars).toBe(20000);
    expect(context.bootstrapTotalMaxChars).toBe(60000);
    expect(context.estimated).toBe(true);
    expect(context.profileId).toBe("stable-2026.7");
  });

  it("marks files truncated by both the per-file and total limits", () => {
    write("AGENTS.md", "A".repeat(300));
    write("SOUL.md", "B".repeat(300));
    write("TOOLS.md", "C".repeat(100));

    const context = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
      bootstrapMaxChars: 200,
      bootstrapTotalMaxChars: 300,
    });

    const agents = context.files.find((file) => file.path === "AGENTS.md");
    const soul = context.files.find((file) => file.path === "SOUL.md");
    const tools = context.files.find((file) => file.path === "TOOLS.md");

    expect(agents.reason).toBe("file_limit");
    expect(agents.injectedChars).toBe(200);
    expect(soul.reason).toBe("file_and_total_limit");
    expect(soul.truncatedByFileLimit).toBe(true);
    expect(soul.truncatedByTotalLimit).toBe(true);
    expect(soul.injectedChars).toBe(100);
    // TOOLS.md hits the <64-char remaining-budget floor: skipped entirely.
    expect(tools.reason).toBe("starved");
    expect(tools.skipped).toBe(true);
    expect(tools.injectedChars).toBe(0);
    expect(context.hasTotalLimitTruncation).toBe(true);
    expect(context.totalLimitReached).toBe(true);
  });

  it("skips a file entirely when under 64 chars of total budget remain", () => {
    write("AGENTS.md", "A".repeat(150));
    write("SOUL.md", "B".repeat(100));

    const context = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
      bootstrapMaxChars: 200,
      bootstrapTotalMaxChars: 200,
    });

    const soul = context.files.find((file) => file.path === "SOUL.md");
    expect(soul.skipped).toBe(true);
    expect(soul.reason).toBe("starved");
  });

  it("spends the total budget in injection order — hook extras starve first", () => {
    write("AGENTS.md", "A".repeat(200));
    write("hooks/bootstrap/AGENTS.md", "H".repeat(100));

    const context = analyzeBootstrapContext({
      workspaceRoot,
      profile: kBeta81Profile,
      extraFilePaths: ["hooks/bootstrap/AGENTS.md"],
      hooksEnabled: true,
      bootstrapMaxChars: 300,
      bootstrapTotalMaxChars: 220,
    });

    const root = context.files.find((file) => file.path === "AGENTS.md");
    const extra = context.files.find(
      (file) => file.path === "hooks/bootstrap/AGENTS.md",
    );
    expect(root.injectedChars).toBe(200);
    expect(extra.skipped).toBe(true);
    expect(context.hardening.state).toBe("starved");
  });

  it("applies the fixed USER.md cap on the beta profile only", () => {
    write("USER.md", "U".repeat(5000));

    const beta = analyzeBootstrapContext({
      workspaceRoot,
      profile: kBeta81Profile,
    });
    const betaUser = beta.files.find((file) => file.path === "USER.md");
    expect(betaUser.capChars).toBe(4000);
    expect(betaUser.truncatedByFileLimit).toBe(true);

    const stable = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
    });
    const stableUser = stable.files.find((file) => file.path === "USER.md");
    expect(stableUser.capChars).toBe(20000);
    expect(stableUser.truncatedByFileLimit).toBe(false);
  });

  it("gates BOOTSTRAP.md on onboarding state instead of an injectMode flag", () => {
    write("BOOTSTRAP.md", "setup ritual");

    const onboarded = analyzeBootstrapContext({ workspaceRoot, onboarded: true });
    const pending = analyzeBootstrapContext({ workspaceRoot, onboarded: false });

    expect(
      onboarded.files.find((file) => file.path === "BOOTSTRAP.md").active,
    ).toBe(false);
    expect(
      onboarded.files.find((file) => file.path === "BOOTSTRAP.md").activeReason,
    ).toBe("setup_gated");
    expect(pending.files.find((file) => file.path === "BOOTSTRAP.md").active).toBe(
      true,
    );
  });

  it("includes MEMORY.md in the injected set and excludes retired files on beta", () => {
    const stablePaths = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
    }).files.map((file) => file.path);
    const betaPaths = analyzeBootstrapContext({
      workspaceRoot,
      profile: kBeta81Profile,
    }).files.map((file) => file.path);

    expect(stablePaths).toContain("MEMORY.md");
    expect(stablePaths).toContain("TOOLS.md");
    expect(betaPaths).toContain("MEMORY.md");
    expect(betaPaths).not.toContain("TOOLS.md");
    expect(betaPaths).not.toContain("HEARTBEAT.md");
  });

  it("marks extras with basenames outside the profile allowlist as blocked", () => {
    write("hooks/bootstrap/AGENTS.md", "rules");
    write("hooks/bootstrap/TOOLS.md", "tools map");

    const context = analyzeBootstrapContext({
      workspaceRoot,
      profile: kBeta81Profile,
      extraFilePaths: ["hooks/bootstrap/AGENTS.md", "hooks/bootstrap/TOOLS.md"],
      hooksEnabled: true,
    });

    const tools = context.files.find(
      (file) => file.path === "hooks/bootstrap/TOOLS.md",
    );
    expect(tools.injectable).toBe(false);
    expect(tools.activeReason).toBe("invalid_basename");
    expect(context.blockedExtraFiles.map((file) => file.path)).toEqual([
      "hooks/bootstrap/TOOLS.md",
    ]);
    expect(context.hardening.state).toBe("blocked");

    const stableContext = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
      extraFilePaths: ["hooks/bootstrap/AGENTS.md", "hooks/bootstrap/TOOLS.md"],
      hooksEnabled: true,
    });
    expect(stableContext.blockedExtraFiles).toEqual([]);
    expect(stableContext.hardening.state).toBe("injected");
  });

  it("treats a disabled hook as blocked hardening", () => {
    write("hooks/bootstrap/AGENTS.md", "rules");
    const context = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
      extraFilePaths: ["hooks/bootstrap/AGENTS.md"],
      hooksEnabled: false,
    });
    expect(context.hardening.state).toBe("blocked");
  });

  it("reports hardening unknown when no hooks/bootstrap extras exist", () => {
    write("AGENTS.md", "short");
    const context = analyzeBootstrapContext({ workspaceRoot });
    expect(context.hardening.state).toBe("unknown");
  });

  it("computes near-limit at 0.85 per file and for the total budget", () => {
    write("AGENTS.md", "A".repeat(90));

    const context = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
      bootstrapMaxChars: 100,
      bootstrapTotalMaxChars: 100,
    });

    const agents = context.files.find((file) => file.path === "AGENTS.md");
    expect(agents.nearFileLimit).toBe(true);
    expect(context.hasActiveNearLimitFiles).toBe(true);
    expect(context.nearTotalLimit).toBe(true);
    expect(context.hasActiveTruncation).toBe(false);
  });

  it("builds a leading total-limit card alongside per-file truncation cards", () => {
    write("AGENTS.md", "A".repeat(300));
    write("SOUL.md", "B".repeat(300));

    const context = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
      bootstrapMaxChars: 200,
      bootstrapTotalMaxChars: 300,
    });
    const cards = buildBootstrapTruncationCards(context);

    expect(cards.length).toBe(2);
    expect(cards[0]).toMatchObject({
      priority: "P0",
      category: "project context",
      title: "Project Context total bootstrap limit is truncating injected files",
      targetPaths: [{ path: "SOUL.md" }],
      status: "open",
    });
    expect(cards[0].evidence).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("SOUL.md: raw 300 chars, injected 100 chars"),
      }),
    ]);
    expect(cards[1].title).toBe("AGENTS.md is being truncated in Project Context");
    // The corrected truncation model (75/25 + visible warning), never the old
    // "70/20/10 without a warning" myth.
    expect(cards[1].recommendation).toContain("first 75%");
    expect(cards[1].recommendation).not.toContain("without a warning");
  });

  it("describes starved files in the total-limit card evidence", () => {
    write("AGENTS.md", "A".repeat(200));
    write("SOUL.md", "B".repeat(100));

    const context = analyzeBootstrapContext({
      workspaceRoot,
      profile: kStableProfile,
      bootstrapMaxChars: 200,
      bootstrapTotalMaxChars: 200,
    });
    const cards = buildBootstrapTruncationCards(context);
    expect(cards[0].evidence[0].text).toContain("skipped entirely");
  });

  it("returns no cards when there is no active truncation", () => {
    write("AGENTS.md", "short");

    expect(buildBootstrapTruncationCards(null)).toEqual([]);
    expect(
      buildBootstrapTruncationCards(analyzeBootstrapContext({ workspaceRoot })),
    ).toEqual([]);
  });

  it("formats character counts", () => {
    expect(formatChars(20000)).toBe("20,000 chars");
    expect(formatChars()).toBe("0 chars");
  });

  describe("createBootstrapContextAnalyzer", () => {
    const writeConfig = (managedRoot, config) => {
      fs.writeFileSync(
        path.join(managedRoot, "openclaw.json"),
        JSON.stringify(config),
        "utf8",
      );
    };

    let managedRoot;

    beforeEach(() => {
      managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-managed-"));
    });

    afterEach(() => {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    });

    const makeAnalyzer = ({ profile = kStableProfile } = {}) =>
      createBootstrapContextAnalyzer({
        workspaceRoot,
        managedRoot,
        getProfile: () => profile,
        readOpenclawConfig: ({ openclawDir, fallback }) => {
          try {
            return JSON.parse(
              fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
            );
          } catch {
            return fallback;
          }
        },
        isOnboarded: () => true,
      });

    it("reads the extras list and budgets from openclaw.json", () => {
      write("AGENTS.md", "root rules");
      write("hooks/bootstrap/AGENTS.md", "hardening");
      writeConfig(managedRoot, {
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "bootstrap-extra-files": {
                enabled: true,
                paths: ["hooks/bootstrap/AGENTS.md"],
              },
            },
          },
        },
        agents: { defaults: { bootstrapMaxChars: 111, bootstrapTotalMaxChars: 2222 } },
      });

      const context = makeAnalyzer().analyze();
      expect(context.bootstrapMaxChars).toBe(111);
      expect(context.bootstrapTotalMaxChars).toBe(2222);
      expect(context.hooksEnabled).toBe(true);
      expect(
        context.files.some((file) => file.path === "hooks/bootstrap/AGENTS.md"),
      ).toBe(true);
    });

    it("requires both hooks.internal.enabled and the entry's enabled flag", () => {
      write("hooks/bootstrap/AGENTS.md", "hardening");
      writeConfig(managedRoot, {
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "bootstrap-extra-files": { enabled: false, paths: ["hooks/bootstrap/AGENTS.md"] },
            },
          },
        },
      });
      expect(makeAnalyzer().analyze().hooksEnabled).toBe(false);
    });

    it("invalidates the file cache on mtime/size change", () => {
      write("AGENTS.md", "A".repeat(10));
      const analyzer = makeAnalyzer();
      const first = analyzer.analyze();
      expect(
        first.files.find((file) => file.path === "AGENTS.md").rawChars,
      ).toBe(10);

      const fullPath = path.join(workspaceRoot, "AGENTS.md");
      fs.writeFileSync(fullPath, "A".repeat(25), "utf8");
      // Force a distinct mtime even on coarse-grained filesystems.
      fs.utimesSync(fullPath, new Date(), new Date(Date.now() + 5000));

      const second = analyzer.analyze();
      expect(
        second.files.find((file) => file.path === "AGENTS.md").rawChars,
      ).toBe(25);
    });

    it("re-reads config inputs when openclaw.json changes", () => {
      write("AGENTS.md", "rules");
      writeConfig(managedRoot, {
        agents: { defaults: { bootstrapMaxChars: 100 } },
      });
      const analyzer = makeAnalyzer();
      expect(analyzer.analyze().bootstrapMaxChars).toBe(100);

      writeConfig(managedRoot, {
        agents: { defaults: { bootstrapMaxChars: 300 } },
      });
      const configPath = path.join(managedRoot, "openclaw.json");
      fs.utimesSync(configPath, new Date(), new Date(Date.now() + 5000));
      expect(analyzer.analyze().bootstrapMaxChars).toBe(300);
    });

    it("degrades to defaults with no config reader wired", () => {
      write("AGENTS.md", "rules");
      const analyzer = createBootstrapContextAnalyzer({
        workspaceRoot,
        getProfile: () => kStableProfile,
      });
      const context = analyzer.analyze();
      expect(context.bootstrapMaxChars).toBe(20000);
      expect(context.hooksEnabled).toBe(false);
    });
  });
});
