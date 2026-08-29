const childProcess = require("child_process");

const {
  OPENCLAW_DIR,
  GOG_KEYRING_PASSWORD,
} = require("../../lib/server/constants");
const modulePath = require.resolve("../../lib/server/commands");
const originalExec = childProcess.exec;

const loadCommandsModule = ({ execMock }) => {
  childProcess.exec = execMock;
  delete require.cache[modulePath];
  return require(modulePath);
};

describe("server/commands", () => {
  afterEach(() => {
    childProcess.exec = originalExec;
    delete require.cache[modulePath];
  });

  it("attaches trimmed stdout and stderr to shellCmd errors", async () => {
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(new Error("boom"), ' {"ok":true} \n', " noisy stderr \n");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { shellCmd } = createCommands({
      gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }),
    });

    await expect(shellCmd("openclaw models list --all --json")).rejects.toMatchObject({
      message: "boom",
      stdout: '{"ok":true}',
      stderr: "noisy stderr",
      cmd: "openclaw models list --all --json",
    });
  });

  it("preserves timeout metadata on clawCmd failures", async () => {
    const timeoutError = Object.assign(new Error("Command failed"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(timeoutError, "", "");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { clawCmd } = createCommands({
      gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }),
    });

    const result = await clawCmd("nodes status --json", {
      quiet: true,
      timeoutMs: 1234,
    });

    expect(execMock).toHaveBeenCalledWith(
      "openclaw nodes status --json",
      expect.objectContaining({
        timeout: 1234,
        killSignal: "SIGTERM",
      }),
      expect.any(Function),
    );
    expect(result).toMatchObject({
      ok: false,
      stdout: "",
      stderr: "",
      code: null,
      killed: true,
      signal: "SIGTERM",
      timedOut: true,
    });
  });

  it("resolves trimmed stdout and logs it for non-json shell commands", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(null, "  hello world \n", "");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { shellCmd } = createCommands({ gatewayEnv: () => ({}) });

    await expect(shellCmd("echo hello ghp_secret123")).resolves.toBe(
      "hello world",
    );

    expect(logSpy).toHaveBeenCalledWith("[onboard] hello world");
    const runningLog = logSpy.mock.calls.find(([message]) =>
      String(message).startsWith("[onboard] Running:"),
    );
    expect(runningLog[0]).toContain("***");
    expect(runningLog[0]).not.toContain("ghp_secret123");
  });

  it("logs clawCmd failures when not quiet", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(Object.assign(new Error("fail"), { code: 2 }), "", "bad flag\n");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { clawCmd } = createCommands({
      gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }),
    });

    const result = await clawCmd("bad command");

    expect(result).toMatchObject({
      ok: false,
      stdout: "",
      stderr: "bad flag",
      code: 2,
      killed: false,
      signal: null,
      timedOut: false,
    });
    expect(logSpy).toHaveBeenCalledWith("[alphaclaw] Running: openclaw bad command");
    expect(logSpy).toHaveBeenCalledWith("[alphaclaw] Error: bad flag");
  });

  it("runs gog commands with the keyring environment", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(null, "ok\n", "");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { gogCmd } = createCommands({ gatewayEnv: () => ({}) });

    const result = await gogCmd("auth list");

    expect(result).toEqual({ ok: true, stdout: "ok", stderr: "" });
    expect(execMock).toHaveBeenCalledWith(
      "gog auth list",
      expect.objectContaining({
        timeout: 15000,
        env: expect.objectContaining({
          XDG_CONFIG_HOME: OPENCLAW_DIR,
          GOG_KEYRING_PASSWORD,
        }),
      }),
      expect.any(Function),
    );
    expect(logSpy).toHaveBeenCalledWith("[alphaclaw] Running: gog auth list");
  });

  it("logs gog command failures when not quiet", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(new Error("gog exploded"), "", "keyring locked\n");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { gogCmd } = createCommands({ gatewayEnv: () => ({}) });

    const result = await gogCmd("gmail list", { quiet: false });

    expect(result).toEqual({ ok: false, stdout: "", stderr: "keyring locked" });
    expect(logSpy).toHaveBeenCalledWith(
      "[alphaclaw] gog error: keyring locked",
    );
  });

  describe("clawCmdWithRetry (gateway rate limiting)", () => {
    const makeExec = (queue) =>
      vi.fn((cmd, opts, callback) => {
        const next = queue.shift();
        if (next.err) {
          callback(Object.assign(new Error("failed"), { code: next.code }), next.stdout || "", next.stderr || "");
        } else {
          callback(null, next.stdout || "", next.stderr || "");
        }
      });

    it("retries on an UNAVAILABLE response honoring retryAfterMs, then succeeds", async () => {
      const execMock = makeExec([
        {
          err: true,
          stderr: '{"code":"UNAVAILABLE","retryable":true,"retryAfterMs":1200}',
        },
        { err: false, stdout: '{"ok":true}' },
      ]);
      const { createCommands } = loadCommandsModule({ execMock });
      const { clawCmdWithRetry } = createCommands({ gatewayEnv: () => ({}) });
      const sleeps = [];
      const result = await clawCmdWithRetry("gateway call config.patch", {
        sleepFn: async (ms) => sleeps.push(ms),
      });
      expect(result.ok).toBe(true);
      expect(sleeps).toEqual([1200]);
      expect(execMock).toHaveBeenCalledTimes(2);
    });

    it("caps the backoff at maxBackoffMs", async () => {
      const execMock = makeExec([
        { err: true, stderr: '{"code":"UNAVAILABLE","retryAfterMs":999999}' },
        { err: false, stdout: "ok" },
      ]);
      const { createCommands } = loadCommandsModule({ execMock });
      const { clawCmdWithRetry } = createCommands({ gatewayEnv: () => ({}) });
      const sleeps = [];
      await clawCmdWithRetry("gateway call config.patch", {
        sleepFn: async (ms) => sleeps.push(ms),
      });
      expect(sleeps).toEqual([30000]);
    });

    it("gives up after maxRetries and returns the last failure", async () => {
      const execMock = makeExec([
        { err: true, stderr: '{"code":"UNAVAILABLE","retryAfterMs":10}' },
        { err: true, stderr: '{"code":"UNAVAILABLE","retryAfterMs":10}' },
        { err: true, stderr: '{"code":"UNAVAILABLE","retryAfterMs":10}' },
      ]);
      const { createCommands } = loadCommandsModule({ execMock });
      const { clawCmdWithRetry } = createCommands({ gatewayEnv: () => ({}) });
      const result = await clawCmdWithRetry("gateway call config.patch", {
        sleepFn: async () => {},
      });
      expect(result.ok).toBe(false);
      expect(execMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("does not retry a non-rate-limit failure", async () => {
      const execMock = makeExec([
        { err: true, stderr: "some other error" },
      ]);
      const { createCommands } = loadCommandsModule({ execMock });
      const { clawCmdWithRetry } = createCommands({ gatewayEnv: () => ({}) });
      const result = await clawCmdWithRetry("gateway call config.patch", {
        sleepFn: async () => {},
      });
      expect(result.ok).toBe(false);
      expect(execMock).toHaveBeenCalledTimes(1);
    });
  });

  // H1: shellCmd's echoed command must never print a secret-valued flag in the
  // clear, even for values that don't match the ghp_/sk- prefixes.
  it("masks --gateway-token and provider secret flags in the shellCmd log", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const execMock = vi.fn((cmd, opts, callback) => callback(null, "", ""));
    const { createCommands } = loadCommandsModule({ execMock });
    const { shellCmd } = createCommands({ gatewayEnv: () => ({}) });

    await shellCmd(
      'openclaw onboard --gateway-token "supersecret-gw" --anthropic-api-key plainkey123 --token bare-token-xyz',
    );

    const runningLog = logSpy.mock.calls.find(([message]) =>
      String(message).startsWith("[onboard] Running:"),
    );
    expect(runningLog[0]).toContain("***");
    expect(runningLog[0]).not.toContain("supersecret-gw");
    expect(runningLog[0]).not.toContain("plainkey123");
    expect(runningLog[0]).not.toContain("bare-token-xyz");
  });

  // execFileCmd runs argv-form (no /bin/sh), so an injection payload is inert.
  it("passes argv through execFileCmd without a shell", async () => {
    const execFileMock = vi.fn((file, args, opts, callback) =>
      callback(null, "done\n", ""),
    );
    const originalExecFile = childProcess.execFile;
    childProcess.execFile = execFileMock;
    try {
      delete require.cache[modulePath];
      const { createCommands } = require(modulePath);
      const { execFileCmd } = createCommands({ gatewayEnv: () => ({}) });

      const payload = "a/b$(touch /tmp/pwn)";
      await expect(
        execFileCmd("openclaw", ["models", "set", "--", payload], {
          timeout: 30000,
        }),
      ).resolves.toBe("done");

      expect(execFileMock).toHaveBeenCalledWith(
        "openclaw",
        ["models", "set", "--", payload],
        expect.objectContaining({ timeout: 30000 }),
        expect.any(Function),
      );
    } finally {
      childProcess.execFile = originalExecFile;
      delete require.cache[modulePath];
    }
  });
});
