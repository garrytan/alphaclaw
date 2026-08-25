const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");

const kPreloadSource = `
const os = require("os");
const fs = require("fs");
const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}
if (process.env.ALPHACLAW_TEST_FETCH_MODE) {
  globalThis.fetch = async (url, options = {}) => {
    const capturePath = process.env.ALPHACLAW_TEST_FETCH_CAPTURE;
    if (capturePath) {
      fs.writeFileSync(
        capturePath,
        JSON.stringify({ url: String(url), body: String(options.body || "") }),
      );
    }
    if (process.env.ALPHACLAW_TEST_FETCH_MODE === "error") {
      return {
        json: async () => ({
          ok: false,
          error_code: 400,
          description: process.env.ALPHACLAW_TEST_FETCH_ERROR,
        }),
      };
    }
    return {
      json: async () => ({
        ok: true,
        result: {
          message_thread_id: Number(
            process.env.ALPHACLAW_TEST_FETCH_THREAD_ID || 777,
          ),
          name: "created",
        },
      }),
    };
  };
}
`.trim();

describe("bin/alphaclaw telegram topic commands", () => {
  let rootDir;
  let tmpHome;
  let openclawDir;
  let preloadPath;

  const configPath = () => path.join(openclawDir, "openclaw.json");
  const registryPath = () =>
    path.join(openclawDir, "workspace", "topic-registry.json");
  const toolsPath = () =>
    path.join(openclawDir, "workspace", "hooks", "bootstrap", "TOOLS.md");

  const writeConfig = (cfg) => {
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      configPath(),
      typeof cfg === "string" ? cfg : JSON.stringify(cfg, null, 2),
    );
  };

  const readConfig = () => JSON.parse(fs.readFileSync(configPath(), "utf8"));
  const readRegistry = () => JSON.parse(fs.readFileSync(registryPath(), "utf8"));

  const writeRegistry = (registry) => {
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), JSON.stringify(registry, null, 2));
  };

  const runCli = (cliArgs, { env = {} } = {}) => {
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--require", preloadPath, binPath, "--root-dir", rootDir, ...cliArgs],
        {
          encoding: "utf8",
          stdio: "pipe",
          env: {
            ...process.env,
            ALPHACLAW_ROOT_DIR: rootDir,
            ALPHACLAW_TEST_HOME: tmpHome,
            ALPHACLAW_SETUP_URL: "",
            ALPHACLAW_BASE_URL: "",
            RENDER_EXTERNAL_URL: "",
            URL: "",
            RAILWAY_PUBLIC_DOMAIN: "",
            RAILWAY_STATIC_URL: "",
            TELEGRAM_BOT_TOKEN: "",
            ...env,
          },
        },
      );
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      return {
        status: error.status,
        stdout: String(error.stdout || ""),
        stderr: String(error.stderr || ""),
      };
    }
  };

  const kTopLevelConfig = {
    channels: {
      telegram: {
        enabled: true,
        groups: { "-100123": { requireMention: true } },
      },
    },
  };

  const kAccountsConfig = {
    channels: {
      telegram: {
        enabled: true,
        accounts: { alpha: { groups: { "-100555": {} } } },
      },
    },
  };

  const kAmbiguousConfig = {
    channels: {
      telegram: {
        enabled: true,
        groups: { "-100123": { requireMention: true } },
        accounts: { alpha: { groups: { "-100555": {} } } },
      },
    },
  };

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-tg-cli-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-tg-home-"));
    openclawDir = path.join(rootDir, ".openclaw");
    preloadPath = path.join(rootDir, "preload.js");
    fs.writeFileSync(preloadPath, kPreloadSource);
  });

  afterEach(() => {
    for (const dir of [rootDir, tmpHome]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe("telegram topic add", () => {
    it("maps a topic when the group lives at channels.telegram.groups", () => {
      writeConfig(kTopLevelConfig);
      const result = runCli([
        "telegram", "topic", "add", "--thread", "12", "--name", "Ops",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Topic mapped: group=-100123 thread=12 name=Ops",
      );
      expect(result.stdout).toContain("Concurrency updated:");
      expect(readRegistry().groups["-100123"].topics["12"].name).toBe("Ops");
      const cfg = readConfig();
      expect(cfg.channels.telegram.groups["-100123"].requireMention).toBe(true);
      expect(cfg.channels.telegram.groupPolicy).toBe("allowlist");
      expect(cfg.channels.telegram.accounts).toBeUndefined();
    });

    it("resolves accounts.*.groups and passes the accountId through to config sync", () => {
      writeConfig(kAccountsConfig);
      const result = runCli([
        "telegram", "topic", "add", "--thread", "9", "--name", "QA", "--agent", "qa",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Topic mapped: group=-100555 thread=9 name=QA agent=qa",
      );
      expect(readRegistry().groups["-100555"].topics["9"].agentId).toBe("qa");
      const cfg = readConfig();
      const accountConfig = cfg.channels.telegram.accounts.alpha;
      expect(accountConfig.groups["-100555"].requireMention).toBe(false);
      expect(accountConfig.groups["-100555"].topics["9"].agentId).toBe("qa");
      expect(accountConfig.groupPolicy).toBe("allowlist");
      expect(cfg.channels.telegram.groups).toBeUndefined();
    });

    it("errors clearly when multiple groups are configured and --group is omitted", () => {
      writeConfig(kAmbiguousConfig);
      const result = runCli([
        "telegram", "topic", "add", "--thread", "12", "--name", "Ops",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Multiple Telegram groups detected");
      expect(result.stderr).toContain("-100123");
      expect(result.stderr).toContain("-100555");
      expect(result.stderr).toContain("Provide --group <groupId>");
    });

    it("honors --group in an ambiguous config and writes the account branch", () => {
      writeConfig(kAmbiguousConfig);
      const result = runCli([
        "telegram", "topic", "add",
        "--group", "-100555", "--thread", "3", "--name", "Support",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Topic mapped: group=-100555 thread=3 name=Support",
      );
      const cfg = readConfig();
      expect(cfg.channels.telegram.accounts.alpha.groups["-100555"]).toBeDefined();
      expect(cfg.channels.telegram.accounts.alpha.groupPolicy).toBe("allowlist");
      expect(cfg.channels.telegram.groups["-100123"]).toEqual({
        requireMention: true,
      });
    });

    it("surfaces the fail-closed error when openclaw.json exists but is unparseable", () => {
      writeConfig('{ "channels": ');
      const result = runCli([
        "telegram", "topic", "add",
        "--group", "-100123", "--thread", "12", "--name", "Ops",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("telegram topic add failed:");
      expect(result.stderr).toContain("not JSON alphaclaw can parse");
      expect(fs.readFileSync(configPath(), "utf8")).toBe('{ "channels": ');
    });
  });

  describe("baseUrl env chain in prompt sync", () => {
    it("prefers ALPHACLAW_SETUP_URL over the rest of the chain", () => {
      writeConfig(kTopLevelConfig);
      const result = runCli(
        ["telegram", "topic", "add", "--thread", "12", "--name", "Ops"],
        {
          env: {
            ALPHACLAW_SETUP_URL: "https://setup.example.test",
            ALPHACLAW_BASE_URL: "https://base.example.test",
            RENDER_EXTERNAL_URL: "https://render.example.test",
            URL: "https://url.example.test",
          },
        },
      );

      expect(result.status).toBe(0);
      const tools = fs.readFileSync(toolsPath(), "utf8");
      expect(tools).toContain("https://setup.example.test");
      expect(tools).not.toContain("https://base.example.test");
    });

    it("falls back through the chain to RENDER_EXTERNAL_URL", () => {
      writeConfig(kTopLevelConfig);
      const result = runCli(
        ["telegram", "topic", "add", "--thread", "12", "--name", "Ops"],
        {
          env: {
            RENDER_EXTERNAL_URL: "https://render.example.test",
            URL: "https://url.example.test",
          },
        },
      );

      expect(result.status).toBe(0);
      const tools = fs.readFileSync(toolsPath(), "utf8");
      expect(tools).toContain("https://render.example.test");
      expect(tools).not.toContain("https://url.example.test");
    });

    it("keeps resolveSetupUiUrl's Railway fallback when the chain is empty", () => {
      writeConfig(kTopLevelConfig);
      const result = runCli(
        ["telegram", "topic", "add", "--thread", "12", "--name", "Ops"],
        { env: { RAILWAY_PUBLIC_DOMAIN: "railway.example.test" } },
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(toolsPath(), "utf8")).toContain(
        "https://railway.example.test",
      );
    });
  });

  describe("telegram topic create", () => {
    const fetchCapturePath = () => path.join(rootDir, "fetch-capture.json");
    const readFetchCapture = () =>
      JSON.parse(fs.readFileSync(fetchCapturePath(), "utf8"));

    it("creates the forum topic, registers it, and syncs config + prompts", () => {
      writeConfig(kTopLevelConfig);
      const result = runCli(
        [
          "telegram", "topic", "create",
          "--group", "-100123", "--name", "Launch", "--agent", "ops",
        ],
        {
          env: {
            TELEGRAM_BOT_TOKEN: "test-token",
            ALPHACLAW_TEST_FETCH_MODE: "ok",
            ALPHACLAW_TEST_FETCH_THREAD_ID: "777",
            ALPHACLAW_TEST_FETCH_CAPTURE: fetchCapturePath(),
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Topic created: group=-100123 thread=777 name=Launch agent=ops",
      );
      expect(result.stdout).toContain("Concurrency updated:");

      const capture = readFetchCapture();
      expect(capture.url).toContain("/bottest-token/createForumTopic");
      expect(JSON.parse(capture.body)).toEqual({
        chat_id: "-100123",
        name: "Launch",
      });

      const topic = readRegistry().groups["-100123"].topics["777"];
      expect(topic.name).toBe("Launch");
      expect(topic.agentId).toBe("ops");
      expect(topic.discovered).toBe(false);

      const cfg = readConfig();
      expect(cfg.channels.telegram.groups["-100123"].topics["777"].agentId).toBe(
        "ops",
      );
      expect(fs.existsSync(toolsPath())).toBe(true);
    });

    it("uses the per-account bot token env key in accounts mode", () => {
      writeConfig(kAccountsConfig);
      const result = runCli(
        ["telegram", "topic", "create", "--group", "-100555", "--name", "QA"],
        {
          env: {
            TELEGRAM_BOT_TOKEN: "default-token",
            TELEGRAM_BOT_TOKEN_ALPHA: "alpha-token",
            ALPHACLAW_TEST_FETCH_MODE: "ok",
            ALPHACLAW_TEST_FETCH_CAPTURE: fetchCapturePath(),
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFetchCapture().url).toContain("/botalpha-token/createForumTopic");
      expect(readConfig().channels.telegram.accounts.alpha.groups["-100555"])
        .toBeDefined();
    });

    it("prints the exact Telegram error text on stderr and registers nothing", () => {
      writeConfig(kTopLevelConfig);
      const errorText = "Bad Request: not enough rights to manage forum topics";
      const result = runCli(
        ["telegram", "topic", "create", "--group", "-100123", "--name", "Launch"],
        {
          env: {
            TELEGRAM_BOT_TOKEN: "test-token",
            ALPHACLAW_TEST_FETCH_MODE: "error",
            ALPHACLAW_TEST_FETCH_ERROR: errorText,
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(errorText);
      expect(fs.existsSync(registryPath())).toBe(false);
    });

    it("requires --group", () => {
      writeConfig(kTopLevelConfig);
      const result = runCli(["telegram", "topic", "create", "--name", "Launch"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Missing --group for telegram topic create",
      );
    });
  });

  describe("telegram topics list", () => {
    const kLastSeenAt = 1755000000000;
    const seedRegistry = () =>
      writeRegistry({
        version: 2,
        meta: { sweepWatermark: 0 },
        groups: {
          "-100123": {
            channel: "telegram",
            name: "Ops Group",
            topics: {
              12: { name: "Ops", agentId: "ops", lastSeenAt: kLastSeenAt },
              13: { name: "", discovered: true },
              14: { name: "Old", stale: true },
              15: { name: "Gone", deleted: true, deletedAt: 1 },
            },
          },
          "-100999": {
            channel: "telegram",
            name: "Other",
            topics: { 7: { name: "Misc" } },
          },
        },
      });

    it("prints a readable table with all columns", () => {
      seedRegistry();
      const result = runCli(["telegram", "topics", "list"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("GROUP");
      expect(result.stdout).toContain("THREAD");
      expect(result.stdout).toContain("NAME");
      expect(result.stdout).toContain("FLAGS");
      expect(result.stdout).toContain("LAST SEEN");
      expect(result.stdout).toContain("AGENT");
      expect(result.stdout).toContain("Ops Group (-100123)");
      expect(result.stdout).toContain("Other (-100999)");
      expect(result.stdout).toContain("(unnamed, discovered)");
      expect(result.stdout).toContain("stale");
      expect(result.stdout).toContain("deleted");
      expect(result.stdout).toContain(new Date(kLastSeenAt).toISOString());
      expect(result.stdout).toContain("ops");
    });

    it("filters rows with --group", () => {
      seedRegistry();
      const result = runCli(["telegram", "topics", "list", "--group", "-100999"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Other (-100999)");
      expect(result.stdout).not.toContain("-100123");
    });

    it("emits machine-readable output with --json", () => {
      seedRegistry();
      const result = runCli(["telegram", "topics", "list", "--json"]);

      expect(result.status).toBe(0);
      const jsonLine = result.stdout.trim().split("\n").at(-1);
      const rows = JSON.parse(jsonLine);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(5);
      const opsRow = rows.find((row) => row.threadId === "12");
      expect(opsRow).toMatchObject({
        groupId: "-100123",
        groupName: "Ops Group",
        name: "Ops",
        agentId: "ops",
        stale: false,
        deleted: false,
        lastSeenAt: kLastSeenAt,
      });
      expect(rows.find((row) => row.threadId === "15").deleted).toBe(true);
    });

    it("reports an empty registry without failing", () => {
      const result = runCli(["telegram", "topics", "list"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No topics registered.");
    });
  });
});
