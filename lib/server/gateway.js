const path = require("path");
const { spawn, execFile } = require("child_process");
const { createLifecycleLock } = require("./utils/lifecycle-lock");
const fs = require("fs");
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

const appendStderrTail = (chunk) => {
  const text = Buffer.isBuffer(chunk)
    ? chunk.toString("utf8")
    : String(chunk ?? "");
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    gatewayStderrTail.push(trimmed);
  }
  if (gatewayStderrTail.length > kGatewayStderrTailLines) {
    gatewayStderrTail = gatewayStderrTail.slice(-kGatewayStderrTailLines);
  }
};

const setGatewayExitHandler = (handler) => {
  gatewayExitHandler = typeof handler === "function" ? handler : null;
};

const setGatewayLaunchHandler = (handler) => {
  gatewayLaunchHandler = typeof handler === "function" ? handler : null;
};

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

const gatewayEnv = () => {
  const env = withOpenclawStartupEnv({
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
  });
  if (env.NODE_OPTIONS) {
    const filtered = stripNodeMemoryFlags(env.NODE_OPTIONS);
    if (filtered) env.NODE_OPTIONS = filtered;
    else delete env.NODE_OPTIONS;
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

// Async openclaw CLI runner: keeps the event loop free (these commands used
// to run through execSync with 15s-120s timeouts, freezing every request
// including /health for the duration). Aborting the signal SIGTERMs the CLI
// child — the shutdown path cancels in-flight lifecycle ops this way.
const execOpenclaw = (args, { timeoutMs, signal } = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      "openclaw",
      args,
      { env: gatewayEnv(), timeout: timeoutMs, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: error || null,
        });
      },
    );
    if (signal) {
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {}
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });

const toExecErrorShape = (result) => ({
  message: result.error?.message || "",
  stdout: result.stdout,
  stderr: result.stderr,
  status: result.error?.code ?? null,
});

const runPluginRuntimeDepsPreflight = async ({ signal } = {}) => {
  const result = await execOpenclaw(["plugins", "list", "--json"], {
    timeoutMs: kPluginRuntimeDepsPreflightTimeoutMs,
    signal,
  });
  if (!result.ok) {
    const err = new Error(result.error?.message || "plugin preflight failed");
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout;
};

const prepareOpenclawChannelPlugins = async ({ signal } = {}) => {
  if (!hasEnabledChannelConfig()) return;
  cleanupOpenclawPluginInstallStages();
  try {
    await runPluginRuntimeDepsPreflight({ signal });
  } catch (err) {
    if (!isInstallStageFailure(err)) {
      console.warn(
        `[alphaclaw] OpenClaw plugin preflight failed: ${(err.stderr || err.message || "").toString().trim().slice(0, 300)}`,
      );
      return;
    }
    cleanupOpenclawPluginInstallStages();
    try {
      await runPluginRuntimeDepsPreflight({ signal });
      console.log("[alphaclaw] OpenClaw plugin preflight recovered after cleaning install stage");
    } catch (retryErr) {
      console.warn(
        `[alphaclaw] OpenClaw plugin preflight retry failed: ${(retryErr.stderr || retryErr.message || "").toString().trim().slice(0, 300)}`,
      );
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

const getGatewayPort = () => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    if (!fs.existsSync(configPath)) return kDefaultGatewayPort;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const parsedPort = Number.parseInt(String(cfg?.gateway?.port || ""), 10);
    return parsedPort > 0 ? parsedPort : kDefaultGatewayPort;
  } catch {
    return kDefaultGatewayPort;
  }
};

const getGatewayUrl = () => `http://${GATEWAY_HOST}:${getGatewayPort()}`;

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
} = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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
  if (e?.status !== undefined && e?.status !== null) {
    console.log(`[alphaclaw] gateway ${cmd} exit code: ${e.status}`);
  }
};

const runGatewayShortCmd = async (cmd, { signal } = {}) => {
  const args = ["gateway", ...String(cmd).split(" ").filter(Boolean)];
  const result = await execOpenclaw(args, {
    timeoutMs: kGatewayShortCmdTimeoutMs,
    signal,
  });
  if (result.ok) {
    if (result.stdout.trim()) console.log(`[alphaclaw] ${result.stdout.trim()}`);
  } else {
    logGatewayCmdOutput(cmd, toExecErrorShape(result));
  }
};

const runGatewayLifecycleRestart = async ({ signal } = {}) => {
  console.log("[alphaclaw] Running: openclaw gateway restart");
  const result = await execOpenclaw(["gateway", "restart"], {
    timeoutMs: kGatewayLifecycleCmdTimeoutMs,
    signal,
  });
  if (result.ok) {
    if (result.stdout.trim()) console.log(`[alphaclaw] ${result.stdout.trim()}`);
    return true;
  }
  logGatewayCmdOutput("restart", toExecErrorShape(result));
  return false;
};

const hasActiveManagedGatewayChild = () =>
  !!(
    gatewayChild &&
    gatewayChild.exitCode === null &&
    !gatewayChild.killed
  );

const runGatewayRestartCmd = async (cmd, { signal } = {}) => {
  await prepareOpenclawChannelPlugins({ signal });
  const startedAt = Date.now();
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
    console.log(
      `[alphaclaw] gateway ${cmd} supervisor exited: code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`,
    );
  });

  const ready = await waitForGatewayReady();
  if (ready) {
    console.log(
      `[alphaclaw] Gateway ${cmd} ready (${Date.now() - startedAt}ms); leaving supervisor running`,
    );
    gatewayChild = null;
    await notifyGatewayLaunch();
    return;
  }

  console.warn(
    `[alphaclaw] Gateway ${cmd} did not become ready within ${kGatewayRestartReadyTimeoutMs}ms; stopping`,
  );
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await runGatewayShortCmd("stop", { signal });
};

const runGatewayColdStart = async ({ signal } = {}) => {
  stopManagedGatewayChild();
  await runGatewayShortCmd("stop", { signal });
  await runGatewayRestartCmd("--force", { signal });
};

const runGatewayCmdUnlocked = async (cmd, { signal } = {}) => {
  console.log(`[alphaclaw] Running: openclaw gateway ${cmd}`);
  if (cmd === "--force") {
    await runGatewayRestartCmd("--force", { signal });
    return;
  }
  await runGatewayShortCmd(cmd, { signal });
};

const launchGatewayProcessUnlocked = async ({ signal } = {}) => {
  if (gatewayChild && gatewayChild.exitCode === null && !gatewayChild.killed) {
    console.log(
      "[alphaclaw] Managed gateway process already running — skipping launch",
    );
    return gatewayChild;
  }
  await prepareOpenclawChannelPlugins({ signal });
  gatewayStderrTail = [];
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
          stderrTail: gatewayStderrTail.slice(-kGatewayStderrTailLines),
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

const startGatewayUnlocked = async ({ signal } = {}) => {
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
  await launchGatewayProcessUnlocked({ signal });
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

const restartGatewayUnlocked = async (reloadEnv, { signal } = {}) => {
  reloadEnv();
  await runGatewayColdStart({ signal });
};

const restartGatewayLightUnlocked = async (reloadEnv, { signal } = {}) => {
  reloadEnv();
  if (await isGatewayRunning()) {
    if (await runGatewayLifecycleRestart({ signal })) {
      console.log("[alphaclaw] Gateway light restart complete");
      return;
    }
    console.warn("[alphaclaw] Gateway light restart failed");
    return;
  }
  if (!hasActiveManagedGatewayChild()) {
    console.log("[alphaclaw] Gateway not running — starting managed process");
    await launchGatewayProcessUnlocked({ signal });
  }
};

// ── Lifecycle lock ─────────────────────────────────────────────────────────
// Every lifecycle entry point (boot start, route restarts, watchdog
// crash-restart/repair relaunch, channel sync, raw gateway commands) runs
// under one single-flight lock: same-op callers JOIN the in-flight operation
// (double-clicked restarts coalesce), different ops QUEUE in FIFO order, and
// shutdown cancels the in-flight op (aborting its CLI child). execSync used
// to provide this serialization by accident, by freezing the event loop.
//
//   idle ─restart→ stopping ─→ preflight ─→ spawning ─→ waiting-ready ─→ idle
//     │                │ [timeout: log, force]  │ [fail: log, notify]
//     └─ concurrent same-op → JOIN   ·   different op → QUEUE (FIFO)
//     shutdown → cancel(): abort signal → CLI child SIGTERM → queue dropped
const gatewayLifecycleLock = createLifecycleLock();

const startGateway = () =>
  gatewayLifecycleLock.run("start", ({ signal }) => startGatewayUnlocked({ signal }));

const restartGateway = (reloadEnv) =>
  gatewayLifecycleLock.run("restart", ({ signal }) =>
    restartGatewayUnlocked(reloadEnv, { signal }),
  );

// Distinct key from "restart": a FULL restart requested during a light
// restart must queue and run, not silently join the lighter operation.
const restartGatewayLight = (reloadEnv) =>
  gatewayLifecycleLock.run("restart-light", ({ signal }) =>
    restartGatewayLightUnlocked(reloadEnv, { signal }),
  );

const runGatewayCmd = (cmd) =>
  gatewayLifecycleLock.run(`gateway:${cmd}`, ({ signal }) =>
    runGatewayCmdUnlocked(cmd, { signal }),
  );

// Watchdog relaunches route through the same lock ("launch"): a crash-restart
// firing during a user-initiated restart queues instead of interleaving.
const launchGatewayProcess = () =>
  gatewayLifecycleLock.run("launch", ({ signal }) =>
    launchGatewayProcessUnlocked({ signal }),
  );

// Shutdown-path gateway stop. Replaces the old SIGTERM/SIGINT handlers that
// ran a blocking `openclaw gateway stop` and process.exit(0)'d on the same
// tick, orphaning the managed child (the "old version keeps the port, the new
// process skips gateway start" wedge). The lifecycle orchestrator awaits this.
// Cancels any in-flight lifecycle op first — never waits out a 120s command.
const stopGatewayForShutdown = async () => {
  await gatewayLifecycleLock.cancel();
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
    }
    return changed;
  } catch (e) {
    console.error(`[alphaclaw] ensureGatewayProxyConfig error: ${e.message}`);
    return false;
  }
};

// Channel add/remove now runs async under the lifecycle lock (each call used
// to be a 15s execSync PER CHANNEL, twice per env save). Tokens are passed as
// execFile ARGUMENTS, never interpolated into a shell string — the old
// `--token "${token}"` interpolation was a shell-injection hazard.
const syncChannelConfigUnlocked = async (savedVars, mode = "all", { signal } = {}) => {
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
        let addResult;
        if (ch === "slack") {
          const appToken = savedMap[def.extraEnvKeys?.[0]];
          if (!appToken) continue;
          addResult = await execOpenclaw(
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
            { timeoutMs: 15000, signal },
          );
          if (addResult.ok) {
            let raw = fs.readFileSync(configPath, "utf8");
            if (raw.includes(token)) {
              raw = raw.split(token).join("${" + def.envKey + "}");
            }
            if (raw.includes(appToken)) {
              raw = raw.split(appToken).join("${" + def.extraEnvKeys[0] + "}");
            }
            fs.writeFileSync(configPath, raw);
          }
        } else {
          addResult = await execOpenclaw(
            ["channels", "add", "--channel", ch, "--token", token],
            { timeoutMs: 15000, signal },
          );
          if (addResult.ok) {
            const raw = fs.readFileSync(configPath, "utf8");
            if (raw.includes(token)) {
              fs.writeFileSync(
                configPath,
                raw.split(token).join("${" + def.envKey + "}"),
              );
            }
          }
        }
        if (addResult.ok) {
          console.log(`[alphaclaw] Channel ${ch} added`);
        } else {
          console.error(
            `[alphaclaw] channels add ${ch}: ${(addResult.stderr || addResult.error?.message || "").toString().trim().slice(0, 200)}`,
          );
        }
      } else if (
        !token &&
        isConfigured &&
        (mode === "remove" || mode === "all")
      ) {
        console.log(`[alphaclaw] Removing channel: ${ch}`);
        const removeResult = await execOpenclaw(
          ["channels", "remove", "--channel", ch, "--delete"],
          { timeoutMs: 15000, signal },
        );
        if (removeResult.ok) {
          console.log(`[alphaclaw] Channel ${ch} removed`);
        } else {
          console.error(
            `[alphaclaw] channels remove ${ch}: ${(removeResult.stderr || removeResult.error?.message || "").toString().trim().slice(0, 200)}`,
          );
        }
      }
    }
  } catch (e) {
    console.error("[alphaclaw] syncChannelConfig error:", e.message);
  }
};

// Channel syncs carry ARGUMENTS (the vars being applied), so same-named
// joins would silently drop the later caller's data — every sync gets a
// unique key and queues FIFO instead of joining.
let channelSyncSeq = 0;
const syncChannelConfig = (savedVars, mode = "all") => {
  channelSyncSeq += 1;
  return gatewayLifecycleLock.run(`channel-sync:${mode}:${channelSyncSeq}`, ({ signal }) =>
    syncChannelConfigUnlocked(savedVars, mode, { signal }),
  );
};

const getChannelStatus = () => {
  try {
    const config = JSON.parse(
      fs.readFileSync(`${OPENCLAW_DIR}/openclaw.json`, "utf8"),
    );
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
  stopGatewayChild,
  stopGatewayChildAndWait,
  getGatewayPort,
  getGatewayUrl,
  isOnboarded,
  isGatewayRunning,
  launchGatewayProcess,
  cleanupOpenclawPluginInstallStages,
  prepareOpenclawChannelPlugins,
  setGatewayExitHandler,
  setGatewayLaunchHandler,
  runGatewayCmd,
  startGateway,
  restartGateway,
  restartGatewayLight,
  stopGatewayForShutdown,
  ensureGatewayProxyConfig,
  syncChannelConfig,
  getChannelStatus,
  // Exported for tests.
  stripNodeMemoryFlags,
};
