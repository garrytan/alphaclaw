const fs = require("fs");
const path = require("path");
const { ownerThreadBasisOf } = require("../../plugin/relay-guard/trust");

// A gateway restart the owner's own attested Capy thread asked for (GST-2323
// PR2): the relay guard refuses the raw call in the gateway and posts the
// relay message id to /relay/internal/gateway-restart (routes/relay.js).
// Who asked is decided here from the box's own records, never from the
// caller: the bridge's row for that message (relay/bridge.db) must be a
// running turn of the owner's attested thread (trust.js
// isAttestedDelegateMessage, the verdict the guards use per call), and the
// thread code comes from the binding the attestation verified
// (relay/remote.db). The restart then runs AlphaClaw's attributed ladder
// (routes/system.js requestGatewayRestart) with source relay:<thread code>.
// A pinned binding's turn (GST-2323 PR3) has no verified thread code, so its
// source is relay:<agent>, the pinned name.
const kMessageIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const kThreadCodePattern = /^[A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,9}$/;
const kPinnedAgentPattern = /^capy-[a-z0-9-]{1,43}$/;

const readOne = (file, sql, value, fsModule) => {
  if (!fsModule.existsSync(file)) return null;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).get(value) || null;
  } finally {
    db.close();
  }
};

// (messageId) => { statusCode, body }. Never throws for a refusal.
const createRelayRestartRequests = ({ rootDir, requestGatewayRestart, logger = console, fsModule = fs }) => (messageId) => {
  const id = typeof messageId === "string" ? messageId : "";
  if (!kMessageIdPattern.test(id)) return { statusCode: 400, body: { ok: false, code: "invalid_input" } };
  if (!rootDir || typeof requestGatewayRestart !== "function") return { statusCode: 503, body: { ok: false, code: "restart_unavailable" } };
  const relayDir = path.join(rootDir, "relay");
  const notOwner = { statusCode: 403, body: { ok: false, code: "not_owner_thread", error: "Only a running turn of the owner's own thread (attested or a pinned binding) can ask for a restart." } };
  let sender = null;
  let basis = null;
  let threadCode = null;
  try {
    sender = readOne(path.join(relayDir, "bridge.db"), "SELECT sender FROM relay_messages WHERE message_id = ?", id, fsModule)?.sender || null;
    basis = sender ? ownerThreadBasisOf({ rootDir, sender, messageId: id, fsModule }) : null;
    if (!basis) return notOwner;
    if (basis === "attested") {
      threadCode = readOne(path.join(relayDir, "remote.db"), "SELECT thread_code FROM relay_bindings WHERE agent = ?", String(sender).toLowerCase(), fsModule)?.thread_code || null;
    }
  } catch {
    return { statusCode: 503, body: { ok: false, code: "restart_unavailable" } };
  }
  const label = basis === "attested" ? threadCode : String(sender).toLowerCase();
  if (typeof label !== "string" || !(basis === "attested" ? kThreadCodePattern : kPinnedAgentPattern).test(label)) return notOwner;
  const source = "relay:" + label;
  const started = requestGatewayRestart({ actor: "relay", source, reason: "relay_message=" + id });
  if (started?.refusal) return { statusCode: started.refusal.statusCode || 409, body: { ...started.refusal.body, ok: false } };
  logger.log?.("[alphaclaw] relay: gateway restart asked by " + sender + " op=" + String(started.operationId || "").slice(0, 8) + " source=" + source + (started.attached ? " (attached to the running one)" : ""));
  return { statusCode: 202, body: { ok: true, operationId: started.operationId, attached: started.attached === true, source } };
};

module.exports = { createRelayRestartRequests };
