const crypto = require("crypto");

// Enforcement grant (F067 / E8).
//
//   requireAuth ─▶ enforcement (agent actor only) ─▶ route handler
//                    │ manifest tier + confirm pass
//                    ▼
//         req[kEnforcementGrant] = frozen { opId, tier, method, path,
//                                           paramsDigest, bodyDigest, confirmId }
//                    │
//                    ▼
//         requireAdmin: human admin session → next()
//                       agent → grant present AND method/path/digests match → next()
//                       anything else → 403 admin_required
//
// The key is a module-private Symbol: middleware that runs BEFORE enforcement
// (or a forged plain property such as `req.alphaclawGrant`) cannot mint one,
// and a manifest error or a middleware reorder fails CLOSED because the grant
// is simply absent. The digests bind the grant to the exact query + body the
// tier decision was made against, so a handler chain that rewrites the body
// after enforcement does not inherit the decision.
const kEnforcementGrant = Symbol("alphaclaw.enforcementGrant");

const stableStringify = (value) => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
};

const digest = (value) =>
  crypto.createHash("sha256").update(stableStringify(value)).digest("hex");

const requestPath = (req) => `${req.baseUrl || ""}${req.path || ""}`;

const computeRequestDigests = (req) => ({
  paramsDigest: digest(req.query ?? null),
  bodyDigest: digest(req.body ?? null),
});

const attachEnforcementGrant = ({ req, op, tier, confirmId = null }) => {
  const { paramsDigest, bodyDigest } = computeRequestDigests(req);
  const grant = Object.freeze({
    opId: op.id,
    tier,
    method: req.method,
    path: requestPath(req),
    paramsDigest,
    bodyDigest,
    confirmId: confirmId || null,
  });
  Object.defineProperty(req, kEnforcementGrant, {
    value: grant,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return grant;
};

// Returns the grant only when it still describes THIS request; otherwise null.
const readEnforcementGrant = (req) => {
  const grant = req?.[kEnforcementGrant];
  if (!grant || typeof grant !== "object") return null;
  if (grant.method !== req.method) return null;
  if (grant.path !== requestPath(req)) return null;
  const { paramsDigest, bodyDigest } = computeRequestDigests(req);
  if (grant.paramsDigest !== paramsDigest) return null;
  if (grant.bodyDigest !== bodyDigest) return null;
  return grant;
};

module.exports = {
  attachEnforcementGrant,
  readEnforcementGrant,
  computeRequestDigests,
  stableStringify,
};
