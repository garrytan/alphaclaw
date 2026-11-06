const crypto = require("crypto");
const {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
} = require("@modelcontextprotocol/sdk/server/auth/errors.js");

// AlphaClaw's OAuth authorization server for the relay's remote MCP endpoint
// (an OAuthServerProvider for the MCP SDK's auth handlers). Only the box's
// admin can grant access, on the consent page (routes/relay-remote.js); this
// provider parks every authorization request until then.
//
//   register (DCR)  redirect_uris must all be allowlisted (Capy's callback by
//                   default); unconsented registrations are capped and expire
//   authorize       PKCE S256 required by the SDK; resource must be /relay/mcp
//                   (RFC 8707) -> pending request -> consent page
//   token           code single-use, 5 min, bound to client, redirect, resource
//                   access 1 h, refresh 30 d rotating; a refresh token used
//                   twice revokes its whole family (replay)
//   verify          hashed lookup; revoked client or family -> invalid
//   consent window  approval needs a window the admin opened on the Relay
//                   page in the last 10 min ("Allow a new connection"), for a
//                   request started after it opened, one approval per window,
//                   so a consent link someone else started and forwarded
//                   cannot be approved on its own
const kAccessTtlMs = 60 * 60 * 1000;
const kRefreshTtlMs = 30 * 24 * 60 * 60 * 1000;
const kCodeTtlMs = 5 * 60 * 1000;
const kPendingTtlMs = 10 * 60 * 1000;
const kUnconsentedClientTtlMs = 24 * 60 * 60 * 1000;
const kMaxPendingRegistrations = 20;
const kRelayScope = "relay";
const kConsentWindowMs = 10 * 60 * 1000;

const sameResource = (a, b) => {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
};

const createRelayOAuthProvider = ({ store, getResourceUrl, getRedirectAllowlist, consentPath = "/relay/oauth/consent", now = Date.now, logger = console }) => {
  let consentWindowOpenedAt = 0;
  let consentWindowUntil = 0;
  const consentWindowOpen = () => now() < consentWindowUntil;
  const consentAllows = (pendingRow) =>
    Boolean(pendingRow) && consentWindowOpen() && pendingRow.expiresAt - kPendingTtlMs >= consentWindowOpenedAt;
  const resolveResource = (requested) => {
    const resource = getResourceUrl();
    if (requested && !sameResource(String(requested), resource)) {
      throw new InvalidTargetError("This server only issues tokens for " + resource);
    }
    return resource;
  };

  const liveClient = (clientId) => {
    const row = store.clients.get(clientId);
    if (!row || row.revokedAt) return null;
    if (!row.consentedAt && now() - row.createdAt > kUnconsentedClientTtlMs) return null;
    return row;
  };

  const clientsStore = {
    getClient: (clientId) => liveClient(clientId)?.info,
    registerClient: (client) => {
      const allowed = new Set(getRedirectAllowlist());
      const uris = Array.isArray(client.redirect_uris) ? client.redirect_uris.map(String) : [];
      const refused = uris.filter((uri) => !allowed.has(uri));
      if (!uris.length || refused.length) {
        logger.warn("[relay] oauth registration refused: redirect_uri not allowed (" + refused.map((uri) => { try { return new URL(uri).host; } catch { return "invalid"; } }).join(",") + ")");
        throw new InvalidClientMetadataError("redirect_uris must be one of the allowed callbacks: " + [...allowed].join(", "));
      }
      // Registration is anonymous, so a full waiting list never refuses: the
      // oldest registration still waiting for consent makes room. A burst
      // can push out an owner's registration that is still waiting (Connect
      // again then), but it can never refuse a new one.
      while (store.clients.countPending(now() - kUnconsentedClientTtlMs) >= kMaxPendingRegistrations) {
        const evicted = store.clients.evictOldestPending(now() - kUnconsentedClientTtlMs);
        if (!evicted) break;
        store.audit("client_evicted", { clientId: evicted, detail: { reason: "waiting_list_full" } });
      }
      const info = { ...client, client_name: String(client.client_name || "").slice(0, 100) || undefined };
      store.clients.insert(info);
      store.audit("client_registered", { clientId: info.client_id, detail: { name: info.client_name || null, redirectHosts: uris.map((uri) => new URL(uri).host) } });
      return info;
    },
  };

  const issueTokens = ({ clientId, family, resource, scopes }) => {
    const accessToken = store.tokens.issue({ kind: "access", clientId, family, resource, scopes, ttlMs: kAccessTtlMs });
    const refreshToken = store.tokens.issue({ kind: "refresh", clientId, family, resource, scopes, ttlMs: kRefreshTtlMs });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(kAccessTtlMs / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  };

  return {
    clientsStore,

    authorize: async (client, params, res) => {
      const resource = resolveResource(params.resource ? params.resource.href : null);
      const { id } = store.pending.create({
        clientId: client.client_id,
        params: {
          state: params.state || null,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          resource,
          scopes: [kRelayScope],
        },
        ttlMs: kPendingTtlMs,
      });
      res.redirect(302, consentPath + "?request=" + encodeURIComponent(id));
    },

    challengeForAuthorizationCode: async (client, code) => {
      const row = store.codes.get(code);
      if (!row || row.clientId !== client.client_id || row.usedAt || row.expiresAt < now()) {
        throw new InvalidGrantError("The authorization code is invalid or expired.");
      }
      return row.challenge;
    },

    exchangeAuthorizationCode: async (client, code, _codeVerifier, redirectUri, resource) => {
      const row = store.codes.get(code);
      if (!row || row.clientId !== client.client_id || row.expiresAt < now()) {
        throw new InvalidGrantError("The authorization code is invalid or expired.");
      }
      if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request.");
      if (resource && !sameResource(resource.href, row.resource)) throw new InvalidTargetError("resource does not match the authorization request.");
      if (!store.codes.markUsed(code)) throw new InvalidGrantError("The authorization code was already used.");
      if (!liveClient(client.client_id)) throw new InvalidGrantError("The client was revoked.");
      const family = crypto.randomUUID();
      store.audit("token_issued", { clientId: client.client_id, detail: { family } });
      return issueTokens({ clientId: client.client_id, family, resource: row.resource, scopes: row.scopes });
    },

    exchangeRefreshToken: async (client, refreshToken, _scopes, resource) => {
      const row = store.tokens.get(refreshToken);
      if (!row || row.kind !== "refresh" || row.clientId !== client.client_id) throw new InvalidGrantError("The refresh token is invalid.");
      if (row.usedAt || row.revokedAt) {
        if (row.usedAt && !row.revokedAt) {
          store.tokens.revokeFamily(row.family);
          store.audit("refresh_replay", { clientId: client.client_id, detail: { family: row.family } });
          logger.warn("[relay] oauth refresh token reuse for client " + client.client_id + ": revoked its token family");
        }
        throw new InvalidGrantError("The refresh token was already used or revoked.");
      }
      if (row.expiresAt < now()) throw new InvalidGrantError("The refresh token expired; connect again.");
      if (resource && !sameResource(resource.href, row.resource)) throw new InvalidTargetError("resource does not match the original grant.");
      if (!liveClient(client.client_id)) throw new InvalidGrantError("The client was revoked.");
      if (!store.tokens.markUsed(refreshToken)) throw new InvalidGrantError("The refresh token was already used.");
      store.audit("token_refreshed", { clientId: client.client_id, detail: { family: row.family } });
      return issueTokens({ clientId: client.client_id, family: row.family, resource: row.resource, scopes: row.scopes });
    },

    verifyAccessToken: async (token) => {
      const row = store.tokens.get(String(token || ""));
      if (!row || row.kind !== "access" || row.revokedAt || row.expiresAt < now()) throw new InvalidTokenError("The access token is invalid or expired.");
      if (!liveClient(row.clientId)) throw new InvalidTokenError("The client was revoked.");
      return {
        token,
        clientId: row.clientId,
        scopes: row.scopes,
        expiresAt: Math.floor(row.expiresAt / 1000),
        resource: new URL(row.resource),
      };
    },

    revokeToken: async (client, request) => {
      const row = store.tokens.get(String(request?.token || ""));
      if (!row || row.clientId !== client.client_id) return;
      store.tokens.revokeFamily(row.family);
      store.audit("token_revoked", { clientId: client.client_id, detail: { family: row.family, by: "client" } });
    },

    openConsentWindow: ({ actor }) => {
      consentWindowOpenedAt = now();
      consentWindowUntil = consentWindowOpenedAt + kConsentWindowMs;
      store.audit("consent_window_opened", { detail: { actor, until: new Date(consentWindowUntil).toISOString() } });
      return { until: new Date(consentWindowUntil).toISOString() };
    },

    consentWindowUntil: () => (consentWindowOpen() ? new Date(consentWindowUntil).toISOString() : null),

    // Whether this pending request may be approved now: the window is open
    // and the request was started after it opened.
    consentAllowsRequest: (requestId) => consentAllows(store.pending.get(requestId)),

    // The consent page's decision. Returns the redirect the browser follows.
    // An approval outside the consent window, or of a request started before
    // the window opened, is refused and approves nothing.
    completeConsent: ({ requestId, approve, actor }) => {
      const pendingRow = store.pending.get(requestId);
      if (pendingRow && approve && !consentAllows(pendingRow)) {
        store.audit("consent_refused", { clientId: pendingRow.clientId, detail: { actor, reason: consentWindowOpen() ? "request_before_window" : "window_closed" } });
        throw Object.assign(new InvalidRequestError("No new connection is allowed for this request."), { consentWindowClosed: true });
      }
      if (!pendingRow || !store.pending.take(requestId)) throw new InvalidRequestError("This sign-in request expired; start Connect again.");
      const client = liveClient(pendingRow.clientId);
      const { params } = pendingRow;
      const target = new URL(params.redirectUri);
      if (params.state) target.searchParams.set("state", params.state);
      if (!client || !approve) {
        target.searchParams.set("error", "access_denied");
        store.audit("consent_denied", { clientId: pendingRow.clientId, detail: { actor } });
        return target.href;
      }
      const code = store.codes.create({
        clientId: client.clientId,
        challenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        resource: params.resource,
        scopes: params.scopes,
        ttlMs: kCodeTtlMs,
      });
      store.clients.markConsented(client.clientId);
      consentWindowUntil = 0;
      store.audit("consent_granted", { clientId: client.clientId, detail: { actor, redirectHost: target.host } });
      target.searchParams.set("code", code);
      return target.href;
    },

    revokeClient: ({ clientId, actor }) => {
      if (!store.clients.get(clientId)) return null;
      store.clients.revoke(clientId);
      const agents = store.bindings.removeForClient(clientId);
      store.audit("client_revoked", { clientId, detail: { actor, bindingsRemoved: agents.length } });
      return { clientId, bindingsRemoved: agents };
    },
  };
};

module.exports = {
  createRelayOAuthProvider,
  sameResource,
  kAccessTtlMs,
  kRefreshTtlMs,
  kCodeTtlMs,
  kPendingTtlMs,
  kConsentWindowMs,
  kMaxPendingRegistrations,
  kRelayScope,
};
