const crypto = require("crypto");

// Signed liaison-key requests (GST-2323 PR4). A liaison machine holds an
// Ed25519 private key in a 0600 file (scripts/relay-client.mjs keygen); the
// box holds only the public key, from ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS
// (deployment env only). Each request to POST /relay/key/call is signed over
// its method, path, agent, timestamp, nonce and body hash, accepted only
// within kKeyWindowMs of its timestamp and only once per nonce
// (remote.db relay_key_nonces), so nothing the box stores or logs can be
// replayed and no secret travels in a tool argument or a transcript.
const kKeyPath = "/relay/key/call";
const kKeyContentType = "application/vnd.alphaclaw.relay-key+json";
const kKeyWindowMs = 5 * 60 * 1000;
const kKeyTools = Object.freeze(["relay_send", "relay_history", "relay_result", "relay_renew"]);
const kNoncePattern = /^[A-Za-z0-9_-]{22,64}$/;
const kTimestampPattern = /^\d{13}$/;
const kSignaturePattern = /^[A-Za-z0-9_-]{86}$/;
const kAgentPattern = /^capy-[a-z0-9-]{1,43}$/;

// The bytes a liaison key signs. scripts/relay-client.mjs builds the same
// string; it is a wire contract, so both change together.
const keySigningInput = ({ method, path, agent, timestamp, nonce, bodyHash }) =>
  ["alphaclaw-relay-key-v1", method, path, agent, timestamp, nonce, bodyHash].join("\n");

const refuse = (code, message) => ({ ok: false, code, message });

// { ok: true, agent, fingerprint } or { ok: false, code, message }.
// keys: config().trustedBindingKeys. useNonce(nonce, agent, expiresAt) is
// true only the first time; it runs only after the signature checks out, so
// unsigned requests cannot fill the table.
const verifyKeyRequest = ({ method, path, headers = {}, rawBody, keys = {}, useNonce, now = Date.now() }) => {
  const agent = String(headers["x-relay-agent"] || "").trim().toLowerCase();
  const timestamp = String(headers["x-relay-timestamp"] || "");
  const nonce = String(headers["x-relay-nonce"] || "");
  const signature = String(headers["x-relay-signature"] || "");
  if (!kAgentPattern.test(agent) || !kTimestampPattern.test(timestamp) || !kNoncePattern.test(nonce) || !kSignaturePattern.test(signature)) {
    return refuse("key_auth_malformed", "A liaison-key request needs x-relay-agent, x-relay-timestamp, x-relay-nonce and x-relay-signature.");
  }
  const key = Object.hasOwn(keys, agent) ? keys[agent] : null;
  if (!key) return refuse("key_not_registered", "No liaison key is registered for " + agent + " on this box.");
  if (Math.abs(now - Number(timestamp)) > kKeyWindowMs) return refuse("key_auth_stale", "The request's timestamp is more than 5 minutes from the box's clock.");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  let valid = false;
  try {
    const publicKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey }, format: "jwk" });
    valid = crypto.verify(null, Buffer.from(keySigningInput({ method, path, agent, timestamp, nonce, bodyHash }), "utf8"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return refuse("key_auth_invalid", "The signature does not match the liaison key registered for " + agent + ".");
  if (!useNonce(nonce, agent, Number(timestamp) + kKeyWindowMs)) return refuse("key_auth_replayed", "This request was already accepted once.");
  return { ok: true, agent, fingerprint: key.fingerprint };
};

module.exports = { verifyKeyRequest, keySigningInput, kKeyPath, kKeyContentType, kKeyWindowMs, kKeyTools };
