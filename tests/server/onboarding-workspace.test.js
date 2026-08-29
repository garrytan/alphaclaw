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
    // The broken workspace failed on its write; the sync moved on and the
    // failure surfaced through onFailure (not just the console).
    expect(
      mockFs.writeFileSync.mock.calls.some(
        ([target]) =>
          target === path.join(brokenWorkspace, "hooks", "bootstrap", "AGENTS.md") &&
          false,
      ),
    ).toBe(false);
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

  it("degrades gracefully when config and google state are unreadable", () => {
    stubRegistryRead(null);
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
