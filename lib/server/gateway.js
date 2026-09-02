const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const fs = require("fs");

// Manual wrapper (not util.promisify): keeps the {stdout, stderr} resolution
// shape and error.stdout/.stderr regardless of how execFile is injected.
const execFileAsync = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        if (error.stdout === undefined) error.stdout = stdout;
        if (error.stderr === undefined) error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
const net = require("net");
const {
  ALPHACLAW_DIR,
  OPENCLAW_DIR,
  GATEWAY_HOST,
  kDefaultGatewayPort,
  kChannelDefs,
  kOnboardingMarkerPath,
  kRootDir,
  kGatewayRestartReadyTimeoutMs,
} = require("./constants");
const {
  normalizeChannelAccountId,
  readPairedCountsByAccount,
} = require("./agents/shared");
const {
  withOpenclawStartupEnv,
  resolveOpenclawSupervisorMode,
} = require("./openclaw-runtime-env");
const { parsePositiveInt } = require("./utils/number");
const { isOpenAiCompatApiEnabled } = require("./alphaclaw-config");
const { withFileLockSync } = require("./utils/safe-file");
const { applyGatewayAuthEnv } = require("./gateway-credential");
const { filterGatewayChildEnv } = require("./gateway-env-policy");
// Namespace require (not destructured) so tests can spy on the module object.
const lockContention = require("./openclaw-lock-contention");
const { redactSecretShapes } = require("./utils/redact");
// Eager (module-load) require: a lazy require inside the stop path would load
// the module through whatever fs mock a caller has installed at that moment.
const { createOpenclawCapabilities } = require("./openclaw-capabilities");

let gatewayChild = null;
let gatewayExitHandler = null;
let gatewayLaunchHandler = null;
const kGatewayStderrTailLines = 50;
const kPluginRuntimeDepsPreflightTimeoutMs = 120 * 1000;
const kGatewayShortCmdTimeoutMs = 15 * 1000;
const kGatewayShutdownStopTimeoutMs = 5 * 1000;
// Inside the shutdown stop's budget (which itself sits inside the process
// shutdown deadline), a cold `--force` capability probe may take only this
// slice; the CLI stop keeps the remainder, never less than the floor.
const kGatewayShutdownProbeTimeoutMs = 1500;
const kGatewayShutdownStopMinMs = 1000;
const kGatewayLifecycleCmdTimeoutMs = 90 * 1000;
// Readiness budget lives in constants.js (env-tunable GATEWAY_RESTART_READY_TIMEOUT,
// clamped 30-480s, default 300s) so the lifecycle-lock lease, the operation
// record lifetime, and the watchdog suppression windows can derive from the
// same number this wait uses.
const kGatewayRestartReadyPollMs = 500;
// Bounded drain window between a managed child's "exit" and "close": close
// waits on EVERY inherited stdio handle, so a gateway descendant holding the
// fds can stall it indefinitely — long enough for the final post-exit stderr
// flush, short enough that the watchdog still sees the exit promptly.
const kGatewayCloseDrainMs = 400;
const expectedExitPids = new Set();

// Lock-contention evidence (read-only). Upstream's state-lifecycle
// coordinator is an exclusive SQLite transaction held by a LIVE process (see
// openclaw-lock-contention.js) — when a restart fails with contention text,
// the useful fact is WHICH live openclaw process holds it. Appended to the
// attempt's stdout evidence ring so it persists on the operation record.
const appendLockContentionEvidence = (stdoutTail, ...tails) => {
  const text = tails
    .filter(Array.isArray)
    .map((lines) => lines.join("\n"))
    .join("\n");
  if (!lockContention.looksLikeLockContention(text)) return;
  try {
    const report = lockContention.describeLockContention({ site: "restart" });
    for (const line of report.lines) {
      stdoutTail.append(`${line}\n`);
      console.warn(line);
    }
  } catch (error) {
    console.warn(
      `[alphaclaw] lock-contention diagnostic failed: ${String(error?.message || error)}`,
    );
  }
};

// Per-child stderr evidence tail: each spawned child gets its OWN tail,
// captured in its launch closure, so a late 'close' from an old child is
// always classified against that child's stderr — never a successor's. With
// the previous module-global tail, a newer launch reset the buffer and a
// stale exit-78 close could latch configuration_error against a healthy new
// gateway. Per-instance creation also replaces the old reset-per-attempt
// pattern (evidence honesty: a failed restart reports only its own stderr).
const createStderrTail = () => {
  let lines = [];
  let carry = "";
  const append = (chunk) => {
    const text =
      carry +
      (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? ""));
    carry = "";
    const split = text.split("\n");
    // A chunk rarely ends exactly on a newline; hold the trailing partial line
    // until it completes so a secret split across chunks is one tail entry
    // (redaction matches whole values) instead of two unmatchable halves.
    const partial = split.pop();
    // Cap the carry: a gateway that never emits a newline (\r progress bars,
    // one huge line) must not grow it without bound. Keep the tail end — that
    // is what snapshot() surfaces.
    if (partial) carry = partial.slice(-8192);
    for (const line of split) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      // Per-line cap at RETENTION time: completed lines had no bound, so a
      // gateway spraying huge single lines could hold 50 x multi-hundred-KB
      // strings here. 2KB keeps the diagnostic head of any sane log line.
      lines.push(trimmed.length > 2048 ? trimmed.slice(0, 2048) : trimmed);
    }
    if (lines.length > kGatewayStderrTailLines) {
      lines = lines.slice(-kGatewayStderrTailLines);
    }
  };
  // Evidence snapshot: completed lines plus any in-flight partial line (a
  // crash often dies mid-line and that fragment is the interesting part).
  const snapshot = () => {
    const tail = [...lines];
    if (carry.trimEnd()) tail.push(carry.trimEnd());
    return tail.slice(-kGatewayStderrTailLines);
  };
  return { append, snapshot };
};

const setGatewayExitHandler = (handler) => {
  gatewayExitHandler = typeof handler === "function" ? handler : null;
};

const setGatewayLaunchHandler = (handler) => {
  gatewayLaunchHandler = typeof handler === "function" ? handler : null;
};

// ── Gateway prelaunch hook ───────────────────────────────────────────────
// Operator-installed executable that runs before EVERY gateway (re)launch —
// before the plugin preflight and the gateway child import the OpenClaw
// bundle — so runtime patches/sidecars a container image cannot bake in are
// restored first. Boundary (the deployed agent shares AlphaClaw's uid, so
// "owner == self" proves nothing and anything under the tree is
// agent-writable): the path comes ONLY from the deployment-only env key, its
// realpath must lie outside the AlphaClaw root and the OpenClaw state dir, it
// is opened O_NOFOLLOW and the OPEN fd is inspected (regular file, root-owned,
// executable, not group/world-writable) and then executed by fd on Linux, so
// the inode that was checked is the inode that runs. Env is a fixed minimal
// projection — never gatewayEnv() (tokens, passwords). Async, awaited by every
// launch path; any failure is a named error the launch path fails closed on.
//
//   ALPHACLAW_GATEWAY_PRELAUNCH_HOOK
//     │ unset ──────────────► skipped (one debug line, launch proceeds)
//     ▼
//   absolute? → realpath → outside rootDir & OPENCLAW_DIR? → open(O_NOFOLLOW)
//     → fstat(fd): regular ∧ uid 0 ∧ mode&0o111 ∧ !(mode&0o022)
//     → execFile(/proc/<pid>/fd/<fd>) [linux] | execFile(realpath) [other]
//        │ exit 0 ─────► "ran"      → launch proceeds
//        │ non-zero/timeout/spawn ─► "failed"  ┐ GatewayPrelaunchHookError
//        └ any check above fails ──► "refused" ┘ → launch ABORTED
const kGatewayPrelaunchHookEnvKey = "ALPHACLAW_GATEWAY_PRELAUNCH_HOOK";
const kGatewayPrelaunchHookTimeoutMs = 120 * 1000;
const kGatewayPrelaunchHookMaxBuffer = 1024 * 1024;
const kGatewayPrelaunchHookOutputLogChars = 2000;
// Hard deadline past the hook's own timeout: execFile's timeout only signals
// the direct child, so a hook that traps the signal or leaves a descendant
// holding stdio would otherwise keep every launch hanging instead of failing
// closed. After this grace the whole process group is SIGKILLed.
const kGatewayPrelaunchHookGraceMs = 5 * 1000;

class GatewayPrelaunchHookError extends Error {
  constructor(
    message,
    { code, hookPath = null, status = "refused", exitCode = null, signal = null } = {},
  ) {
    super(message);
    this.name = "GatewayPrelaunchHookError";
    this.code = String(code || "refused");
    this.hookPath = hookPath;
    this.status = status;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

// PATH, HOME, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, ALPHACLAW_ROOT_DIR —
// and nothing else. Deliberately NOT derived from gatewayEnv().
// The hook runs as a root-installed program; like sudo's secure_path it gets
// a fixed system PATH, never the process's own — any writable directory on
// the inherited PATH would let a planted `bash`/`sh`/`node` shim run under a
// `#!/usr/bin/env …` shebang on every gateway launch.
const kGatewayPrelaunchHookPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const minimalHookEnv = () => ({
  PATH: kGatewayPrelaunchHookPath,
  HOME: kRootDir,
  OPENCLAW_STATE_DIR: OPENCLAW_DIR,
  OPENCLAW_CONFIG_PATH: `${OPENCLAW_DIR}/openclaw.json`,
  ALPHACLAW_ROOT_DIR: kRootDir,
});

const isPathInside = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

let prelaunchHookUnsetLogged = false;

const isGatewayPrelaunchHookConfigured = () =>
  Boolean(String(process.env[kGatewayPrelaunchHookEnvKey] || "").trim());

const noteGatewayPrelaunchHookUnset = () => {
  if (prelaunchHookUnsetLogged) return;
  prelaunchHookUnsetLogged = true;
  console.log(
    `[alphaclaw] gateway prelaunch hook: ${kGatewayPrelaunchHookEnvKey} unset — skipping`,
  );
};

// /proc/<pid>/fd/<fd> (the PARENT's pid, not /proc/self): Node opens every fd
// O_CLOEXEC, so a `#!` hook exec'ed as /proc/self/fd/<fd> fails with ENOENT
// when the interpreter reopens the path after exec (the fd is gone by then).
// The parent keeps the fd open until the hook exits, so the parent-pid path
// resolves for both ELF binaries and scripts (verified empirically).
const gatewayPrelaunchHookExecPath = ({ fd, realPath, platform, pid }) =>
  platform === "linux" ? `/proc/${pid}/fd/${fd}` : realPath;

const runGatewayPrelaunchHook = async ({
  hookPath = process.env[kGatewayPrelaunchHookEnvKey],
  rootDir = kRootDir,
  openclawDir = OPENCLAW_DIR,
  realpathSync = fs.realpathSync,
  lstatSync = fs.lstatSync,
  openSync = fs.openSync,
  fstatSync = fs.fstatSync,
  statSync = fs.statSync,
  closeSync = fs.closeSync,
  execFile: execFileImpl = execFile,
  platform = process.platform,
  pid = process.pid,
  env = minimalHookEnv(),
  timeoutMs = kGatewayPrelaunchHookTimeoutMs,
  graceMs = kGatewayPrelaunchHookGraceMs,
  killProcess = process.kill.bind(process),
} = {}) => {
  const configured = typeof hookPath === "string" ? hookPath.trim() : "";
  if (!configured) {
    noteGatewayPrelaunchHookUnset();
    return false;
  }
  const refuse = (message, code) =>
    new GatewayPrelaunchHookError(message, {
      code,
      hookPath: configured,
      status: "refused",
    });
  if (!path.isAbsolute(configured)) {
    throw refuse(
      `Gateway prelaunch hook path must be absolute: ${configured}`,
      "not_absolute",
    );
  }
  // The configured path is inspected BEFORE it is resolved: a symlink (or a
  // symlinked path component) the deployed agent can repoint at any root-owned
  // executable would otherwise pass every later check, because O_NOFOLLOW is
  // applied to the resolved target and never sees the link. The documented
  // boundary is "no symlinks", so the path must be canonical.
  let linkStat;
  try {
    linkStat = lstatSync(configured);
  } catch (error) {
    throw refuse(
      `Gateway prelaunch hook not found: ${configured} (${error.code || error.message})`,
      "not_found",
    );
  }
  if (typeof linkStat?.isSymbolicLink === "function" && linkStat.isSymbolicLink()) {
    throw refuse(`Gateway prelaunch hook must not be a symlink: ${configured}`, "symlink");
  }
  let realPath;
  try {
    realPath = realpathSync(configured);
  } catch (error) {
    throw refuse(
      `Gateway prelaunch hook not found: ${configured} (${error.code || error.message})`,
      "not_found",
    );
  }
  // Both roots are canonicalized too: a symlinked deployment root (say
  // /srv/current → /data/alphaclaw) would otherwise let a hook that physically
  // lives in the agent-writable tree pass the textual containment check.
  const canonicalDir = (dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  };
  for (const [label, dir] of [
    ["the AlphaClaw root", rootDir],
    ["the OpenClaw state dir", openclawDir],
  ]) {
    if (isPathInside(realPath, dir) || isPathInside(realPath, canonicalDir(dir))) {
      throw refuse(
        `Gateway prelaunch hook must live outside ${label} (${dir}); refusing ${realPath} — the deployed agent can write anywhere under the tree`,
        "in_tree",
      );
    }
  }
  // In-tree is reported first (the more specific refusal); everything else
  // must be canonical — a symlinked component anywhere in the path is refused.
  if (realPath !== configured) {
    throw refuse(
      `Gateway prelaunch hook path must be canonical (a symlinked component resolves ${configured} to ${realPath})`,
      "symlink",
    );
  }
  let fd;
  try {
    fd = openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw refuse(
      error.code === "ELOOP"
        ? `Gateway prelaunch hook must not be a symlink: ${realPath}`
        : `Gateway prelaunch hook could not be opened: ${realPath} (${error.code || error.message})`,
      error.code === "ELOOP" ? "symlink" : "open_failed",
    );
  }
  try {
    let stat;
    try {
      stat = fstatSync(fd);
    } catch (error) {
      throw refuse(
        `Gateway prelaunch hook could not be inspected: ${realPath} (${error.code || error.message})`,
        "check_failed",
      );
    }
    if (!stat.isFile()) {
      throw refuse(
        `Gateway prelaunch hook must be an executable regular file: ${realPath}`,
        "not_regular_file",
      );
    }
    if (stat.uid !== 0) {
      throw refuse(
        `Gateway prelaunch hook must be owned by root (uid 0), found uid ${stat.uid}: ${realPath}`,
        "not_root_owned",
      );
    }
    if ((stat.mode & 0o111) === 0) {
      throw refuse(
        `Gateway prelaunch hook must be an executable regular file: ${realPath}`,
        "not_executable",
      );
    }
    if ((stat.mode & 0o022) !== 0) {
      throw refuse(
        `Gateway prelaunch hook must not be group- or world-writable (mode ${(stat.mode & 0o777).toString(8)}): ${realPath}`,
        "writable_by_others",
      );
    }
    if (platform !== "linux") {
      // No fd-exec off Linux: re-stat the PATH and require the same inode the
      // fd inspection saw, so a swap between check and exec is refused.
      let pathStat;
      try {
        pathStat = statSync(realPath);
      } catch (error) {
        throw refuse(
          `Gateway prelaunch hook vanished before exec: ${realPath} (${error.code || error.message})`,
          "changed_during_check",
        );
      }
      if (pathStat.ino !== stat.ino || pathStat.dev !== stat.dev) {
        throw refuse(
          `Gateway prelaunch hook changed between inspection and exec: ${realPath}`,
          "changed_during_check",
        );
      }
    }
    const execPath = gatewayPrelaunchHookExecPath({ fd, realPath, platform, pid });
    console.log(`[alphaclaw] Running gateway prelaunch hook: ${realPath}`);
    // The hook gets its own process group (detached) so the hard deadline can
    // kill it AND anything it spawned; execFile's own timeout then covers the
    // well-behaved case and the outer timer the hostile one.
    const result = await new Promise((resolve) => {
      let settled = false;
      let hardTimer = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (hardTimer) clearTimeout(hardTimer);
        resolve(value);
      };
      const child = execFileImpl(
        execPath,
        [],
        {
          env,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          detached: platform !== "win32",
          encoding: "utf8",
          maxBuffer: kGatewayPrelaunchHookMaxBuffer,
        },
        (error, stdout, stderr) => settle({ error, stdout, stderr }),
      );
      hardTimer = setTimeout(() => {
        const childPid = child?.pid;
        if (childPid) {
          try {
            killProcess(-childPid, "SIGKILL");
          } catch {}
          try {
            killProcess(childPid, "SIGKILL");
          } catch {}
        }
        settle({
          error: Object.assign(
            new Error(
              `prelaunch hook did not exit within ${Math.round((timeoutMs + graceMs) / 1000)}s (process group killed)`,
            ),
            { killed: true },
          ),
          stdout: "",
          stderr: "",
        });
      }, timeoutMs + graceMs);
      hardTimer.unref?.();
    });
    for (const [stream, text] of [
      ["stdout", result.stdout],
      ["stderr", result.stderr],
    ]) {
      // Hooks read state/config and often run with shell tracing: token-,
      // key- and signed-URL-shaped values are redacted before the platform
      // log keeps them.
      const trimmed = redactSecretShapes(String(text ?? "").trim());
      if (trimmed) {
        console.log(
          `[alphaclaw] gateway prelaunch hook ${stream}: ${trimmed.slice(0, kGatewayPrelaunchHookOutputLogChars)}`,
        );
      }
    }
    if (result.error) {
      const { error } = result;
      const timedOut = Boolean(error.killed);
      const exitCode = typeof error.code === "number" ? error.code : null;
      const signal = error.signal || null;
      const code = timedOut
        ? "timeout"
        : exitCode !== null
          ? "nonzero_exit"
          : "exec_failed";
      const description = timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : exitCode !== null
          ? `exited with code ${exitCode}`
          : signal
            ? `was killed by ${signal}`
            : `could not be executed (${error.code || error.message})`;
      throw new GatewayPrelaunchHookError(
        `Gateway prelaunch hook ${description}: ${realPath}`,
        { code, hookPath: configured, status: "failed", exitCode, signal },
      );
    }
    return true;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
};

// Outcome seam for the watchdog/notifier (wired like the exit/launch
// handlers): { status: "ran"|"refused"|"failed", code, hookPath, message,
// site, durationMs, exitCode, signal }. Only invoked when a hook is
// configured; a handler throw is logged, never propagated into a launch.
let gatewayPrelaunchHookHandler = null;
let lastGatewayPrelaunchHookOutcome = null;

const setGatewayPrelaunchHookHandler = (handler) => {
  gatewayPrelaunchHookHandler = typeof handler === "function" ? handler : null;
};

const getLastGatewayPrelaunchHookOutcome = () => lastGatewayPrelaunchHookOutcome;

const reportGatewayPrelaunchHook = (outcome) => {
  lastGatewayPrelaunchHookOutcome = outcome;
  if (!gatewayPrelaunchHookHandler) return;
  try {
    gatewayPrelaunchHookHandler(outcome);
  } catch (err) {
    console.error(
      `[alphaclaw] Gateway prelaunch hook handler error: ${err.message}`,
    );
  }
};

// The ONE prelaunch step every launch path awaits (managed launch, cold
// restart, direct --force, in-place light restart). Throws
// GatewayPrelaunchHookError after reporting it — callers decide how to abort.
// Unset hook: resolves synchronously-cheap (no fs, no spawn) so an
// unconfigured box keeps today's launch timing exactly.
const prepareGatewayLaunch = async ({ site = "launch" } = {}) => {
  if (!isGatewayPrelaunchHookConfigured()) {
    noteGatewayPrelaunchHookUnset();
    // No hook gated THIS launch: a refused/failed outcome left over from an
    // earlier launch (before the operator unset the hook) must not read as
    // the cause of anything that happens to this one — the watchdog consults
    // getLastGatewayPrelaunchHookOutcome to tell a fail-closed hook abort
    // from a real configuration error.
    lastGatewayPrelaunchHookOutcome = null;
    return false;
  }
  const startedAt = Date.now();
  const hookPath = String(process.env[kGatewayPrelaunchHookEnvKey] || "").trim() || null;
  let ran;
  try {
    ran = await runGatewayPrelaunchHook();
  } catch (error) {
    if (!(error instanceof GatewayPrelaunchHookError)) throw error;
    console.error(`[alphaclaw] gateway ${site} aborted: ${error.message}`);
    reportGatewayPrelaunchHook({
      status: error.status,
      code: error.code,
      hookPath: error.hookPath ?? hookPath,
      message: error.message,
      site,
      durationMs: Date.now() - startedAt,
      exitCode: error.exitCode,
      signal: error.signal,
    });
    throw error;
  }
  if (ran) {
    reportGatewayPrelaunchHook({
      status: "ran",
      code: null,
      hookPath,
      message: null,
      site,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      signal: null,
    });
  }
  return ran;
};

// ── Shutdown cancellation ────────────────────────────────────────────────
// gateway.js is lock-free (call sites serialize via gateway-lifecycle-lock),
// so shutdown needs a module-level abort: flipping it cancels in-flight
// ready/stop waits (a 120s ready-wait must not outlive the shutdown
// deadline) and SIGTERMs in-flight openclaw CLI children via the shared
// AbortSignal below. One-way by design — this process is going down.
let gatewayWaitsAbortReason = null;
const gatewayAbortController = new AbortController();
const abortGatewayWaits = (reason = "shutdown") => {
  gatewayWaitsAbortReason = String(reason || "shutdown");
  try {
    gatewayAbortController.abort(new Error(gatewayWaitsAbortReason));
  } catch {}
};
const isGatewayWaitsAborted = () => gatewayWaitsAbortReason !== null;

// NODE_OPTIONS is inherited by every Node child. Memory flags sized for the
// admin process (e.g. --max-old-space-size set by the start script) must NOT
// leak to the gateway — the two processes need separate heap budgets or they
// jointly overrun the container.
//
// POLICY (issue #24): the strip is unconditional — alphaclaw cannot tell a
// deliberate gateway cap from a stale admin-process value inside one shared
// NODE_OPTIONS. The sanctioned way to cap the gateway heap is the explicit
// ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE env var (MB), applied by
// gatewayLaunchEnv() to the long-running daemon only. Stripping is also no
// longer silent: warnStrippedNodeMemoryFlags names the dropped tokens once
// per distinct set — without a cap, Node sizes its default heap from host
// RAM (~49 GB observed on a 123 GB box), so a silently-discarded 8 GB cap
// RAISES the ceiling ~6x.
const stripNodeMemoryFlags = (nodeOptions) => {
  const tokens = String(nodeOptions || "").split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (/^--max-(old|semi)-space-size(=|$)/.test(tokens[i])) {
      // Space-separated form carries its value as the NEXT token — drop both
      // (a stranded bare number would abort the child's Node startup).
      if (!tokens[i].includes("=") && /^\d+$/.test(tokens[i + 1] || "")) i += 1;
      continue;
    }
    kept.push(tokens[i]);
  }
  return kept.join(" ");
};

// External supervision (OPENCLAW_SUPERVISOR_MODE=external) is applied by
// withOpenclawStartupEnv below: AlphaClaw owns the gateway lifecycle (launch,
// watchdog restarts, rollback restarts), so a beta gateway must skip its
// internal self-restart supervisor and defer to us. It defaults ON — a
// harmless no-op on stable, load-bearing on 2026.8.1+ — with an
// OPENCLAW_SUPERVISOR_MODE=off|none escape hatch that neutralizes both
// supervisor variables (see openclaw-runtime-env.js). The verified
// restart-handoff contract lives in lib/server/gateway-restart-handoff.js
// (full contract: docs/designs/openclaw-context-contract.md, lifecycle
// appendix); the watchdog consumes it on unmanaged clean exits.

// Gate for the watchdog's restart-handoff consume: mirrors the exact
// supervisor-mode resolution the gateway env gets (default ON, off|none
// escape hatch), so the consume is skipped precisely when the gateway was
// told NOT to defer restarts to us — an escape-hatched gateway writes no
// handoff rows.
const isSupervisorModeActive = (env = process.env) =>
  resolveOpenclawSupervisorMode(env) !== null;

const gatewayEnv = () => {
  const env = withOpenclawStartupEnv(
    // Team mode swaps the gateway to trusted-proxy auth, which refuses to
    // start when OPENCLAW_GATEWAY_TOKEN is set; applyGatewayAuthEnv drops the
    // token and provides OPENCLAW_GATEWAY_PASSWORD for internal callers
    // (openclaw CLI included). No-op while gateway auth is token-based.
    applyGatewayAuthEnv({
      ...process.env,
      HOME: kRootDir,
      OPENCLAW_HOME: kRootDir,
      OPENCLAW_CONFIG_PATH: `${OPENCLAW_DIR}/openclaw.json`,
      OPENCLAW_STATE_DIR: OPENCLAW_DIR,
      XDG_CONFIG_HOME: OPENCLAW_DIR,
      // Versions are managed by AlphaClaw's release-channel system; the gateway
      // (or the agent running inside it) must never self-update out from under
      // the recorded channel state.
      OPENCLAW_NO_AUTO_UPDATE: "1",
    }),
  );
  if (env.NODE_OPTIONS) {
    const filtered = stripNodeMemoryFlags(env.NODE_OPTIONS);
    warnStrippedNodeMemoryFlags(env.NODE_OPTIONS, filtered);
    if (filtered) env.NODE_OPTIONS = filtered;
    else delete env.NODE_OPTIONS;
  }
  // Autotune: the strip above removed the ADMIN process's heap budget; this
  // installs the GATEWAY's own computed one. Null (autotune off, suppressed,
  // or any internal error) leaves the env exactly as today.
  try {
    const { getGatewayNodeOptionsSuffix } = require("./autotune");
    const heapSuffix = getGatewayNodeOptionsSuffix();
    if (heapSuffix) {
      env.NODE_OPTIONS = [env.NODE_OPTIONS, heapSuffix]
        .filter(Boolean)
        .join(" ");
    }
  } catch {}
  // The Claude Code launcher config lets its holder start autonomous, billable
  // Claude Code cloud runs on the operator's personal claude.ai account. The
  // gateway (and the agent inside it) has no legitimate use for either the
  // token or the routine URL, so both are excluded from the child env
  // explicitly rather than waiting on the broader process.env-spread allowlist
  // rewrite (TODOS.md P1).
  delete env.CLAUDE_CODE_ROUTINE_TOKEN;
  delete env.CLAUDE_CODE_ROUTINE_URL;
  // Final gate (TODOS P1): the derivations above need the full env (autotune
  // kill-switch, auth, NODE_OPTIONS), so filtering happens LAST — an explicit
  // allowlist replaces the old full process.env spread, so the gateway child
  // and every `openclaw` CLI spawn no longer inherit SETUP_PASSWORD, webhook/
  // platform secrets, or AlphaClaw internals. Pure object ops, never throws.
  return filterGatewayChildEnv(env);
};

// gatewayEnv() runs on every spawn/status path — warn once per distinct
// stripped-flag set, not per call.
let lastStrippedFlagsSignature = null;
const warnStrippedNodeMemoryFlags = (original, filtered) => {
  if (original === (filtered || "")) return;
  const originalTokens = String(original || "").split(/\s+/).filter(Boolean);
  const keptTokens = new Set(String(filtered || "").split(/\s+/).filter(Boolean));
  const dropped = originalTokens.filter((token) => !keptTokens.has(token));
  const signature = dropped.join(" ");
  if (!signature || signature === lastStrippedFlagsSignature) return;
  lastStrippedFlagsSignature = signature;
  console.warn(
    `[alphaclaw] Stripped Node memory flag(s) from the gateway/CLI child NODE_OPTIONS: ${signature} — the two processes need separate heap budgets. To cap the gateway heap, set ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE=<MB> instead.`,
  );
};

// Env for the LONG-RUNNING gateway daemon only (issue #24): applies the
// operator's explicit heap cap. Deliberately not part of gatewayEnv(), which
// is also the env for every short-lived openclaw CLI child — capping those
// would starve one-shot commands for no benefit. In-gateway restarts
// (supervisor-mode handoff) re-exec with the daemon's own env, so the cap
// survives them.
const gatewayLaunchEnv = () => {
  const env = gatewayEnv();
  const capMb = parsePositiveInt(
    process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE,
    0,
  );
  if (capMb > 0) {
    const capFlag = `--max-old-space-size=${capMb}`;
    env.NODE_OPTIONS = env.NODE_OPTIONS
      ? `${env.NODE_OPTIONS} ${capFlag}`
      : capFlag;
  }
  return env;
};

const resolveOpenclawExtensionsDir = () => {
  try {
    const entryPath = require.resolve("openclaw");
    const entryDir = path.dirname(entryPath);
    const distDir =
      path.basename(entryDir) === "dist" ? entryDir : path.join(entryDir, "dist");
    return path.join(distDir, "extensions");
  } catch {
    return "";
  }
};

const isOpenclawInstallStageDir = (name) =>
  name === ".openclaw-install-stage" ||
  String(name || "").startsWith(".openclaw-install-stage-");

const cleanupOpenclawPluginInstallStages = ({
  extensionsDir = resolveOpenclawExtensionsDir(),
} = {}) => {
  if (!extensionsDir) return 0;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry?.isDirectory?.()) continue;
      const pluginDir = path.join(extensionsDir, entry.name);
      for (const child of fs.readdirSync(pluginDir, { withFileTypes: true })) {
        if (!child?.isDirectory?.() || !isOpenclawInstallStageDir(child.name)) {
          continue;
        }
        const stageDir = path.join(pluginDir, child.name);
        fs.rmSync(stageDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
        removed += 1;
        console.log(`[alphaclaw] Removed stale OpenClaw plugin install stage: ${stageDir}`);
      }
    }
  } catch (err) {
    console.warn(
      `[alphaclaw] Could not clean OpenClaw plugin install stages: ${err.message}`,
    );
  }
  return removed;
};

const hasEnabledChannelConfig = () => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    if (!fs.existsSync(configPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const channels = cfg?.channels && typeof cfg.channels === "object" ? cfg.channels : {};
    return Object.keys(kChannelDefs).some((channel) => channels?.[channel]?.enabled === true);
  } catch {
    return false;
  }
};

const isInstallStageFailure = (err) =>
  /ENOTEMPTY|openclaw-install-stage/i.test(
    [
      err?.message,
      err?.stdout?.toString?.(),
      err?.stderr?.toString?.(),
    ]
      .filter(Boolean)
      .join("\n"),
  );

// execFile failures embed the full argv in error.message ("Command failed:
// openclaw channels add ... --bot-token xoxb-..."), and the CLI may echo
// token values to stdout/stderr. Anything logged from these results lands in
// process.log, which /api/watchdog/logs serves — scrub every value that
// followed a secret-bearing flag before callers can log it.
const kSecretFlagPattern = /token|secret|password|api-?key/i;
const collectSecretArgValues = (args) => {
  const secrets = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string" || !arg) continue;
    // --secret-flag=value form
    const eqMatch = arg.match(/^(--[^=]+)=(.+)$/);
    if (eqMatch && kSecretFlagPattern.test(eqMatch[1])) {
      secrets.push(eqMatch[2]);
      continue;
    }
    // --secret-flag value form
    if (
      i > 0 &&
      typeof args[i - 1] === "string" &&
      args[i - 1].startsWith("--") &&
      !args[i - 1].includes("=") &&
      kSecretFlagPattern.test(args[i - 1])
    ) {
      secrets.push(arg);
    }
  }
  return secrets;
};
const scrubSecrets = (text, secrets) =>
  secrets.reduce((acc, secret) => acc.split(secret).join("[redacted]"), text);

// Channel CLI runner: tokens ride as execFile ARGUMENTS (never a shell
// string), and every string field a caller could plausibly forward to a
// logger (message/cmd/stack plus captured stdout/stderr) is scrubbed before
// the error propagates.
const execChannelCmd = async (args) => {
  const secrets = collectSecretArgValues(args);
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", args, {
      env: gatewayEnv(),
      timeout: 15000,
      encoding: "utf8",
      signal: gatewayAbortController.signal,
    });
    return {
      stdout: scrubSecrets(stdout, secrets),
      stderr: scrubSecrets(stderr, secrets),
    };
  } catch (error) {
    if (secrets.length) {
      for (const field of ["message", "cmd", "stack", "stdout", "stderr"]) {
        if (typeof error[field] === "string") {
          error[field] = scrubSecrets(error[field], secrets);
        }
      }
    }
    throw error;
  }
};

// The preflight boots the full OpenClaw CLI (up to 120s on cold volumes). It
// must never run synchronously: the boot sequence and restarts call this, and
// a blocking spawn here froze the whole server for the duration.
const runPluginRuntimeDepsPreflight = () =>
  execFileAsync("openclaw", ["plugins", "list", "--json"], {
    env: gatewayEnv(),
    timeout: kPluginRuntimeDepsPreflightTimeoutMs,
    encoding: "utf8",
    // Shutdown SIGTERMs an in-flight preflight instead of waiting it out.
    signal: gatewayAbortController.signal,
  });

// Desired plugin state: the preflight only matters when the enabled-channel
// set or the installed OpenClaw version changed. Skipping it on a match is
// the difference between seconds and minutes of restart downtime.
let lastPreflightSuccessHash = null;

const readInstalledOpenclawVersion = () => {
  try {
    const entryDir = path.dirname(require.resolve("openclaw"));
    const pkgDir =
      path.basename(entryDir) === "dist" ? path.dirname(entryDir) : entryDir;
    const pkg = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
    );
    return String(pkg.version || "");
  } catch {
    return "";
  }
};

const computeDesiredPluginStateHash = () => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const channels = cfg?.channels && typeof cfg.channels === "object" ? cfg.channels : {};
    const enabled = Object.keys(kChannelDefs)
      .filter((channel) => channels?.[channel]?.enabled === true)
      .sort();
    if (enabled.length === 0) return null;
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({ enabled, version: readInstalledOpenclawVersion() }),
      )
      .digest("hex");
  } catch {
    return null;
  }
};

const prepareOpenclawChannelPlugins = async () => {
  if (!hasEnabledChannelConfig()) return { skipped: true };
  const desiredHash = computeDesiredPluginStateHash();
  if (desiredHash && desiredHash === lastPreflightSuccessHash) {
    return { skipped: true };
  }
  cleanupOpenclawPluginInstallStages();
  try {
    await runPluginRuntimeDepsPreflight();
    lastPreflightSuccessHash = desiredHash;
    return { skipped: false };
  } catch (err) {
    if (!isInstallStageFailure(err)) {
      console.warn(
        `[alphaclaw] OpenClaw plugin preflight failed: ${(err.stderr || err.message || "").toString().trim().slice(0, 300)}`,
      );
      return { skipped: false, failed: true };
    }
    cleanupOpenclawPluginInstallStages();
    try {
      await runPluginRuntimeDepsPreflight();
      lastPreflightSuccessHash = desiredHash;
      console.log("[alphaclaw] OpenClaw plugin preflight recovered after cleaning install stage");
      return { skipped: false };
    } catch (retryErr) {
      console.warn(
        `[alphaclaw] OpenClaw plugin preflight retry failed: ${(retryErr.stderr || retryErr.message || "").toString().trim().slice(0, 300)}`,
      );
      return { skipped: false, failed: true };
    }
  }
};

const writeOnboardingMarker = (reason) => {
  fs.mkdirSync(ALPHACLAW_DIR, { recursive: true });
  fs.writeFileSync(
    kOnboardingMarkerPath,
    JSON.stringify(
      {
        onboarded: true,
        reason,
        markedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
};

// Legacy backfill: older deployments may only have the control-ui skill as
// proof of onboarding (before the dedicated marker file existed).
const kLegacyControlUiSkillPath = path.join(OPENCLAW_DIR, "skills", "control-ui", "SKILL.md");

const isOnboarded = () => {
  if (fs.existsSync(kOnboardingMarkerPath)) return true;
  if (fs.existsSync(kLegacyControlUiSkillPath)) {
    writeOnboardingMarker("legacy_artifact_backfill");
    return true;
  }
  return false;
};

// openclaw.json is consulted several times per status sample (port probe,
// channel status, channel summary). Memoize the parsed config briefly so one
// snapshot never re-parses an unchanged file; writers below always read
// fresh. Keyed on the fs function identities so test-injected fs mocks
// invalidate the memo automatically.
let openclawConfigMemo = { at: 0, readFn: null, existsFn: null, config: null };
const openclawConfigMemoTtlMs = 1500;
const invalidateOpenclawConfigMemo = () => {
  openclawConfigMemo = { at: 0, readFn: null, existsFn: null, config: null };
};

const readOpenclawConfigCached = () => {
  const now = Date.now();
  const configPath = `${OPENCLAW_DIR}/openclaw.json`;
  // Validate the memo by mtime, not just TTL: openclaw.json is rewritten by
  // EXTERNAL writers too (the openclaw CLI, the gateway itself, operators),
  // which the in-module invalidation can't see — and a stale port here
  // misroutes every proxied request until the TTL lapses. A statSync is
  // microseconds; the memo only exists to skip the JSON.parse.
  if (
    openclawConfigMemo.config !== null &&
    openclawConfigMemo.readFn === fs.readFileSync &&
    openclawConfigMemo.existsFn === fs.existsSync &&
    now - openclawConfigMemo.at < openclawConfigMemoTtlMs
  ) {
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync?.(configPath)?.mtimeMs ?? null;
    } catch {
      mtimeMs = null; // vanished — fall through to the fresh read below
    }
    if (mtimeMs !== null && mtimeMs === openclawConfigMemo.mtimeMs) {
      return openclawConfigMemo.config;
    }
  }
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync?.(configPath)?.mtimeMs ?? null;
  } catch {}
  openclawConfigMemo = {
    at: now,
    mtimeMs,
    readFn: fs.readFileSync,
    existsFn: fs.existsSync,
    config,
  };
  return config;
};

const getGatewayPort = () => {
  try {
    const cfg = readOpenclawConfigCached();
    if (!cfg) return kDefaultGatewayPort;
    const parsedPort = Number.parseInt(String(cfg?.gateway?.port || ""), 10);
    return parsedPort > 0 ? parsedPort : kDefaultGatewayPort;
  } catch {
    return kDefaultGatewayPort;
  }
};

const getGatewayUrl = () => `http://${GATEWAY_HOST}:${getGatewayPort()}`;

// One shared TCP probe for every consumer (status snapshot, watchdog
// watcher): a single recorded observation means no double connects and no
// split-brain between two probers within the same second, and up↔down
// transitions fire an event so the watchdog re-probes health immediately
// instead of waiting out its timer.
let gatewayTcpObservation = { running: null, observedAt: 0 };
let gatewayTcpTransitionHandler = null;

const setGatewayTcpTransitionHandler = (handler) => {
  gatewayTcpTransitionHandler = typeof handler === "function" ? handler : null;
};

const getGatewayTcpObservation = () => gatewayTcpObservation;

const probeGatewayTcp = async () => {
  const running = await isGatewayRunning();
  const previous = gatewayTcpObservation.running;
  gatewayTcpObservation = { running, observedAt: Date.now() };
  if (previous !== null && previous !== running && gatewayTcpTransitionHandler) {
    try {
      gatewayTcpTransitionHandler({ running });
    } catch (err) {
      console.error(
        `[alphaclaw] gateway tcp transition handler error: ${err.message}`,
      );
    }
  }
  return gatewayTcpObservation;
};

const isGatewayRunning = () =>
  new Promise((resolve) => {
    const sock = net.createConnection(getGatewayPort(), GATEWAY_HOST);
    sock.setTimeout(1000);
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForGatewayReady = async ({
  timeoutMs = kGatewayRestartReadyTimeoutMs,
  shouldAbort = null,
} = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // Two abort sources compose: the caller's local predicate (e.g. a spawn
    // failure) and the module-level shutdown flag — without the latter,
    // shutdown would wait out the full 120s ready window and the shutdown
    // deadline would hard-exit mid-drain.
    if (isGatewayWaitsAborted() || shouldAbort?.()) return false;
    if (await isGatewayRunning()) return true;
    await sleep(kGatewayRestartReadyPollMs);
  }
  return false;
};

const logGatewayCmdOutput = (cmd, e) => {
  if (e?.stdout?.trim()) {
    console.log(`[alphaclaw] gateway ${cmd} stdout: ${e.stdout.trim()}`);
  }
  if (e?.stderr?.trim()) {
    console.log(`[alphaclaw] gateway ${cmd} stderr: ${e.stderr.trim()}`);
  }
  if (!e?.stdout?.trim() && !e?.stderr?.trim()) {
    console.log(`[alphaclaw] gateway ${cmd} error: ${e.message}`);
  }
  // execSync errors carry .status; execFile errors carry .code.
  const exitCode = e?.status ?? e?.code;
  if (exitCode !== undefined && exitCode !== null) {
    console.log(`[alphaclaw] gateway ${cmd} exit code: ${exitCode}`);
  }
};

// ── Capability-gated `gateway stop --force` ──────────────────────────────
// The OpenClaw CLI (2026.8.2+) refuses a non-interactive `gateway stop`
// without --force ("This stops the operator's running gateway service…
// re-run with --force", exit 1) — every managed stop here is non-interactive.
// The pin (2026.7.1-2) has no --force at all, so the flag is PROBED per
// installed version (openclaw-capabilities.js gatewayStopForce), never
// assumed. lib/server.js may inject its shared capabilities instance via
// setGatewayCapabilities; otherwise a local instance is built lazily on the
// same clawCmd shape — a require cycle is avoided because the capabilities
// module does not depend on this one.
const kNonInteractiveStopRefusalPattern = /re-run with --force/i;
let gatewayCapabilities = null;

const setGatewayCapabilities = (capabilities) => {
  gatewayCapabilities =
    capabilities && typeof capabilities.get === "function" ? capabilities : null;
};

// `abortable:false` omits the module-level abort signal (shutdown path only,
// see isGatewayStopForceSupported): once abortGatewayWaits has fired, execFile
// with the aborted signal never spawns — it rejects with AbortError at once —
// so an abortable probe on the shutdown path could only ever answer "unknown".
const gatewayCliCmd = async (
  cmd,
  { timeoutMs = kGatewayShortCmdTimeoutMs, abortable = true } = {},
) => {
  const args = String(cmd).split(" ").filter(Boolean);
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", args, {
      env: gatewayEnv(),
      timeout: timeoutMs,
      encoding: "utf8",
      ...(abortable ? { signal: gatewayAbortController.signal } : {}),
    });
    return { ok: true, stdout, stderr, code: 0, timedOut: false };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e?.stdout ?? ""),
      stderr: String(e?.stderr ?? ""),
      code: typeof e?.code === "number" ? e.code : null,
      timedOut: Boolean(e?.killed),
    };
  }
};

const getGatewayCapabilities = () => {
  if (!gatewayCapabilities) {
    gatewayCapabilities = createOpenclawCapabilities({
      clawCmd: (cmd, opts) => gatewayCliCmd(cmd, opts),
      getInstalledVersion: readInstalledOpenclawVersion,
    });
  }
  return gatewayCapabilities;
};

// Cached determinate answers (supported/unsupported for the installed version)
// are served without a spawn. A cold or "unknown" cache probes `gateway stop
// --help`. The shutdown stop passes { abortable:false, timeoutMs } so that
// probe (a) is not pre-killed by the already-fired module abort — the
// externally-supervised gateway population the shutdown CLI stop exists for is
// exactly the one whose boot warm-up was skipped ("already running") — and (b)
// fits the shutdown stop's own budget instead of the probe's 10s default.
// Both are threaded through the capabilities layer as per-call clawCmd
// options; the cache is consulted first either way.
const isGatewayStopForceSupported = async ({
  abortable = true,
  timeoutMs = null,
} = {}) => {
  try {
    const cmdOpts = {
      ...(abortable ? {} : { abortable: false }),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    const capabilities = getGatewayCapabilities();
    const answer =
      Object.keys(cmdOpts).length > 0
        ? await capabilities.get("gatewayStopForce", { cmdOpts })
        : await capabilities.get("gatewayStopForce");
    return answer === "supported";
  } catch (error) {
    console.warn(
      `[alphaclaw] gateway stop --force capability probe failed: ${String(error?.message || error)}`,
    );
    return false;
  }
};

// Every managed short lifecycle command (stop above all) returns its outcome
// instead of swallowing it: { ok, exitCode, refused, forced, timedOut,
// stdout, stderr }. `refused` = the CLI's non-interactive stop guard fired
// (the incident class where a restart recorded "succeeded" over a gateway
// that was never stopped). `abortable:false` is for the shutdown path, whose
// module-level abort has already fired — it applies to the --force capability
// probe this stop consults as well as to the stop itself.
const runGatewayShortCmd = async (
  cmd,
  { timeoutMs = kGatewayShortCmdTimeoutMs, abortable = true } = {},
) => {
  // Multi-word commands ride as separate argv entries (never a shell string).
  const args = ["gateway", ...String(cmd).split(" ").filter(Boolean)];
  let forced = false;
  const startedAt = Date.now();
  if (args[1] === "stop" && !args.includes("--force")) {
    // Non-abortable = the shutdown path: probe + CLI stop must BOTH fit the
    // caller's budget, so a cold probe gets a short slice and the stop keeps
    // the remainder (a 5 s probe followed by a 5 s stop would outlive the
    // 10 s process shutdown deadline and leave the old gateway on the port).
    const forceSupported = await isGatewayStopForceSupported(
      abortable
        ? {}
        : {
            abortable: false,
            timeoutMs: Math.min(timeoutMs, kGatewayShutdownProbeTimeoutMs),
          },
    );
    if (forceSupported) {
      args.push("--force");
      forced = true;
    }
  }
  const stopTimeoutMs = abortable
    ? timeoutMs
    : Math.max(kGatewayShutdownStopMinMs, timeoutMs - (Date.now() - startedAt));
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", args, {
      env: gatewayEnv(),
      timeout: stopTimeoutMs,
      encoding: "utf8",
      ...(abortable ? { signal: gatewayAbortController.signal } : {}),
    });
    if (stdout.trim()) console.log(`[alphaclaw] ${stdout.trim()}`);
    return {
      ok: true,
      exitCode: 0,
      refused: false,
      forced,
      timedOut: false,
      stdout,
      stderr,
    };
  } catch (e) {
    logGatewayCmdOutput(cmd, e);
    const stdout = String(e?.stdout ?? "");
    const stderr = String(e?.stderr ?? "");
    const refused = kNonInteractiveStopRefusalPattern.test(`${stdout}\n${stderr}`);
    if (refused) {
      console.warn(
        `[alphaclaw] gateway ${cmd} REFUSED by the OpenClaw CLI (non-interactive guard; --force ${forced ? "was passed" : "is not supported by the installed OpenClaw"}) — the gateway was not stopped by this command`,
      );
    }
    const exitCode =
      typeof e?.code === "number"
        ? e.code
        : typeof e?.status === "number"
          ? e.status
          : null;
    return {
      ok: false,
      exitCode,
      refused,
      forced,
      timedOut: Boolean(e?.killed),
      stdout,
      stderr,
    };
  }
};

// In-place recycle via the gateway's own lifecycle command — used by the
// light restart path when the gateway is already up (no plugin preflight, no
// cold-start stop/force pipeline).
const runGatewayLifecycleRestart = async () => {
  console.log("[alphaclaw] Running: openclaw gateway restart");
  try {
    const { stdout } = await execFileAsync("openclaw", ["gateway", "restart"], {
      env: gatewayEnv(),
      timeout: kGatewayLifecycleCmdTimeoutMs,
      encoding: "utf8",
      signal: gatewayAbortController.signal,
    });
    if (stdout.trim()) console.log(`[alphaclaw] ${stdout.trim()}`);
    // The recycled gateway re-read openclaw.json (concurrency now live) but
    // kept its original env — flip config rows only, never env rows.
    try {
      require("./autotune").stampOpenclawConfigConsumed();
    } catch {}
    return true;
  } catch (e) {
    logGatewayCmdOutput("restart", e);
    return false;
  }
};

const hasActiveManagedGatewayChild = () =>
  !!(
    gatewayChild &&
    gatewayChild.exitCode === null &&
    !gatewayChild.killed
  );

// A restart that never becomes ready is a FAILURE the caller must see —
// evidence attached. Previously this path logged a console.warn and returned
// normally, and the UI toasted "Gateway restarted" over a dead gateway.
class GatewayRestartError extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = "GatewayRestartError";
    this.evidence = evidence;
  }
}

// The incumbent verdict is a FAILURE thrown like every other never-restarted
// outcome. "Ready" came from the OLD gateway (stop refused/ignored, port never
// released, pre-restart pids still alive — assessRestartIncumbent below), so
// the env/config the caller restarted for is NOT live. Every restartGateway()
// caller — the manual route, channel connect/delete, team transitions, the
// memory mitigation — relies on the contract "restartGateway THROWS when the
// gateway did not restart"; an earlier iteration RETURNED { ok:false,
// incumbent:true } and every caller but the route read it as success (the #54
// class: "op recorded succeeded" over a gateway that never restarted). A
// subclass, so `instanceof GatewayRestartError` catches keep matching, with
// the verdict carried explicitly: incumbent:true, reason, detail, evidence.
const kGatewayIncumbentRestartReason = "incumbent_gateway_still_running";
class GatewayIncumbentRestartError extends GatewayRestartError {
  constructor(detail, evidence = {}) {
    super(
      `Gateway restart did not take effect — ${detail || "the previous gateway is still running"}`,
      evidence,
    );
    this.name = "GatewayIncumbentRestartError";
    this.code = "restart_incumbent";
    this.reason = kGatewayIncumbentRestartReason;
    this.incumbent = true;
    this.detail = detail || null;
  }
}

// Live openclaw GATEWAY pids (managed child, external `gateway run`, a
// `gateway --force` supervisor) from the read-only /proc scan in
// openclaw-lock-contention.js. [] off Linux / unreadable /proc — evidence
// then rests on the port observation alone. Never on the 2s status tick.
//
// The gateway pattern is applied INSIDE the scan (before its cap) and the
// snapshot is uncapped: the default 12-entry cap over every openclaw-ish
// process (in ascending-pid order) would drop the newest pids on a busy host
// — the just-spawned supervisor/gateway — and a missing new pid records a
// successful swap as incumbent_gateway_still_running, while a missing
// SURVIVING pid would be a false success. A pid verdict can afford neither.
const kGatewayProcessPattern = /(^|\s)gateway(\s|$)|openclaw-gateway/;
const isGatewayCmdline = (cmdline) => kGatewayProcessPattern.test(String(cmdline || ""));
const listGatewayPids = () => {
  try {
    return lockContention
      .listLiveOpenclawProcesses({
        match: (argv) => isGatewayCmdline(argv.join(" ")),
        limit: Infinity,
      })
      // Re-filter over the returned cmdline: the scan's `match` runs on the
      // full argv, the snapshot must stay gateway-only whatever the scan gave.
      .filter((proc) => isGatewayCmdline(proc.cmdline))
      .map((proc) => proc.pid);
  } catch {
    return [];
  }
};

// Incumbent verdict for a cold restart (pure over the two snapshots). "Ready"
// after a restart is only success when the OLD gateway is actually gone:
//   (stopConfirmed ∨ ¬wasRunningBefore ∨ pidReplacement) ∧ (new gateway pid ∨ every pre-stop pid gone)
// where pidReplacement = we had pre-stop pids, none survived, and a NEW pid
// answers — an external supervisor that swapped the process between two
// 500 ms port polls never shows a "port down" sample, yet the old gateway is
// provably gone. Otherwise the port that answered belongs to the incumbent
// the CLI refused to stop (or that ignored the stop), and reporting success
// would flip the restart-required banner over a gateway still running the
// OLD env/config.
const assessRestartIncumbent = ({ stopEvidence, postReadyPids = [], supervisorPid = null }) => {
  const preStopPids = Array.isArray(stopEvidence?.preStopPids)
    ? stopEvidence.preStopPids
    : [];
  const pre = new Set(preStopPids);
  const newPids = postReadyPids.filter((pid) => !pre.has(pid));
  const survivingPids = postReadyPids.filter((pid) => pre.has(pid));
  const stopConfirmed = stopEvidence?.stopConfirmed === true;
  const wasRunningBefore = stopEvidence?.wasRunningBefore === true;
  const pidReplacement =
    preStopPids.length > 0 && survivingPids.length === 0 && newPids.length > 0;
  const stopSatisfied = stopConfirmed || !wasRunningBefore || pidReplacement;
  const pidSatisfied = newPids.length > 0 || survivingPids.length === 0;
  const evidence = {
    wasRunningBefore,
    stopConfirmed,
    pidReplacement,
    cliRefused: stopEvidence?.cliRefused === true,
    cliExitCode: stopEvidence?.cliExitCode ?? null,
    cliForced: stopEvidence?.cliForced === true,
    managedChildPid: stopEvidence?.managedChildPid ?? null,
    preStopPids,
    postReadyPids,
    newPids,
    survivingPids,
    supervisorPid,
  };
  if (stopSatisfied && pidSatisfied) return { ok: true, evidence, detail: null };
  const reasons = [];
  if (!stopSatisfied) {
    reasons.push(
      `the gateway port never released after stop${
        evidence.cliRefused
          ? " (the OpenClaw CLI refused the non-interactive stop)"
          : evidence.cliExitCode
            ? ` (openclaw gateway stop exited ${evidence.cliExitCode})`
            : ""
      }`,
    );
  }
  if (!pidSatisfied) {
    reasons.push(
      `${survivingPids.length} pre-restart gateway process(es) still alive (pid ${survivingPids.join(", ")}) and no new gateway process observed`,
    );
  }
  return {
    ok: false,
    evidence,
    detail: `the previous gateway is still running: ${reasons.join("; ")}`,
  };
};

const runGatewayRestartCmd = async (
  cmd,
  { onStep = null, stopEvidence = null } = {},
) => {
  // A restart cancelled by shutdown must never spawn a fresh supervisor.
  if (isGatewayWaitsAborted()) {
    throw new GatewayRestartError(
      `Gateway ${cmd} aborted: ${gatewayWaitsAbortReason}`,
      { aborted: true, reason: gatewayWaitsAbortReason },
    );
  }
  const startedAt = Date.now();
  let supervisorExit = null;
  let supervisorSpawnError = null;
  // Evidence honesty: fresh per-attempt tails mean the evidence only ever
  // contains THIS attempt's output — never leftovers from a previous launch.
  // stdout gets its OWN ring (not merged with stderr): noisy stdout must not
  // evict the stderr crash cause, and upstream may print blocking-state
  // messages (e.g. the state-lifecycle lock wait) to stdout.
  const stderrTail = createStderrTail();
  const stdoutTail = createStderrTail();
  onStep?.({ step: "launching", status: "running" });
  const restartChildEnv = gatewayEnv();
  const child = spawn("openclaw", ["gateway", cmd], {
    env: restartChildEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    stdoutTail.append(d);
    process.stdout.write(`[gateway] ${d}`);
  });
  child.stderr.on("data", (d) => {
    stderrTail.append(d);
    process.stderr.write(`[gateway] ${d}`);
  });
  child.on("exit", (code, signal) => {
    supervisorExit = { code: code ?? null, signal: signal ?? null };
    console.log(
      `[alphaclaw] gateway ${cmd} supervisor exited: code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`,
    );
  });
  // Without a listener, a spawn failure (binary missing mid-apply, EACCES)
  // emits an unhandled 'error' event and kills the whole server. Record it
  // as evidence and fail the ready-wait fast instead of burning the budget.
  child.on("error", (error) => {
    supervisorSpawnError = error;
    supervisorExit = supervisorExit || { code: null, signal: null };
    stderrTail.append(`gateway supervisor spawn error: ${error.message}\n`);
  });

  // A supervisor that spawn-failed or exited non-zero (or via signal) is
  // terminally dead — burning the remaining ready budget on it just delays
  // the failure the operator needs to see. Exit code 0 is NOT failure: the
  // supervisor daemonizes and may legitimately exit before the port answers.
  const supervisorFailed = () =>
    !!supervisorSpawnError ||
    (supervisorExit !== null && supervisorExit.code !== 0);

  onStep?.({ step: "waiting_ready", status: "running", budgetMs: kGatewayRestartReadyTimeoutMs });
  let ready = await waitForGatewayReady({
    timeoutMs: kGatewayRestartReadyTimeoutMs,
    shouldAbort: supervisorFailed,
  });
  if (!ready && supervisorFailed() && !isGatewayWaitsAborted()) {
    // One final probe before failing fast: a healthy incumbent still holding
    // the port, or a gateway that came up just as its supervisor died, must
    // not be classified as a failed restart.
    ready = await isGatewayRunning();
  }
  if (!ready && isGatewayWaitsAborted()) {
    // Shutdown cancelled the wait: reap the supervisor (escalating to SIGKILL
    // if the CLI traps/delays SIGTERM — a lingering supervisor can hold the
    // gateway port past the successor process's EADDRINUSE retry window) and
    // fail the operation without the stop-CLI round trip.
    try {
      child.kill("SIGTERM");
    } catch {}
    const killTimer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {}
    }, 3000);
    if (typeof killTimer.unref === "function") killTimer.unref();
    throw new GatewayRestartError(
      `Gateway ${cmd} aborted: ${gatewayWaitsAbortReason}`,
      {
        aborted: true,
        reason: gatewayWaitsAbortReason,
        stderrTail: stderrTail.snapshot(),
        stdoutTail: stdoutTail.snapshot(),
        supervisorExit,
      },
    );
  }
  if (ready) {
    // "Ready" is not yet "restarted": with stop evidence (the cold-start
    // path) the port must have been observed down, or a new gateway pid must
    // have appeared with the pre-stop ones gone — else the incumbent answered
    // and this is an HONEST failure (no autotune stamp, no launch notice).
    if (stopEvidence) {
      const verdict = assessRestartIncumbent({
        stopEvidence,
        postReadyPids: listGatewayPids(),
        supervisorPid: child.pid ?? null,
      });
      if (!verdict.ok) {
        console.warn(
          `[alphaclaw] Gateway ${cmd} did NOT take effect — ${verdict.detail}`,
        );
        onStep?.({ step: "waiting_ready", status: "warning", detail: verdict.detail });
        gatewayChild = null;
        // THROWN, not returned: a resolved value from this function means
        // "a new gateway is up" to every caller (see the class comment).
        throw new GatewayIncumbentRestartError(verdict.detail, {
          ...verdict.evidence,
          stderrTail: stderrTail.snapshot(),
          stdoutTail: stdoutTail.snapshot(),
          supervisorExit,
        });
      }
    }
    console.log(
      `[alphaclaw] Gateway ${cmd} ready (${Date.now() - startedAt}ms); leaving supervisor running`,
    );
    // Stamp only once the new gateway is PROVEN up — a spawn error or a
    // never-ready supervisor must not leave rows claiming a nonexistent
    // gateway consumed this env. (The stamp is what lets the UI's own
    // Restart button clear a pending row.)
    stampAutotuneFromChildEnv(restartChildEnv);
    gatewayChild = null;
    await notifyGatewayLaunch();
    return { ok: true, durationMs: Date.now() - startedAt };
  }

  appendLockContentionEvidence(stdoutTail, stderrTail.snapshot(), stdoutTail.snapshot());
  if (supervisorFailed()) {
    // Early-abort failure: name the real cause (dead supervisor), not the
    // timeout symptom — the wait ended within one poll tick, not at budget.
    const exitDesc = supervisorSpawnError
      ? `spawn error: ${supervisorSpawnError.message}`
      : supervisorExit?.signal
        ? `signal ${supervisorExit.signal}`
        : `code ${supervisorExit?.code}`;
    console.warn(
      `[alphaclaw] Gateway ${cmd} supervisor died before ready (${exitDesc}); stopping`,
    );
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await runGatewayShortCmd("stop");
    throw new GatewayRestartError(
      `Gateway restart supervisor exited (${exitDesc}) before ready`,
      {
        stderrTail: stderrTail.snapshot(),
        stdoutTail: stdoutTail.snapshot(),
        supervisorExit,
        timeoutMs: kGatewayRestartReadyTimeoutMs,
      },
    );
  }

  console.warn(
    `[alphaclaw] Gateway ${cmd} did not become ready within ${kGatewayRestartReadyTimeoutMs}ms; stopping`,
  );
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await runGatewayShortCmd("stop");
  throw new GatewayRestartError(
    `Gateway did not become ready within ${Math.round(kGatewayRestartReadyTimeoutMs / 1000)}s`,
    {
      stderrTail: stderrTail.snapshot(),
      stdoutTail: stdoutTail.snapshot(),
      supervisorExit,
      timeoutMs: kGatewayRestartReadyTimeoutMs,
    },
  );
};

// The stop CLI can time out (or return while the old process is still
// draining); launching + TCP-probing against a port the OLD gateway still
// holds would declare a false instant success. Bounded wait, then proceed —
// `--force` still replaces a wedged process.
const kGatewayStopSettleTimeoutMs = 15 * 1000;

const waitForGatewayStopped = async ({
  timeoutMs = kGatewayStopSettleTimeoutMs,
} = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // Shutdown must not wait out the stop-settle window either.
    if (isGatewayWaitsAborted()) return false;
    if (!(await isGatewayRunning())) return true;
    await sleep(kGatewayRestartReadyPollMs);
  }
  return false;
};

// Cold restart pipeline (the manual Restart button, channel restarts, the
// memory mitigation):
//
//   prelaunch hook ─refused/failed─► GatewayPrelaunchHookError (nothing stopped)
//        │ ran/unset
//        ▼
//   plugin preflight ──► snapshot {wasRunningBefore, gateway pids, managed pid}
//        ▼
//   SIGTERM managed child + `openclaw gateway stop [--force]`
//        ▼
//   waitForGatewayStopped ─► stopConfirmed?
//        │ no ∧ stop refused/failed ─► step stopping: WARNING (else done)
//        ▼
//   `openclaw gateway --force` ─► waitForGatewayReady
//        │ ready ─► assessRestartIncumbent(stopEvidence, live pids)
//        │            ├ ok ─────────► stamp autotune, { ok:true, durationMs, downtimeMs }
//        │            └ incumbent ──► throw GatewayIncumbentRestartError (no stamp)
//        └ never ready ─► GatewayRestartError (evidence)
//
// Contract for every caller: a RESOLVED value means a new gateway is up; every
// other outcome THROWS (a GatewayRestartError subclass, or the hook error).
const runGatewayColdStart = async ({ onStep = null } = {}) => {
  // The hook runs FIRST: a refused/failed hook aborts before anything is
  // stopped, so the running gateway keeps serving.
  await prepareGatewayLaunch({ site: "restart" });
  // Prepare BEFORE stopping: the plugin preflight can take minutes and the
  // gateway keeps serving while it runs; a matching desired-state hash skips
  // it entirely. This is where restart downtime dropped from minutes to
  // seconds.
  onStep?.({ step: "preparing_plugins", status: "running" });
  const prep = await prepareOpenclawChannelPlugins();
  onStep?.({
    step: "preparing_plugins",
    // A failed preflight continues (the gateway may still boot) but must not
    // stream as a clean "done" — the client renders this status verbatim.
    status: prep?.failed ? "warning" : prep?.skipped ? "skipped" : "done",
  });
  onStep?.({ step: "stopping", status: "running" });
  const stopStartedAt = Date.now();
  const wasRunningBefore = await isGatewayRunning();
  const preStopPids = listGatewayPids();
  const managedChildPid = hasActiveManagedGatewayChild()
    ? gatewayChild.pid ?? null
    : null;
  stopManagedGatewayChild();
  const stop = await runGatewayShortCmd("stop");
  const portReleased = await waitForGatewayStopped();
  const stopEvidence = {
    wasRunningBefore,
    preStopPids,
    managedChildPid,
    stopConfirmed: portReleased,
    cliOk: stop.ok,
    cliRefused: stop.refused,
    cliExitCode: stop.exitCode,
    cliForced: stop.forced,
  };
  if (!portReleased && !isGatewayWaitsAborted()) {
    if (!stop.ok) {
      const detail = `openclaw gateway stop ${
        stop.refused
          ? "was refused by the CLI (non-interactive guard)"
          : `failed${stop.exitCode !== null ? ` (exit ${stop.exitCode})` : ""}`
      } and the old gateway still holds the port`;
      console.warn(
        `[alphaclaw] ${detail} — proceeding with --force; the restart is verified against the incumbent before it can succeed`,
      );
      onStep?.({ step: "stopping", status: "warning", detail });
    } else {
      console.warn(
        "[alphaclaw] old gateway still holds the port after stop — proceeding with --force; readiness probes may briefly see the old process",
      );
      onStep?.({ step: "stopping", status: "done" });
    }
  } else {
    onStep?.({ step: "stopping", status: "done" });
  }
  const result = await runGatewayRestartCmd("--force", { onStep, stopEvidence });
  // Downtime = stop initiated -> gateway ready. The number the operator
  // actually feels; surfaced on the success line and the operation record.
  return { ...result, downtimeMs: Date.now() - stopStartedAt };
};

const runGatewayCmd = async (cmd) => {
  console.log(`[alphaclaw] Running: openclaw gateway ${cmd}`);
  if (cmd === "--force") {
    // Awaiting only when configured keeps the unconfigured spawn on the
    // caller's synchronous tick (the abort/handler-attach contract relies
    // on it).
    if (isGatewayPrelaunchHookConfigured()) {
      await prepareGatewayLaunch({ site: "force restart" });
    } else {
      noteGatewayPrelaunchHookUnset();
    }
    await runGatewayRestartCmd("--force");
    return;
  }
  await runGatewayShortCmd(cmd);
};

// Autotune spawn stamp: record the env values a fresh gateway actually
// consumed so ledger rows flip pending_restart → applied. Called from EVERY
// path that hands gatewayEnv() to a NEW gateway (managed launch AND the
// cold-restart --force supervisor) — in-place recycles keep the original env
// and correctly do not stamp. Best-effort by contract: never blocks or fails
// a launch. Any heap flag in the child env is autotune's (the strip removes
// all others); UV is stamped only when it matches the derivation (an
// operator-set UV_THREADPOOL_SIZE is not ours).
const stampAutotuneFromChildEnv = (childEnv) => {
  try {
    const {
      stampGatewayEnvApplied,
      getUvThreadpoolSize,
    } = require("./autotune");
    // LAST match, not first: gatewayLaunchEnv appends the operator's explicit
    // cap (ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE) after autotune's suffix and
    // V8 last-wins — the stamp must record the value the gateway actually got.
    const heapMatches = [
      ...String(childEnv.NODE_OPTIONS || "").matchAll(
        /--max-old-space-size=(\d+)/g,
      ),
    ];
    const heapMatch = heapMatches.at(-1) ?? null;
    const derivedUv = getUvThreadpoolSize();
    const envUv = String(childEnv.UV_THREADPOOL_SIZE || "").trim();
    return stampGatewayEnvApplied({
      gatewayHeapMb: heapMatch ? Number.parseInt(heapMatch[1], 10) : null,
      uvThreadpoolSize:
        derivedUv != null && envUv === String(derivedUv) ? derivedUv : null,
    });
  } catch (err) {
    console.error(`[autotune] spawn stamp failed: ${err.message}`);
    return null;
  }
};

// Undo a stamp whose spawn failed — best-effort, never blocks error handling.
const revertAutotuneStamp = (stamp) => {
  if (!stamp) return;
  try {
    require("./autotune").revertGatewayEnvStamp(stamp);
  } catch {}
};

const launchGatewayProcess = async () => {
  if (gatewayChild && gatewayChild.exitCode === null && !gatewayChild.killed) {
    console.log(
      "[alphaclaw] Managed gateway process already running — skipping launch",
    );
    return gatewayChild;
  }
  // Fail closed on the prelaunch hook: null = launch aborted, which every
  // caller (boot, watchdog relaunch/repair/medic, light restart) already
  // treats as "no gateway was started". The outcome reached the hook handler
  // before this returns; nothing is thrown into a caller that only logs.
  try {
    await prepareGatewayLaunch({ site: "managed launch" });
  } catch (error) {
    if (error instanceof GatewayPrelaunchHookError) return null;
    throw error;
  }
  await prepareOpenclawChannelPlugins();
  // A launch cancelled by shutdown must never spawn a fresh gateway child —
  // the aborted preflight above swallows its own abort and returns.
  if (isGatewayWaitsAborted()) return null;
  // Captured by THIS child's handlers below: its finalize — whether 'close'
  // or the bounded post-'exit' drain timeout gets there first — snapshots
  // this tail, never a successor launch's.
  const stderrTail = createStderrTail();
  const launchedAt = Date.now();
  // gatewayLaunchEnv, not gatewayEnv: only the long-running daemon gets the
  // operator's explicit heap cap (issue #24). The autotune stamp reads the
  // SAME env the child consumes — never a differently-built copy.
  const childEnv = gatewayLaunchEnv();
  const child = spawn("openclaw", ["gateway", "run"], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  gatewayChild = child;
  // Stamp at spawn (there is no in-process ready signal for the managed
  // child — the watchdog TCP-probes it); a spawn 'error' reverts the stamp
  // below so a failed launch never reads as "applied".
  const autotuneStamp = stampAutotuneFromChildEnv(childEnv);
  let didSignalGatewayReady = false;
  child.stdout.on("data", (d) => {
    const text = Buffer.isBuffer(d) ? d.toString("utf8") : String(d ?? "");
    if (
      !didSignalGatewayReady &&
      gatewayLaunchHandler &&
      text.toLowerCase().includes("listening on")
    ) {
      didSignalGatewayReady = true;
      try {
        gatewayLaunchHandler({
          pid: child.pid,
          startedAt: Date.now(),
        });
      } catch (err) {
        console.error(`[alphaclaw] Gateway launch handler error: ${err.message}`);
      }
    }
    process.stdout.write(`[gateway] ${d}`);
  });
  child.stderr.on("data", (d) => {
    stderrTail.append(d);
    process.stderr.write(`[gateway] ${d}`);
  });
  // A spawn failure (binary missing/non-executable) with no listener is an
  // uncaught 'error' event — process death. Log it and clear the child so
  // the TCP watcher reports the gateway down instead.
  child.on("error", (error) => {
    console.error(`[alphaclaw] gateway launch error: ${error.message}`);
    stderrTail.append(`gateway launch error: ${error.message}\n`);
    revertAutotuneStamp(autotuneStamp);
    if (gatewayChild === child) gatewayChild = null;
  });
  // Classification prefers "close" over "exit": close fires only after the
  // stdio pipes have drained, so the FINAL stderr chunk (which can carry the
  // exit-78 step-aside signature) is always in the tail before the watchdog
  // classifies. But close waits on every inherited stdio handle — a gateway
  // descendant that inherited the fds and outlives the gateway stalls close
  // indefinitely, and an exit the watchdog never sees means no restart-
  // handoff consume and no relaunch until the descendant dies. So "exit"
  // arms a bounded drain timer that runs the SAME finalize with the tail
  // received so far; first of {close, drain timeout} wins via the settled
  // flag and the loser is a no-op (never a double report).
  let exitFinalized = false;
  let closeDrainTimer = null;
  const finalizeGatewayExit = (code, signal) => {
    if (exitFinalized) return;
    exitFinalized = true;
    if (closeDrainTimer) {
      clearTimeout(closeDrainTimer);
      closeDrainTimer = null;
    }
    const expectedExit = expectedExitPids.has(child.pid);
    expectedExitPids.delete(child.pid);
    console.log(
      `[alphaclaw] Gateway launcher exited with code ${code}${signal ? ` signal ${signal}` : ""}`,
    );
    if (gatewayExitHandler) {
      try {
        gatewayExitHandler({
          code,
          signal,
          expectedExit,
          stderrTail: stderrTail.snapshot(),
          // Exit-78 step-aside classification needs the spawn time (the
          // losing process exits within seconds of its own launch) and the
          // restart-handoff consume needs the exited PID.
          pid: child.pid ?? null,
          launchedAt,
        });
      } catch (err) {
        console.error(`[alphaclaw] Gateway exit handler error: ${err.message}`);
      }
    }
    if (gatewayChild === child) gatewayChild = null;
  };
  child.on("exit", (code, signal) => {
    if (exitFinalized) return;
    // The (code, signal) pair here is exactly what the eventual close would
    // deliver — the timeout path classifies with identical inputs, just an
    // earlier stderr snapshot.
    closeDrainTimer = setTimeout(
      () => finalizeGatewayExit(code, signal),
      kGatewayCloseDrainMs,
    );
    if (typeof closeDrainTimer.unref === "function") closeDrainTimer.unref();
  });
  child.on("close", (code, signal) => {
    finalizeGatewayExit(code, signal);
  });
  return child;
};

const markManagedGatewayExitExpected = () => {
  if (
    !gatewayChild ||
    gatewayChild.exitCode !== null ||
    gatewayChild.killed ||
    !gatewayChild.pid
  ) {
    return false;
  }
  expectedExitPids.add(gatewayChild.pid);
  return true;
};

const notifyGatewayLaunch = async () => {
  if (!gatewayLaunchHandler) return;
  if (!(await isGatewayRunning())) return;
  const pid =
    gatewayChild &&
    gatewayChild.exitCode === null &&
    !gatewayChild.killed &&
    gatewayChild.pid
      ? gatewayChild.pid
      : null;
  try {
    gatewayLaunchHandler({ startedAt: Date.now(), pid });
  } catch (err) {
    console.error(`[alphaclaw] Gateway launch handler error: ${err.message}`);
  }
};

const startGateway = async () => {
  if (!isOnboarded()) {
    console.log("[alphaclaw] Not onboarded yet — skipping gateway start");
    return;
  }
  if (await isGatewayRunning()) {
    console.log("[alphaclaw] Gateway already running — skipping start");
    await notifyGatewayLaunch();
    return;
  }
  console.log("[alphaclaw] Starting openclaw gateway...");
  const child = await launchGatewayProcess();
  // Warm the stop --force probe off the boot path so the shutdown stop
  // usually finds a cached answer (it probes non-abortably within its own
  // budget when the cache is cold — see isGatewayStopForceSupported).
  // Fire-and-forget, never throws.
  if (child) void isGatewayStopForceSupported();
};

const stopManagedGatewayChild = () => {
  markManagedGatewayExitExpected();
  if (!gatewayChild || gatewayChild.exitCode !== null || gatewayChild.killed) {
    return;
  }
  try {
    gatewayChild.kill("SIGTERM");
  } catch {
    // ignore
  }
  gatewayChild = null;
};

const restartGateway = async (reloadEnv, { onStep = null } = {}) => {
  reloadEnv();
  return runGatewayColdStart({ onStep });
};

// Light restart: when the gateway is already up, `openclaw gateway restart`
// recycles it in place (no plugin preflight, no cold-start stop/force
// pipeline); when nothing is listening and no managed child is active, fall
// back to a managed launch. Callers serialize this via gateway-lifecycle-lock
// like every other lifecycle entry point.
const restartGatewayLight = async (reloadEnv) => {
  reloadEnv();
  if (await isGatewayRunning()) {
    // The in-place recycle re-imports the bundle too — the hook gates it.
    try {
      await prepareGatewayLaunch({ site: "light restart" });
    } catch (error) {
      if (error instanceof GatewayPrelaunchHookError) {
        console.warn("[alphaclaw] Gateway light restart refused by the prelaunch hook");
        return;
      }
      throw error;
    }
    if (await runGatewayLifecycleRestart()) {
      console.log("[alphaclaw] Gateway light restart complete");
      return;
    }
    console.warn("[alphaclaw] Gateway light restart failed");
    return;
  }
  if (!hasActiveManagedGatewayChild()) {
    console.log("[alphaclaw] Gateway not running — starting managed process");
    await launchGatewayProcess();
  }
};

const attachGatewaySignalHandlers = () => {
  // The stop command is async now; exit only after it settles or the process
  // would die with the gateway still holding the port.
  const stopThenExit = async () => {
    try {
      await runGatewayCmd("stop");
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", stopThenExit);
  process.on("SIGINT", stopThenExit);
};

// Quiesce stop for the pre-update backup (issues #11/#18): the gateway is the
// only writer of the state dir, so pausing it makes the backup's tar walk
// deterministic — no vanished-file races. Unlike stopGatewayForShutdown this
// must NOT abortGatewayWaits (that flag is one-way and would poison the
// relaunch that follows the backup). Caller contract: hold the gateway
// lifecycle lock across stop→backup→start (the watchdog relaunches an exited
// gateway 10s into a managed operation unless the lock blocks it) and
// relaunch via startGateway() afterwards.
// Evidence of the last quiesce stop, for the backup ladder's exclusivity
// record: { at, method: "managed_child"|"cli"|"none", childExited,
// portReleased, cliRefused, cliExitCode }. The boolean return contract of
// stopGatewayForBackup is unchanged (the quiesce seam does Boolean(await
// stop())); the evidence rides beside it.
let lastGatewayStopEvidence = null;
const getLastGatewayStopEvidence = () => lastGatewayStopEvidence;

const stopGatewayForBackup = async ({
  timeoutMs = kGatewayStopSettleTimeoutMs,
} = {}) => {
  markManagedGatewayExitExpected();
  const hadManagedChild = hasActiveManagedGatewayChild();
  const childExited = await stopGatewayChildAndWait();
  // Externally-supervised gateways (VPS `openclaw gateway run` outside our
  // child) need a CLI stop as well — bounded, best-effort, outcome recorded.
  const stop = await runGatewayShortCmd("stop");
  const portReleased = await waitForGatewayStopped({ timeoutMs });
  lastGatewayStopEvidence = {
    at: new Date().toISOString(),
    method: hadManagedChild ? "managed_child" : stop.ok ? "cli" : "none",
    childExited: hadManagedChild ? childExited : false,
    portReleased,
    cliRefused: stop.refused,
    cliExitCode: stop.exitCode,
  };
  if (stop.refused) {
    console.warn(
      `[alphaclaw] backup quiesce: the OpenClaw CLI refused \`gateway stop\` (non-interactive guard) — relying on the managed-child stop; port released: ${portReleased}`,
    );
  }
  return portReleased;
};

// Shutdown-path gateway stop for the lifecycle orchestrator (used instead of
// the plain SIGTERM/SIGINT handlers when server.js owns graceful shutdown).
// Cancels in-flight lifecycle waits/CLI children FIRST via abortGatewayWaits —
// never waits out a 120s ready window inside the shutdown deadline — then
// reaps the managed child so the old version cannot keep the port and wedge
// the successor into "gateway already running, skipping start".
const stopGatewayForShutdown = async () => {
  abortGatewayWaits("shutdown");
  markManagedGatewayExitExpected();
  await stopGatewayChildAndWait();
  // Externally-supervised gateways (VPS `openclaw gateway run` outside our
  // child) still need a CLI stop — best-effort, bounded, and NOT on the
  // shared abort signal (it fired above). Same runner as every other stop,
  // so --force rides along when the installed CLI supports it; with a cold
  // capability cache the runner probes for it non-abortably inside this same
  // budget (a 2026.8.x+ CLI refuses the non-interactive stop without it).
  await runGatewayShortCmd("stop", {
    timeoutMs: kGatewayShutdownStopTimeoutMs,
    abortable: false,
  });
};

const ensureGatewayProxyConfig = (origin) => {
  if (!isOnboarded()) return false;
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    // Locked read-modify-write: team mode and the channel sync write this
    // file through the same lock (utils/safe-file.js), so this writer can no
    // longer clobber their changes mid-flight (plan 1.6, landed with Phase 4).
    return withFileLockSync(configPath, () => {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!cfg.gateway) cfg.gateway = {};
    let changed = false;

    if (isOpenAiCompatApiEnabled({ fsModule: fs, openclawDir: OPENCLAW_DIR })) {
      if (!cfg.gateway.http) cfg.gateway.http = {};
      if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};

      const chatCompletions = cfg.gateway.http.endpoints.chatCompletions || {};
      if (chatCompletions.enabled !== true) {
        cfg.gateway.http.endpoints.chatCompletions = {
          ...chatCompletions,
          enabled: true,
        };
        console.log("[alphaclaw] Enabled gateway OpenAI chat completions endpoint");
        changed = true;
      }

      const responses = cfg.gateway.http.endpoints.responses || {};
      if (responses.enabled !== true) {
        cfg.gateway.http.endpoints.responses = {
          ...responses,
          enabled: true,
        };
        console.log("[alphaclaw] Enabled gateway OpenResponses endpoint");
        changed = true;
      }
    }

    if (!Array.isArray(cfg.gateway.trustedProxies)) {
      cfg.gateway.trustedProxies = [];
    }
    if (!cfg.gateway.trustedProxies.includes("127.0.0.1")) {
      cfg.gateway.trustedProxies.push("127.0.0.1");
      console.log("[alphaclaw] Added 127.0.0.1 to gateway.trustedProxies");
      changed = true;
    }

    if (origin) {
      if (!cfg.gateway.controlUi) cfg.gateway.controlUi = {};
      if (!Array.isArray(cfg.gateway.controlUi.allowedOrigins)) {
        cfg.gateway.controlUi.allowedOrigins = [];
      }
      if (!cfg.gateway.controlUi.allowedOrigins.includes(origin)) {
        cfg.gateway.controlUi.allowedOrigins.push(origin);
        console.log(`[alphaclaw] Added dashboard origin: ${origin}`);
        changed = true;
      }
    }

    // Managed remote MCP server entry. Env-driven so any AlphaClaw operator
    // (Render, Fly, fly.io-style PaaS, plain VPS) can wire OpenClaw to a
    // remote MCP server without hand-editing /data/.openclaw/openclaw.json.
    //
    //   REMOTE_MCP_URL         upstream MCP endpoint (streamable-http).
    //   REMOTE_MCP_API_TOKEN   Bearer token the remote MCP expects. Persisted
    //                          as the ${REMOTE_MCP_API_TOKEN} reference, not
    //                          raw, so the openclaw.json that gets
    //                          git-committed never holds the plaintext.
    //   REMOTE_MCP_NAME        Key under mcp.servers.<name>. Default "remote".
    //   REMOTE_MCP_PROXY_URL   When set, OpenClaw connects here instead of
    //                          REMOTE_MCP_URL. Intended for a same-host
    //                          scanning proxy (e.g. `pipelock mcp proxy
    //                          --listen ... --upstream <REMOTE_MCP_URL>`),
    //                          but the implementation is proxy-agnostic.
    //                          The supervisor that starts that proxy is
    //                          responsible for unsetting this env var when
    //                          the proxy is not running, so AlphaClaw never
    //                          points OpenClaw at a dead listener.
    const remoteMcpUrl = String(process.env.REMOTE_MCP_URL || "").trim();
    const remoteMcpToken = String(
      process.env.REMOTE_MCP_API_TOKEN || "",
    ).trim();
    const remoteMcpProxyUrl = String(
      process.env.REMOTE_MCP_PROXY_URL || "",
    ).trim();
    const remoteMcpNameRaw = String(process.env.REMOTE_MCP_NAME || "").trim();
    // Constrain the managed key. OpenClaw sanitizes names later for tool
    // prefixes, but the config-key itself must be safe to use as an object
    // key and to read back in `openclaw mcp` CLI commands. Reject names
    // with prototype-pollution shapes, spaces, or path-like names; fall
    // back to "remote" with a warning so a typo doesn't silently misroute.
    const kRemoteMcpNamePattern = /^[A-Za-z0-9_-]{1,64}$/;
    const kReservedRemoteMcpNames = new Set([
      "__proto__",
      "constructor",
      "prototype",
    ]);
    let remoteMcpName = "remote";
    if (remoteMcpNameRaw) {
      if (
        kRemoteMcpNamePattern.test(remoteMcpNameRaw) &&
        !kReservedRemoteMcpNames.has(remoteMcpNameRaw)
      ) {
        remoteMcpName = remoteMcpNameRaw;
      } else {
        console.warn(
          `[alphaclaw] REMOTE_MCP_NAME=${JSON.stringify(remoteMcpNameRaw)} is invalid (must match ${kRemoteMcpNamePattern} and not be a reserved key); falling back to "remote"`,
        );
      }
    }
    const placeholderAuth = "Bearer ${REMOTE_MCP_API_TOKEN}";
    const desiredAuth = `Bearer ${remoteMcpToken}`;
    const kManagedMarker = "_alphaclawManaged";
    let mcpChanged = false;

    // Clean up any managed entries left over from a prior REMOTE_MCP_NAME
    // value. Without this, renaming REMOTE_MCP_NAME from "sure" to "notion"
    // would leave the old "sure" entry behind, duplicating MCP tools or
    // routing callbacks to a stale target. The marker scopes the cleanup so
    // user-managed entries (no marker) are never touched.
    if (cfg.mcp?.servers) {
      for (const [key, entry] of Object.entries(cfg.mcp.servers)) {
        if (
          entry &&
          typeof entry === "object" &&
          entry[kManagedMarker] === true &&
          key !== remoteMcpName
        ) {
          delete cfg.mcp.servers[key];
          mcpChanged = true;
          console.log(
            `[alphaclaw] Removed stale managed MCP server "${key}" (REMOTE_MCP_NAME is now "${remoteMcpName}")`,
          );
        }
      }
    }

    if (remoteMcpUrl && remoteMcpToken) {
      if (!cfg.mcp) cfg.mcp = {};
      if (!cfg.mcp.servers) cfg.mcp.servers = {};
      const existing = cfg.mcp.servers[remoteMcpName] || {};
      const effectiveUrl = remoteMcpProxyUrl || remoteMcpUrl;
      const existingHeaders = existing.headers || {};
      const existingAuth = existingHeaders.Authorization;
      // Only the placeholder counts as "already sanitized". A plaintext
      // Bearer (even one that matches the current desiredAuth) must trigger a
      // rewrite so the substitution loop below scrubs it back to the
      // ${REMOTE_MCP_API_TOKEN} reference.
      const authIsPlaceholder = existingAuth === placeholderAuth;
      const hasManagedMarker = existing[kManagedMarker] === true;
      if (
        existing.url !== effectiveUrl ||
        existing.transport !== "streamable-http" ||
        !authIsPlaceholder ||
        !hasManagedMarker
      ) {
        cfg.mcp.servers[remoteMcpName] = {
          ...existing,
          url: effectiveUrl,
          transport: "streamable-http",
          headers: {
            ...existingHeaders,
            Authorization: desiredAuth,
          },
          [kManagedMarker]: true,
        };
        mcpChanged = true;
        console.log(
          `[alphaclaw] Configured remote MCP server "${remoteMcpName}" (url=${effectiveUrl}, via_proxy=${Boolean(remoteMcpProxyUrl)})`,
        );
      }
    } else if (
      cfg.mcp?.servers?.[remoteMcpName] &&
      cfg.mcp.servers[remoteMcpName][kManagedMarker] === true
    ) {
      delete cfg.mcp.servers[remoteMcpName];
      mcpChanged = true;
      console.log(
        `[alphaclaw] Removed remote MCP server "${remoteMcpName}" entry (REMOTE_MCP_URL / REMOTE_MCP_API_TOKEN unset)`,
      );
    }
    if (cfg.mcp?.servers && Object.keys(cfg.mcp.servers).length === 0) {
      delete cfg.mcp.servers;
    }
    if (cfg.mcp && Object.keys(cfg.mcp).length === 0) {
      delete cfg.mcp;
    }
    if (mcpChanged) changed = true;

    if (changed) {
      let content = JSON.stringify(cfg, null, 2);
      if (remoteMcpToken) {
        const jsonValue = JSON.stringify(desiredAuth);
        const jsonPlaceholder = JSON.stringify(placeholderAuth);
        content = content.split(jsonValue).join(jsonPlaceholder);
      }
      fs.writeFileSync(configPath, content);
      invalidateOpenclawConfigMemo();
    }
    return changed;
    });
  } catch (e) {
    console.error(`[alphaclaw] ensureGatewayProxyConfig error: ${e.message}`);
    return false;
  }
};

// Sequential per channel (each add rewrites openclaw.json, and the token →
// env-ref rewrite must happen right after its own add), but async: each CLI
// call previously blocked the event loop for up to 15s. Tokens are passed as
// execFile ARGUMENTS, never interpolated into a shell string, and every
// logged failure is scrubbed of secret argv values (see execChannelCmd).
const syncChannelConfig = async (savedVars, mode = "all") => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const savedMap = Object.fromEntries(
      savedVars.filter((v) => v.value).map((v) => [v.key, v.value]),
    );

    for (const [ch, def] of Object.entries(kChannelDefs)) {
      // Externally-configured channels (no managed env token — e.g. signal
      // linked via signal-cli) are never auto-added or auto-removed: without
      // this guard the removal branch below would `channels remove --delete`
      // an operator's out-of-band channel on every boot and env save.
      // (whatsapp's declared `sync:false` stays unenforced on purpose this
      // wave — honoring it would change env-clear removal behavior; TODOS.)
      if (!def.envKey) continue;
      const token = savedMap[def.envKey];
      const isConfigured = cfg.channels?.[ch]?.enabled;

      if (token && !isConfigured && (mode === "add" || mode === "all")) {
        console.log(`[alphaclaw] Adding channel: ${ch}`);
        try {
          if (ch === "slack") {
            const appToken = savedMap[def.extraEnvKeys?.[0]];
            if (!appToken) continue;
            await execChannelCmd([
              "channels",
              "add",
              "--channel",
              "slack",
              "--bot-token",
              token,
              "--app-token",
              appToken,
            ]);
            let raw = fs.readFileSync(configPath, "utf8");
            if (raw.includes(token)) {
              raw = raw.split(token).join("${" + def.envKey + "}");
            }
            if (raw.includes(appToken)) {
              raw = raw.split(appToken).join("${" + def.extraEnvKeys[0] + "}");
            }
            fs.writeFileSync(configPath, raw);
            invalidateOpenclawConfigMemo();
          } else {
            await execChannelCmd([
              "channels",
              "add",
              "--channel",
              ch,
              "--token",
              token,
            ]);
            const raw = fs.readFileSync(configPath, "utf8");
            if (raw.includes(token)) {
              fs.writeFileSync(
                configPath,
                raw.split(token).join("${" + def.envKey + "}"),
              );
            }
          }
          console.log(`[alphaclaw] Channel ${ch} added`);
        } catch (e) {
          console.error(
            `[alphaclaw] channels add ${ch}: ${(e.stderr || e.message || "").toString().trim().slice(0, 200)}`,
          );
        }
      } else if (
        !token &&
        isConfigured &&
        (mode === "remove" || mode === "all")
      ) {
        console.log(`[alphaclaw] Removing channel: ${ch}`);
        try {
          await execChannelCmd([
            "channels",
            "remove",
            "--channel",
            ch,
            "--delete",
          ]);
          console.log(`[alphaclaw] Channel ${ch} removed`);
        } catch (e) {
          console.error(
            `[alphaclaw] channels remove ${ch}: ${(e.stderr || e.message || "").toString().trim().slice(0, 200)}`,
          );
        }
      }
    }
  } catch (e) {
    console.error("[alphaclaw] syncChannelConfig error:", e.message);
  } finally {
    // The openclaw CLI itself rewrites openclaw.json (channels add/remove) —
    // drop the memo so the next read (port, channel status, probe target) is
    // never up to 1.5s stale after a config change.
    invalidateOpenclawConfigMemo();
  }
};

const getChannelStatus = () => {
  try {
    const config = readOpenclawConfigCached();
    if (!config) return {};
    const credDir = `${OPENCLAW_DIR}/credentials`;
    const channels = {};

    for (const ch of Object.keys(kChannelDefs)) {
      const channelConfig =
        config.channels?.[ch] && typeof config.channels[ch] === "object"
          ? config.channels[ch]
          : null;
      if (!channelConfig?.enabled) continue;

      const rawAccounts =
        channelConfig.accounts && typeof channelConfig.accounts === "object"
          ? channelConfig.accounts
          : {};
      const accountEntries = Object.keys(rawAccounts).length > 0
        ? Object.entries(rawAccounts)
        : [["default", channelConfig]];
      const configuredAccountIds = new Set(
        accountEntries.map(([accountId]) => normalizeChannelAccountId(accountId)),
      );
      const hasConfiguredToken = accountEntries.some(([accountId, accountConfig]) => {
        const normalizedAccountId = normalizeChannelAccountId(accountId);
        const envKey = normalizedAccountId === "default"
          ? kChannelDefs[ch].envKey
          : `${kChannelDefs[ch].envKey}_${normalizedAccountId.replace(/-/g, "_").toUpperCase()}`;
        return !!process.env[envKey]
          || !!accountConfig?.botToken
          || !!accountConfig?.token;
      });
      // External channels (signal) have no token to require — enabled config
      // is their whole contract (#113). The `enabled` gate above still
      // applies: a present-but-disabled block never reports as configured.
      if (!kChannelDefs[ch].external && !hasConfiguredToken) continue;

      const pairedByAccount = readPairedCountsByAccount({
        fsImpl: fs,
        OPENCLAW_DIR,
        channelId: ch,
        accountIds: Array.from(configuredAccountIds),
        config: channelConfig,
      });

      const accounts = Object.fromEntries(
        Array.from(pairedByAccount.entries()).map(([accountId, paired]) => [
          accountId,
          { status: paired > 0 ? "paired" : "configured", paired },
        ]),
      );
      const paired = Array.from(pairedByAccount.values()).reduce(
        (total, count) => total + Number(count || 0),
        0,
      );
      channels[ch] = {
        status: paired > 0 ? "paired" : "configured",
        paired,
        accounts,
      };
    }

    return channels;
  } catch {
    return {};
  }
};

// VPS restarts (detached respawn + exit 0) skip the SIGTERM handlers that
// normally reap the managed child; an orphaned gateway would keep the OLD
// OpenClaw code alive on the port and the new process would "skip start".
// `force` exists for SIGKILL escalation: child.kill("SIGTERM") sets `.killed`
// the moment the signal is SENT, so without it the escalation call below
// would see killed===true and silently never deliver the SIGKILL — a gateway
// that ignores SIGTERM would keep the port through every shutdown.
const stopGatewayChild = ({ signal = "SIGTERM", force = false } = {}) => {
  if (
    gatewayChild &&
    gatewayChild.exitCode === null &&
    (force || !gatewayChild.killed)
  ) {
    try {
      gatewayChild.kill(signal);
      return true;
    } catch {}
  }
  return false;
};

// SIGTERM alone is a request, not a guarantee: a stuck gateway that keeps the
// port makes the respawned server treat the OLD version as healthy. Escalate
// to SIGKILL after a short grace and wait for the exit before the respawn.
const stopGatewayChildAndWait = async ({ graceMs = 2000 } = {}) => {
  if (!stopGatewayChild()) return true;
  const child = gatewayChild;
  // A signal-killed child (the SIGKILL escalation below, or SIGTERM default
  // disposition) leaves exitCode null and sets signalCode — checking
  // exitCode alone made a SUCCESSFUL reap poll out its whole budget and
  // report false.
  const exited = () =>
    !child || child.exitCode !== null || child.signalCode !== null;
  const waitUntil = async (deadline) => {
    while (!exited() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100).unref?.());
    }
    return exited();
  };
  if (await waitUntil(Date.now() + graceMs)) return true;
  stopGatewayChild({ signal: "SIGKILL", force: true });
  return waitUntil(Date.now() + 1000);
};

module.exports = {
  gatewayEnv,
  isSupervisorModeActive,
  gatewayLaunchEnv,
  stopGatewayChild,
  stopGatewayChildAndWait,
  getGatewayPort,
  getGatewayUrl,
  isOnboarded,
  isGatewayRunning,
  probeGatewayTcp,
  getGatewayTcpObservation,
  setGatewayTcpTransitionHandler,
  launchGatewayProcess,
  cleanupOpenclawPluginInstallStages,
  prepareOpenclawChannelPlugins,
  setGatewayExitHandler,
  setGatewayLaunchHandler,
  runGatewayCmd,
  GatewayRestartError,
  GatewayIncumbentRestartError,
  kGatewayIncumbentRestartReason,
  GatewayPrelaunchHookError,
  abortGatewayWaits,
  startGateway,
  restartGateway,
  restartGatewayLight,
  attachGatewaySignalHandlers,
  stopGatewayForShutdown,
  stopGatewayForBackup,
  getLastGatewayStopEvidence,
  setGatewayCapabilities,
  runGatewayPrelaunchHook,
  setGatewayPrelaunchHookHandler,
  getLastGatewayPrelaunchHookOutcome,
  kGatewayPrelaunchHookEnvKey,
  kGatewayPrelaunchHookTimeoutMs,
  ensureGatewayProxyConfig,
  syncChannelConfig,
  getChannelStatus,
  // Exported for tests.
  stripNodeMemoryFlags,
  assessRestartIncumbent,
  minimalHookEnv,
  kGatewayPrelaunchHookPath,
  kGatewayPrelaunchHookGraceMs,
  kGatewayShutdownProbeTimeoutMs,
};
