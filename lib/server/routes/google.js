const {
  kDefaultGoogleClient,
  kDefaultGoogleScopes,
  createGoogleAccountId,
  readGoogleState,
  writeGoogleState,
  listGoogleAccounts,
  getGoogleAccountById,
  getGoogleAccountByEmailAndClient,
  upsertGoogleAccount,
  removeGoogleAccount,
} = require("../google-state");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { syncBootstrapPromptFiles } = require("../onboarding/workspace");
const { installGogCliSkill } = require("../gog-skill");
const { parseJsonSafe } = require("../utils/json");
const { quoteShellArg } = require("../utils/shell");
const { jsStringLiteral, htmlText } = require("./oauth-callback-html");
// Direct require, NOT the injected `constants` param: test harnesses hand-
// build that object and must not silently undefine the OAuth TTL/cap.
const {
  kGoogleOauthStateTtlMs,
  kGoogleOauthMaxPendingFlows,
} = require("../constants");

const uniqueServiceLabels = (scopes) =>
  Array.from(
    new Set(
      (scopes || [])
        .map((scope) => String(scope || "").split(":")[0])
        .filter(Boolean),
    ),
  );

const registerGoogleRoutes = ({
  app,
  fs,
  isGatewayRunning,
  gogCmd,
  getBaseUrl,
  readGoogleCredentials,
  getApiEnableUrl,
  constants,
}) => {
  const {
    GOG_CONFIG_DIR,
    GOG_STATE_PATH,
    API_TEST_COMMANDS,
    BASE_SCOPES,
    SCOPE_MAP,
    REVERSE_SCOPE_MAP,
    kMaxGoogleAccounts,
    gogClientCredentialsPath,
  } = constants;

  // Google refresh tokens are staged on disk to hand to `gog auth tokens
  // import/export`. A predictable `/tmp/gog-*-<ms>.json` at default 0644 in
  // the shared, world-writable /tmp is a symlink-hijack + world-readable
  // credential leak (same H14 class the git-askpass helper was moved off of).
  // Mint a private 0700 dir per operation and run the callback with a path
  // inside it; the whole dir is removed afterward.
  const withPrivateTokenFile = async (basename, callback) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gog-"));
    try {
      return await callback(path.join(dir, basename));
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };

  const readState = () => readGoogleState({ fs, statePath: GOG_STATE_PATH });
  const saveState = (state) => writeGoogleState({ fs, statePath: GOG_STATE_PATH, state });
  const syncBootstrapTools = (req) => {
    try {
      syncBootstrapPromptFiles({
        fs,
        workspaceDir: constants.WORKSPACE_DIR,
        baseUrl: getBaseUrl(req),
      });
    } catch {}
    try {
      installGogCliSkill({ fs, openclawDir: constants.OPENCLAW_DIR });
    } catch {}
  };

  const listAuthenticatedAccounts = async (state) => {
    const configuredClients = new Set([kDefaultGoogleClient]);
    listGoogleAccounts(state).forEach((account) => {
      const client = String(account.client || kDefaultGoogleClient).trim() || kDefaultGoogleClient;
      configuredClients.add(client);
    });
    const combined = [];
    for (const client of configuredClients) {
      const command =
        client === kDefaultGoogleClient
          ? "auth list --json --check"
          : `--client ${quoteShellArg(client)} auth list --json --check`;
      const result = await gogCmd(command, { quiet: true });
      if (!result.ok) continue;
      const parsed = parseJsonSafe(result.stdout, { accounts: [] });
      const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      accounts.forEach((entry) => {
        combined.push({
          ...entry,
          client: String(entry.client || client || kDefaultGoogleClient).trim() || kDefaultGoogleClient,
        });
      });
    }
    return combined;
  };

  const accountIsAuthenticated = ({ account, authenticatedAccounts }) =>
    authenticatedAccounts.some(
      (entry) =>
        String(entry.email || "").trim().toLowerCase() === String(account.email || "").trim().toLowerCase() &&
        String(entry.client || kDefaultGoogleClient).trim() === String(account.client || kDefaultGoogleClient).trim() &&
        (entry.valid !== false),
    );

  const getSelectedAccount = ({ state, accountId, fallbackToFirst = true }) => {
    if (accountId) {
      return getGoogleAccountById(state, accountId);
    }
    return fallbackToFirst ? listGoogleAccounts(state)[0] || null : null;
  };

  const clearStoredGoogleAuthForEmail = async ({
    email,
    preferredClient = kDefaultGoogleClient,
    extraClients = [],
  }) => {
    const normalizedEmail = String(email || "").trim();
    if (!normalizedEmail) return;
    const clientCandidates = new Set([
      kDefaultGoogleClient,
      preferredClient,
      ...extraClients,
    ]);
    for (const clientName of clientCandidates) {
      const safeClientName =
        String(clientName || "").trim() || kDefaultGoogleClient;
      const clientArg =
        safeClientName === kDefaultGoogleClient
          ? ""
          : `--client ${quoteShellArg(safeClientName)} `;
      await gogCmd(
        `${clientArg}auth remove ${quoteShellArg(normalizedEmail)} --force`,
        { quiet: true },
      );
    }
  };

  const ensureClientCredentials = ({ client, clientId, clientSecret, req }) => {
    const credentialsPath = gogClientCredentialsPath(client);
    fs.mkdirSync(GOG_CONFIG_DIR, { recursive: true });
    const credentials = {
      web: {
        client_id: clientId,
        client_secret: clientSecret,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        redirect_uris: [`${getBaseUrl(req)}/auth/google/callback`],
      },
    };
    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
    return credentialsPath;
  };

  app.get("/api/google/accounts", async (req, res) => {
    const state = readState();
    const authenticatedAccounts = await listAuthenticatedAccounts(state);
    const accounts = listGoogleAccounts(state).map((account) => {
      const activeScopes = account.services || [];
      const services = uniqueServiceLabels(activeScopes).join(", ");
      const hasCredentials = fs.existsSync(gogClientCredentialsPath(account.client));
      return {
        ...account,
        services,
        activeScopes,
        hasCredentials,
        authenticated:
          hasCredentials &&
          (Boolean(account.authenticated) || accountIsAuthenticated({ account, authenticatedAccounts })),
      };
    });
    res.json({
      ok: true,
      hasCompanyCredentials: fs.existsSync(gogClientCredentialsPath(kDefaultGoogleClient)),
      hasPersonalCredentials: fs.existsSync(gogClientCredentialsPath("personal")),
      accounts,
    });
  });

  app.get("/api/google/status", async (req, res) => {
    if (!(await isGatewayRunning())) {
      return res.json({
        hasCredentials: false,
        authenticated: false,
        email: "",
        services: "",
        activeScopes: [],
      });
    }
    const state = readState();
    const selected = getSelectedAccount({
      state,
      accountId: String(req.query.accountId || ""),
      fallbackToFirst: true,
    });
    if (!selected) {
      return res.json({
        hasCredentials: false,
        authenticated: false,
        email: "",
        services: "",
        activeScopes: [],
      });
    }
    const authenticatedAccounts = await listAuthenticatedAccounts(state);
    const activeScopes = selected.services || [];
    const services = uniqueServiceLabels(activeScopes).join(", ");
    const hasCredentials = fs.existsSync(gogClientCredentialsPath(selected.client));
    res.json({
      accountId: selected.id,
      client: selected.client,
      personal: selected.personal,
      hasCredentials,
      authenticated:
        hasCredentials &&
        (Boolean(selected.authenticated) ||
          accountIsAuthenticated({ account: selected, authenticatedAccounts })),
      email: selected.email,
      services,
      activeScopes,
    });
  });

  app.get("/api/google/credentials", (req, res) => {
    const state = readState();
    const accountId = String(req.query.accountId || "").trim();
    const requestedClient = String(req.query.client || "").trim();
    const account = accountId ? getGoogleAccountById(state, accountId) : null;
    const client =
      String(account?.client || requestedClient || kDefaultGoogleClient).trim()
      || kDefaultGoogleClient;
    const credentials = readGoogleCredentials(client);
    const hasCredentials = Boolean(credentials.clientId && credentials.clientSecret);
    res.json({
      ok: true,
      client,
      hasCredentials,
      clientId: credentials.clientId || "",
      clientSecret: credentials.clientSecret || "",
    });
  });

  app.post("/api/google/credentials", async (req, res) => {
    const body = req.body || {};
    const clientId = String(body.clientId || "").trim();
    const clientSecret = String(body.clientSecret || "").trim();
    const email = String(body.email || "").trim();
    const accountId = String(body.accountId || "").trim();
    const personal = Boolean(body.personal);
    const client = String(body.client || (personal ? "personal" : kDefaultGoogleClient)).trim()
      || kDefaultGoogleClient;
    if (!clientId || !clientSecret || !email) {
      return res.json({ ok: false, error: "Missing fields" });
    }

    try {
      const state = readState();
      const existing = accountId ? getGoogleAccountById(state, accountId) : null;
      const legacyClientsForEmail = listGoogleAccounts(state)
        .filter(
          (entry) =>
            String(entry.email || "").trim().toLowerCase() ===
            email.toLowerCase(),
        )
        .map((entry) => String(entry.client || kDefaultGoogleClient).trim());
      await clearStoredGoogleAuthForEmail({
        email,
        preferredClient: client,
        extraClients: [
          ...legacyClientsForEmail,
          String(existing?.client || "").trim(),
        ],
      });
      const credentialsPath = ensureClientCredentials({
        client,
        clientId,
        clientSecret,
        req,
      });
      const command = client === kDefaultGoogleClient
        ? `auth credentials set ${quoteShellArg(credentialsPath)}`
        : `--client ${quoteShellArg(client)} auth credentials set ${quoteShellArg(credentialsPath)}`;
      const result = await gogCmd(command, { quiet: true });
      if (!result.ok) {
        throw new Error(result.stderr || "Failed to set Google client credentials");
      }

      const { state: nextState, account } = upsertGoogleAccount({
        state,
        maxAccounts: kMaxGoogleAccounts,
        account: {
          id: existing?.id || accountId || createGoogleAccountId(),
          email,
          personal,
          client,
          services: body.services || existing?.services || kDefaultGoogleScopes,
          authenticated: false,
        },
      });
      saveState(nextState);
      syncBootstrapTools(req);

      res.json({ ok: true, accountId: account.id, account });
    } catch (err) {
      console.error("[alphaclaw] Failed to save Google credentials:", err);
      res.json({ ok: false, error: err.message });
    }
  });

  app.post("/api/google/accounts", (req, res) => {
    const body = req.body || {};
    const email = String(body.email || "").trim();
    const accountId = String(body.accountId || "").trim();
    const personal = Boolean(body.personal);
    const client = String(body.client || (personal ? "personal" : kDefaultGoogleClient)).trim()
      || kDefaultGoogleClient;
    if (!email) {
      return res.json({ ok: false, error: "Missing fields" });
    }
    if (!fs.existsSync(gogClientCredentialsPath(client))) {
      return res.json({
        ok: false,
        error: "Credentials missing for selected client. Save credentials first.",
      });
    }
    try {
      const state = readState();
      const existing = accountId ? getGoogleAccountById(state, accountId) : null;
      const { state: nextState, account } = upsertGoogleAccount({
        state,
        maxAccounts: kMaxGoogleAccounts,
        account: {
          id: existing?.id || accountId || createGoogleAccountId(),
          email,
          personal,
          client,
          services: body.services || existing?.services || kDefaultGoogleScopes,
          authenticated: Boolean(existing?.authenticated),
        },
      });
      saveState(nextState);
      syncBootstrapTools(req);
      res.json({ ok: true, accountId: account.id, account });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get("/api/google/check", async (req, res) => {
    const state = readState();
    const account = getSelectedAccount({
      state,
      accountId: String(req.query.accountId || ""),
      fallbackToFirst: true,
    });
    if (!account) return res.json({ error: "No Google account configured" });

    const enabledServices = uniqueServiceLabels(account.services || []);
    const results = {};
    for (const svc of enabledServices) {
      const cmd = API_TEST_COMMANDS[svc];
      if (!cmd) continue;
      const clientArg =
        account.client === kDefaultGoogleClient
          ? ""
          : `--client ${quoteShellArg(account.client)} `;
      const result = await gogCmd(
        `${clientArg}${cmd} --account ${quoteShellArg(account.email)}`,
        { quiet: true },
      );
      const stderr = result.stderr || "";
      if (stderr.includes("has not been used") || stderr.includes("is not enabled")) {
        const projectMatch = stderr.match(/project=(\d+)/);
        results[svc] = {
          status: "not_enabled",
          enableUrl: getApiEnableUrl(svc, projectMatch?.[1]),
        };
      } else if (result.ok || stderr.includes("not found") || stderr.includes("Not Found")) {
        results[svc] = { status: "ok", enableUrl: getApiEnableUrl(svc) };
      } else {
        results[svc] = {
          status: "error",
          message: result.stderr?.slice(0, 200),
          enableUrl: getApiEnableUrl(svc),
        };
      }
    }
    res.json({ accountId: account.id, email: account.email, results });
  });

  // Single source of the kept-account failure message; the structured
  // `retryable` field on the response comes from the route's `removed` flag
  // (any throw before removal leaves the account, so retrying is safe).
  const retryableDisconnectError = (detail) =>
    new Error(`${detail}; account kept so disconnect can be retried`);

  app.post("/api/google/disconnect", async (req, res) => {
    const accountId = String(req.body?.accountId || "").trim();
    const state = readState();
    const account = getSelectedAccount({ state, accountId, fallbackToFirst: true });
    if (!account) return res.json({ ok: true });
    let removed = false;
    try {
      // clientArg must live at try scope: the `auth remove` call below the
      // withPrivateTokenFile callback consumes it too. Declaring it inside
      // the callback (the v0.9.49 /tmp-hardening refactor did) makes every
      // disconnect throw ReferenceError AFTER the upstream revocation already
      // ran — token revoked at Google, account never removed locally.
      const clientArg =
        account.client === kDefaultGoogleClient
          ? ""
          : `--client ${quoteShellArg(account.client)} `;
      await withPrivateTokenFile("revoke.json", async (revokeFile) => {
        const exportResult = await gogCmd(
          `${clientArg}auth tokens export ${quoteShellArg(account.email)} --out ${quoteShellArg(revokeFile)} --overwrite`,
          { quiet: true },
        );
        if (exportResult.ok && fs.existsSync(revokeFile)) {
          // parseJsonSafe only falls back on parse ERRORS — a file containing
          // literal `null` parses fine, so coalesce it too.
          const tokenData = parseJsonSafe(fs.readFileSync(revokeFile, "utf8"), {}) ?? {};
          if (tokenData.refresh_token) {
            // The revocation REQUEST gates local removal: only a response
            // proving the token is already dead (200, or 400 with Google's
            // invalid_token/invalid_grant body) may fall through to `auth
            // remove`. On network failure, timeout, 5xx, or any other 4xx
            // the account MUST survive so the operator can retry — removing
            // local state while a live refresh token exists upstream would
            // orphan that token with no local handle left to revoke it.
            // When there is nothing to revoke (export failed above, or no
            // refresh_token in the staged file), removal proceeds
            // best-effort — that is the pre-fix contract, pinned by tests.
            // Token goes in the form-encoded body, never the URL: query
            // strings leak credentials into proxy/access logs, and an
            // unencoded token would 400 as a malformed request — which must
            // never be mistaken for token-already-dead.
            let revokeRes;
            try {
              revokeRes = await fetch("https://oauth2.googleapis.com/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ token: tokenData.refresh_token }),
                signal: AbortSignal.timeout(10_000),
              });
            } catch (err) {
              throw retryableDisconnectError(`token revocation request failed (${err.message})`);
            }
            if (revokeRes.ok && typeof revokeRes.text === "function") {
              // Drain the (empty) success body so undici releases the socket.
              await revokeRes.text().catch(() => {});
            }
            if (!revokeRes.ok) {
              // `.json()` resolving to literal null does not hit the catch.
              const revokeBody = (await revokeRes.json().catch(() => ({}))) ?? {};
              const tokenAlreadyDead =
                revokeRes.status === 400 &&
                ["invalid_token", "invalid_grant"].includes(revokeBody.error);
              if (!tokenAlreadyDead) {
                throw retryableDisconnectError(
                  `token revocation failed upstream (HTTP ${revokeRes.status})`,
                );
              }
            }
          }
        }
      });
      const removeResult = await gogCmd(
        `${clientArg}auth remove ${quoteShellArg(account.email)} --force`,
        { quiet: true },
      );
      if (!removeResult.ok) {
        // State removal still proceeds (the operator asked for the account
        // gone and the token is confirmed dead upstream), but never
        // silently: a failed keyring remove leaves residue in the gog store
        // that the accounts UI can no longer see.
        console.warn(
          "[alphaclaw] gog auth remove failed during disconnect; a credential entry may remain in the gog keyring:",
          String(removeResult.stderr || "").slice(0, 200),
        );
      }
      // Re-read state at removal time: the awaits above (gog export, revoke
      // fetch, auth remove) leave a multi-second window in which a concurrent
      // OAuth-callback completion may have written new accounts — deriving
      // nextState from the pre-await snapshot would silently erase them.
      const { state: nextState } = removeGoogleAccount({
        state: readState(),
        accountId: account.id,
      });
      saveState(nextState);
      removed = true;
      syncBootstrapTools(req);
      res.json({
        ok: true,
        ...(removeResult.ok
          ? {}
          : { warning: "gog auth remove failed; a credential entry may remain in the gog keyring" }),
      });
    } catch (err) {
      console.error("[alphaclaw] Google disconnect error:", err);
      // Every throw that reaches here before `removed` flipped left the
      // account in state, so a retry with the SAME resolved accountId is
      // safe — echo it so accountId-less callers don't re-resolve
      // fallback-to-first onto a different account next attempt.
      res.json({
        ok: false,
        ...(removed ? {} : { retryable: true, accountId: account.id }),
        error: err.message,
      });
    }
  });

  // OAuth callback binding (E-C11 + upstream PR #114's pattern, mirrored from
  // codex.js): the callback below bypasses session auth by design (it's a
  // Google redirect), so completion must be bound to a flow an ADMIN started
  // here. The account-linking payload (accountId/client/email/services/
  // redirectUri) is held SERVER-SIDE, keyed by an opaque single-use state —
  // a live state can no longer be decoded, edited, and replayed within its
  // TTL window. In-memory and single-process on purpose (same semantics as
  // the codex flow): a server restart mid-consent voids the flow, visibly.
  const kGooglePendingOauthFlows = new Map();
  const cleanupGoogleOauthFlows = () => {
    const now = Date.now();
    for (const [state, flow] of kGooglePendingOauthFlows.entries()) {
      if (!flow || now - flow.createdAt > kGoogleOauthStateTtlMs) {
        kGooglePendingOauthFlows.delete(state);
      }
    }
  };
  const createGoogleOauthFlow = (flow) => {
    cleanupGoogleOauthFlows();
    while (kGooglePendingOauthFlows.size >= kGoogleOauthMaxPendingFlows) {
      const oldestState = kGooglePendingOauthFlows.keys().next().value;
      kGooglePendingOauthFlows.delete(oldestState);
    }
    const state = crypto.randomBytes(16).toString("hex");
    kGooglePendingOauthFlows.set(state, { ...flow, createdAt: Date.now() });
    return state;
  };
  const consumeGoogleOauthFlow = (state) => {
    cleanupGoogleOauthFlows();
    const key = String(state || "");
    const flow = kGooglePendingOauthFlows.get(key);
    kGooglePendingOauthFlows.delete(key);
    if (!flow || Date.now() - flow.createdAt > kGoogleOauthStateTtlMs) {
      return null;
    }
    return flow;
  };
  // Soft session binding: hash of the requester's setup_token cookie. The
  // callback still works without a session (it must — Google redirects the
  // popup back), but when BOTH hops carry one, they must match.
  const readSessionTokenHash = (req) => {
    const cookieHeader = String(req.headers?.cookie || "");
    const match = cookieHeader.match(/(?:^|;\s*)setup_token=([^;]+)/);
    if (!match) return "";
    let tokenValue = match[1];
    try {
      tokenValue = decodeURIComponent(tokenValue);
    } catch {}
    return crypto.createHash("sha256").update(tokenValue).digest("hex");
  };
  // Google setup is an admin surface (4.6). requireAuth sets the identity;
  // when absent (older test harnesses without the auth layer) fall through.
  const rejectNonAdmin = (req, res) => {
    const role = req.alphaclawIdentity?.role;
    if (role && role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return true;
    }
    return false;
  };

  app.get("/auth/google/start", (req, res) => {
    if (rejectNonAdmin(req, res)) return;
    const state = readState();
    const requestedAccountId = String(req.query.accountId || "").trim();
    const requestedClient = String(req.query.client || "").trim();
    let account = requestedAccountId
      ? getGoogleAccountById(state, requestedAccountId)
      : null;
    if (!account && req.query.email) {
      account = getGoogleAccountByEmailAndClient(
        state,
        String(req.query.email || "").trim(),
        requestedClient || kDefaultGoogleClient,
      );
    }
    const client = account?.client || requestedClient || kDefaultGoogleClient;
    const email = account?.email || String(req.query.email || "").trim();
    const services = (
      req.query.services ||
      (account?.services || kDefaultGoogleScopes).join(",")
    )
      .split(",")
      .map((scope) => String(scope || "").trim())
      .filter(Boolean);
    try {
      const { clientId } = readGoogleCredentials(client);
      if (!clientId) throw new Error("No client_id found");
      const scopes = [
        ...BASE_SCOPES,
        ...services.map((scope) => SCOPE_MAP[scope]).filter(Boolean),
      ].join(" ");
      const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
      // The state is opaque; the payload stays server-side. An accountId the
      // start could not resolve is dropped ("") — an unknown id can no longer
      // be planted for the callback to adopt (fresh accounts get a new id).
      const flowState = createGoogleOauthFlow({
        accountId: account?.id || "",
        client,
        email,
        services,
        redirectUri,
        sessionTokenHash: readSessionTokenHash(req),
      });
      const authUrl = new URL("https://accounts.google.com/o/oauth2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", flowState);
      if (email) authUrl.searchParams.set("login_hint", email);
      res.redirect(authUrl.toString());
    } catch (err) {
      console.error("[alphaclaw] Failed to start Google auth:", err);
      res.redirect(`/setup?google=error&message=${encodeURIComponent(err.message)}`);
    }
  });

  app.get("/auth/google/callback", async (req, res) => {
    const { code, error, state } = req.query;
    // A denied/aborted consent must not leave a live flow behind: consume the
    // state on every early return so it can never be replayed with a code.
    if (error) {
      if (state) consumeGoogleOauthFlow(state);
      return res.redirect(`/setup?google=error&message=${encodeURIComponent(error)}`);
    }
    if (!code) {
      if (state) consumeGoogleOauthFlow(state);
      return res.redirect("/setup?google=error&message=no_code");
    }

    try {
      // A state we did not issue to an admin (or one replayed/expired) must
      // not complete — the callback is reachable without a session (E-C11).
      // Single-use: the consume below deletes the entry before any exchange.
      const flow = consumeGoogleOauthFlow(state);
      if (!flow) {
        throw new Error(
          "This sign-in link wasn't started from this dashboard (or expired). Start Google setup again from the dashboard.",
        );
      }
      const callbackSessionHash = readSessionTokenHash(req);
      if (
        flow.sessionTokenHash &&
        callbackSessionHash &&
        callbackSessionHash !== flow.sessionTokenHash
      ) {
        // A different browser session (or a rotated token) is completing a
        // flow it did not start. Fail visibly; restarting the flow is cheap.
        throw new Error(
          "This sign-in link wasn't started from this dashboard (or expired). Start Google setup again from the dashboard.",
        );
      }
      const accountId = String(flow.accountId || "").trim();
      const requestedClient = String(flow.client || "").trim();
      const stateData = readState();
      const existingAccount = accountId
        ? getGoogleAccountById(stateData, accountId)
        : getGoogleAccountByEmailAndClient(
            stateData,
            String(flow.email || "").trim(),
            requestedClient || kDefaultGoogleClient,
          );
      const client = existingAccount?.client || requestedClient || kDefaultGoogleClient;
      const { clientId, clientSecret } = readGoogleCredentials(client);
      if (!clientId || !clientSecret) {
        throw new Error(`Google credentials missing for client "${client}"`);
      }
      // Pinned at start time: the exchange must present the redirect_uri the
      // authorize hop actually used, not one recomputed from this request's
      // Host header (proxy drift would yield an opaque redirect_uri_mismatch).
      const redirectUri =
        flow.redirectUri || `${getBaseUrl(req)}/auth/google/callback`;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || tokens.error) {
        throw new Error(`Google token error: ${tokens.error_description || tokens.error || "exchange_failed"}`);
      }

      if (!tokens.refresh_token && !existingAccount?.authenticated) {
        throw new Error(
          "No refresh token received. Revoke app access at myaccount.google.com/permissions and retry.",
        );
      }

      let email = String(existingAccount?.email || flow.email || "").trim();
      if (!email && tokens.access_token) {
        try {
          const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          const info = await infoRes.json();
          email = String(info.email || "").trim();
        } catch {}
      }

      if (tokens.refresh_token) {
        const tokenData = {
          email,
          client,
          created_at: new Date().toISOString(),
          refresh_token: tokens.refresh_token,
        };
        const result = await withPrivateTokenFile("token.json", async (tokenFile) => {
          fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2), {
            mode: 0o600,
          });
          const importCmd =
            client === kDefaultGoogleClient
              ? `auth tokens import ${quoteShellArg(tokenFile)}`
              : `--client ${quoteShellArg(client)} auth tokens import ${quoteShellArg(tokenFile)}`;
          return gogCmd(importCmd, { quiet: true });
        });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to import Google token");
        }
      }

      const requestedServices = Array.isArray(flow.services)
        ? flow.services
        : [];
      const grantedServices = tokens.scope
        ? tokens.scope
            .split(" ")
            .map((scope) => REVERSE_SCOPE_MAP[scope])
            .filter(Boolean)
        : requestedServices;
      const { state: nextState, account } = upsertGoogleAccount({
        state: stateData,
        maxAccounts: kMaxGoogleAccounts,
        account: {
          id: existingAccount?.id || accountId || createGoogleAccountId(),
          email,
          personal: Boolean(existingAccount?.personal),
          client,
          services: grantedServices.length ? grantedServices : requestedServices,
          authenticated: true,
        },
      });
      saveState(nextState);
      syncBootstrapTools(req);

      res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ google: 'success', accountId: ${jsStringLiteral(account.id)}, email: ${jsStringLiteral(email)} }, '*');
      window.close();
    </script><p>Google connected! You can close this window.</p></body></html>`);
    } catch (err) {
      console.error("[alphaclaw] Google OAuth callback error:", err);
      const message = err.message || "unknown_error";
      res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ google: 'error', message: ${jsStringLiteral(message)} }, '*');
      window.close();
    </script><p>Error: ${htmlText(message)}. You can close this window.</p></body></html>`);
    }
  });
};

module.exports = { registerGoogleRoutes };
