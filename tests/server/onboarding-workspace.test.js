const { resolveSetupUiUrl } = require("../../lib/server/onboarding/workspace");

describe("server/onboarding/workspace", () => {
  const kOriginalRailwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;

  afterEach(() => {
    if (typeof kOriginalRailwayPublicDomain === "undefined") {
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
      return;
    }
    process.env.RAILWAY_PUBLIC_DOMAIN = kOriginalRailwayPublicDomain;
  });

  it("falls back to Railway public domain when no explicit base URL is provided", () => {
    process.env.RAILWAY_PUBLIC_DOMAIN = "alphaclaw-production.up.railway.app";

    expect(resolveSetupUiUrl("")).toBe(
      "https://alphaclaw-production.up.railway.app",
    );
  });
});

describe("server/onboarding/workspace resolveSetupUiUrl fallbacks", () => {
  const kOriginalPublic = process.env.RAILWAY_PUBLIC_DOMAIN;
  const kOriginalStatic = process.env.RAILWAY_STATIC_URL;

  afterEach(() => {
    if (typeof kOriginalPublic === "undefined") {
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
    } else {
      process.env.RAILWAY_PUBLIC_DOMAIN = kOriginalPublic;
    }
    if (typeof kOriginalStatic === "undefined") {
      delete process.env.RAILWAY_STATIC_URL;
    } else {
      process.env.RAILWAY_STATIC_URL = kOriginalStatic;
    }
  });

  it("falls back to the Railway static URL when set", () => {
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    process.env.RAILWAY_STATIC_URL = "https://static.example.com//";

    expect(resolveSetupUiUrl("")).toBe("https://static.example.com");
  });

  it("defaults to localhost when no railway env is present", () => {
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    delete process.env.RAILWAY_STATIC_URL;

    expect(resolveSetupUiUrl("")).toBe("http://localhost:3000");
  });
});

describe("server/onboarding/workspace bootstrap prompt sync", () => {
  const realFs = require("fs");
  const path = require("path");
  const {
    syncBootstrapPromptFiles,
    ensureOpenclawRuntimeArtifacts,
  } = require("../../lib/server/onboarding/workspace");
  const {
    OPENCLAW_DIR,
    WORKSPACE_DIR,
    kSetupDir,
  } = require("../../lib/server/constants");
  const { kRegistryPath } = require("../../lib/server/topic-registry");

  const kToolsTemplatePath = path.join(kSetupDir, "core-prompts", "TOOLS.md");
  const kAgentsSourcePath = path.join(kSetupDir, "core-prompts", "AGENTS.md");
  const kConfigPath = path.join(OPENCLAW_DIR, "openclaw.json");
  const kGoogleStatePath = path.join(OPENCLAW_DIR, "gogcli", "state.json");

  const buildTemplateMockFs = ({ tools, agents }) => ({
    readFileSync: vi.fn((target) => {
      if (target === kToolsTemplatePath) return tools;
      if (target === kAgentsSourcePath) return agents;
      if (target === kConfigPath) return "{}";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  });
  const findMergedWrite = (mockFs) =>
    mockFs.writeFileSync.mock.calls.find(
      ([target]) =>
        target === path.join(WORKSPACE_DIR, "hooks", "bootstrap", "AGENTS.md"),
    );

  // #121: the agents template used to be concatenated RAW — a {{TOKEN}} in
  // core-prompts/AGENTS.md would have shipped to the agent literally. This
  // pins that BOTH templates go through the renderer.
  it("substitutes {{TOKEN}} vars in BOTH templates; unknown tokens stay visible (#121)", () => {
    const mockFs = buildTemplateMockFs({
      tools: "Tools state {{STATE_DIR}} env {{ENV_FILE}} setup {{SETUP_UI_URL}}",
      agents: "Agents root {{ROOT_DIR}} state {{STATE_DIR}} typo {{NOT_A_TOKEN}}",
    });

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
      openclawDir: "/home/op/.alphaclaw/.openclaw",
      rootDir: "/home/op/.alphaclaw",
      envFilePath: "/home/op/.alphaclaw/.env",
    });

    const merged = findMergedWrite(mockFs);
    expect(merged).toBeTruthy();
    expect(merged[1]).toContain("Agents root /home/op/.alphaclaw state /home/op/.alphaclaw/.openclaw");
    expect(merged[1]).toContain("Tools state /home/op/.alphaclaw/.openclaw env /home/op/.alphaclaw/.env");
    expect(merged[1]).toContain("setup https://setup.example.com");
    // Typo'd tokens stay visible instead of silently blanking a safety rule.
    expect(merged[1]).toContain("{{NOT_A_TOKEN}}");
  });

  it("real shipped templates render with zero surviving tokens and zero /data (#121)", () => {
    const mockFs = buildTemplateMockFs({
      tools: realFs.readFileSync(kToolsTemplatePath, "utf8"),
      agents: realFs.readFileSync(kAgentsSourcePath, "utf8"),
    });

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
      openclawDir: "/home/user/.alphaclaw/.openclaw",
      rootDir: "/home/user/.alphaclaw",
      envFilePath: "/home/user/.alphaclaw/.env",
    });

    const merged = findMergedWrite(mockFs);
    expect(merged).toBeTruthy();
    expect(merged[1]).not.toContain("{{");
    expect(merged[1]).not.toContain("/data");
    expect(merged[1]).toContain(
      "`$OPENCLAW_STATE_DIR` (this install: `/home/user/.alphaclaw/.openclaw`)",
    );
  });

  it("an unsafe substitution value degrades to the env-var reference (#121)", () => {
    const mockFs = buildTemplateMockFs({
      tools: "State: {{STATE_DIR}}",
      agents: "AGENTS",
    });

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
      openclawDir: "/tmp/evil`touch pwned`\ndir",
      rootDir: "/home/user/.alphaclaw",
      envFilePath: "/home/user/.alphaclaw/.env",
    });

    const merged = findMergedWrite(mockFs);
    expect(merged).toBeTruthy();
    // Validated, not mutated: the hostile value never renders at all.
    expect(merged[1]).toContain("State: $OPENCLAW_STATE_DIR");
    expect(merged[1]).not.toContain("evil");
    expect(merged[1]).not.toContain("`touch");
  });

  const stubRegistryRead = (registry) => {
    const original = realFs.readFileSync;
    vi.spyOn(realFs, "readFileSync").mockImplementation((target, ...rest) => {
      if (target === kRegistryPath) {
        if (registry === null) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return JSON.stringify(registry);
      }
      return original.call(realFs, target, ...rest);
    });
  };

  it("writes bootstrap files for all agent workspaces with topics and google accounts", () => {
    stubRegistryRead({
      groups: {
        "-100123": {
          name: "Ops",
          topics: {
            42: { name: "Deploys" },
          },
        },
      },
    });

    const otherWorkspace = "/tmp/alphaclaw-other-workspace";
    const brokenWorkspace = "/tmp/alphaclaw-broken-workspace";
    const config = JSON.stringify({
      channels: {
        telegram: {
          accounts: {
            midas: {
              groups: { "-100123": { enabled: true } },
            },
          },
        },
      },
      agents: {
        list: [
          { id: "main", workspace: WORKSPACE_DIR },
          { id: "research", workspace: otherWorkspace },
          { id: "", workspace: "/tmp/ignored" },
          { id: "broken", workspace: brokenWorkspace },
        ],
      },
    });
    const googleState = JSON.stringify({
      version: 2,
      accounts: [
        {
          id: "acc1",
          email: "garry@example.com",
          client: "default",
          personal: true,
          authenticated: true,
          services: ["gmail:read"],
        },
        {
          id: "acc2",
          email: "",
          client: "",
          personal: false,
          authenticated: false,
          services: "not-an-array",
        },
      ],
      gmailPush: { token: "", topics: {} },
    });

    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kConfigPath) return config;
        if (target === kGoogleStatePath) return googleState;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn((target) => target === kGoogleStatePath),
      // No renameSync on this mock: writeFileAtomic degrades to a plain
      // writeFileSync at the final path.
      writeFileSync: vi.fn((target) => {
        if (String(target).startsWith(brokenWorkspace)) {
          throw new Error("read-only workspace");
        }
      }),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
      onFailure,
    });

    // ONE merged file per workspace: hardening rules first, tools map after.
    const mainMergedWrite = mockFs.writeFileSync.mock.calls.find(
      ([target]) =>
        target === path.join(WORKSPACE_DIR, "hooks", "bootstrap", "AGENTS.md"),
    );
    expect(mainMergedWrite).toBeTruthy();
    expect(mainMergedWrite[1].startsWith("AGENTS TEMPLATE")).toBe(true);
    expect(mainMergedWrite[1]).toContain("Setup: https://setup.example.com");
    expect(mainMergedWrite[1]).toContain("## Topic Registry");
    expect(mainMergedWrite[1]).toContain("| Ops (-100123) | Deploys | 42 |");
    expect(mainMergedWrite[1]).toContain("### Sync Rules");
    expect(mainMergedWrite[1]).toContain("## Available Google Accounts");
    expect(mainMergedWrite[1]).toContain(
      "- garry@example.com (type: personal; client: default; status: authenticated; services: gmail:read)",
    );
    expect(mainMergedWrite[1]).toContain(
      "- (unknown email) (type: company; client: default; status: awaiting sign-in",
    );

    const otherMergedWrite = mockFs.writeFileSync.mock.calls.find(
      ([target]) =>
        target === path.join(otherWorkspace, "hooks", "bootstrap", "AGENTS.md"),
    );
    expect(otherMergedWrite).toBeTruthy();
    expect(otherMergedWrite[1].startsWith("AGENTS TEMPLATE")).toBe(true);
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    // A separate TOOLS.md is never written anymore (rejected as a
    // bootstrap-extra-files basename on OpenClaw 2026.8.1+).
    expect(
      mockFs.writeFileSync.mock.calls.some(([target]) =>
        String(target).endsWith(path.join("hooks", "bootstrap", "TOOLS.md")),
      ),
    ).toBe(false);
    // The broken workspace's write was ATTEMPTED (the mock throws for it);
    // the sync moved on and the failure surfaced through onFailure (not just
    // the console).
    expect(
      mockFs.writeFileSync.mock.calls.some(
        ([target]) =>
          target === path.join(brokenWorkspace, "hooks", "bootstrap", "AGENTS.md"),
      ),
    ).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `[onboard] Bootstrap prompt sync workspace-sync:${brokenWorkspace} failed: read-only workspace`,
      ),
    );
    expect(onFailure).toHaveBeenCalledWith(
      `workspace-sync:${brokenWorkspace}`,
      expect.objectContaining({ message: "read-only workspace" }),
    );
  });

  it("resolves secondary agent workspaces from the keyed agents.entries map (2026.8)", () => {
    stubRegistryRead(null);
    const otherWorkspace = "/tmp/alphaclaw-entries-workspace";
    const config = JSON.stringify({
      agents: {
        entries: {
          main: { workspace: WORKSPACE_DIR },
          " research ": { workspace: otherWorkspace },
          "no-workspace": {},
        },
      },
    });
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kConfigPath) return config;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
    });

    const mergedTargets = mockFs.writeFileSync.mock.calls
      .map(([target]) => target)
      .filter((target) =>
        String(target).endsWith(path.join("hooks", "bootstrap", "AGENTS.md")),
      );
    expect(mergedTargets).toContain(
      path.join(WORKSPACE_DIR, "hooks", "bootstrap", "AGENTS.md"),
    );
    expect(mergedTargets).toContain(
      path.join(otherWorkspace, "hooks", "bootstrap", "AGENTS.md"),
    );
    // Only the two workspace-bearing entries fan out.
    expect(mergedTargets).toHaveLength(2);
  });

  it("prefers agents.entries over agents.list when both exist (mirror upstream precedence)", () => {
    stubRegistryRead(null);
    const entriesWorkspace = "/tmp/alphaclaw-entries-precedence-workspace";
    const listWorkspace = "/tmp/alphaclaw-list-precedence-workspace";
    const config = JSON.stringify({
      agents: {
        entries: {
          research: { workspace: entriesWorkspace },
        },
        list: [{ id: "stale", workspace: listWorkspace }],
      },
    });
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kConfigPath) return config;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
    });

    const mergedTargets = mockFs.writeFileSync.mock.calls
      .map(([target]) => target)
      .filter((target) =>
        String(target).endsWith(path.join("hooks", "bootstrap", "AGENTS.md")),
      );
    expect(mergedTargets).toContain(
      path.join(entriesWorkspace, "hooks", "bootstrap", "AGENTS.md"),
    );
    expect(mergedTargets).not.toContain(
      path.join(listWorkspace, "hooks", "bootstrap", "AGENTS.md"),
    );
  });

  it("advertises the native topic-create action only when enabled with no pending restart", () => {
    const {
      kRestartRequiredFlagPath,
    } = require("../../lib/server/restart-required-flag");
    const config = JSON.stringify({
      channels: {
        telegram: {
          actions: { createForumTopic: true, editForumTopic: true },
          groups: { "-100123": { enabled: true } },
        },
      },
    });
    const makeFs = ({ restartFlagPending }) => ({
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kConfigPath) return config;
        if (target === kRestartRequiredFlagPath) {
          if (restartFlagPending) {
            return JSON.stringify({ reason: "telegram_actions_enabled" });
          }
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
    });
    const toolsContent = (mockFs) =>
      mockFs.writeFileSync.mock.calls.find(([target]) =>
        String(target).endsWith(path.join("hooks", "bootstrap", "AGENTS.md")),
      )[1];

    stubRegistryRead({
      version: 2,
      meta: { sweepWatermark: 0 },
      groups: { "-100123": { name: "Ops", topics: { 42: { name: "Deploys" } } } },
    });

    // Actions enabled + no pending restart flag → the native action line.
    const activeFs = makeFs({ restartFlagPending: false });
    syncBootstrapPromptFiles({
      fs: activeFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
    });
    expect(toolsContent(activeFs)).toContain(
      "The native `createForumTopic` action is enabled",
    );

    // Same config with a pending restart flag → the line is gated off.
    const pendingFs = makeFs({ restartFlagPending: true });
    syncBootstrapPromptFiles({
      fs: pendingFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
    });
    const pendingContent = toolsContent(pendingFs);
    expect(pendingContent).toContain("## Topic Registry");
    expect(pendingContent).not.toContain("The native `createForumTopic` action");
  });

  it("renders the Machine Resources section from the machine profile", () => {
    stubRegistryRead(null);
    const machineProfile = require("../../lib/server/machine-profile");
    const autotune = require("../../lib/server/autotune");
    vi.spyOn(machineProfile, "getMachineProfile").mockReturnValue({
      detectedAt: 1,
      tier: "medium",
      memory: { limitBytes: 4 * 1024 * 1024 * 1024, source: "cgroup-v2" },
      cpu: { cores: 2, hostCores: 8, source: "cgroup-v2" },
      disk: { totalBytes: null, path: null },
      gpu: {
        present: true,
        vendor: "nvidia",
        // Control char: external nvidia-smi output goes through sanitizeLabel.
        devices: [{ name: "NVIDIA\u0000 A10G", vramBytes: null }],
      },
      environment: "container",
    });
    vi.spyOn(autotune, "getAgentConcurrencyCap").mockReturnValue(32);
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-machine-workspace",
      baseUrl: "https://setup.example.com",
    });

    const toolsWrite = mockFs.writeFileSync.mock.calls.find(([target]) =>
      String(target).endsWith(path.join("hooks", "bootstrap", "AGENTS.md")),
    );
    expect(toolsWrite).toBeTruthy();
    const content = toolsWrite[1];
    expect(content).toContain("## Machine Resources");
    expect(content).toContain(
      "- Capacity: medium tier — 4.0 GB RAM, 2 vCPU, GPU: NVIDIA A10G",
    );
    expect(content).toContain("- Agent concurrency cap (autotune): 32");
    expect(content).toContain(
      "run `alphaclaw admin GET /api/watchdog/resources` if agent administration is enabled",
    );
    // Injected into every agent session — the section stays tiny.
    const section = content.slice(content.indexOf("## Machine Resources"));
    expect(section.length).toBeLessThanOrEqual(500);
  });

  it("omits the Machine Resources section when the profile read throws (fail-open)", () => {
    stubRegistryRead(null);
    const machineProfile = require("../../lib/server/machine-profile");
    vi.spyOn(machineProfile, "getMachineProfile").mockImplementation(() => {
      throw new Error("profile exploded");
    });
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-machine-workspace",
      baseUrl: "https://setup.example.com",
    });

    const toolsWrite = mockFs.writeFileSync.mock.calls.find(([target]) =>
      String(target).endsWith(path.join("hooks", "bootstrap", "AGENTS.md")),
    );
    expect(toolsWrite).toBeTruthy();
    // The merged AGENTS.md still writes; only the machine section is missing.
    expect(toolsWrite[1]).toContain("Setup: https://setup.example.com");
    expect(toolsWrite[1]).not.toContain("## Machine Resources");
  });

  it("degrades gracefully when config and google state are unreadable", () => {
    stubRegistryRead(null);
    // Machine profile is host-derived (not routed through the injected fs), so
    // pin it to a throw here to keep the exact-equality assertion meaningful.
    const machineProfile = require("../../lib/server/machine-profile");
    vi.spyOn(machineProfile, "getMachineProfile").mockImplementation(() => {
      throw new Error("profile exploded");
    });
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn((target) => {
        if (target === kGoogleStatePath) {
          throw new Error("stat failed");
        }
        return false;
      }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-sync-workspace",
      baseUrl: "https://setup.example.com",
    });

    const mergedWrite = mockFs.writeFileSync.mock.calls.find(([target]) =>
      String(target).endsWith(path.join("hooks", "bootstrap", "AGENTS.md")),
    );
    expect(mergedWrite).toBeTruthy();
    expect(mergedWrite[1]).toBe("AGENTS TEMPLATE\n\nSetup: https://setup.example.com");
  });

  it("reports through onFailure when bootstrap sync fails entirely", () => {
    const mockFs = {
      readFileSync: vi.fn(() => {
        throw new Error("template missing");
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-sync-workspace",
      baseUrl: "https://setup.example.com",
      onFailure,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[onboard] Bootstrap prompt sync merge-write failed: template missing",
      ),
    );
    expect(onFailure).toHaveBeenCalledWith(
      "merge-write",
      expect.objectContaining({ message: "template missing" }),
    );
  });

  it("survives an onFailure callback that itself throws", () => {
    const mockFs = {
      readFileSync: vi.fn(() => {
        throw new Error("template missing");
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      syncBootstrapPromptFiles({
        fs: mockFs,
        workspaceDir: "/tmp/alphaclaw-sync-workspace",
        baseUrl: "https://setup.example.com",
        onFailure: () => {
          throw new Error("reporting exploded");
        },
      }),
    ).not.toThrow();
  });

  it("deletes the legacy AlphaClaw TOOLS.md after a successful merge", () => {
    stubRegistryRead(null);
    const legacyPath = path.join(
      "/tmp/alphaclaw-legacy-workspace",
      "hooks",
      "bootstrap",
      "TOOLS.md",
    );
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn((target) => target === legacyPath),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-legacy-workspace",
      baseUrl: "https://setup.example.com",
    });

    expect(mockFs.unlinkSync).toHaveBeenCalledWith(legacyPath);
  });

  it("keeps the legacy TOOLS.md when the config reconcile fails (write→reconcile→delete)", () => {
    stubRegistryRead(null);
    const workspaceDir = "/tmp/alphaclaw-reconcile-fail-workspace";
    const legacyPath = path.join(workspaceDir, "hooks", "bootstrap", "TOOLS.md");
    // Config still references the legacy TOOLS.md path, so the reconcile
    // needs a write — which fails.
    const config = JSON.stringify({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "bootstrap-extra-files": {
              enabled: true,
              paths: ["hooks/bootstrap/AGENTS.md", "hooks/bootstrap/TOOLS.md"],
            },
          },
        },
      },
    });
    const makeFs = ({ configWriteFails }) => ({
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kConfigPath) return config;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn((target) => target === legacyPath),
      writeFileSync: vi.fn((target) => {
        if (configWriteFails && target === kConfigPath) {
          throw new Error("disk full");
        }
      }),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();

    // Reconcile failure: the config may still reference the legacy path, so
    // the file it points at must NOT be deleted (self-heals next boot sync).
    const failingFs = makeFs({ configWriteFails: true });
    syncBootstrapPromptFiles({
      fs: failingFs,
      workspaceDir,
      baseUrl: "https://setup.example.com",
      onFailure,
    });
    expect(onFailure).toHaveBeenCalledWith(
      "config-reconcile",
      expect.objectContaining({ message: "disk full" }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[onboard] Bootstrap prompt sync config-reconcile failed: disk full",
      ),
    );
    expect(failingFs.unlinkSync).not.toHaveBeenCalled();

    // Same config with a working write: reconcile succeeds → deletion runs.
    const workingFs = makeFs({ configWriteFails: false });
    syncBootstrapPromptFiles({
      fs: workingFs,
      workspaceDir,
      baseUrl: "https://setup.example.com",
    });
    expect(workingFs.unlinkSync).toHaveBeenCalledWith(legacyPath);
  });

  it("keeps the legacy TOOLS.md when openclaw.json exists but is not strict JSON", () => {
    stubRegistryRead(null);
    const workspaceDir = "/tmp/alphaclaw-json5-workspace";
    const legacyPath = path.join(workspaceDir, "hooks", "bootstrap", "TOOLS.md");
    // A legal upstream JSON5/${ENV}/$include config our strict parser cannot
    // read — it may still reference hooks/bootstrap/TOOLS.md, so treating it
    // as reconciled would delete the only hardening injection.
    const json5Config = "{ hooks: { internal: { enabled: true } } } // JSON5";
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kConfigPath) return json5Config;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(
        (target) => target === kConfigPath || target === legacyPath,
      ),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onFailure = vi.fn();

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir,
      baseUrl: "https://setup.example.com",
      onFailure,
    });

    // The merged hardening file is still written...
    expect(
      mockFs.writeFileSync.mock.calls.some(
        ([target]) =>
          target === path.join(workspaceDir, "hooks", "bootstrap", "AGENTS.md"),
      ),
    ).toBe(true);
    // ...but the unreadable config is never rewritten, and the legacy
    // TOOLS.md it may still reference is kept (reconcile skipped).
    expect(
      mockFs.writeFileSync.mock.calls.some(([target]) => target === kConfigPath),
    ).toBe(false);
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("openclaw.json exists but is not parseable"),
    );
    // Not a failure — a JSON5 config is legal upstream, so no watchdog noise.
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("warns when the merged hardening file approaches the 20k injection cap", () => {
    stubRegistryRead(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "T".repeat(12000);
        if (target === kAgentsSourcePath) return "A".repeat(6000);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-size-workspace",
      baseUrl: "https://setup.example.com",
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("approaching OpenClaw's 20,000-char per-file injection cap"),
    );
  });

  it("reconciles the bootstrap-extra-files hook entry on the sync path, preserving user paths", () => {
    stubRegistryRead(null);
    const config = JSON.stringify({
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "bootstrap-extra-files": {
              enabled: true,
              paths: [
                "hooks/bootstrap/AGENTS.md",
                "hooks/bootstrap/TOOLS.md",
                "hooks/bootstrap/USER.md",
              ],
            },
          },
        },
      },
    });
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kConfigPath) return config;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-reconcile-workspace",
      baseUrl: "https://setup.example.com",
    });

    const configWrite = mockFs.writeFileSync.mock.calls.find(
      ([target]) => target === kConfigPath,
    );
    expect(configWrite).toBeTruthy();
    const written = JSON.parse(configWrite[1]);
    // AlphaClaw's merged path first, the legacy AlphaClaw TOOLS.md path
    // dropped, the user-added path preserved verbatim.
    expect(written.hooks.internal.entries["bootstrap-extra-files"]).toEqual({
      enabled: true,
      paths: ["hooks/bootstrap/AGENTS.md", "hooks/bootstrap/USER.md"],
    });
  });

  it("does not rewrite openclaw.json when the hook entry is already reconciled", () => {
    stubRegistryRead(null);
    const config = JSON.stringify({
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
    });
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kConfigPath) return config;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-noop-workspace",
      baseUrl: "https://setup.example.com",
    });

    expect(
      mockFs.writeFileSync.mock.calls.some(([target]) => target === kConfigPath),
    ).toBe(false);
  });

  // The bundled hook resolves `paths` if non-empty, ELSE `patterns`, ELSE
  // `files` — writing a managed non-empty `paths` array short-circuits the
  // alias keys completely, so alias-configured extras must fold into `paths`.
  const makeReconcileFs = (config) => ({
    readFileSync: vi.fn((target) => {
      if (target === kToolsTemplatePath) return "Setup: {{SETUP_UI_URL}}";
      if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
      if (target === kConfigPath) return config;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  });
  const findConfigWrite = (mockFs) =>
    mockFs.writeFileSync.mock.calls.find(([target]) => target === kConfigPath);

  it("folds patterns-alias extras into managed paths and preserves the alias key", () => {
    stubRegistryRead(null);
    const mockFs = makeReconcileFs(
      JSON.stringify({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "bootstrap-extra-files": {
                enabled: true,
                patterns: ["hooks/bootstrap/PATTERNS.md", "notes/*.md"],
              },
            },
          },
        },
      }),
    );

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-patterns-alias-workspace",
      baseUrl: "https://setup.example.com",
    });

    const configWrite = findConfigWrite(mockFs);
    expect(configWrite).toBeTruthy();
    const written = JSON.parse(configWrite[1]);
    expect(written.hooks.internal.entries["bootstrap-extra-files"]).toEqual({
      enabled: true,
      // The alias key stays untouched — harmless once paths is a superset.
      patterns: ["hooks/bootstrap/PATTERNS.md", "notes/*.md"],
      paths: [
        "hooks/bootstrap/AGENTS.md",
        "hooks/bootstrap/PATTERNS.md",
        "notes/*.md",
      ],
    });
  });

  it("folds files-alias extras into managed paths and preserves the alias key", () => {
    stubRegistryRead(null);
    const mockFs = makeReconcileFs(
      JSON.stringify({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "bootstrap-extra-files": {
                enabled: true,
                files: ["hooks/bootstrap/EXTRA.md"],
              },
            },
          },
        },
      }),
    );

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-files-alias-workspace",
      baseUrl: "https://setup.example.com",
    });

    const configWrite = findConfigWrite(mockFs);
    expect(configWrite).toBeTruthy();
    const written = JSON.parse(configWrite[1]);
    expect(written.hooks.internal.entries["bootstrap-extra-files"]).toEqual({
      enabled: true,
      files: ["hooks/bootstrap/EXTRA.md"],
      paths: ["hooks/bootstrap/AGENTS.md", "hooks/bootstrap/EXTRA.md"],
    });
  });

  it("keeps existing user paths in order ahead of folded alias extras", () => {
    stubRegistryRead(null);
    const mockFs = makeReconcileFs(
      JSON.stringify({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "bootstrap-extra-files": {
                enabled: true,
                paths: [
                  "hooks/bootstrap/ZULU.md",
                  "hooks/bootstrap/TOOLS.md",
                  "hooks/bootstrap/ALPHA.md",
                ],
                patterns: ["notes/*.md"],
                files: ["extra/FILES.md", "notes/*.md"],
              },
            },
          },
        },
      }),
    );

    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: "/tmp/alphaclaw-alias-order-workspace",
      baseUrl: "https://setup.example.com",
    });

    const configWrite = findConfigWrite(mockFs);
    expect(configWrite).toBeTruthy();
    const written = JSON.parse(configWrite[1]);
    // AlphaClaw's path first, user paths in their original order (legacy
    // TOOLS.md dropped), then patterns, then files, exact duplicates deduped.
    expect(
      written.hooks.internal.entries["bootstrap-extra-files"].paths,
    ).toEqual([
      "hooks/bootstrap/AGENTS.md",
      "hooks/bootstrap/ZULU.md",
      "hooks/bootstrap/ALPHA.md",
      "notes/*.md",
      "extra/FILES.md",
    ]);
  });

  it("is a no-op on re-run after alias extras were folded into paths", () => {
    stubRegistryRead(null);
    const firstFs = makeReconcileFs(
      JSON.stringify({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "bootstrap-extra-files": {
                enabled: true,
                patterns: ["hooks/bootstrap/PATTERNS.md"],
              },
            },
          },
        },
      }),
    );
    syncBootstrapPromptFiles({
      fs: firstFs,
      workspaceDir: "/tmp/alphaclaw-alias-noop-workspace",
      baseUrl: "https://setup.example.com",
    });
    const firstWrite = findConfigWrite(firstFs);
    expect(firstWrite).toBeTruthy();

    // Feed the first run's output back in: diff-before-write must hold.
    const secondFs = makeReconcileFs(firstWrite[1]);
    syncBootstrapPromptFiles({
      fs: secondFs,
      workspaceDir: "/tmp/alphaclaw-alias-noop-workspace",
      baseUrl: "https://setup.example.com",
    });
    expect(findConfigWrite(secondFs)).toBeUndefined();
  });

  // Fix wave F106: a full-root import promotes the repo's committed .env OVER
  // the managed symlink; the next artifact sync must move it aside and re-link.
  it("moves a regular imported .env aside and restores the managed symlink", () => {
    const openclawDir = "/tmp/alphaclaw-artifacts";
    const envFilePath = "/tmp/alphaclaw-env-file";
    const linkPath = path.join(openclawDir, ".env");
    let linkExists = true;
    const mockFs = {
      existsSync: vi.fn((target) => {
        if (target === linkPath) return linkExists;
        if (target === envFilePath) return true;
        if (target === path.join(openclawDir, "gogcli", "config.json")) return true;
        return false;
      }),
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => false, isFile: () => true })),
      renameSync: vi.fn(() => {
        linkExists = false;
      }),
      symlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    ensureOpenclawRuntimeArtifacts({ fs: mockFs, openclawDir, envFilePath });

    expect(mockFs.renameSync).toHaveBeenCalledTimes(1);
    expect(mockFs.renameSync.mock.calls[0][0]).toBe(linkPath);
    expect(mockFs.renameSync.mock.calls[0][1]).toMatch(/\.env\.imported-/);
    expect(mockFs.symlinkSync).toHaveBeenCalledWith(envFilePath, linkPath);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("was a regular file"));
  });

  it("an unwritable gogcli dir is logged, never thrown (F008 — it used to abort the gateway launch)", () => {
    const openclawDir = "/tmp/alphaclaw-artifacts";
    const envFilePath = "/tmp/alphaclaw-env-file";
    const mockFs = {
      existsSync: vi.fn((target) => target === path.join(openclawDir, ".env") || target === envFilePath),
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => true, isFile: () => false })),
      renameSync: vi.fn(),
      symlinkSync: vi.fn(),
      mkdirSync: vi.fn(() => {
        throw Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" });
      }),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => ensureOpenclawRuntimeArtifacts({ fs: mockFs, openclawDir, envFilePath })).not.toThrow();
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(path.join(openclawDir, "gogcli"), { recursive: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("gogcli dir skipped: EACCES"));
    log.mockRestore();
  });

  it("leaves an existing managed symlink alone", () => {
    const openclawDir = "/tmp/alphaclaw-artifacts";
    const envFilePath = "/tmp/alphaclaw-env-file";
    const mockFs = {
      existsSync: vi.fn((target) => target !== path.join(openclawDir, "gogcli", "config.json") || true),
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => true, isFile: () => false })),
      renameSync: vi.fn(),
      symlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
    };
    ensureOpenclawRuntimeArtifacts({ fs: mockFs, openclawDir, envFilePath });
    expect(mockFs.renameSync).not.toHaveBeenCalled();
    expect(mockFs.symlinkSync).not.toHaveBeenCalled();
  });

  it("symlinks the env file into the openclaw dir when missing", () => {
    const openclawDir = "/tmp/alphaclaw-artifacts";
    const envFilePath = "/tmp/alphaclaw-env-file";
    const mockFs = {
      existsSync: vi.fn((target) => {
        if (target === path.join(openclawDir, ".env")) return false;
        if (target === envFilePath) return true;
        if (target === path.join(openclawDir, "gogcli", "config.json")) {
          return true;
        }
        return false;
      }),
      symlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
    };

    ensureOpenclawRuntimeArtifacts({ fs: mockFs, openclawDir, envFilePath });

    expect(mockFs.symlinkSync).toHaveBeenCalledWith(
      envFilePath,
      path.join(openclawDir, ".env"),
    );
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it("logs and continues when the env symlink fails", () => {
    const openclawDir = "/tmp/alphaclaw-artifacts";
    const envFilePath = "/tmp/alphaclaw-env-file";
    const mockFs = {
      existsSync: vi.fn((target) => {
        if (target === path.join(openclawDir, ".env")) return false;
        if (target === envFilePath) return true;
        if (target === path.join(openclawDir, "gogcli", "config.json")) {
          return true;
        }
        return false;
      }),
      symlinkSync: vi.fn(() => {
        throw new Error("EPERM: operation not permitted");
      }),
      mkdirSync: vi.fn(),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    ensureOpenclawRuntimeArtifacts({ fs: mockFs, openclawDir, envFilePath });

    expect(logSpy).toHaveBeenCalledWith(
      "[alphaclaw] .env symlink skipped: EPERM: operation not permitted",
    );
  });
});
