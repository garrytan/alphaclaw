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
const {
  applyControlUiBasePath,
  kControlUiBasePath,
  kControlUiMount,
} = require("./control-ui-mount");
const { withFileLockSync, writeFileAtomic } = require("./utils/safe-file");
const { applyGatewayAuthEnv } = require("./gateway-credential");
const { filterGatewayChildEnv } = require("./gateway-env-policy");
// Namespace require (not destructured) so tests can spy on the module object.
const lockContention = require("./openclaw-lock-contention");
const gatewayIdentity = require("./gateway-identity");
const { waitForGatewayReadiness } = require("./gateway-readiness");
const { redactSecretShapes } = require("./utils/redact");

let gatewayChild = null;
// The managed child's real gateway pid. Under AlphaClaw's NODE_COMPILE_CACHE
// the `openclaw` binary is a compile-cache launcher that respawns the gateway
// as its child and forwards signals to it (openclaw.mjs → runRespawnedChild),
// so the process holding the port is the launcher's child, not `child.pid`.
// Resolved from /proc once the gateway is listening; carried into exit
// classification (the restart-handoff row is keyed by the GATEWAY's pid) and
// to the watchdog as the serving pid (memory monitor, pid-reuse guard).
let gatewayChildWorkerPid = null;
// Launch generation: a module counter stamped on every `gateway run` spawn
// (requestGatewayLaunch — boot, watchdog relaunches and the cold restart all
// go through it). The watchdog fences late launch/exit
// notifications with it (a payload from an older generation can never
// overwrite the current identity) and matches a pending replacement to the
// launch that fulfils it. 0 before any spawn; never reused within a process.
let gatewayLaunchGeneration = 0;
// Generation of the CURRENT managed child (null when none / adopted from
// outside). Carried on the notifyGatewayLaunch payload for a live child.
let gatewayChildGeneration = null;
const getLaunchGeneration = () => gatewayLaunchGeneration;
// requestGatewayLaunch outcomes — the one shape every relaunch caller sees.
const kGatewayLaunchOutcomes = Object.freeze({
  INCUMBENT_PRESENT: "incumbent_present",
  CHILD_RETAINED: "child_retained",
  LAUNCH_REQUESTED: "launch_requested",
  LAUNCH_ABORTED: "launch_aborted",
  LAUNCH_FAILED: "launch_failed",
});
// Reason carried by a GatewayRestartError thrown because the CALLER's fence
// (`shouldAbort`) fired — a lifecycle-lock holder whose lease expired. The
// watchdog maps it to lease_expired; one predicate, no string coupling.
const kCallerAbortReason = "aborted_by_caller";
const isCallerAbortError = (err) =>
  err?.aborted === true && err?.reason === kCallerAbortReason;
let gatewayExitHandler = null;
let gatewayLaunchHandler = null;
const kGatewayStderrTailLines = 50;
const kPluginRuntimeDepsPreflightTimeoutMs = 120 * 1000;
// Stop ladder (restart + shutdown). Step 1 asks OpenClaw to restart itself
// (`gateway restart --wait <askGrace>`: admission closes, the agent's turn
// compacts, active work drains inside the grace, the gateway exits 0 with a
// handoff row); step 2 SIGTERMs the gateway's process group; step 3 SIGKILLs
// it. Each wait is bounded; the ladder as a whole is bounded by the caller's
// deadline (restart: the operation budget; shutdown: the process deadline).
const kGatewayStopAskGraceMs = 30 * 1000;
const kGatewayStopTermGraceMs = 10 * 1000;
const kGatewayStopKillGraceMs = 5 * 1000;
const kGatewayStopPollMs = 250;
// The `gateway restart` CLI blocks on post-restart health until its own
// timeout; the ladder reaps it once the gateway is gone, so its lifetime is
// capped just past the ask grace.
const kGatewayStopAskCliSlackMs = 5 * 1000;
// Shutdown has ~10 s for everything (init/server-lifecycle); the gateway gets
// this much of it, SIGTERM first, SIGKILL for the remainder.
const kGatewayShutdownStopBudgetMs = 6 * 1000;
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
// survives them. The cold restart spawns a NEW daemon through
// requestGatewayLaunch and gets this env too — an earlier restart path used
// gatewayEnv() and silently dropped the cap after the first restart (F011).
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

// A stop that could not be completed, or that the ladder REFUSED to attempt
// because it could not prove which process is the gateway. `code` is the
// user-facing failure class the route and the card render:
//   stop_refused  port busy, owner unknown / foreign / ambiguous — nothing was
//                 signalled (never kill a process we cannot identify)
//   stop_failed   the identified gateway survived SIGKILL (or /proc could not
//                 confirm it gone) and the port is still held
class GatewayStopError extends GatewayRestartError {
  constructor(code, message, evidence = {}) {
    super(message, evidence);
    this.name = "GatewayStopError";
    this.code = code;
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
//
// Both patterns live in openclaw-lock-contention.js beside the /proc scan:
// the EVIDENCE pattern (default here — any gateway-ish process, CLI verbs
// included) and the SERVING pattern (only processes that can own the port),
// which resolveServingIdentity passes to narrow the snapshot to an identity.
const { kGatewayProcessPattern, kGatewayServingCmdlinePattern } = lockContention;
const listGatewayPids = ({ pattern = kGatewayProcessPattern } = {}) => {
  const matches = (cmdline) => pattern.test(String(cmdline || ""));
  try {
    return lockContention
      .listLiveOpenclawProcesses({
        match: (argv) => matches(argv.join(" ")),
        limit: Infinity,
      })
      // Re-filter over the returned cmdline: the scan's `match` runs on the
      // full argv, the snapshot must stay gateway-only whatever the scan gave.
      .filter((proc) => matches(proc.cmdline))
      .map((proc) => proc.pid);
  } catch {
    return [];
  }
};

// Serving identity of a gateway AlphaClaw did not spawn (boot around an
// incumbent, an external `gateway run`): the process-tree ROOT among the
// serving-pattern pids (the pid whose parent is not itself a candidate), its
// worker (resolveFirstChildPid — the same two-pid shape the adopted cold-
// restart supervisor carries: launcher/root + gateway worker), the root's
// /proc start ticks (pid-reuse guard for the memory tick) and the full
// candidate list. null whenever the answer is not unambiguous — zero
// candidates, or more than one root (two independent gateways, a foreign
// process with matching argv): ambiguity always fails safe to today's
// behaviour (no identity, "detached"). Linux /proc only; never throws.
const resolveServingIdentity = () => {
  const pids = listGatewayPids({ pattern: kGatewayServingCmdlinePattern });
  if (pids.length === 0) return null;
  const candidates = new Set(pids);
  // A candidate whose parent could not be read (raced with exit, non-Linux)
  // counts as a root: it can only make the scan MORE ambiguous, never adopt
  // the wrong process.
  const roots = pids.filter(
    (pid) => !candidates.has(lockContention.readProcParentPid(pid)),
  );
  if (roots.length !== 1) return null;
  const rootPid = roots[0];
  return {
    rootPid,
    workerPid: resolveFirstChildPid(rootPid) ?? null,
    startTicks: lockContention.readProcStartTicks(rootPid),
    pids,
  };
};

// Identity for a launch-handler payload when no live managed child exists.
// A throwing /proc walk must never take the launch notification down with it.
const resolveServingIdentitySafe = () => {
  try {
    return resolveServingIdentity();
  } catch (error) {
    console.warn(
      `[alphaclaw] serving identity scan failed: ${String(error?.message || error)}`,
    );
    return null;
  }
};

// ── Gateway identity ─────────────────────────────────────────────────────
// Which processes ARE the gateway right now, and may the stop ladder signal
// them? Three sources, first match wins:
//   managed   a live managed child: its whole /proc tree (launcher + gateway
//             worker + plugin/exec helpers); the worker is the tree member
//             that holds the port's listener
//   adopted   no live child, one unambiguous serving tree in /proc
//             (resolveServingIdentity), or every listener on the port is an
//             openclaw process
//   foreign   something listens on the port and is NOT an openclaw process
//             (or the openclaw tree shares the port with a stranger) — the
//             ladder refuses to signal anything
// null when nothing is on the port and no child is live. Start ticks are
// snapshotted per pid here; every later signal re-checks them (a reused pid
// is not the process we resolved). Linux /proc; off Linux the managed child
// handle is the only identity (its tree is just the pid).
const kIdentityOwners = Object.freeze({
  MANAGED: "managed",
  ADOPTED: "adopted",
  FOREIGN: "foreign",
});
const snapshotStartTicks = (pids) =>
  new Map(pids.map((pid) => [pid, lockContention.readProcStartTicks(pid)]));

const resolveGatewayIdentity = () => {
  const port = getGatewayPort();
  const listeners = gatewayIdentity.findPortListenerPids(port);
  const finish = (owner, rootPid, tree, workerHint) => {
    const pids = tree.length ? tree : [rootPid];
    const foreignListeners = listeners.filter((pid) => !pids.includes(pid));
    const workerPid =
      listeners.find((pid) => pids.includes(pid)) ?? workerHint ?? null;
    return {
      owner: foreignListeners.length ? kIdentityOwners.FOREIGN : owner,
      rootPid,
      workerPid,
      pids,
      // A group we may signal as one: the root is its own group leader (the
      // detached spawn below) and it is not OUR group.
      pgid: (() => {
        const pgid = gatewayIdentity.readProcessGroupId(rootPid);
        return pgid != null &&
          pgid === rootPid &&
          pgid !== gatewayIdentity.readProcessGroupId(process.pid)
          ? pgid
          : null;
      })(),
      startTicks: snapshotStartTicks(pids),
      listeners,
      foreignListeners,
    };
  };
  if (isManagedGatewayChildLive() && gatewayChild.pid) {
    return finish(
      kIdentityOwners.MANAGED,
      gatewayChild.pid,
      gatewayIdentity.listProcessTree(gatewayChild.pid),
      gatewayChildWorkerPid ?? resolveFirstChildPid(gatewayChild.pid),
    );
  }
  const serving = resolveServingIdentitySafe();
  if (serving?.rootPid != null) {
    return finish(
      kIdentityOwners.ADOPTED,
      serving.rootPid,
      gatewayIdentity.listProcessTree(serving.rootPid),
      serving.workerPid,
    );
  }
  if (listeners.length === 0) return null;
  if (!listeners.every((pid) => gatewayIdentity.isOpenclawPid(pid))) {
    return {
      owner: kIdentityOwners.FOREIGN,
      rootPid: null,
      workerPid: null,
      pids: [],
      pgid: null,
      startTicks: new Map(),
      listeners,
      foreignListeners: listeners,
    };
  }
  return finish(kIdentityOwners.ADOPTED, listeners[0], [...listeners], listeners[0]);
};

// ── Stop ladder ──────────────────────────────────────────────────────────
//
//   resolveGatewayIdentity ─null ∧ port closed─► { how: "none" }
//        │ foreign / ambiguous ─► throw GatewayStopError stop_refused (nothing signalled)
//        ▼
//   mark the managed exit EXPECTED (before the first signal — the exit
//   classifier must never book our own stop as a crash)
//        ▼
//   1. ask    `openclaw gateway restart --wait <askGrace>` — OpenClaw closes
//             admission, compacts the agent's turn, drains ≤ grace, exits 0
//             (full-process restart under external supervision; skipped when
//             OPENCLAW_NO_RESPAWN keeps the gateway in-process, when the
//             deadline cannot fit the grace, or when the caller says so)
//        │ still alive / CLI refused
//   2. term   SIGTERM the process group (or each pid, start ticks re-checked)
//        │ still alive after termGrace
//   3. kill   SIGKILL the same; still alive after killGrace ─► stop_failed
//        ▼
//   { how: graceful|sigterm|sigkill, downAtMs, pids, identity }
//
// "Gone" = every resolved pid has exited (or is a different process now).
// The port is not consulted for "gone" — a foreign listener would make a dead
// gateway look alive; the caller checks the port before spawning instead.
// `shouldAbort()` is honoured between every poll: a holder that lost its
// lease sends no further signal. `onStep` streams the phase for the UI.
const kStopHow = Object.freeze({
  NONE: "none",
  GRACEFUL: "graceful",
  SIGTERM: "sigterm",
  SIGKILL: "sigkill",
});
const kStateOwnershipWaitPattern =
  /waiting for Gateway state ownership|ownership held by another OpenClaw process/i;

const stopGatewayLadder = async ({
  deadlineAt = null,
  askGraceMs = kGatewayStopAskGraceMs,
  termGraceMs = kGatewayStopTermGraceMs,
  killGraceMs = kGatewayStopKillGraceMs,
  allowGracefulRestart = true,
  onStep = null,
  shouldAbort = null,
} = {}) => {
  const identity = resolveGatewayIdentity();
  const stopStartedAt = Date.now();
  const remaining = () =>
    deadlineAt == null ? Infinity : Math.max(0, deadlineAt - Date.now());
  const abortIfFenced = (phase) => {
    if (shouldAbort?.()) {
      throw new GatewayRestartError(`Gateway stop aborted by caller during ${phase}`, {
        aborted: true,
        reason: kCallerAbortReason,
        phase,
      });
    }
  };
  if (!identity) {
    if (!(await isGatewayRunning())) {
      return { how: kStopHow.NONE, downAtMs: Date.now(), pids: [], identity: null };
    }
    throw new GatewayStopError(
      "stop_refused",
      `Port ${getGatewayPort()} answers but no gateway process could be identified behind it`,
      { listeners: [] },
    );
  }
  if (identity.owner === kIdentityOwners.FOREIGN) {
    throw new GatewayStopError(
      "stop_refused",
      `Port ${getGatewayPort()} is held by a process that is not the gateway (pid ${identity.foreignListeners.join(", ")})`,
      { listeners: identity.listeners, foreignListeners: identity.foreignListeners },
    );
  }
  const { pids, startTicks } = identity;
  const alivePids = () =>
    pids.filter((pid) => gatewayIdentity.isSameProcess(pid, startTicks.get(pid)));
  const gone = () => alivePids().length === 0;
  const waitUntilGone = async (budgetMs, extraStop = null) => {
    const until = Date.now() + Math.min(budgetMs, remaining());
    while (Date.now() < until) {
      if (gone()) return true;
      if (extraStop?.()) return false;
      abortIfFenced("stop");
      await sleep(kGatewayStopPollMs);
    }
    return gone();
  };
  const signalTree = (signal) => {
    if (identity.pgid != null) {
      try {
        process.kill(-identity.pgid, signal);
        return;
      } catch {
        // group gone or not ours any more — fall through to per-pid
      }
    }
    for (const pid of alivePids()) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
  };

  // Our own stop: the exit classifier books the managed child's exit as a
  // restart, never a crash, whatever code the launcher relays.
  markManagedGatewayExitExpected();
  for (const pid of pids) expectedExitPids.add(pid);

  let how = null;
  const graceful =
    allowGracefulRestart &&
    identity.workerPid != null &&
    remaining() > askGraceMs + termGraceMs + killGraceMs &&
    !String(gatewayEnv().OPENCLAW_NO_RESPAWN || "").trim();
  if (graceful) {
    onStep?.({ step: "stopping", status: "running", detail: { phase: "asking", graceSeconds: Math.round(askGraceMs / 1000) } });
    let cliExit = null;
    let cli = null;
    const cliTail = createStderrTail();
    try {
      cli = spawn("openclaw", ["gateway", "restart", "--wait", `${askGraceMs}ms`], {
        env: gatewayEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      cli.on("exit", (code, signal) => {
        cliExit = { code, signal };
      });
      cli.on("error", (error) => {
        cliExit = { code: null, signal: null, error };
      });
      cli.stderr.on("data", (d) => cliTail.append(d));
      cli.stdout.on("data", (d) => cliTail.append(d));
      const settled = await waitUntilGone(
        askGraceMs + kGatewayStopAskCliSlackMs,
        // A CLI that exited without the gateway going away refused the
        // request (or could not reach it): no point waiting out the grace.
        () => cliExit !== null && cliExit.code !== 0 && !gone(),
      );
      if (settled) how = kStopHow.GRACEFUL;
      else {
        const lastLine = cliTail.snapshot().slice(-1)[0] || "";
        console.warn(
          `[alphaclaw] gateway restart request was not honoured (openclaw gateway restart ${
            cliExit ? `exited ${cliExit.code ?? cliExit.signal ?? "with an error"}` : "did not settle inside the grace"
          }); escalating to SIGTERM${lastLine ? ` — ${lastLine}` : ""}`,
        );
      }
    } finally {
      // The CLI blocks on post-restart health until its own timeout; the
      // ladder owns the relaunch, so it is reaped as soon as the stop settles.
      if (cli && cli.exitCode === null && cli.signalCode === null) {
        try {
          cli.kill("SIGTERM");
        } catch {}
      }
    }
  }
  if (!how) {
    abortIfFenced("sigterm");
    onStep?.({ step: "stopping", status: "running", detail: { phase: "terminating" } });
    signalTree("SIGTERM");
    if (await waitUntilGone(termGraceMs)) how = kStopHow.SIGTERM;
  }
  if (!how) {
    abortIfFenced("sigkill");
    onStep?.({
      step: "stopping",
      status: "running",
      detail: { phase: "forcing", graceSeconds: Math.round((graceful ? askGraceMs : termGraceMs) / 1000) },
    });
    signalTree("SIGKILL");
    if (await waitUntilGone(killGraceMs)) how = kStopHow.SIGKILL;
  }
  if (!how) {
    const survivors = alivePids();
    throw new GatewayStopError(
      "stop_failed",
      `the gateway did not exit after SIGKILL (pid ${survivors.join(", ")} still alive)`,
      { pids, survivors, owner: identity.owner },
    );
  }
  console.log(
    `[alphaclaw] gateway stopped (${how}, ${Date.now() - stopStartedAt}ms, pids ${pids.join(", ")})`,
  );
  return { how, downAtMs: Date.now(), pids, identity };
};

// Cold restart pipeline (the manual Restart button, the env-change restart,
// channel restarts, team transitions, the watchdog's `replace` intent and
// the memory mitigation):
//
//   prelaunch hook ─refused/failed─► GatewayPrelaunchHookError (nothing stopped)
//        │ ran/unset
//        ▼
//   plugin preflight (gateway STILL SERVING; skipped on a matching hash)
//        ▼
//   shouldAbort?() ─true─► GatewayRestartError {aborted_by_caller} (nothing stopped)
//        ▼
//   stopGatewayLadder ─refused/failed─► GatewayStopError {stop_refused|stop_failed}
//        ▼
//   port still held by a stranger ─► GatewayRestartError {code: launch_failed}
//        ▼
//   requestGatewayLaunch({ prepared, deferAutotuneStamp }) ─not launch_requested─► GatewayRestartError
//        ▼
//   waitForGatewayReadiness(/readyz) ─child exited─► launch_failed (stderr tail)
//        │                            ─budget─────► ready_timeout (child left running; the watchdog's readiness ladder owns it)
//        │ ready, listener ∈ the new child's tree
//        ▼
//   stamp autotune, resolve the worker pid, notifyGatewayLaunch
//   { ok: true, durationMs, downtimeMs, how }
//
// Contract for every caller: a RESOLVED value means a NEW gateway is up and
// ready; every other outcome THROWS. `shouldAbort` is the caller's lease
// fence, checked before the hook, before the stop, between every poll of the
// ladder and the ready wait, and immediately before the spawn.
const runGatewayColdStart = async ({
  onStep = null,
  shouldAbort = null,
  deadlineAt = null,
  // Ladder grace overrides (tests drive the escalation in milliseconds).
  ladder = {},
} = {}) => {
  const abortIfFenced = (phase) => {
    if (shouldAbort?.()) {
      throw new GatewayRestartError(`Gateway restart aborted by caller before ${phase}`, {
        aborted: true,
        reason: kCallerAbortReason,
        phase,
      });
    }
  };
  const restartStartedAt = Date.now();
  abortIfFenced("prelaunch_hook");
  await prepareGatewayLaunch({ site: "restart" });
  onStep?.({ step: "preparing_plugins", status: "running" });
  const prep = await prepareOpenclawChannelPlugins();
  onStep?.({
    step: "preparing_plugins",
    status: prep?.failed ? "warning" : prep?.skipped ? "skipped" : "done",
  });
  abortIfFenced("stop");
  const stopStartedAt = Date.now();
  const stop = await stopGatewayLadder({ onStep, shouldAbort, deadlineAt, ...ladder });
  onStep?.({ step: "stopping", status: "done", detail: { how: stop.how } });
  const port = getGatewayPort();
  const strangers = gatewayIdentity.findPortListenerPids(port);
  if (strangers.length > 0) {
    throw new GatewayRestartError(
      `port ${port} is held by another process (pid ${strangers.join(", ")})`,
      { code: "launch_failed", listeners: strangers },
    );
  }
  abortIfFenced("launch");
  onStep?.({ step: "launching", status: "running" });
  const launch = await requestGatewayLaunch({
    site: "restart",
    prepared: true,
    deferAutotuneStamp: true,
    reconcileIncumbent: false,
    shouldAbort,
  });
  if (launch.outcome === kGatewayLaunchOutcomes.LAUNCH_ABORTED) {
    throw new GatewayRestartError(`Gateway launch aborted (${launch.detail})`, {
      aborted: true,
      reason: launch.detail === "lease_expired" ? kCallerAbortReason : launch.detail,
      code: "aborted",
    });
  }
  if (launch.outcome !== kGatewayLaunchOutcomes.LAUNCH_REQUESTED) {
    throw new GatewayRestartError(
      `Gateway launch did not start a new process (${launch.outcome}${launch.detail ? `: ${launch.detail}` : ""})`,
      { code: "launch_failed", outcome: launch.outcome, stderrTail: [] },
    );
  }
  const { child, generation, stderrTail, childEnv } = launch;
  onStep?.({ step: "launching", status: "done" });
  onStep?.({ step: "waiting_ready", status: "running", budgetMs: kGatewayRestartReadyTimeoutMs });
  let sawOwnershipWait = false;
  const onOutput = (d) => {
    if (!sawOwnershipWait && kStateOwnershipWaitPattern.test(String(d))) {
      sawOwnershipWait = true;
      onStep?.({ step: "waiting_ready", status: "running", budgetMs: kGatewayRestartReadyTimeoutMs, detail: { phase: "lock_wait" } });
    }
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  const childExited = () => child.exitCode !== null || child.signalCode !== null;
  let readiness;
  try {
    readiness = await waitForGatewayReadiness({
      url: `${getGatewayUrl()}/readyz`,
      budgetMs: kGatewayRestartReadyTimeoutMs,
      pollMs: kGatewayRestartReadyPollMs,
      shouldAbort: () => childExited() || isGatewayWaitsAborted() || shouldAbort?.() === true,
    });
  } finally {
    child.stdout?.off?.("data", onOutput);
    child.stderr?.off?.("data", onOutput);
  }
  if (!readiness.ready) {
    if (childExited()) {
      appendLockContentionEvidence(stderrTail, stderrTail.snapshot());
      throw new GatewayRestartError(
        `OpenClaw exited before it was ready (${
          child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`
        })`,
        { code: "launch_failed", stderrTail: stderrTail.snapshot(), exitCode: child.exitCode, signal: child.signalCode },
      );
    }
    if (isGatewayWaitsAborted()) {
      throw new GatewayRestartError(`Gateway restart aborted: ${gatewayWaitsAbortReason}`, {
        aborted: true,
        reason: gatewayWaitsAbortReason,
        code: "aborted",
        stderrTail: stderrTail.snapshot(),
      });
    }
    if (shouldAbort?.()) {
      throw new GatewayRestartError("Gateway restart aborted by caller while waiting for readiness", {
        aborted: true,
        reason: kCallerAbortReason,
        code: "aborted",
        stderrTail: stderrTail.snapshot(),
      });
    }
    // The new process is up but not ready inside the budget. It stays as the
    // managed child: the watchdog's readiness ladder (transitional budget →
    // degraded → repair) owns it from here, and a retry runs the ladder.
    console.warn(
      `[alphaclaw] Gateway did not report ready within ${kGatewayRestartReadyTimeoutMs}ms (last: ${readiness.last?.kind ?? "none"}${readiness.last?.status ? ` ${readiness.last.status}` : ""})`,
    );
    throw new GatewayRestartError(
      `OpenClaw did not become ready within ${Math.round(kGatewayRestartReadyTimeoutMs / 1000)}s`,
      {
        code: "ready_timeout",
        budgetMs: kGatewayRestartReadyTimeoutMs,
        readiness: readiness.last ?? null,
        stderrTail: stderrTail.snapshot(),
      },
    );
  }
  // Ready — from OUR child? The listener behind the port must be in the new
  // child's tree, or another process took the port between stop and spawn.
  const tree = gatewayIdentity.listProcessTree(child.pid);
  const listeners = gatewayIdentity.findPortListenerPids(port);
  const worker = listeners.find((pid) => tree.includes(pid)) ?? null;
  if (listeners.length > 0 && !worker) {
    throw new GatewayRestartError(
      `another process answered on port ${port} (pid ${listeners.join(", ")}) — the new gateway is not the one serving`,
      { code: "launch_failed", listeners, generation, stderrTail: stderrTail.snapshot() },
    );
  }
  if (gatewayChild === child) {
    gatewayChildWorkerPid = worker ?? resolveFirstChildPid(child.pid) ?? null;
    launch.identity.workerPid = gatewayChildWorkerPid;
  }
  // Stamp only now: the NEW gateway is proven up and ready — a spawn that
  // never got here must not leave rows claiming it consumed this env.
  stampAutotuneFromChildEnv(childEnv);
  // durationMs = the whole operation (prepare → ready), what "restarted in
  // Ns" means; downtimeMs = stop initiated → ready, what the operator felt.
  const durationMs = Date.now() - restartStartedAt;
  console.log(
    `[alphaclaw] Gateway restart ready (${durationMs}ms total, down ${Date.now() - stopStartedAt}ms; stop ${stop.how}; launcher pid ${child.pid}${
      gatewayChildWorkerPid ? `, gateway pid ${gatewayChildWorkerPid}` : ""
    })`,
  );
  await notifyGatewayLaunch();
  return {
    ok: true,
    durationMs,
    downtimeMs: Date.now() - stopStartedAt,
    how: stop.how,
  };
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

// The adopted launcher's gateway child via /proc PPid links (Linux only; null
// where /proc is unavailable or nothing matches). Only a child whose process
// name is OpenClaw's counts: the launcher's sole child is the gateway (title
// `openclaw-gateway`), while in the no-launcher shape (compile cache
// disabled) the `--force` process IS the gateway and its children are plugin
// helpers — handing one of those to the restart-handoff consume would reject
// a genuine gateway-requested restart. Bounded scan, synchronous reads.
const kMaxProcScanForChild = 8192;
const kOpenclawProcessNamePattern = /^openclaw/i;
const resolveFirstChildPid = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  let scanned = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    if (++scanned > kMaxProcScanForChild) break;
    const candidate = Number.parseInt(name, 10);
    if (candidate === pid) continue;
    try {
      const status = fs.readFileSync(`/proc/${candidate}/status`, "utf8");
      const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
      if (!ppidMatch || Number.parseInt(ppidMatch[1], 10) !== pid) continue;
      // `Name:` is the kernel comm (the first 15 bytes of the process title).
      const nameMatch = status.match(/^Name:\s+(\S+)/m);
      if (nameMatch && kOpenclawProcessNamePattern.test(nameMatch[1])) {
        return candidate;
      }
    } catch {
      // Raced with exit or unreadable: skip.
    }
  }
  return null;
};

// Exit classification for a MANAGED gateway child (every `gateway run` spawn
// — boot, watchdog relaunches and the cold restart all go through
// requestGatewayLaunch) — one owner so the watchdog sees every managed exit
// the same way. `identity.workerPid` is a MUTABLE slot the launch fills once
// the gateway is listening (the launcher/worker split is resolved from /proc
// after the spawn), read at exit time so the handoff consume gets the
// gateway's pid, not the launcher's.
const attachManagedGatewayExitClassification = (
  child,
  { stderrTail, launchedAt, identity = { workerPid: null }, generation = null },
) => {
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
    // Release the managed slot BEFORE the watchdog classifies: a synchronous
    // relaunch decision inside the handler must never see the dead child as
    // "already running" (requestGatewayLaunch's alive guard) and skip.
    if (gatewayChild === child) {
      gatewayChild = null;
      gatewayChildWorkerPid = null;
      gatewayChildGeneration = null;
    }
    const workerPid = identity.workerPid ?? null;
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
          // The real gateway's pid (the handoff row is keyed by it); null
          // when the launcher/worker split was never resolved.
          workerPid,
          // Launcher shape: the launcher relays the worker's exit code, so an
          // EXPECTED stop can land as code 1 (the worker hit its own drain
          // deadline) — our own stop, not a crash.
          supervisor: workerPid != null && workerPid !== child.pid,
          launchedAt,
          // The launch generation this child was spawned under (null for a
          // legacy caller): the watchdog's exit fence ignores an exit from a
          // generation older than the one currently serving.
          generation,
        });
      } catch (err) {
        console.error(`[alphaclaw] Gateway exit handler error: ${err.message}`);
      }
    }
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
};

// Alive guard shared by requestGatewayLaunch and notifyGatewayLaunch: a
// managed child that has not exited and was not killed by us.
const isManagedGatewayChildLive = () =>
  !!(gatewayChild && gatewayChild.exitCode === null && !gatewayChild.killed);

// The one relaunch primitive. Every caller — boot, the watchdog's repair /
// crash restart / medic / config retry, the light restart — gets ONE result
// shape and NEVER an exception:
//
//   { outcome, child, pid, generation, serving, error, detail }
//
//   alive guard ─live child─► child_retained {child, pid}   (no spawn, no handler)
//        │ none
//        ▼
//   reconcileIncumbent ∧ isGatewayRunning() ─► incumbent_present {serving}  ◄─ reconcile point 1
//        │ port closed / reconcile off        (serving = resolveServingIdentity(),
//        ▼                                     null when ambiguous; no handler fires)
//   preflight: prelaunch hook ─refused/failed─► launch_aborted {detail: prelaunch_hook}
//              plugin preflight ─threw───────► launch_failed {error}
//        │ ok (minutes may have passed)
//        ▼
//   shutdown aborted? ─► launch_aborted {detail: shutdown}
//   alive guard again ─► child_retained          ┐ reconcile point 2: the world
//   reconcileIncumbent ∧ isGatewayRunning() ─► incumbent_present ┘ moved during the awaits
//   shouldAbort?() ─true─► launch_aborted {detail: lease_expired}   (the caller's lease fence:
//        │ false/unset                                               checked before AND after the
//        ▼                                                           point-2 port probe, and here,
//                                                                    immediately before spawn)
//        ▼
//   spawn `gateway run` ─threw─► launch_failed {error}
//        │
//        ▼
//   launch_requested {child, pid, generation = ++gatewayLaunchGeneration}
//   (NOT yet proven serving — the watchdog verifies readiness + identity)
//
// incumbent_present fires NO launch handler: gateway.js has no intent (adopt?
// replace?), so it returns the discovered identity and lets the watchdog —
// which owns the health probe and the corpse check — decide. Boot's
// notifyGatewayLaunch() (no intent) keeps notifying as it always did.
const kGatewayLaunchSpawnArgs = ["gateway", "run"];
const requestGatewayLaunch = async ({
  site = "managed launch",
  reconcileIncumbent = true,
  shouldAbort = null,
  // The cold restart runs the prelaunch hook and the plugin preflight BEFORE
  // stopping the old gateway (it keeps serving meanwhile); `prepared` skips
  // both here so neither runs twice. `deferAutotuneStamp` leaves the autotune
  // ledger untouched until the caller has proven the new gateway ready.
  prepared = false,
  deferAutotuneStamp = false,
} = {}) => {
  const result = (outcome, fields = {}) => ({
    outcome,
    child: null,
    pid: null,
    generation: null,
    serving: null,
    error: null,
    detail: null,
    ...fields,
  });
  const retained = () => {
    console.log(
      "[alphaclaw] Managed gateway process already running — skipping launch",
    );
    return result(kGatewayLaunchOutcomes.CHILD_RETAINED, {
      child: gatewayChild,
      pid: gatewayChild.pid ?? null,
      generation: gatewayChildGeneration,
    });
  };
  const incumbent = () => {
    const serving = resolveServingIdentitySafe();
    return result(kGatewayLaunchOutcomes.INCUMBENT_PRESENT, {
      serving,
      pid: serving?.rootPid ?? null,
    });
  };
  const aborted = (detail) => result(kGatewayLaunchOutcomes.LAUNCH_ABORTED, { detail });
  const failed = (error) =>
    result(kGatewayLaunchOutcomes.LAUNCH_FAILED, {
      error,
      detail: String(error?.message || error),
    });

  if (isManagedGatewayChildLive()) return retained();
  if (reconcileIncumbent && (await isGatewayRunning())) return incumbent();
  if (!prepared) {
    // Fail closed on the prelaunch hook: launch_aborted = "no gateway was
    // started". The outcome reached the hook handler before this returns;
    // nothing is thrown into a caller that only logs.
    try {
      await prepareGatewayLaunch({ site });
    } catch (error) {
      if (error instanceof GatewayPrelaunchHookError) return aborted("prelaunch_hook");
      return failed(error);
    }
    try {
      await prepareOpenclawChannelPlugins();
    } catch (error) {
      return failed(error);
    }
  }
  // A launch cancelled by shutdown must never spawn a fresh gateway child —
  // the aborted preflight above swallows its own abort and returns.
  if (isGatewayWaitsAborted()) return aborted("shutdown");
  // Reconcile point 2: the preflight can take minutes; a child may have been
  // spawned (a concurrent caller) or an incumbent may have taken the port
  // meanwhile. Launching into either is the duplicate launch this exists to
  // prevent.
  if (isManagedGatewayChildLive()) return retained();
  if (shouldAbort?.()) return aborted("lease_expired");
  if (reconcileIncumbent && (await isGatewayRunning())) return incumbent();
  if (shouldAbort?.()) return aborted("lease_expired");
  // Captured by THIS child's handlers below: its finalize — whether 'close'
  // or the bounded post-'exit' drain timeout gets there first — snapshots
  // this tail, never a successor launch's.
  const stderrTail = createStderrTail();
  const launchedAt = Date.now();
  // gatewayLaunchEnv, not gatewayEnv: only the long-running daemon gets the
  // operator's explicit heap cap (issue #24). The autotune stamp reads the
  // SAME env the child consumes — never a differently-built copy.
  const childEnv = gatewayLaunchEnv();
  let child;
  try {
    // detached: the launcher becomes its own process-group leader, so the
    // stop ladder can signal launcher + gateway worker + helpers as one group
    // (a SIGKILL to the launcher alone orphans the worker on the port).
    child = spawn("openclaw", kGatewayLaunchSpawnArgs, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    return failed(error);
  }
  const generation = ++gatewayLaunchGeneration;
  gatewayChild = child;
  gatewayChildWorkerPid = null;
  gatewayChildGeneration = generation;
  // Start ticks read once at spawn: the pid is live here and the value is
  // immutable for the process's life (the watchdog's pid-reuse guard).
  const startTicks = lockContention.readProcStartTicks(child.pid);
  // Autotune stamp at spawn for the boot / watchdog relaunch callers (there
  // is no in-process ready signal for them — the watchdog probes); a spawn
  // 'error' reverts it so a failed launch never reads as "applied". The cold
  // restart defers it and stamps once the new gateway is proven ready.
  const autotuneStamp = deferAutotuneStamp ? null : stampAutotuneFromChildEnv(childEnv);
  // The launcher/worker split is resolved from /proc once the gateway is
  // listening: the process holding the port inside this child's tree is the
  // gateway. Shared with the exit classifier through this mutable slot.
  const identity = { workerPid: null };
  const resolveWorker = () => {
    if (identity.workerPid != null) return identity.workerPid;
    const tree = gatewayIdentity.listProcessTree(child.pid);
    const listener = gatewayIdentity
      .findPortListenerPids(getGatewayPort())
      .find((pid) => tree.includes(pid));
    identity.workerPid = listener ?? resolveFirstChildPid(child.pid) ?? null;
    if (gatewayChild === child) gatewayChildWorkerPid = identity.workerPid;
    return identity.workerPid;
  };
  // OpenClaw's ready line: "http server listening (N plugins; Xs)" on the
  // pinned line, "listening on <addr>" on older ones — match the verb, not
  // one build's suffix.
  let didSignalGatewayReady = false;
  child.stdout.on("data", (d) => {
    const text = Buffer.isBuffer(d) ? d.toString("utf8") : String(d ?? "");
    if (
      !didSignalGatewayReady &&
      gatewayLaunchHandler &&
      /server listening|listening on/i.test(text)
    ) {
      didSignalGatewayReady = true;
      const workerPid = resolveWorker();
      try {
        gatewayLaunchHandler({
          startedAt: Date.now(),
          pid: child.pid,
          // Serving pid = the gateway worker behind the launcher (the memory
          // monitor samples it); the launcher pid when /proc cannot tell.
          servingPid: workerPid ?? child.pid,
          rootPid: child.pid,
          startTicks,
          generation,
          supervision: "managed",
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
  attachManagedGatewayExitClassification(child, { stderrTail, launchedAt, identity, generation });
  return result(kGatewayLaunchOutcomes.LAUNCH_REQUESTED, {
    child,
    pid: child.pid ?? null,
    generation,
    identity,
    stderrTail,
    childEnv,
  });
};

// Compatibility wrapper (boot, the light restart, legacy watchdog harnesses):
// the pre-outcome contract — a child handle, null for an aborted launch, a
// THROWN error for a failed one. No incumbent reconcile (its callers already
// probed the port themselves), so behaviour is byte-identical to before.
const launchGatewayProcess = async ({ shouldAbort = null } = {}) => {
  const launch = await requestGatewayLaunch({ reconcileIncumbent: false, shouldAbort });
  if (launch.outcome === kGatewayLaunchOutcomes.LAUNCH_FAILED) throw launch.error;
  return launch.child ?? null;
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

// Launch notification for a gateway that is UP (port answers) — after a cold
// restart, or at boot around an already-running gateway. Three identities:
//   managed   a live managed child: launcher/root = child.pid, serving pid =
//             the worker resolved from /proc (the listener inside the child's
//             tree) or the child itself
//   adopted   no live child, one unambiguous serving tree in /proc — the
//             discovered root/worker/start ticks (memory monitor, pid-reuse
//             guard and stale-predecessor fence all work for the incumbent)
//   detached  no live child and no unambiguous identity — every pid null
//             (today's shape); the watchdog tracks the gateway by TCP only
// `pid` keeps its meaning of "the child AlphaClaw spawned" (null otherwise).
const notifyGatewayLaunch = async ({ shouldAbort = null } = {}) => {
  if (!gatewayLaunchHandler || shouldAbort?.()) return;
  if (!(await isGatewayRunning())) return;
  if (shouldAbort?.()) return;
  const startedAt = Date.now();
  let payload;
  if (isManagedGatewayChildLive() && gatewayChild.pid) {
    const rootPid = gatewayChild.pid;
    if (gatewayChildWorkerPid == null) {
      const tree = gatewayIdentity.listProcessTree(rootPid);
      gatewayChildWorkerPid =
        gatewayIdentity.findPortListenerPids(getGatewayPort()).find((pid) => tree.includes(pid)) ??
        resolveFirstChildPid(rootPid) ??
        null;
    }
    payload = {
      startedAt,
      pid: rootPid,
      servingPid: gatewayChildWorkerPid ?? rootPid,
      rootPid,
      startTicks: lockContention.readProcStartTicks(rootPid),
      generation: gatewayChildGeneration,
      supervision: "managed",
    };
  } else {
    const identity = resolveServingIdentitySafe();
    payload = {
      startedAt,
      pid: null,
      servingPid: identity?.workerPid ?? identity?.rootPid ?? null,
      rootPid: identity?.rootPid ?? null,
      startTicks: identity?.startTicks ?? null,
      generation: null,
      supervision: identity ? "adopted" : "detached",
    };
  }
  try {
    gatewayLaunchHandler(payload);
  } catch (err) {
    console.error(`[alphaclaw] Gateway launch handler error: ${err.message}`);
  }
};

const startGateway = async ({ shouldAbort = null } = {}) => {
  if (shouldAbort?.()) return;
  if (!isOnboarded()) {
    console.log("[alphaclaw] Not onboarded yet — skipping gateway start");
    return;
  }
  const running = await isGatewayRunning();
  if (shouldAbort?.()) return;
  if (running) {
    console.log("[alphaclaw] Gateway already running — skipping start");
    await notifyGatewayLaunch({ shouldAbort });
    return;
  }
  console.log("[alphaclaw] Starting openclaw gateway...");
  return launchGatewayProcess({ shouldAbort });
};

const restartGateway = async (reloadEnv, options = {}) => {
  reloadEnv();
  return runGatewayColdStart(options);
};

// Shutdown-path gateway stop for the lifecycle orchestrator (used instead of
// the plain SIGTERM/SIGINT handlers when server.js owns graceful shutdown).
// Cancels in-flight lifecycle waits FIRST via abortGatewayWaits — never waits
// out a ready window inside the shutdown deadline — then runs the stop ladder
// without the graceful ask (there is no supervisor left to relaunch into)
// inside a fixed slice of the process deadline, so the old gateway cannot
// keep the port and wedge the successor into "already running, skipping".
// A refused stop (foreign/unknown listener) is logged, not thrown: shutdown
// proceeds either way.
const stopGatewayForShutdown = async ({ budgetMs = kGatewayShutdownStopBudgetMs } = {}) => {
  abortGatewayWaits("shutdown");
  const deadlineAt = Date.now() + budgetMs;
  try {
    await stopGatewayLadder({
      deadlineAt,
      allowGracefulRestart: false,
      termGraceMs: Math.max(1000, Math.floor(budgetMs * 0.6)),
      killGraceMs: Math.max(500, Math.floor(budgetMs * 0.3)),
    });
  } catch (error) {
    console.warn(
      `[alphaclaw] shutdown gateway stop: ${String(error?.message || error)}`,
    );
  }
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

    // Control UI mount contract (control-ui-mount.js): the gateway serves the
    // dashboard under gateway.controlUi.basePath=/openclaw so the UI resolves
    // fonts, themes, sw.js and its bootstrap config from the base path the
    // gateway stamps into index.html, and routes/proxy.js forwards /openclaw*
    // verbatim. Prefix-stripping against a root-mounted gateway (pre-v0.9.83)
    // 404'd every one of those and showed "Styles failed to load". Mode-aware:
    // ALPHACLAW_CONTROL_UI_MOUNT=legacy removes OUR key so the strip-mode proxy
    // and the gateway agree again. Runs regardless of `origin`.
    console.log(
      `[alphaclaw] control_ui_mount=${kControlUiMount} basePath=${
        kControlUiMount === "legacy" ? "(removed)" : kControlUiBasePath
      }`,
    );
    if (applyControlUiBasePath(cfg, { mount: kControlUiMount, log: console.log }).changed) {
      changed = true;
    }

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
      // Atomic under the same lock: a torn openclaw.json is a wiped gateway
      // config on the next fail-open reader (F013).
      writeFileAtomic(configPath, content, { fsModule: fs });
      invalidateOpenclawConfigMemo();
    }
    return changed;
    });
  } catch (e) {
    console.error(`[alphaclaw] ensureGatewayProxyConfig error: ${e.message}`);
    return false;
  }
};

// Token → ${ENV} scrub after `openclaw channels add` wrote the literal token
// into openclaw.json. Locked (the team-mode and proxy-config writers share
// the file lock) and atomic — the previous raw readFileSync/writeFileSync pair
// raced cross-process writers and could leave a torn file (F013). A text
// replace, not a JSON walk: the file was just written by openclaw and must be
// left byte-identical apart from the token occurrences.
const scrubTokensInOpenclawConfig = (configPath, replacements) =>
  withFileLockSync(configPath, () => {
    let raw = fs.readFileSync(configPath, "utf8");
    let changed = false;
    for (const { value, envKey } of replacements) {
      if (!value || !raw.includes(value)) continue;
      raw = raw.split(value).join("${" + envKey + "}");
      changed = true;
    }
    if (changed) {
      writeFileAtomic(configPath, raw, { fsModule: fs });
      invalidateOpenclawConfigMemo();
    }
    return changed;
  });

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
            scrubTokensInOpenclawConfig(configPath, [
              { value: token, envKey: def.envKey },
              { value: appToken, envKey: def.extraEnvKeys[0] },
            ]);
          } else {
            await execChannelCmd([
              "channels",
              "add",
              "--channel",
              ch,
              "--token",
              token,
            ]);
            scrubTokensInOpenclawConfig(configPath, [{ value: token, envKey: def.envKey }]);
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

// Signal the managed child's whole process group (the detached spawn makes
// the launcher its own group leader, so this reaches the gateway worker and
// its helpers in one call) or, when the child is not a group leader we own,
// the child alone. `force` exists for SIGKILL escalation: child.kill() sets
// `.killed` the moment a signal is SENT, so without it the escalation would
// see killed===true and never deliver. Returns true when a signal went out.
const signalManagedGatewayChild = ({ signal = "SIGTERM", force = false } = {}) => {
  const child = gatewayChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  if (!force && child.killed) return false;
  const pgid = gatewayIdentity.readProcessGroupId(child.pid);
  const ownGroup = gatewayIdentity.readProcessGroupId(process.pid);
  if (pgid != null && pgid === child.pid && pgid !== ownGroup) {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch {}
  }
  try {
    child.kill(signal);
    return true;
  } catch {}
  return false;
};

// Legacy name kept for the lifecycle orchestrator and tests.
const stopGatewayChild = (options = {}) => signalManagedGatewayChild(options);

// Last-ditch synchronous reap for the shutdown deadline / abandoned-drain
// escape hatches (server-lifecycle): SIGKILL the managed group — launcher AND
// worker — so a second signal or a hung earlier shutdown step still leaves
// the port free. Returns false when there was nothing to kill.
const killManagedGatewayChildNow = () => {
  markManagedGatewayExitExpected();
  return signalManagedGatewayChild({ signal: "SIGKILL", force: true });
};

// SIGTERM alone is a request, not a guarantee: a stuck gateway that keeps the
// port makes the respawned server treat the OLD version as healthy. Escalate
// to SIGKILL after a short grace and wait for the exit before the respawn.
const stopGatewayChildAndWait = async ({ graceMs = 2000, shouldAbort = null } = {}) => {
  if (shouldAbort?.()) return false;
  const child = gatewayChild;
  markManagedGatewayExitExpected();
  if (!signalManagedGatewayChild({ signal: "SIGTERM" })) return true;
  const exited = () =>
    !child || child.exitCode !== null || child.signalCode !== null;
  const waitUntil = async (deadline) => {
    while (!exited() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100).unref?.());
    }
    return exited();
  };
  if (await waitUntil(Date.now() + graceMs)) return true;
  // The grace wait may outlive its caller's lease or tracked child. Never
  // escalate against a successor installed during that wait.
  if (shouldAbort?.() || gatewayChild !== child) return false;
  signalManagedGatewayChild({ signal: "SIGKILL", force: true });
  return waitUntil(Date.now() + 1000);
};


module.exports = {
  gatewayEnv,
  isSupervisorModeActive,
  gatewayLaunchEnv,
  stopGatewayChild,
  stopGatewayChildAndWait,
  killManagedGatewayChildNow,
  getManagedGatewayWorkerPid: () => gatewayChildWorkerPid,
  getGatewayPort,
  getGatewayUrl,
  isOnboarded,
  isGatewayRunning,
  probeGatewayTcp,
  getGatewayTcpObservation,
  setGatewayTcpTransitionHandler,
  launchGatewayProcess,
  requestGatewayLaunch,
  kGatewayLaunchOutcomes,
  isCallerAbortError,
  getLaunchGeneration,
  resolveServingIdentity,
  resolveGatewayIdentity,
  listGatewayPids,
  cleanupOpenclawPluginInstallStages,
  prepareOpenclawChannelPlugins,
  setGatewayExitHandler,
  setGatewayLaunchHandler,
  GatewayRestartError,
  GatewayStopError,
  GatewayPrelaunchHookError,
  abortGatewayWaits,
  startGateway,
  restartGateway,
  stopGatewayLadder,
  kStopHow,
  stopGatewayForShutdown,
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
  minimalHookEnv,
  kGatewayPrelaunchHookPath,
  kGatewayPrelaunchHookGraceMs,
  kGatewayStopAskGraceMs,
  kGatewayStopTermGraceMs,
  kGatewayStopKillGraceMs,
  kGatewayShutdownStopBudgetMs,
};
