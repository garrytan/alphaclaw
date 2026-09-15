const { kDefaultGoogleClient } = require("./google-state");
const { parseJsonSafe } = require("./utils/json");
const { quoteShellArg } = require("./utils/shell");

const retryableDisconnectError = (detail) => Object.assign(
  new Error(`${detail}; account kept so disconnect can be retried`),
  { code: "google_disconnect_failed", retryable: true },
);

// Called only while the account's disconnect operation owns its lifecycle.
const revokeGoogleAccount = async ({ account, gogCmd, withPrivateTokenFile, fs }) => {
  // clientArg must live at function scope: the `auth remove` call below the
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
    if (!exportResult.ok && exportResult.timedOut) {
      // A TIMED-OUT/killed export is transient — the token may still be
      // live. Falling through to best-effort removal here would orphan it
      // (the "hung export == no token" bug). Keep the account; retry.
      throw retryableDisconnectError(
        "token export timed out (the account may still hold a live token)",
      );
    }
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
        // refresh_token in the staged file), proceed to local removal.
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
            // A 307/308 would replay the credential POST to another
            // origin; the revoke endpoint is fixed, so never follow.
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
        } catch (err) {
          throw retryableDisconnectError(`token revocation request failed (${err.message})`);
        }
        if (revokeRes.ok) {
          // Discard the (empty) success body so undici releases the
          // socket without buffering whatever a broken proxy returns.
          await revokeRes.body?.cancel?.().catch?.(() => {});
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
    // Keep the local account until both the remote grant and local
    // keyring entry are removed, so failed cleanup remains retryable.
    console.warn(
      "[alphaclaw] gog auth remove failed during disconnect; a credential entry may remain in the gog keyring:",
      // Subprocess stderr is attacker-influenceable text headed for
      // durable logs: strip control chars/newlines to block log forging.
      String(removeResult.stderr || "")
        .replace(/[\x00-\x1f\x7f]+/g, " ")
        .slice(0, 200),
    );
    throw retryableDisconnectError("gog auth remove failed");
  }
};

module.exports = { revokeGoogleAccount, retryableDisconnectError };
