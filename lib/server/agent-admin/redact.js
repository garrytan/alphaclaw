const { isSensitiveKey } = require("../helpers");

const kMask = "••• (set)";

// Walks a JSON-ish body masking string leaves whose path matches a
// secretFields pattern ("vars.*", "credentials.clientSecret"). "*" matches
// one segment. Used for generic leaf masking; ops needing a structural
// transform (env.list's present/absent) use redactResponse instead.
const pathMatches = (pattern, pathSegments) => {
  const parts = pattern.split(".");
  if (parts.length !== pathSegments.length) return false;
  return parts.every((part, i) => part === "*" || part === pathSegments[i]);
};

const maskSecretFields = (body, secretFields) => {
  if (!Array.isArray(secretFields) || !secretFields.length) return body;
  const walk = (value, segments) => {
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, segments));
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        const nextSegments = [...segments, key];
        if (
          typeof child === "string" &&
          child &&
          secretFields.some((pattern) => pathMatches(pattern, nextSegments))
        ) {
          out[key] = kMask;
        } else {
          out[key] = walk(child, nextSegments);
        }
      }
      return out;
    }
    return value;
  };
  return walk(body, []);
};

// Audit summaries carry body KEYS only; secret-shaped values never land in
// the audit trail even as previews.
const summarizeParams = (body) => {
  if (!body || typeof body !== "object") return null;
  return { keys: Object.keys(body).slice(0, 32), redacted: true };
};

const applyOpRedaction = (op, body) => {
  let out = body;
  if (typeof op?.redactResponse === "function") {
    try {
      out = op.redactResponse(out);
    } catch {
      // Redactor bugs must fail CLOSED for the agent actor: better an empty
      // payload than a leaked secret.
      return { ok: true, redactionFailed: true };
    }
  }
  return maskSecretFields(out, op?.secretFields);
};

module.exports = { kMask, maskSecretFields, summarizeParams, applyOpRedaction, isSensitiveKey };
