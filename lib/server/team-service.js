const { GatewayMutationBlockedError } = require("./gateway-mutation-policy");
const fs = require("fs");
const { OPENCLAW_DIR } = require("./constants");
const { isTeamEnabled, updateTeamConfig } = require("./alphaclaw-config");
const {
  disableTeamMode,
  enableTeamMode,
  probeIdentityHandshake,
} = require("./team-auth-transition");

const kIdentityProbeCacheMs = 60 * 1000;

const rosterReconciliationDeferredFields = (error) => error instanceof GatewayMutationBlockedError
  ? { memberSaved: true, configSaved: true, gatewayConfigSaved: false, gatewayConfigDeferred: true,
      restartRequired: true, restartDeferred: true, code: error.code,
      hint: `${error.hint || "Resolve the gateway blocker."} An administrator must then save member settings again to sync gateway authentication; restarting alone does not sync the roster.` }
  : {};

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
  withGatewayTransition = (run) => run({ restartGateway, assertCanMutate: () => {} }),
  membersStore = null,
  // team/gateway-config.js applyTeamGatewayConfig — the single writer of
  // gateway.auth (+ trustedProxies), rebuilt from the current roster.
  applyTeamGatewayConfig = null,
  request = undefined,
  probeOptions = {},
  logger = console,
  // Optional auto-fix notifier, threaded into enableTeamMode's restore path.
  notify = null,
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

  // This callback is supplied by the human route, never copied from request
  // fields. Owner credentials are verified/created only after admission.
  const setEnabled = async (enabled, { prepareEnable = null } = {}) => {
    const wantEnabled = enabled === true;
    if (transitionInFlight) {
      return {
        ok: false,
        code: "transition_in_flight",
        error: "A team-mode transition is already running.",
      };
    }
    const wasEnabled = teamEnabled();
    if (wantEnabled === wasEnabled) return { ok: true, enabled: wantEnabled, changed: false };
    transitionInFlight = true;
    let transitionEvidence = {};
    let preparationEvidence = {};
    try {
      return await withGatewayTransition(async ({ restartGateway: scopedRestart, assertCanMutate }) => {
        assertCanMutate();
        if (wantEnabled === teamEnabled()) return { ok: true, enabled: wantEnabled, changed: false };
        if (wantEnabled && typeof prepareEnable === "function") {
          const prepared = await prepareEnable();
          preparationEvidence = { ...prepared };
          transitionEvidence = { ...prepared };
          if (prepared?.ok === false) return { ...prepared, enabled: teamEnabled(), changed: false };
          assertCanMutate();
        }
        identityProbeCache = null;
        // Keep persisted routing mode aligned with persisted gateway auth,
        // synchronously under this transition's lease. Lockdown and session
        // revocation remain in the route AFTER a verified successful probe.
        const onAuthConfigApplied = () => {
          assertCanMutate();
          transitionEvidence.configApplied = true;
          updateTeamConfig({ fsModule, openclawDir, enabled: true });
        };
        const onAuthConfigRestored = () => {
          assertCanMutate();
          transitionEvidence.configRestored = true;
          updateTeamConfig({ fsModule, openclawDir, enabled: false });
        };
        const result = wantEnabled
          ? await enableTeamMode({
              fsModule, openclawDir, env, applyAuthConfig: applyTeamGatewayConfig,
              probeUser: probeUserEmail(), restartGateway: scopedRestart,
              assertCanMutate, onAuthConfigApplied, onAuthConfigRestored,
              getGatewayUrl, ...(request ? { request } : {}), probeOptions, logger, notify,
            })
          : await disableTeamMode({
              fsModule, openclawDir, env, restartGateway: scopedRestart,
              assertCanMutate, onAuthConfigRestored, getGatewayUrl,
              ...(request ? { request } : {}), probeOptions,
            });
        transitionEvidence = { ...transitionEvidence, ...result };
        const enabledNow = teamEnabled();
        return { ...preparationEvidence, ...result, enabled: enabledNow, changed: enabledNow !== wasEnabled };
      });
    } catch (error) {
      if (!(error instanceof GatewayMutationBlockedError)) throw error;
      return { ...transitionEvidence, ok: false, blocked: true, code: error.code, hint: error.hint,
        error: error.message, restartDeferred: true, enabled: teamEnabled(), changed: teamEnabled() !== wasEnabled };
    } finally {
      transitionInFlight = false;
    }
  };

  // Roster changes use the same ownership as enable/disable, but never call
  // setEnabled (or acquire a second lease inside an existing transition).
  const reconcileRoster = async () => {
    if (!teamEnabled()) return false;
    return withGatewayTransition(async ({ assertCanMutate }) => {
      assertCanMutate();
      if (!teamEnabled()) return false;
      const result = await applyTeamGatewayConfig({ assertCanMutate, shouldApply: teamEnabled });
      assertCanMutate();
      if (result?.skipped) return false;
      identityProbeCache = null;
      return true;
    });
  };

  return {
    getIdentityProbe,
    invalidateIdentityProbe,
    isTeamEnabled: teamEnabled,
    isTransitionInFlight: () => transitionInFlight,
    setEnabled,
    reconcileRoster,
  };
};

module.exports = { createTeamService, rosterReconciliationDeferredFields };
