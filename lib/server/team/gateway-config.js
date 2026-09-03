// Team mode gateway configuration (4.4).
//
// Writes OpenClaw's trusted-proxy auth config from the CURRENT member roster
// via the locked config writer, and preserves the pre-team `gateway.auth`
// subtree in AlphaClaw state (never in openclaw.json — beta's strict root
// rejects unknown keys, C6) so disable can restore it exactly.
//
// Reconciliation contract (E-C8): call applyTeamGatewayConfig after EVERY
// member mutation — enable, invite accept, role change, disable, remove —
// so allowUsers/identityScopes always reflect the roster. A disabled member
// loses GATEWAY authority here, not just AlphaClaw login.

// Scope names verified against the beta's OperatorScopeSchema (live e2e boots
// a real 2026.8 gateway with this exact subtree): operator.read / .write /
// .approvals / .admin / .questions / .pairing / .talk / .talk.secrets.
// deviceAutoApprove never carries operator.admin (upstream CRITICAL audit
// finding) — admin authority flows only through identityScopes.
const kDeviceAutoApproveScopes = Object.freeze([
  "operator.read",
  "operator.write",
  "operator.approvals",
]);
const kMemberScopes = Object.freeze([
  "operator.read",
  "operator.write",
  "operator.approvals",
]);
const kAdminScopes = Object.freeze([
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
]);
const kIdentityHeaderName = "x-alphaclaw-user";
const kLoopbackTrustedProxies = Object.freeze(["127.0.0.1", "::1"]);

// Intersect our desired scope names against the gateway's advertised set when
// it is known (CEO finding 8 — an unknown scope name fails beta config
// validation and causes exit-78 churn). Unknown advertised set → write our
// defaults unchanged; they come from the same beta docs the feature does.
const intersectScopes = (scopes, advertised) => {
  if (!Array.isArray(advertised) || advertised.length === 0) return [...scopes];
  const allowed = new Set(advertised.map((scope) => String(scope)));
  return scopes.filter((scope) => allowed.has(scope));
};

const buildTrustedProxyAuth = ({
  members = [],
  advertisedScopes = null,
  password = null,
} = {}) => {
  const active = members.filter((member) => member && !member.disabled);
  const identityScopes = {};
  for (const member of active) {
    identityScopes[member.email] = intersectScopes(
      member.role === "admin" ? kAdminScopes : kMemberScopes,
      advertisedScopes,
    );
  }
  return {
    mode: "trusted-proxy",
    // Internal same-host callers (openclaw CLI, gatewayEnv subprocesses)
    // authenticate via the local-direct password fallback — token auth is
    // mutually exclusive with trusted-proxy mode. Usually the env-ref
    // "${OPENCLAW_GATEWAY_PASSWORD}"; applyGatewayAuthEnv provides the value
    // to the gateway child.
    ...(password ? { password } : {}),
    // Per-identity authority lives at gateway.auth.identityScopes in the
    // beta schema (trustedProxy rejects the key — strict object).
    identityScopes,
    trustedProxy: {
      userHeader: kIdentityHeaderName,
      // Same-host proxy: AlphaClaw reaches the gateway over loopback. This is
      // why host isolation is a documented precondition of the enable wizard
      // (E-C3) — allowLoopback makes any local process able to set the header.
      allowLoopback: true,
      deviceAutoApprove: {
        enabled: true,
        scopes: intersectScopes(kDeviceAutoApproveScopes, advertisedScopes),
      },
      allowUsers: active.map((member) => member.email),
    },
  };
};

const createTeamGatewayConfig = ({
  openclawDir,
  updateOpenclawConfig,
  teamStateStore,
  membersStore,
  getAdvertisedScopes = async () => null,
  env = process.env,
  nowFn = Date.now,
} = {}) => {
  // Lazy require: team-auth-transition imports nothing from this module, so
  // the edge stays acyclic.
  const { derivePasswordCredential } = require("../team-auth-transition");
  // Rebuild gateway.auth from the current roster. Captures the pre-team auth
  // subtree into AlphaClaw state on first enable only.
  const applyTeamGatewayConfig = async () => {
    const advertisedScopes = await Promise.resolve()
      .then(() => getAdvertisedScopes())
      .catch(() => null);
    const members = membersStore.listMembers();
    let previousAuth;
    let nextAuth;
    // updateOpenclawConfig persists the config object mutated IN PLACE (its
    // return value is metadata, not the next config).
    updateOpenclawConfig({
      openclawDir,
      mutate: (cfg) => {
        const gateway =
          cfg.gateway && typeof cfg.gateway === "object" ? cfg.gateway : {};
        previousAuth =
          gateway.auth && gateway.auth.mode !== "trusted-proxy"
            ? gateway.auth
            : undefined;
        // Stable across reconciliations: an existing password (or env-backed
        // secret) is reused, so repeated roster rebuilds never rotate the
        // internal-caller credential.
        const password = derivePasswordCredential({
          currentAuth: gateway.auth || {},
          env,
        });
        nextAuth = buildTrustedProxyAuth({
          members,
          advertisedScopes,
          password: password.configValue,
        });
        gateway.auth = nextAuth;
        // trusted-proxy mode refuses to start without at least one proxy IP.
        // ensureGatewayProxyConfig normally adds this at boot; guarantee it
        // here so enable → restart cannot race into a refusing gateway.
        const proxies = Array.isArray(gateway.trustedProxies)
          ? gateway.trustedProxies
          : [];
        for (const address of kLoopbackTrustedProxies) {
          if (!proxies.includes(address)) proxies.push(address);
        }
        gateway.trustedProxies = proxies;
        cfg.gateway = gateway;
      },
    });
    teamStateStore.update((state) => ({
      ...state,
      enabledAt: state.enabledAt || nowFn(),
      // Preserve only the FIRST pre-team auth subtree; reconciliation runs
      // repeatedly and must not overwrite it with our own trusted-proxy blob.
      previousGatewayAuth:
        state.previousGatewayAuth !== undefined
          ? state.previousGatewayAuth
          : previousAuth ?? null,
      lastAppliedAt: nowFn(),
      allowUsers: nextAuth.trustedProxy.allowUsers,
    }));
    return { auth: nextAuth };
  };

  // Restore the preserved pre-team auth subtree (or remove gateway.auth
  // entirely when there was none).
  const revertTeamGatewayConfig = () => {
    const state = teamStateStore.read();
    const previousAuth = state.previousGatewayAuth;
    updateOpenclawConfig({
      openclawDir,
      mutate: (cfg) => {
        const gateway =
          cfg.gateway && typeof cfg.gateway === "object" ? cfg.gateway : {};
        if (previousAuth === null || previousAuth === undefined) {
          delete gateway.auth;
        } else {
          gateway.auth = previousAuth;
        }
        cfg.gateway = gateway;
      },
    });
    teamStateStore.update((current) => ({
      ...current,
      enabledAt: null,
      previousGatewayAuth: undefined,
      lastRevertedAt: nowFn(),
      allowUsers: [],
    }));
    return { restored: previousAuth ?? null };
  };

  return { applyTeamGatewayConfig, revertTeamGatewayConfig, buildTrustedProxyAuth };
};

module.exports = {
  createTeamGatewayConfig,
  buildTrustedProxyAuth,
  kIdentityHeaderName,
  kAdminScopes,
  kMemberScopes,
  kDeviceAutoApproveScopes,
};
