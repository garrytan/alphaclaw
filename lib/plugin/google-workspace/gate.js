// The one owner check behind both the tool factories and before_tool_call:
// Google Workspace runs only on the owner's own turns. A relay session is
// decided only by relay-guard's owner-thread verdict, from the box's relay
// records (an attested owner thread or a pinned binding, re-checked for the
// message itself), never by senderIsOwner, because every delegate's turn
// runs over the gateway's admin connection. Any other session needs
// OpenClaw's host-derived senderIsOwner === true. Fails closed.
const policy = require("../relay-guard/policy");
const { resolveRelayTrust, isOwnerThreadMessage } = require("../relay-guard/trust");

const ownerOf = ({ rootDir, sessionKey, runId, senderIsOwner } = {}) => {
  const kind = policy.classifyCall({ sessionKey, runId });
  const bySender = () => (senderIsOwner === true ? { owner: true, basis: "sender" } : { owner: false, reason: "not_owner" });
  if (kind === "other") return bySender();
  let trust;
  try {
    trust = resolveRelayTrust({ rootDir, sessionKey, runId, requireTrustedOwner: true });
  } catch {
    return { owner: false, reason: "relay_check_failed" };
  }
  if (kind === "unknown" && trust.tier === "none") return bySender();
  try {
    if (trust.tier === "delegate" && trust.ownerThread === true && isOwnerThreadMessage({ rootDir, sender: trust.sender, messageId: trust.messageId })) {
      return { owner: true, basis: "relay_owner_thread" };
    }
  } catch {
    return { owner: false, reason: "relay_check_failed" };
  }
  return { owner: false, reason: "relay_not_owner_thread" };
};

module.exports = { ownerOf };
