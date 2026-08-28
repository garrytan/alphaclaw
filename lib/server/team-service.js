const fs = require("fs");
const { OPENCLAW_DIR } = require("./constants");
const { isTeamEnabled, updateTeamConfig } = require("./alphaclaw-config");
const {
  disableTeamMode,
  enableTeamMode,
  probeIdentityHandshake,
} = require("./team-auth-transition");

const kIdentityProbeCacheMs = 60 * 1000;

// Facade over the team-mode TRANSITION: the config flag, the snapshot ->
// write -> restart -> probe -> auto-restore state machine, and the cached
// identity-handshake probe. One instance is created at server wiring time and
// shared by the team routes.
//
// The roster is the credentialed members store (4.1) and the gateway.auth
// subtree is owned by team/gateway-config.js — this service never edits
// either directly; it drives the transition around the injected writer.
const createTeamService = ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  env = process.env,
  restartGateway = null,
  getGatewayUrl = null,
  membersStore = null,
  // team/gateway-config.js applyTeamGatewayConfig — the single writer of
  // gateway.auth (+ trustedProxies), rebuilt from the current roster.
  applyTeamGatewayConfig = null,
  request = undefined,
  probeOptions = {},
  logger = console,
} = {}) => {
  let identityProbeCache = null;
  let transitionInFlight = false;

  const storeOptions = () => ({ fsModule, openclawDir });
  const teamEnabled = () => isTeamEnabled(storeOptions());

  const activeMembers = () =>
    (membersStore?.listMembers?.() || []).filter(
      (member) => member && !member.disabled,
    );
  // The probe injects a real allowUsers/identityScopes key: prefer an admin
  // (always present — the last-admin guard keeps one), fall back to anyone.
  const probeUserEmail = () => {
    const members = activeMembers();
    const admin = members.find((member) => member.role === "admin");
    return String(admin?.email || members[0]?.email || "").trim();
  };

  const runIdentityProbe = async () => {
    const probeUser = probeUserEmail();
    if (typeof getGatewayUrl !== "function" || !probeUser) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: !probeUser ? "No members configured" : "Gateway unavailable",
      };
    }
    const probe = await probeIdentityHandshake({
      gatewayUrl: getGatewayUrl(),
      operatorId: probeUser,
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

  // Roster mutations change what a fresh probe would verify.
  const invalidateIdentityProbe = () => {
    identityProbeCache = null;
  };

  const setEnabled = async (enabled) => {
    const wantEnabled = enabled === true;
    if (wantEnabled === teamEnabled()) {
      return { ok: true, enabled: wantEnabled, changed: false };
    }
    if (transitionInFlight) {
      return {
        ok: false,
        code: "transition_in_flight",
        error: "A team-mode transition is already running.",
      };
    }
    transitionInFlight = true;
    try {
      identityProbeCache = null;
      if (wantEnabled) {
        const result = await enableTeamMode({
          fsModule,
          openclawDir,
          env,
          applyAuthConfig: applyTeamGatewayConfig,
          probeUser: probeUserEmail(),
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
    invalidateIdentityProbe,
    isTeamEnabled: teamEnabled,
    isTransitionInFlight: () => transitionInFlight,
    setEnabled,
  };
};

module.exports = { createTeamService };
