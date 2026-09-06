const crypto = require("crypto");
const {
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_SCOPE,
  CODEX_OAUTH_TOKEN_URL,
  kCodexOauthStateTtlMs,
} = require("../constants");
const { jsStringLiteral, htmlText } = require("./oauth-callback-html");
const { sendIfStateDbQuietError } = require("../utils/state-db-quiet-http");
const {
  StateDbQuietError,
  isStateDbQuiet,
  whenStateDbQuietReleased,
  kBackupInProgressCode,
  kBackupInProgressMessage,
} = require("../state-db-quiet");
const { wrapAsync } = require("../utils/wrap-async");

// A completed exchange whose store write hit a barrier that began mid-flight
// is retried this many times across successive barriers before it is dropped
// (loudly). Each retry waits for the current quiet period to lift.
const kDeferredCodexWriteMaxAttempts = 3;

const createCodexOauthState = () => {
  const kCodexOauthStates = new Map();

  const cleanupCodexOauthStates = () => {
    const now = Date.now();
    for (const [state, value] of kCodexOauthStates.entries()) {
      if (!value || now - value.createdAt > kCodexOauthStateTtlMs) {
        kCodexOauthStates.delete(state);
      }
    }
  };

  return { kCodexOauthStates, cleanupCodexOauthStates };
};

const registerCodexRoutes = ({
  app,
  createPkcePair,
  parseCodexAuthorizationInput,
  getCodexAccountId,
  authProfiles,
  onAuthChanged = () => {},
  // Optional operator notifier (upgradeNotifier.notify shape) for a deferred
  // profile write that fails after the barrier lifts — the tokens were only
  // ever in memory, so the loss must reach the operator, not only the log.
  notify = null,
}) => {
  const { kCodexOauthStates, cleanupCodexOauthStates } = createCodexOauthState();

  // The OAuth code and state are one-use: once the token exchange succeeded,
  // a 409 would discard live tokens the operator can never re-obtain by
  // retrying. So a StateDbQuietError from the store write (a barrier that
  // began AFTER the entry pre-check) retains the credential in ONE in-memory
  // slot — Codex has exactly one profile — and writes it when the barrier
  // lifts. Any later completed exchange (direct or deferred) supersedes the
  // slot, so a stale pending write can never clobber a newer credential.
  // The slot's OUTCOME is kept alongside (`deferredWrite` on GET
  // /api/codex/status): the tokens exist only in memory until the write
  // lands, so a write that fails after the barrier lifts must be visible to
  // the client — the "saved after the backup finishes" badge would otherwise
  // stay up over a credential that was never persisted.
  let deferredCodexWrite = null;
  let deferredWriteOutcome = null;
  const setDeferredWriteOutcome = (state, reason = null) => {
    deferredWriteOutcome = { state, reason, at: Date.now() };
  };

  const deferCodexWrite = (credential, attempt) => {
    deferredCodexWrite = { credential, attempt };
    setDeferredWriteOutcome("pending", kBackupInProgressCode);
    console.warn(
      `[codex] OAuth tokens exchanged but the auth store is closed for a backup — the profile write is deferred until the barrier lifts (attempt ${attempt}/${kDeferredCodexWriteMaxAttempts})`,
    );
    whenStateDbQuietReleased(() => {
      if (deferredCodexWrite?.credential !== credential) return;
      deferredCodexWrite = null;
      try {
        authProfiles.upsertCodexProfile(credential);
        setDeferredWriteOutcome("saved");
        onAuthChanged();
        console.log("[codex] deferred Codex profile write completed after the backup");
      } catch (err) {
        if (err instanceof StateDbQuietError && attempt < kDeferredCodexWriteMaxAttempts) {
          deferCodexWrite(credential, attempt + 1);
          return;
        }
        const reason = String(err?.message || err);
        setDeferredWriteOutcome("failed", reason);
        console.error(
          `[codex] deferred Codex profile write FAILED (${reason}) — reconnect Codex from the Models tab`,
        );
        if (typeof notify === "function") {
          // Important-class: the operator believes Codex is connected.
          Promise.resolve()
            .then(() =>
              notify(
                `⚠️ Codex connection was not saved — the deferred profile write failed after the backup (${reason}). Reconnect Codex from the Models tab.`,
                { eventType: "health", id: `codex-deferred-write-failed-${Date.now()}` },
              ),
            )
            .catch(() => {});
        }
      }
    });
  };

  const persistCodexProfileOrDefer = (credential) => {
    try {
      authProfiles.upsertCodexProfile(credential);
    } catch (err) {
      if (!(err instanceof StateDbQuietError)) throw err;
      deferCodexWrite(credential, 1);
      return { deferred: true };
    }
    // A direct write supersedes any pending slot AND its outcome: nothing is
    // deferred any more, so the status must not keep an old verdict around.
    deferredCodexWrite = null;
    deferredWriteOutcome = null;
    onAuthChanged();
    return { deferred: false };
  };

  const oauthErrorPage = (message) =>
    `<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'error', message: ${jsStringLiteral(message)} }, '*');
      window.close();
    </script><p>Error: ${htmlText(message)}. You can close this window.</p></body></html>`;

  app.get("/api/codex/status", (req, res) => {
    // Additive marker: configured credentials are UNAVAILABLE during a
    // backup, not removed — `connected` keeps its shape for old clients.
    const availability = authProfiles.getAuthStoreAvailability?.() || null;
    // Additive: present only while a deferred write is pending or has settled
    // (saved | failed) since the last direct write — the UI clears its
    // "saved after the backup" badge from it.
    const deferredFields = deferredWriteOutcome ? { deferredWrite: deferredWriteOutcome } : {};
    if (availability?.unavailable === true) {
      return res.json({
        connected: false,
        unavailable: true,
        reason: availability.reason || kBackupInProgressCode,
        ...deferredFields,
      });
    }
    const profile = authProfiles.getCodexProfile();
    if (!profile) return res.json({ connected: false, ...deferredFields });
    res.json({
      connected: true,
      profileId: profile.profileId,
      accountId: profile.accountId || null,
      expires: typeof profile.expires === "number" ? profile.expires : null,
      ...deferredFields,
    });
  });

  app.get("/auth/codex/start", (req, res) => {
    // Codex setup is an admin surface (4.6/E-C11); requireAuth sets the
    // identity, and legacy sessions count as admin.
    const role = req.alphaclawIdentity?.role;
    if (role && role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      cleanupCodexOauthStates();
      const redirectUri = CODEX_OAUTH_REDIRECT_URI;
      const { verifier, challenge } = createPkcePair();
      const state = crypto.randomBytes(16).toString("hex");
      kCodexOauthStates.set(state, { verifier, redirectUri, createdAt: Date.now() });

      const authUrl = new URL(CODEX_OAUTH_AUTHORIZE_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", CODEX_OAUTH_SCOPE);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("id_token_add_organizations", "true");
      authUrl.searchParams.set("codex_cli_simplified_flow", "true");
      // Keep this aligned with OpenClaw's own Codex OAuth flow.
      authUrl.searchParams.set("originator", "pi");
      res.redirect(authUrl.toString());
    } catch (err) {
      console.error("[codex] Failed to start OAuth flow:", err);
      res.redirect("/setup?codex=error&message=" + encodeURIComponent(err.message));
    }
  });

  app.get("/auth/codex/callback", wrapAsync(async (req, res) => {
    const { code, error, state } = req.query;
    if (error) {
      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'error', message: ${jsStringLiteral(error)} }, '*');
      window.close();
    </script><p>Codex auth failed. You can close this window.</p></body></html>`);
    }
    if (!code || !state) {
      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'error', message: 'Missing OAuth state/code' }, '*');
      window.close();
    </script><p>Missing OAuth state/code. You can close this window.</p></body></html>`);
    }

    // Pre-check BEFORE the one-use state is consumed: the login attempt stays
    // valid, so re-opening the same callback URL after the backup succeeds.
    if (isStateDbQuiet()) {
      return res.send(oauthErrorPage(kBackupInProgressMessage));
    }

    cleanupCodexOauthStates();
    const oauthState = kCodexOauthStates.get(String(state));
    kCodexOauthStates.delete(String(state));
    if (!oauthState) {
      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'error', message: 'State mismatch or expired login attempt' }, '*');
      window.close();
    </script><p>State mismatch. You can close this window.</p></body></html>`);
    }

    try {
      const tokenRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_OAUTH_CLIENT_ID,
          code: String(code),
          code_verifier: oauthState.verifier,
          redirect_uri: oauthState.redirectUri,
        }),
      });
      const json = await tokenRes.json().catch(() => ({}));
      if (
        !tokenRes.ok ||
        !json.access_token ||
        !json.refresh_token ||
        typeof json.expires_in !== "number"
      ) {
        throw new Error(`Token exchange failed (${tokenRes.status})`);
      }

      const access = String(json.access_token);
      const refresh = String(json.refresh_token);
      const expires = Date.now() + Number(json.expires_in) * 1000;
      const accountId = getCodexAccountId(access);

      const outcome = persistCodexProfileOrDefer({ access, refresh, expires, accountId });
      if (outcome.deferred) {
        return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'success', deferred: true, reason: ${jsStringLiteral(kBackupInProgressCode)} }, '*');
      window.close();
    </script><p>Codex connected. The credential will be saved as soon as the running backup finishes. You can close this window.</p></body></html>`);
      }

      return res.send(`<!DOCTYPE html><html><body><script>
      window.opener?.postMessage({ codex: 'success' }, '*');
      window.close();
    </script><p>Codex connected. You can close this window.</p></body></html>`);
    } catch (err) {
      console.error("[codex] OAuth callback error:", err);
      return res.send(oauthErrorPage(err.message || "OAuth error"));
    }
  }));

  app.post("/api/codex/exchange", wrapAsync(async (req, res) => {
    try {
      cleanupCodexOauthStates();
      const { input } = req.body || {};
      const parsed = parseCodexAuthorizationInput(input);
      const code = String(parsed.code || "");
      const state = String(parsed.state || "");
      if (!code || !state) {
        return res.status(400).json({
          ok: false,
          error: "Missing code/state. Paste the full redirect URL from your browser address bar.",
        });
      }
      const oauthState = kCodexOauthStates.get(state);
      if (!oauthState) {
        return res.status(400).json({
          ok: false,
          error: "OAuth state expired or invalid. Start Codex OAuth again.",
        });
      }
      // Pre-check BEFORE consuming the one-use state (same retry contract
      // as the callback: the pasted URL stays valid after the backup).
      if (isStateDbQuiet()) {
        sendIfStateDbQuietError(res, new StateDbQuietError());
        return;
      }
      kCodexOauthStates.delete(state);
      const tokenRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_OAUTH_CLIENT_ID,
          code,
          code_verifier: oauthState.verifier,
          redirect_uri: oauthState.redirectUri,
        }),
      });
      const json = await tokenRes.json().catch(() => ({}));
      if (
        !tokenRes.ok ||
        !json.access_token ||
        !json.refresh_token ||
        typeof json.expires_in !== "number"
      ) {
        return res.status(400).json({
          ok: false,
          error: `Token exchange failed (${tokenRes.status})`,
        });
      }
      const access = String(json.access_token);
      const refresh = String(json.refresh_token);
      const expires = Date.now() + Number(json.expires_in) * 1000;
      const accountId = getCodexAccountId(access);
      const outcome = persistCodexProfileOrDefer({ access, refresh, expires, accountId });
      if (outcome.deferred) {
        // Honest: the tokens are held, not yet persisted.
        return res
          .status(202)
          .json({ ok: true, deferred: true, reason: kBackupInProgressCode });
      }
      return res.json({ ok: true });
    } catch (err) {
      if (sendIfStateDbQuietError(res, err)) return;
      console.error("[codex] Manual exchange error:", err);
      return res
        .status(500)
        .json({ ok: false, error: err.message || "Codex OAuth exchange failed" });
    }
  }));

  app.post("/api/codex/disconnect", (req, res) => {
    try {
      const changed = authProfiles.removeCodexProfiles();
      if (changed) onAuthChanged();
      res.json({ ok: true, changed });
    } catch (err) {
      if (sendIfStateDbQuietError(res, err)) return;
      // The auth store can now fail closed (shared state db busy on the
      // sqlite era) — surface the retry guidance instead of a bare 500.
      res.status(503).json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerCodexRoutes };
