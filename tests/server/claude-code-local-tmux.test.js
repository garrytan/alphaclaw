const { createTmuxDriver } = require("../../lib/server/claude-code-local/tmux");

// Cycle-3 adversarial-review fixes: history-limit before new-session, -s
// all-window pane matching, bounded full-history capture.
describe("tmux driver — adversarial-review hardening", () => {
  const kSock = "/data/claude-code-local/tmux.sock";
  const mkExec = (impl) =>
    vi.fn((cmd, args, opts, cb) => {
      const { code = 0, stdout = "", stderr = "" } = impl(args) || {};
      const err = code === 0 ? null : Object.assign(new Error("x"), { code });
      cb(err, stdout, stderr);
    });

  it("raises the GLOBAL history-limit BEFORE new-session (so the pane inherits it)", async () => {
    const calls = [];
    const execFileImpl = mkExec((args) => {
      calls.push(args.slice(2)); // drop -S <sock>
      return { code: 0 };
    });
    const driver = createTmuxDriver({ socketPath: kSock, execFileImpl });
    await driver.newSession({ sessionName: "s", cwd: "/w", commandArgv: ["claude"], env: {} });
    const historyIdx = calls.findIndex(
      (a) => a.includes("set-option") && a.includes("-g") && a.includes("history-limit"),
    );
    const newSessionIdx = calls.findIndex((a) => a.includes("new-session"));
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeLessThan(newSessionIdx); // set BEFORE the pane exists
  });

  it("lists panes across ALL windows (-s) and matches the recorded pane PID", async () => {
    const execFileImpl = mkExec((args) => {
      if (args.includes("list-panes")) {
        expect(args).toContain("-s"); // all windows, not just current
        return { code: 0, stdout: "9999 0\n4242 0\n" }; // human shell, then rescue pane
      }
      return { code: 0 };
    });
    const driver = createTmuxDriver({ socketPath: kSock, execFileImpl });
    const matched = await driver.listPaneInfo({ sessionName: "s", env: {}, panePid: 4242 });
    expect(matched).toEqual({ panePid: 4242, paneDead: false });
    // Unknown PID → first row.
    const first = await driver.listPaneInfo({ sessionName: "s", env: {}, panePid: 111 });
    expect(first).toEqual({ panePid: 9999, paneDead: false });
  });

  it("bounds a full-history capture (lines=null) instead of an unbounded -S -", async () => {
    let captured = null;
    const execFileImpl = mkExec((args) => {
      if (args.includes("capture-pane")) captured = args;
      return { code: 0, stdout: "out" };
    });
    const driver = createTmuxDriver({ socketPath: kSock, execFileImpl });
    await driver.capturePane({ sessionName: "s", lines: null, env: {} });
    const sIdx = captured.lastIndexOf("-S");
    expect(captured[sIdx + 1]).toBe("-50000"); // capped, never bare "-"
  });
});

const kSocketPath = "/data/claude-code-local/tmux.sock";
const kSessionName = "alphaclaw-rescue";
const kWorkspace = "/data/claude-code-local/workspace";
// Every run() call rides its own socket + no-config prefix so the operator's
// ~/.tmux.conf never reaches the rescue server.
const kSocketPrefix = ["-S", kSocketPath, "-f", "/dev/null"];
const kCommandArgv = ["env", "-i", "HOME=/data/home", "claude", "remote-control"];
const kEnv = { PATH: "/usr/bin" };

// respond(args) -> { error, stdout, stderr } lets a test script per-call
// results; the callback fires synchronously, which run() tolerates.
const createExecFileSpy = (respond) =>
  vi.fn((cmd, args, opts, callback) => {
    const result = respond?.(args) || {};
    callback(result.error || null, result.stdout || "", result.stderr || "");
    return {};
  });

const createDriver = (respond) => {
  const execFileImpl = createExecFileSpy(respond);
  const driver = createTmuxDriver({ socketPath: kSocketPath, execFileImpl });
  return { driver, execFileImpl };
};

const kExitOneError = (stderr = "") =>
  Object.assign(new Error(`tmux exited 1: ${stderr}`), { code: 1 });

describe("claude-code-local tmux driver", () => {
  describe("newSession", () => {
    it("passes the pane command as argv after -- and applies the follow-up options", async () => {
      const { driver, execFileImpl } = createDriver();
      const result = await driver.newSession({
        sessionName: kSessionName,
        cwd: kWorkspace,
        commandArgv: kCommandArgv,
        env: kEnv,
      });
      expect(result.code).toBe(0);
      expect(result.warning).toBeUndefined();
      expect(execFileImpl).toHaveBeenCalledTimes(4);
      expect(execFileImpl.mock.calls[0][0]).toBe("tmux");
      // The server must exist before set-option can land (fix wave F132):
      // set-option is not a server-starting command and failed silently,
      // leaving the pane at tmux's 2000-line default.
      expect(execFileImpl.mock.calls[0][1]).toEqual([...kSocketPrefix, "start-server"]);
      // The scrubbed env must reach the server-starting call too.
      expect(execFileImpl.mock.calls[0][2].env).toBe(kEnv);
      // history-limit is raised GLOBALLY next (before the pane exists) so the
      // rescue pane inherits it — a -t session set afterward would not apply.
      expect(execFileImpl.mock.calls[1][1]).toEqual([
        ...kSocketPrefix,
        "set-option",
        "-g",
        "history-limit",
        "50000",
      ]);
      expect(execFileImpl.mock.calls[2][1]).toEqual([
        ...kSocketPrefix,
        "new-session",
        "-d",
        "-s",
        kSessionName,
        "-x",
        "220",
        "-y",
        "50",
        "-c",
        kWorkspace,
        "--",
        ...kCommandArgv,
      ]);
      expect(execFileImpl.mock.calls[3][1]).toEqual([
        ...kSocketPrefix,
        "set-option",
        "-t",
        kSessionName,
        "remain-on-exit",
        "on",
      ]);
    });

    it("surfaces a failed history-limit as a warning and stops early when the server cannot start (F132)", async () => {
      const limitFails = createDriver((args) =>
        args.includes("history-limit")
          ? { error: kExitOneError("bad option"), stderr: "unknown option: history-limit" }
          : { code: 0 },
      );
      const limited = await limitFails.driver.newSession({
        sessionName: kSessionName,
        cwd: kWorkspace,
        commandArgv: kCommandArgv,
        env: kEnv,
      });
      expect(limited.code).toBe(0);
      expect(limited.warning).toMatch(/history-limit not applied/);
      // start-server, set-option, new-session, remain-on-exit still ran.
      expect(limitFails.execFileImpl).toHaveBeenCalledTimes(4);

      const serverFails = createDriver((args) =>
        args.includes("start-server")
          ? { error: kExitOneError("no socket"), stderr: "error connecting" }
          : { code: 0 },
      );
      const failed = await serverFails.driver.newSession({
        sessionName: kSessionName,
        cwd: kWorkspace,
        commandArgv: kCommandArgv,
        env: kEnv,
      });
      expect(failed.code).toBe(1);
      expect(serverFails.execFileImpl).toHaveBeenCalledTimes(1);
    });

    it("skips remain-on-exit when creation fails", async () => {
      const { driver, execFileImpl } = createDriver((args) =>
        args.includes("new-session")
          ? { error: kExitOneError("duplicate session"), stderr: "duplicate session: alphaclaw-rescue" }
          : { code: 0 },
      );
      const result = await driver.newSession({
        sessionName: kSessionName,
        cwd: kWorkspace,
        commandArgv: kCommandArgv,
        env: kEnv,
      });
      expect(result.code).toBe(1);
      // start-server + global set-option + failed new-session, but NO
      // remain-on-exit follow-up.
      expect(execFileImpl).toHaveBeenCalledTimes(3);
    });
  });

  describe("capturePane", () => {
    it("captures the last N lines with -S -<lines>", async () => {
      const { driver, execFileImpl } = createDriver(() => ({ stdout: "pane text\n" }));
      const text = await driver.capturePane({ sessionName: kSessionName, lines: 800, env: kEnv });
      expect(text).toBe("pane text\n");
      expect(execFileImpl.mock.calls[0][1]).toEqual([
        ...kSocketPrefix,
        "capture-pane",
        "-p",
        "-J",
        "-t",
        kSessionName,
        "-S",
        "-800",
      ]);
    });

    it("bounds the full-history capture (lines=null) to -S -50000, never a bare -", async () => {
      const { driver, execFileImpl } = createDriver(() => ({ stdout: "full history\n" }));
      const text = await driver.capturePane({ sessionName: kSessionName, lines: null, env: kEnv });
      expect(text).toBe("full history\n");
      expect(execFileImpl.mock.calls[0][1]).toEqual([
        ...kSocketPrefix,
        "capture-pane",
        "-p",
        "-J",
        "-t",
        kSessionName,
        "-S",
        "-50000",
      ]);
    });

    it("returns null on nonzero exit", async () => {
      const { driver } = createDriver(() => ({ error: kExitOneError() }));
      expect(await driver.capturePane({ sessionName: kSessionName, env: kEnv })).toBeNull();
    });
  });

  describe("sendKeys", () => {
    it("sends the payload literally, then Enter as a named key in its own call", async () => {
      const { driver, execFileImpl } = createDriver();
      const result = await driver.sendKeys({
        sessionName: kSessionName,
        text: "hunter2",
        env: kEnv,
      });
      expect(result.code).toBe(0);
      expect(execFileImpl).toHaveBeenCalledTimes(2);
      expect(execFileImpl.mock.calls[0][1]).toEqual([
        ...kSocketPrefix,
        "send-keys",
        "-t",
        kSessionName,
        "-l",
        "hunter2",
      ]);
      expect(execFileImpl.mock.calls[1][1]).toEqual([
        ...kSocketPrefix,
        "send-keys",
        "-t",
        kSessionName,
        "Enter",
      ]);
      // The submit call must never be literal, or Enter would be typed text.
      expect(execFileImpl.mock.calls[1][1]).not.toContain("-l");
    });

    it("does not send Enter when the literal send fails", async () => {
      const { driver, execFileImpl } = createDriver(() => ({ error: kExitOneError() }));
      const result = await driver.sendKeys({ sessionName: kSessionName, text: "x", env: kEnv });
      expect(result.code).toBe(1);
      expect(execFileImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("listPaneInfo", () => {
    it("parses a live pane line", async () => {
      const { driver, execFileImpl } = createDriver(() => ({ stdout: "4242 0\n" }));
      expect(await driver.listPaneInfo({ sessionName: kSessionName, env: kEnv })).toEqual({
        panePid: 4242,
        paneDead: false,
      });
      expect(execFileImpl.mock.calls[0][1]).toEqual([
        ...kSocketPrefix,
        "list-panes",
        "-s",
        "-t",
        kSessionName,
        "-F",
        "#{pane_pid} #{pane_dead}",
      ]);
    });

    it("parses a dead pane line (remain-on-exit)", async () => {
      const { driver } = createDriver(() => ({ stdout: "4242 1\n" }));
      expect(await driver.listPaneInfo({ sessionName: kSessionName, env: kEnv })).toEqual({
        panePid: 4242,
        paneDead: true,
      });
    });

    it("returns panePid null for an unparseable line", async () => {
      const { driver } = createDriver(() => ({ stdout: "garbage\n" }));
      expect(await driver.listPaneInfo({ sessionName: kSessionName, env: kEnv })).toEqual({
        panePid: null,
        paneDead: false,
      });
    });

    it("returns null for empty stdout", async () => {
      const { driver } = createDriver(() => ({ stdout: "" }));
      expect(await driver.listPaneInfo({ sessionName: kSessionName, env: kEnv })).toBeNull();
    });

    it("returns null on nonzero exit", async () => {
      const { driver } = createDriver(() => ({ error: kExitOneError("no such session") }));
      expect(await driver.listPaneInfo({ sessionName: kSessionName, env: kEnv })).toBeNull();
    });
  });

  describe("killSession", () => {
    it("is ok on exit 0", async () => {
      const { driver } = createDriver();
      const { ok } = await driver.killSession({ sessionName: kSessionName, env: kEnv });
      expect(ok).toBe(true);
    });

    it("is ok when the session is already gone (idempotent)", async () => {
      const kStderr = `can't find session: ${kSessionName}\n`;
      const { driver } = createDriver(() => ({
        error: kExitOneError(kStderr),
        stderr: kStderr,
      }));
      const { ok } = await driver.killSession({ sessionName: kSessionName, env: kEnv });
      expect(ok).toBe(true);
    });

    it("is not ok on an unrelated failure", async () => {
      const kStderr = "server exited unexpectedly\n";
      const { driver } = createDriver(() => ({
        error: kExitOneError(kStderr),
        stderr: kStderr,
      }));
      const { ok } = await driver.killSession({ sessionName: kSessionName, env: kEnv });
      expect(ok).toBe(false);
    });
  });

  describe("run", () => {
    it("resolves code 1 when execFile throws synchronously (tmux absent)", async () => {
      const execFileImpl = vi.fn(() => {
        const err = new Error("spawn tmux ENOENT");
        err.code = "ENOENT";
        throw err;
      });
      const driver = createTmuxDriver({ socketPath: kSocketPath, execFileImpl });
      const result = await driver.run(["has-session", "-t", kSessionName]);
      expect(result.code).toBe(1);
      expect(result.error).toBeTruthy();
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("ENOENT");
    });
  });

  describe("hasTmux", () => {
    it("reports ok with the trimmed version", async () => {
      const { driver, execFileImpl } = createDriver(() => ({ stdout: "tmux 3.6a\n" }));
      expect(await driver.hasTmux({ env: kEnv })).toEqual({ ok: true, version: "tmux 3.6a" });
      // The probe is socket-independent: bare tmux -V.
      expect(execFileImpl.mock.calls[0][1]).toEqual(["-V"]);
    });

    it("is ok:false on error", async () => {
      const { driver } = createDriver(() => ({ error: kExitOneError("not found") }));
      expect(await driver.hasTmux({ env: kEnv })).toEqual({ ok: false, version: "" });
    });

    it("is ok:false when execFile throws synchronously", async () => {
      const execFileImpl = vi.fn(() => {
        throw new Error("spawn tmux ENOENT");
      });
      const driver = createTmuxDriver({ socketPath: kSocketPath, execFileImpl });
      expect(await driver.hasTmux({ env: kEnv })).toEqual({ ok: false, version: "" });
    });
  });
});
