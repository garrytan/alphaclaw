const fs = require("fs");
const os = require("os");
const path = require("path");

const envModulePath = "../../lib/server/env";
const constantsModulePath = "../../lib/server/constants";

const loadEnvModule = (rootDir) => {
  vi.resetModules();
  process.env.ALPHACLAW_ROOT_DIR = rootDir;
  return require(envModulePath);
};

describe("server/env", () => {
  let tmpDir;
  let previousRootDir;
  let previousOpenAiApiKey;
  let previousBrightdataApiKey;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-env-"));
    previousRootDir = process.env.ALPHACLAW_ROOT_DIR;
    previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    previousBrightdataApiKey = process.env.BRIGHTDATA_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BRIGHTDATA_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete require.cache[require.resolve(envModulePath)];
    delete require.cache[require.resolve(constantsModulePath)];
    if (previousRootDir === undefined) {
      delete process.env.ALPHACLAW_ROOT_DIR;
    } else {
      process.env.ALPHACLAW_ROOT_DIR = previousRootDir;
    }
    if (previousOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
    if (previousBrightdataApiKey === undefined) {
      delete process.env.BRIGHTDATA_API_KEY;
    } else {
      process.env.BRIGHTDATA_API_KEY = previousBrightdataApiKey;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads duplicate env keys with last-wins semantics", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      [
        "OPENAI_API_KEY=first",
        "BRIGHTDATA_API_KEY=bright",
        "OPENAI_API_KEY=second",
      ].join("\n"),
    );
    const env = loadEnvModule(tmpDir);

    expect(env.readEnvFile()).toEqual([
      { key: "BRIGHTDATA_API_KEY", value: "bright" },
      { key: "OPENAI_API_KEY", value: "second" },
    ]);
  });

  it("shows and keeps the live value of a duplicate key whose last line is empty", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      ["OPENAI_API_KEY=fixture-live", "BRIGHTDATA_API_KEY=bright", "OPENAI_API_KEY="].join("\n"),
    );
    const env = loadEnvModule(tmpDir);

    expect(env.readEnvFile()).toEqual([
      { key: "BRIGHTDATA_API_KEY", value: "bright" },
      { key: "OPENAI_API_KEY", value: "fixture-live" },
    ]);
    env.updateEnvFile((vars) => vars.map((entry) => (entry.key === "BRIGHTDATA_API_KEY" ? { ...entry, value: "changed" } : entry)));
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toBe("BRIGHTDATA_API_KEY=changed\nOPENAI_API_KEY=fixture-live");
  });

  it("reloads duplicate keys idempotently after the effective value is loaded", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      ["OPENAI_API_KEY=first", "OPENAI_API_KEY=second"].join("\n"),
    );
    const env = loadEnvModule(tmpDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(env.reloadEnv()).toBe(true);
    expect(process.env.OPENAI_API_KEY).toBe("second");
    expect(env.reloadEnv()).toBe(false);
    expect(
      logSpy.mock.calls.filter(([line]) => String(line).includes("Env updated")),
    ).toHaveLength(1);
  });

  it("never applies the gateway-env hatch keys from .env (agent self-grant defense)", () => {
    // These control what the OpenClaw child inherits; the agent can write
    // .env, so reloadEnv must ignore them (deployment env only).
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      [
        "OPENAI_API_KEY=ok",
        "ALPHACLAW_GATEWAY_ENV_UNRESTRICTED=1",
        "ALPHACLAW_GATEWAY_ENV_PASSTHROUGH=*",
        // The restart-hardening knob is deployment-only too: an agent-written
        // .env must not shrink the ready budget.
        "GATEWAY_RESTART_READY_TIMEOUT=30",
      ].join("\n"),
    );
    const env = loadEnvModule(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.ALPHACLAW_GATEWAY_ENV_UNRESTRICTED;
    delete process.env.ALPHACLAW_GATEWAY_ENV_PASSTHROUGH;
    const savedReadyTimeout = process.env.GATEWAY_RESTART_READY_TIMEOUT;
    delete process.env.GATEWAY_RESTART_READY_TIMEOUT;

    env.reloadEnv();

    expect(process.env.OPENAI_API_KEY).toBe("ok");
    expect(process.env.ALPHACLAW_GATEWAY_ENV_UNRESTRICTED).toBeUndefined();
    expect(process.env.ALPHACLAW_GATEWAY_ENV_PASSTHROUGH).toBeUndefined();
    expect(process.env.GATEWAY_RESTART_READY_TIMEOUT).toBeUndefined();
    if (savedReadyTimeout !== undefined) {
      process.env.GATEWAY_RESTART_READY_TIMEOUT = savedReadyTimeout;
    }
    // And they never surface through the file readers either.
    expect(env.readEnvFile().some((v) => v.key.startsWith("ALPHACLAW_GATEWAY_ENV_"))).toBe(
      true,
    );
  });

  it("writes a deduped env file using the last value for each key", () => {
    const env = loadEnvModule(tmpDir);

    env.writeEnvFile([
      { key: "OPENAI_API_KEY", value: "first" },
      { key: "BRIGHTDATA_API_KEY", value: "bright" },
      { key: "OPENAI_API_KEY", value: "second" },
    ]);

    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toBe(
      "BRIGHTDATA_API_KEY=bright\nOPENAI_API_KEY=second",
    );
    // Secret-bearing file: 0600 on a fresh inode, even over a looser pre-existing one.
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(tmpDir, ".env")).mode & 0o777).toBe(0o600);
    }
  });

  it("tightens a pre-existing world-readable .env to 0600 on rewrite", () => {
    const env = loadEnvModule(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".env"), "OLD=1", { mode: 0o644 });
    env.writeEnvFile([{ key: "NEW", value: "2" }]);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(tmpDir, ".env")).mode & 0o777).toBe(0o600);
    }
  });

  it("strips line breaks from keys and values before writing (issue #26 hardening)", () => {
    // An embedded newline in a value would inject arbitrary extra .env lines
    // into a file two root-cron shell scripts parse — key/value smuggling.
    const env = loadEnvModule(tmpDir);

    env.writeEnvFile([
      { key: "OPENAI_API_KEY", value: "line1\nEVIL_KEY=oops" },
      { key: "BRIGHTDATA_API_KEY", value: "a\r\nb\u2028c\u2029d e" },
    ]);

    // Every line-break flavor (CR, LF, U+2028, U+2029) is stripped; real
    // spaces are legitimate values (the whole point of the shell-parser fix).
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toBe(
      "OPENAI_API_KEY=line1EVIL_KEY=oops\nBRIGHTDATA_API_KEY=abcd e",
    );
  });

  it("returns an empty list when the env file is missing", () => {
    const env = loadEnvModule(tmpDir);
    expect(env.readEnvFile()).toEqual([]);
  });

  it("skips comments, blank lines, and lines without an equals sign", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      [
        "# a comment",
        "",
        "NOT A KEY VALUE LINE",
        "OPENAI_API_KEY=real",
      ].join("\n"),
    );
    const env = loadEnvModule(tmpDir);

    expect(env.readEnvFile()).toEqual([
      { key: "OPENAI_API_KEY", value: "real" },
    ]);
  });

  it("drops entries without keys when normalizing", () => {
    const env = loadEnvModule(tmpDir);
    expect(
      env.normalizeEnvVars([
        { value: "orphan" },
        { key: "   ", value: "blank" },
        { key: "GOOD", value: "1" },
      ]),
    ).toEqual([{ key: "GOOD", value: "1" }]);
  });

  it("drops NUL-containing names rather than aliasing them in readers, normalizers, and writers", () => {
    const env = loadEnvModule(tmpDir);
    const invalidKeys = ["ALPHACLAW_SETUP_URL\0ignored", "\0OPENAI_API_KEY", "CUSTOM\0_FLAG", ["URL\0ignored"]];
    const good = { key: "CUSTOM_FLAG", value: "kept" };
    for (const key of invalidKeys) expect(env.normalizeEnvKey(key)).toBe("");
    const entries = [...invalidKeys.map((key) => ({ key, value: "private-value" })), good];
    expect(env.normalizeEnvVars(entries)).toEqual([good]);
    fs.writeFileSync(path.join(tmpDir, ".env"), entries.map(({ key, value }) => `${key}=${value}`).join("\n"));
    expect(env.readEnvFile()).toEqual([good]);
    expect(env.readEnvFileStrict()).toEqual([good]);
    env.writeEnvFile(entries);
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toBe("CUSTOM_FLAG=kept");
    env.updateEnvFile((current) => [...current, { key: "URL\0ignored", value: "private-value" }]);
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toBe("CUSTOM_FLAG=kept");
  });

  it("clears process env vars whose file value became empty", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=");
    const env = loadEnvModule(tmpDir);
    process.env.OPENAI_API_KEY = "still-set";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(env.reloadEnv()).toBe(true);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      "[alphaclaw] Env updated: removed OPENAI_API_KEY",
    );
  });

  describe("reload matches boot (ALPH-50)", () => {
    const kKeys = ["SETUP_PASSWORD", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "CUSTOM_FROM_FILE", "HOME", "PATH"];
    let saved;
    beforeEach(() => {
      saved = Object.fromEntries(kKeys.map((key) => [key, process.env[key]]));
    });
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    // Boots the way bin/alphaclaw.js does: the deployment env, recorded,
    // then the .env file's values through the shared overlay rule.
    const sharedModulePath = "../../lib/server/deployment-only-env";
    const boot = (deploymentEnv, envFileText) => {
      fs.writeFileSync(path.join(tmpDir, ".env"), envFileText);
      for (const modulePath of [envModulePath, constantsModulePath, sharedModulePath]) {
        delete require.cache[require.resolve(modulePath)];
      }
      const env = loadEnvModule(tmpDir);
      const shared = require(sharedModulePath);
      for (const key of kKeys) delete process.env[key];
      Object.assign(process.env, deploymentEnv);
      shared.recordDeploymentEnvBaseline({ ...process.env });
      const entries = envFileText
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => ({ key: line.slice(0, line.indexOf("=")).trim(), value: line.slice(line.indexOf("=") + 1) }))
        .filter(({ key }) => !shared.kDeploymentOnlyEnvKeys.includes(key));
      for (const [key, value] of shared.resolveEnvFileOverlay(entries)) process.env[key] = value;
      return env;
    };
    const rewrite = (text) => fs.writeFileSync(path.join(tmpDir, ".env"), text);

    it("platform-set keys with empty .env lines survive an external rewrite and are not logged as removed", () => {
      const env = boot(
        { SETUP_PASSWORD: "platform-pw", ANTHROPIC_API_KEY: "sk-ant-platform", TELEGRAM_BOT_TOKEN: "123:platform" },
        "SETUP_PASSWORD=\nANTHROPIC_API_KEY=\nTELEGRAM_BOT_TOKEN=\n",
      );
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      rewrite("SETUP_PASSWORD=\nANTHROPIC_API_KEY=\nTELEGRAM_BOT_TOKEN=\nCUSTOM_FROM_FILE=x\n");
      expect(env.reloadEnv()).toBe(true);
      expect(process.env.SETUP_PASSWORD).toBe("platform-pw");
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-platform");
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe("123:platform");
      expect(logSpy.mock.calls.map(([line]) => line)).toEqual(["[alphaclaw] Env updated: added CUSTOM_FROM_FILE"]);
    });

    it("a .env value overrides the platform; clearing it restores the platform value; a file-only key is removed", () => {
      const env = boot({ ANTHROPIC_API_KEY: "sk-ant-platform" }, "ANTHROPIC_API_KEY=sk-ant-file\nOPENAI_API_KEY=sk-file-only\n");
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-file");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      rewrite("ANTHROPIC_API_KEY=\nOPENAI_API_KEY=\n");
      expect(env.reloadEnv()).toBe(true);
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-platform");
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(logSpy.mock.calls.map(([line]) => line)).toEqual([
        "[alphaclaw] Env updated: restored from deployment env ANTHROPIC_API_KEY; removed OPENAI_API_KEY",
      ]);
      expect(logSpy.mock.calls.join("\n")).not.toContain("sk-ant");
    });

    it("a known key missing from the file keeps its platform value", () => {
      const env = boot({ TELEGRAM_BOT_TOKEN: "123:platform" }, "CUSTOM_FROM_FILE=x\n");
      rewrite("CUSTOM_FROM_FILE=y\n");
      vi.spyOn(console, "log").mockImplementation(() => {});
      env.reloadEnv();
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe("123:platform");
      expect(process.env.CUSTOM_FROM_FILE).toBe("y");
    });

    it("duplicate keys ending in an empty value keep the earlier value, as at boot", () => {
      const env = boot({}, "OPENAI_API_KEY=first\nOPENAI_API_KEY=\n");
      expect(process.env.OPENAI_API_KEY).toBe("first");
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(env.reloadEnv()).toBe(false);
      expect(process.env.OPENAI_API_KEY).toBe("first");
    });

    it("never touches the keys boot manages after the .env load", () => {
      const env = boot({ HOME: "/platform-home", PATH: "/usr/bin" }, "");
      process.env.HOME = "/data/root";
      process.env.PATH = "/data/root/bin:/usr/bin";
      rewrite("HOME=/elsewhere\nPATH=/tmp/evil\n");
      vi.spyOn(console, "log").mockImplementation(() => {});
      env.reloadEnv();
      expect(process.env.HOME).toBe("/data/root");
      expect(process.env.PATH).toBe("/data/root/bin:/usr/bin");
    });

    it("boot and reload agree: reloading an unchanged file after boot changes nothing", () => {
      const cases = [
        [{ SETUP_PASSWORD: "pw" }, "SETUP_PASSWORD=\n"],
        [{ ANTHROPIC_API_KEY: "platform" }, "ANTHROPIC_API_KEY=file\n"],
        [{}, "OPENAI_API_KEY=a\nOPENAI_API_KEY=\nCUSTOM_FROM_FILE=c\n"],
        [{ TELEGRAM_BOT_TOKEN: "t" }, "ALPHACLAW_SIDECARS=[]\n"],
      ];
      for (const [deploymentEnv, text] of cases) {
        const env = boot(deploymentEnv, text);
        const before = Object.fromEntries(kKeys.map((key) => [key, process.env[key]]));
        vi.spyOn(console, "log").mockImplementation(() => {});
        expect(env.reloadEnv()).toBe(false);
        expect(Object.fromEntries(kKeys.map((key) => [key, process.env[key]]))).toEqual(before);
      }
    });
  });

  it("bin/alphaclaw.js records the deployment baseline before anything changes process.env, and loads .env through the shared overlay", () => {
    const binSource = fs.readFileSync(path.join(__dirname, "../../bin/alphaclaw.js"), "utf8");
    const record = binSource.indexOf("recordDeploymentEnvBaseline(process.env)");
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(binSource.indexOf("process.env.ALPHACLAW_ROOT_DIR ="));
    expect(binSource).toContain("resolveEnvFileOverlay(entries)");
  });

  it("logs env changes as key names only, never values, whatever the key is called", () => {
    const saved = {
      APP_DATABASE_URL: process.env.APP_DATABASE_URL,
      PLAIN_SETTING: process.env.PLAIN_SETTING,
    };
    process.env.OPENAI_API_KEY = "sk-old-value-0000000000";
    process.env.BRIGHTDATA_API_KEY = "bright-old";
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      [
        "APP_DATABASE_URL=postgres://app:hunter2-db-password@db.internal:5432/app",
        "PLAIN_SETTING=plain-visible-value",
        "OPENAI_API_KEY=sk-new-value-1111111111",
        "BRIGHTDATA_API_KEY=",
      ].join("\n"),
    );
    const env = loadEnvModule(tmpDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(env.reloadEnv()).toBe(true);
      const lines = logSpy.mock.calls.map(([line]) => String(line));
      expect(lines).toEqual([
        "[alphaclaw] Env updated: added APP_DATABASE_URL, PLAIN_SETTING; changed OPENAI_API_KEY; removed BRIGHTDATA_API_KEY",
      ]);
      for (const value of ["hunter2", "plain-visible-value", "sk-new-value", "sk-old-value", "bright-old"]) {
        expect(lines.join("\n")).not.toContain(value);
      }
      expect(process.env.APP_DATABASE_URL).toBe(
        "postgres://app:hunter2-db-password@db.internal:5432/app",
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reloads when the watcher fires and the env file is unreadable", () => {
    vi.useFakeTimers();
    const env = loadEnvModule(tmpDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let watchHandler = null;
    vi.spyOn(fs, "watchFile").mockImplementation((filePath, options, handler) => {
      watchHandler = handler;
    });

    env.startEnvWatcher();
    // No .env file exists, so the signature read fails and a reload runs.
    watchHandler();
    vi.advanceTimersByTime(250);

    expect(
      logSpy.mock.calls.filter(([line]) =>
        String(line).includes("changed externally, reloading"),
      ),
    ).toHaveLength(1);
  });

  it("skips reloads when the watched file content is unchanged", () => {
    vi.useFakeTimers();
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=stable");
    const env = loadEnvModule(tmpDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let watchHandler = null;
    vi.spyOn(fs, "watchFile").mockImplementation((filePath, options, handler) => {
      watchHandler = handler;
    });

    env.reloadEnv();
    env.startEnvWatcher();
    watchHandler();
    vi.advanceTimersByTime(250);

    expect(process.env.OPENAI_API_KEY).toBe("stable");
    expect(
      logSpy.mock.calls.filter(([line]) =>
        String(line).includes("changed externally, reloading"),
      ),
    ).toHaveLength(0);
  });

  it("reloads when only an earlier non-empty duplicate changes before an unchanged empty one", () => {
    vi.useFakeTimers();
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=fixture-a\nOPENAI_API_KEY=");
    const env = loadEnvModule(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    let watchHandler = null;
    vi.spyOn(fs, "watchFile").mockImplementation((filePath, options, handler) => {
      watchHandler = handler;
    });

    env.reloadEnv();
    expect(process.env.OPENAI_API_KEY).toBe("fixture-a");
    env.startEnvWatcher();
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=fixture-b\nOPENAI_API_KEY=");
    watchHandler();
    vi.advanceTimersByTime(250);

    expect(process.env.OPENAI_API_KEY).toBe("fixture-b");
  });

  it("debounces env watcher events and ignores AlphaClaw's own writes", () => {
    vi.useFakeTimers();
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=first");
    const env = loadEnvModule(tmpDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let watchHandler = null;
    const watchSpy = vi
      .spyOn(fs, "watchFile")
      .mockImplementation((filePath, options, handler) => {
        watchHandler = handler;
      });

    env.startEnvWatcher();
    expect(watchSpy).toHaveBeenCalled();

    env.writeEnvFile([{ key: "OPENAI_API_KEY", value: "second" }]);
    watchHandler();
    vi.advanceTimersByTime(250);

    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("changed externally, reloading"),
    );

    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=third");
    watchHandler();
    fs.writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=fourth");
    watchHandler();
    vi.advanceTimersByTime(249);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    vi.advanceTimersByTime(1);

    expect(process.env.OPENAI_API_KEY).toBe("fourth");
    expect(
      logSpy.mock.calls.filter(([line]) =>
        String(line).includes("changed externally, reloading"),
      ),
    ).toHaveLength(1);
  });
});
