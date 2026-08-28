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
const { applyGatewayAuthEnv } = require("./gateway-credential");

let gatewayChild = null;
let gatewayExitHandler = null;
let gatewayLaunchHandler = null;
const kGatewayStderrTailLines = 50;
const kPluginRuntimeDepsPreflightTimeoutMs = 120 * 1000;
const kGatewayShortCmdTimeoutMs = 15 * 1000;
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

// Version-gated external supervision (2026.8.1-beta.1+). AlphaClaw already
// owns the gateway lifecycle (launch, watchdog restarts, rollback restarts);
// OPENCLAW_SUPERVISOR_MODE=external tells a beta gateway to skip its internal
// self-restart supervisor and defer to us. Injected from lib/server.js via
// setGatewayFeatureGates; fail-closed — on stable (2026.7.x) or when gates are
// absent/unreadable, the variable is NOT set and nothing changes.
//
// TODO(supervisor handoff): the pinned stable package (2026.7.1-2) ships no
// external-supervision doc, so the "verified restart handoff" contract
// (gateway acks the handoff before the old process exits) cannot be verified
// yet. Once a 2026.8.1 beta is installed, read its gateway lifecycle docs and
// implement the handoff in runGatewayRestartCmd/stopGatewayChildAndWait; until
// then only the env-var plumbing ships behind the gate.
let gatewayFeatureGates = null;
const setGatewayFeatureGates = (gates) => {
  gatewayFeatureGates = gates || null;
};

const supervisorModeEnv = () => {
  try {
    if (gatewayFeatureGates?.supportsFeature?.("supervisorMode")) {
      return { OPENCLAW_SUPERVISOR_MODE: "external" };
    }
  } catch {}
  return {};
};

const gatewayEnv = () =>
  withOpenclawStartupEnv(
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
      ...supervisorModeEnv(),
    }),
  );

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

// The preflight boots the full OpenClaw CLI (up to 120s on cold volumes). It
// must never run synchronously: the boot sequence and restarts call this, and
// a blocking spawn here froze the whole server for the duration.
const runPluginRuntimeDepsPreflight = () =>
  execFileAsync("openclaw", ["plugins", "list", "--json"], {
    env: gatewayEnv(),
    timeout: kPluginRuntimeDepsPreflightTimeoutMs,
    encoding: "utf8",
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
  if (
    openclawConfigMemo.config !== null &&
    openclawConfigMemo.readFn === fs.readFileSync &&
    openclawConfigMemo.existsFn === fs.existsSync &&
    now - openclawConfigMemo.at < openclawConfigMemoTtlMs
  ) {
    return openclawConfigMemo.config;
  }
  const configPath = `${OPENCLAW_DIR}/openclaw.json`;
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  openclawConfigMemo = {
    at: now,
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
    if (shouldAbort?.()) return false;
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
  try {
    const { stdout } = await execFileAsync("openclaw", ["gateway", cmd], {
      env: gatewayEnv(),
      timeout: kGatewayShortCmdTimeoutMs,
      encoding: "utf8",
    });
    if (stdout.trim()) console.log(`[alphaclaw] ${stdout.trim()}`);
  } catch (e) {
    logGatewayCmdOutput(cmd, e);
  }
};


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
  const startedAt = Date.now();
  let supervisorExit = null;
  let supervisorSpawnError = null;
  // Evidence honesty: the tail must only contain THIS attempt's stderr —
  // otherwise a failed restart reports leftovers from a previous launch.
  gatewayStderrTail = [];
  gatewayStderrCarry = "";
  onStep?.({ step: "launching", status: "running" });
  const child = spawn("openclaw", ["gateway", cmd], {
    env: gatewayEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  if (!portReleased) {
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

const launchGatewayProcess = async () => {
  if (gatewayChild && gatewayChild.exitCode === null && !gatewayChild.killed) {
    console.log(
      "[alphaclaw] Managed gateway process already running — skipping launch",
    );
    return gatewayChild;
  }
  await prepareOpenclawChannelPlugins();
  gatewayStderrTail = [];
  gatewayStderrCarry = "";
  const child = spawn("openclaw", ["gateway", "run"], {
    env: gatewayEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  gatewayChild = child;
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

const ensureGatewayProxyConfig = (origin) => {
  if (!isOnboarded()) return false;
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
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
  } catch (e) {
    console.error(`[alphaclaw] ensureGatewayProxyConfig error: ${e.message}`);
    return false;
  }
};

// Sequential per channel (each add rewrites openclaw.json, and the token →
// env-ref rewrite must happen right after its own add), but async: each CLI
// call previously blocked the event loop for up to 15s.
const syncChannelConfig = async (savedVars, mode = "all") => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const savedMap = Object.fromEntries(
      savedVars.filter((v) => v.value).map((v) => [v.key, v.value]),
    );
    const env = gatewayEnv();

    for (const [ch, def] of Object.entries(kChannelDefs)) {
      const token = savedMap[def.envKey];
      const isConfigured = cfg.channels?.[ch]?.enabled;

      if (token && !isConfigured && (mode === "add" || mode === "all")) {
        console.log(`[alphaclaw] Adding channel: ${ch}`);
        try {
          if (ch === "slack") {
            const appToken = savedMap[def.extraEnvKeys?.[0]];
            if (!appToken) continue;
            await execFileAsync(
              "openclaw",
              [
                "channels",
                "add",
                "--channel",
                "slack",
                "--bot-token",
                token,
                "--app-token",
                appToken,
              ],
              { env, timeout: 15000, encoding: "utf8" },
            );
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
            await execFileAsync(
              "openclaw",
              ["channels", "add", "--channel", ch, "--token", token],
              { env, timeout: 15000, encoding: "utf8" },
            );
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
          await execFileAsync(
            "openclaw",
            ["channels", "remove", "--channel", ch, "--delete"],
            { env, timeout: 15000, encoding: "utf8" },
          );
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
const stopGatewayChild = ({ signal = "SIGTERM" } = {}) => {
  if (gatewayChild && gatewayChild.exitCode === null && !gatewayChild.killed) {
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
  const exited = () => !child || child.exitCode !== null;
  const waitUntil = async (deadline) => {
    while (!exited() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100).unref?.());
    }
    return exited();
  };
  if (await waitUntil(Date.now() + graceMs)) return true;
  stopGatewayChild({ signal: "SIGKILL" });
  return waitUntil(Date.now() + 1000);
};

module.exports = {
  gatewayEnv,
  setGatewayFeatureGates,
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
  startGateway,
  restartGateway,
  attachGatewaySignalHandlers,
  ensureGatewayProxyConfig,
  syncChannelConfig,
  getChannelStatus,
};
