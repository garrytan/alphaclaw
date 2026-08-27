const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");
const { OPENCLAW_DIR } = require("./constants");
const { buildManagedPaths } = require("./internal-files-migration");
const {
  readOpenclawConfigForWrite,
  updateOpenclawConfig,
} = require("./openclaw-config");
const { getGatewayCredential, resolveConfigSecret } = require("./gateway-credential");
const { buildIdentityHeaders, kIdentityUserHeader } = require("./proxy-identity");

// Gateway auth-mode transition for team mode: snapshot -> apply -> restart ->
// probe -> auto-restore on failure. Config keys follow
// node_modules/openclaw/docs/gateway/trusted-proxy-auth.md exactly:
//   gateway.trustedProxies                       (source-IP allowlist)
//   gateway.auth.mode = "trusted-proxy"
//   gateway.auth.trustedProxy.userHeader         (identity header name)
//   gateway.auth.trustedProxy.allowUsers         (operator id allowlist)
//   gateway.auth.trustedProxy.allowLoopback      (AlphaClaw proxies from
//                                                 loopback on the same host)
//   gateway.auth.password                        (internal same-host callers;
//                                                 the doc's recommended
//                                                 fallback — token auth is
//                                                 mutually exclusive with
//                                                 trusted-proxy)

const kSnapshotFileName = "team-auth-snapshot.json";
const kSnapshotFileMode = 0o600;
const kLoopbackTrustedProxies = ["127.0.0.1", "::1"];
const kProbeTimeoutMs = 5000;
const kProbeHealthAttempts = 10;
const kProbeHealthRetryDelayMs = 1000;
const kAuthRejectedStatuses = new Set([401, 403, 407]);
const kTokenEnvRef = "${OPENCLAW_GATEWAY_TOKEN}";
const kPasswordEnvRef = "${OPENCLAW_GATEWAY_PASSWORD}";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveTeamAuthSnapshotPath = ({ openclawDir = OPENCLAW_DIR } = {}) =>
  path.join(buildManagedPaths({ openclawDir }).internalDir, kSnapshotFileName);

const readTeamAuthSnapshot = ({ fsModule = fs, openclawDir = OPENCLAW_DIR } = {}) => {
  try {
    const raw = fsModule.readFileSync(
      resolveTeamAuthSnapshotPath({ openclawDir }),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeTeamAuthSnapshot = ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  snapshot,
}) => {
  const snapshotPath = resolveTeamAuthSnapshotPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fsModule.writeFileSync(
    snapshotPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { mode: kSnapshotFileMode },
  );
  try {
    fsModule.chmodSync(snapshotPath, kSnapshotFileMode);
  } catch {}
  return snapshotPath;
};

const removeTeamAuthSnapshot = ({ fsModule = fs, openclawDir = OPENCLAW_DIR } = {}) => {
  try {
    fsModule.unlinkSync(resolveTeamAuthSnapshotPath({ openclawDir }));
  } catch {}
};

// Minimal HTTP request helper; injectable in tests via the `request` params.
const performHttpProbe = ({ url, method = "GET", headers = {}, body = null }) =>
  new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      return resolve({ status: 0, error: `Invalid probe URL: ${error.message}` });
    }
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      target,
      { method, headers, timeout: kProbeTimeoutMs },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode || 0, error: null });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("probe timed out"));
    });
    req.on("error", (error) => {
      resolve({ status: 0, error: error.message });
    });
    if (body) req.write(body);
    req.end();
  });

const probeHealth = async ({
  gatewayUrl,
  request,
  healthAttempts = kProbeHealthAttempts,
  healthRetryDelayMs = kProbeHealthRetryDelayMs,
}) => {
  let last = { status: 0, error: "no probe attempt" };
  for (let attempt = 0; attempt < healthAttempts; attempt += 1) {
    last = await request({ url: `${gatewayUrl}/health`, method: "GET" });
    if (!last.error && last.status >= 200 && last.status < 300) {
      return { ok: true };
    }
    await sleep(healthRetryDelayMs);
  }
  return {
    ok: false,
    error: last.error
      ? `gateway /health unreachable (${last.error})`
      : `gateway /health returned HTTP ${last.status}`,
  };
};

// /tools/invoke is always enabled and enforces gateway auth (tools-invoke doc),
// so it makes a cheap auth oracle: 401/403 means the credential path failed,
// any other status (including tool-level 4xx) means auth succeeded.
const probeAuthedInvoke = async ({ gatewayUrl, headers, request }) => {
  const invoke = await request({
    url: `${gatewayUrl}/tools/invoke`,
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ tool: "alphaclaw-identity-probe", action: "json", args: {} }),
  });
  if (invoke.error) {
    return { ok: false, error: `gateway auth probe failed (${invoke.error})` };
  }
  if (kAuthRejectedStatuses.has(invoke.status)) {
    return {
      ok: false,
      error: `gateway rejected the credential (HTTP ${invoke.status})`,
    };
  }
  return { ok: true };
};

// Loopback request with an injected identity header, exactly what the AlphaClaw
// proxy sends in team mode.
const probeIdentityHandshake = async ({
  gatewayUrl,
  operatorId,
  request = performHttpProbe,
  ...probeOptions
}) => {
  const health = await probeHealth({ gatewayUrl, request, ...probeOptions });
  if (!health.ok) return health;
  return probeAuthedInvoke({
    gatewayUrl,
    headers: buildIdentityHeaders({ id: operatorId }),
    request,
  });
};

const probeSharedSecret = async ({
  gatewayUrl,
  credential,
  request = performHttpProbe,
  ...probeOptions
}) => {
  const health = await probeHealth({ gatewayUrl, request, ...probeOptions });
  if (!health.ok) return health;
  if (!credential) {
    // No shared secret configured (e.g. auth-less local setups): liveness is
    // the best signal available.
    return { ok: true };
  }
  return probeAuthedInvoke({
    gatewayUrl,
    headers: { authorization: `Bearer ${credential}` },
    request,
  });
};

const derivePasswordCredential = ({ currentAuth = {}, env = process.env }) => {
  const envPassword = String(env.OPENCLAW_GATEWAY_PASSWORD || "").trim();
  const envToken = String(env.OPENCLAW_GATEWAY_TOKEN || "").trim();
  const configPassword = resolveConfigSecret(currentAuth.password, env);
  const configToken = resolveConfigSecret(currentAuth.token, env);
  const value =
    envPassword ||
    configPassword ||
    envToken ||
    configToken ||
    crypto.randomBytes(32).toString("hex");
  // Prefer an env reference in openclaw.json when the secret is env-backed
  // (gatewayEnv provides OPENCLAW_GATEWAY_PASSWORD to the gateway child);
  // otherwise the literal value has to live in the config for the gateway to
  // read it.
  const envBacked = value === envPassword || value === envToken;
  return { value, configValue: envBacked ? kPasswordEnvRef : value };
};

const restoreSnapshotConfig = ({ fsModule, openclawDir, snapshot, env }) => {
  updateOpenclawConfig({
    fsModule,
    openclawDir,
    mutate: (config) => {
      if (!config.gateway) config.gateway = {};
      if (snapshot && "gatewayAuth" in snapshot) {
        if (snapshot.gatewayAuth) config.gateway.auth = snapshot.gatewayAuth;
        else delete config.gateway.auth;
        if (Array.isArray(snapshot.trustedProxies)) {
          config.gateway.trustedProxies = snapshot.trustedProxies;
        } else if (snapshot.trustedProxies === null) {
          delete config.gateway.trustedProxies;
        }
        return;
      }
      // No snapshot: reconstruct token auth from the environment.
      if (String(env.OPENCLAW_GATEWAY_TOKEN || "").trim()) {
        config.gateway.auth = { mode: "token", token: kTokenEnvRef };
      } else {
        delete config.gateway.auth;
      }
    },
  });
};

// enableTeamMode: snapshot gateway auth, switch openclaw.json to trusted-proxy
// auth, restart the gateway, and verify the identity handshake end to end.
// Probe failure restores the snapshot and restarts again so a broken flip can
// never strand the gateway in an unusable auth mode.
const enableTeamMode = async ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  env = process.env,
  operators = [],
  restartGateway,
  getGatewayUrl,
  request = performHttpProbe,
  probeOptions = {},
  logger = console,
} = {}) => {
  const operatorIds = (Array.isArray(operators) ? operators : [])
    .map((operator) => String(operator?.id || "").trim())
    .filter(Boolean);
  if (operatorIds.length === 0) {
    return {
      ok: false,
      error: "Add at least one operator before enabling team mode.",
    };
  }
  if (typeof restartGateway !== "function" || typeof getGatewayUrl !== "function") {
    return { ok: false, error: "Gateway control is unavailable." };
  }

  let currentConfig;
  try {
    currentConfig = readOpenclawConfigForWrite({ fsModule, openclawDir });
  } catch (error) {
    return { ok: false, error: `Cannot read openclaw.json: ${error.message}` };
  }
  const currentAuth = currentConfig?.gateway?.auth || null;
  const alreadyTrustedProxy =
    String(currentAuth?.mode || "").trim() === "trusted-proxy";

  // Snapshot the pre-team auth config. When re-enabling while already in
  // trusted-proxy mode, keep the existing snapshot — it still points at the
  // original token-auth config we would want to restore.
  const existingSnapshot = readTeamAuthSnapshot({ fsModule, openclawDir });
  if (!alreadyTrustedProxy || !existingSnapshot) {
    writeTeamAuthSnapshot({
      fsModule,
      openclawDir,
      snapshot: {
        savedAt: new Date().toISOString(),
        gatewayAuth: currentAuth,
        trustedProxies: Array.isArray(currentConfig?.gateway?.trustedProxies)
          ? currentConfig.gateway.trustedProxies
          : null,
      },
    });
  }

  const password = derivePasswordCredential({ currentAuth: currentAuth || {}, env });

  try {
    updateOpenclawConfig({
      fsModule,
      openclawDir,
      mutate: (config) => {
        if (!config.gateway) config.gateway = {};
        const trustedProxies = new Set(
          Array.isArray(config.gateway.trustedProxies)
            ? config.gateway.trustedProxies
            : [],
        );
        for (const address of kLoopbackTrustedProxies) trustedProxies.add(address);
        config.gateway.trustedProxies = Array.from(trustedProxies);
        // Whole-object replacement: gateway.auth.token must not survive —
        // shared tokens are mutually exclusive with trusted-proxy mode.
        config.gateway.auth = {
          mode: "trusted-proxy",
          password: password.configValue,
          trustedProxy: {
            userHeader: kIdentityUserHeader,
            allowLoopback: true,
            allowUsers: operatorIds,
          },
        };
      },
    });
  } catch (error) {
    return { ok: false, error: `Could not update openclaw.json: ${error.message}` };
  }

  // A restart that THROWS (not just a failed probe) must also restore — the
  // trusted-proxy config is already on disk, so leaving it there with the
  // team flag never flipped (team-service sets it only on ok) is the
  // split-brain that 401s every dashboard→gateway request. Treat any
  // post-write failure as a probe failure and fall through to restore.
  let probe;
  try {
    await restartGateway();
    probe = await probeIdentityHandshake({
      gatewayUrl: getGatewayUrl(),
      operatorId: operatorIds[0],
      request,
      ...probeOptions,
    });
  } catch (error) {
    probe = { ok: false, error: `gateway restart failed: ${error.message}` };
  }
  if (probe.ok) {
    return { ok: true, allowUsers: operatorIds };
  }

  logger.warn?.(
    `[alphaclaw] Team mode enable failed (${probe.error}); restoring previous gateway auth`,
  );
  try {
    const snapshot = readTeamAuthSnapshot({ fsModule, openclawDir });
    restoreSnapshotConfig({ fsModule, openclawDir, snapshot, env });
    await restartGateway();
  } catch (error) {
    return {
      ok: false,
      restored: false,
      error: `${probe.error}; restore also failed: ${error.message}`,
    };
  }
  return { ok: false, restored: true, error: probe.error };
};

// disableTeamMode: restore the snapshot (or reconstruct token auth), restart,
// and probe the shared-secret path.
const disableTeamMode = async ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  env = process.env,
  restartGateway,
  getGatewayUrl,
  request = performHttpProbe,
  probeOptions = {},
} = {}) => {
  if (typeof restartGateway !== "function" || typeof getGatewayUrl !== "function") {
    return { ok: false, error: "Gateway control is unavailable." };
  }
  const snapshot = readTeamAuthSnapshot({ fsModule, openclawDir });
  try {
    restoreSnapshotConfig({ fsModule, openclawDir, snapshot, env });
  } catch (error) {
    return { ok: false, error: `Could not update openclaw.json: ${error.message}` };
  }

  await restartGateway();

  const credential = getGatewayCredential({ fsModule, openclawDir, env });
  const probe = await probeSharedSecret({
    gatewayUrl: getGatewayUrl(),
    credential: credential.value,
    request,
    ...probeOptions,
  });
  if (probe.ok) {
    removeTeamAuthSnapshot({ fsModule, openclawDir });
    return { ok: true };
  }
  return { ok: false, error: probe.error };
};

// Keeps gateway.auth.trustedProxy.allowUsers in sync when the operator list
// changes while team mode is on. No-op in any other auth mode.
const syncTeamAllowUsers = ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  operators = [],
} = {}) => {
  const operatorIds = (Array.isArray(operators) ? operators : [])
    .map((operator) => String(operator?.id || "").trim())
    .filter(Boolean);
  try {
    const config = readOpenclawConfigForWrite({ fsModule, openclawDir });
    if (String(config?.gateway?.auth?.mode || "").trim() !== "trusted-proxy") {
      return { changed: false };
    }
    const currentAllowUsers = Array.isArray(
      config?.gateway?.auth?.trustedProxy?.allowUsers,
    )
      ? config.gateway.auth.trustedProxy.allowUsers
      : [];
    if (JSON.stringify(currentAllowUsers) === JSON.stringify(operatorIds)) {
      return { changed: false };
    }
    updateOpenclawConfig({
      fsModule,
      openclawDir,
      mutate: (liveConfig) => {
        if (
          String(liveConfig?.gateway?.auth?.mode || "").trim() !== "trusted-proxy"
        ) {
          return;
        }
        if (!liveConfig.gateway.auth.trustedProxy) {
          liveConfig.gateway.auth.trustedProxy = {};
        }
        liveConfig.gateway.auth.trustedProxy.allowUsers = operatorIds;
      },
    });
    return { changed: true };
  } catch (error) {
    return { changed: false, error: error.message };
  }
};

module.exports = {
  kLoopbackTrustedProxies,
  kSnapshotFileName,
  disableTeamMode,
  enableTeamMode,
  performHttpProbe,
  probeIdentityHandshake,
  probeSharedSecret,
  readTeamAuthSnapshot,
  removeTeamAuthSnapshot,
  resolveTeamAuthSnapshotPath,
  syncTeamAllowUsers,
  writeTeamAuthSnapshot,
};
