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

// Success-path tests get a generous URL deadline so an event-loop stall on a
// loaded CI worker can never trip it; the timeout test overrides its own.
const kFastTimers = {
  urlPollMs: 2,
  urlDeadlineMs: 2_000,
  trustWatchMs: 2,
  loginPollMs: 2,
  loginTtlMs: 500,
  probeMs: 60_000,
};

const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const createService = ({ env = {}, driver, fsModule, runStream, spawnImpl, getResources, timers, resolveExternalBaseUrl } = {}) => {
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
      resolveExternalBaseUrl,
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
      // The snapshot carries the revocable wrapper path — never the raw
      // claude.ai URL (boundary pin).
      expect(snapshot.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
      expect(snapshot.spawnedBy).toBe("click");
      const token = snapshot.sessionUrl.slice("/rescue/".length);
      expect(service.resolveRescueRedirect(token)).toBe(
        "https://claude.ai/code/sess_abcdef123456",
      );
      // No external base configured → raw-URL fallback with the config hint.
      const line = service.getNotificationLine();
      expect(line).toContain("https://claude.ai/code/sess_abcdef123456");
      expect(line).toContain("ALPHACLAW_SETUP_URL");
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
      expect(snapshot.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
      expect(
        service.resolveRescueRedirect(snapshot.sessionUrl.slice("/rescue/".length)),
      ).toBe("https://claude.ai/code?environment=env_01TESTENV42");
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
      const { service, driver } = createService({
        timers: { ...kFastTimers, urlDeadlineMs: 250 },
      });
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
      const kPersistedToken = "ab".repeat(32);
      const persisted = {
        sessionName: "alphaclaw-rescue",
        phase: "running",
        sessionId: "sess_persisted01",
        sessionUrl: "https://claude.ai/code/sess_persisted01",
        linkToken: kPersistedToken,
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
      // Identity match ⇒ the persisted link token is REUSED (link continuity
      // across AlphaClaw reboots of a still-live session).
      expect(result).toMatchObject({
        ok: true,
        status: "running",
        sessionUrl: `/rescue/${kPersistedToken}`,
      });
      expect(service.resolveRescueRedirect(kPersistedToken)).toBe(
        "https://claude.ai/code/sess_persisted01",
      );
      expect(driver.newSession).not.toHaveBeenCalled();
    });

    it("re-extracts from scrollback when the pane identity mismatches", async () => {
      const { driver, fsModule } = { ...createService({}) };
      const kStaleToken = "cd".repeat(32);
      fsModule.files.set(
        kPaths.stateFile,
        JSON.stringify({
          panePid: 1111,
          sessionUrl: "https://claude.ai/code/sess_stale0000",
          linkToken: kStaleToken,
        }),
      );
      driver.state.sessionAlive = true;
      driver.state.panePid = 4242;
      driver.state.buffer = "https://claude.ai/code/sess_fresh0000?from=cli";
      const { service } = createService({ driver, fsModule });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({ confirmed: true, source: "click" });
      // Identity mismatch ⇒ the link token ROTATES with the re-extracted URL:
      // a replaced session must not be reachable via the old capability.
      expect(result.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
      const freshToken = result.sessionUrl.slice("/rescue/".length);
      expect(freshToken).not.toBe(kStaleToken);
      expect(service.resolveRescueRedirect(kStaleToken)).toBeNull();
      expect(service.resolveRescueRedirect(freshToken)).toBe(
        "https://claude.ai/code/sess_fresh0000",
      );
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
      // The parent shell is a live same-uid process this runner can always
      // signal — a portable stand-in for a foreign live holder (PID 1 is
      // EPERM-guarded on unprivileged runners).
      fsModule.files.set(
        kPaths.lockFile,
        JSON.stringify({ pid: process.ppid, at: Date.now() }),
      );
      const held = await service.startSession({ confirmed: true, source: "click" });
      expect(held).toMatchObject({ ok: false, code: "busy" });
      // A dead holder is stale regardless of timestamp.
      fsModule.files.set(kPaths.lockFile, JSON.stringify({ pid: 999999999, at: Date.now() }));
      const stolen = await service.startSession({ confirmed: true, source: "click" });
      expect(stolen).toMatchObject({ ok: true });
    });

    it("treats an EPERM holder as alive (another uid's process exists)", async () => {
      const { driver, fsModule } = createService({});
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error("EPERM");
        err.code = "EPERM";
        throw err;
      });
      try {
        const { service } = createService({ driver, fsModule });
        await service.refreshProbes({ force: true });
        fsModule.files.set(
          kPaths.lockFile,
          JSON.stringify({ pid: 4242424, at: Date.now() }),
        );
        const held = await service.startSession({ confirmed: true, source: "click" });
        expect(held).toMatchObject({ ok: false, code: "busy" });
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  describe("consent-mode TOCTOU guard", () => {
    it("refuses a click whose consented mode mismatches the live config", async () => {
      const env = { CLAUDE_CODE_LOCAL_PERMISSION_MODE: "acceptEdits" };
      const { service, driver } = createService({ env });
      await service.refreshProbes({ force: true });
      env.CLAUDE_CODE_LOCAL_PERMISSION_MODE = "bypassPermissions"; // hot-reload race
      const result = await service.startSession({
        confirmed: true,
        consentedMode: "acceptEdits",
        source: "click",
      });
      expect(result).toMatchObject({ ok: false, code: "confirm_required" });
      // The refusal carries server-truth mode+cwd so the modal renders it.
      expect(result.permissionMode).toBe("bypassPermissions");
      expect(result.cwd).toBe(kPaths.workspace);
      expect(driver.newSession).not.toHaveBeenCalled();
      const matched = await service.startSession({
        confirmed: true,
        consentedMode: "bypassPermissions",
        source: "click",
      });
      expect(matched).toMatchObject({ ok: true, status: "starting" });
    });

    it("never grants bypassPermissions on a null (unnamed) consent", async () => {
      const env = { CLAUDE_CODE_LOCAL_PERMISSION_MODE: "bypassPermissions" };
      const { service, driver } = createService({ env });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({
        confirmed: true,
        consentedMode: null,
        source: "click",
      });
      expect(result).toMatchObject({ ok: false, code: "confirm_required" });
      expect(result.permissionMode).toBe("bypassPermissions");
      expect(driver.newSession).not.toHaveBeenCalled();
    });

    it("captures the mode once and ignores a hot-reload after validation", async () => {
      const env = { CLAUDE_CODE_LOCAL_PERMISSION_MODE: "acceptEdits" };
      const { service, driver } = createService({ env });
      await service.refreshProbes({ force: true });
      // Flip the env mid-spawn (after newSession resolves) — the spawned
      // session must carry the mode validated at the top, not the new one.
      driver.newSession.mockImplementation(async () => {
        env.CLAUDE_CODE_LOCAL_PERMISSION_MODE = "bypassPermissions";
        driver.state.sessionAlive = true;
        return { code: 0, stdout: "", stderr: "" };
      });
      await service.startSession({
        confirmed: true,
        consentedMode: "acceptEdits",
        source: "click",
      });
      const argv = driver.newSession.mock.calls[0][0].commandArgv;
      expect(argv).toContain("acceptEdits");
      expect(argv).not.toContain("--dangerously-skip-permissions");
    });
  });

  describe("double-start does not orphan the URL watcher", () => {
    it("keeps the first watcher alive through a second start on a starting session", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      // Second click (another tab) while starting — early-returns "starting"
      // but must NOT kill the in-flight URL watcher.
      const second = await service.startSession({ confirmed: true, source: "click" });
      expect(second).toMatchObject({ ok: true, status: "starting" });
      driver.state.buffer = "https://claude.ai/code/sess_watcher12345";
      await flush(60);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("running");
      expect(snapshot.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
      expect(
        service.resolveRescueRedirect(snapshot.sessionUrl.slice("/rescue/".length)),
      ).toBe("https://claude.ai/code/sess_watcher12345");
    });
  });

  describe("stop failure surfaces", () => {
    it("reports stop_failed and keeps the session when kill-session fails", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "https://claude.ai/code/sess_running123456";
      await flush(60);
      driver.killSession.mockResolvedValueOnce({ ok: false, result: { stderr: "server busy" } });
      const preStopToken = service
        .getStatusSnapshot()
        .sessionUrl.slice("/rescue/".length);
      const stopped = await service.stopSession();
      expect(stopped).toMatchObject({ ok: false, code: "stop_failed" });
      // The session is NOT cleared — a live remote shell must stay tracked
      // (state stays "running": the shell really is still up), and the
      // capability link stays LIVE with it.
      expect(service.getStatusSnapshot().state).toBe("running");
      expect(service.resolveRescueRedirect(preStopToken)).toBe(
        "https://claude.ai/code/sess_running123456",
      );
    });
  });

  describe("logout hardening", () => {
    it("refuses while a login is in progress and verifies credential removal", async () => {
      const child = createFakeChild();
      const { service } = createService({
        spawnImpl: vi.fn(() => child),
        runStream: createFakeRunStream({ loggedIn: false }),
      });
      await service.refreshProbes({ force: true });
      await service.startLogin();
      expect(await service.logout()).toMatchObject({ ok: false, code: "login_in_progress" });
    });

    it("reports logout_failed when the credential file cannot be removed", async () => {
      const { service, fsModule } = createService({});
      await service.refreshProbes({ force: true });
      const credPath = `${kPaths.home}/.claude/.credentials.json`;
      fsModule.files.set(credPath, "creds");
      fsModule.rmSync = vi.fn(); // swallow the delete (EACCES-style no-op)
      const result = await service.logout();
      expect(result).toMatchObject({ ok: false, code: "logout_failed" });
    });
  });

  describe("generation staleness", () => {
    it("ignores a late URL after the session was stopped mid-watch", async () => {
      const { service, driver, fsModule } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      // The token is minted (and persisted) at spawn, before the URL exists.
      const preStopToken = JSON.parse(fsModule.files.get(kPaths.stateFile)).linkToken;
      expect(preStopToken).toMatch(/^[0-9a-f]{64}$/);
      await service.stopSession();
      driver.state.sessionAlive = true; // simulate stale capture still flowing
      driver.state.buffer = "https://claude.ai/code/sess_late00000000";
      await flush(60);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("ready");
      expect(snapshot.sessionUrl).toBeNull();
      // Revocation survives the stale watcher: the pre-stop capability is dead.
      expect(service.resolveRescueRedirect(preStopToken)).toBeNull();
    });

    it("errors with spawn_failed when the pane dies before the URL appears", async () => {
      const { service, driver } = createService({});
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = "booting…";
      driver.state.sessionAlive = false; // process died mid-starting
      await flush(80);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("error");
      expect(snapshot.error.code).toBe("spawn_failed");
    });
  });

  describe("script(1) hosting fallback", () => {
    const createScriptService = ({ env = {} } = {}) => {
      const driver = createFakeDriver();
      driver.state.tmuxOk = false;
      const child = createFakeChild();
      const spawnImpl = vi.fn(() => child);
      const built = createService({
        env,
        driver,
        spawnImpl,
      });
      // hasScriptCommandImpl is a factory option; rebuild with it set.
      const service = createClaudeCodeLocalService({
        env,
        fsModule: built.fsModule,
        tmux: driver,
        runStream: createFakeRunStream(),
        spawnImpl,
        hasScriptCommandImpl: () => true,
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        paths: kPaths,
        timers: kFastTimers,
      });
      return { service, driver, child, spawnImpl, fsModule: built.fsModule };
    };

    it("spawns via script(1), warns about restart survival, and extracts the URL from the buffer", async () => {
      const { service, child } = createScriptService();
      await service.refreshProbes({ force: true });
      const started = await service.startSession({ confirmed: true, source: "click" });
      expect(started).toMatchObject({ ok: true, status: "starting" });
      child.stdout.emit(
        "data",
        "Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_01SCRIPTHOST\n",
      );
      await flush(60);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("running");
      expect(snapshot.hosting).toBe("script");
      expect(snapshot.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
      expect(
        service.resolveRescueRedirect(snapshot.sessionUrl.slice("/rescue/".length)),
      ).toBe("https://claude.ai/code?environment=env_01SCRIPTHOST");
      expect(snapshot.warnings.join(" ")).toContain("does not survive AlphaClaw restarts");
    });

    it("answers the trust prompt and the RC confirm exactly once each on stdin", async () => {
      const { service, child } = createScriptService();
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      child.stdout.emit("data", "Do you trust the files in this folder?\n");
      await flush(40);
      child.stdout.emit("data", "Enable Remote Control? (y/n)\n");
      await flush(40);
      const writes = child.stdin.write.mock.calls.map(([arg]) => arg);
      expect(writes.filter((w) => w === "1\n").length).toBe(1);
      expect(writes.filter((w) => w === "y\n").length).toBe(1);
    });

    it("kills the child and clears the session on an auth-gate screen", async () => {
      const { service, child } = createScriptService();
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      child.stdout.emit(
        "data",
        "Error: You must be logged in to use Remote Control.\n",
      );
      await flush(60);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(["probing", "needs_login", "error"]).toContain(
        service.getStatusSnapshot().state,
      );
    });

    it("maps a child exit before the URL to spawn_failed", async () => {
      const { service, child } = createScriptService();
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      child.stdout.emit("data", "booting…");
      child.emit("exit", 1);
      await flush(40);
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("error");
      expect(snapshot.error.code).toBe("spawn_failed");
    });
  });

  describe("tail redaction (session source)", () => {
    it("scrubs .env secrets out of the tmux session tail", async () => {
      const env = { SETUP_PASSWORD: "hunter2-super-secret" };
      const { service, driver } = createService({ env });
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer =
        "https://claude.ai/code/sess_abcdef123456\n$ cat .env\nSETUP_PASSWORD=hunter2-super-secret\n";
      await flush(60);
      const tail = await service.getTail({ source: "session" });
      expect(tail.ok).toBe(true);
      expect(tail.tail).not.toContain("hunter2-super-secret");
    });
  });

  describe("adoption hardening", () => {
    it("refuses adopted_without_url when a live foreign pane has no banner", async () => {
      const { driver, fsModule } = createService({});
      driver.state.sessionAlive = true;
      driver.state.panePid = 4242;
      driver.state.buffer = "just some scrollback, no urls";
      const { service } = createService({ driver, fsModule });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({ confirmed: true, source: "click" });
      expect(result).toMatchObject({ ok: false, code: "adopted_without_url" });
    });

    it("prefers the banner URL over an echoed decoy during re-extraction", async () => {
      const { driver, fsModule } = createService({});
      fsModule.files.set(
        kPaths.stateFile,
        JSON.stringify({ panePid: 1111, sessionUrl: "https://claude.ai/code/sess_stale0000" }),
      );
      driver.state.sessionAlive = true;
      driver.state.panePid = 4242; // identity mismatch → re-extract
      driver.state.buffer = [
        "$ cat attacker.log",
        "visit my totally real session https://claude.ai/code/sess_evil0000000",
        "Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_01REALBANNER",
      ].join("\n");
      const { service } = createService({ driver, fsModule });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({ confirmed: true, source: "click" });
      expect(result.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
      expect(
        service.resolveRescueRedirect(result.sessionUrl.slice("/rescue/".length)),
      ).toBe("https://claude.ai/code?environment=env_01REALBANNER");
    });
  });

  describe("login lifecycle edges", () => {
    it("fails the login at TTL and cancelLogin clears it", async () => {
      const child = createFakeChild();
      const spawnImpl = vi.fn(() => child);
      const runStream = createFakeRunStream({ loggedIn: false });
      const { service } = createService({
        spawnImpl,
        runStream,
        timers: { ...kFastTimers, loginTtlMs: 60 },
      });
      await service.refreshProbes({ force: true });
      await service.startLogin();
      await flush(150);
      expect(service.getStatusSnapshot().login).toMatchObject({ phase: "failed" });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      const second = createFakeChild();
      const { service: cancellable } = createService({
        spawnImpl: vi.fn(() => second),
        runStream: createFakeRunStream({ loggedIn: false }),
      });
      await cancellable.refreshProbes({ force: true });
      await cancellable.startLogin();
      await cancellable.cancelLogin();
      expect(second.kill).toHaveBeenCalledWith("SIGTERM");
      expect(cancellable.getStatusSnapshot().state).toBe("needs_login");
    });
  });

  describe("probe economy", () => {
    it("skips the PERIODIC probe under the floor but a FORCED probe still runs", async () => {
      const resources = { low: false };
      const runStream = createFakeRunStream();
      const { service } = createService({
        runStream,
        timers: { ...kFastTimers, probeMs: 0 }, // every non-forced call re-probes
        getResources: () =>
          resources.low
            ? { memory: { totalBytes: 1024 ** 3, usedBytes: 900 * 1024 * 1024 } }
            : { memory: { totalBytes: 4 * 1024 ** 3, usedBytes: 1024 ** 3 } },
      });
      await service.refreshProbes({ force: true });
      const afterFirst = runStream.runStreamed.mock.calls.length;
      resources.low = true;
      // Periodic (non-forced) probe is throttled by the floor → no new calls.
      await service.refreshProbes();
      expect(runStream.runStreamed.mock.calls.length).toBe(afterFirst);
      // A forced probe (login verification) must run even under the floor.
      await service.refreshProbes({ force: true });
      expect(runStream.runStreamed.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it("falls back to the managed workspace when CWD is not absolute", async () => {
      const { service, driver } = createService({
        env: { CLAUDE_CODE_LOCAL_CWD: "relative/dir" },
      });
      await service.refreshProbes({ force: true });
      await service.startSession({ confirmed: true, source: "click" });
      expect(driver.newSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: kPaths.workspace }),
      );
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

  describe("rescue link capability", () => {
    const kRescueUrl = "https://claude.ai/code/sess_rescuecap01";
    const startRunning = async (opts = {}) => {
      const built = createService(opts);
      await built.service.refreshProbes({ force: true });
      await built.service.startSession({ confirmed: true, source: "click" });
      built.driver.state.buffer = kRescueUrl;
      await flush(60);
      const snapshot = built.service.getStatusSnapshot();
      expect(snapshot.state).toBe("running");
      return { ...built, token: snapshot.sessionUrl.slice("/rescue/".length) };
    };

    it("rotates the token across start → stop → start (old link dies)", async () => {
      const { service, driver, token: tokenA } = await startRunning();
      expect(service.resolveRescueRedirect(tokenA)).toBe(kRescueUrl);
      await service.stopSession();
      expect(service.resolveRescueRedirect(tokenA)).toBeNull();
      await service.startSession({ confirmed: true, source: "click" });
      driver.state.buffer = kRescueUrl;
      await flush(60);
      const tokenB = service.getStatusSnapshot().sessionUrl.slice("/rescue/".length);
      expect(tokenB).not.toBe(tokenA);
      expect(service.resolveRescueRedirect(tokenB)).toBe(kRescueUrl);
      expect(service.resolveRescueRedirect(tokenA)).toBeNull();
    });

    it("idempotent start while running returns the SAME wrapper link — no rotation, never the raw URL", async () => {
      const { service, token } = await startRunning();
      const again = await service.startSession({ confirmed: true, source: "click" });
      expect(again).toMatchObject({ ok: true, status: "running" });
      expect(again.sessionUrl).toBe(`/rescue/${token}`);
      expect(again.sessionUrl).not.toContain("claude.ai");
      expect(service.resolveRescueRedirect(token)).toBe(kRescueUrl);
    });

    it("does not resolve while starting — but the token is already persisted at spawn", async () => {
      const { service, driver, fsModule } = createService({});
      await service.refreshProbes({ force: true });
      const started = await service.startSession({ confirmed: true, source: "click" });
      expect(started).toMatchObject({ ok: true, status: "starting" });
      const token = JSON.parse(fsModule.files.get(kPaths.stateFile)).linkToken;
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(service.resolveRescueRedirect(token)).toBeNull();
      driver.state.buffer = kRescueUrl;
      await flush(60);
      expect(service.resolveRescueRedirect(token)).toBe(kRescueUrl);
    });

    it("refuses empty, wrong-same-length, and wrong-different-length tokens without throwing", async () => {
      const { service, token } = await startRunning();
      const crypto = require("crypto");
      const spy = vi.spyOn(crypto, "timingSafeEqual");
      expect(service.resolveRescueRedirect("")).toBeNull();
      expect(service.resolveRescueRedirect("ff".repeat(32))).toBeNull();
      expect(service.resolveRescueRedirect("short")).toBeNull();
      expect(service.resolveRescueRedirect(null)).toBeNull();
      // Hash-both-sides semantic: the different-length candidate still went
      // through timingSafeEqual (digests are fixed-length — no throw, no
      // length oracle).
      expect(spy).toHaveBeenCalled();
      expect(service._internals.timingSafeTokenEqual("short", token)).toBe(false);
      expect(service._internals.timingSafeTokenEqual(token, token)).toBe(true);
      spy.mockRestore();
    });

    it("mints a fresh token when adopting pre-feature state (no linkToken persisted)", async () => {
      const { driver, fsModule } = createService({});
      fsModule.files.set(
        kPaths.stateFile,
        JSON.stringify({
          panePid: 4242,
          sessionId: "sess_upgrade001",
          sessionUrl: "https://claude.ai/code/sess_upgrade001",
        }),
      );
      driver.state.sessionAlive = true;
      driver.state.panePid = 4242;
      const { service } = createService({ driver, fsModule });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({ confirmed: true, source: "click" });
      expect(result.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
      const persisted = JSON.parse(fsModule.files.get(kPaths.stateFile));
      expect(persisted.linkToken).toBe(result.sessionUrl.slice("/rescue/".length));
    });

    it("never reuses a malformed persisted linkToken even on identity match", async () => {
      const { driver, fsModule } = createService({});
      const kBadToken = "NOT-64-HEX";
      fsModule.files.set(
        kPaths.stateFile,
        JSON.stringify({
          panePid: 4242,
          sessionUrl: "https://claude.ai/code/sess_tampered01",
          linkToken: kBadToken,
        }),
      );
      driver.state.sessionAlive = true;
      driver.state.panePid = 4242;
      const { service } = createService({ driver, fsModule });
      await service.refreshProbes({ force: true });
      const result = await service.startSession({ confirmed: true, source: "click" });
      expect(result.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
      expect(result.sessionUrl).not.toContain(kBadToken);
      expect(service.resolveRescueRedirect(kBadToken)).toBeNull();
    });

    it("notification line carries the absolute wrapper link when a base URL resolves", async () => {
      const { service, token } = await startRunning({
        resolveExternalBaseUrl: () => "https://box.example/",
      });
      expect(service.getNotificationLine()).toBe(
        `🛟 Rescue session: https://box.example/rescue/${token}`,
      );
    });

    it("origin-normalizes a base URL that carries a path", async () => {
      const { service, token } = await startRunning({
        resolveExternalBaseUrl: () => "https://box.example/setup",
      });
      expect(service.getNotificationLine()).toBe(
        `🛟 Rescue session: https://box.example/rescue/${token}`,
      );
    });

    it("falls back to the raw URL + config hint when no base resolves (never a localhost wrapper)", async () => {
      for (const resolveExternalBaseUrl of [
        undefined,
        () => "",
        () => "file:///etc",
        () => "not a url",
        // The REAL resolveSetupUrl never returns empty — its zero-config
        // default is http://localhost:3000 (onboarding/workspace.js). These
        // two pin the loopback filter that keeps that default from shipping
        // dead wrapper links in notifications and QR codes.
        () => "http://localhost:3000",
        () => "http://127.0.0.1:8080",
        () => {
          throw new Error("boom");
        },
      ]) {
        const { service } = await startRunning({ resolveExternalBaseUrl });
        const line = service.getNotificationLine();
        expect(line).toContain(kRescueUrl);
        expect(line).toContain("ALPHACLAW_SETUP_URL");
        expect(line).not.toContain("/rescue/");
        expect(line).not.toContain("localhost");
      }
    });

    it("kill switch keeps the live link resolving while the snapshot hides it", async () => {
      const env = { CLAUDE_CODE_LOCAL_ENABLED: "" };
      const { service, token } = await startRunning({ env });
      env.CLAUDE_CODE_LOCAL_ENABLED = "0";
      const snapshot = service.getStatusSnapshot();
      expect(snapshot.state).toBe("disabled");
      expect(snapshot.sessionUrl).toBeNull();
      // Disabling never cuts off a live rescue: the capability stays valid
      // until the session is actually stopped.
      expect(service.resolveRescueRedirect(token)).toBe(kRescueUrl);
    });

    it("pane death revokes the link on the liveness check", async () => {
      const { service, driver, token } = await startRunning();
      expect(service.resolveRescueRedirect(token)).toBe(kRescueUrl);
      driver.state.sessionAlive = false;
      await service.checkSessionLiveness();
      expect(service.resolveRescueRedirect(token)).toBeNull();
    });
  });
});


describe("claude-code-local service — fix wave PR 10 (F131, F133, F134, F135)", () => {
  const kBanner =
    "Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_01REALBANNER";

  const buildService = ({ env = {}, driver, fsModule, timers } = {}) => {
    const fakeDriver = driver || createFakeDriver();
    const fakeFs = fsModule || createFakeFs();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = createClaudeCodeLocalService({
      env,
      fsModule: fakeFs,
      tmux: fakeDriver,
      runStream: createFakeRunStream(),
      logger,
      paths: kPaths,
      timers: timers || kFastTimers,
    });
    return { service, driver: fakeDriver, fsModule: fakeFs, logger };
  };

  it("the auth gate reports needs_login IMMEDIATELY instead of collapsing to probing (F131)", async () => {
    const { service, driver } = buildService({});
    await service.refreshProbes({ force: true });
    await service.startSession({ confirmed: true, source: "click" });
    driver.state.buffer =
      "Error: You must be logged in to use Remote Control.\nRemote Control is only available with claude.ai subscriptions.";
    await flush(60);
    const snapshot = service.getStatusSnapshot();
    expect(snapshot.state).toBe("needs_login");
    expect(snapshot.state).not.toBe("probing");
    expect(driver.killSession).toHaveBeenCalled();
  });

  it("never writes the full Remote Control sessionId to the process log (F133)", async () => {
    const { service, driver, logger } = buildService({});
    await service.refreshProbes({ force: true });
    await service.startSession({ confirmed: true, source: "click" });
    driver.state.buffer = "https://claude.ai/code/sess_abcdef123456SECRETTAIL";
    await flush(60);
    expect(service.getStatusSnapshot().state).toBe("running");
    const logged = logger.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toMatch(/running — session sess_abc…/);
    expect(logged).not.toContain("sess_abcdef123456SECRETTAIL");
  });

  it("boot adoption RESUMES the URL wait for a pane persisted as `starting` (F134)", async () => {
    const { driver, fsModule } = buildService({});
    driver.state.sessionAlive = true;
    driver.state.panePid = 4242;
    driver.state.buffer = "claude is starting up…"; // no URL yet
    fsModule.files.set(
      kPaths.stateFile,
      JSON.stringify({
        sessionName: "alphaclaw-rescue",
        phase: "starting",
        hosting: "tmux",
        panePid: 4242,
        startedAt: Date.now() - 1_000,
        spawnedBy: "click",
        mode: "acceptEdits",
      }),
    );
    const { service } = buildService({ driver, fsModule, timers: { ...kFastTimers, urlDeadlineMs: 5_000 } });
    service.reconcileOnBoot();
    await flush(60);
    // Healthy pane inside its URL budget: still starting, NOT adopted_without_url.
    let snapshot = service.getStatusSnapshot();
    expect(snapshot.state).toBe("starting");
    expect(snapshot.error).toBeFalsy();
    // The URL appears: the resumed watcher promotes the session to running.
    driver.state.buffer = kBanner;
    await flush(80);
    snapshot = service.getStatusSnapshot();
    expect(snapshot.state).toBe("running");
    expect(snapshot.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
  });

  it("boot adoption still marks a pane adopted_without_url when its URL budget has elapsed (F134 bound)", async () => {
    const { driver, fsModule } = buildService({});
    driver.state.sessionAlive = true;
    driver.state.panePid = 4242;
    driver.state.buffer = "no url here";
    fsModule.files.set(
      kPaths.stateFile,
      JSON.stringify({
        sessionName: "alphaclaw-rescue",
        phase: "starting",
        hosting: "tmux",
        panePid: 4242,
        startedAt: Date.now() - 10 * 60_000,
      }),
    );
    const { service } = buildService({ driver, fsModule, timers: { ...kFastTimers, urlDeadlineMs: 5_000 } });
    service.reconcileOnBoot();
    await flush(60);
    const snapshot = service.getStatusSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.error.code).toBe("adopted_without_url");
  });

  it("boot adoption runs while the feature is DISABLED so a live session stays visible and stoppable (F135)", async () => {
    const { driver, fsModule } = buildService({});
    driver.state.sessionAlive = true;
    driver.state.panePid = 4242;
    driver.state.buffer = kBanner;
    fsModule.files.set(
      kPaths.stateFile,
      JSON.stringify({
        sessionName: "alphaclaw-rescue",
        phase: "running",
        hosting: "tmux",
        panePid: 4242,
        startedAt: Date.now() - 60_000,
        sessionUrl: "https://claude.ai/code?environment=env_01REALBANNER",
      }),
    );
    const env = { CLAUDE_CODE_LOCAL_ENABLED: "0" };
    const { service } = buildService({ env, driver, fsModule });
    service.reconcileOnBoot();
    await flush(60);
    const snapshot = service.getStatusSnapshot();
    expect(snapshot.state).toBe("disabled");
    expect(snapshot.startedAt).toBeTruthy();
    expect(snapshot.warnings.join(" ")).toContain("still live");
    // Disabled still means "no new spawns": autostart did not fire, nothing was killed.
    expect(driver.newSession).not.toHaveBeenCalled();
    expect(driver.killSession).not.toHaveBeenCalled();
    // Re-enabling (hot-reloaded .env) reveals the adopted session with a
    // working revocable link — proof the adoption really happened.
    env.CLAUDE_CODE_LOCAL_ENABLED = "";
    const live = service.getStatusSnapshot();
    expect(live.state).toBe("running");
    expect(live.sessionUrl).toMatch(/^\/rescue\/[0-9a-f]{64}$/);
    expect(
      service.resolveRescueRedirect(live.sessionUrl.slice("/rescue/".length)),
    ).toBe("https://claude.ai/code?environment=env_01REALBANNER");
    env.CLAUDE_CODE_LOCAL_ENABLED = "0";
    const stopped = await service.stopSession();
    expect(stopped.ok).toBe(true);
    expect(driver.killSession).toHaveBeenCalled();
  });
});
