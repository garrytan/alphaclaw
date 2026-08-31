// Thin tmux driver for the rescue session. Everything is argv-form execFile —
// there is deliberately NO shell string anywhere (the injection surface is
// deleted, not quoted): the pane command rides tmux's own argv form after
// `--`, and the child env rides `env -i K=V…` argv items.
//
// Every call carries the caller's env (buildRescueEnv) so the IMPLICIT
// server-starting first invocation is as scrubbed as the panes: a tmux server
// inherits its spawner's environment and would otherwise expose AlphaClaw's
// secrets via `show-environment`. `-f /dev/null` keeps operator ~/.tmux.conf
// out of the rescue server for the same reason.
const { execFile } = require("child_process");

const kDefaultTimeoutMs = 10_000;

const createTmuxDriver = ({
  socketPath,
  execFileImpl = execFile,
  timeoutMs = kDefaultTimeoutMs,
} = {}) => {
  const run = (args, { env, timeoutMs: callTimeoutMs } = {}) =>
    new Promise((resolve) => {
      let child;
      try {
        child = execFileImpl(
          "tmux",
          ["-S", socketPath, "-f", "/dev/null", ...args],
          { env, timeout: callTimeoutMs ?? timeoutMs, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            resolve({
              code: error ? (error.code === undefined ? 1 : error.code) : 0,
              error: error || null,
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
            });
          },
        );
      } catch (error) {
        // Synchronous spawn failure (ENOENT when tmux is absent).
        resolve({ code: 1, error, stdout: "", stderr: String(error?.message || "") });
        return;
      }
      void child;
    });

  const hasTmux = async ({ env } = {}) => {
    const result = await new Promise((resolve) => {
      try {
        execFileImpl("tmux", ["-V"], { env, timeout: timeoutMs }, (error, stdout) =>
          resolve({ ok: !error, version: String(stdout || "").trim() }),
        );
      } catch {
        resolve({ ok: false, version: "" });
      }
    });
    return result;
  };

  const newSession = async ({
    sessionName,
    cwd,
    commandArgv,
    cols = 220,
    rows = 50,
    env,
  }) => {
    const created = await run(
      [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-x",
        String(cols),
        "-y",
        String(rows),
        "-c",
        cwd,
        "--",
        ...commandArgv,
      ],
      { env },
    );
    if (created.code !== 0) return created;
    // remain-on-exit keeps the death screen capturable — a fast CLI exit
    // would otherwise destroy the only pane, kill the single-session server,
    // and take the diagnostics with it (observed live during the T0 spike).
    // Liveness therefore never trusts has-session alone; it checks the pane
    // PID (service-side). Generous history so adoption re-extraction has a
    // real scrollback to search.
    await run(["set-option", "-t", sessionName, "remain-on-exit", "on"], { env });
    await run(["set-option", "-t", sessionName, "history-limit", "50000"], { env });
    return created;
  };

  const hasSession = async ({ sessionName, env }) => {
    const result = await run(["has-session", "-t", sessionName], { env });
    return { alive: result.code === 0, result };
  };

  // -J joins wrapped lines so a URL split by pane width still matches one
  // regex. lines=null captures the FULL history (adoption fallback).
  const capturePane = async ({ sessionName, lines = 800, env }) => {
    const result = await run(
      [
        "capture-pane",
        "-p",
        "-J",
        "-t",
        sessionName,
        "-S",
        lines == null ? "-" : `-${lines}`,
      ],
      { env },
    );
    return result.code === 0 ? result.stdout : null;
  };

  // "#{pane_pid} #{pane_dead}" — pane_pid is the direct child (the `env`
  // wrapper→claude chain leader); pane_dead flips to 1 under remain-on-exit.
  const listPaneInfo = async ({ sessionName, env }) => {
    const result = await run(
      ["list-panes", "-t", sessionName, "-F", "#{pane_pid} #{pane_dead}"],
      { env },
    );
    if (result.code !== 0) return null;
    const [line] = result.stdout.split("\n").filter(Boolean);
    if (!line) return null;
    const [pidRaw, deadRaw] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidRaw, 10);
    return {
      panePid: Number.isFinite(pid) ? pid : null,
      paneDead: deadRaw === "1",
    };
  };

  const sendKeys = async ({ sessionName, text, env }) => {
    // -l = literal (no key-name interpretation of the payload) …
    const literal = await run(["send-keys", "-t", sessionName, "-l", text], { env });
    if (literal.code !== 0) return literal;
    // … then Enter as a NAMED key in its own call, so the payload can never
    // smuggle key names and the submit is unambiguous.
    return run(["send-keys", "-t", sessionName, "Enter"], { env });
  };

  const killSession = async ({ sessionName, env }) => {
    // Idempotent: exit 1 (no such session) is success for our purposes.
    const result = await run(["kill-session", "-t", sessionName], { env });
    return { ok: result.code === 0 || /can't find session|no server/i.test(result.stderr), result };
  };

  return {
    socketPath,
    run,
    hasTmux,
    newSession,
    hasSession,
    capturePane,
    listPaneInfo,
    sendKeys,
    killSession,
  };
};

module.exports = { createTmuxDriver };
