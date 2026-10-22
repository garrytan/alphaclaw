const path = require("path");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const { resolveOpenclawChildConfigPath } = require("./openclaw-config-path");

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
  kGatewayStopAskGraceMs,
  kGatewayRoutineRestartGraceMs,
  kGatewayStopAskAckMs,
  kGatewayStopAskReserveMs,
  kGatewayStopTermGraceMs,
  kGatewayStopKillGraceMs,
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
const lsofShim = require("./lsof-shim");
const { waitForGatewayReadiness, probeGatewayReadiness } = require("./gateway-readiness");
const askOutcome = require("./gateway-ask-outcome");
const { redactSecretShapes } = require("./utils/redact");
const {
  formatRestartLogLine,
  logRestart,
  redactEvidenceLine,
  appendLockContentionEvidence,
  createStderrTail,
} = require("./gateway-restart-log");
// Every restart and stop carries an operation id. One minted here means the
// caller did not pass its own: the ladder still logs a real id, and a restart
// with no source says so loudly so the caller can be found and fixed.
const mintRestartOpId = (source) => {
  const opId = crypto.randomUUID();
  if (!source) console.warn(`[alphaclaw] restart op=${opId.slice(0, 8)} has no source: a caller did not attribute this restart`);
  return opId;
};
// How long OpenClaw may drain before the ladder escalates depends on who
// asked (ALPH-17). Routine restarts (an operator, a channel or team change)
// wait ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS; a watchdog repair replaces an
// unhealthy gateway and keeps the short grace; the memory mitigation passes
// its own resolver. An unattributed caller gets the short grace it always had.
const kRestartClasses = Object.freeze({ ROUTINE: "routine", REPAIR: "repair", MEMORY: "memory" });
const resolveRestartClass = (source) => {
  const value = String(source || "");
  if (value === "watchdog:memory_mitigation") return kRestartClasses.MEMORY;
  if (/^(api|channels|team):/.test(value)) return kRestartClasses.ROUTINE;
  return kRestartClasses.REPAIR;
};
const {
  cleanupOpenclawPluginInstallStages,
  hasEnabledChannelConfig,
  isInstallStageFailure,
  computeDesiredPluginStateHash,
} = require("./gateway-plugin-preflight");

let gatewayChild = null;
// The managed child's real gateway pid. Under AlphaClaw's NODE_COMPILE_CACHE
// the `openclaw` binary is a compile-cache launcher that respawns the gateway
// as its child and forwards signals to it (openclaw.mjs → runRespawnedChild),
// so the process holding the port is the launcher's child, not `child.pid`.
// Resolved from /proc once the gateway is listening; carried into exit
// classification (the restart-handoff row is keyed by the GATEWAY's pid) and
// to the watchdog as the serving pid (memory monitor, pid-reuse guard).
let gatewayChildWorkerPid = null;
// True only when gatewayChildWorkerPid is the process holding the gateway
// port (found in the child's tree, the root itself included); false for the
// first-child fallback. The memory monitor's worker basis requires it.
let gatewayChildWorkerVerified = false;
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
// Called (never awaited) when a cold restart is requested, while the old
// gateway still admits work: the wedge sweep records which sessions were
// running (session-wedge-sweep.js). It can never delay or fail a restart.
let gatewayRestartRequestedHandler = null;
const kPluginRuntimeDepsPreflightTimeoutMs = 120 * 1000;
// Stop ladder (restart + shutdown). Step 1 asks OpenClaw to restart itself
// (`gateway restart --wait <askGrace>`: admission closes, the agent's turn
// compacts, active work drains inside the grace, the gateway exits 0 with a
// handoff row); step 2 SIGTERMs the gateway's process group; step 3 SIGKILLs
// it. Each wait is bounded; the ladder as a whole is bounded by the caller's
// deadline (restart: the operation budget; shutdown: the process deadline).
// The step durations live in constants.js beside the operation budget that
// must cover them.
const kGatewayStopPollMs = 250;
// The ask's whole budget is the grace OpenClaw drains for, plus the CLI's
// 10 s gateway.restart.request ack window (it can land late under load), plus
// OpenClaw's 15 s post-drain shutdown reserve, so an accepted drain and its
// cleanup always fit inside the wait.
const gatewayStopAskBudgetMs = (askGraceMs) => askGraceMs + kGatewayStopAskAckMs + kGatewayStopAskReserveMs;
// After a non-zero ask exit the gateway's state decides (gateway-ask-outcome.js):
// /readyz is probed this often, each probe bounded well under the interval
// the ladder can afford.
const kGatewayStopAskProbeIntervalMs = 500;
const kGatewayStopAskProbeTimeoutMs = 1500;
// `ALPHACLAW_GATEWAY_STOP_ASK=0` skips the ask step everywhere (operator
// escape hatch: a pin whose `gateway restart` misbehaves); the step is then
// recorded as skipped with reason caller_disabled, never silently.
const isGatewayStopAskDisabled = (env = process.env) =>
  String(env.ALPHACLAW_GATEWAY_STOP_ASK ?? "").trim() === "0";
// Ask-preflight skip reasons — the step detail and the log line carry one of
// these, and the runbook explains each (docs/upgrade-troubleshooting.md).
const kAskSkipReasons = Object.freeze({
  NO_LSOF: "no_lsof",
  NO_RESPAWN_PINNED: "no_respawn_pinned",
  NO_WORKER: "no_worker",
  NO_BUDGET: "no_budget",
  CALLER_DISABLED: "caller_disabled",
});
const kAskSkipFixes = Object.freeze({
  no_lsof: "install lsof (apt-get install -y lsof) — OpenClaw's restart CLI finds the gateway with it",
  no_respawn_pinned: "unset OPENCLAW_NO_RESPAWN so the gateway can exit for a full-process restart",
  no_worker: "no gateway worker was identified; nothing to ask",
  no_budget: "the operation deadline cannot fit the ask grace",
  caller_disabled: "ALPHACLAW_GATEWAY_STOP_ASK=0 or a shutdown/replace caller",
});
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

const setGatewayExitHandler = (handler) => {
  gatewayExitHandler = typeof handler === "function" ? handler : null;
};

const setGatewayLaunchHandler = (handler) => {
  gatewayLaunchHandler = typeof handler === "function" ? handler : null;
};

const setGatewayRestartRequestedHandler = (handler) => {
  gatewayRestartRequestedHandler = typeof handler === "function" ? handler : null;
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
  OPENCLAW_CONFIG_PATH: resolveOpenclawChildConfigPath(OPENCLAW_DIR),
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
// restart, in-place light restart — every launch is `gateway run`). Throws
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
// watchdog restarts, the stop ladder), so the gateway must skip its internal
// self-restart supervisor and defer to us. It defaults ON with an
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
      OPENCLAW_CONFIG_PATH: resolveOpenclawChildConfigPath(OPENCLAW_DIR),
      OPENCLAW_STATE_DIR: OPENCLAW_DIR,
      XDG_CONFIG_HOME: OPENCLAW_DIR,
      // AlphaClaw runs exactly the pinned openclaw; the gateway (or the agent
      // running inside it) must never self-update out from under the pin.
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
  // OpenClaw 2026.10 prints only "The CLI command failed." for a failed
  // `gateway run` unless OPENCLAW_DEBUG is set (2026.9.8 always printed the
  // Reason line). The crash classifier and incident bundles read that line.
  if (env.OPENCLAW_DEBUG === undefined) env.OPENCLAW_DEBUG = "1";
  return env;
};

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
// The kernel stamps mtime from a coarse clock (one tick is a few ms), so two
// writes in one tick share an mtimeMs: a rewrite right after our read would
// look unchanged. A memo whose file was modified this close to the read is
// re-read instead of trusted (git's "racily clean" rule).
const kOpenclawConfigRacyMtimeMs = 100;
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
    if (
      mtimeMs !== null &&
      mtimeMs === openclawConfigMemo.mtimeMs &&
      openclawConfigMemo.at - mtimeMs > kOpenclawConfigRacyMtimeMs
    ) {
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

// Live openclaw GATEWAY pids (managed child, external `gateway run`, a legacy
// `gateway --force` root from an older AlphaClaw) from the read-only /proc scan in
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
  // The port listener inside the root's tree proves the worker (the root
  // itself when it serves directly); the first child is only a guess.
  const tree = gatewayIdentity.listProcessTree(rootPid);
  const listener = gatewayIdentity.findPortListenerPids(getGatewayPort()).find((pid) => tree.includes(pid));
  return {
    rootPid,
    workerPid: listener ?? resolveFirstChildPid(rootPid) ?? null,
    workerVerified: listener != null,
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

// ── Inventory ────────────────────────────────────────────────────────────
// Everything the stop ladder can touch, classified (bug #137 RC3). The
// inventory is the managed child's /proc TREE ∪ every member of its PROCESS
// GROUP (a service the agent started through `exec` and left running has
// ppid 1 once its parent died, so the tree walk misses it, but it still
// carries the launcher's pgid and dies with the group signal). Classes:
//   gateway  an OpenClaw PROGRAM (argv rules 1/2/2b; the root and the worker
//            are always in) — "gone" and survivors are judged on these only
//   helper   parent is in the gateway set (plugins, MCP servers, browsers)
//   other    everything else — what the operator cares about
// `cmd` is comm + a JS runtime's script basename, nothing else (one shared
// redactor, lib/server/utils/redact.js).
const kProcessClasses = Object.freeze({ GATEWAY: "gateway", HELPER: "helper", OTHER: "other" });
const kMaxInventoryEntries = 256;

const buildInventory = ({ rootPid, workerPid, pgid, tree, previous = null }) => {
  const pids = new Set(Array.isArray(tree) ? tree : []);
  if (rootPid != null) pids.add(rootPid);
  if (pgid != null) for (const pid of gatewayIdentity.listProcessGroupMembers(pgid)) pids.add(pid);
  if (previous) for (const pid of previous.keys()) pids.add(pid);
  const entries = new Map();
  for (const pid of [...pids].sort((a, b) => a - b).slice(0, kMaxInventoryEntries)) {
    const known = previous?.get(pid);
    if (known) {
      entries.set(pid, known);
      continue;
    }
    const isGateway =
      pid === rootPid || pid === workerPid || gatewayIdentity.isOpenclawProgramPid(pid);
    entries.set(pid, {
      pid,
      ppid: lockContention.readProcParentPid(pid),
      cmd: redactEvidenceLine(gatewayIdentity.describeProcessCommand(pid), 80),
      class: isGateway ? kProcessClasses.GATEWAY : null,
      startTicks: lockContention.readProcStartTicks(pid),
    });
  }
  for (const entry of entries.values()) {
    if (entry.class) continue;
    entry.class = entries.get(entry.ppid)?.class === kProcessClasses.GATEWAY
      ? kProcessClasses.HELPER
      : kProcessClasses.OTHER;
  }
  return entries;
};

const summarizeInventory = (entries) => {
  const gateway = [];
  const other = [];
  let helpers = 0;
  for (const entry of entries.values()) {
    if (entry.class === kProcessClasses.GATEWAY) gateway.push({ pid: entry.pid, cmd: entry.cmd });
    else if (entry.class === kProcessClasses.HELPER) helpers += 1;
    else other.push({ pid: entry.pid, cmd: entry.cmd });
  }
  return { gateway, helpers, other };
};

const resolveGatewayIdentity = () => {
  const port = getGatewayPort();
  const listeners = gatewayIdentity.findPortListenerPids(port);
  const finish = (owner, rootPid, tree, workerHint) => {
    const pids = tree.length ? tree : [rootPid];
    const foreignListeners = listeners.filter((pid) => !pids.includes(pid));
    const workerPid =
      listeners.find((pid) => pids.includes(pid)) ?? workerHint ?? null;
    // A group we may signal as one: the root is its own group leader (the
    // detached spawn below) and it is not OUR group.
    const pgid = (() => {
      const candidate = gatewayIdentity.readProcessGroupId(rootPid);
      return candidate != null &&
        candidate === rootPid &&
        candidate !== gatewayIdentity.readProcessGroupId(process.pid)
        ? candidate
        : null;
    })();
    const inventory = buildInventory({ rootPid, workerPid, pgid, tree: pids });
    return {
      owner: foreignListeners.length ? kIdentityOwners.FOREIGN : owner,
      rootPid,
      workerPid,
      pids,
      pgid,
      startTicks: snapshotStartTicks(pids),
      inventory,
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
      inventory: new Map(),
      listeners,
      foreignListeners: listeners,
    };
  }
  return finish(kIdentityOwners.ADOPTED, listeners[0], [...listeners], listeners[0]);
};

// The identity as the record, the log and `alphaclaw diagnose` carry it:
// pids and argument-free command descriptions only.
const describeIdentity = (identity) => {
  if (!identity) return null;
  const summary = summarizeInventory(identity.inventory ?? new Map());
  return {
    owner: identity.owner,
    rootPid: identity.rootPid,
    workerPid: identity.workerPid,
    pgid: identity.pgid,
    gateway: summary.gateway,
    helpers: summary.helpers,
    other: summary.other,
    listeners: identity.listeners,
  };
};

// ── Stop ladder ──────────────────────────────────────────────────────────
//
//   resolveGatewayIdentity ─null ∧ port closed─► { how: "none" }
//        │ foreign / ambiguous ─► throw GatewayStopError stop_refused (nothing signalled)
//        ▼
//   mark the managed exit EXPECTED (before the first signal — the exit
//   classifier must never book our own stop as a crash)
//        ▼
//   ask preflight ─cannot work─► step {phase: asking, status: skipped, reason}
//        │ ok (a real lsof, or AlphaClaw's shim on the ask CLI's PATH only)
//   1. ask    `openclaw gateway restart --wait <askGrace>` — OpenClaw closes
//             admission, compacts the agent's turn, drains ≤ grace, exits 0
//        │ still alive / CLI refused (its last line kept, redacted)
//   2. term   SIGTERM the process group (or each ALIVE gateway-set pid)
//        │ still alive after termGrace
//   3. kill   SIGKILL the same; a gateway-set pid still alive or UNKNOWN
//             after killGrace ─► stop_failed (unknown blocks, is never
//             signalled per pid, and is never "gone")
//        ▼
//   { how: graceful|sigterm|sigkill, downAtMs, pids, identity, evidence }
//
// "Gone" = every GATEWAY-SET pid has verdict gone (exited, zombie with no
// live thread, or a different process now). Bystanders in the group are
// re-inventoried at every poll and REPORTED (observedExits / stillRunning),
// never judged. The port is not consulted for "gone" — a foreign listener
// would make a dead gateway look alive; the caller checks the port before
// spawning instead. `shouldAbort()` is honoured between every poll: a holder
// that lost its lease sends no further signal. `onStep` streams the phase.
const kStopHow = Object.freeze({
  NONE: "none",
  GRACEFUL: "graceful",
  SIGTERM: "sigterm",
  SIGKILL: "sigkill",
});
// The gateway is alive but waiting for state ownership — streamed as the
// `lock_wait` phase. 2026.9.8+ "waiting for Gateway state ownership held by
// another OpenClaw process, up to N s"; 2026.10.2 adds "Waiting for the
// previous Gateway's owner heartbeat to expire before reclaiming state (up to
// N seconds)" while a holder in another PID namespace still has a fresh
// heartbeat (dist/gateway-lock-*.mjs).
const kStateOwnershipWaitPattern =
  /waiting for Gateway state ownership|ownership held by another OpenClaw process|Waiting for the previous Gateway's owner heartbeat to expire before reclaiming state/i;

const stopGatewayLadder = async ({
  deadlineAt = null,
  // A number, or a resolver called once right before the ask is decided
  // (after preflight and any caller awaits) that returns { askGraceMs,
  // reason } from fresh evidence: the memory mitigation's drain budget.
  askGraceMs: askGraceOption = kGatewayStopAskGraceMs,
  termGraceMs = kGatewayStopTermGraceMs,
  killGraceMs = kGatewayStopKillGraceMs,
  allowGracefulRestart = true,
  onStep = null,
  shouldAbort = null,
  // Checked between ask polls: the operator chose "Restart now", so the
  // drain is cut short and the ladder moves on to SIGTERM.
  shouldExpedite = null,
  opId: callerOpId = null,
} = {}) => {
  const opId = callerOpId || mintRestartOpId(null);
  const identity = resolveGatewayIdentity();
  const stopStartedAt = Date.now();
  const remaining = () =>
    deadlineAt == null ? Infinity : Math.max(0, deadlineAt - Date.now());
  const abortIfFenced = (phase, signalled) => {
    if (shouldAbort?.()) {
      throw new GatewayRestartError(`Gateway stop aborted by caller during ${phase}`, {
        aborted: true,
        reason: kCallerAbortReason,
        phase,
        signalled,
        stopEvidence: signalled ? collectEvidence(null) : null,
      });
    }
  };
  if (!identity) {
    if (!(await isGatewayRunning())) {
      logRestart(opId, "identity", { owner: "none", port: getGatewayPort() });
      return { how: kStopHow.NONE, downAtMs: Date.now(), pids: [], identity: null, evidence: null };
    }
    logRestart(opId, "stop_refused", { reason: "unidentified_listener", port: getGatewayPort() });
    throw new GatewayStopError(
      "stop_refused",
      `Port ${getGatewayPort()} answers but no gateway process could be identified behind it`,
      { listeners: [], signalled: false },
    );
  }
  if (identity.owner === kIdentityOwners.FOREIGN) {
    logRestart(opId, "stop_refused", {
      reason: "foreign_listener",
      listeners: identity.foreignListeners,
    });
    throw new GatewayStopError(
      "stop_refused",
      `Port ${getGatewayPort()} is held by a process that is not the gateway (pid ${identity.foreignListeners.join(", ")})`,
      { listeners: identity.listeners, foreignListeners: identity.foreignListeners, signalled: false },
    );
  }
  const { pids } = identity;
  let inventory = identity.inventory;
  let signalled = false;
  const verdictOf = (entry) =>
    gatewayIdentity.resolveProcessVerdict(entry.pid, entry.startTicks);
  const gatewayEntries = () =>
    [...inventory.values()].filter((entry) => entry.class === kProcessClasses.GATEWAY);
  const gatewayVerdicts = () =>
    gatewayEntries().map((entry) => ({ ...entry, ...verdictOf(entry) }));
  const gone = () =>
    gatewayVerdicts().every((entry) => entry.verdict === gatewayIdentity.kProcessVerdicts.GONE);
  // Late forks and reparented members join the inventory at every poll.
  const reinventory = () => {
    inventory = buildInventory({
      rootPid: identity.rootPid,
      workerPid: identity.workerPid,
      pgid: identity.pgid,
      tree: [],
      previous: inventory,
    });
  };
  const collectEvidence = (how) => {
    const observedExits = { helpers: 0, other: [] };
    const stillRunning = [];
    for (const entry of inventory.values()) {
      if (entry.class === kProcessClasses.GATEWAY) continue;
      const { verdict } = verdictOf(entry);
      if (verdict === gatewayIdentity.kProcessVerdicts.GONE) {
        // Exits are observations during stopping, counted only once we
        // actually sent a signal — a graceful ask records none.
        if (!signalled) continue;
        if (entry.class === kProcessClasses.HELPER) observedExits.helpers += 1;
        else observedExits.other.push({ pid: entry.pid, cmd: entry.cmd });
      } else if (entry.class === kProcessClasses.OTHER) {
        stillRunning.push({ pid: entry.pid, cmd: entry.cmd });
      }
    }
    return {
      how,
      askSkippedReason,
      askRefusedLine,
      askExit,
      askAttempts,
      askDrainMs,
      askGraceMs: askSkippedReason ? null : askGraceMs,
      askGraceReason,
      ...(askExpedited ? { askExpedited } : {}),
      observedExits,
      stillRunning,
      survivors: [],
      identity: describeIdentity({ ...identity, inventory }),
    };
  };
  const waitUntilGone = async (budgetMs, extraStop = null) => {
    const until = Date.now() + Math.min(budgetMs, remaining());
    while (Date.now() < until) {
      reinventory();
      if (gone()) return true;
      if (extraStop?.()) return false;
      abortIfFenced("stop", signalled);
      await sleep(kGatewayStopPollMs);
    }
    reinventory();
    return gone();
  };
  // Group signal as today (UC2: the owner kept the process-group policy);
  // the per-pid fallback — no group of ours, or the group already gone —
  // signals ONLY gateway-set pids whose verdict is alive. An unknown pid is
  // never signalled: we cannot prove what it is.
  const signalTree = (signal) => {
    signalled = true;
    if (identity.pgid != null) {
      try {
        process.kill(-identity.pgid, signal);
        logRestart(opId, signal === "SIGKILL" ? "forcing" : "stopping", {
          signal,
          target: `pgid:${identity.pgid}`,
        });
        return;
      } catch {
        // group gone or not ours any more — fall through to per-pid
      }
    }
    const targets = gatewayVerdicts()
      .filter((entry) => entry.verdict === gatewayIdentity.kProcessVerdicts.ALIVE)
      .map((entry) => entry.pid);
    for (const pid of targets) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
    logRestart(opId, signal === "SIGKILL" ? "forcing" : "stopping", { signal, target: "pids", pids: targets });
  };

  logRestart(opId, "identity", describeIdentity(identity));
  // Our own stop: the exit classifier books the managed child's exit as a
  // restart, never a crash, whatever code the launcher relays.
  markManagedGatewayExitExpected();
  for (const pid of inventory.keys()) expectedExitPids.add(pid);

  let how = null;
  let askSkippedReason = null;
  let askRefusedLine = null;
  let askExit = null;
  let askAttempts = null;
  let askDrainMs = null;
  let askGraceMs = kGatewayStopAskGraceMs;
  let askGraceReason = null;
  let askExpedited = false;
  if (typeof askGraceOption === "function") {
    try {
      const resolved = askGraceOption();
      if (Number.isFinite(resolved?.askGraceMs) && resolved.askGraceMs > 0) {
        askGraceMs = resolved.askGraceMs;
        askGraceReason = typeof resolved.reason === "string" ? resolved.reason : null;
      } else {
        askGraceReason = "resolver_invalid";
      }
    } catch {
      askGraceReason = "resolver_failed";
    }
  } else if (Number.isFinite(askGraceOption) && askGraceOption > 0) {
    askGraceMs = askGraceOption;
  }
  // Ask preflight (bug #137 RC2): the pin's `gateway restart` finds the
  // gateway with lsof and silently reports "no listener" without it, so the
  // ask is attempted only when it can work; every other case is a recorded
  // skip, not a 2 s detour that reads like a refusal.
  const askEnv = lsofShim.withAskLsofPath(gatewayEnv());
  const lsof = lsofShim.resolveAskLsofPath({ env: askEnv });
  if (!allowGracefulRestart || isGatewayStopAskDisabled()) askSkippedReason = kAskSkipReasons.CALLER_DISABLED;
  else if (identity.workerPid == null) askSkippedReason = kAskSkipReasons.NO_WORKER;
  else if (String(gatewayEnv().OPENCLAW_NO_RESPAWN || "").trim()) askSkippedReason = kAskSkipReasons.NO_RESPAWN_PINNED;
  else if (remaining() <= gatewayStopAskBudgetMs(askGraceMs) + termGraceMs + killGraceMs) askSkippedReason = kAskSkipReasons.NO_BUDGET;
  else if (!lsof.path) askSkippedReason = kAskSkipReasons.NO_LSOF;
  if (askSkippedReason) {
    onStep?.({ step: "stopping", status: "running", detail: { phase: "asking", status: "skipped", reason: askSkippedReason } });
    logRestart(opId, "asking", {
      status: "skipped",
      reason: askSkippedReason,
      fix: kAskSkipFixes[askSkippedReason],
      runbook: "docs/upgrade-troubleshooting.md#restart-failed-couldnt-stop-the-old-gateway",
    });
  } else {
    onStep?.({ step: "stopping", status: "running", detail: { phase: "asking", graceSeconds: Math.round(askGraceMs / 1000) } });
    logRestart(opId, "asking", { status: "running", graceMs: askGraceMs,
      ...(askGraceReason ? { graceReason: askGraceReason } : {}), lsof: lsof.kind, lsofPath: lsof.path });
    const askStartedAt = Date.now();
    const askDeadline = Math.min(askStartedAt + gatewayStopAskBudgetMs(askGraceMs), Date.now() + remaining());
    // The drain OpenClaw actually runs is min(--wait, its supervisor's stop
    // budget); the gateway announces it at drain start. Recorded so a clamp
    // (systemd TimeoutStopUSec) is visible in the evidence.
    const onGatewayOutput = (chunk) => {
      const announced = String(chunk).match(/shutdown drain budget remains with timeout ([\d.]+)ms/);
      if (announced) askDrainMs = Math.round(Number(announced[1]));
    };
    const gatewayOutput = gatewayChild && identity.rootPid === gatewayChild.pid ? gatewayChild : null;
    gatewayOutput?.stdout?.on?.("data", onGatewayOutput);
    gatewayOutput?.stderr?.on?.("data", onGatewayOutput);
    const startAsk = (attempt, waitMs) => {
      const run = { attempt, exit: null, cli: null, tail: createStderrTail(), states: [], lastProbeAt: 0, exitClass: null, line: null };
      try {
        run.cli = spawn("openclaw", ["gateway", "restart", "--wait", `${waitMs}ms`], {
          env: askEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        run.cli.on("exit", (code, signal) => {
          run.exit ??= { code, signal };
        });
        run.cli.on("error", (error) => {
          run.exit ??= { code: null, signal: null, error };
        });
        run.cli.stderr.on("data", (d) => run.tail.append(d));
        run.cli.stdout.on("data", (d) => run.tail.append(d));
      } catch (error) {
        run.exit = { code: null, signal: null, error };
      }
      return run;
    };
    // The CLI blocks on post-restart health until its own timeout; the
    // ladder owns the relaunch, so it is reaped as soon as the stop settles.
    const reap = (run) => {
      if (run.cli && run.cli.exitCode === null && run.cli.signalCode === null) {
        try {
          run.cli.kill("SIGTERM");
        } catch {}
      }
    };
    const graceLeftMs = () => askDeadline - Date.now() - kGatewayStopAskAckMs - kGatewayStopAskReserveMs;
    const runs = [startAsk(1, askGraceMs)];
    let decision = null;
    try {
      while (Date.now() < askDeadline) {
        reinventory();
        if (gone()) {
          how = kStopHow.GRACEFUL;
          break;
        }
        abortIfFenced("stop", signalled);
        if (shouldExpedite?.()) {
          askExpedited = true;
          logRestart(opId, "asking", { status: "expedited", ms: Date.now() - askStartedAt, drainMs: askDrainMs });
          break;
        }
        const run = runs.at(-1);
        // A CLI that exited non-zero has not decided anything: the gateway's
        // own admission state does (gateway-ask-outcome.js).
        if (run.exit && run.exit.code !== 0 && Date.now() - run.lastProbeAt >= kGatewayStopAskProbeIntervalMs) {
          if (!run.exitClass) {
            run.exitClass = askOutcome.classifyAskExit({ ...run.exit, lines: run.tail.snapshot() });
            run.line = redactEvidenceLine(run.exit.error?.message || run.tail.snapshot().slice(-1)[0] || "");
            logRestart(opId, "asking", {
              status: "exited",
              attempt: run.attempt,
              exit: run.exit.code ?? run.exit.signal ?? "error",
              class: run.exitClass,
              ms: Date.now() - askStartedAt,
              line: run.line,
            });
          }
          run.lastProbeAt = Date.now();
          const observation = await probeGatewayReadiness({
            url: `${getGatewayUrl()}/readyz`,
            timeoutMs: kGatewayStopAskProbeTimeoutMs,
          });
          reinventory();
          if (gone()) {
            how = kStopHow.GRACEFUL;
            break;
          }
          const state = askOutcome.classifyAskProbe(observation);
          if (run.states.at(-1) !== state) logRestart(opId, "asking", { status: "probe", attempt: run.attempt, gateway: state });
          run.states.push(state);
          decision = askOutcome.decideAfterAskExit({
            exitClass: run.exitClass,
            states: run.states,
            attempt: run.attempt,
            graceLeftFraction: graceLeftMs() / askGraceMs,
          });
          if (decision === askOutcome.kAskDecisions.ESCALATE) break;
          if (decision === askOutcome.kAskDecisions.REASK) {
            reap(run);
            const waitMs = Math.max(1000, graceLeftMs());
            logRestart(opId, "asking", { status: "reasking", attempt: run.attempt + 1, graceMs: waitMs });
            runs.push(startAsk(run.attempt + 1, waitMs));
            continue;
          }
        }
        await sleep(kGatewayStopPollMs);
      }
      if (!how) {
        reinventory();
        if (gone()) how = kStopHow.GRACEFUL;
      }
      askAttempts = runs.map((run) => ({
        attempt: run.attempt,
        exit: run.exit ? run.exit.code ?? run.exit.signal ?? "error" : null,
        class: run.exitClass,
        gateway: run.states.at(-1) ?? null,
      }));
      const last = runs.at(-1);
      if (askExpedited && !how) {
        askExit = "expedited";
      } else if (how) {
        logRestart(opId, "asking", { status: "honoured", attempts: runs.length, ms: Date.now() - askStartedAt, drainMs: askDrainMs });
      } else {
        askRefusedLine = last.line ?? redactEvidenceLine(last.tail.snapshot().slice(-1)[0] || "");
        askExit = last.exit ? last.exit.code ?? last.exit.signal ?? "error" : "did_not_settle";
        logRestart(opId, "asking", {
          status: decision === askOutcome.kAskDecisions.ESCALATE ? "refused" : "expired",
          exit: askExit,
          class: last.exitClass,
          gateway: last.states.at(-1) ?? null,
          attempts: runs.length,
          ms: Date.now() - askStartedAt,
          drainMs: askDrainMs,
          line: askRefusedLine,
        });
      }
    } finally {
      for (const run of runs) reap(run);
      gatewayOutput?.stdout?.off?.("data", onGatewayOutput);
      gatewayOutput?.stderr?.off?.("data", onGatewayOutput);
    }
  }
  if (!how) {
    abortIfFenced("sigterm", signalled);
    onStep?.({ step: "stopping", status: "running", detail: { phase: "terminating" } });
    signalTree("SIGTERM");
    if (await waitUntilGone(termGraceMs)) how = kStopHow.SIGTERM;
    else {
      logRestart(opId, "stopping-wait", {
        gone: gatewayVerdicts().filter((e) => e.verdict === gatewayIdentity.kProcessVerdicts.GONE).length,
        of: gatewayEntries().length,
        survivors: gatewayVerdicts().filter((e) => e.verdict !== gatewayIdentity.kProcessVerdicts.GONE)
          .map((e) => ({ pid: e.pid, verdict: e.verdict, reason: e.reason })),
      });
    }
  }
  if (!how) {
    abortIfFenced("sigkill", signalled);
    onStep?.({
      step: "stopping",
      status: "running",
      detail: { phase: "forcing", graceSeconds: Math.round((askSkippedReason || askExpedited ? termGraceMs : askGraceMs) / 1000) },
    });
    signalTree("SIGKILL");
    if (await waitUntilGone(killGraceMs)) how = kStopHow.SIGKILL;
  }
  if (!how) {
    const survivors = gatewayVerdicts()
      .filter((entry) => entry.verdict !== gatewayIdentity.kProcessVerdicts.GONE)
      .map((entry) => ({ pid: entry.pid, verdict: entry.verdict, reason: entry.reason, cmd: entry.cmd }));
    const unverified = survivors.every((entry) => entry.verdict === gatewayIdentity.kProcessVerdicts.UNKNOWN);
    const evidence = { ...collectEvidence(null), survivors };
    logRestart(opId, "stop_failed", { survivors, unverified });
    throw new GatewayStopError(
      "stop_failed",
      unverified
        ? `could not verify that ${survivors.length} gateway process${survivors.length === 1 ? "" : "es"} exited after SIGKILL (${survivors.map((e) => `pid ${e.pid}: ${e.reason}`).join(", ")})`
        : `${survivors.length} gateway process${survivors.length === 1 ? "" : "es"} did not exit after SIGKILL (${survivors.map((e) => `pid ${e.pid}: ${e.verdict}/${e.reason}`).join(", ")})`,
      { pids, survivors, owner: identity.owner, signalled, stopEvidence: evidence, unverified },
    );
  }
  const evidence = collectEvidence(how);
  logRestart(opId, "stopped", {
    how,
    ms: Date.now() - stopStartedAt,
    gateway: evidence.identity.gateway.map((e) => e.pid),
    observedExits: evidence.observedExits,
    stillRunning: evidence.stillRunning,
  });
  return { how, downAtMs: Date.now(), pids, identity, evidence };
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
//   afterStop?() (Retry upgrade: doctor --fix + the boot's post-Doctor
//        │        convergence, gateway DOWN) ─holdGateway/threw─► launch_failed
//        │ { reprepare } → prelaunch hook + plugin preflight again (hash
//        │ invalidated: Doctor may have migrated plugins), so the launch
//        │ sees the converged state exactly like a boot after Doctor
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
  // The restart operation id, threaded through every ladder log line.
  // Callers mint it at their own entry (so their started row and the ladder
  // lines share it) and name who restarted and why (ALPH-17).
  opId: callerOpId = null,
  source = null,
  reason = null,
  // Ladder grace overrides (tests drive the escalation in milliseconds).
  ladder = {},
  shouldExpedite = null,
  // Work that must run with the gateway stopped (Retry upgrade's Doctor).
  // Resolves { reprepare, holdGateway, holdReason }; its outcome is the
  // caller's to interpret — a failed Doctor still relaunches.
  afterStop = null,
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
  const opId = callerOpId || mintRestartOpId(source);
  const restartClass = resolveRestartClass(source);
  logRestart(opId, "requested", { source: source || "unattributed", reason: reason ? redactEvidenceLine(String(reason), 120) : null, class: restartClass });
  if (gatewayRestartRequestedHandler) {
    const handler = gatewayRestartRequestedHandler;
    void Promise.resolve().then(() => handler({ opId, source })).catch(() => {});
  }
  const ladderOptions = restartClass === kRestartClasses.ROUTINE && ladder.askGraceMs == null
    ? { askGraceMs: kGatewayRoutineRestartGraceMs, ...ladder }
    : ladder;
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
  const stop = await stopGatewayLadder({ onStep, shouldAbort, shouldExpedite, deadlineAt, opId, ...ladderOptions });
  onStep?.({ step: "stopping", status: "done", detail: { how: stop.how } });
  let afterStopResult = null;
  if (typeof afterStop === "function") {
    const stoppedFields = { signalled: stop.how !== kStopHow.NONE, stopEvidence: stop.evidence };
    const abortAfterStop = (phase) => {
      if (!shouldAbort?.()) return;
      throw new GatewayRestartError(`Gateway restart aborted by caller before ${phase}`, {
        aborted: true,
        reason: kCallerAbortReason,
        code: "aborted",
        phase,
        ...stoppedFields,
      });
    };
    abortAfterStop("after_stop");
    try {
      afterStopResult = await afterStop();
    } catch (error) {
      if (error instanceof GatewayRestartError) throw error;
      throw new GatewayRestartError(`work after the stop failed: ${error?.message || error}`, { code: "launch_failed", ...stoppedFields });
    }
    abortAfterStop("launch");
    if (afterStopResult?.holdGateway) {
      logRestart(opId, "launch_failed", { reason: "held_after_stop" });
      throw new GatewayRestartError(afterStopResult.holdReason || "the gateway was held after the stop", {
        code: "launch_failed",
        held: true,
        ...stoppedFields,
      });
    }
    if (afterStopResult?.reprepare) {
      try {
        await prepareGatewayLaunch({ site: "restart" });
      } catch (error) {
        throw new GatewayRestartError(`the prelaunch hook refused the relaunch: ${error?.message || error}`, { code: "launch_failed", ...stoppedFields });
      }
      lastPreflightSuccessHash = null;
      onStep?.({ step: "preparing_plugins", status: "running", detail: { phase: "after_upgrade" } });
      const reprep = await prepareOpenclawChannelPlugins();
      onStep?.({
        step: "preparing_plugins",
        status: reprep?.failed ? "warning" : reprep?.skipped ? "skipped" : "done",
        detail: { phase: "after_upgrade" },
      });
      abortAfterStop("launch");
    }
  }
  const port = getGatewayPort();
  // A zombie in the OLD identity can still hold the listener for a moment:
  // the kernel closes the fd table after the exit the ladder already judged
  // `gone`. Wait out the kill grace for that one case; anything else on the
  // port is a stranger.
  const oldPids = new Set(stop.identity?.pids ?? []);
  const strangerDeadline = Date.now() + (ladder.killGraceMs ?? kGatewayStopKillGraceMs);
  let strangers = gatewayIdentity.findPortListenerPids(port);
  while (
    strangers.length > 0 &&
    strangers.every((pid) => oldPids.has(pid)) &&
    Date.now() < strangerDeadline
  ) {
    abortIfFenced("launch");
    await sleep(kGatewayStopPollMs);
    strangers = gatewayIdentity.findPortListenerPids(port);
  }
  if (strangers.length > 0) {
    logRestart(opId, "launch_failed", { reason: "port_held", listeners: strangers });
    throw new GatewayRestartError(
      `port ${port} is held by another process (pid ${strangers.join(", ")})`,
      { code: "launch_failed", listeners: strangers, signalled: stop.how !== kStopHow.NONE, stopEvidence: stop.evidence },
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
  const stopped = { signalled: stop.how !== kStopHow.NONE, stopEvidence: stop.evidence };
  if (launch.outcome === kGatewayLaunchOutcomes.LAUNCH_ABORTED) {
    throw new GatewayRestartError(`Gateway launch aborted (${launch.detail})`, {
      aborted: true,
      reason: launch.detail === "lease_expired" ? kCallerAbortReason : launch.detail,
      code: "aborted",
      ...stopped,
    });
  }
  if (launch.outcome !== kGatewayLaunchOutcomes.LAUNCH_REQUESTED) {
    logRestart(opId, "launch_failed", { reason: launch.outcome, detail: redactEvidenceLine(launch.detail || "") });
    throw new GatewayRestartError(
      `Gateway launch did not start a new process (${launch.outcome}${launch.detail ? `: ${launch.detail}` : ""})`,
      { code: "launch_failed", outcome: launch.outcome, stderrTail: [], ...stopped },
    );
  }
  const { child, generation, stderrTail, childEnv } = launch;
  logRestart(opId, "launch", { pid: child.pid, generation });
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
      logRestart(opId, "launch_failed", { reason: "exited_before_ready", code: child.exitCode, signal: child.signalCode });
      throw new GatewayRestartError(
        `OpenClaw exited before it was ready (${
          child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`
        })`,
        { code: "launch_failed", stderrTail: stderrTail.snapshot(), exitCode: child.exitCode, signal: child.signalCode, ...stopped },
      );
    }
    if (isGatewayWaitsAborted()) {
      throw new GatewayRestartError(`Gateway restart aborted: ${gatewayWaitsAbortReason}`, {
        aborted: true,
        reason: gatewayWaitsAbortReason,
        code: "aborted",
        stderrTail: stderrTail.snapshot(),
        ...stopped,
      });
    }
    if (shouldAbort?.()) {
      throw new GatewayRestartError("Gateway restart aborted by caller while waiting for readiness", {
        aborted: true,
        reason: kCallerAbortReason,
        code: "aborted",
        stderrTail: stderrTail.snapshot(),
        ...stopped,
      });
    }
    // The new process is up but not ready inside the budget. It stays as the
    // managed child: the watchdog's readiness ladder (transitional budget →
    // degraded → repair) owns it from here, and a retry runs the ladder.
    console.warn(
      `[alphaclaw] Gateway did not report ready within ${kGatewayRestartReadyTimeoutMs}ms (last: ${readiness.last?.kind ?? "none"}${readiness.last?.status ? ` ${readiness.last.status}` : ""})`,
    );
    logRestart(opId, "ready_timeout", { budgetMs: kGatewayRestartReadyTimeoutMs, last: readiness.last?.kind ?? "none" });
    throw new GatewayRestartError(
      `OpenClaw did not become ready within ${Math.round(kGatewayRestartReadyTimeoutMs / 1000)}s`,
      {
        code: "ready_timeout",
        budgetMs: kGatewayRestartReadyTimeoutMs,
        readiness: readiness.last ?? null,
        stderrTail: stderrTail.snapshot(),
        ...stopped,
      },
    );
  }
  // Ready — from OUR child? The listener behind the port must be in the new
  // child's tree, or another process took the port between stop and spawn.
  const tree = gatewayIdentity.listProcessTree(child.pid);
  const listeners = gatewayIdentity.findPortListenerPids(port);
  const worker = listeners.find((pid) => tree.includes(pid)) ?? null;
  if (listeners.length > 0 && !worker) {
    logRestart(opId, "launch_failed", { reason: "stranger_serving", listeners });
    throw new GatewayRestartError(
      `another process answered on port ${port} (pid ${listeners.join(", ")}) — the new gateway is not the one serving`,
      { code: "launch_failed", listeners, generation, stderrTail: stderrTail.snapshot(), ...stopped },
    );
  }
  if (gatewayChild === child) {
    gatewayChildWorkerPid = worker ?? resolveFirstChildPid(child.pid) ?? null;
    gatewayChildWorkerVerified = worker != null;
    launch.identity.workerPid = gatewayChildWorkerPid;
    launch.identity.workerVerified = gatewayChildWorkerVerified;
  }
  // Stamp only now: the NEW gateway is proven up and ready — a spawn that
  // never got here must not leave rows claiming it consumed this env.
  stampAutotuneFromChildEnv(childEnv);
  // durationMs = the whole operation (prepare → ready), what "restarted in
  // Ns" means; downtimeMs = stop initiated → ready, what the operator felt.
  const durationMs = Date.now() - restartStartedAt;
  logRestart(opId, "ready", {
    ms: durationMs,
    downMs: Date.now() - stopStartedAt,
    how: stop.how,
    launcherPid: child.pid,
    workerPid: gatewayChildWorkerPid ?? null,
  });
  await notifyGatewayLaunch();
  return {
    ok: true,
    opId,
    durationMs,
    downtimeMs: Date.now() - stopStartedAt,
    how: stop.how,
    stopEvidence: stop.evidence,
    ...(afterStopResult ? { afterStop: afterStopResult } : {}),
  };
};


// Autotune spawn stamp: record the env values a fresh gateway actually
// consumed so ledger rows flip pending_restart → applied. Called from EVERY
// path that hands gatewayEnv() to a NEW gateway (managed launch AND the
// cold restart's fresh `gateway run`) — in-place recycles keep the original env
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
// disabled) the `gateway run` process IS the gateway and its children are plugin
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
      gatewayChildWorkerVerified = false;
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

// Alive guard shared by resolveGatewayIdentity, requestGatewayLaunch and
// notifyGatewayLaunch: a managed child that has not exited and was not killed
// by us.
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

  // The launch guard alone also requires signalCode === null. The ladder
  // signals the process GROUP, so child.killed stays false, and a SIGKILLed or
  // OOM-killed child keeps exitCode null until its 'close' (or the
  // kGatewayCloseDrainMs timer) releases the slot. Without this a replacement
  // launch inside that window is skipped as child_retained.
  const childStillRunning = () =>
    isManagedGatewayChildLive() && gatewayChild.signalCode === null;
  if (childStillRunning()) return retained();
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
  if (childStillRunning()) return retained();
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
  gatewayChildWorkerVerified = false;
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
  const identity = { workerPid: null, workerVerified: false };
  const resolveWorker = () => {
    if (identity.workerPid != null) return identity.workerPid;
    const tree = gatewayIdentity.listProcessTree(child.pid);
    const listener = gatewayIdentity
      .findPortListenerPids(getGatewayPort())
      .find((pid) => tree.includes(pid));
    identity.workerPid = listener ?? resolveFirstChildPid(child.pid) ?? null;
    identity.workerVerified = listener != null;
    if (gatewayChild === child) {
      gatewayChildWorkerPid = identity.workerPid;
      gatewayChildWorkerVerified = identity.workerVerified;
    }
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
          workerVerified: identity.workerVerified,
          rootPid: child.pid,
          startTicks,
          generation,
          supervision: "managed",
        });
      } catch (err) {
        console.error(`[alphaclaw] Gateway launch handler error: ${err.message}`);
      }
    }
    notifyGatewayOutput(text);
    process.stdout.write(`[gateway] ${d}`);
  });
  child.stderr.on("data", (d) => {
    stderrTail.append(d);
    notifyGatewayOutput(Buffer.isBuffer(d) ? d.toString("utf8") : String(d ?? ""));
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

// One observer of the managed gateway's raw output (both streams): the boot
// timeline reads OpenClaw's "startup phase:" trace and counts output as proof
// of life. Never allowed to break the pipe.
let gatewayOutputObserver = null;
const setGatewayOutputObserver = (observer) => {
  gatewayOutputObserver = typeof observer === "function" ? observer : null;
};
function notifyGatewayOutput(text) {
  if (!gatewayOutputObserver) return;
  try {
    gatewayOutputObserver(text);
  } catch {}
}

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
      const listener = gatewayIdentity.findPortListenerPids(getGatewayPort()).find((pid) => tree.includes(pid));
      gatewayChildWorkerPid = listener ?? resolveFirstChildPid(rootPid) ?? null;
      gatewayChildWorkerVerified = listener != null;
    }
    payload = {
      startedAt,
      pid: rootPid,
      servingPid: gatewayChildWorkerPid ?? rootPid,
      workerVerified: gatewayChildWorkerVerified,
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
      workerVerified: identity?.workerVerified === true,
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
  const opId = crypto.randomUUID();
  logRestart(opId, "requested", { source: "shutdown" });
  try {
    await stopGatewayLadder({
      deadlineAt,
      opId,
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
  try {
    const summary = summarizeInventory(
      buildInventory({ rootPid: child.pid, workerPid: gatewayChildWorkerPid, pgid, tree: gatewayIdentity.listProcessTree(child.pid) }),
    );
    logRestart("shutdown", "identity", {
      signal,
      rootPid: child.pid,
      pgid,
      gateway: summary.gateway.map((e) => e.pid),
      helpers: summary.helpers,
      other: summary.other,
    });
  } catch {}
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
  setGatewayRestartRequestedHandler,
  setGatewayOutputObserver,
  GatewayRestartError,
  GatewayStopError,
  GatewayPrelaunchHookError,
  abortGatewayWaits,
  startGateway,
  restartGateway,
  stopGatewayLadder,
  kStopHow,
  kAskSkipReasons,
  kRestartClasses,
  resolveRestartClass,
  kProcessClasses,
  describeIdentity,
  formatRestartLogLine,
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
  gatewayStopAskBudgetMs,
  kGatewayStopKillGraceMs,
  kGatewayShutdownStopBudgetMs,
};
