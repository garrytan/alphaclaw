const fs = require("fs");
const os = require("os");
const net = require("net");
const { readRelayConfig } = require("./config");
const {
  kRelayEngineVersion,
  kRelaySidecarName,
  relayPaths,
} = require("./constants");
const { resolveEnginePlatform, engineFileName, ensureEngineBinary } = require("./engine-binary");
const { createEngineClient } = require("./engine-client");
const {
  ensureRelayDir,
  ensureInternalSecret,
  readInternalSecret,
  readRelaySecrets,
  writeRelaySecrets,
  resolveBoxAgentName,
  provisionRelay,
} = require("./provision");
const { openBridgeStore } = require("./bridge-store");
const { createRelayBridge } = require("./bridge");
const { createRelayMasker, collectRelaySecrets } = require("./mask");
const { createRelayConversations } = require("./conversations");
const { createRelayBrainArchive } = require("./brain-archive");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { RelayError, describeRelayError, toRelayError } = require("./errors");

// The relay service: owns the self-hosted Agent Relay on this box.
//
//   boot -> binary (download + verify, backoff) -> internal secret
//        -> engine sidecar (built-in "relay-engine", supervised, restarted)
//        -> /health -> provisioning (workspace + box agent, secrets.json)
//        -> bridge (relay DMs to the box agent become agent runs)
//
// Each step that fails leaves a coded state (errors.js) on the Relay page
// and retries with backoff, except the two that need a person
// (platform_unsupported, secrets_missing). ALPHACLAW_RELAY=off skips it all.
const kRetryBaseMs = 30 * 1000;
const kRetryMaxMs = 30 * 60 * 1000;
const kHealthWaitMs = 60 * 1000;
const kHealthPollMs = 500;
const kRetentionSweepMs = 6 * 60 * 60 * 1000;
const kExposureCheckMs = 10 * 60 * 1000;
const kNoRetryCodes = new Set(["platform_unsupported", "secrets_missing", "relay_disabled"]);

// The engine runs with only what it needs: no AlphaClaw secret, no provider
// key, no gateway token. RELAYCAST_INTERNAL_SECRET_FILE is a path; the
// secret itself stays in its 0600 file.
const buildRelayEngineSidecarEntry = ({ config, paths, target = resolveEnginePlatform() }) => ({
  name: kRelaySidecarName,
  command: [
    require("path").join(paths.binDir, engineFileName(target || "unsupported")),
    "--db",
    paths.engineDb,
    "--port",
    String(config.port),
  ],
  cwd: paths.dir,
  env: {
    HOME: paths.dir,
    RELAYCAST_INTERNAL_SECRET_FILE: paths.internalSecretFile,
    RELAYCAST_PUBLIC_WORKSPACE_CREATE: "false",
    ...(config.retentionDays > 0 ? { RELAYCAST_MESSAGE_TTL_DAYS: String(config.retentionDays) } : {}),
  },
  restart: "always",
  stopTimeoutSeconds: 5,
});

// The engine sidecar exists only where a pinned engine build does: on any
// other platform (native Windows) the relay reports platform_unsupported
// instead of a sidecar entry that cannot start.
const buildRelayBuiltinSidecars = ({ config, paths, target = resolveEnginePlatform() }) =>
  config.enabled && target ? [buildRelayEngineSidecarEntry({ config, paths, target })] : [];

const listNonLoopbackAddresses = (interfaces = os.networkInterfaces()) => {
  const out = [];
  for (const list of Object.values(interfaces || {})) {
    for (const address of list || []) {
      if (!address || address.internal) continue;
      if (address.family === "IPv4" || address.family === 4) out.push(address.address);
    }
  }
  return out;
};

const probeTcp = (host, port, timeoutMs = 1000) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

const createRelayService = ({
  env = process.env,
  rootDir,
  fsModule = fs,
  getSupervisor,
  readDefaultAgentLabel = () => "",
  resolveAgentId = () => "main",
  createGatewayClient = null,
  fetchImpl = globalThis.fetch,
  ensureBinary = ensureEngineBinary,
  listAddresses = listNonLoopbackAddresses,
  probe = probeTcp,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
  onRelayMessage = () => {},
  onReady = () => {},
  brainArchiveOptions = {},
}) => {
  const config = readRelayConfig({ env, defaultAgentLabel: readDefaultAgentLabel() });
  const paths = relayPaths(rootDir);
  const engine = createEngineClient({ baseUrl: "http://127.0.0.1:" + config.port, fetchImpl });
  const maskText = createRelayMasker({ rootDir, env, fsModule });
  const state = {
    phase: config.enabled ? "idle" : "off",
    error: null,
    attempts: 0,
    retryAt: null,
    retryTimer: null,
    sweepTimer: null,
    exposureTimer: null,
    auth: null,
    store: null,
    bridge: null,
    archive: null,
    gateway: null,
    exposure: { checkedAt: null, exposedOn: [] },
    startedAt: null,
    readyAt: null,
    stopped: false,
  };

  const log = (line) => logger.log("[relay] " + line);

  const setPhase = (phase, error = null) => {
    state.phase = phase;
    state.error = error ? describeRelayError(error.code, error.message) : null;
  };

  const getAuth = () => {
    if (!state.auth) throw new RelayError("provisioning_pending", "The relay has not finished provisioning.");
    return state.auth;
  };

  const waitForHealth = async () => {
    const deadline = now() + kHealthWaitMs;
    for (;;) {
      try {
        await engine.health();
        return;
      } catch (error) {
        if (now() >= deadline || state.stopped) throw error;
      }
      await new Promise((resolve) => setTimer(resolve, kHealthPollMs));
    }
  };

  const checkExposure = async () => {
    const exposedOn = [];
    for (const host of listAddresses()) {
      if (await probe(host, config.port)) exposedOn.push(host);
    }
    state.exposure = { checkedAt: new Date(now()).toISOString(), exposedOn };
    if (exposedOn.length) {
      logger.warn("[relay] the relay engine answers on a non-loopback address (" + exposedOn.join(", ") + ") port " + config.port + "; every route but /health needs a key, and anonymous workspace creation is off");
    }
  };

  const sweepRetention = () => {
    try {
      const removed = state.store?.prune(config.retentionDays) || 0;
      if (removed) log("retention removed " + removed + " bridged message record(s) older than " + config.retentionDays + " days");
    } catch (error) {
      logger.warn("[relay] retention sweep failed: " + (error?.message || error));
    }
  };

  const scheduleRetry = (error) => {
    if (state.stopped || kNoRetryCodes.has(error.code)) return;
    const delay = Math.min(kRetryMaxMs, kRetryBaseMs * 2 ** Math.min(state.attempts, 10));
    state.attempts += 1;
    state.retryAt = new Date(now() + delay).toISOString();
    state.retryTimer = setTimer(() => {
      state.retryTimer = null;
      void run();
    }, delay);
    state.retryTimer?.unref?.();
  };

  const startBridge = () => {
    if (state.bridge) return;
    state.store = state.store || openBridgeStore({ dbPath: paths.bridgeDb, now });
    let bridge = null;
    if (typeof createGatewayClient === "function") {
      state.gateway = createGatewayClient({
        onEvent: (payload) => bridge?.handleGatewayEvent(payload),
        onDisconnect: () => bridge?.onGatewayDisconnect(),
      });
    }
    bridge = createRelayBridge({
      engine,
      getAuth,
      store: state.store,
      requestGateway: state.gateway ? state.gateway.requestGateway : async () => { throw new Error("OpenClaw gateway is not connected"); },
      resolveAgentId,
      config,
      onRelayMessage,
      maskText,
      now,
      setTimer,
      clearTimer,
      logger,
    });
    state.bridge = bridge;
    bridge.start();
    // The brain archive reads the engine, the bridge's store and the relay
    // sessions on its own timer; nothing in the bridge waits on it.
    state.archive = createRelayBrainArchive({
      config,
      paths,
      engine,
      getAuth,
      conversations: createRelayConversations({ relayService: { getAuth, engine, getStore: () => state.store }, resolveAgentId }),
      getBridgeStore: () => state.store,
      requestGateway: state.gateway ? state.gateway.requestGateway : null,
      resolveAgentId,
      maskText,
      collectSecrets: () => Array.from(collectRelaySecrets({ rootDir, env, fsModule })),
      env,
      now,
      setTimer,
      clearTimer,
      logger,
      ...brainArchiveOptions,
    });
    state.archive.start();
    sweepRetention();
    state.sweepTimer = setInterval(sweepRetention, kRetentionSweepMs);
    state.sweepTimer.unref?.();
  };

  const run = async () => {
    if (state.stopped) return;
    try {
      setPhase("downloading");
      ensureRelayDir(paths, fsModule);
      const engineDbExistedAtStart = fsModule.existsSync(paths.engineDb);
      await ensureBinary({ binDir: paths.binDir, fetchImpl, fsModule, logger });
      if (state.stopped) return;
      ensureInternalSecret(paths, fsModule);
      if (!engineDbExistedAtStart && !readRelaySecrets(paths, fsModule)) {
        writeRelaySecrets(paths, { state: "creating", startedAt: new Date(now()).toISOString() }, fsModule);
      }
      setPhase("engine_starting");
      const supervisor = getSupervisor();
      if (!supervisor) throw new RelayError("engine_unavailable", "The relay engine sidecar is not registered.");
      supervisor.start();
      try {
        await waitForHealth();
      } catch (error) {
        throw new RelayError("engine_unavailable", "The relay engine did not answer /health within " + kHealthWaitMs / 1000 + " s.");
      }
      setPhase("provisioning");
      const agentName = resolveBoxAgentName({ secrets: readRelaySecrets(paths, fsModule), config });
      try {
        state.auth = await provisionRelay({
          client: engine,
          paths,
          agentName,
          agentPersona: "This box's OpenClaw agent (AlphaClaw).",
          engineDbExistedAtStart,
          fsModule,
          logger,
        });
      } catch (error) {
        throw error?.code === "secrets_missing" || error?.code === "provisioning_failed"
          ? error
          : new RelayError("provisioning_failed", "Provisioning failed: " + (error?.message || error));
      }
      if (state.stopped) return;
      startBridge();
      await checkExposure().catch(() => {});
      if (!state.exposureTimer) {
        state.exposureTimer = setInterval(() => void checkExposure().catch(() => {}), kExposureCheckMs);
        state.exposureTimer.unref?.();
      }
      state.attempts = 0;
      state.retryAt = null;
      state.readyAt = new Date(now()).toISOString();
      setPhase("ready");
      try {
        onReady();
      } catch {}
      log("ready: engine " + kRelayEngineVersion + " on 127.0.0.1:" + config.port + ", box agent " + state.auth.agentName);
    } catch (error) {
      const relayError = toRelayError(error);
      setPhase("failed", relayError);
      logger.warn("[relay] " + relayError.code + ": " + relayError.message);
      scheduleRetry(relayError);
    }
  };

  const start = () => {
    if (!config.enabled) {
      log("off (ALPHACLAW_RELAY=off)");
      return;
    }
    if (state.startedAt) return;
    state.startedAt = new Date(now()).toISOString();
    void run();
  };

  const stop = () => {
    state.stopped = true;
    if (state.retryTimer) clearTimer(state.retryTimer);
    if (state.sweepTimer) clearInterval(state.sweepTimer);
    if (state.exposureTimer) clearInterval(state.exposureTimer);
    state.bridge?.stop();
    state.archive?.stop();
    state.archive = null;
    try {
      state.gateway?.close();
    } catch {}
    try {
      state.store?.close();
    } catch {}
    state.store = null;
    state.bridge = null;
  };

  const getStatus = () => {
    const supervisor = config.enabled ? getSupervisor?.() : null;
    const engineProcess = supervisor?.getStatus?.() || null;
    return {
      enabled: config.enabled,
      phase: state.phase,
      error: state.error,
      retryAt: state.retryAt,
      engine: {
        version: kRelayEngineVersion,
        target: resolveEnginePlatform(),
        port: config.port,
        process: engineProcess
          ? {
              status: engineProcess.status || null,
              pid: engineProcess.pid || null,
              starts: engineProcess.starts ?? null,
              startedAt: engineProcess.startedAt || null,
              lastExit: engineProcess.lastExit || null,
              crashLoop: engineProcess.crashLoop || null,
            }
          : null,
        exposure: state.exposure,
      },
      agentName: state.auth?.agentName || null,
      settings: {
        retentionDays: config.retentionDays,
        maxConcurrent: config.maxConcurrent,
        hourlyCap: config.hourlyCap,
        agentNameRejected: config.agentNameRejected,
      },
      bridge: state.bridge ? state.bridge.getStatus() : null,
      archive: state.archive ? state.archive.getStatus() : { enabled: config.enabled && config.brainMode !== "off", phase: config.enabled && config.brainMode !== "off" ? "waiting" : "off", code: null },
      startedAt: state.startedAt,
      readyAt: state.readyAt,
    };
  };

  const fileSize = (file) => {
    try {
      return fsModule.statSync(file).size;
    } catch {
      return null;
    }
  };

  return {
    config,
    paths,
    engine,
    start,
    stop,
    getStatus,
    getAuth,
    maskText,
    // The bearer of /relay/internal/mask: the relay's internal secret (0600).
    isInternalSecret: (candidate) => {
      if (!config.enabled || !candidate) return false;
      try {
        return timingSafeStringEqual(String(candidate), readInternalSecret(paths, fsModule));
      } catch {
        return false;
      }
    },
    getStore: () => state.store,
    retryArchive: () => (state.archive ? state.archive.retry() : null),
    resolveAgentId,
    isReady: () => state.phase === "ready",
    dbSizes: () => ({ engine: fileSize(paths.engineDb), bridge: fileSize(paths.bridgeDb), archive: fileSize(paths.archiveDb) }),
    _internal: { run, checkExposure, sweepRetention, state },
  };
};

module.exports = { createRelayService, buildRelayEngineSidecarEntry, buildRelayBuiltinSidecars, listNonLoopbackAddresses };
