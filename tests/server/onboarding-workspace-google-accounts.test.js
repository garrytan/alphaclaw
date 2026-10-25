const realFs = require("fs");
const path = require("path");
const { syncBootstrapPromptFiles } = require("../../lib/server/onboarding/workspace");
const { OPENCLAW_DIR, WORKSPACE_DIR, kSetupDir } = require("../../lib/server/constants");
const { kRegistryPath } = require("../../lib/server/topic-registry");
const {
  refreshDetectedGogAccounts,
  resetDetectedGogAccountsForTests,
} = require("../../lib/server/gog-accounts");

describe("server/onboarding/workspace Google accounts section", () => {
  const kToolsTemplatePath = path.join(kSetupDir, "core-prompts", "TOOLS.md");
  const kAgentsSourcePath = path.join(kSetupDir, "core-prompts", "AGENTS.md");
  const kGoogleStatePath = path.join(OPENCLAW_DIR, "gogcli", "state.json");
  const kStateAccount = {
    id: "acc1",
    email: "you@example.com",
    client: "default",
    personal: true,
    authenticated: true,
    services: ["gmail:read"],
  };

  const seedGog = (accounts) =>
    refreshDetectedGogAccounts({
      execFileCmd: async () => JSON.stringify({ accounts }),
    });

  const renderSection = (stateAccounts) => {
    const googleState =
      stateAccounts === null
        ? null
        : JSON.stringify({ version: 2, accounts: stateAccounts, gmailPush: { token: "", topics: {} } });
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kToolsTemplatePath) return "TOOLS TEMPLATE";
        if (target === kAgentsSourcePath) return "AGENTS TEMPLATE";
        if (target === kGoogleStatePath && googleState) return googleState;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn((target) => target === kGoogleStatePath && Boolean(googleState)),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
    };
    syncBootstrapPromptFiles({
      fs: mockFs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: "https://setup.example.com",
    });
    const written = mockFs.writeFileSync.mock.calls
      .filter(([target]) => String(target).startsWith(WORKSPACE_DIR))
      .map(([, content]) => String(content))
      .find((content) => content.includes("## Available Google Accounts"));
    expect(written).toBeTruthy();
    const start = written.indexOf("## Available Google Accounts");
    const next = written.indexOf("\n## ", start + 1);
    return written.slice(start, next === -1 ? undefined : next).trimEnd();
  };

  beforeEach(() => {
    resetDetectedGogAccountsForTests();
    const original = realFs.readFileSync;
    vi.spyOn(realFs, "readFileSync").mockImplementation((target, ...rest) => {
      if (target === kRegistryPath) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return original.call(realFs, target, ...rest);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDetectedGogAccountsForTests();
  });

  it("keeps today's lines for accounts AlphaClaw manages, even when gog lists them too", async () => {
    await seedGog([{ email: "YOU@example.com", client: "default" }]);

    expect(renderSection([kStateAccount])).toBe(
      [
        "## Available Google Accounts",
        "",
        "Configured in AlphaClaw (use `--client <client> --account <email>` for gog commands):",
        "",
        "- you@example.com (type: personal; client: default; status: authenticated; services: gmail:read)",
      ].join("\n"),
    );
  });

  it("lists accounts set up in gog outside the Setup UI when AlphaClaw has none", async () => {
    await seedGog([
      { email: "you@example.com", client: "default" },
      { email: "ops@example.com", client: "work" },
    ]);

    expect(renderSection(null)).toBe(
      [
        "## Available Google Accounts",
        "",
        "Also stored in gog (use `--client <client> --account <email>` for gog commands):",
        "",
        "- you@example.com (configured in gog outside the Setup UI; client: default)",
        "- ops@example.com (configured in gog outside the Setup UI; client: work)",
      ].join("\n"),
    );
  });

  it("lists both, and treats the same email under another client as a separate account", async () => {
    await seedGog([
      { email: "you@example.com", client: "default" },
      { email: "you@example.com", client: "work" },
    ]);

    const section = renderSection([kStateAccount]);

    expect(section).toContain(
      "- you@example.com (type: personal; client: default; status: authenticated; services: gmail:read)",
    );
    expect(section).toContain(
      "\n\nAlso stored in gog (use `--client <client> --account <email>` for gog commands):\n\n" +
        "- you@example.com (configured in gog outside the Setup UI; client: work)",
    );
    expect(section).not.toContain("outside the Setup UI; client: default");
  });

  it("says no accounts are configured only when neither AlphaClaw nor gog has one", async () => {
    await seedGog([]);

    expect(renderSection(null)).toBe(
      "## Available Google Accounts\n\nNo Google accounts are currently configured.",
    );
  });

  it("falls back to AlphaClaw's state alone when gog cannot be asked", async () => {
    await seedGog([{ email: "ops@example.com", client: "default" }]);
    await refreshDetectedGogAccounts({
      execFileCmd: async () => {
        throw Object.assign(new Error("gog failed"), { code: 1 });
      },
    });

    expect(renderSection(null)).toBe(
      "## Available Google Accounts\n\nNo Google accounts are currently configured.",
    );
    expect(renderSection([kStateAccount])).not.toContain("Also stored in gog");
  });
});
