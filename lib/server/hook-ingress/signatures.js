// Pure per-sender signature verifiers for the /hooks edge (GST-2134 PR 2,
// D4/D6). No I/O: the caller passes the configured secret, the exact body
// bytes and the lower-cased request headers. A verified delivery also names
// the sender's own signature headers, forwarded unchanged so a transform that
// checks the signature again still can. Every preset runs through one
// HMAC-SHA256 helper; digests are compared with timingSafeStringEqual
// (tests/server/guards/secret-compare.guard.test.js keeps direct
// crypto.timingSafeEqual out of lib/). Sources for each scheme are cited in
// tests/server/hook-ingress-signatures.test.js.
const crypto = require("crypto");
const { timingSafeStringEqual } = require("../utils/timing-safe");

const kSignedPresets = Object.freeze(["standard_webhooks", "circleback", "quo", "verkada"]);
const kDefaultToleranceMs = 5 * 60 * 1000;
const kStandardWebhooksKeyPrefix = "whsec_";
const kMinDecodedKeyBytes = 16;
const kMaxSecretChars = 512;
const kBase64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const kHexPattern = /^[0-9a-fA-F]+$/;
const kSecondsPattern = /^\d{1,12}$/;
const kMillisecondsPattern = /^\d{1,15}$/;

const fail = (reason) => ({ ok: false, reason });

const hmacSha256 = (hmacKey, { encoding, parts }) =>
  crypto
    .createHmac("sha256", hmacKey)
    .update(Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8")))))
    .digest(encoding);

const decodeStrictBase64 = (value) => {
  if (typeof value !== "string" || !kBase64Pattern.test(value)) return null;
  if (value.endsWith("=") && value.length % 4 !== 0) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return null;
  return decoded;
};

const validateBase64Key = (encoded) => {
  const decoded = decodeStrictBase64(encoded);
  if (!decoded) return fail("not_base64");
  if (decoded.length < kMinDecodedKeyBytes) return fail("too_short");
  return { ok: true, key: decoded };
};

const resolveKey = (preset, secret) => {
  if (typeof secret !== "string" || !secret) return fail("missing");
  if (secret.length > kMaxSecretChars) return fail("too_long");
  if (/\s/.test(secret)) return fail("whitespace");
  if (preset === "standard_webhooks") {
    if (!secret.startsWith(kStandardWebhooksKeyPrefix)) return fail("missing_prefix");
    return validateBase64Key(secret.slice(kStandardWebhooksKeyPrefix.length));
  }
  if (preset === "quo") {
    const bare = secret.startsWith(kStandardWebhooksKeyPrefix)
      ? secret.slice(kStandardWebhooksKeyPrefix.length)
      : secret;
    return validateBase64Key(bare);
  }
  if (preset === "circleback" || preset === "verkada") return { ok: true, key: Buffer.from(secret, "utf8") };
  return fail("unknown_preset");
};

const validateSecret = (preset, secret) => {
  const resolved = resolveKey(preset, secret);
  return resolved.ok ? { ok: true } : resolved;
};

const readHeader = (headers, name, { joinWith = null } = {}) => {
  if (!headers || typeof headers !== "object" || !Object.prototype.hasOwnProperty.call(headers, name)) {
    return { value: "" };
  }
  const raw = headers[name];
  if (typeof raw === "string") return { value: raw.trim() };
  if (!Array.isArray(raw)) return { value: "" };
  const values = raw.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
  if (values.length <= 1) return { value: values[0] || "" };
  if (joinWith !== null) return { value: values.join(joinWith) };
  return { conflict: true };
};

const isStale = ({ timestampMs, nowMs, toleranceMs }) => Math.abs(nowMs - timestampMs) > toleranceMs;

const parseStandardWebhooks = (headers) => {
  const signature = readHeader(headers, "webhook-signature", { joinWith: " " });
  if (!signature.value) return fail("missing_signature");
  const id = readHeader(headers, "webhook-id");
  const timestamp = readHeader(headers, "webhook-timestamp");
  if (id.conflict || timestamp.conflict || !id.value || !kSecondsPattern.test(timestamp.value)) {
    return fail("malformed");
  }
  const signatures = signature.value
    .split(/\s+/)
    .map((entry) => entry.split(","))
    .filter(([version, encoded, ...rest]) => version === "v1" && rest.length === 0 && decodeStrictBase64(encoded))
    .map(([, encoded]) => encoded);
  if (signatures.length === 0) return fail("malformed");
  return {
    ok: true,
    signatures,
    timestamp: timestamp.value,
    timestampMs: Number(timestamp.value) * 1000,
    id: id.value,
  };
};

const parseQuoLegacy = (headers) => {
  const header = readHeader(headers, "openphone-signature");
  if (header.conflict) return fail("malformed");
  if (!header.value) return fail("missing_signature");
  const fields = header.value.split(";");
  if (fields.length !== 4) return fail("malformed");
  const [scheme, version, timestamp, digest] = fields;
  if (scheme !== "hmac" || version !== "1" || !kMillisecondsPattern.test(timestamp) || !decodeStrictBase64(digest)) {
    return fail("malformed");
  }
  return { ok: true, signatures: [digest], timestamp, timestampMs: Number(timestamp) };
};

const parseCircleback = (headers) => {
  const header = readHeader(headers, "x-signature");
  if (header.conflict) return fail("malformed");
  if (!header.value) return fail("missing_signature");
  if (!kHexPattern.test(header.value)) return fail("malformed");
  return { ok: true, signatures: [header.value.toLowerCase()], timestampMs: null };
};

const parseVerkada = (headers) => {
  const header = readHeader(headers, "verkada-signature");
  if (header.conflict) return fail("malformed");
  if (!header.value) return fail("missing_signature");
  const fields = header.value.split("|");
  if (fields.length !== 2) return fail("malformed");
  const [timestamp, hex] = fields;
  if (!kSecondsPattern.test(timestamp) || !kHexPattern.test(hex)) return fail("malformed");
  return { ok: true, signatures: [hex.toLowerCase()], timestamp, timestampMs: Number(timestamp) * 1000 };
};

const standardWebhooksScheme = (scheme) => ({
  scheme,
  encoding: "base64",
  parse: parseStandardWebhooks,
  forwardHeaders: ["webhook-signature"],
  signedParts: ({ parsed, rawBody }) => [`${parsed.id}.${parsed.timestamp}.`, rawBody],
  describe: ({ parsed }) => ({
    replayKey: parsed.id,
    deliveryId: parsed.id,
    signedHeaders: { "webhook-id": parsed.id, "webhook-timestamp": parsed.timestamp },
  }),
});

const kSchemes = Object.freeze({
  standard_webhooks: standardWebhooksScheme("standard_webhooks"),
  quo: standardWebhooksScheme("quo"),
  quo_legacy: {
    scheme: "quo_legacy",
    encoding: "base64",
    parse: parseQuoLegacy,
    forwardHeaders: ["openphone-signature"],
    signedParts: ({ parsed, rawBody }) => [`${parsed.timestamp}.`, rawBody],
    describe: ({ matched }) => ({ replayKey: matched, deliveryId: null, signedHeaders: {} }),
  },
  circleback: {
    scheme: "circleback",
    encoding: "hex",
    parse: parseCircleback,
    forwardHeaders: ["x-signature"],
    signedParts: ({ rawBody }) => [rawBody],
    describe: ({ matched }) => ({ replayKey: matched, deliveryId: null, signedHeaders: {} }),
  },
  verkada: {
    scheme: "verkada",
    encoding: "hex",
    parse: parseVerkada,
    forwardHeaders: ["verkada-signature"],
    signedParts: ({ parsed, rawBody }) => [rawBody, `|${parsed.timestamp}`],
    describe: ({ parsed, matched }) => ({
      replayKey: matched,
      deliveryId: null,
      signedHeaders: { "webhook-timestamp": parsed.timestamp },
    }),
  },
});

const selectScheme = (preset, headers) => {
  if (preset !== "quo") return kSchemes[preset];
  return readHeader(headers, "webhook-signature", { joinWith: " " }).value ? kSchemes.quo : kSchemes.quo_legacy;
};

const verifySignedDelivery = ({
  preset,
  secret,
  rawBody,
  headers,
  nowMs,
  toleranceMs = kDefaultToleranceMs,
} = {}) => {
  if (!kSignedPresets.includes(preset)) return fail("malformed");
  const resolved = resolveKey(preset, secret);
  if (!resolved.ok) return fail("no_secret");
  if (!Buffer.isBuffer(rawBody) || !Number.isFinite(nowMs) || !Number.isFinite(toleranceMs) || toleranceMs < 0) {
    return fail("malformed");
  }
  const definition = selectScheme(preset, headers);
  const parsed = definition.parse(headers);
  if (!parsed.ok) return parsed;
  const expected = hmacSha256(resolved.key, {
    encoding: definition.encoding,
    parts: definition.signedParts({ parsed, rawBody }),
  });
  const matched = parsed.signatures.find((presented) => timingSafeStringEqual(presented, expected));
  if (!matched) return fail("bad_signature");
  if (parsed.timestampMs !== null && isStale({ timestampMs: parsed.timestampMs, nowMs, toleranceMs })) {
    return fail("stale_timestamp");
  }
  const described = definition.describe({ parsed, matched });
  const forwarded = Object.fromEntries(
    definition.forwardHeaders.map((name) => [name, readHeader(headers, name, { joinWith: " " }).value]),
  );
  return { ok: true, scheme: definition.scheme, ...described, signedHeaders: { ...described.signedHeaders, ...forwarded } };
};

module.exports = {
  hmacSha256,
  kSignedPresets,
  validateSecret,
  verifySignedDelivery,
};
