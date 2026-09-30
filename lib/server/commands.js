const childProcess = require("child_process");
const { exec, execFile } = childProcess;
const { OPENCLAW_DIR, GOG_KEYRING_PASSWORD } = require("./constants");
const { scrubTokenParams } = require("./utils/redact");
const { createRunStream } = require("./openclaw-run-stream");
const { kRepairKillGraceMs } = require("./repair-operation");
const { processGroupHasWriters } = require("./process-group");

// How long clawCmd waits after the timeout signal before SIGKILLing a process
// group that is still alive (an `openclaw` CLI finishing a state-DB write).
const kClawCmdKillGraceMs = 5000;
// exec's default was 1 MiB (overflow killed the CLI and failed the call);
// JSON listings grow past that on larger installs.
const kClawCmdMaxBufferBytes = 16 * 1024 * 1024;

const createCommands = ({ gatewayEnv }) => {
  // The one argv-form spawn primitive (no shell). Resolves
  // { err, stdout, stderr } with trimmed text and NEVER rejects; the two
  // public wrappers shape it — execFileCmd into shellCmd's string/Error
  // contract, clawCmdWithBin into clawCmd's result object.
  const runExecFile = (file, args, opts = {}) =>
    new Promise((resolve) => {
      const { timeoutMs, ...execOpts } = opts;
      const timeout = timeoutMs ?? execOpts.timeout ?? 60000;
      execFile(
        file,
        args,
        { timeout, ...execOpts },
        (err, stdout, stderr) => {
          resolve({
            err: err || null,
            stdout: String(stdout || "").trim(),
            stderr: String(stderr || "").trim(),
          });
        },
      );
    });

  // Argv-form command runner: no shell, so untrusted operands (model keys,
  // provider secrets, remote URLs) can never be interpreted as shell syntax.
  // Same resolution shape as shellCmd ({stdout} on success, error.stdout/stderr
  // on failure) so callers swap one for the other without reshaping results.
  const execFileCmd = async (file, args = [], opts = {}) => {
    if (opts.processGroup) {
      let stdout = "";
      let stderr = "";
      const result = await createRunStream().runStreamed({
        command: file,
        args,
        env: opts.env,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? 60_000,
        killGraceMs: kRepairKillGraceMs,
        signal: opts.signal,
        onProcess: opts.onProcess,
        onOutput: (text, stream) => {
          if (stream === "stderr") stderr = (stderr + text).slice(-1024 * 1024);
          else stdout = (stdout + text).slice(-1024 * 1024);
          opts.onOutput?.(text, stream);
        },
      });
      if (!result.ok) {
        throw Object.assign(new Error("Grouped command failed"), {
          code: result.code,
          killed: result.killed,
          signal: result.signal,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      }
      return stdout.trim();
    }
    const { err, stdout, stderr } = await runExecFile(file, args, opts);
    if (err) {
      err.stdout = stdout;
      err.stderr = stderr;
      throw err;
    }
    return stdout;
  };

  const shellCmd = (cmd, opts = {}) =>
    new Promise((resolve, reject) => {
      const {
        logStdout,
        timeoutMs = 60000,
        ...execOpts
      } = opts;
      const shouldLogStdout =
        typeof logStdout === "boolean" ? logStdout : !cmd.includes("--json");
      console.log(
        `[onboard] Running: ${cmd
          .replace(/ghp_[^\s"]+/g, "***")
          .replace(/github_pat_[^\s"]+/g, "***")
          .replace(/sk-[^\s"]+/g, "***")
          // Mask the value after a known secret-valued flag (gateway token,
          // provider tokens/keys) so a shelled command can't print it in the
          // clear (H1). Quoted or bare values are both covered.
          .replace(
            /(--(?:gateway-token|token|bot-token|app-token|[a-z-]*api-key)[=\s]+)("?)[^\s"]+\2/gi,
            "$1***",
          )
          .slice(0, 200)}`,
      );
      exec(cmd, { timeout: timeoutMs, ...execOpts }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || "").trim();
          err.stderr = String(stderr || "").trim();
          err.cmd = cmd;
          console.error(
            `[onboard] Error: ${scrubTokenParams(String(stderr || err.message || "").slice(0, 300))}`,
          );
          return reject(err);
        }
        if (shouldLogStdout && stdout.trim()) {
          console.log(`[onboard] ${stdout.trim().slice(0, 300)}`);
        }
        resolve(stdout.trim());
      });
    });

  // clawCmd used `exec` with its `timeout` option, which signals only the
  // `/bin/sh -c` wrapper: dash (Debian's /bin/sh) does not exec the last
  // command, so the `openclaw` process is a grandchild that survives the
  // timeout, reparents to PID 1 and keeps holding OpenClaw's state lifecycle
  // while the caller already reports failure and rolls back. `exec` also
  // ignores `detached`, so the wrapper is spawned here directly in its own
  // process group. On timeout the whole group gets `killSignal`, then SIGKILL
  // after `killGraceMs`, and the result settles only once the group can no
  // longer write, so a caller's follow-up never races a still-running CLI.
  // `killScope: "leader"` keeps exec's old leader-only kill for the one
  // caller that needs the CLI to outlive the call (the WhatsApp QR login).
  // The command text still goes through the platform shell unchanged
  // (callers pass shell-quoted arguments) and the result object keeps exec's
  // contract, including its maxBuffer overflow reading as a timeout.
  const clawCmd = (
    cmd,
    {
      quiet = false,
      timeoutMs = 15000,
      killSignal = "SIGTERM",
      killGraceMs = kClawCmdKillGraceMs,
      killScope = "group",
      maxBuffer = kClawCmdMaxBufferBytes,
    } = {},
  ) =>
    new Promise((resolve) => {
      if (!quiet) console.log(`[alphaclaw] Running: openclaw ${cmd}`);
      const useGroup = process.platform !== "win32" && killScope !== "leader";
      let timedOut = false;
      let overflow = false;
      let settled = false;
      let timer = null;
      let graceTimer = null;
      let stdout = "";
      let stderr = "";
      let capturedBytes = 0;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        if (!quiet && !result.ok) {
          // A failing `openclaw dashboard` run can print its token-bearing
          // URL to stderr before dying — scrub token params by shape.
          console.log(
            `[alphaclaw] Error: ${scrubTokenParams(result.stderr.slice(0, 200))}`,
          );
        }
        resolve(result);
      };
      const shellCommand = `openclaw ${cmd}`;
      let child;
      try {
        child =
          process.platform === "win32"
            ? childProcess.spawn(
                process.env.ComSpec || "cmd.exe",
                ["/d", "/s", "/c", `"${shellCommand}"`],
                { env: gatewayEnv(), windowsVerbatimArguments: true, windowsHide: true },
              )
            : childProcess.spawn("/bin/sh", ["-c", shellCommand], {
                env: gatewayEnv(),
                detached: useGroup,
              });
      } catch (error) {
        finish({
          ok: false,
          stdout: "",
          stderr: String(error?.message || ""),
          code: error?.code,
          killed: false,
          signal: null,
          timedOut: false,
        });
        return;
      }
      const pid = child.pid;
      const ownsGroup = useGroup && Number.isInteger(pid) && pid > 1;
      const destroyPipes = () => {
        try { child.stdout?.destroy?.(); } catch {}
        try { child.stderr?.destroy?.(); } catch {}
      };
      const kill = (sig) => {
        if (ownsGroup) {
          try {
            process.kill(-pid, sig);
            return;
          } catch {}
        }
        try {
          child.kill(sig);
        } catch {}
      };
      const stopForLimit = () => {
        timedOut = true;
        kill(killSignal);
        if (!ownsGroup) {
          // Leader-only: settle when the leader exits (the "exit" handler
          // below) and keep draining the pipes, so a CLI that outlives the
          // call (the WhatsApp login) is never cut off by a closed pipe. A
          // leader that already exited while a descendant holds the pipes
          // settles right away.
          if (child.exitCode !== null || child.signalCode !== null) {
            finish(buildResult(child.exitCode, child.signalCode));
          }
          return;
        }
        graceTimer = setTimeout(() => {
          kill("SIGKILL");
          // A descendant outside the group (setsid) could still hold the
          // pipes; destroy them so `close` fires once the leader is gone.
          destroyPipes();
        }, killGraceMs);
      };
      // Decode as a stream (like exec) so a multi-byte UTF-8 character split
      // across chunks is not mangled.
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      const onData = (stream) => (chunk) => {
        // Past the cap, or once settled, output is drained and discarded.
        if (overflow || settled) return;
        if (stream === "stdout") stdout += chunk;
        else stderr += chunk;
        // Bytes, not UTF-16 units (as execFile counts maxBuffer).
        capturedBytes += Buffer.byteLength(chunk, "utf8");
        if (capturedBytes > maxBuffer) {
          overflow = true;
          if (!timedOut) stopForLimit();
        }
      };
      child.stdout?.on("data", onData("stdout"));
      child.stderr?.on("data", onData("stderr"));
      child.on("error", (error) => {
        finish({
          ok: false,
          stdout: stdout.trim(),
          stderr: (stderr || String(error?.message || "")).trim(),
          code: error?.code,
          killed: timedOut,
          signal: null,
          timedOut,
        });
      });
      const buildResult = (code, signal) => {
        const failed = code !== 0 || timedOut;
        const result = {
          ok: !failed,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          // exec reports no code on success.
          code: failed
            ? overflow
              ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              : (code ?? null)
            : undefined,
        };
        if (failed) {
          result.killed = timedOut;
          result.signal = signal || (timedOut ? killSignal : null);
          result.timedOut = timedOut;
        }
        return result;
      };
      child.on("exit", (code, signal) => {
        // Leader-only kill after a limit: the leader is gone, a descendant
        // may keep the pipes open on purpose; settle now.
        if (timedOut && !ownsGroup) finish(buildResult(code, signal));
      });
      child.on("close", (code, signal) => {
        const result = buildResult(code, signal);
        if (!timedOut || !ownsGroup) {
          finish(result);
          return;
        }
        // The leader closed its pipes; give any group member still writing
        // the rest of the grace period, then SIGKILL it before settling.
        const deadline = Date.now() + killGraceMs;
        const waitForGroup = () => {
          if (!processGroupHasWriters(pid)) return finish(result);
          if (Date.now() >= deadline) {
            kill("SIGKILL");
            return finish(result);
          }
          setTimeout(waitForGroup, 100);
        };
        waitForGroup();
      });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(stopForLimit, timeoutMs);
      }
    });

  // clawCmd for a SPECIFIC openclaw bin instead of whatever `openclaw`
  // resolves to on PATH (issue #76 C6: while the watchdog has a
  // versionMismatch latched, the repair doctor step and the capability probes
  // must talk to the binary that can read the CURRENT DBs — the expected
  // overlay's bin — never to the diverged tree on PATH). Same contract as
  // clawCmd: a result object, never rejects on a failed command, 15s default
  // timeout, SIGTERM. Argv-form through the execFileCmd primitive (no shell),
  // and the bin runs under the CURRENT node — `process.execPath [bin,
  // ...args]` — exactly how the channel prober and the config validator
  // invoke an overlay's bin, so a bin with a foreign shebang or a lost +x
  // still runs. `cmd` is the same trusted command text clawCmd takes
  // ("gateway stop --help"), split on whitespace with quotes grouping words
  // and NOTHING expanded; pass an argv array to skip the split. `env`
  // defaults to the gateway env (the OPENCLAW_STATE_DIR/CONFIG_PATH the
  // gateway itself sees); an UNVERIFIED candidate must be probed under an
  // explicit probeEnv() instead.
  const clawCmdWithBin = async (
    bin,
    cmd,
    { quiet = false, timeoutMs = 15000, killSignal = "SIGTERM", env = null } = {},
  ) => {
    if (typeof bin !== "string" || bin.trim() === "") {
      throw new TypeError("clawCmdWithBin requires a bin path");
    }
    const args = Array.isArray(cmd) ? cmd.map(String) : splitCommandLine(cmd);
    if (!quiet) console.log(`[alphaclaw] Running: ${bin} ${args.join(" ")}`);
    const { err, stdout, stderr } = await runExecFile(
      process.execPath,
      [bin, ...args],
      {
        env: env && typeof env === "object" ? env : gatewayEnv(),
        timeoutMs,
        killSignal,
      },
    );
    const result = { ok: !err, stdout, stderr, code: err?.code };
    if (err) {
      result.killed = Boolean(err.killed);
      result.signal = err.signal || null;
      result.timedOut = Boolean(err.killed && err.signal === killSignal);
    }
    if (!quiet && !result.ok) {
      console.log(
        `[alphaclaw] Error: ${scrubTokenParams(result.stderr.slice(0, 200))}`,
      );
    }
    return result;
  };

  const gogCmd = (cmd, { quiet = false } = {}) =>
    new Promise((resolve) => {
      if (!quiet) console.log(`[alphaclaw] Running: gog ${cmd}`);
      exec(
        `gog ${cmd}`,
        {
          timeout: 15000,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: OPENCLAW_DIR,
            GOG_KEYRING_PASSWORD,
          },
        },
        (err, stdout, stderr) => {
          const result = {
            ok: !err,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            // node's exec kills on `timeout` and sets err.killed; distinguish a
            // TRANSIENT failure (hung/killed process — the token may still be
            // live) from a clean nonzero exit, so callers never treat a timeout
            // as "no token" and orphan a live credential.
            timedOut: Boolean(err && err.killed),
            code: err && typeof err.code === "number" ? err.code : null,
          };
          if (!quiet && !result.ok) {
            console.log(`[alphaclaw] gog error: ${result.stderr.slice(0, 200)}`);
          }
          resolve(result);
        },
      );
    });

  // OpenClaw 2026.8 rate-limits gateway control-plane writes (30/min per method).
  // A limited call returns { code: "UNAVAILABLE", retryable: true, retryAfterMs } and
  // exits nonzero. Honor retryAfterMs (capped) with a bounded number of retries
  // instead of failing the whole operation.
  const clawCmdWithRetry = async (cmd, opts = {}) => {
    const {
      maxRetries = 2,
      maxBackoffMs = 30000,
      sleepFn = sleep,
      ...rest
    } = opts;
    let result = await clawCmd(cmd, rest);
    let attempt = 0;
    while (!result.ok && attempt < maxRetries) {
      const unavailable = parseUnavailableRetry(result);
      if (!unavailable) break;
      attempt += 1;
      const wait = Math.min(
        unavailable.retryAfterMs > 0 ? unavailable.retryAfterMs : attempt * 500,
        maxBackoffMs,
      );
      await sleepFn(wait);
      result = await clawCmd(cmd, rest);
    }
    return result;
  };

  return {
    shellCmd,
    execFileCmd,
    clawCmd,
    clawCmdWithBin,
    clawCmdWithRetry,
    gogCmd,
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Split a TRUSTED command string into argv for the argv-form runners. Words
// are separated by whitespace; a double- or single-quoted run groups words
// ('config set a "two words"' → ["config", "set", "a", "two words"]). Nothing
// is expanded — there is no shell on this path, so `$VAR`, globs, `;` and
// redirects stay literal characters in their argument. An unterminated quote
// runs to the end of the string.
const splitCommandLine = (cmd) => {
  const text = String(cmd ?? "");
  const args = [];
  let current = "";
  let inWord = false;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        args.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) args.push(current);
  return args;
};

// Detect a gateway control-plane rate-limit response in a clawCmd result. Returns
// { retryAfterMs } when the output is an UNAVAILABLE/retryable error, else null.
const parseUnavailableRetry = (result) => {
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  if (!/UNAVAILABLE/i.test(text)) return null;
  const match = text.match(/\{[\s\S]*?"code"\s*:\s*"UNAVAILABLE"[\s\S]*?\}/i);
  let retryAfterMs = 0;
  if (match) {
    try {
      const doc = JSON.parse(match[0]);
      if (doc && doc.retryable === false) return null;
      retryAfterMs = Number(doc.retryAfterMs) || 0;
    } catch {
      /* fall through with default backoff */
    }
  }
  return { retryAfterMs };
};

module.exports = { createCommands, parseUnavailableRetry, splitCommandLine };
