const { isSensitiveKey } = require("../helpers");
const { redactSecretShapes, scrubTokenParams, stripControlChars } = require("../utils/redact");

const { kMask } = require("./constants");

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

// Free-text error hygiene for the AGENT actor (critic gap, PR 3). Route
// handlers hand `err.message` straight to the envelope, which is right for the
// dashboard but lets an agent transcript collect execSync command lines,
// absolute paths and the occasional token-shaped substring. For 5xx the text is
// replaced with a fixed sentence (the `code`/`hint` fields, which drive the
// agent's next action, are untouched); for 4xx the message is the agent's
// validation feedback, so it is kept but scrubbed of secret shapes, `token=`
// query params, control characters, and clamped.
const kAgentErrorMaxLength = 400;
const kGenericServerError = "The server could not complete the operation (details are in the server log).";

const scrubAgentErrorText = (text) =>
  stripControlChars(redactSecretShapes(scrubTokenParams(String(text)))).slice(
    0,
    kAgentErrorMaxLength,
  );

const sanitizeAgentErrorBody = (body, statusCode) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (typeof body.error !== "string" || !body.error) return body;
  const status = Number(statusCode) || 200;
  if (status < 400) return body;
  if (status >= 500) {
    return { ...body, error: kGenericServerError };
  }
  return { ...body, error: scrubAgentErrorText(body.error) };
};

module.exports = {
  kMask,
  kGenericServerError,
  maskSecretFields,
  summarizeParams,
  applyOpRedaction,
  sanitizeAgentErrorBody,
  isSensitiveKey,
};
