const crypto = require("crypto");
const { RelayError } = require("./errors");
const { isValidRelayAgentName } = require("./config");
const { kMaxTextChars, kMaxLongTextChars } = require("./mcp-tools");
const { splitResult, kResultPartChars } = require("./bridge");
const { loadProvenanceKey, describePublicKey, signProvenance, verifyProvenance, kProvenanceClaimMs } = require("./provenance");

// Long messages in both directions and the owner-provenance statement
// (GST-2090 PR4).
//
// Box to a Capy thread: the box agent's relay_send and relay_reply reach
// prepareOutbound through POST /relay/internal/outbound (mcp-stdio.js). A text
// longer than kResultPartChars leaves as its first part with a result_ref;
// the thread reads the rest with relay_result, as it does for a long bridged
// answer. Only capy-* agents have relay_result, so any other recipient keeps
// the kMaxTextChars cap.
//
// A Capy thread to the box: remote-tools stores a text longer than
// kInboundPartChars here and the engine carries its first part with
// relay_long_ref; the bridge reads it whole before the box's run starts.
const kResultReaderPrefix = "capy-";
const kInboundPartChars = 12000;
const kProvenanceRefPattern = /^pv_[a-f0-9]{24}$/;

const longNotice = (parts, ref) =>
  "\n\n[Relay: this message has " + parts + " parts and this is part 1. Read parts 2-" + parts + " with relay_result, result_ref " + ref + ".]";
const inboundNotice = (length) => "\n\n[Relay: this message is " + length + " characters long; the box reads it whole.]";

const createRelayOutbound = ({ relayDir, getStore, getBoxAgentName, maskText = (text) => text, fsModule, now = Date.now, logger = console }) => {
  let key = null;
  const provenanceKey = () => {
    if (!key) key = loadProvenanceKey({ relayDir, ...(fsModule ? { fsModule } : {}) });
    return key;
  };
  const requireStore = () => {
    const store = getStore();
    if (!store) throw new RelayError("provisioning_pending");
    return store;
  };

  // { text, metadata, provenance } for one masked text the box agent sends.
  const prepareOutbound = ({ to, text, provenanceRef = null }) => {
    const recipient = String(to || "").trim().toLowerCase();
    if (!isValidRelayAgentName(recipient)) throw new RelayError("invalid_input", "to must be a relay agent name (a-z, 0-9 and -).");
    if (typeof text !== "string" || text.length > kMaxLongTextChars) throw new RelayError("invalid_input", "text is longer than " + kMaxLongTextChars + " characters.");
    const masked = String(maskText(text) ?? "");
    const pages = recipient.startsWith(kResultReaderPrefix);
    if (!pages && masked.length > kMaxTextChars) {
      throw new RelayError("invalid_input", "text is longer than " + kMaxTextChars + " characters; only a Capy thread (capy-...) reads a long message in parts.");
    }
    let out = masked;
    const metadata = {};
    if (pages && masked.length > kResultPartChars) {
      const parts = splitResult(masked);
      const ref = "rr_" + crypto.randomBytes(12).toString("hex");
      requireStore().saveResult({ ref, messageId: "box:" + ref, sender: recipient, lane: null, parts });
      out = parts[0] + longNotice(parts.length, ref);
      metadata.relay_result_ref = ref;
      metadata.relay_result_parts = parts.length;
    }
    let provenance = false;
    if (typeof provenanceRef === "string" && kProvenanceRefPattern.test(provenanceRef)) {
      const store = getStore();
      const claim = store ? store.claimProvenance(provenanceRef, kProvenanceClaimMs) : null;
      if (claim) {
        metadata.relay_provenance = signProvenance({ key: provenanceKey(), claim, from: getBoxAgentName() || null, to: recipient, text: out, maskText, now: now() });
        provenance = true;
        logger.log?.("[relay] owner provenance signed for a message to " + recipient + " (telegram message " + String(claim.messageId).slice(0, 32) + ")");
      } else {
        logger.warn?.("[relay] owner provenance not signed for a message to " + recipient + ": the claim was spent, expired or unknown");
      }
    }
    return { text: out, metadata, provenance };
  };

  // A remote agent's text to the box: the first part for the engine and the
  // ref the bridge reads it whole by. Shorter texts go as they are.
  const prepareInbound = ({ sender, text }) => {
    if (text.length <= kInboundPartChars) return { text, metadata: {} };
    const ref = "rl_" + crypto.randomBytes(12).toString("hex");
    requireStore().saveLongMessage({ ref, sender, text });
    return { text: text.slice(0, kInboundPartChars) + inboundNotice(text.length), metadata: { relay_long_ref: ref } };
  };

  // The owner_provenance relay_history shows: the statement, whether it
  // verifies against this box's key and this message's text, and the signed
  // envelope for a check of your own. Only the box agent's messages count.
  const readProvenance = (message) => {
    if (!message?.metadata?.relay_provenance || message.agent_name !== getBoxAgentName()) return null;
    const envelope = message.metadata.relay_provenance;
    const { verified, payload } = verifyProvenance({ key: provenanceKey(), envelope, text: String(message.text ?? "") });
    return { verified, statement: payload, signed: envelope };
  };

  return { prepareOutbound, prepareInbound, readProvenance, publicKey: () => describePublicKey(provenanceKey()) };
};

module.exports = { createRelayOutbound, kInboundPartChars, kProvenanceRefPattern };
