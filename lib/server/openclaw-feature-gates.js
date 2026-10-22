// OpenClaw feature map. Every feature below is present on the pinned
// OpenClaw (each first shipped at or below 2026.9.1-beta.1, the pin is
// 2026.10.4), so GET /api/openclaw/features answers true for every key
// whatever the version read returns; an unreadable or diverged install is
// surfaced by openclaw-pin-state.js instead of silently picking pre-2026.8
// behavior. The values record the release each feature first shipped in.
const kFeatureMinVersions = {
  // 2026.8.1 beta line: multi-user Control UI, roster, profiles, dashboards,
  // trusted-proxy pairing auto-approval, external supervisor.
  multiUser: "2026.8.1-beta.1",
  sessionDashboards: "2026.8.1-beta.1",
  supervisorMode: "2026.8.1-beta.1",
  trustedProxyPairing: "2026.8.1-beta.1",
  secretEgressBinding: "2026.8.1-beta.1",
  // 2026.8.1 Project Context contract: TOOLS.md/HEARTBEAT.md retired,
  // MEMORY.md-era six-name bootstrap set + extras basename allowlist, USER.md
  // 4k cap. Verified present in 2026.8.1-beta.1's dist (WORKSPACE_BOOTSTRAP_
  // FILENAMES + USER_BOOTSTRAP_MAX_CHARS) — see
  // docs/designs/openclaw-context-contract.md and
  // lib/server/doctor/context-profiles.js.
  bootstrapContractV2: "2026.8.1-beta.1",
  // Stable already ships trusted-proxy gateway auth (docs/gateway/
  // trusted-proxy-auth.md in the pinned package).
  trustedProxyAuth: "2026.7.1",
  // 2026.9.1 beta line: exec approvals live in state/openclaw.sqlite
  // (exec_approvals_config) and the legacy exec-approvals.json is
  // existence-fatal (issue #23). The floor the reaper checks lives in
  // openclaw-state-era.js (kExecApprovalsSqliteMinVersion).
  execApprovalsSqlite: "2026.9.1-beta.1",
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

  const features = () => {
    const map = {};
    for (const name of Object.keys(kFeatureMinVersions)) map[name] = true;
    return { version: currentVersion(), features: map };
  };

  return { features, kFeatureMinVersions };
};

module.exports = { createFeatureGates, kFeatureMinVersions };
