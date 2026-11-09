// Secret drop requests: one-time links that let a signed-in admin type a value
// into AlphaClaw instead of a chat. In memory only (a restart drops every
// open link; the agent can ask again). The link token is returned once, when
// the request is made, and only its sha256 is kept; a token is resolved by a
// constant-time compare against every live request. No value is ever held
// here: the save reads it from the request body and forgets it.
const crypto = require("crypto");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { classifySecretDropKey } = require("../utils/env-keys");

const kSecretDropTtlMs = 15 * 60 * 1000;
// A finished request stays readable (status only) this long after it ends.
const kSecretDropKeepMs = 60 * 60 * 1000;
const kSecretDropMaxOpen = 20;
const kSecretDropReasonMaxChars = 200;
const kSecretDropTokenPattern = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const createSecretDropRequests = ({ nowFn = () => Date.now(), randomBytes = crypto.randomBytes, ttlMs = kSecretDropTtlMs } = {}) => {
  const requests = new Map();

  const isOpen = (request) => request.status === "pending" || request.status === "partial";

  const sweep = () => {
    const now = nowFn();
    for (const [id, request] of requests) {
      if (isOpen(request) && now >= request.expiresAt) {
        request.status = request.status === "partial" ? "partial_expired" : "expired";
        request.endedAt = now;
      }
      if (!isOpen(request) && now - (request.endedAt ?? request.expiresAt) > kSecretDropKeepMs) requests.delete(id);
    }
  };

  const view = (request) => ({
    id: request.id,
    name: request.name,
    status: request.status,
    createdAt: new Date(request.createdAt).toISOString(),
    expiresAt: new Date(request.expiresAt).toISOString(),
    ...(request.stores ? { stores: { ...request.stores } } : {}),
    ...(request.reach ? { reach: request.reach } : {}),
  });

  const create = ({ name, reason = "", requestedBy = "unknown", requestContext = null }) => {
    sweep();
    const verdict = classifySecretDropKey(name);
    if (!verdict.ok) return { ok: false, code: verdict.reason, error: verdict.error };
    const open = [...requests.values()].filter(isOpen);
    if (open.length >= kSecretDropMaxOpen) {
      return { ok: false, code: "too_many_open", error: `${kSecretDropMaxOpen} secret links are already open; wait for one to be used or expire.` };
    }
    const now = nowFn();
    const token = randomBytes(32).toString("base64url");
    const request = {
      id: `sd_${randomBytes(9).toString("hex")}`,
      name,
      reason: String(reason || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, kSecretDropReasonMaxChars),
      requestedBy,
      requestContext: requestContext ? String(requestContext).slice(0, 256) : null,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
      tokenHash: sha256(token),
      csrf: randomBytes(24).toString("base64url"),
      stores: null,
      reach: null,
      endedAt: null,
    };
    requests.set(request.id, request);
    return { ok: true, token, request: view(request) };
  };

  // The live request a link token opens, or null (unknown, used, expired).
  const resolveToken = (token) => {
    sweep();
    if (typeof token !== "string" || !kSecretDropTokenPattern.test(token)) return null;
    const hash = sha256(token);
    let found = null;
    for (const request of requests.values()) {
      if (timingSafeStringEqual(request.tokenHash, hash) && isOpen(request)) found = request;
    }
    return found;
  };

  const get = (id) => {
    sweep();
    const request = requests.get(String(id || ""));
    return request ? view(request) : null;
  };

  // stored: both stores hold the value; the link is spent. partial: one
  // does; the link stays open until it expires so Retry can ask again.
  const finish = (id, { status, stores, reach }) => {
    const request = requests.get(id);
    if (!request) return null;
    request.stores = stores;
    request.reach = reach;
    request.status = status;
    if (status === "stored") {
      request.endedAt = nowFn();
      request.tokenHash = "";
    }
    return view(request);
  };

  return { create, resolveToken, get, finish, view };
};

module.exports = {
  createSecretDropRequests,
  kSecretDropTtlMs,
  kSecretDropTokenPattern,
};
