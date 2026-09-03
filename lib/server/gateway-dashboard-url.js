const { readOpenclawConfig } = require("./openclaw-config");

// Trimmed compare, matching gateway-credential.js: a whitespace-padded mode
// value must not make the two resolvers disagree about the auth mode.
const getGatewayAuthMode = (config) =>
  String(config?.gateway?.auth?.mode || "").trim();
const isTrustedProxyAuthMode = (config) =>
  getGatewayAuthMode(config) === "trusted-proxy";
// Tokenless is the only correct dashboard link in BOTH non-token modes:
// trusted-proxy rejects shared tokens outright; password mode is mutually
// exclusive with token auth upstream, so a stale token would ride the
// fragment as a dead credential and burn the gateway's failed-auth budget.
const isTokenlessAuthMode = (config) => {
  const mode = getGatewayAuthMode(config);
  return mode === "trusted-proxy" || mode === "password";
};

// Hard ceiling on a full resolution: SecretRef providers can be external
// commands with no timeout of their own (the CLI fallback's 15s clawCmd
// bound does not cover that phase). On timeout the memo self-clears so the
// NEXT call starts a fresh resolution instead of joining a wedged promise
// forever, and the caller gets a tokenless result instead of a hang.
const kResolveTimeoutMs = 20_000;

// Dashboard-URL token resolution, extracted from routes/system.js so the
// /gateway/launch redirect, GET /api/gateway/dashboard, and the doctor's
// token-resolvable check share one resolver.
//
// Resolution precedence (config first, CLI last):
//
//   gateway.auth.mode === "trusted-proxy"? ──yes──► "" (tokenless IS success:
//        │no                                        the proxy injects operator
//        ▼                                          identity; the gateway
//   SecretRef (openclaw secret runtime)             rejects shared tokens —
//        │empty                                     the CLI is never spawned)
//        ▼
//   literal gateway.auth.token
//        │empty
//        ▼
//   ${ENV} reference (process.env, then env file)
//        │empty
//        ▼
//   OPENCLAW_GATEWAY_TOKEN env fallback
//        │empty
//        ▼
//   CLI scrape: `openclaw dashboard --no-open`   [resolveDashboardToken only]
//
// NOT gateway-credential.js: getGatewayCredential returns the gateway
// PASSWORD in password/trusted-proxy modes — an internal client credential
// that must never feed a browser URL — and resolves env-first, while this
// resolver is config-first (test-pinned). Consolidating the two resolvers is
// a deliberate non-goal here (tracked as a follow-up).

const createDashboardUrlService = ({
  fsModule,
  openclawDir,
  readEnvFile,
  // STRICT env reader for the doctor's probe: a transient .env read failure
  // must THROW into the check's no-card path, never silently read as "no
  // token" and emit a false warning card. Token RESOLUTION keeps the lenient
  // reader (a launch should still try the other sources). Optional: absent
  // (older wiring, the routes-system harness) the probe uses the lenient one.
  readEnvFileStrict = null,
  clawCmd,
  // Test seam: production always imports the real plugin-sdk modules (the
  // import is a native dynamic import of an externalized dependency, so
  // vi.mock cannot reach it).
  importSecretRuntime = () =>
    Promise.all([
      import("openclaw/plugin-sdk/secret-input"),
      import("openclaw/plugin-sdk/secret-ref-runtime"),
    ]),
}) => {
  let openclawSecretRuntimePromise = null;
  let resolveTokenInFlight = null;

  const getEnvFileValue = (key) =>
    (typeof readEnvFile === "function" ? readEnvFile() : []).find(
      (entry) => entry?.key === key,
    )?.value;
  const normalizeSecretValue = (value) => {
    if (typeof value !== "string") return "";
    const trimmed = String(value || "").trim();
    if (trimmed.length >= 2) {
      const first = trimmed[0];
      const last = trimmed[trimmed.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return trimmed.slice(1, -1).trim();
      }
    }
    return trimmed;
  };
  const getEnvObject = () => {
    const env = { ...process.env };
    for (const entry of typeof readEnvFile === "function" ? readEnvFile() : []) {
      const key = String(entry?.key || "").trim();
      if (!key) continue;
      if (!normalizeSecretValue(env[key])) {
        env[key] = normalizeSecretValue(entry?.value);
      }
    }
    return env;
  };
  const loadOpenclawSecretRuntime = async () => {
    // secret-ref-runtime, not runtime-secret-resolution: the latter subpath
    // was removed from openclaw >= 2026.9.1-beta.1's exports map
    // (ERR_PACKAGE_PATH_NOT_EXPORTED), and the swallow in the caller made
    // secret-ref gateway tokens silently resolve to "". secret-ref-runtime
    // exports resolveSecretRefValues on BOTH the pinned 2026.7.1-2 and the
    // beta (verified against both packages) — no fallback chain needed.
    openclawSecretRuntimePromise ||= importSecretRuntime()
      .then(([secretInput, secretRefRuntime]) => ({
        coerceSecretRef: secretInput.coerceSecretRef,
        resolveSecretRefValues: secretRefRuntime.resolveSecretRefValues,
      }))
      .catch((error) => {
        // Degrade loudly: a future export removal must not silently disable
        // secret-ref token resolution again.
        console.warn(
          `[alphaclaw] OpenClaw secret-ref runtime unavailable (${error.message}) — secretRef gateway tokens will not resolve`,
        );
        // Un-poison the memo: a transient import failure (mid-upgrade module
        // swap, brief fs hiccup) must not cache the rejection until restart.
        openclawSecretRuntimePromise = null;
        throw error;
      });
    return openclawSecretRuntimePromise;
  };
  const resolveSecretRefToken = async ({ config, value, env }) => {
    try {
      const { coerceSecretRef, resolveSecretRefValues } =
        await loadOpenclawSecretRuntime();
      const ref = coerceSecretRef(value, config?.secrets?.defaults);
      if (!ref) return "";
      const resolved = await resolveSecretRefValues([ref], { config, env });
      const refKey = `${ref.source}:${ref.provider}:${ref.id}`;
      return normalizeSecretValue(resolved.get(refKey));
    } catch {
      return "";
    }
  };
  const resolveEnvReference = (value) => {
    const match = String(value || "").trim().match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
    if (!match) return "";
    const envKey = match[1];
    const envValue = process.env[envKey] || getEnvFileValue(envKey);
    return normalizeSecretValue(envValue);
  };
  const readConfigSnapshot = () =>
    readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
  // Callers holding a fresh snapshot pass it in so one resolution never
  // re-reads openclaw.json (the doctor's sourced-card pass threads one
  // snapshot through every check for the same reason).
  const getDashboardTokenFromConfig = async ({ config } = {}) => {
    const snapshot = config || readConfigSnapshot();
    if (isTokenlessAuthMode(snapshot)) {
      return "";
    }
    return resolveTokenFromSnapshot(snapshot);
  };
  const resolveTokenFromSnapshot = async (config) => {
    const env = getEnvObject();
    const configuredToken = config?.gateway?.auth?.token;
    const resolvedSecretRefToken = await resolveSecretRefToken({
      config,
      value: configuredToken,
      env,
    });
    if (resolvedSecretRefToken) return resolvedSecretRefToken;
    if (typeof configuredToken === "string" && configuredToken.trim()) {
      const trimmedToken = normalizeSecretValue(configuredToken);
      if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(trimmedToken)) {
        return resolveEnvReference(trimmedToken);
      }
      return trimmedToken;
    }
    return normalizeSecretValue(env.OPENCLAW_GATEWAY_TOKEN);
  };
  const buildDashboardUrl = (token, subPath = "") => {
    if (!subPath) {
      // Legacy shape, byte-identical: the admin-manifest redaction and the
      // /api/gateway/dashboard response tests pin these exact strings.
      return token ? `/openclaw/#token=${encodeURIComponent(token)}` : "/openclaw";
    }
    return `/openclaw${subPath}${token ? `#token=${encodeURIComponent(token)}` : ""}`;
  };
  const extractDashboardTokenFromOutput = (stdout) => {
    const tokenMatch = String(stdout || "").match(/[#?&]token=([^\s&#]+)/);
    if (!tokenMatch) return "";
    try {
      return decodeURIComponent(tokenMatch[1]);
    } catch {
      return tokenMatch[1];
    }
  };
  // Config-only, exec-free probe for the doctor's token check: SecretRef
  // resolution can run source:"exec" providers (1Password CLI, vault
  // helpers), which a scheduled doctor scan must never spawn in the
  // background. A SecretRef-SHAPED token (object value) counts as configured
  // without resolving it — the card copy already tells the operator to
  // verify the reference resolves.
  const hasConfiguredDashboardToken = ({ config } = {}) => {
    const snapshot = config || readConfigSnapshot();
    const configuredToken = snapshot?.gateway?.auth?.token;
    if (configuredToken && typeof configuredToken === "object") return true;
    if (typeof configuredToken === "string" && configuredToken.trim()) {
      const trimmedToken = normalizeSecretValue(configuredToken);
      if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(trimmedToken)) {
        return Boolean(resolveEnvReferenceStrict(trimmedToken));
      }
      return true;
    }
    return Boolean(normalizeSecretValue(getEnvObjectStrict().OPENCLAW_GATEWAY_TOKEN));
  };
  // Probe-only strict variants: a failed .env read THROWS (into the doctor
  // check's no-card path) instead of silently reading as "no token".
  const probeEnvReader = () =>
    typeof readEnvFileStrict === "function"
      ? readEnvFileStrict()
      : typeof readEnvFile === "function"
        ? readEnvFile()
        : [];
  const getEnvObjectStrict = () => {
    const env = { ...process.env };
    for (const entry of probeEnvReader()) {
      const key = String(entry?.key || "").trim();
      if (!key) continue;
      if (!normalizeSecretValue(env[key])) {
        env[key] = normalizeSecretValue(entry?.value);
      }
    }
    return env;
  };
  const resolveEnvReferenceStrict = (value) => {
    const match = String(value || "").trim().match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
    if (!match) return "";
    const envKey = match[1];
    return normalizeSecretValue(getEnvObjectStrict()[envKey]);
  };
  // Full resolution incl. the CLI fallback. Single-flight: concurrent
  // launches share one in-flight resolution (and at most one CLI spawn);
  // cleared on settle so the next call observes fresh config. One config
  // read serves the whole resolution. The whole flight races kResolveTimeoutMs
  // (see the constant's comment): on timeout the memo self-clears and callers
  // get a tokenless result — a tab degrades, never hangs, and the NEXT launch
  // retries fresh instead of joining a wedged provider forever.
  const resolveDashboardToken = ({ timeoutMs = kResolveTimeoutMs } = {}) => {
    resolveTokenInFlight ||= (async () => {
      const work = (async () => {
        const config = readConfigSnapshot();
        if (isTokenlessAuthMode(config)) {
          // Never spawn the CLI just to discard its output (trusted-proxy)
          // or scrape a URL the CLI never tokens (password).
          return { token: "", source: "" };
        }
        const configToken = await resolveTokenFromSnapshot(config);
        if (configToken) return { token: configToken, source: "config" };
        // Bounded by clawCmd's built-in exec timeout (timeoutMs default 15s,
        // SIGTERM on expiry, resolves {ok:false, timedOut:true} — never
        // rejects). The bare invocation is itself test-pinned
        // (routes-system.test.js asserts the exact call), so that bound
        // stays clawCmd's default.
        const result = await clawCmd("dashboard --no-open");
        if (result?.ok && result.stdout) {
          const cliToken = extractDashboardTokenFromOutput(result.stdout);
          if (cliToken) return { token: cliToken, source: "cli" };
        }
        return { token: "", source: "" };
      })();
      let timer;
      try {
        return await Promise.race([
          work,
          new Promise((resolve) => {
            timer = setTimeout(() => {
              // Fixed line, no values: the hung phase may hold a secret.
              console.warn(
                `[alphaclaw] dashboard_token_resolve_timeout after ${timeoutMs}ms — serving tokenless`,
              );
              resolve({ token: "", source: "" });
            }, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      resolveTokenInFlight = null;
    });
    return resolveTokenInFlight;
  };

  return {
    buildDashboardUrl,
    getDashboardTokenFromConfig,
    hasConfiguredDashboardToken,
    resolveDashboardToken,
  };
};

module.exports = { createDashboardUrlService, isTrustedProxyAuthMode };
