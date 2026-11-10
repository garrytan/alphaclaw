const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeFileAtomic } = require("../utils/safe-file");

// Owner provenance (GST-2090 PR4). When the box agent sends a relay message
// during a turn the owner started on Telegram, the relay guard records which
// Telegram message started that turn (relay-guard/provenance.js) and AlphaClaw
// signs a statement of it with the relay's own Ed25519 key, carried on the
// relay message as metadata.relay_provenance. A Capy thread can then act on
// "Garry said X" without checking at the source.
//
// What it proves: the box received that Telegram message (chat, topic,
// message id, sender id) from a sender OpenClaw counted as the owner, with
// that text (sha256 and the masked quote), and the relay message it is
// attached to carried exactly this text (relay_text_sha256). What it does
// not prove: that the agent's own words in the relay message say what the
// owner meant. Anything with a shell on the box can read the key, so it
// steers honest agents and leaves an audit trail; it is not a wall against
// the box itself.
const kProvenanceKeyFile = "provenance-key.json";
const kProvenanceVersion = 1;
const kProvenanceClaimMs = 10 * 60 * 1000;
const kMaxQuoteChars = 2000;

const sha256Hex = (text) => crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

const keyIdOf = (publicKey) => sha256Hex(publicKey.export({ type: "spki", format: "der" }).toString("base64")).slice(0, 16);

// The relay's signing key (relay/provenance-key.json, 0600), made on first use.
const loadProvenanceKey = ({ relayDir, fsModule = fs }) => {
  const file = path.join(relayDir, kProvenanceKeyFile);
  let stored = null;
  try {
    stored = JSON.parse(fsModule.readFileSync(file, "utf8"));
  } catch {}
  if (!stored?.privateKeyPem) {
    const pair = crypto.generateKeyPairSync("ed25519");
    stored = { version: 1, privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }) };
    writeFileAtomic(file, JSON.stringify(stored, null, 2) + "\n", { fsModule, mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(stored.privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, kid: keyIdOf(publicKey) };
};

const describePublicKey = ({ publicKey, kid }) => ({
  alg: "Ed25519",
  kid,
  public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
  public_key_jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" },
});

// claim: the row the guard wrote (bridge-store claimProvenance). text: the
// relay message exactly as it leaves the box (masked, first part included).
const signProvenance = ({ key, claim, from, to, text, maskText = (value) => value, now = Date.now() }) => {
  const payload = JSON.stringify({
    v: kProvenanceVersion,
    kind: "owner_message",
    channel: claim.channel,
    account_id: claim.accountId,
    conversation_id: claim.conversationId,
    thread_id: claim.threadId,
    message_id: claim.messageId,
    sender_id: claim.senderId,
    sender_is_owner: true,
    text_sha256: claim.textSha256,
    quote: String(maskText(String(claim.quote || "")) ?? "").slice(0, kMaxQuoteChars),
    received_at: claim.receivedAt ? new Date(claim.receivedAt).toISOString() : null,
    from,
    to,
    relay_text_sha256: sha256Hex(text),
    signed_at: new Date(now).toISOString(),
  });
  return { v: kProvenanceVersion, alg: "Ed25519", kid: key.kid, payload, sig: b64url(crypto.sign(null, Buffer.from(payload, "utf8"), key.privateKey)) };
};

// { verified, payload } for an envelope carried on a relay message. text is
// the relay message's text, which must be the one the signature names.
const verifyProvenance = ({ key, envelope, text = null }) => {
  try {
    if (!envelope || typeof envelope !== "object" || envelope.alg !== "Ed25519" || envelope.kid !== key.kid) return { verified: false, payload: null };
    if (typeof envelope.payload !== "string" || typeof envelope.sig !== "string") return { verified: false, payload: null };
    const ok = crypto.verify(null, Buffer.from(envelope.payload, "utf8"), key.publicKey, Buffer.from(envelope.sig, "base64url"));
    const payload = JSON.parse(envelope.payload);
    const textMatches = text === null || payload?.relay_text_sha256 === sha256Hex(text);
    return { verified: Boolean(ok && textMatches), payload };
  } catch {
    return { verified: false, payload: null };
  }
};

module.exports = {
  kProvenanceKeyFile,
  kProvenanceClaimMs,
  kMaxQuoteChars,
  sha256Hex,
  loadProvenanceKey,
  describePublicKey,
  signProvenance,
  verifyProvenance,
};
