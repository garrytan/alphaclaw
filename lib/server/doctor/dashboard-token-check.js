const { kDoctorCardSource } = require("./constants");
const { isTrustedProxyAuthMode } = require("../gateway-dashboard-url");

// Config-only dashboard-token check: warns when the gateway token cannot be
// resolved from openclaw.json/env, so tokened dashboard links depend on the
// launcher's runtime CLI fallback (or the user pasting a token by hand).
// Thin adapter over the shared gateway-dashboard-url service; it uses ONLY
// hasConfiguredDashboardToken — an exec-free probe. Neither the CLI-spawning
// resolveDashboardToken path nor SecretRef resolution (whose source:"exec"
// providers spawn external commands) may ever run inside a doctor pass:
// scheduled scans would spawn them in the background.
//
// Emission guards (all must hold, mirroring the launcher's tokened branch):
//   onboarded AND gateway.auth.mode is neither "trusted-proxy" (tokenless IS
//   the success path there) nor "password" (token auth is mutually exclusive
//   with password mode — a token card would push toward a mixed config)
//   AND the config-only probe finds no token. A probe throw emits NO card
//   (never a false warning from a transient error) and one fixed-code log
//   line — the error message can echo config text, so it stays out of the
//   log entirely (fail-closed redaction).

const kDashboardTokenSourceKey = "det:dashboard-token-unresolvable";

const buildDashboardTokenCards = async ({
  hasConfiguredDashboardToken = null,
  config = null,
  onboarded = true,
} = {}) => {
  if (typeof hasConfiguredDashboardToken !== "function") return [];
  if (!onboarded) return [];
  // No readable config snapshot means the token/auth-mode distinction is
  // unknowable — skip rather than risk a false card.
  if (!config || typeof config !== "object") return [];
  if (isTrustedProxyAuthMode(config)) return [];
  if (String(config?.gateway?.auth?.mode || "").trim() === "password") return [];
  try {
    if (await hasConfiguredDashboardToken({ config })) return [];
  } catch {
    console.warn(
      `[doctor] ${kDashboardTokenSourceKey}: resolver failed — check skipped`,
    );
    return [];
  }
  return [
    {
      sourceKey: kDashboardTokenSourceKey,
      priority: "P2",
      category: "workspace state",
      title:
        "Gateway token not resolvable from config — dashboard links fall back to manual auth",
      summary:
        "Neither gateway.auth.token in openclaw.json (literal, ${ENV} reference, or SecretRef) nor the " +
        "OPENCLAW_GATEWAY_TOKEN environment fallback resolves to a usable value, so dashboard links cannot be " +
        "token-primed from config. The launcher's CLI fallback may still sign each click in, so this is a " +
        "warning, not an error.",
      recommendation:
        "Set gateway.auth.token in openclaw.json (or export OPENCLAW_GATEWAY_TOKEN) so dashboard links carry a " +
        "token without a CLI round-trip. If the value is a ${ENV} reference or SecretRef, verify the referenced " +
        "secret actually resolves.",
      // Text evidence, not a path: openclaw.json lives in the managed root,
      // outside workspaceRoot — a path entry would be refused a snippet by
      // the workspace containment and dead-link in browse.
      evidence: [
        {
          type: "text",
          text: "gateway.auth.token / OPENCLAW_GATEWAY_TOKEN: no resolvable value",
        },
      ],
      targetPaths: [],
      fixPrompt:
        "The gateway dashboard token is not resolvable from configuration. Set gateway.auth.token in " +
        "openclaw.json under the OpenClaw directory (or export OPENCLAW_GATEWAY_TOKEN in the environment), and " +
        "confirm any ${ENV}/SecretRef reference resolves to a real value. Never print the token itself.",
      status: "open",
      source: kDoctorCardSource.deterministic,
    },
  ];
};

module.exports = {
  buildDashboardTokenCards,
  kDashboardTokenSourceKey,
};
