// /oauth/<id> is the public redirect target an OAuth provider sends the
// browser to. AlphaClaw rewrites it onto the hook with WEBHOOK_TOKEN injected,
// so anyone holding the URL can start an agent run (ALPH-71 L-9). Each id gets
// a small fixed budget per minute, and only the OAuth result fields reach the
// hook transform: a caller can no longer pick the agent's message, wake mode
// or run name.
const kOauthCallbackFields = ["code", "state", "error"];
const kOauthCallbackMaxFieldLength = 4096;
// RFC 6749 VSCHAR: code, state and error are printable ASCII, so a newline or
// control character is never a legitimate value.
const kOauthCallbackValuePattern = /^[\x20-\x7E]+$/;
const kOauthCallbackRateLimit = 10;
const kOauthCallbackRateWindowMs = 60_000;

const firstString = (value) => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" ? candidate.trim() : "";
};

const pickOauthCallbackFields = (req) => {
  const body = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {};
  const query = new URL(String(req.originalUrl || req.url || ""), "http://localhost").searchParams;
  const fields = {};
  for (const field of kOauthCallbackFields) {
    const value = firstString(body[field]) || String(query.get(field) || "").trim();
    if (value && value.length <= kOauthCallbackMaxFieldLength && kOauthCallbackValuePattern.test(value)) {
      fields[field] = value;
    }
  }
  return fields;
};

const createOauthCallbackMiddleware = ({
  getOauthCallbackById,
  markOauthCallbackUsed = () => {},
  webhookMiddleware,
  now = () => performance.now(),
}) => {
  const rateWindows = new Map();

  const takeRateBudget = (callbackId) => {
    const nowMs = now();
    const window = rateWindows.get(callbackId);
    if (!window || nowMs - window.startedAt >= kOauthCallbackRateWindowMs) {
      rateWindows.set(callbackId, { startedAt: nowMs, count: 1 });
      return { ok: true };
    }
    if (window.count >= kOauthCallbackRateLimit) {
      const retryAfterMs = window.startedAt + kOauthCallbackRateWindowMs - nowMs;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    window.count += 1;
    return { ok: true };
  };

  return (req, res) => {
    const method = String(req.method || "").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const callbackId = String(req.params?.id || "").trim();
    if (!callbackId) {
      return res.status(404).json({ error: "Not found" });
    }
    const callback = getOauthCallbackById(callbackId);
    if (!callback?.hookName) {
      return res.status(404).json({ error: "Not found" });
    }
    const budget = takeRateBudget(callbackId);
    if (!budget.ok) {
      res.setHeader("Retry-After", String(budget.retryAfterSeconds));
      return res.status(429).json({ error: "Too many requests" });
    }
    try {
      markOauthCallbackUsed(callbackId);
    } catch {}
    const fields = pickOauthCallbackFields(req);
    const rewrittenUrl = `/hooks/${callback.hookName}`;
    req.url = rewrittenUrl;
    req.originalUrl = rewrittenUrl;
    req.method = "POST";
    req.body = Buffer.from(JSON.stringify(fields), "utf8");
    req.headers["content-type"] = "application/json";
    const webhookToken = String(process.env.WEBHOOK_TOKEN || "").trim();
    if (webhookToken) {
      req.headers.authorization = `Bearer ${webhookToken}`;
    }
    return webhookMiddleware(req, res);
  };
};

module.exports = {
  createOauthCallbackMiddleware,
};
