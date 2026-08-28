const fs = require("fs");
const { OPENCLAW_DIR } = require("./constants");
const {
  isTeamEnabled,
  updateTeamConfig,
} = require("./alphaclaw-config");
const operatorsStore = require("./operators-store");
const {
  disableTeamMode,
  enableTeamMode,
  probeIdentityHandshake,
  syncTeamAllowUsers,
} = require("./team-auth-transition");

const kIdentityProbeCacheMs = 60 * 1000;

// Facade over the team feature: config flag, operator roster, session ->
// operator resolution, and the gateway auth-mode transition. One instance is
// created at server wiring time and shared by auth, proxy, and team routes.
//
// NOT a security boundary: every operator shares the single SETUP_PASSWORD.
// Operator identity is display/attribution metadata layered on top.
const createTeamService = ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  env = process.env,
  restartGateway = null,
  getGatewayUrl = null,
  request = undefined,
  probeOptions = {},
  logger = console,
} = {}) => {
  let identityProbeCache = null;
  let transitionInFlight = false;

  const storeOptions = () => ({ fsModule, openclawDir });

  const teamEnabled = () => isTeamEnabled(storeOptions());
  const listOperators = () => operatorsStore.listOperators(storeOptions());
  const getOperatorsVersion = () =>
    operatorsStore.getOperatorsVersion(storeOptions());
  const getOperator = (operatorId) =>
    operatorsStore.getOperatorById(operatorId, storeOptions());

  // Downgrade rules (never a logout): missing claims, an opsv older than the
  // current operatorsVersion, or a sub that no longer exists all resolve to
  // an anonymous — but still authenticated — session.
  const resolveOperatorForSession = (claims = {}) => {
    if (!teamEnabled()) return null;
    const sub = String(claims?.sub || "").trim();
    if (!sub) return null;
    const opsv = Number(claims?.opsv);
    if (!Number.isFinite(opsv) || opsv < getOperatorsVersion()) return null;
    return getOperator(sub);
  };

  const setOperators = (operators) => {
    const state = operatorsStore.setOperators({
      ...storeOptions(),
      operators,
    });
    // Keep the gateway allowlist current while team mode is on; the gateway
    // reloads gateway.auth on restart, so a stale allowlist self-heals on the
    // next restart even if a hot reload is unsupported.
    if (teamEnabled()) {
      const sync = syncTeamAllowUsers({
        ...storeOptions(),
        operators: state.operators,
      });
      if (sync.error) {
        logger.warn?.(
          `[alphaclaw] Could not sync gateway allowUsers: ${sync.error}`,
        );
      }
    }
    identityProbeCache = null;
    return state;
  };

  const getLoginInfo = () => {
    if (!teamEnabled()) return { teamEnabled: false, operators: [] };
    return {
      teamEnabled: true,
      // Names only — the unauthenticated login page must not leak emails.
      operators: listOperators().map(({ id, name }) => ({ id, name })),
    };
  };

  const runIdentityProbe = async () => {
    const operators = listOperators();
    if (typeof getGatewayUrl !== "function" || operators.length === 0) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: operators.length === 0 ? "No operators configured" : "Gateway unavailable",
      };
    }
    const probe = await probeIdentityHandshake({
      gatewayUrl: getGatewayUrl(),
      operatorId: operators[0].id,
      ...(request ? { request } : {}),
      healthAttempts: 1,
      ...probeOptions,
    });
    return {
      ok: probe.ok === true,
      checkedAt: new Date().toISOString(),
      error: probe.ok ? null : probe.error || "Identity probe failed",
    };
  };

  // Cached (60s) loopback identity handshake result, only meaningful while
  // team mode is on.
  const getIdentityProbe = async () => {
    if (!teamEnabled()) return null;
    const now = Date.now();
    if (identityProbeCache && now - identityProbeCache.at < kIdentityProbeCacheMs) {
      return identityProbeCache.result;
    }
    const result = await runIdentityProbe();
    identityProbeCache = { at: now, result };
    return result;
  };

  const setEnabled = async (enabled) => {
    const wantEnabled = enabled === true;
    if (wantEnabled === teamEnabled()) {
      return { ok: true, enabled: wantEnabled, changed: false };
    }
    if (transitionInFlight) {
      return { ok: false, error: "A team-mode transition is already running." };
    }
    transitionInFlight = true;
    try {
      identityProbeCache = null;
      if (wantEnabled) {
        const result = await enableTeamMode({
          fsModule,
          openclawDir,
          env,
          operators: listOperators(),
          restartGateway,
          getGatewayUrl,
          ...(request ? { request } : {}),
          probeOptions,
          logger,
        });
        if (!result.ok) return { ...result, enabled: false };
        updateTeamConfig({ fsModule, openclawDir, enabled: true });
        return { ok: true, enabled: true, changed: true };
      }
      const result = await disableTeamMode({
        fsModule,
        openclawDir,
        env,
        restartGateway,
        getGatewayUrl,
        ...(request ? { request } : {}),
        probeOptions,
      });
      // Disabling always lands on team-off in alphaclaw.json — a failed probe
      // is reported but must not strand the flag on.
      updateTeamConfig({ fsModule, openclawDir, enabled: false });
      if (!result.ok) {
        return { ok: false, enabled: false, changed: true, error: result.error };
      }
      return { ok: true, enabled: false, changed: true };
    } finally {
      transitionInFlight = false;
    }
  };

  return {
    getIdentityProbe,
    getLoginInfo,
    getOperator,
    getOperatorsVersion,
    isTeamEnabled: teamEnabled,
    listOperators,
    resolveOperatorForSession,
    setEnabled,
    setOperators,
  };
};

module.exports = { createTeamService };
