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
const { buildIdentityHeaders } = require("./proxy-identity");

// Gateway auth-mode transition for team mode: snapshot -> apply -> restart ->
// probe -> auto-restore on failure. The gateway.auth SHAPE is owned by the
// single writer in team/gateway-config.js (buildTrustedProxyAuth — the
// live-verified beta subtree with auth-level identityScopes); this module
// owns the TRANSITION around it: the pre-team snapshot, the restart, the
// loopback identity-handshake probe, and restoring the snapshot when the
// flip fails. gateway.auth.password (internal same-host callers — token auth
// is mutually exclusive with trusted-proxy) is derived here and written by
// the gateway-config writer.

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

// enableTeamMode: snapshot gateway auth, let the roster-driven writer
// (team/gateway-config.js applyTeamGatewayConfig) switch openclaw.json to
// trusted-proxy auth, restart the gateway, and verify the identity handshake
// end to end. Probe failure restores the snapshot and restarts again so a
// broken flip can never strand the gateway in an unusable auth mode.
const enableTeamMode = async ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  env = process.env,
  // Single writer of gateway.auth (+ trustedProxies): rebuilds the subtree
  // from the CURRENT member roster.
  applyAuthConfig,
  // Member email injected as the identity header for the handshake probe.
  probeUser = "",
  restartGateway,
  getGatewayUrl,
  request = performHttpProbe,
  probeOptions = {},
  logger = console,
} = {}) => {
  const probeUserId = String(probeUser || "").trim();
  if (!probeUserId) {
    return {
      ok: false,
      error: "Create your admin account before enabling team access.",
    };
  }
  if (typeof applyAuthConfig !== "function") {
    return { ok: false, error: "Gateway auth writer is unavailable." };
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

  try {
    await applyAuthConfig();
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
      operatorId: probeUserId,
      request,
      ...probeOptions,
    });
  } catch (error) {
    probe = { ok: false, error: `gateway restart failed: ${error.message}` };
  }
  if (probe.ok) {
    return { ok: true };
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
  derivePasswordCredential,
  writeTeamAuthSnapshot,
};
