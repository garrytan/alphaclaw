const express = require("express");
const { authorizationHandler } = require("@modelcontextprotocol/sdk/server/auth/handlers/authorize.js");
const { tokenHandler } = require("@modelcontextprotocol/sdk/server/auth/handlers/token.js");
const { clientRegistrationHandler } = require("@modelcontextprotocol/sdk/server/auth/handlers/register.js");
const { revocationHandler } = require("@modelcontextprotocol/sdk/server/auth/handlers/revoke.js");
const { requireBearerAuth } = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { wrapAsync } = require("../utils/wrap-async");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { sendRelayProblem, RelayError } = require("../relay/errors");
const { kRelayEngineVersion } = require("../relay/constants");
const { kRelayScope } = require("../relay/oauth-provider");

// The relay's public surface, for remote agents (Capy threads):
//   GET  /.well-known/oauth-authorization-server         RFC 8414 metadata
//   GET  /.well-known/oauth-protected-resource/relay/mcp RFC 9728 metadata
//   /relay/oauth/{register,authorize,token,revoke}       MCP SDK handlers
//   GET|POST /relay/oauth/consent                        admin-only consent
//   POST /relay/mcp                                      Streamable HTTP MCP,
//                                                        bearer token only
// and the owner's view and controls under /api/relay/remote (humans only for
// mutations). Every grant, refresh, revoke and binding is in the remote
// audit log; no token, capability or webhook URL is ever returned here.
const kOauthBase = "/relay/oauth";
const kMcpPath = "/relay/mcp";
const kRequestIdPattern = /^[A-Za-z0-9_-]{20,100}$/;
const kClientIdPattern = /^[A-Za-z0-9_-]{1,100}$/;
const kAgentPattern = /^capy-[a-f0-9]{12}$/;

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const consentHtml = ({ title, body, formAction = "" }) =>
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
  "<title>" + escapeHtml(title) + "</title><style>" +
  "body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0d121b;color:#c9d1d9;display:flex;justify-content:center;padding:48px 16px;margin:0}" +
  "main{max-width:520px;width:100%;background:#0f141f;border:1px solid rgba(255,255,255,.11);border-radius:12px;padding:24px}" +
  "h1{font-size:18px;margin:0 0 12px;color:#f3f4f6}p,li{font-size:14px;line-height:1.5}code{background:rgba(0,0,0,.3);padding:1px 4px;border-radius:4px}" +
  ".row{display:flex;gap:12px;margin-top:20px}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.13);cursor:pointer}" +
  ".ok{background:#63ebff;color:#0d121b;border-color:#63ebff}.no{background:transparent;color:#c9d1d9}.muted{color:#6e7681;font-size:12px}" +
  "input{font:inherit;margin-left:8px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:#0d121b;color:#f3f4f6;letter-spacing:.08em;text-transform:uppercase;width:11ch}" +
  "</style></head><body><main>" + body + "</main></body></html>";

const sendConsentPage = (res, status, { title, body, formOrigin = null }) => {
  res.status(status);
  res.set("Cache-Control", "no-store");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "same-origin");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" + (formOrigin ? " " + formOrigin : ""),
  );
  res.type("html").send(consentHtml({ title, body }));
};

const registerRelayRemoteRoutes = ({ app, requireAuth, requireAdmin, resolveRequestIdentity, relayRemote, logger = console }) => {
  // The SDK handlers (and their rate limiters) are built once, here; they
  // reach the provider through this delegate, which opens the store on first
  // use. available() answers the relay's own problem body until it can.
  const current = () => relayRemote.ensureOpen().provider;
  const provider = {
    clientsStore: {
      getClient: (clientId) => current().clientsStore.getClient(clientId),
      registerClient: (client) => current().clientsStore.registerClient(client),
    },
    authorize: (...args) => current().authorize(...args),
    challengeForAuthorizationCode: (...args) => current().challengeForAuthorizationCode(...args),
    exchangeAuthorizationCode: (...args) => current().exchangeAuthorizationCode(...args),
    exchangeRefreshToken: (...args) => current().exchangeRefreshToken(...args),
    verifyAccessToken: (...args) => current().verifyAccessToken(...args),
    revokeToken: (...args) => current().revokeToken(...args),
    authenticateClientSecret: (...args) => current().authenticateClientSecret(...args),
  };
  const available = (req, res, next) => {
    try {
      relayRemote.ensureOpen();
      return next();
    } catch (error) {
      return sendRelayProblem(res, error);
    }
  };

  app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/relay/oauth"], (req, res) => {
    const reason = relayRemote.unavailableReason();
    if (reason === "relay_disabled" || reason === "remote_disabled") return res.status(404).json({ error: "not_found" });
    if (reason === "public_url_missing") return sendRelayProblem(res, new RelayError(reason));
    const origin = relayRemote.publicOrigin();
    res.set("Cache-Control", "no-store");
    res.json({
      issuer: origin,
      authorization_endpoint: origin + kOauthBase + "/authorize",
      token_endpoint: origin + kOauthBase + "/token",
      registration_endpoint: origin + kOauthBase + "/register",
      revocation_endpoint: origin + kOauthBase + "/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      revocation_endpoint_auth_methods_supported: ["client_secret_post"],
      scopes_supported: [kRelayScope],
    });
  });

  app.get(["/.well-known/oauth-protected-resource/relay/mcp", "/.well-known/oauth-protected-resource"], (req, res) => {
    const reason = relayRemote.unavailableReason();
    if (reason === "relay_disabled" || reason === "remote_disabled") return res.status(404).json({ error: "not_found" });
    if (reason === "public_url_missing") return sendRelayProblem(res, new RelayError(reason));
    res.set("Cache-Control", "no-store");
    res.json({
      resource: relayRemote.mcpUrl(),
      authorization_servers: [relayRemote.publicOrigin()],
      scopes_supported: [kRelayScope],
      bearer_methods_supported: ["header"],
      resource_name: "AlphaClaw Agent Relay",
    });
  });

  app.use(kOauthBase + "/register", available, clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0 }));
  app.use(kOauthBase + "/authorize", available, authorizationHandler({ provider }));
  const clientBody = [express.urlencoded({ extended: false }), express.json()];
  app.use(kOauthBase + "/token", available, ...clientBody, provider.authenticateClientSecret, tokenHandler({ provider }));
  app.use(kOauthBase + "/revoke", available, ...clientBody, provider.authenticateClientSecret, revocationHandler({ provider }));

  const loadPending = (requestId) => {
    if (!kRequestIdPattern.test(String(requestId || ""))) return null;
    const { store } = relayRemote.ensureOpen();
    const pending = store.pending.get(requestId);
    if (!pending) return null;
    const client = store.clients.get(pending.clientId);
    return client ? { pending, client } : null;
  };

  const consentGate = (req, res) => {
    const identity = resolveRequestIdentity(req);
    if (!identity) {
      const next = kOauthBase + "/consent?request=" + encodeURIComponent(String(req.query.request || req.body?.request || ""));
      res.redirect(302, "/login.html?next=" + encodeURIComponent(next));
      return null;
    }
    if (identity.role !== "admin") {
      sendConsentPage(res, 403, {
        title: "Admin sign-in needed",
        body: "<h1>Only an admin can connect agents to this relay</h1><p>Sign in to AlphaClaw as an admin, then start Connect again.</p>",
      });
      return null;
    }
    return identity;
  };

  app.get(kOauthBase + "/consent", (req, res) => {
    try {
      relayRemote.ensureOpen();
    } catch (error) {
      return sendRelayProblem(res, error);
    }
    if (!consentGate(req, res)) return undefined;
    const loaded = loadPending(req.query.request);
    if (!loaded) {
      return sendConsentPage(res, 410, { title: "Request expired", body: "<h1>This sign-in request expired</h1><p>Start Connect again from the app that sent you here.</p>" });
    }
    const { pending, client } = loaded;
    const redirect = new URL(pending.params.redirectUri);
    const name = client.info?.client_name || "An MCP client";
    const windowOpen = relayRemote.ensureOpen().provider.consentAllowsRequest(pending.id);
    return sendConsentPage(res, 200, {
      title: "Connect to the Agent Relay",
      formOrigin: redirect.origin,
      body:
        "<h1>Connect " + escapeHtml(name) + " to this box's Agent Relay?</h1>" +
        "<p>It will be able to:</p><ul>" +
        "<li>join the relay as <code>capy-…</code> agents, one per thread it binds, and message any agent on it, including this box's agent;</li>" +
        "<li>read those agents' own inboxes and conversations, and have each thread woken at a webhook it registers;</li>" +
        "</ul><p>Its messages to this box's agent run in a separate, messaging-only session: the agent answers from what it already knows and cannot read files, run commands, change files or settings, or send messages for it. Anything more waits for you, and AlphaClaw tells you when a request does. Text the agent sends back is checked for this box's credentials and masked first; treat that as a safety net, not a promise. You can revoke this connection on the Relay page.</p>" +
        "<p><strong>Approve only if you pressed Connect in your own app just now.</strong> Anyone can start this request and send you the link.</p>" +
        "<p class=\"muted\">After you choose, your browser returns to <code>" + escapeHtml(redirect.origin) + "</code>. Client id " + escapeHtml(client.clientId) + ".</p>" +
        (windowOpen
          ? ""
          : "<p><strong>This request cannot be approved.</strong> Approval needs a connection you allowed first. If you want to connect this app, open the Relay page in AlphaClaw, press <em>Allow a new connection</em>, then start Connect again from your app.</p>") +
        "<form method=\"post\" action=\"" + kOauthBase + "/consent\">" +
        "<input type=\"hidden\" name=\"request\" value=\"" + escapeHtml(pending.id) + "\">" +
        "<input type=\"hidden\" name=\"csrf\" value=\"" + escapeHtml(pending.csrf) + "\">" +
        (windowOpen
          ? "<p><label>Code from the Relay page <input name=\"consent_code\" autocomplete=\"off\" spellcheck=\"false\" maxlength=\"20\" required></label></p>" +
            "<p class=\"muted\">The Relay page showed this code when you pressed <em>Allow a new connection</em>. If you did not press it, press Cancel.</p>"
          : "") +
        "<div class=\"row\">" +
        (windowOpen ? "<button class=\"ok\" name=\"decision\" value=\"approve\" type=\"submit\">Connect</button>" : "") +
        "<button class=\"no\" name=\"decision\" value=\"deny\" type=\"submit\" formnovalidate>Cancel</button></div></form>",
    });
  });

  app.post(kOauthBase + "/consent", express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
    try {
      relayRemote.ensureOpen();
    } catch (error) {
      return sendRelayProblem(res, error);
    }
    const identity = consentGate(req, res);
    if (!identity) return undefined;
    // A browser sends Origin: null for a form post from a page whose
    // referrer policy hides the origin, so "null" counts as absent and
    // Sec-Fetch-Site decides; the CSRF token is checked either way.
    const origin = String(req.get("origin") || "");
    const fetchSite = String(req.get("sec-fetch-site") || "");
    const sameOrigin = origin && origin !== "null" ? origin === relayRemote.publicOrigin() : fetchSite === "same-origin";
    const loaded = loadPending(req.body?.request);
    if (!sameOrigin || !loaded || !timingSafeStringEqual(String(req.body?.csrf || ""), loaded.pending.csrf)) {
      logger.warn("[relay] oauth consent refused: " + (!sameOrigin ? "cross-origin post" : !loaded ? "unknown or expired request" : "csrf mismatch"));
      return sendConsentPage(res, 403, { title: "Request refused", body: "<h1>This consent request could not be verified</h1><p>Start Connect again.</p>" });
    }
    try {
      const target = relayRemote.ensureOpen().provider.completeConsent({
        requestId: loaded.pending.id,
        approve: req.body?.decision === "approve",
        actor: identity.kind === "member" ? "member:" + identity.memberId : identity.kind,
        presentedCode: req.body?.consent_code,
      });
      res.set("Cache-Control", "no-store");
      return res.redirect(303, target);
    } catch (error) {
      if (error?.consentWindowClosed) {
        return sendConsentPage(res, 403, {
          title: "This request cannot be approved",
          body: "<h1>This request cannot be approved</h1><p>Nothing was approved. If you want to connect this app, open the Relay page in AlphaClaw, press <em>Allow a new connection</em>, then start Connect again from your app within 10 minutes.</p>",
        });
      }
      if (error?.consentCodeMismatch) {
        return sendConsentPage(res, 403, {
          title: "The code does not match",
          body: "<h1>The code does not match</h1><p>Nothing was approved. Go back and enter the code the Relay page showed when you pressed <em>Allow a new connection</em>.</p>",
        });
      }
      return sendConsentPage(res, 410, { title: "Request expired", body: "<h1>This sign-in request expired</h1><p>" + escapeHtml(error?.message || "") + "</p>" });
    }
  });

  const bearer = (req, res, next) => {
    try {
      relayRemote.ensureOpen();
    } catch (error) {
      return sendRelayProblem(res, error);
    }
    const metadataUrl = relayRemote.publicOrigin() + "/.well-known/oauth-protected-resource/relay/mcp";
    return requireBearerAuth({ verifier: provider, resourceMetadataUrl: metadataUrl, expectedResource: new URL(relayRemote.mcpUrl()) })(req, res, next);
  };

  app.post(
    kMcpPath,
    bearer,
    wrapAsync(async (req, res) => {
      const { tools, store } = relayRemote.ensureOpen();
      const clientId = req.auth.clientId;
      const server = new Server({ name: "alphaclaw-relay", version: kRelayEngineVersion }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = String(request.params.name || "");
        const result = await tools.call({ clientId, name, args: request.params.arguments || {} });
        const logSafe = (value) => String(value || "").slice(0, 40).replace(/[^A-Za-z0-9_.:-]/g, "?") || "-";
        logger.log("[relay] remote tool=" + logSafe(name) + " client=" + logSafe(clientId) + " as=" + logSafe(request.params.arguments?.as) + " " + (result.isError ? "error" : "ok"));
        return result;
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      store.clients.touch(clientId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }),
  );
  app.all(kMcpPath, (req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this endpoint is stateless, POST only." }, id: null });
  });

  app.get("/api/relay/remote", requireAuth, (req, res) => {
    res.json({ ok: true, ...relayRemote.getStatus() });
  });

  const actorOf = (req) => {
    const identity = resolveRequestIdentity(req);
    return identity?.kind === "member" ? "member:" + identity.memberId : identity?.kind || "unknown";
  };

  // Opens the 10-minute window in which one consent can be approved, and
  // returns its one-time code to this admin only (never in GET status, which
  // the agent can read). Admins only, and outside the agent's manifest
  // (admin-manifest/index.js).
  app.post("/api/relay/remote/consent-window", requireAuth, requireAdmin, (req, res) => {
    try {
      const result = relayRemote.openConsentWindow({ actor: actorOf(req) });
      logger.log("[relay] remote consent window opened until " + result.until);
      res.set("Cache-Control", "no-store");
      return res.json({ ok: true, ...result });
    } catch (error) {
      return sendRelayProblem(res, error);
    }
  });

  app.post("/api/relay/remote/clients/:clientId/revoke", requireAuth, requireAdmin, (req, res) => {
    const clientId = String(req.params.clientId || "");
    if (!kClientIdPattern.test(clientId)) return sendRelayProblem(res, new RelayError("invalid_input", "clientId is not a client id."));
    try {
      const result = relayRemote.revokeClient({ clientId, actor: actorOf(req) });
      if (!result) return res.status(404).json({ ok: false, error: "No such client." });
      logger.log("[relay] remote client " + clientId + " revoked; bindings removed: " + result.bindingsRemoved.length);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return sendRelayProblem(res, error);
    }
  });

  app.delete("/api/relay/remote/bindings/:agent", requireAuth, requireAdmin, (req, res) => {
    const agent = String(req.params.agent || "");
    if (!kAgentPattern.test(agent)) return sendRelayProblem(res, new RelayError("invalid_input", "agent is not a capy- agent name."));
    try {
      const result = relayRemote.removeBinding({ agent, actor: actorOf(req) });
      if (!result) return res.status(404).json({ ok: false, error: "No such binding." });
      logger.log("[relay] remote binding " + agent + " removed by the owner");
      return res.json({ ok: true, ...result });
    } catch (error) {
      return sendRelayProblem(res, error);
    }
  });
};

module.exports = { registerRelayRemoteRoutes, kMcpPath, kOauthBase };
