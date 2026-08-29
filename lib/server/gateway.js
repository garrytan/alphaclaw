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
} = require("./constants");
const {
  normalizeChannelAccountId,
  readPairedCountsByAccount,
} = require("./agents/shared");
const { withOpenclawStartupEnv } = require("./openclaw-runtime-env");
const { isOpenAiCompatApiEnabled } = require("./alphaclaw-config");
const { withFileLockSync } = require("./utils/safe-file");
const { applyGatewayAuthEnv } = require("./gateway-credential");

let gatewayChild = null;
let gatewayExitHandler = null;
let gatewayLaunchHandler = null;
const kGatewayStderrTailLines = 50;
const kPluginRuntimeDepsPreflightTimeoutMs = 120 * 1000;
const kGatewayShortCmdTimeoutMs = 15 * 1000;
const kGatewayLifecycleCmdTimeoutMs = 90 * 1000;
const kGatewayRestartReadyTimeoutMs = 120 * 1000;
const kGatewayRestartReadyPollMs = 500;
let gatewayStderrTail = [];
const expectedExitPids = new Set();

let gatewayStderrCarry = "";

const appendStderrTail = (chunk) => {
  const text =
    gatewayStderrCarry +
    (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? ""));
  gatewayStderrCarry = "";
  const lines = text.split("\n");
  // A chunk rarely ends exactly on a newline; hold the trailing partial line
  // until it completes so a secret split across chunks is one tail entry
  // (redaction matches whole values) instead of two unmatchable halves.
  const partial = lines.pop();
  // Cap the carry: a gateway that never emits a newline (\r progress bars,
  // one huge line) must not grow it without bound. Keep the tail end — that
  // is what stderrTailSnapshot surfaces.
  if (partial) gatewayStderrCarry = partial.slice(-8192);
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    gatewayStderrTail.push(trimmed);
  }
  if (gatewayStderrTail.length > kGatewayStderrTailLines) {
    gatewayStderrTail = gatewayStderrTail.slice(-kGatewayStderrTailLines);
  }
};

// Evidence snapshot: completed lines plus any in-flight partial line (a crash
// often dies mid-line and that fragment is the interesting part).
const stderrTailSnapshot = () => {
  const tail = [...gatewayStderrTail];
  if (gatewayStderrCarry.trimEnd()) tail.push(gatewayStderrCarry.trimEnd());
  return tail.slice(-kGatewayStderrTailLines);
};

const setGatewayExitHandler = (handler) => {
  gatewayExitHandler = typeof handler === "function" ? handler : null;
};

const setGatewayLaunchHandler = (handler) => {
  gatewayLaunchHandler = typeof handler === "function" ? handler : null;
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
// restart-handoff contract lives in openclaw-restart-handoff.js.
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

const runGatewayShortCmd = async (cmd) => {
  // Multi-word commands ride as separate argv entries (never a shell string).
  const args = ["gateway", ...String(cmd).split(" ").filter(Boolean)];
  try {
    const { stdout } = await execFileAsync("openclaw", args, {
      env: gatewayEnv(),
      timeout: kGatewayShortCmdTimeoutMs,
      encoding: "utf8",
      signal: gatewayAbortController.signal,
    });
    if (stdout.trim()) console.log(`[alphaclaw] ${stdout.trim()}`);
  } catch (e) {
    logGatewayCmdOutput(cmd, e);
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

const runGatewayRestartCmd = async (cmd, { onStep = null } = {}) => {
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
  // Evidence honesty: the tail must only contain THIS attempt's stderr —
  // otherwise a failed restart reports leftovers from a previous launch.
  gatewayStderrTail = [];
  gatewayStderrCarry = "";
  onStep?.({ step: "launching", status: "running" });
  const restartChildEnv = gatewayEnv();
  const child = spawn("openclaw", ["gateway", cmd], {
    env: restartChildEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The --force supervisor launches a NEW gateway with this env — without the
  // stamp, the UI's own Restart button could never clear a pending row.
  stampAutotuneFromChildEnv(restartChildEnv);
  child.stdout.on("data", (d) => process.stdout.write(`[gateway] ${d}`));
  child.stderr.on("data", (d) => {
    appendStderrTail(d);
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
    appendStderrTail(`gateway supervisor spawn error: ${error.message}\n`);
  });

  onStep?.({ step: "waiting_ready", status: "running", budgetMs: kGatewayRestartReadyTimeoutMs });
  const ready = await waitForGatewayReady({
    shouldAbort: () => !!supervisorSpawnError,
  });
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
        stderrTail: stderrTailSnapshot(),
        supervisorExit,
      },
    );
  }
  if (ready) {
    console.log(
      `[alphaclaw] Gateway ${cmd} ready (${Date.now() - startedAt}ms); leaving supervisor running`,
    );
    gatewayChild = null;
    await notifyGatewayLaunch();
    return { durationMs: Date.now() - startedAt };
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
      stderrTail: stderrTailSnapshot(),
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

const runGatewayColdStart = async ({ onStep = null } = {}) => {
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
  stopManagedGatewayChild();
  await runGatewayShortCmd("stop");
  const portReleased = await waitForGatewayStopped();
  if (!portReleased && !isGatewayWaitsAborted()) {
    console.warn(
      "[alphaclaw] old gateway still holds the port after stop — proceeding with --force; readiness probes may briefly see the old process",
    );
  }
  onStep?.({ step: "stopping", status: "done" });
  const result = await runGatewayRestartCmd("--force", { onStep });
  // Downtime = stop initiated -> gateway ready. The number the operator
  // actually feels; surfaced on the success line and the operation record.
  return { ...result, downtimeMs: Date.now() - stopStartedAt };
};

const runGatewayCmd = async (cmd) => {
  console.log(`[alphaclaw] Running: openclaw gateway ${cmd}`);
  if (cmd === "--force") {
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
    const heapMatch = /--max-old-space-size=(\d+)/.exec(
      String(childEnv.NODE_OPTIONS || ""),
    );
    const derivedUv = getUvThreadpoolSize();
    const envUv = String(childEnv.UV_THREADPOOL_SIZE || "").trim();
    stampGatewayEnvApplied({
      gatewayHeapMb: heapMatch ? Number.parseInt(heapMatch[1], 10) : null,
      uvThreadpoolSize:
        derivedUv != null && envUv === String(derivedUv) ? derivedUv : null,
    });
  } catch (err) {
    console.error(`[autotune] spawn stamp failed: ${err.message}`);
  }
};

const launchGatewayProcess = async () => {
  if (gatewayChild && gatewayChild.exitCode === null && !gatewayChild.killed) {
    console.log(
      "[alphaclaw] Managed gateway process already running — skipping launch",
    );
    return gatewayChild;
  }
  await prepareOpenclawChannelPlugins();
  // A launch cancelled by shutdown must never spawn a fresh gateway child —
  // the aborted preflight above swallows its own abort and returns.
  if (isGatewayWaitsAborted()) return null;
  gatewayStderrTail = [];
  gatewayStderrCarry = "";
  const childEnv = gatewayEnv();
  const child = spawn("openclaw", ["gateway", "run"], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  gatewayChild = child;
  stampAutotuneFromChildEnv(childEnv);
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
    appendStderrTail(d);
    process.stderr.write(`[gateway] ${d}`);
  });
  // A spawn failure (binary missing/non-executable) with no listener is an
  // uncaught 'error' event — process death. Log it and clear the child so
  // the TCP watcher reports the gateway down instead.
  child.on("error", (error) => {
    console.error(`[alphaclaw] gateway launch error: ${error.message}`);
    appendStderrTail(`gateway launch error: ${error.message}\n`);
    if (gatewayChild === child) gatewayChild = null;
  });
  child.on("exit", (code, signal) => {
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
          stderrTail: stderrTailSnapshot(),
        });
      } catch (err) {
        console.error(`[alphaclaw] Gateway exit handler error: ${err.message}`);
      }
    }
    if (gatewayChild === child) gatewayChild = null;
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
  await launchGatewayProcess();
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
  // child) still need a CLI stop — best-effort, bounded, non-blocking exec.
  await new Promise((resolve) => {
    try {
      const { exec } = require("child_process");
      exec(
        "openclaw gateway stop",
        { env: gatewayEnv(), timeout: 5000, encoding: "utf8" },
        () => resolve(),
      );
    } catch {
      resolve();
    }
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
      if (!hasConfiguredToken) continue;

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
  abortGatewayWaits,
  startGateway,
  restartGateway,
  restartGatewayLight,
  attachGatewaySignalHandlers,
  stopGatewayForShutdown,
  ensureGatewayProxyConfig,
  syncChannelConfig,
  getChannelStatus,
  // Exported for tests.
  stripNodeMemoryFlags,
};
