const { compareVersionParts } = require("./helpers");

// Version-gated OpenClaw feature detection.
//
// Fail-closed per feature: an unknown, unreadable, or dev-sha version means
// "not supported" — a gated UI affordance quietly hides rather than breaking
// against an older gateway. Reuses the OpenClaw-aware comparator in
// helpers.js (hotfix "-2" ranks above base, "-beta.N" below) — do NOT add a
// third comparator.
//
// Dev builds are identified by commit sha, which no calver range can
// classify; they fail closed here. Callers that genuinely need a capability
// answer for a dev build should probe the running gateway instead.
const kFeatureMinVersions = {
  // 2026.8.1 beta line: multi-user Control UI, roster, profiles, dashboards,
  // trusted-proxy pairing auto-approval, sqlite backup, external supervisor.
  multiUser: "2026.8.1-beta.1",
  sessionDashboards: "2026.8.1-beta.1",
  sqliteBackup: "2026.8.1-beta.1",
  supervisorMode: "2026.8.1-beta.1",
  trustedProxyPairing: "2026.8.1-beta.1",
  secretEgressBinding: "2026.8.1-beta.1",
  // 2026.8.1 Project Context contract: TOOLS.md/HEARTBEAT.md retired,
  // MEMORY.md-era six-name bootstrap set + extras basename allowlist, USER.md
  // 4k cap. Verified present in 2026.8.1-beta.1's dist (WORKSPACE_BOOTSTRAP_
  // FILENAMES + USER_BOOTSTRAP_MAX_CHARS) — see
  // docs/designs/openclaw-context-contract.md. Drives the doctor's context
  // profile selection (lib/server/doctor/context-profiles.js).
  bootstrapContractV2: "2026.8.1-beta.1",
  // Stable already ships trusted-proxy gateway auth (docs/gateway/
  // trusted-proxy-auth.md in the pinned package).
  trustedProxyAuth: "2026.7.1",
};

const kVersionShape = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const createFeatureGates = ({ getInstalledVersion }) => {
  const currentVersion = () => {
    try {
      const version = String(getInstalledVersion() || "").trim();
      return kVersionShape.test(version) ? version : null;
    } catch {
      return null;
    }
  };

  const supportsFeature = (name) => {
    const minVersion = kFeatureMinVersions[name];
    if (!minVersion) return false;
    const version = currentVersion();
    if (!version) return false;
    try {
      return compareVersionParts(version, minVersion) >= 0;
    } catch {
      return false;
    }
  };

  const features = () => {
    const map = {};
    for (const name of Object.keys(kFeatureMinVersions)) {
      map[name] = supportsFeature(name);
    }
    return { version: currentVersion(), features: map };
  };

  return { supportsFeature, features, kFeatureMinVersions };
};

module.exports = { createFeatureGates, kFeatureMinVersions };
