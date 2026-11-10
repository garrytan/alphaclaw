const fs = require("fs");
const path = require("path");
const { resolveGrant, attestationVerdict, principalKeyFor, principalKeyForClient } = require("./grants");

// The one answer to "is this relay call the owner's delegate?" (GST-1982).
// The relay guard calls it on every relay tool call, and Wintermute's own
// guard requires this file by path, so both guards read the same source:
// the bridge's row for the run (relay/bridge.db: the tier the bridge
// stamped right before chat.send, and the approval the message carried) and
// the binding's liveness now (relay/remote.db). Both databases are opened
// read-only. Anything missing, unreadable or unexpected is the peer tier.
//
// A delegate is owner-equivalent on the box: its turn has exec as the
// gateway's user, so these files are not out of its reach. The gates are the
// owner's grants (relay_grants in remote.db, GST-2090) and that a revoke ends
// the running turn; see docs/designs/agent-relay.md, "Delegates" and
// "Grants".
//
// Per call it checks only what can change under a running turn: the grant
// the bridge stamped on the row is still live, and the binding is still
// live. An identity's freshness is checked once, when the message is
// accepted, never again mid-turn; a handoff fences only messages not yet
// dispatched (bridge.js), never a turn already running.
const kRelaySessionPattern = /^agent:[^:]+:relay-/i;
const kRelayRunPrefix = "relay-";
const kActiveStates = Object.freeze(["dispatched", "completing", "reconciling"]);

// Pure: why a binding is or is not a live delegate. delegateAgents null
// skips the list check (the bridge applied it when it stamped the row).
// The list names agents, not OAuth clients: every thread of one Capy
// account binds through the same client, reviewers and outside-PR readers
// included, while an agent name is random and only the thread holding its
// capability can bind it again.
const classifyBinding = ({ binding, client, delegateAgents = null, now = Date.now() }) => {
  if (!binding) return { trust: "peer", reason: "not_bound" };
  if (Array.isArray(delegateAgents) && !delegateAgents.length) return { trust: "peer", reason: "delegates_off" };
  if (Array.isArray(delegateAgents) && !delegateAgents.includes(String(binding.agent || "").toLowerCase())) return { trust: "peer", reason: "agent_not_delegate" };
  if (!client || client.revokedAt || !client.consentedAt) return { trust: "peer", reason: "client_revoked" };
  if (binding.deadAt) return { trust: "peer", reason: "binding_dead" };
  if (!(Number(binding.until) > now)) return { trust: "peer", reason: "binding_expired" };
  return { trust: "delegate", reason: "delegate" };
};

// A remote.db from before grants has no relay_grants table: no grant rows,
// so the env-list fallback decides, exactly as before the upgrade.
const readGrants = (remote, agent, clientId) => {
  try {
    return remote
      .prepare("SELECT * FROM relay_grants WHERE principal_key IN (?, ?)")
      .all(principalKeyFor(agent), principalKeyForClient(clientId))
      .map((row) => ({
        id: row.id,
        tier: row.tier,
        principalKind: row.principal_kind,
        principal: parseJson(row.principal),
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        lanesMax: row.lanes_max,
        hourlyCap: row.hourly_cap,
        requireRoute: row.require_route,
      }));
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ""))) return [];
    throw error;
  }
};

const parseJson = (raw) => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

// GST-2323: the run is an attested delegate's only when the bridge stamped
// the org and thread owner it verified (attested_org and attested_owner,
// checked against the deployment env at dispatch) and the binding still
// holds that verified attestation for that owner, under a live Capy grant,
// at the generation the message was sent under. A handoff, a revoke or a
// changed binding mid-turn ends it on the next call. owner is the binding's
// recorded user claim (the thread's owner), or null.
const attestationOfRun = (row, binding, grants) => {
  const claims = binding ? parseJson(binding.attested_claims) : null;
  const owner = typeof claims?.user === "string" && claims.user ? claims.user : null;
  if (!binding || !claims) return { attested: false, reason: "not_attested", owner };
  if (typeof row.attested_org !== "string" || !row.attested_org || typeof row.attested_owner !== "string" || !row.attested_owner) {
    return { attested: false, reason: "owner_not_trusted", owner };
  }
  if (!Number.isInteger(row.binding_generation) || row.binding_generation !== Number(binding.generation)) return { attested: false, reason: "generation_stale", owner };
  const verdict = attestationVerdict({
    binding: { clientId: binding.client_id, threadCode: binding.thread_code, attestedClaims: claims },
    grants,
    org: row.attested_org,
    owners: [row.attested_owner],
  });
  return { attested: verdict.attested === true, reason: verdict.reason, owner };
};

// GST-2323 PR3: the run is a pinned binding's only when the bridge found
// the sender on ALPHACLAW_RELAY_TRUSTED_BINDINGS at dispatch and stamped it
// (pinned_binding), the sender is still a live delegate through a live grant
// of its own (verdict, never the env-list fallback), and the binding is at
// the generation the message was sent under. No identity is checked here:
// trust rests on the binding's capability. A removed binding, a revoked
// client or grant, or a handoff ends it on the next call.
//
// GST-2323 PR4: a row stamped pin_requires_attestation is pinned only while
// the run is also attested (attestation, attestationOfRun's verdict for the
// same call), so a revoked Capy grant or a handoff to an unattested holder
// ends the pin too.
const pinnedOfRun = (row, binding, verdict, agent, attestation = null) => {
  if (!binding || typeof row.pinned_binding !== "string" || row.pinned_binding.toLowerCase() !== agent) return false;
  if (row.pin_requires_attestation === 1 && attestation?.attested !== true) return false;
  if (verdict.trust !== "delegate" || verdict.reason !== "grant" || !verdict.grantId) return false;
  return Number.isInteger(row.binding_generation) && row.binding_generation === Number(binding.generation);
};

const parseApproval = (raw) => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && Array.isArray(value.targets) ? value : null;
  } catch {
    return null;
  }
};

const openReadOnly = (file, fsModule) => {
  if (!fsModule.existsSync(file)) return null;
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
};

const peer = (reason, extra = {}) => ({ tier: "peer", reason, approval: null, ownerThread: false, ...extra });

// fallbackAgents: ALPHACLAW_RELAY_DELEGATE_AGENTS as the relay guard's plugin
// config carries it, read only for an agent with no grant row at all (one
// release, then removed). delegateAgents, when a caller passes a list, can
// only narrow: an agent not on it is a peer. null (the default, and what the
// relay guard and wm-guards pass) leaves the decision to the grants.
//
// GST-2323 adds, for a delegate: attested (true only for a Capy-attested
// thread whose owner is on ALPHACLAW_RELAY_CAPY_OWNERS, which the bridge
// checked at dispatch; such a run's high-risk calls need no confirmation),
// attestationReason (why not: not_attested, owner_not_trusted,
// generation_stale, attestation_org, not_capy_connection, ...) and owner
// (the binding's recorded Capy user id, or null). GST-2323 PR3 adds
// ownerThread (true for an attested delegate or a pinned binding: the
// owner's own thread, whose high-risk calls need no confirmation) and
// pinnedBinding (the agent name when the binding is pinned; attested stays
// false and attestationReason is pinned_binding, since no identity was
// checked). requireTrustedOwner: true narrows the tier itself: any delegate
// that is not the owner's own thread that way is a peer with reason
// owner_not_trusted. The default keeps the tier as before.
const resolveRelayTrust = ({ rootDir, sessionKey, runId, delegateAgents = null, fallbackAgents = null, requireTrustedOwner = false, now = Date.now(), fsModule = fs } = {}) => {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const run = typeof runId === "string" ? runId.trim() : "";
  const relayCall = kRelaySessionPattern.test(key) || run.startsWith(kRelayRunPrefix);
  const unattributed = !key && !run;
  if (!relayCall && !unattributed) return { tier: "none", reason: "not_relay", approval: null };
  const relayDir = path.join(String(rootDir || ""), "relay");
  const bridge = openReadOnly(path.join(relayDir, "bridge.db"), fsModule);
  if (!bridge) return relayCall ? peer("no_bridge") : { tier: "none", reason: "no_bridge", approval: null };
  let remote = null;
  try {
    const placeholders = kActiveStates.map(() => "?").join(", ");
    const liveness = (row) => {
      if (row.trust !== "delegate") return { trust: "peer", reason: "peer" };
      remote = remote || openReadOnly(path.join(relayDir, "remote.db"), fsModule);
      if (!remote) return { trust: "peer", reason: "not_bound" };
      const agent = String(row.sender).toLowerCase();
      const binding = remote.prepare("SELECT * FROM relay_bindings WHERE agent = ?").get(agent);
      const client = binding ? remote.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(binding.client_id) : null;
      const grants = binding ? readGrants(remote, agent, binding.client_id) : [];
      // A caller with no env list (wm-guards) takes the bridge's stamp for an
      // agent with no grant row at all, as before grants; any grant row,
      // a revoked one included, decides instead.
      const verdict = resolveGrant({
        binding: binding ? { agent: binding.agent, clientId: binding.client_id, until: binding.until_at, deadAt: binding.dead_at } : null,
        client: client ? { revokedAt: client.revoked_at, consentedAt: client.consented_at } : null,
        grants,
        fallbackAgents: Array.isArray(fallbackAgents) ? fallbackAgents : [agent],
        narrowTo: delegateAgents,
        now,
      });
      if (verdict.trust !== "delegate") return verdict;
      // The grant the bridge stamped on this row must still be live: a
      // revoke ends every turn it admitted, on every lane, even when another
      // live grant names the same agent.
      if (row.grant_id) {
        const stamped = grants.find((grant) => grant.id === row.grant_id);
        if (!stamped || stamped.revokedAt) return { trust: "peer", reason: "grant_revoked" };
      }
      const attestation = attestationOfRun(row, binding, grants);
      const pinned = pinnedOfRun(row, binding, verdict, agent, attestation);
      // requireTrustedOwner (wm-guards): only the owner's own thread (an
      // attested delegate whose thread owner is on the box's allowlist, or
      // a pinned binding) counts as a delegate.
      if (requireTrustedOwner && !attestation.attested && !pinned) return { trust: "peer", reason: "owner_not_trusted", owner: attestation.owner };
      return {
        ...verdict,
        attested: attestation.attested,
        attestationReason: !attestation.attested && pinned ? "pinned_binding" : attestation.reason,
        owner: attestation.owner,
        ownerThread: attestation.attested === true || pinned,
        pinnedBinding: pinned ? agent : null,
      };
    };
    if (unattributed) {
      const rows = bridge.prepare("SELECT * FROM relay_messages WHERE state IN (" + placeholders + ")").all(...kActiveStates);
      if (!rows.length) return { tier: "none", reason: "no_relay_run", approval: null };
      for (const row of rows) {
        const verdict = liveness(row);
        if (verdict.trust !== "delegate") return peer("unattributed_" + verdict.reason);
      }
      return { tier: "delegate", reason: "unattributed_delegate", approval: null };
    }
    let row = run ? bridge.prepare("SELECT * FROM relay_messages WHERE run_id = ?").get(run) : null;
    if (!row && kRelaySessionPattern.test(key)) {
      row = bridge
        .prepare(
          "SELECT * FROM relay_messages WHERE session_key = ? COLLATE NOCASE AND state IN (" + placeholders + ")" +
            " ORDER BY COALESCE(dispatched_at, received_at) DESC LIMIT 1",
        )
        .get(key, ...kActiveStates);
    }
    if (!row) return peer("no_run");
    const verdict = liveness(row);
    const facts = {
      sender: row.sender,
      messageId: row.message_id,
      lane: row.lane || null,
      route: row.route || null,
      bindingGeneration: Number.isInteger(row.binding_generation) ? row.binding_generation : null,
      confirmationRef: row.confirmation_ref || null,
    };
    if (verdict.trust !== "delegate") return peer(verdict.reason, { ...facts, grantId: null, approvalState: null, attested: false, ownerThread: false, pinnedBinding: null, owner: verdict.owner || null });
    const approval = kActiveStates.includes(row.state) ? parseApproval(row.approval) : null;
    return {
      tier: "delegate",
      reason: "delegate",
      approval,
      ...facts,
      grantId: row.grant_id || verdict.grantId || null,
      approvalState: row.approval_state || (approval ? "recorded" : "none"),
      attested: verdict.attested === true,
      attestationReason: verdict.attestationReason,
      attestedOrg: verdict.attested === true ? row.attested_org : null,
      owner: verdict.owner || null,
      ownerThread: verdict.ownerThread === true,
      pinnedBinding: verdict.pinnedBinding || null,
    };
  } finally {
    try {
      remote?.close();
    } catch {}
    try {
      bridge.close();
    } catch {}
  }
};

// Whether this one relay message (by id, from this sender) runs as the
// owner's own thread right now, and on what basis: "attested" (a Capy
// attestation, GST-2323), "pinned_binding" (ALPHACLAW_RELAY_TRUSTED_BINDINGS,
// GST-2323 PR3) or null. The guards' confirmation check asks it, so
// AlphaClaw's guard and Wintermute's own agree without either passing a
// flag. Reads the bridge's row and remote.db only; anything else is null.
const ownerThreadBasisOf = ({ rootDir, sender, messageId, now = Date.now(), fsModule = fs } = {}) => {
  if (!sender || !messageId) return null;
  const bridge = openReadOnly(path.join(String(rootDir || ""), "relay", "bridge.db"), fsModule);
  if (!bridge) return null;
  let row;
  try {
    row = bridge.prepare("SELECT * FROM relay_messages WHERE message_id = ?").get(String(messageId));
  } finally {
    try {
      bridge.close();
    } catch {}
  }
  if (!row || !row.run_id || !(row.attested_org || row.pinned_binding) || row.trust !== "delegate" || !kActiveStates.includes(row.state)) return null;
  if (String(row.sender).toLowerCase() !== String(sender).toLowerCase()) return null;
  const trust = resolveRelayTrust({ rootDir, sessionKey: row.session_key, runId: row.run_id, fallbackAgents: [], now, fsModule });
  if (trust.tier !== "delegate" || trust.ownerThread !== true || String(trust.messageId) !== String(messageId)) return null;
  return trust.attested === true ? "attested" : trust.pinnedBinding ? "pinned_binding" : null;
};

const isOwnerThreadMessage = (input) => ownerThreadBasisOf(input) !== null;

// The name Wintermute's own guard (wm-guards) and AlphaClaw's callers have
// used since GST-2323: it answers for every owner's-own-thread basis,
// a pinned binding included.
const isAttestedDelegateMessage = isOwnerThreadMessage;

module.exports = { resolveRelayTrust, isAttestedDelegateMessage, isOwnerThreadMessage, ownerThreadBasisOf, classifyBinding, pinnedOfRun, kRelaySessionPattern, kActiveStates };
