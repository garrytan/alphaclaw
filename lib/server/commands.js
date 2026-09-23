const { exec, execFile } = require("child_process");
const { OPENCLAW_DIR, GOG_KEYRING_PASSWORD } = require("./constants");
const { scrubTokenParams } = require("./utils/redact");

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

  const clawCmd = (
    cmd,
    { quiet = false, timeoutMs = 15000, killSignal = "SIGTERM" } = {},
  ) =>
    new Promise((resolve) => {
      if (!quiet) console.log(`[alphaclaw] Running: openclaw ${cmd}`);
      exec(
        `openclaw ${cmd}`,
        {
          env: gatewayEnv(),
          timeout: timeoutMs,
          killSignal,
        },
        (err, stdout, stderr) => {
          const result = {
            ok: !err,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: err?.code,
          };
          if (err) {
            result.killed = Boolean(err.killed);
            result.signal = err.signal || null;
            result.timedOut = Boolean(err.killed && err.signal === killSignal);
          }
          if (!quiet && !result.ok) {
            // A failing `openclaw dashboard` run can print its token-bearing
            // URL to stderr before dying — scrub token params by shape.
            console.log(
              `[alphaclaw] Error: ${scrubTokenParams(result.stderr.slice(0, 200))}`,
            );
          }
          resolve(result);
        },
      );
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
