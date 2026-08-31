const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const kSessionIdleTtlMs = 15 * 60 * 1000;
const kCleanupIntervalMs = 30 * 1000;
const kMaxBufferedOutputChars = 200000;

const hasScriptCommand = () => {
  try {
    const result = spawnSync("sh", ["-lc", "command -v script >/dev/null 2>&1"], {
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
};

const kMinTerminalCols = 20;
const kMaxTerminalCols = 500;
const kDefaultTerminalCols = 120;
const kMinTerminalRows = 5;
const kMaxTerminalRows = 200;
const kDefaultTerminalRows = 30;

// Both size inputs arrive from the BROWSER (WS query params) and are
// interpolated into a `sh -c` wrapper string below — clamping to bounded
// integers IS the injection guard, not a nicety. Anything non-numeric
// (including shell metacharacters) collapses to the defaults.
const clampTerminalDimension = (value, { min, max, fallback }) => {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};
const clampTerminalSize = ({ cols, rows } = {}) => ({
  cols: clampTerminalDimension(cols, {
    min: kMinTerminalCols,
    max: kMaxTerminalCols,
    fallback: kDefaultTerminalCols,
  }),
  rows: clampTerminalDimension(rows, {
    min: kMinTerminalRows,
    max: kMaxTerminalRows,
    fallback: kDefaultTerminalRows,
  }),
});

// The shell path is operator-env-controlled (process.env.SHELL), not remote
// input — but it rides the same wrapper string, so keep it to a plain
// absolute path and fall back to bash for anything exotic.
const kSafeShellPattern = /^\/[A-Za-z0-9._/-]+$/;
const resolveSafeShell = (shell) =>
  kSafeShellPattern.test(String(shell || "")) ? String(shell) : "/bin/bash";

/*
  PTY spawn pipeline (upstream #76 — why the wrapper exists):

    node ──spawn(stdio:pipe)──▶ script -q -f -c "<wrapper>" /dev/null
                                   │ script's own stdin is a PIPE, not a tty,
                                   │ so it calls openpty() with a NULL winsize
                                   │ and the kernel leaves the PTY at 0×0 —
                                   │ a Node TUI then sees isTTY=true with
                                   │ columns=0 and renders one glyph per line.
                                   ▼
              wrapper:  stty rows R cols C 2>/dev/null; exec <shell> -i
                                   │ sets the slave's winsize BEFORE the shell
                                   │ starts (R/C are clamped integers); exec
                                   │ keeps the shell as the PTY's foreground
                                   │ leader, so signal delivery is unchanged.
                                   ▼
                              <shell> -i

  There is deliberately NO live resize: writing `stty ...` into the shell's
  stdin only works at an idle prompt and corrupts a running TUI's input. A
  new size applies at the next (re)spawn — restart button, dead-process
  respawn — from the latest connection's recorded size (node-pty → TODOS).
*/
const buildPtyWrapperCommand = ({ shell, cols, rows } = {}) => {
  const size = clampTerminalSize({ cols, rows });
  return `stty rows ${size.rows} cols ${size.cols} 2>/dev/null; exec ${resolveSafeShell(shell)} -i`;
};

const createShellProcess = ({
  shell = "/bin/bash",
  cwd = process.cwd(),
  env = {},
  preferPty = false,
  cols,
  rows,
} = {}) => {
  const wrapperCommand = buildPtyWrapperCommand({ shell, cols, rows });
  if (preferPty && process.platform === "darwin") {
    return spawn("script", ["-q", "/dev/null", "/bin/sh", "-c", wrapperCommand], {
      cwd,
      env: { ...env, TERM: env.TERM || "xterm-256color" },
      stdio: "pipe",
    });
  }
  if (preferPty) {
    return spawn("script", ["-q", "-f", "-c", wrapperCommand, "/dev/null"], {
      cwd,
      env: { ...env, TERM: env.TERM || "xterm-256color" },
      stdio: "pipe",
    });
  }
  // No PTY available: stty has nothing to size — spawn the shell directly.
  return spawn(resolveSafeShell(shell), ["-i"], {
    cwd,
    env: { ...env, TERM: env.TERM || "xterm-256color" },
    stdio: "pipe",
  });
};

const createWatchdogTerminalService = ({
  cwd = process.cwd(),
  shell = process.env.SHELL || "/bin/bash",
  env = process.env,
  // Injectable for tests: lets a fake child deterministically emit spawn
  // 'error' / stdin EPIPE without a real shell (H12 coverage).
  createProcess = createShellProcess,
} = {}) => {
  let session = null;
  const preferPty = hasScriptCommand();
  // Latest clamped size from the most recent client connection. EVERY respawn
  // path (restart button, dead-process respawn, first create) uses it —
  // first-connection-wins would half-reintroduce #76 after a window resize.
  let lastRequestedSize = clampTerminalSize({});

  const notifySubscribers = (event) => {
    if (!session?.subscribers?.size) return;
    session.subscribers.forEach((subscriber) => {
      try {
        subscriber(event);
      } catch {}
    });
  };

  const appendOutput = (chunk = "") => {
    if (!session || !chunk) return;
    const chunkText = String(chunk);
    session.output += chunkText;
    session.endCursor += chunkText.length;
    if (session.output.length > kMaxBufferedOutputChars) {
      const trimCount = session.output.length - kMaxBufferedOutputChars;
      session.output = session.output.slice(trimCount);
      session.startCursor += trimCount;
    }
    notifySubscribers({ type: "output", data: chunkText });
  };

  const markActive = () => {
    if (!session) return;
    session.lastActiveAtMs = Date.now();
  };

  const createOrReuseSession = ({ cols, rows } = {}) => {
    if (cols !== undefined || rows !== undefined) {
      lastRequestedSize = clampTerminalSize({ cols, rows });
    }
    if (session && !session.ended) {
      markActive();
      // Reuse deliberately does NOT resize the live PTY (see the spawn
      // pipeline comment above) — the recorded size applies at next respawn.
      return {
        id: session.id,
        shell,
        cwd,
        ended: false,
        size: session.size,
      };
    }
    if (session && session.ended) session = null;

    const proc = createProcess({
      shell,
      cwd,
      env,
      preferPty,
      cols: lastRequestedSize.cols,
      rows: lastRequestedSize.rows,
    });
    const sessionId = crypto.randomUUID();
    // One line per spawn so a future "smashed text" report is reconstructable
    // from logs alone (was: an invisible 0×0 PTY).
    console.log(
      `[watchdog-terminal] session ${sessionId.slice(0, 8)} spawned at ${lastRequestedSize.cols}x${lastRequestedSize.rows} (pty=${preferPty})`,
    );
    session = {
      id: sessionId,
      proc,
      size: { ...lastRequestedSize },
      output: "",
      startCursor: 0,
      endCursor: 0,
      ended: false,
      exitCode: null,
      signal: null,
      lastActiveAtMs: Date.now(),
      subscribers: new Set(),
    };

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => appendOutput(chunk));
    proc.stderr.on("data", (chunk) => appendOutput(chunk));
    // Spawn failures (ENOENT on a bad SHELL / missing `script`) emit 'error';
    // with no listener Node throws → uncaughtException → gracefulExit(1) (H12).
    // Mark the session ended and deliver a terminal exit so the WS bridge shows
    // it instead of the whole AlphaClaw process restarting.
    proc.on("error", (error) => {
      if (!session || session.id !== sessionId) return;
      session.ended = true;
      session.exitCode = null;
      session.signal = null;
      appendOutput(`\r\n[terminal error: ${String(error?.message || error)}]\r\n`);
      notifySubscribers({ type: "exit", code: null, signal: null });
    });
    // An EPIPE on stdin (shell exits between the writable check and the write)
    // also emits 'error' — swallow it; writeInput already reports the failure.
    proc.stdin?.on("error", () => {});
    proc.on("close", (code, signal) => {
      if (!session || session.id !== sessionId) return;
      session.ended = true;
      session.exitCode = code;
      session.signal = signal;
      const endLine = `\r\n[terminal exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}]\r\n`;
      appendOutput(endLine);
      notifySubscribers({
        type: "exit",
        code,
        signal,
      });
    });

    return {
      id: session.id,
      shell,
      cwd,
      ended: false,
      size: session.size,
    };
  };

  const subscribe = ({
    sessionId = "",
    onEvent = () => {},
    replayBuffer = true,
    tailLines = 0,
  } = {}) => {
    if (!session || String(session.id) !== String(sessionId || "")) {
      return {
        ok: false,
        error: "Terminal session not found",
        unsubscribe: () => {},
      };
    }
    markActive();
    const subscriber = (event) => onEvent(event);
    session.subscribers.add(subscriber);
    if (replayBuffer && session.output) {
      onEvent({ type: "output", data: session.output });
    } else if (!replayBuffer && Number(tailLines || 0) > 0 && !session.ended) {
      const lines = String(session.output || "").split("\n");
      const count = Math.max(1, Math.floor(Number(tailLines || 0)));
      const tail = lines.slice(-count).join("\n");
      if (tail.trim()) onEvent({ type: "output", data: tail });
    }
    if (session.ended) {
      onEvent({
        type: "exit",
        code: session.exitCode,
        signal: session.signal,
      });
    }
    return {
      ok: true,
      unsubscribe: () => {
        if (!session) return;
        session.subscribers.delete(subscriber);
      },
    };
  };

  const readOutput = ({ sessionId = "", cursor = 0 } = {}) => {
    if (!session || String(session.id) !== String(sessionId || "")) {
      return {
        found: false,
        output: "",
        cursor: 0,
        startCursor: 0,
        endCursor: 0,
        ended: true,
      };
    }
    markActive();
    const requestedCursor = Number(cursor);
    const safeCursor = Number.isFinite(requestedCursor)
      ? Math.max(0, Math.floor(requestedCursor))
      : 0;
    const effectiveCursor =
      safeCursor < session.startCursor || safeCursor > session.endCursor
        ? session.startCursor
        : safeCursor;
    const sliceIndex = Math.max(0, effectiveCursor - session.startCursor);
    return {
      found: true,
      output: session.output.slice(sliceIndex),
      cursor: session.endCursor,
      startCursor: session.startCursor,
      endCursor: session.endCursor,
      ended: !!session.ended,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  };

  const writeInput = ({ sessionId = "", input = "" } = {}) => {
    if (!session || String(session.id) !== String(sessionId || "")) {
      return { ok: false, error: "Terminal session not found" };
    }
    if (session.ended || !session.proc.stdin.writable) {
      return { ok: false, error: "Terminal session has ended" };
    }
    markActive();
    // Guard the write: the shell can exit between the writable check above and
    // the write, and an unguarded EPIPE would surface as a throw (H12).
    try {
      session.proc.stdin.write(String(input || ""));
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
    return { ok: true };
  };

  const closeSession = ({ sessionId = "" } = {}) => {
    if (!session || String(session.id) !== String(sessionId || "")) {
      return { ok: true };
    }
    const targetProc = session.proc;
    session = null;
    try {
      targetProc.kill("SIGTERM");
    } catch {}
    return { ok: true };
  };

  const disposeSession = () => {
    if (!session) return;
    const targetProc = session.proc;
    session = null;
    try {
      targetProc.kill("SIGTERM");
    } catch {}
  };

  const cleanupTimer = setInterval(() => {
    if (!session || session.ended) return;
    const idleForMs = Date.now() - Number(session.lastActiveAtMs || 0);
    if (idleForMs < kSessionIdleTtlMs) return;
    try {
      session.proc.kill("SIGTERM");
    } catch {}
  }, kCleanupIntervalMs);
  cleanupTimer.unref?.();

  return {
    createOrReuseSession,
    subscribe,
    readOutput,
    writeInput,
    closeSession,
    disposeSession,
  };
};

module.exports = {
  createWatchdogTerminalService,
  // Pure helpers exported for tests: the wrapper string is where browser
  // input would become command injection if the clamp ever regressed.
  buildPtyWrapperCommand,
  clampTerminalSize,
  resolveSafeShell,
};
