const http = require("http");
const https = require("https");
const { URL } = require("url");
const { normalizeIp } = require("./utils/network");
const {
  kForwardedEvidenceHeaders,
  sanitizeProxyHeaders,
} = require("./proxy-identity");
const {
  shouldForwardResponseHeader,
} = require("./routes/response-header-policy");

const { sanitizeLabel } = require("./utils/sanitize-label");

// Every header a caller can use to authenticate a hook delivery is redacted in
// the stored request log: the log is readable by the agent actor at the
// "safe" tier, so a plaintext token there is a token leak (fix wave F149).
const kRedactedHeaderKeys = new Set([
  "authorization",
  "cookie",
  "x-webhook-token",
  "x-openclaw-token",
  "x-telegram-bot-api-secret-token",
  "x-hub-signature",
  "x-hub-signature-256",
]);
const kDefaultGatewayTimeoutMs = 30_000;
const kRedactedPayloadKeys = new Set([
  "authorization",
  "code",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
]);
const kGmailDedupeTtlMs = 24 * 60 * 60 * 1000;
const kGmailDedupeCleanupIntervalMs = 60 * 1000;

const sanitizeHeaders = (headers) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = String(key || "").toLowerCase();
    if (!normalizedKey) continue;
    if (kRedactedHeaderKeys.has(normalizedKey)) {
      sanitized[normalizedKey] = "[REDACTED]";
      continue;
    }
    sanitized[normalizedKey] = Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return sanitized;
};

const extractBodyBuffer = (req) => {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (req.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body), "utf8");
  }
  return Buffer.alloc(0);
};

const truncateText = (text, maxBytes) => {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(String(text || ""), "utf8");
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString("utf8"), truncated: false };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
};

const redactPayloadData = (value, key = "") => {
  const normalizedKey = String(key || "").toLowerCase();
  if (normalizedKey && kRedactedPayloadKeys.has(normalizedKey)) {
    return "[REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactPayloadData(item));
  }

  if (value && typeof value === "object") {
    const redacted = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = redactPayloadData(childValue, childKey);
    }
    return redacted;
  }

  return value;
};

const sanitizePayloadForLogging = (bodyBuffer) => {
  if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return bodyBuffer;
  const parsedBody = parseJsonSafe(bodyBuffer.toString("utf8"));
  if (!parsedBody || typeof parsedBody !== "object") {
    return bodyBuffer;
  }
  return Buffer.from(JSON.stringify(redactPayloadData(parsedBody)), "utf8");
};

const toGatewayRequestHeaders = ({ reqHeaders, contentLength, authorization }) => {
  // The webhook/oauth paths are UNAUTHENTICATED and gateway-bound: the
  // identity/scope strip must apply here exactly like the catch-all proxies,
  // or an anonymous POST could smuggle x-alphaclaw-user / x-openclaw-scopes
  // to a trusted-proxy gateway from loopback.
  const headers = sanitizeProxyHeaders(reqHeaders);
  // Client-controlled forwarded evidence must not reach the gateway from
  // this unauthenticated path either — same rule as the catch-all proxies.
  for (const evidenceHeader of kForwardedEvidenceHeaders) {
    delete headers[evidenceHeader];
  }
  delete headers.host;
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  headers["content-length"] = String(contentLength);
  if (authorization) headers.authorization = authorization;
  return headers;
};

// Hook ingress (fix wave F058/F211). /hooks and /webhook are UNAUTHENTICATED
// and gateway-bound. The old forwarder normalized the inbound pathname and
// sent it on, so `/hooks/../tools/invoke` (dot segments collapse in the URL
// parser, not in Express routing) reached arbitrary gateway HTTP endpoints,
// bypassing the /v1 enable gate and the bearer throttle. The path is now
// validated segment by segment from the RAW request-target and the gateway
// path is REBUILT from the validated segments — the inbound pathname itself
// never reaches the gateway.
//
//   raw target ─▶ split "/" ─▶ [hooks|webhook] ─▶ 1..3 segments, each:
//                                                  decode ONCE (bad % → 400)
//                                                  second decode must be a no-op
//                                                  not "." / ".."
//                                                  ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$
//              ─▶ gateway path = "/hooks/" + segments.map(encodeURIComponent)
//
// Sub-segments stay allowed (bounded, validated) so a hook URL with a nested
// route keeps working; a "/" or "\" smuggled through percent-encoding fails
// the character class.
const kHookSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const kMaxHookSegments = 3;

const resolveHookIngress = (rawUrl) => {
  const raw = String(rawUrl || "");
  const queryIndex = raw.indexOf("?");
  const rawPath = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const rawSegments = rawPath.split("/");
  if (rawSegments.length < 3 || rawSegments[0] !== "") {
    return { ok: false, status: 404, reason: "shape", rawPath };
  }
  const prefix = rawSegments[1];
  if (prefix !== "hooks" && prefix !== "webhook") {
    return { ok: false, status: 404, reason: "prefix", rawPath };
  }
  const tail = rawSegments.slice(2);
  if (tail.length > kMaxHookSegments) {
    return { ok: false, status: 404, reason: "too_many_segments", rawPath };
  }
  const segments = [];
  for (const rawSegment of tail) {
    if (!rawSegment) return { ok: false, status: 404, reason: "empty_segment", rawPath };
    let decoded;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return { ok: false, status: 400, reason: "bad_percent_encoding", rawPath };
    }
    let decodedTwice = null;
    try {
      decodedTwice = decodeURIComponent(decoded);
    } catch {}
    if (decodedTwice !== null && decodedTwice !== decoded) {
      return { ok: false, status: 404, reason: "double_encoded", rawPath };
    }
    if (decoded === "." || decoded === "..") {
      return { ok: false, status: 404, reason: "dot_segment", rawPath };
    }
    if (!kHookSegmentPattern.test(decoded)) {
      return { ok: false, status: 404, reason: "segment_chars", rawPath };
    }
    segments.push(decoded);
  }
  return {
    ok: true,
    hookName: segments[0],
    gatewayPath: `/hooks/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`,
    rawPath,
  };
};

// One structured, injection-safe audit line per rejection: control characters
// stripped and the path capped, never the query string (it can carry tokens).
const auditRejectedIngress = ({ reason, rawPath, sourceIp }) => {
  console.warn(
    `[hooks] rejected ingress reason=${reason} path=${JSON.stringify(
      sanitizeLabel(rawPath, { maxLength: 120 }),
    )} ip=${sourceIp || "unknown"}`,
  );
};

const resolveForwardMethod = (method) => {
  if (String(method || "").toUpperCase() === "GET") return "POST";
  return method;
};

const parseJsonSafe = (rawValue) => {
  try {
    return JSON.parse(String(rawValue || "").trim() || "{}");
  } catch {
    return null;
  }
};

const queryParamsToObject = (searchParams) => {
  const params = {};
  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const currentValue = params[key];
      if (Array.isArray(currentValue)) {
        currentValue.push(value);
      } else {
        params[key] = [currentValue, value];
      }
      continue;
    }
    params[key] = value;
  }
  return params;
};

const buildBodyFromQueryParams = ({ bodyBuffer, queryParams }) => {
  if (!queryParams || Object.keys(queryParams).length === 0) {
    return null;
  }

  if (bodyBuffer.length === 0) {
    return Buffer.from(JSON.stringify(queryParams), "utf8");
  }

  const parsedBody = parseJsonSafe(bodyBuffer.toString("utf8"));
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return null;
  }

  // Keep explicit body values authoritative when both are provided.
  const mergedBody = { ...queryParams, ...parsedBody };
  return Buffer.from(JSON.stringify(mergedBody), "utf8");
};

const getGmailPayloadData = (parsedBody) => {
  if (!parsedBody || typeof parsedBody !== "object") return null;
  if (parsedBody.payload && typeof parsedBody.payload === "object") {
    return parsedBody.payload;
  }
  return parsedBody;
};

const getGmailMessageId = (message = {}) => {
  const preferredId = String(message?.id || "").trim();
  if (preferredId) return preferredId;
  const fallbackId = String(message?.messageId || "").trim();
  return fallbackId;
};

const buildGmailDedupedBodyBuffer = ({ parsedBody, filteredMessages }) => {
  if (parsedBody?.payload && typeof parsedBody.payload === "object") {
    return Buffer.from(
      JSON.stringify({
        ...parsedBody,
        payload: {
          ...parsedBody.payload,
          messages: filteredMessages,
        },
      }),
      "utf8",
    );
  }
  return Buffer.from(
    JSON.stringify({
      ...(parsedBody || {}),
      messages: filteredMessages,
    }),
    "utf8",
  );
};

const createWebhookMiddleware = ({
  gatewayUrl,
  getGatewayUrl,
  insertRequest,
  maxPayloadBytes = 50 * 1024,
  gatewayTimeoutMs = kDefaultGatewayTimeoutMs,
}) => {
  const gmailSeenMessageIds = new Map();
  let lastGmailDedupeCleanupAt = 0;
  // Hooks that have proven durable ingress via the OpenClaw 2026.8
  // `x-openclaw-delivery-accepted: durable` response header. Once a hook has been
  // seen accepting durably, a later bare 200 (no header) means the update may NOT
  // have been stored before the ack — worth flagging on the Webhooks page. Telegram
  // webhook mode is the primary user of this; the latch is hook-agnostic so only
  // hooks that actually use durable ingress are ever checked.
  const durableCapableHooks = new Set();

  const pruneGmailSeenMessageIds = (nowMs) => {
    if (nowMs - lastGmailDedupeCleanupAt < kGmailDedupeCleanupIntervalMs) return;
    for (const [messageKey, seenAt] of gmailSeenMessageIds.entries()) {
      if (nowMs - seenAt > kGmailDedupeTtlMs) {
        gmailSeenMessageIds.delete(messageKey);
      }
    }
    lastGmailDedupeCleanupAt = nowMs;
  };

  return (req, res) => {
    const sourceIp = normalizeIp(
      req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
    );
    // Validate the ingress path FIRST, from the raw request-target, before any
    // URL normalization can collapse dot segments.
    const ingress = resolveHookIngress(req.originalUrl || req.url);
    if (!ingress.ok) {
      auditRejectedIngress({ reason: ingress.reason, rawPath: ingress.rawPath, sourceIp });
      return res
        .status(ingress.status)
        .json({ error: ingress.status === 400 ? "Bad Request" : "Not found" });
    }
    const hookName = ingress.hookName;
    const resolvedGatewayUrl =
      typeof getGatewayUrl === "function" ? getGatewayUrl() : gatewayUrl;
    const gateway = new URL(resolvedGatewayUrl);
    const protocolClient = gateway.protocol === "https:" ? https : http;
    let inboundUrl;
    try {
      inboundUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      auditRejectedIngress({ reason: "bad_url", rawPath: ingress.rawPath, sourceIp });
      return res.status(400).json({ error: "Bad Request" });
    }
    let tokenFromQuery = "";
    if (inboundUrl.searchParams.has("token")) {
      const tokenValue = String(inboundUrl.searchParams.get("token") || "");
      if (!req.headers.authorization) {
        tokenFromQuery = tokenValue;
      }
      inboundUrl.searchParams.delete("token");
    }

    let bodyBuffer = extractBodyBuffer(req);
    const queryBody = queryParamsToObject(inboundUrl.searchParams);
    const bodyWithQueryParams = buildBodyFromQueryParams({
      bodyBuffer,
      queryParams: queryBody,
    });
    if (bodyWithQueryParams) {
      bodyBuffer = bodyWithQueryParams;
    }
    if (hookName === "gmail" && bodyBuffer.length > 0) {
      const parsedBody = parseJsonSafe(bodyBuffer.toString("utf8"));
      const payloadData = getGmailPayloadData(parsedBody);
      const accountKey = String(
        payloadData?.account || payloadData?.email || payloadData?.inbox || "unknown",
      )
        .trim()
        .toLowerCase();
      const messages = Array.isArray(payloadData?.messages) ? payloadData.messages : [];
      if (messages.length > 0) {
        const nowMs = Date.now();
        pruneGmailSeenMessageIds(nowMs);
        const unseenMessages = [];
        for (const message of messages) {
          const messageId = getGmailMessageId(message);
          if (!messageId) {
            unseenMessages.push(message);
            continue;
          }
          const dedupeKey = `${accountKey}:${messageId}`;
          if (gmailSeenMessageIds.has(dedupeKey)) {
            continue;
          }
          gmailSeenMessageIds.set(dedupeKey, nowMs);
          unseenMessages.push(message);
        }
        if (unseenMessages.length === 0) {
          return res.status(200).json({ ok: true, deduped: true });
        }
        if (unseenMessages.length < messages.length && parsedBody) {
          bodyBuffer = buildGmailDedupedBodyBuffer({
            parsedBody,
            filteredMessages: unseenMessages,
          });
        }
      }
    }

    const sanitizedHeaders = sanitizeHeaders(req.headers);
    const payload = truncateText(sanitizePayloadForLogging(bodyBuffer), maxPayloadBytes);

    const gatewayHeaders = toGatewayRequestHeaders({
      reqHeaders: req.headers,
      contentLength: bodyBuffer.length,
      authorization: tokenFromQuery ? `Bearer ${tokenFromQuery}` : req.headers.authorization,
    });
    if (bodyWithQueryParams && !gatewayHeaders["content-type"]) {
      gatewayHeaders["content-type"] = "application/json";
    }

    const requestOptions = {
      protocol: gateway.protocol,
      hostname: gateway.hostname,
      port: gateway.port,
      method: resolveForwardMethod(req.method),
      // Rebuilt from the validated segments — never the inbound pathname.
      path: `${ingress.gatewayPath}${inboundUrl.search || ""}`,
      headers: gatewayHeaders,
    };

    // Exactly one request-log row per delivery, whichever path settles it:
    // gateway 'end', gateway error/timeout, upstream abort mid-body, or the
    // caller hanging up first (fix wave F151 — a stalled gateway used to park
    // the delivery forever with no row at all).
    let logged = false;
    const logRow = ({ gatewayStatus, gatewayBody }) => {
      if (logged) return;
      logged = true;
      try {
        insertRequest({
          hookName,
          method: req.method,
          headers: sanitizedHeaders,
          payload: payload.text,
          payloadTruncated: payload.truncated,
          payloadSize: bodyBuffer.length,
          sourceIp,
          gatewayStatus,
          gatewayBody,
        });
      } catch (err) {
        console.error("[webhook] failed to write request log:", err.message);
      }
    };

    const proxyReq = protocolClient.request(requestOptions, (proxyRes) => {
      const responseChunks = [];
      let responseSize = 0;
      let responseTruncated = false;

      proxyRes.on("aborted", () => {
        logRow({
          gatewayStatus: proxyRes.statusCode || 502,
          gatewayBody: "[UPSTREAM ABORTED] gateway closed the connection mid-response",
        });
        if (!res.writableEnded) res.destroy();
      });
      proxyRes.on("error", (err) => {
        logRow({
          gatewayStatus: proxyRes.statusCode || 502,
          gatewayBody: `[UPSTREAM ERROR] ${err.message || "gateway stream error"}`,
        });
        if (!res.writableEnded) res.destroy();
      });

      proxyRes.on("data", (chunk) => {
        if (!Buffer.isBuffer(chunk)) return;
        if (responseSize >= maxPayloadBytes) {
          responseTruncated = true;
          return;
        }
        const remaining = maxPayloadBytes - responseSize;
        if (chunk.length > remaining) {
          responseChunks.push(chunk.subarray(0, remaining));
          responseSize += remaining;
          responseTruncated = true;
          return;
        }
        responseChunks.push(chunk);
        responseSize += chunk.length;
      });

      proxyRes.on("end", () => {
        const responseText = Buffer.concat(responseChunks).toString("utf8");
        const gatewayBody = responseTruncated ? `${responseText}\n[TRUNCATED]` : responseText;
        // Durable-ingress assertion (observability only — the client response is
        // piped separately and is never altered).
        const status = proxyRes.statusCode || null;
        const durableAccepted =
          String(
            proxyRes.headers?.["x-openclaw-delivery-accepted"] || "",
          ).toLowerCase() === "durable";
        let annotatedBody = gatewayBody;
        if (durableAccepted) {
          durableCapableHooks.add(hookName);
        } else if (status === 200 && durableCapableHooks.has(hookName)) {
          annotatedBody = `[NOT DURABLY ACCEPTED] ${gatewayBody}`;
          console.warn(
            `[webhook] ${hookName}: gateway returned 200 without x-openclaw-delivery-accepted:durable (update may not have been stored before ack)`,
          );
        }
        logRow({ gatewayStatus: status, gatewayBody: annotatedBody });
      });

      res.statusCode = proxyRes.statusCode || 502;
      for (const [key, value] of Object.entries(proxyRes.headers || {})) {
        if (value == null) continue;
        // /hooks/* is unauthenticated, so the gateway must not be able to set a
        // cookie in the caller's browser or leak hop-by-hop headers (MW2).
        if (!shouldForwardResponseHeader(key)) continue;
        res.setHeader(key, value);
      }
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      const timedOut = err?.code === "ETIMEDOUT";
      const status = timedOut ? 504 : 502;
      logRow({
        gatewayStatus: status,
        gatewayBody: timedOut
          ? `gateway did not answer within ${gatewayTimeoutMs}ms`
          : err.message || "Gateway unavailable",
      });
      if (!res.headersSent) {
        res
          .status(status)
          .json({ error: timedOut ? "Gateway timeout" : "Gateway unavailable" });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });

    // A listening-but-stalled gateway must not park the delivery forever.
    proxyReq.setTimeout(gatewayTimeoutMs, () => {
      proxyReq.destroy(Object.assign(new Error("gateway timeout"), { code: "ETIMEDOUT" }));
    });

    // Caller hung up before the gateway answered: stop the upstream request
    // and record the delivery as abandoned (499, nginx's convention).
    res.on("close", () => {
      if (logged || res.writableEnded) return;
      proxyReq.destroy();
      logRow({
        gatewayStatus: 499,
        gatewayBody: "client closed the connection before the gateway answered",
      });
    });

    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  };
};

module.exports = { createWebhookMiddleware, resolveHookIngress };
