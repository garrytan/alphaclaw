const { EventEmitter } = require("events");
const {
  createClaudeCodeLocalService,
} = require("../../lib/server/claude-code-local");

// ---------------------------------------------------------------- fakes ----

const kOauthFixtureLine =
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=xyz\nPaste code here if prompted >";

const createFakeFs = () => {
  const files = new Map();
  const dirs = new Set(["/proc/4242"]);
  return {
    files,
    dirs,
    mkdirSync: vi.fn((dir) => dirs.add(dir)),
    existsSync: vi.fn((p) => files.has(p) || dirs.has(p)),
    readFileSync: vi.fn((p) => {
      if (!files.has(p)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    }),
    writeFileSync: vi.fn((p, data, opts) => {
      if (opts?.flag === "wx" && files.has(p)) {
        const err = new Error("EEXIST");
        err.code = "EEXIST";
        throw err;
      }
      files.set(p, String(data));
    }),
    renameSync: vi.fn((from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    }),
    rmSync: vi.fn((p) => {
      files.delete(p);
      dirs.delete(p);
    }),
  };
};

// A controllable tmux driver: tests script the pane buffer and liveness.
const createFakeDriver = () => {
  const state = {
    buffer: "",
    sessionAlive: false,
    panePid: 4242,
    paneDead: false,
    newSessionResult: { code: 0, stdout: "", stderr: "" },
    tmuxOk: true,
  };
  const driver = {
    state,
    socketPath: "/data/claude-code-local/tmux.sock",
    hasTmux: vi.fn(async () => ({ ok: state.tmuxOk, version: "tmux 3.6a" })),
    newSession: vi.fn(async () => {
      if (state.newSessionResult.code === 0) state.sessionAlive = true;
      return state.newSessionResult;
    }),
    hasSession: vi.fn(async () => ({ alive: state.sessionAlive })),
    capturePane: vi.fn(async () => (state.sessionAlive ? state.buffer : null)),
    listPaneInfo: vi.fn(async () =>
      state.sessionAlive ? { panePid: state.panePid, paneDead: state.paneDead } : null,
    ),
    sendKeys: vi.fn(async () => ({ code: 0 })),
    killSession: vi.fn(async () => {
      state.sessionAlive = false;
      return { ok: true };
    }),
  };
  return driver;
};

const createFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn();
  child.pid = 5150;
  return child;
};

const createFakeRunStream = ({ loggedIn = true, installed = true } = {}) => {
  const stream = {
    loggedIn,
    installed,
    runStreamed: vi.fn(async ({ args }) => {
      if (args[0] === "--version") {
        return stream.installed
          ? { ok: true, code: 0, tail: "2.1.237 (Claude Code)" }
          : { ok: false, code: null, error: "spawn claude ENOENT", tail: "" };
      }
      if (args[0] === "auth") {
        return {
          ok: true,
          code: 0,
          tail: JSON.stringify({ loggedIn: stream.loggedIn, authMethod: "oauth" }),
        };
      }
      return { ok: true, code: 0, tail: "" };
    }),
  };
  return stream;
};

const kPaths = {
  root: "/data/claude-code-local",
  home: "/data/claude-code-local/home",
  workspace: "/data/claude-code-local/workspace",
  stateFile: "/data/claude-code-local/state.json",
  socket: "/data/claude-code-local/tmux.sock",
  lockFile: "/data/claude-code-local/lifecycle.lock",
};

const kFastTimers = {
  urlPollMs: 2,
  urlDeadlineMs: 250,
  trustWatchMs: 2,
  loginPollMs: 2,
  loginTtlMs: 500,
  probeMs: 60_000,
};

const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const createService = ({ env = {}, driver, fsModule, runStream, spawnImpl, getResources, timers } = {}) => {
  const fakeDriver = driver || createFakeDriver();
  const fakeFs = fsModule || createFakeFs();
  return {
    driver: fakeDriver,
    fsModule: fakeFs,
    service: createClaudeCodeLocalService({
      env,
      fsModule: fakeFs,
      tmux: fakeDriver,
      runStream: runStream || createFakeRunStream(),
      spawnImpl,
      getResources,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      paths: kPaths,
      timers: timers || kFastTimers,
    }),
  };
};

// ---------------------------------------------------------------- tests ----

describe("claude-code-local service", () => {
  describe("rescue env allowlist", () => {
    it("never carries Anthropic credentials, routine config, growthbook, or BROWSER", () => {
      const { service } = createService({
        env: {
          PATH: "/usr/bin",
          ANTHROPIC_API_KEY: "sk-ant-poison",
          ANTHROPIC_AUTH_TOKEN: "poison2",
          CLAUDE_CODE_OAUTH_TOKEN: "poison3",
          DISABLE_GROWTHBOOK: "1",
          CLAUDE_CODE_ROUTINE_TOKEN: "poison4",
          CLAUDE_CODE_ROUTINE_URL: "poison5",
          BROWSER: "xdg-open",
          SETUP_PASSWORD: "hunter2",
        },
      });
      const rescueEnv = service._internals.buildRescueEnv();
      expect(rescueEnv).toEqual({
        PATH: "/usr/bin",
        TERM: "xterm-256color",
        HOME: kPaths.home,
        CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX: "alphaclaw",
      });
      const serialized = JSON.stringify(rescueEnv);
      for (const poison of ["poison", "hunter2", "GROWTHBOOK", "BROWSER"]) {
        expect(serialized).not.toContain(poison);
      }
    });
  });

  describe("spawn command", () => {
    it("builds argv-form (no shell string) with env -i pairs", () => {
      const { service } = createService({ env: { PATH: "/usr/bin" } });
      const { argv } = service._internals.buildSpawnCommand({ source: "click" });
      expect(argv[0]).toBe("env");
      expect(argv[1]).toBe("-i");
      expect(argv).toContain("claude");
      expect(argv).toContain("remote-control");
      // Hostile env values pass through inertly as single argv items.
      const { service: hostile } = createService({
        env: { PATH: "/usr/bin; rm -rf / '\"$(boom)" },
      });
      const hostileArgv = hostile._internals.buildSpawnCommand({ source: "click" }).argv;
      expect(hostileArgv).toContain("PATH=/usr/bin; rm -rf / '\"$(boom)");
      expect(hostileArgv.every((token) => typeof token === "string")).toBe(true);
    });

    it("clamps unattended spawns to acceptEdits even when bypassPermissions is configured", () => {
      const { service } = createService({
        env: { CLAUDE_CODE_LOCAL_PERMISSION_MODE: "bypassPermissions" },
      });
      const click = service._internals.buildSpawnCommand({ source: "click" });
      expect(click.argv).toContain("--dangerously-skip-permissions");
      expect(click.mode).toBe("bypassPermissions");
      for (const source of ["autostart", "incident:12"]) {
        const unattended = service._internals.buildSpawnCommand({ source });
        expect(unattended.mode).toBe("acceptEdits");
        expect(unattended.argv).not.toContain("--dangerously-skip-permissions");
        expect(unattended.argv).toContain("acceptEdits");
      }
    });

    it("adds -c only for autostart respawns", () => {
      const { service } = createService({});
      expect(
        service._internals.buildSpawnCommand({ source: "autostart", useContinue: true }).argv,
      ).toContain("-c");
      expect(
        service._internals.buildSpawnCommand({ source: "click" }).argv,
      ).not.toContain("-c");
    });
  });

  describe("state derivation", () => {
    it("reports probing before the first probe, then ready", async () => {
      const { service } = createService({});
      expect(service.getStatusSnapshot().state).toBe("probing");
      await service.refreshProbes({ force: true });
      expect(service.getStatusSnapshot().state).toBe("ready");
    });

    it("reports disabled / not_installed / needs_login from the guards", async () => {
      const disabled = createService({ env: { CLAUDE_CODE_LOCAL_ENABLED: "0" } });
      await disabled.service.refreshProbes({ force: true });
      expect(disabled.service.getStatusSnapshot().state).toBe("disabled");

      const missing = createService({ runStream: createFakeRunStream({ installed: false }) });
      await missing.service.refreshProbes({ force: true });
      expect(missing.service.getStatusSnapshot().state).toBe("not_installed");

      const loggedOut = createService({ runStream: createFakeRunStream({ loggedIn: false }) });
      await loggedOut.service.refreshProbes({ force: true });
      expect(loggedOut.service.getStatusSnapshot().state).toBe("needs_login");
    });

    it("warns on untested claude versions", async () => {
      const runStream = createFakeRunStream();
      runStream.runStreamed.mockImplementation(async ({ args }) =>
        args[0] === "--version"
          ? { ok: true, code: 0, tail: "9.9.9 (Claude Code)" }
          : { ok: true, code: 0, tail: JSON.stringify({ loggedIn: true }) },
      );
      const { service } = createService({ runStream });
      await service.refreshProbes({ force: true });
      expect(service.getStatusSnapshot().warnings.join(" ")).toContain("outside the tested range");
    });
  });

  describe("startSession (tmux hosting)", () => {
    it("refuses without consent, then spawns and extracts the URL", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      const refused = await service.startSession({ confirmed: false, source: "click" });
      expect(refused).toMatchObject({ ok: false, code: "confirm_required" });

      const started = await service.startSession({ confirmed: true, source: "click" });
      expect(started).toMatchObject({ ok: true, status: "starting" });
      expect(driver.newSession).toHaveBeenCalledTimes(1);
      driver.state.buffer = "ready!\nhttps://claude.ai/code/sess_abcdef123456?from=cli\n";
      await flush(60);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("running");
      expect(snapshot.sessionUrl).toBe("https://claude.ai/code/sess_abcdef123456");
      expect(snapshot.spawnedBy).toBe("click");
      expect(service.getNotificationLine()).toContain("https://claude.ai/code/sess_abcdef123456");
    });

    it("answers the trust prompt while waiting", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "Do you trust the files in this folder?\n> 1. Yes  2. No";
      await flush(30);
      expect(driver.sendKeys).toHaveBeenCalledWith(
        expect.objectContaining({ text: "1" }),
      );
    });

    it("pre-seeds workspace trust in the rescue .claude.json before spawning", async () => {
      const { service, fsModule } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      const config = JSON.parse(fsModule.files.get(`${kPaths.home}/.claude.json`));
      expect(config.projects[kPaths.workspace]).toMatchObject({
        hasTrustDialogAccepted: true,
      });
    });

    it("answers Enable Remote Control? (y/n) exactly once, then extracts the env URL", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "Enable Remote Control? (y/n)";
      await flush(30);
      const yCalls = () =>
        driver.sendKeys.mock.calls.filter(([args]) => args.text === "y").length;
      expect(yCalls()).toBe(1);
      await flush(30);
      expect(yCalls()).toBe(1); // prompt persists on screen; answered once
      driver.state.buffer +=
        "\n·✔︎· Connected · workspace · HEAD\nContinue coding in the Claude mobile app or https://claude.ai/code?environment=env_01TESTENV42\nspace to show QR code";
      await flush(60);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("running");
      expect(snapshot.sessionUrl).toBe(
        "https://claude.ai/code?environment=env_01TESTENV42",
      );
    });

    it("maps the workspace-not-trusted exit to an actionable error", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer =
        "Error: Workspace not trusted. Please run `claude` in /x first to review and accept the workspace trust dialog.";
      await flush(60);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("error");
      expect(snapshot.error.code).toBe("workspace_not_trusted");
      expect(driver.killSession).toHaveBeenCalled();
    });

    it("maps the auth-gate screen to an error, clears the session, and re-probes login", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer =
        "Error: You must be logged in to use Remote Control.\nRemote Control is only available with claude.ai subscriptions.";
      await flush(60);
      // The gate reset the probe memo, so the next snapshot re-derives from
      // guards (probing until refreshed).
      const snapshot = service.getStatusSnapshot();
      expect(["probing", "needs_login", "error"]).toContain(snapshot.state);
      expect(driver.killSession).toHaveBeenCalled();
    });

    it("times out into a kept-for-diagnosis error session", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "still booting…";
      await flush(400);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("error");
      expect(snapshot.error.code).toBe("url_extract_timeout");
      expect(snapshot.error.tailSanitized).toContain("still booting");
      // Retry kills the failed session FIRST, then spawns fresh.
      driver.killSession.mockClear();
      const retry = await service.startSession({ confirmed: true, source: "click" });
      expect(driver.killSession).toHaveBeenCalled();
      expect(retry).toMatchObject({ ok: true, status: "starting" });
    });

    it("returns busy while another lifecycle op holds the mutex", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      let release;
      driver.newSession.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => {
              driver.state.sessionAlive = true;
              resolve({ code: 0, stdout: "", stderr: "" });
            };
          }),
      );
      const first = service.startSession({ confirmed: true, source: "click" });
      await flush(10);
      const second = await service.startSession({ confirmed: true, source: "click" });
      expect(second).toMatchObject({ ok: false, code: "busy" });
      release();
      await first;
    });

    it("recovers a stale socket by unlinking and retrying once", async () => {
      const { service, driver, fsModule } = createService({});
      await service.refreshProbes({ force: true });
      driver.newSession
        .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "error connecting to /data/claude-code-local/tmux.sock (No such file or directory)" })
        .mockImplementationOnce(async () => {
          driver.state.sessionAlive = true;
          return { code: 0, stdout: "", stderr: "" };
        });
      const result = await service.startSession({ confirmed: true, source: "click" });
      expect(result).toMatchObject({ ok: true, status: "starting" });
      expect(fsModule.rmSync).toHaveBeenCalledWith(kPaths.socket, { force: true });
      expect(driver.newSession).toHaveBeenCalledTimes(2);
    });
  });

  describe("adoption", () => {
    it("trusts the persisted URL only on pane-identity match", async () => {
      const { driver, fsModule } = { ...createService({}) };
      const persisted = {
        sessionName: "alphaclaw-rescue",
        phase: "running",
        sessionId: "sess_persisted01",
        sessionUrl: "https://claude.ai/code/sess_persisted01",
        panePid: 4242,
        spawnedBy: "click",
        startedAt: 111,
        mode: "acceptEdits",
      };
      fsModule.files.set(kPaths.stateFile, JSON.stringify(persisted));
      driver.state.sessionAlive = true;
      driver.state.panePid = 4242;
      const { service } = createService({ driver, fsModule });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({ confirmed: true, source: "click" });
      expect(result).toMatchObject({
        ok: true,
        status: "running",
        sessionUrl: "https://claude.ai/code/sess_persisted01",
      });
      expect(driver.newSession).not.toHaveBeenCalled();
    });

    it("re-extracts from scrollback when the pane identity mismatches", async () => {
      const { driver, fsModule } = { ...createService({}) };
      fsModule.files.set(
        kPaths.stateFile,
        JSON.stringify({ panePid: 1111, sessionUrl: "https://claude.ai/code/sess_stale0000" }),
      );
      driver.state.sessionAlive = true;
      driver.state.panePid = 4242;
      driver.state.buffer = "https://claude.ai/code/sess_fresh0000?from=cli";
      const { service } = createService({ driver, fsModule });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({ confirmed: true, source: "click" });
      expect(result.sessionUrl).toBe("https://claude.ai/code/sess_fresh0000");
    });

    it("reaps a dead pane instead of adopting it", async () => {
      const { driver, fsModule } = { ...createService({}) };
      driver.state.sessionAlive = true;
      driver.state.paneDead = true;
      const { service } = createService({ driver, fsModule });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({ confirmed: true, source: "click" });
      // Dead pane reaped, then a fresh spawn proceeds.
      expect(driver.killSession).toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, status: "starting" });
    });
  });

  describe("process death while running", () => {
    it("returns to ready on the liveness poll and reaps the pane", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "https://claude.ai/code/sess_abcdef123456";
      await flush(60);
      expect(service.getStatusSnapshot().state).toBe("running");
      // kill -9 equivalent: session vanishes.
      driver.state.sessionAlive = false;
      await service.refreshProbes({ force: true });
      expect(service.getStatusSnapshot().state).toBe("ready");
    });
  });

  describe("kill switch with a live session", () => {
    it("shows disabled + a still-live warning and never auto-kills", async () => {
      const env = { CLAUDE_CODE_LOCAL_ENABLED: "" };
      const { service, driver } = createService({ env });
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "https://claude.ai/code/sess_abcdef123456";
      await flush(60);
      env.CLAUDE_CODE_LOCAL_ENABLED = "0"; // hot-reloaded .env edit
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("disabled");
      expect(snapshot.warnings.join(" ")).toContain("still live");
      expect(driver.killSession).not.toHaveBeenCalled();
      const stopped = await service.stopSession();
      expect(stopped.ok).toBe(true);
      expect(driver.killSession).toHaveBeenCalled();
    });
  });

  describe("memory floor (unattended only)", () => {
    const lowMemory = () => ({
      memory: { totalBytes: 1024 * 1024 * 1024, usedBytes: 900 * 1024 * 1024 },
    });

    it("skips incident spawns under the floor but allows clicks", async () => {
      const { service, driver } = createService({ getResources: lowMemory });
      await service.refreshProbes({ force: true });
      const unattended = await service.startSession({ source: "incident:7" });
      expect(unattended).toMatchObject({ ok: false, code: "memory_floor" });
      expect(driver.newSession).not.toHaveBeenCalled();
      const click = await service.startSession({ confirmed: true, source: "click" });
      expect(click).toMatchObject({ ok: true, status: "starting" });
    });
  });

  describe("ensureForIncident", () => {
    it("spawns once when logged in and idle, and never throws outward", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      service.ensureForIncident({ incidentId: 9 });
      await flush(40);
      expect(driver.newSession).toHaveBeenCalledTimes(1);
      const spawnArgs = driver.newSession.mock.calls[0][0];
      expect(spawnArgs.commandArgv).toContain("acceptEdits");
    });

    it("does nothing when logged out or disabled", async () => {
      const loggedOut = createService({ runStream: createFakeRunStream({ loggedIn: false }) });
      await loggedOut.service.refreshProbes({ force: true });
      loggedOut.service.ensureForIncident({ incidentId: 1 });
      await flush(30);
      expect(loggedOut.driver.newSession).not.toHaveBeenCalled();

      const disabled = createService({ env: { CLAUDE_CODE_LOCAL_SPAWN_ON_INCIDENT: "0" } });
      await disabled.service.refreshProbes({ force: true });
      disabled.service.ensureForIncident({ incidentId: 2 });
      await flush(30);
      expect(disabled.driver.newSession).not.toHaveBeenCalled();
    });
  });

  describe("login flow", () => {
    const startLoginWithChild = async (overrides = {}) => {
      const child = createFakeChild();
      const spawnImpl = vi.fn(() => child);
      const runStream = createFakeRunStream({ loggedIn: false });
      const built = createService({ spawnImpl, runStream, ...overrides });
      await built.service.refreshProbes({ force: true });
      const started = await built.service.startLogin();
      return { ...built, child, spawnImpl, runStream, started };
    };

    it("spawns claude auth login in a PTY and surfaces the OAuth URL", async () => {
      const { service, child, spawnImpl, started } = await startLoginWithChild();
      expect(started).toMatchObject({ ok: true, status: "starting" });
      // script(1) wrapper with the fixed argv (see pty-process.js).
      expect(spawnImpl).toHaveBeenCalledWith(
        "script",
        expect.arrayContaining(["-c", "claude auth login"]),
        expect.objectContaining({ cwd: kPaths.home }),
      );
      child.stdout.emit("data", kOauthFixtureLine);
      await flush(30);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("login_in_progress");
      expect(snapshot.login.phase).toBe("awaiting_code");
      expect(snapshot.login.oauthUrl).toContain("https://claude.com/cai/oauth/authorize");
    });

    it("verifies via auth status after the code is submitted, and redacts the code everywhere", async () => {
      const { service, child, runStream } = await startLoginWithChild();
      child.stdout.emit("data", kOauthFixtureLine);
      await flush(20);
      const code = "SECRET-LOGIN-CODE-123#abc";
      const submitted = await service.submitLoginCode({ code });
      expect(submitted).toMatchObject({ ok: true, status: "verifying" });
      expect(child.stdin.write).toHaveBeenCalledWith(`${code}\n`);
      runStream.loggedIn = true; // the CLI stored credentials
      await flush(60);
      expect(service.getStatusSnapshot().login).toMatchObject({ phase: "success" });
      // Poison-string assertion: the pasted code never leaves via the tail.
      child.stdout.emit("data", `echoed ${code} somewhere`);
      const tail = await service.getTail({ source: "login" });
      if (tail.ok) expect(tail.tail).not.toContain(code);
    });

    it("rejects garbage codes loudly", async () => {
      const { service } = await startLoginWithChild();
      expect(await service.submitLoginCode({ code: "" })).toMatchObject({ ok: false, code: "empty_code" });
      expect(await service.submitLoginCode({ code: "x".repeat(600) })).toMatchObject({ ok: false, code: "invalid_code" });
      expect(await service.submitLoginCode({ code: "badÿcode" })).toMatchObject({ ok: false, code: "invalid_code" });
    });

    it("fails closed when the child exits without credentials", async () => {
      const { service, child } = await startLoginWithChild();
      child.stdout.emit("data", "Opening browser to sign in…");
      child.emit("exit", 1);
      await flush(60);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.login).toMatchObject({ phase: "failed" });
      expect(snapshot.state).toBe("needs_login");
    });

    it("refuses to start twice and refuses when already logged in", async () => {
      const { service } = await startLoginWithChild();
      expect(await service.startLogin()).toMatchObject({ ok: false, code: "login_in_progress" });
      const loggedIn = createService({});
      await loggedIn.service.refreshProbes({ force: true });
      expect(await loggedIn.service.startLogin()).toMatchObject({ ok: false, code: "already_logged_in" });
    });
  });

  describe("logout", () => {
    it("refuses while a session is live, removes credentials when idle", async () => {
      const { service, driver, fsModule } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "https://claude.ai/code/sess_abcdef123456";
      await flush(60);
      expect(await service.logout()).toMatchObject({ ok: false, code: "session_running" });
      await service.stopSession();
      const result = await service.logout();
      expect(result.ok).toBe(true);
      expect(fsModule.rmSync).toHaveBeenCalledWith(
        `${kPaths.home}/.claude/.credentials.json`,
        { force: true },
      );
    });
  });

  describe("cross-process file lock", () => {
    it("refuses when a live foreign process holds the lock, steals a stale one", async () => {
      const { service, fsModule } = createService({});
      await service.refreshProbes({ force: true });
      // PID 1 is always alive on linux; a fresh timestamp = genuinely held.
      fsModule.files.set(kPaths.lockFile, JSON.stringify({ pid: 1, at: Date.now() }));
      const held = await service.startSession({ confirmed: true, source: "click" });
      expect(held).toMatchObject({ ok: false, code: "busy" });
      // A dead holder is stale regardless of timestamp.
      fsModule.files.set(kPaths.lockFile, JSON.stringify({ pid: 999999999, at: Date.now() }));
      const stolen = await service.startSession({ confirmed: true, source: "click" });
      expect(stolen).toMatchObject({ ok: true });
    });
  });

  describe("permission-mode config", () => {
    it("falls back to acceptEdits on invalid values and exposes live vs configured", async () => {
      const env = { CLAUDE_CODE_LOCAL_PERMISSION_MODE: "yolo" };
      const { service, driver } = createService({ env });
      await service.refreshProbes({ force: true });
      expect(service.getStatusSnapshot().permissionMode).toBe("acceptEdits");
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "https://claude.ai/code/sess_abcdef123456";
      await flush(60);
      env.CLAUDE_CODE_LOCAL_PERMISSION_MODE = "bypassPermissions";
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.permissionMode).toBe("bypassPermissions");
      expect(snapshot.livePermissionMode).toBe("acceptEdits");
    });
  });

  describe("directory hygiene", () => {
    it("creates the root/home/workspace dirs 0700 and pre-seeds .claude.json", async () => {
      const { service, fsModule } = createService({});
      await service.refreshProbes({ force: true });
      for (const dir of [kPaths.root, kPaths.home, kPaths.workspace]) {
        expect(fsModule.mkdirSync).toHaveBeenCalledWith(dir, {
          recursive: true,
          mode: 0o700,
        });
      }
      expect(fsModule.files.get(`${kPaths.home}/.claude.json`)).toContain(
        "hasCompletedOnboarding",
      );
    });
  });
});
