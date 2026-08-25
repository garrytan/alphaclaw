const fs = require("fs");
const os = require("os");
const path = require("path");

// syncConfigForTelegram writes the persisted restart flag at a constants-
// derived path; point the root at a temp dir BEFORE requiring modules so
// nothing touches the real ~/.alphaclaw.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-tg-ws-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const {
  syncConfigForTelegram,
  resolveAccountIdForGroup,
} = require("../../lib/server/telegram-workspace");
const {
  OpenclawConfigReadError,
} = require("../../lib/server/openclaw-config");
const {
  kRestartRequiredFlagPath,
} = require("../../lib/server/restart-required-flag");
const topicRegistryModule = require("../../lib/server/topic-registry");

const writeOpenclawConfig = ({ dir, config }) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "openclaw.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
};

const readOpenclawConfig = ({ dir }) =>
  JSON.parse(fs.readFileSync(path.join(dir, "openclaw.json"), "utf8"));

describe("server/telegram-workspace", () => {
  let tempRootDir = "";
  let openclawDir = "";

  beforeEach(() => {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-test-"));
    openclawDir = path.join(tempRootDir, ".openclaw");
  });

  afterEach(() => {
    if (tempRootDir) {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    fs.rmSync(kRestartRequiredFlagPath, { force: true });
    fs.rmSync(path.dirname(topicRegistryModule.kRegistryPath), {
      recursive: true,
      force: true,
    });
  });

  afterAll(() => {
    fs.rmSync(kTempRoot, { recursive: true, force: true });
  });

  it("writes topic agentId to openclaw group topic config", () => {
    writeOpenclawConfig({
      dir: openclawDir,
      config: {
        channels: {
          telegram: {
            groups: {
              "-1001234567890": {
                requireMention: true,
              },
            },
          },
        },
      },
    });

    const topicRegistry = {
      getGroup: () => ({
        topics: {
          "1": { name: "General", agentId: "main" },
          "3": {
            name: "Ops",
            agentId: "ops",
            systemInstructions: "Handle ops requests only.",
          },
          "5": { name: "No Overrides" },
        },
      }),
      getTotalTopicCount: () => 3,
    };

    syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-1001234567890",
      requireMention: true,
      resolvedUserId: "",
    });

    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    expect(nextConfig.channels.telegram.groups["-1001234567890"].topics).toEqual({
      "1": { agentId: "main" },
      "3": { systemPrompt: "Handle ops requests only.", agentId: "ops" },
    });
  });

  it("skips discovered and deleted topics when writing config topics", () => {
    writeOpenclawConfig({
      dir: openclawDir,
      config: { channels: { telegram: { groups: { "-100777": {} } } } },
    });

    const topicRegistry = {
      getGroup: () => ({
        topics: {
          // Operator/agent-authored routing: written.
          "1": { name: "Ops", agentId: "ops" },
          // Discovered topics never write routing config (E3), even when a
          // hostile registry row carries agentId/systemInstructions.
          "2": { name: "Sneaky", agentId: "evil", discovered: true },
          // Tombstoned entries are skipped entirely.
          "3": {
            name: "Dead",
            agentId: "ghost",
            systemInstructions: "haunt",
            deleted: true,
          },
        },
      }),
      getTotalTopicCount: () => 3,
    };

    syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-100777",
      requireMention: false,
      resolvedUserId: "",
    });

    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    expect(nextConfig.channels.telegram.groups["-100777"].topics).toEqual({
      "1": { agentId: "ops" },
    });
  });

  it("omits empty agentId values when syncing topic metadata", () => {
    writeOpenclawConfig({
      dir: openclawDir,
      config: {
        channels: {
          telegram: {
            groups: {
              "-1001234567890": {},
            },
          },
        },
      },
    });

    const topicRegistry = {
      getGroup: () => ({
        topics: {
          "2": { name: "Prompt Only", systemInstructions: "Only prompt." },
          "4": { name: "Blank Agent", agentId: "   " },
        },
      }),
      getTotalTopicCount: () => 2,
    };

    syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-1001234567890",
      requireMention: false,
      resolvedUserId: "",
    });

    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    expect(nextConfig.channels.telegram.groups["-1001234567890"].topics).toEqual({
      "2": { systemPrompt: "Only prompt." },
    });
  });

  it("bootstraps a missing config and records the allowed user", () => {
    fs.mkdirSync(openclawDir, { recursive: true });
    const topicRegistry = {
      getGroup: () => null,
      getTotalTopicCount: () => 0,
    };

    const result = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-100999",
      requireMention: true,
      resolvedUserId: "42",
    });

    expect(result).toEqual({
      totalTopics: 0,
      maxConcurrent: 8,
      subagentMaxConcurrent: 6,
      actionsChanged: true,
    });
    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    const group = nextConfig.channels.telegram.groups["-100999"];
    expect(group.requireMention).toBe(true);
    expect(group.topics).toBeUndefined();
    expect(nextConfig.channels.telegram.groupPolicy).toBe("allowlist");
    expect(nextConfig.channels.telegram.groupAllowFrom).toEqual(["42"]);
    expect(nextConfig.session.resetByType.thread).toEqual({
      mode: "idle",
      idleMinutes: 525600,
    });

    // Re-running with the same user does not duplicate the allowlist entry,
    // and actionsChanged only fires on the transition.
    const rerun = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-100999",
      requireMention: true,
      resolvedUserId: "42",
    });
    expect(rerun.actionsChanged).toBe(false);
    expect(
      readOpenclawConfig({ dir: openclawDir }).channels.telegram.groupAllowFrom,
    ).toEqual(["42"]);
  });

  it("removes stale topics when the registry has no prompt overrides left", () => {
    writeOpenclawConfig({
      dir: openclawDir,
      config: {
        channels: {
          telegram: {
            groups: {
              "-100777": {
                requireMention: false,
                topics: { "9": { systemPrompt: "stale" } },
              },
            },
          },
        },
      },
    });
    const topicRegistry = {
      getGroup: () => ({ topics: { "9": { name: "No Overrides" } } }),
      getTotalTopicCount: () => 1,
    };

    syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-100777",
      requireMention: false,
      resolvedUserId: "",
    });

    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    expect(nextConfig.channels.telegram.groups["-100777"].topics).toBeUndefined();
  });

  it("targets the matching account config when multi-account telegram is set up", () => {
    writeOpenclawConfig({
      dir: openclawDir,
      config: {
        channels: {
          telegram: {
            accounts: {
              work: {
                groups: { "-100555": { requireMention: false } },
              },
            },
          },
        },
      },
    });
    const topicRegistry = {
      getGroup: () => ({
        topics: { "3": { name: "Ops", agentId: "ops" } },
      }),
      getActiveTopicCount: () => 4,
      getTotalTopicCount: () => 99,
    };

    const result = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-100555",
      accountId: "work",
      requireMention: true,
      resolvedUserId: "77",
    });

    // getActiveTopicCount wins over getTotalTopicCount when available.
    expect(result.totalTopics).toBe(4);
    expect(result.maxConcurrent).toBe(12);
    expect(result.subagentMaxConcurrent).toBe(10);
    expect(result.actionsChanged).toBe(true);
    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    const account = nextConfig.channels.telegram.accounts.work;
    expect(account.groups["-100555"]).toEqual({
      requireMention: true,
      topics: { "3": { agentId: "ops" } },
    });
    expect(account.groupPolicy).toBe("allowlist");
    expect(account.groupAllowFrom).toEqual(["77"]);
    expect(account.actions).toEqual({
      createForumTopic: true,
      editForumTopic: true,
    });
    // Root telegram config is left untouched when accounts exist.
    expect(nextConfig.channels.telegram.groups).toBeUndefined();
    expect(nextConfig.channels.telegram.actions).toBeUndefined();
  });

  it("creates a fresh account bucket for unknown or malformed account ids", () => {
    writeOpenclawConfig({
      dir: openclawDir,
      config: {
        channels: {
          telegram: {
            accounts: { work: "not-an-object" },
          },
        },
      },
    });
    const topicRegistry = {
      getGroup: () => null,
      getTotalTopicCount: () => 0,
    };

    syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-100333",
      accountId: "  personal  ",
      requireMention: false,
      resolvedUserId: "",
    });

    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    const personal = nextConfig.channels.telegram.accounts.personal;
    expect(personal.groups["-100333"]).toEqual({ requireMention: false });
    expect(personal.groupPolicy).toBe("allowlist");
    // The malformed sibling account entry is preserved as-is.
    expect(nextConfig.channels.telegram.accounts.work).toBe("not-an-object");
  });

  it("fails closed on an unparseable openclaw.json: throws, never writes", () => {
    const configPath = path.join(openclawDir, "openclaw.json");
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === configPath) {
          return "{ channels: { telegram: {} }, // JSON5 the operator maintains";
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };
    const topicRegistry = {
      getGroup: () => null,
      getTotalTopicCount: () => 0,
    };

    let caught = null;
    try {
      syncConfigForTelegram({
        fs: mockFs,
        openclawDir,
        topicRegistry,
        groupId: "-1",
        requireMention: false,
        resolvedUserId: "",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenclawConfigReadError);
    expect(caught.code).toBe("OPENCLAW_CONFIG_UNREADABLE");
    // The operator's config was never rewritten — not even once.
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("caps auto-scaled concurrency at 64", () => {
    fs.mkdirSync(openclawDir, { recursive: true });
    const topicRegistry = {
      getGroup: () => null,
      getActiveTopicCount: () => 25,
      getTotalTopicCount: () => 25,
    };

    const result = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-1",
      requireMention: false,
      resolvedUserId: "",
    });

    // 25 * 3 = 75 would exceed the hard ceiling (E4.4).
    expect(result.maxConcurrent).toBe(64);
    expect(result.subagentMaxConcurrent).toBe(62);
    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    expect(nextConfig.agents.defaults.maxConcurrent).toBe(64);
    expect(nextConfig.agents.defaults.subagents.maxConcurrent).toBe(62);
  });

  it("counts only named, non-stale, non-deleted topics via the real registry", () => {
    fs.mkdirSync(openclawDir, { recursive: true });
    // Seed the real registry (temp workspace) with a mixed population.
    fs.mkdirSync(path.dirname(topicRegistryModule.kRegistryPath), {
      recursive: true,
    });
    fs.writeFileSync(
      topicRegistryModule.kRegistryPath,
      JSON.stringify({
        version: 2,
        meta: { sweepWatermark: 0 },
        groups: {
          "-1": {
            name: "G",
            topics: {
              1: { name: "Live One" },
              2: { name: "Live Two" },
              3: { name: "", discovered: true },
              4: { name: "Stale", stale: true },
              5: { name: "Dead", deleted: true },
            },
          },
        },
      }),
    );

    const result = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry: topicRegistryModule,
      groupId: "-1",
      requireMention: false,
      resolvedUserId: "",
    });

    expect(result.totalTopics).toBe(2);
    // 2 * 3 = 6 < floor 8.
    expect(result.maxConcurrent).toBe(8);
    expect(result.subagentMaxConcurrent).toBe(6);
  });

  it("preserves an operator's explicit false on action flags", () => {
    writeOpenclawConfig({
      dir: openclawDir,
      config: {
        channels: {
          telegram: {
            actions: { createForumTopic: false, editForumTopic: false },
            groups: { "-1": {} },
          },
        },
      },
    });
    const topicRegistry = {
      getGroup: () => null,
      getTotalTopicCount: () => 0,
    };

    const result = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-1",
      requireMention: false,
      resolvedUserId: "",
    });

    expect(result.actionsChanged).toBe(false);
    const nextConfig = readOpenclawConfig({ dir: openclawDir });
    expect(nextConfig.channels.telegram.actions).toEqual({
      createForumTopic: false,
      editForumTopic: false,
    });
    // No transition → no restart flag.
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(false);
  });

  it("fills in only the missing action flag, preserving the explicit false", () => {
    writeOpenclawConfig({
      dir: openclawDir,
      config: {
        channels: {
          telegram: {
            actions: { createForumTopic: false },
            groups: { "-1": {} },
          },
        },
      },
    });
    const topicRegistry = { getGroup: () => null, getTotalTopicCount: () => 0 };

    const result = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId: "-1",
      requireMention: false,
      resolvedUserId: "",
    });

    expect(result.actionsChanged).toBe(true);
    expect(
      readOpenclawConfig({ dir: openclawDir }).channels.telegram.actions,
    ).toEqual({ createForumTopic: false, editForumTopic: true });
  });

  it("writes the restart flag through the injected fs when actions change", () => {
    const configPath = path.join(openclawDir, "openclaw.json");
    const written = new Map();
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === configPath) return "{}";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      writeFileSync: vi.fn((target, content) => {
        written.set(String(target), String(content));
      }),
      mkdirSync: vi.fn(),
    };
    const topicRegistry = { getGroup: () => null, getTotalTopicCount: () => 0 };

    const result = syncConfigForTelegram({
      fs: mockFs,
      openclawDir,
      topicRegistry,
      groupId: "-1",
      requireMention: false,
      resolvedUserId: "",
    });

    expect(result.actionsChanged).toBe(true);
    // The flag write went through the INJECTED fs, not the real one.
    expect(written.has(kRestartRequiredFlagPath)).toBe(true);
    const flag = JSON.parse(written.get(kRestartRequiredFlagPath));
    expect(flag.reason).toBe("telegram_actions_enabled");
    expect(flag.source).toBe("telegram-workspace");
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(false);
  });

  it("clears the restart flag requirement between unchanged runs (real fs)", () => {
    fs.mkdirSync(openclawDir, { recursive: true });
    const topicRegistry = { getGroup: () => null, getTotalTopicCount: () => 0 };
    const runSync = () =>
      syncConfigForTelegram({
        fs,
        openclawDir,
        topicRegistry,
        groupId: "-1",
        requireMention: false,
        resolvedUserId: "",
      });

    expect(runSync().actionsChanged).toBe(true);
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(true);

    // Operator restarts and the flag is cleared elsewhere; a second sync must
    // not re-mark a restart.
    fs.rmSync(kRestartRequiredFlagPath);
    expect(runSync().actionsChanged).toBe(false);
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(false);
  });
});

describe("server/telegram-workspace resolveAccountIdForGroup", () => {
  const cfgWithAccounts = {
    channels: {
      telegram: {
        accounts: {
          " work ": { groups: { "-100555": {} } },
          personal: { groups: { "-100777": {} } },
        },
      },
    },
  };

  it("maps a group to its owning account (trim-normalized)", () => {
    expect(
      resolveAccountIdForGroup({ cfg: cfgWithAccounts, groupId: "-100555" }),
    ).toBe("work");
    expect(
      resolveAccountIdForGroup({ cfg: cfgWithAccounts, groupId: "-100777" }),
    ).toBe("personal");
  });

  it("falls back to the top-level config as the default account", () => {
    const cfg = {
      channels: { telegram: { groups: { "-100999": { requireMention: true } } } },
    };
    expect(resolveAccountIdForGroup({ cfg, groupId: "-100999" })).toBe("default");
  });

  it("returns null when no account claims the group", () => {
    expect(
      resolveAccountIdForGroup({ cfg: cfgWithAccounts, groupId: "-404" }),
    ).toBeNull();
    expect(
      resolveAccountIdForGroup({
        cfg: { channels: { telegram: { groups: {} } } },
        groupId: "-1",
      }),
    ).toBeNull();
  });

  it("returns null for missing config or blank group ids", () => {
    expect(resolveAccountIdForGroup({ cfg: null, groupId: "-1" })).toBeNull();
    expect(resolveAccountIdForGroup({ cfg: {}, groupId: "-1" })).toBeNull();
    expect(
      resolveAccountIdForGroup({ cfg: cfgWithAccounts, groupId: "" }),
    ).toBeNull();
  });
});
