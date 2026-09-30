const childProcess = require("child_process");

const {
  OPENCLAW_DIR,
  GOG_KEYRING_PASSWORD,
} = require("../../lib/server/constants");
const { EventEmitter } = require("events");
const modulePath = require.resolve("../../lib/server/commands");
const originalExec = childProcess.exec;
const originalSpawn = childProcess.spawn;

const loadCommandsModule = ({ execMock, spawnMock } = {}) => {
  if (execMock) childProcess.exec = execMock;
  if (spawnMock) childProcess.spawn = spawnMock;
  delete require.cache[modulePath];
  return require(modulePath);
};

// A fake clawCmd child: no pid (so the group kill falls back to child.kill),
// emits the scripted output and close on the next tick; `hang` never closes
// until killed.
const makeFakeChild = ({ code = 0, signal = null, stdout = "", stderr = "", hang = false } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((sig) => {
    setImmediate(() => child.emit("close", null, sig));
  });
  if (!hang) {
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code, signal);
    });
  }
  return child;
};

describe("server/commands", () => {
  afterEach(() => {
    childProcess.exec = originalExec;
    childProcess.spawn = originalSpawn;
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
    const spawnMock = vi.fn(() => makeFakeChild({ hang: true }));
    const { createCommands } = loadCommandsModule({ spawnMock });
    const { clawCmd } = createCommands({
      gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }),
    });

    const result = await clawCmd("nodes status --json", {
      quiet: true,
      timeoutMs: 20,
    });

    // Own process group via spawn (exec ignores `detached`); the command text
    // still runs through /bin/sh unchanged.
    expect(spawnMock).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "openclaw nodes status --json"],
      expect.objectContaining({
        detached: true,
        env: { OPENCLAW_GATEWAY_TOKEN: "token" },
      }),
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

  it("keeps multi-byte UTF-8 clawCmd output intact across chunk boundaries", async () => {
    const { PassThrough } = require("stream");
    const spawnMock = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const bytes = Buffer.from("aé", "utf8"); // 61 c3 a9
      setImmediate(() => {
        child.stdout.write(bytes.subarray(0, 2)); // splits "é"
        child.stdout.end(bytes.subarray(2));
        child.stderr.end();
        setImmediate(() => child.emit("close", 0, null));
      });
      return child;
    });
    const { createCommands } = loadCommandsModule({ spawnMock });
    const { clawCmd } = createCommands({ gatewayEnv: () => ({}) });

    const result = await clawCmd("x", { quiet: true });

    expect(result).toMatchObject({ ok: true, stdout: "aé" });
  });

  it("logs clawCmd failures when not quiet", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const spawnMock = vi.fn(() => makeFakeChild({ code: 2, stderr: "bad flag\n" }));
    const { createCommands } = loadCommandsModule({ spawnMock });
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

  it("scrubs token-bearing URL params from the failed-command stderr log", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const spawnMock = vi.fn(() =>
      makeFakeChild({
        code: 1,
        stderr: "could not open http://127.0.0.1:18789/#token=leaky-shared-token — also ?bootstrapToken=leaky-handoff expired\n",
      }),
    );
    const { createCommands } = loadCommandsModule({ spawnMock });
    const { clawCmd } = createCommands({ gatewayEnv: () => ({}) });

    const result = await clawCmd("dashboard --no-open");

    // The raw result still carries stderr for callers that redact themselves;
    // only the shared console log line is scrubbed.
    expect(result.stderr).toContain("leaky-shared-token");
    const errorLines = logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[alphaclaw] Error:"));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).not.toContain("leaky-shared-token");
    expect(errorLines[0]).not.toContain("leaky-handoff");
    expect(errorLines[0]).toContain("#token=***");
    expect(errorLines[0]).toContain("?bootstrapToken=***");
  });

  it("runs gog commands with the keyring environment", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(null, "ok\n", "");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { gogCmd } = createCommands({ gatewayEnv: () => ({}) });

    const result = await gogCmd("auth list");

    // timedOut/code distinguish a transient (killed/timeout) failure from a
    // clean nonzero exit — success carries the defaults.
    expect(result).toEqual({
      ok: true,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      code: null,
    });
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

    // A plain Error (no .killed) is a clean failure: timedOut false, code null.
    expect(result).toEqual({
      ok: false,
      stdout: "",
      stderr: "keyring locked",
      timedOut: false,
      code: null,
    });
    expect(logSpy).toHaveBeenCalledWith(
      "[alphaclaw] gog error: keyring locked",
    );
  });

  it("flags a killed/timed-out gog command as timedOut (transient, not no-token)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const execMock = vi.fn((cmd, opts, callback) => {
      const err = new Error("timed out");
      err.killed = true;
      err.signal = "SIGTERM";
      callback(err, "", "");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { gogCmd } = createCommands({ gatewayEnv: () => ({}) });

    const result = await gogCmd("auth tokens export foo", { quiet: true });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  describe("clawCmdWithRetry (gateway rate limiting)", () => {
    const makeSpawn = (queue) =>
      vi.fn(() => {
        const next = queue.shift();
        return makeFakeChild({
          code: next.err ? (next.code ?? 1) : 0,
          stdout: next.stdout || "",
          stderr: next.stderr || "",
        });
      });

    it("retries on an UNAVAILABLE response honoring retryAfterMs, then succeeds", async () => {
      const spawnMock = makeSpawn([
        {
          err: true,
          stderr: '{"code":"UNAVAILABLE","retryable":true,"retryAfterMs":1200}',
        },
        { err: false, stdout: '{"ok":true}' },
      ]);
      const { createCommands } = loadCommandsModule({ spawnMock });
      const { clawCmdWithRetry } = createCommands({ gatewayEnv: () => ({}) });
      const sleeps = [];
      const result = await clawCmdWithRetry("gateway call config.patch", {
        sleepFn: async (ms) => sleeps.push(ms),
      });
      expect(result.ok).toBe(true);
      expect(sleeps).toEqual([1200]);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("caps the backoff at maxBackoffMs", async () => {
      const spawnMock = makeSpawn([
        { err: true, stderr: '{"code":"UNAVAILABLE","retryAfterMs":999999}' },
        { err: false, stdout: "ok" },
      ]);
      const { createCommands } = loadCommandsModule({ spawnMock });
      const { clawCmdWithRetry } = createCommands({ gatewayEnv: () => ({}) });
      const sleeps = [];
      await clawCmdWithRetry("gateway call config.patch", {
        sleepFn: async (ms) => sleeps.push(ms),
      });
      expect(sleeps).toEqual([30000]);
    });

    it("gives up after maxRetries and returns the last failure", async () => {
      const spawnMock = makeSpawn([
        { err: true, stderr: '{"code":"UNAVAILABLE","retryAfterMs":10}' },
        { err: true, stderr: '{"code":"UNAVAILABLE","retryAfterMs":10}' },
        { err: true, stderr: '{"code":"UNAVAILABLE","retryAfterMs":10}' },
      ]);
      const { createCommands } = loadCommandsModule({ spawnMock });
      const { clawCmdWithRetry } = createCommands({ gatewayEnv: () => ({}) });
      const result = await clawCmdWithRetry("gateway call config.patch", {
        sleepFn: async () => {},
      });
      expect(result.ok).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("does not retry a non-rate-limit failure", async () => {
      const spawnMock = makeSpawn([
        { err: true, stderr: "some other error" },
      ]);
      const { createCommands } = loadCommandsModule({ spawnMock });
      const { clawCmdWithRetry } = createCommands({ gatewayEnv: () => ({}) });
      const result = await clawCmdWithRetry("gateway call config.patch", {
        sleepFn: async () => {},
      });
      expect(result.ok).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(1);
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

// Issue #76 C6: while the watchdog has a versionMismatch latched, the repair
// doctor step and the capability probes must run the EXPECTED overlay's bin,
// never whatever `openclaw` resolves to on PATH. clawCmdWithBin is clawCmd's
// argv-form twin for that: `process.execPath [bin, ...args]`, caller env, same
// result object.
// Real processes, no exec mock: a fake `openclaw` on PATH that backgrounds a
// grandchild and waits, exactly the shape dash gives `exec("openclaw …")`.
describe("server/commands clawCmd timeout kills the whole process group", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  let dir;
  // Zombies (exited, not yet reaped) cannot write: count them as gone.
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      return state !== "Z" && state !== "X";
    } catch {
      return true;
    }
  };
  const writeFakeOpenclaw = (body) => {
    const bin = path.join(dir, "openclaw");
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  const readPids = () =>
    fs
      .readFileSync(path.join(dir, "pids"), "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  const waitFor = async (predicate, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return predicate();
  };
  const loadClawCmd = () => {
    delete require.cache[modulePath];
    const { createCommands } = require(modulePath);
    return createCommands({
      gatewayEnv: () => ({ ...process.env, PATH: `${dir}:${process.env.PATH}` }),
    }).clawCmd;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawcmd-group-"));
  });
  afterEach(() => {
    for (const pid of fs.existsSync(path.join(dir, "pids")) ? readPids() : []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves no openclaw grandchild alive after a timeout", async () => {
    writeFakeOpenclaw(`sleep 30 &\necho "$$ $!" > "${dir}/pids"\nwait`);
    const clawCmd = loadClawCmd();

    const result = await clawCmd("channels add --channel telegram", {
      quiet: true,
      timeoutMs: 500,
    });

    expect(result).toMatchObject({ ok: false, killed: true, timedOut: true });
    const pids = readPids();
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  });

  it("SIGKILLs a group that ignores the timeout signal once the grace period ends", async () => {
    writeFakeOpenclaw(
      [
        "trap '' TERM",
        `sh -c 'trap "" TERM; sleep 30 & echo $! >> "${dir}/pids"; echo $$ >> "${dir}/pids"; wait' &`,
        `echo $$ >> "${dir}/pids"`,
        "wait",
      ].join("\n"),
    );
    const clawCmd = loadClawCmd();

    const startedAt = Date.now();
    const result = await clawCmd("pairing list --channel telegram --json", {
      quiet: true,
      timeoutMs: 300,
      killGraceMs: 400,
    });
    const elapsed = Date.now() - startedAt;

    expect(result).toMatchObject({ ok: false, timedOut: true });
    // Nothing honours SIGTERM, so only the SIGKILL at timeout + grace ends it.
    expect(elapsed).toBeGreaterThanOrEqual(650);
    const pids = readPids();
    expect(pids).toHaveLength(3); // outer sh, inner sh, sleep
    expect(await waitFor(() => pids.every((pid) => !isAlive(pid)), 2000)).toBe(true);
  });

  it("settles after the grace period even when a setsid'd descendant holds the pipes", async () => {
    writeFakeOpenclaw(`setsid sleep 30 &\necho "$!" > "${dir}/pids"\nwait`);
    const clawCmd = loadClawCmd();

    const startedAt = Date.now();
    const result = await clawCmd("x", { quiet: true, timeoutMs: 300, killGraceMs: 300 });

    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("killScope leader keeps the CLI running and writing past the call (WhatsApp QR login)", async () => {
    // The shell wrapper is the leader; the CLI keeps printing after the call
    // returns (a closed pipe would SIGPIPE it) and only then finishes.
    writeFakeOpenclaw(
      `echo QR-BLOCK\nsleep 1\necho more-output\necho linked > "${dir}/marker"\necho $$ > "${dir}/pids"`,
    );
    const clawCmd = loadClawCmd();

    const result = await clawCmd("channels login --channel whatsapp", {
      quiet: true,
      timeoutMs: 300,
      killSignal: "SIGKILL",
      killScope: "leader",
    });

    expect(result).toMatchObject({ ok: false, timedOut: true, stdout: "QR-BLOCK" });
    expect(await waitFor(() => fs.existsSync(path.join(dir, "marker")), 5000)).toBe(true);
  });

  it("killScope leader settles when the leader already exited but a descendant holds the pipes", async () => {
    writeFakeOpenclaw(`(sleep 30; true) &\necho "$!" > "${dir}/pids"\nexit 0`);
    delete require.cache[modulePath];
    const { createCommands } = require(modulePath);
    const clawCmd = createCommands({
      gatewayEnv: () => ({ ...process.env, PATH: `${dir}:${process.env.PATH}` }),
    }).clawCmd;
    // `exec` makes the fake CLI the shell itself, so the backgrounded
    // subshell is the only pipe holder once the leader exits.
    const startedAt = Date.now();
    const result = await clawCmd("x", { quiet: true, timeoutMs: 400, killScope: "leader" });

    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("fails an output overflow like exec's maxBuffer (reads as a timeout)", async () => {
    writeFakeOpenclaw(`head -c 5000 /dev/zero | tr '\\0' x\nsleep 30`);
    const clawCmd = loadClawCmd();

    const result = await clawCmd("x", { quiet: true, timeoutMs: 10000, maxBuffer: 1000 });

    expect(result).toMatchObject({
      ok: false,
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      killed: true,
      timedOut: true,
    });
  });

  it("stops retaining output past the cap while a TERM-resistant CLI keeps writing", async () => {
    writeFakeOpenclaw(`trap '' TERM\nwhile :; do head -c 65536 /dev/zero | tr '\\0' x; done`);
    const clawCmd = loadClawCmd();

    const result = await clawCmd("x", {
      quiet: true,
      timeoutMs: 10000,
      maxBuffer: 100000,
      killGraceMs: 500,
    });

    expect(result).toMatchObject({ ok: false, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    // At most one pipe chunk past the cap is kept.
    expect(result.stdout.length).toBeLessThanOrEqual(100000 + 65536);
  });

  it("counts the output cap in bytes, not characters", async () => {
    // 400 three-byte characters = 1200 bytes > a 1000-byte cap (400 chars < it).
    writeFakeOpenclaw(`printf '中%.0s' $(seq 1 400)\nsleep 30`);
    const clawCmd = loadClawCmd();

    const result = await clawCmd("x", { quiet: true, timeoutMs: 10000, maxBuffer: 1000 });

    expect(result).toMatchObject({ ok: false, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it("returns a fast command's output unchanged, with no code on success", async () => {
    writeFakeOpenclaw(`echo "out:$*"\necho err >&2`);
    const clawCmd = loadClawCmd();

    const result = await clawCmd("pairing list --json", { quiet: true, timeoutMs: 5000 });

    expect(result).toEqual({
      ok: true,
      stdout: "out:pairing list --json",
      stderr: "err",
      code: undefined,
    });
  });
});

describe("server/commands clawCmdWithBin (#76 C6)", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const kBin = "/opt/alphaclaw/openclaw-overlays/2026.9.2/bin/openclaw.js";
  const originalExecFile = childProcess.execFile;

  const loadWithExecFile = (execFileMock) => {
    childProcess.execFile = execFileMock;
    childProcess.exec = vi.fn(() => {
      throw new Error("clawCmdWithBin must never reach the shell exec");
    });
    delete require.cache[modulePath];
    return require(modulePath);
  };

  afterEach(() => {
    childProcess.execFile = originalExecFile;
    childProcess.exec = originalExec;
    delete require.cache[modulePath];
    vi.restoreAllMocks();
  });

  it("runs the bin under the CURRENT node as argv with the caller's env, and mirrors clawCmd's result shape — stderr survives on exit 0", async () => {
    const execFileMock = vi.fn((file, args, opts, callback) =>
      callback(null, "Usage: openclaw gateway stop [options]\n  --force\n", " deprecation warning \n"),
    );
    const { createCommands } = loadWithExecFile(execFileMock);
    const { clawCmdWithBin } = createCommands({ gatewayEnv: () => ({ FROM: "gateway" }) });
    const env = { OPENCLAW_STATE_DIR: "/data/openclaw", HOME: "/data" };

    const result = await clawCmdWithBin(kBin, "gateway stop --help", {
      quiet: true,
      timeoutMs: 1234,
      env,
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFileMock.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([kBin, "gateway", "stop", "--help"]);
    expect(opts).toEqual(
      expect.objectContaining({ env, timeout: 1234, killSignal: "SIGTERM" }),
    );
    // The caller-supplied env is used verbatim — never merged with the
    // gateway env (an UNVERIFIED candidate is probed under probeEnv()).
    expect(opts.env).toBe(env);
    // Same shape as clawCmd's success: ok + trimmed stdout/stderr (the help
    // probes read `${stdout}\n${stderr}`, so stderr must not be dropped).
    expect(result).toEqual({
      ok: true,
      stdout: "Usage: openclaw gateway stop [options]\n  --force",
      stderr: "deprecation warning",
    });
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it("defaults to clawCmd's 15s SIGTERM timeout and the gateway env when the caller supplies none", async () => {
    const execFileMock = vi.fn((file, args, opts, callback) => callback(null, "", ""));
    const { createCommands } = loadWithExecFile(execFileMock);
    const gatewayEnvValue = { OPENCLAW_GATEWAY_TOKEN: "token", HOME: "/data" };
    const { clawCmdWithBin } = createCommands({ gatewayEnv: () => gatewayEnvValue });

    await clawCmdWithBin(kBin, "doctor --json", { quiet: true });

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.timeout).toBe(15000);
    expect(opts.killSignal).toBe("SIGTERM");
    expect(opts.env).toBe(gatewayEnvValue);
  });

  it("reports a clean nonzero exit like clawCmd (code, killed:false, signal:null, timedOut:false) and logs the scrubbed stderr when not quiet", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const execFileMock = vi.fn((file, args, opts, callback) =>
      callback(
        Object.assign(new Error("Command failed"), { code: 2 }),
        "",
        "could not open http://127.0.0.1:18789/#token=leaky-shared-token\n",
      ),
    );
    const { createCommands } = loadWithExecFile(execFileMock);
    const { clawCmdWithBin } = createCommands({ gatewayEnv: () => ({}) });

    const result = await clawCmdWithBin(kBin, "dashboard --no-open");

    expect(result).toEqual({
      ok: false,
      stdout: "",
      stderr: "could not open http://127.0.0.1:18789/#token=leaky-shared-token",
      code: 2,
      killed: false,
      signal: null,
      timedOut: false,
    });
    expect(logSpy).toHaveBeenCalledWith(
      `[alphaclaw] Running: ${kBin} dashboard --no-open`,
    );
    const errorLines = logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[alphaclaw] Error:"));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("#token=***");
    expect(errorLines[0]).not.toContain("leaky-shared-token");
  });

  it("quiet suppresses both the Running and the Error log lines", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const execFileMock = vi.fn((file, args, opts, callback) =>
      callback(Object.assign(new Error("fail"), { code: 1 }), "", "bad\n"),
    );
    const { createCommands } = loadWithExecFile(execFileMock);
    const { clawCmdWithBin } = createCommands({ gatewayEnv: () => ({}) });

    const result = await clawCmdWithBin(kBin, "bad command", { quiet: true });

    expect(result.ok).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("preserves timeout metadata (killed by the configured killSignal → timedOut) like clawCmd", async () => {
    const execFileMock = vi.fn((file, args, opts, callback) =>
      callback(
        Object.assign(new Error("Command failed"), {
          code: null,
          killed: true,
          signal: "SIGKILL",
        }),
        "",
        "",
      ),
    );
    const { createCommands } = loadWithExecFile(execFileMock);
    const { clawCmdWithBin } = createCommands({ gatewayEnv: () => ({}) });

    const result = await clawCmdWithBin(kBin, "nodes status --json", {
      quiet: true,
      timeoutMs: 50,
      killSignal: "SIGKILL",
    });

    expect(execFileMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 50, killSignal: "SIGKILL" }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: null,
      killed: true,
      signal: "SIGKILL",
      timedOut: true,
    });
  });

  it("splits the trusted command text without a shell (quotes group, nothing expands) and passes an argv array through untouched", async () => {
    const execFileMock = vi.fn((file, args, opts, callback) => callback(null, "", ""));
    const { createCommands } = loadWithExecFile(execFileMock);
    const { clawCmdWithBin } = createCommands({ gatewayEnv: () => ({}) });

    const payload = "a/b$(touch /tmp/pwn);rm -rf ~";
    await clawCmdWithBin(kBin, `models set --name "two words" -- ${payload}`, {
      quiet: true,
    });
    expect(execFileMock.mock.calls[0][1]).toEqual([
      kBin,
      "models",
      "set",
      "--name",
      "two words",
      "--",
      "a/b$(touch",
      "/tmp/pwn);rm",
      "-rf",
      "~",
    ]);

    await clawCmdWithBin(kBin, ["config", "get", "gateway.auth mode", "--json"], {
      quiet: true,
    });
    expect(execFileMock.mock.calls[1][1]).toEqual([
      kBin,
      "config",
      "get",
      "gateway.auth mode",
      "--json",
    ]);
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it("rejects a missing bin path instead of silently falling back to PATH openclaw", async () => {
    const execFileMock = vi.fn();
    const { createCommands } = loadWithExecFile(execFileMock);
    const { clawCmdWithBin } = createCommands({ gatewayEnv: () => ({}) });

    await expect(clawCmdWithBin("", "gateway stop --help")).rejects.toThrow(TypeError);
    await expect(clawCmdWithBin(null, "gateway stop --help")).rejects.toThrow(
      /requires a bin path/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("really executes a JS bin under process.execPath with ONLY the supplied env (no shebang, no +x needed)", async () => {
    // Real spawn, hermetic: a throwaway "bin" in a private tmpdir echoes what
    // it received. No mocks — the original child_process.execFile.
    delete require.cache[modulePath];
    const { createCommands } = require(modulePath);
    const { clawCmdWithBin } = createCommands({
      gatewayEnv: () => {
        throw new Error("gatewayEnv must not be consulted when env is supplied");
      },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-clawcmd-bin-"));
    try {
      const bin = path.join(dir, "openclaw.js");
      // Deliberately NOT executable and without a shebang: the node runner is
      // what makes it runnable, exactly as for an overlay's bin.
      fs.writeFileSync(
        bin,
        [
          "process.stdout.write(JSON.stringify({",
          "  argv: process.argv.slice(2),",
          "  marker: process.env.ALPHACLAW_TEST_MARKER ?? null,",
          "  leaked: Object.keys(process.env).filter((k) => k.startsWith('ALPHACLAW_TEST_LEAK')),",
          "}));",
          "process.stderr.write('warned\\n');",
          "process.exit(Number(process.env.ALPHACLAW_TEST_EXIT || 0));",
        ].join("\n"),
        { mode: 0o644 },
      );
      const env = { ALPHACLAW_TEST_MARKER: "m1", ALPHACLAW_TEST_EXIT: "0" };
      process.env.ALPHACLAW_TEST_LEAK_PARENT = "1";
      try {
        const ok = await clawCmdWithBin(bin, "gateway stop --help", {
          quiet: true,
          env,
          timeoutMs: 20000,
        });
        expect(ok.ok).toBe(true);
        expect(ok.stderr).toBe("warned");
        expect(JSON.parse(ok.stdout)).toEqual({
          argv: ["gateway", "stop", "--help"],
          marker: "m1",
          leaked: [],
        });

        const failed = await clawCmdWithBin(bin, ["doctor", "--json"], {
          quiet: true,
          env: { ...env, ALPHACLAW_TEST_EXIT: "3" },
          timeoutMs: 20000,
        });
        expect(failed).toMatchObject({
          ok: false,
          code: 3,
          killed: false,
          signal: null,
          timedOut: false,
          stderr: "warned",
        });
        expect(JSON.parse(failed.stdout).argv).toEqual(["doctor", "--json"]);
      } finally {
        delete process.env.ALPHACLAW_TEST_LEAK_PARENT;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // execFileCmd now shares the argv primitive with clawCmdWithBin; its
  // rejection contract (Error with trimmed stdout/stderr attached) is pinned
  // so the refactor cannot regress the callers that catch it.
  it("execFileCmd still rejects with trimmed stdout/stderr attached to the error", async () => {
    const execFileMock = vi.fn((file, args, opts, callback) =>
      callback(Object.assign(new Error("boom"), { code: 7 }), ' {"ok":false} \n', " nope \n"),
    );
    const { createCommands } = loadWithExecFile(execFileMock);
    const { execFileCmd } = createCommands({ gatewayEnv: () => ({}) });

    await expect(execFileCmd("openclaw", ["models", "list"], { timeoutMs: 999 })).rejects.toMatchObject({
      message: "boom",
      code: 7,
      stdout: '{"ok":false}',
      stderr: "nope",
    });
    expect(execFileMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 999 }),
    );
  });

  describe("splitCommandLine", () => {
    const { splitCommandLine } = require("../../lib/server/commands");

    it.each([
      ["gateway stop --help", ["gateway", "stop", "--help"]],
      ["  leading   and  trailing  ", ["leading", "and", "trailing"]],
      ['config set a "two words" \'single quoted\'', ["config", "set", "a", "two words", "single quoted"]],
      ['--name="glued value" tail', ["--name=glued value", "tail"]],
      ['"" empty-arg-kept', ["", "empty-arg-kept"]],
      ["$HOME `id` ; && || > out", ["$HOME", "`id`", ";", "&&", "||", ">", "out"]],
      ['unterminated "runs to end', ["unterminated", "runs to end"]],
      ["", []],
      [null, []],
    ])("splits %j", (input, expected) => {
      expect(splitCommandLine(input)).toEqual(expected);
    });
  });
});
