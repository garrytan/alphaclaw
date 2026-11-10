const fs = require("fs");
const path = require("path");

// A gateway restart the owner's own attested Capy thread asks for (GST-2323
// PR2). A relay turn never restarts the gateway itself: the relay guard
// refuses the raw call and asks AlphaClaw instead, through its loopback
// route POST /relay/internal/gateway-restart (routes/relay.js, the relay's
// 0600 internal secret as the bearer, the same caller rule as
// /relay/internal/mask). AlphaClaw checks the message is the owner's
// attested thread's from its own records and starts its attributed restart
// ladder with source relay:<thread code>. Only the message id is sent;
// nothing the relay turn chose decides who asked.
const kRequestTimeoutMs = 5000;

// The AlphaClaw server's port, from the gateway's environment (PORT crosses
// into it for the agent's alphaclaw admin; gateway-env-policy.js).
const appPortOf = (env) => {
  const port = Number.parseInt(String(env?.PORT || "3000"), 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
};

// { ok: true, operationId, attached, source } or { ok: false, code, error }.
// Never throws: an unreachable server is { ok: false, code: "unreachable" }.
const requestGatewayRestart = async ({ rootDir, messageId, env = process.env, fetchImpl = globalThis.fetch, fsModule = fs } = {}) => {
  const unreachable = { ok: false, code: "unreachable" };
  const port = appPortOf(env);
  if (!port || !rootDir || !messageId || typeof fetchImpl !== "function") return unreachable;
  let secret;
  try {
    secret = fsModule.readFileSync(path.join(String(rootDir), "relay", "internal.secret"), "utf8").trim();
  } catch {
    return unreachable;
  }
  if (!secret) return unreachable;
  try {
    const response = await fetchImpl("http://127.0.0.1:" + port + "/relay/internal/gateway-restart", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ message_id: String(messageId) }),
      signal: AbortSignal.timeout(kRequestTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") return unreachable;
    return body.ok === true ? { ok: true, operationId: String(body.operationId || ""), attached: body.attached === true, source: String(body.source || "") } : { ok: false, code: String(body.code || "refused"), error: String(body.error || "") };
  } catch {
    return unreachable;
  }
};

module.exports = { requestGatewayRestart, appPortOf };
