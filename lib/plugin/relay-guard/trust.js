const fs = require("fs");
const path = require("path");
const { resolveGrant, principalKeyFor } = require("./grants");

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
const readGrants = (remote, agent) => {
  try {
    return remote
      .prepare("SELECT * FROM relay_grants WHERE principal_key = ?")
      .all(principalKeyFor(agent))
      .map((row) => ({ id: row.id, tier: row.tier, createdAt: row.created_at, revokedAt: row.revoked_at, lanesMax: row.lanes_max, hourlyCap: row.hourly_cap, requireRoute: row.require_route }));
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ""))) return [];
    throw error;
  }
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

const peer = (reason, extra = {}) => ({ tier: "peer", reason, approval: null, ...extra });

// fallbackAgents: ALPHACLAW_RELAY_DELEGATE_AGENTS as the relay guard's plugin
// config carries it, read only for an agent with no grant row at all (one
// release, then removed). delegateAgents, when a caller passes a list, can
// only narrow: an agent not on it is a peer. null (the default, and what the
// relay guard and wm-guards pass) leaves the decision to the grants.
const resolveRelayTrust = ({ rootDir, sessionKey, runId, delegateAgents = null, fallbackAgents = null, now = Date.now(), fsModule = fs } = {}) => {
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
      const grants = binding ? readGrants(remote, agent) : [];
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
      return verdict;
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
      kind: null,
    };
    if (verdict.trust !== "delegate") return peer(verdict.reason, { ...facts, grantId: null, approvalState: null });
    const approval = kActiveStates.includes(row.state) ? parseApproval(row.approval) : null;
    return {
      tier: "delegate",
      reason: "delegate",
      approval,
      ...facts,
      grantId: row.grant_id || verdict.grantId || null,
      approvalState: row.approval_state || (approval ? "recorded" : "none"),
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

module.exports = { resolveRelayTrust, classifyBinding, kRelaySessionPattern, kActiveStates };
