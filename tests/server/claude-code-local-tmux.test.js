const { createTmuxDriver } = require("../../lib/server/claude-code-local/tmux");

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
      expect(execFileImpl).toHaveBeenCalledTimes(3);
      expect(execFileImpl.mock.calls[0][0]).toBe("tmux");
      expect(execFileImpl.mock.calls[0][1]).toEqual([
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
      // The scrubbed env must reach the server-starting call too.
      expect(execFileImpl.mock.calls[0][2].env).toBe(kEnv);
      expect(execFileImpl.mock.calls[1][1]).toEqual([
        ...kSocketPrefix,
        "set-option",
        "-t",
        kSessionName,
        "remain-on-exit",
        "on",
      ]);
      expect(execFileImpl.mock.calls[2][1]).toEqual([
        ...kSocketPrefix,
        "set-option",
        "-t",
        kSessionName,
        "history-limit",
        "50000",
      ]);
    });

    it("skips the follow-up options when creation fails", async () => {
      const { driver, execFileImpl } = createDriver(() => ({
        error: kExitOneError("duplicate session"),
        stderr: "duplicate session: alphaclaw-rescue",
      }));
      const result = await driver.newSession({
        sessionName: kSessionName,
        cwd: kWorkspace,
        commandArgv: kCommandArgv,
        env: kEnv,
      });
      expect(result.code).toBe(1);
      expect(execFileImpl).toHaveBeenCalledTimes(1);
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

    it("captures the full history with -S - when lines is null", async () => {
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
        "-",
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
