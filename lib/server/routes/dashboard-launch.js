const { wrapAsync } = require("../utils/wrap-async");
const {
  collectSecretValues,
  redactSecrets,
  scrubTokenParams,
} = require("../utils/redact");
const { readOpenclawConfig } = require("../openclaw-config");

// Server-side Control UI launcher: GET /gateway/launch?to=<target> resolves
// the gateway token and 302s to /openclaw<subPath>#token=<encoded>, so the
// token never enters the SPA's DOM/JS. Deliberately NOT under /api: expired
// sessions get the login-page redirect (not 401 JSON), the agent bearer
// physically cannot reach it (allowBearer only applies under /api/), and the
// admin-manifest route scanner (which walks /api literals) stays untouched.
//
// Decision tree per request:
//
//   onboarded? ──no──────────────► 302 tokenless
//      │yes
//   admin? ─────no (member)──────► 302 tokenless (proxy identity signs in)
//      │yes
//   resolveDashboardToken()
//      ├─ config token ──────────► 302 #token=…  (outcome tokened-config)
//      ├─ trusted-proxy mode ────► 302 tokenless (success path, no CLI)
//      ├─ CLI-scraped token ─────► 302 #token=…  (outcome tokened-cli)
//      ├─ no token anywhere ─────► 302 tokenless (connect-screen fallback)
//      └─ throw ─────────────────► redacted log + 302 tokenless (never 500)

// Allowlisted targets in a Map: query input can never hit prototype keys,
// and raw ?to input never reaches the Location header (open-redirect guard).
const kLaunchTargets = new Map([
  ["dashboards", "/dashboards"],
  ["secrets", "/settings/secrets"],
]);
// Fixed, greppable code for the resolver-failure log line.
const kLaunchResolveErrorCode = "gateway_launch_resolve_failed";

// The resolver's error text can echo CLI output (a URL carrying a token) or
// config values. Mask every known secret value from ALL the sources the
// resolver itself reads (process env, env file, config literals — same
// three-source set as the watchdog-overseer redaction), then scrub
// token-bearing params by shape as the fallback for values outside that set.
// Fails closed: if redaction itself breaks, only the fixed code is logged.
const createLaunchErrorRedactor = ({ fsModule, openclawDir, readEnvFile }) => (
  message,
) => {
  try {
    const secrets = collectSecretValues({
      env: process.env,
      envFileVars: typeof readEnvFile === "function" ? readEnvFile() : [],
      configObjects: [
        readOpenclawConfig({ fsModule, openclawDir, fallback: {} }),
      ],
    });
    return scrubTokenParams(redactSecrets(String(message || ""), { secrets }));
  } catch {
    return "";
  }
};

const registerDashboardLaunchRoutes = ({
  app,
  requireAuth,
  isAdminRequest,
  isOnboarded,
  dashboardUrlService,
  fsModule,
  openclawDir,
  readEnvFile,
  // Passed through to the service's resolve bound (a hung SecretRef provider
  // must degrade a launch tokenless, never hang the tab); tests shrink it.
  resolveTimeoutMs = undefined,
}) => {
  const redactLaunchErrorMessage = createLaunchErrorRedactor({
    fsModule,
    openclawDir,
    readEnvFile,
  });
  app.get(
    "/gateway/launch",
    requireAuth,
    wrapAsync(async (req, res) => {
      // String() neutralizes array-form query (?to=a&to=b arrives as an
      // array; "a,b" misses the allowlist and falls back to the root).
      const requestedTarget = String(req.query.to || "");
      const subPath = kLaunchTargets.get(requestedTarget) || "";
      // The Location header carries a live credential — never cache it.
      res.set("Cache-Control", "no-store");
      const admin = isAdminRequest(req);
      // res.redirect() writes the target URL — token included — into an HTML
      // body that body-capture/APM middleware could log. Empty-body 302.
      const sendRedirect = (location) => {
        res.set("Location", location);
        res.status(302).end();
      };
      // One audit line per launch. The allowlisted key (never raw input) and
      // the outcome only — the token itself is never logged.
      const logLaunch = (outcome) => {
        console.log(
          `[alphaclaw] gateway launch: identity=${admin ? "admin" : "member"} target=${
            kLaunchTargets.has(requestedTarget) ? requestedTarget : "root"
          } outcome=${outcome}`,
        );
      };
      if (!isOnboarded() || !admin) {
        // Members and pre-onboarding: tokenless, and never a CLI spawn. In
        // team mode the proxy injects the member's identity; the connect
        // screen is upstream's canonical fallback otherwise.
        logLaunch("tokenless");
        return sendRedirect(dashboardUrlService.buildDashboardUrl("", subPath));
      }
      let resolved = { token: "", source: "" };
      try {
        resolved =
          (await dashboardUrlService.resolveDashboardToken(
            resolveTimeoutMs === undefined
              ? undefined
              : { timeoutMs: resolveTimeoutMs },
          )) || resolved;
      } catch (error) {
        // Never a dead-end tab: any resolver throw degrades to the tokenless
        // redirect instead of an Express 500.
        console.error(
          `[alphaclaw] ${kLaunchResolveErrorCode}: ${redactLaunchErrorMessage(
            error?.message,
          )}`,
        );
      }
      logLaunch(
        resolved.token
          ? resolved.source === "cli"
            ? "tokened-cli"
            : "tokened-config"
          : "tokenless",
      );
      return sendRedirect(
        dashboardUrlService.buildDashboardUrl(resolved.token, subPath),
      );
    }),
  );
};

module.exports = { registerDashboardLaunchRoutes };
