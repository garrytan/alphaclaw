const express = require("express");
const { kGatewayBuiltinHookNames } = require("./webhooks");

// /oauth/<id> is the public redirect target an OAuth provider sends the
// browser to. AlphaClaw rewrites it onto the hook with WEBHOOK_TOKEN injected,
// so anyone holding the URL can start an agent run (ALPH-71 L-9). Each id gets
// a small budget per caller per minute, under a larger ceiling across all
// callers, so one caller cannot spend the provider's redirect. Every provider
// param reaches the hook transform (oauth_verifier, realmId, shop, hmac, iss,
// error_description, ...) except the fields the default transform turns into
// the agent run (message, wake mode, run name) and `source`, which OpenClaw's
// hook mappings match on beside the path: a caller cannot pick another mapping
// (CSO ALPH-71 PR 2). The path is the only other field the matcher reads, and AlphaClaw
// sets it. `token` never reached the transform before L-9 either (the hook
// ingress consumed it). The gateway's built-in wake and agent hooks
// (kGatewayBuiltinHookNames) read the raw payload, so their aliases are 404.
const kOauthCallbackDeniedFields = new Set(["message", "wakeMode", "name", "token", "source"]);
const kReservedFieldNames = new Set(["__proto__", "constructor", "prototype"]);
const kOauthCallbackMaxFieldLength = 4096;
// RFC 6749 VSCHAR: OAuth result values are printable ASCII, so a newline or
// control character is never a legitimate value.
const kOauthCallbackValuePattern = /^[\x20-\x7E]+$/;
const kOauthCallbackRateLimit = 10;
const kOauthCallbackIdRateLimit = 60;
const kOauthCallbackRateWindowMs = 60_000;
const kOauthCallbackRateMaxEntries = 10_000;
// response_mode=form_post (OIDC) delivers the result as a urlencoded POST body.
const parseFormPostBody = express.urlencoded({ extended: false, limit: "64kb" });

const firstString = (value) => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" ? candidate.trim() : "";
};

const pickOauthCallbackFields = (req) => {
  const body = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {};
  const query = new URL(String(req.originalUrl || req.url || ""), "http://localhost").searchParams;
  const fields = {};
  const names = new Set([...query.keys(), ...Object.keys(body)]);
  for (const field of names) {
    if (kOauthCallbackDeniedFields.has(field) || kReservedFieldNames.has(field)) continue;
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
  const idWindows = new Map();
  const callerWindows = new Map();

  const currentWindow = (windows, key, nowMs) => {
    const window = windows.get(key);
    if (window && nowMs - window.startedAt < kOauthCallbackRateWindowMs) return window;
    windows.delete(key);
    if (windows.size >= kOauthCallbackRateMaxEntries) {
      for (const [staleKey, stale] of windows) {
        if (nowMs - stale.startedAt >= kOauthCallbackRateWindowMs) windows.delete(staleKey);
      }
      if (windows.size >= kOauthCallbackRateMaxEntries) windows.delete(windows.keys().next().value);
    }
    const fresh = { startedAt: nowMs, count: 0 };
    windows.set(key, fresh);
    return fresh;
  };

  const refuse = (window, nowMs) => {
    const retryAfterMs = window.startedAt + kOauthCallbackRateWindowMs - nowMs;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  };

  const takeRateBudget = (callbackId, caller) => {
    const nowMs = now();
    const idWindow = currentWindow(idWindows, callbackId, nowMs);
    if (idWindow.count >= kOauthCallbackIdRateLimit) return refuse(idWindow, nowMs);
    const callerWindow = currentWindow(callerWindows, `${callbackId}\n${caller}`, nowMs);
    if (callerWindow.count >= kOauthCallbackRateLimit) return refuse(callerWindow, nowMs);
    idWindow.count += 1;
    callerWindow.count += 1;
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
    if (!callback?.hookName || kGatewayBuiltinHookNames.has(callback.hookName)) {
      return res.status(404).json({ error: "Not found" });
    }
    const budget = takeRateBudget(callbackId, String(req.ip || req.socket?.remoteAddress || ""));
    if (!budget.ok) {
      res.setHeader("Retry-After", String(budget.retryAfterSeconds));
      return res.status(429).json({ error: "Too many requests" });
    }
    try {
      markOauthCallbackUsed(callbackId);
    } catch {}
    return parseFormPostBody(req, res, (parseError) => {
      if (parseError) {
        return res.status(parseError.status || 400).json({ error: "Bad Request" });
      }
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
    });
  };
};

module.exports = {
  createOauthCallbackMiddleware,
};
