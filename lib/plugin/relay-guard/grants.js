// The one answer to "which grant, if any, makes this relay sender the owner's
// delegate?" (relay trust v2, GST-2090). Pure, so the relay guard (trust.js,
// loaded by OpenClaw from this directory), the bridge and the remote tools
// all decide from the same table. Grants live in relay/remote.db
// (relay_grants); a revoked grant is kept as a tombstone.
//
// Order, deny first:
// A binding's grants are its agent's ("agent:<name>") plus, for a binding
// made through a Capy grant's own client, that grant ("client:<id>").
//
//   1. the binding must be live (bound, client consented and not revoked,
//      not dead, not past its until date), as before grants;
//   2. a caller's narrowTo list can only narrow (an empty list is no
//      delegates at all);
//   3. a live grant for the agent decides: any live peer grant makes it a
//      peer, otherwise the newest live delegate grant makes it a delegate;
//   4. with no live grant, a revoked one is a tombstone: peer, whatever the
//      deployment env list says, after any reboot or import;
//   5. with no grant row at all, the agent in fallbackAgents
//      (ALPHACLAW_RELAY_DELEGATE_AGENTS, read for one release) is a delegate;
//   6. anything else is a peer.
const kGrantTiers = Object.freeze(["delegate", "peer"]);
const kRoutes = Object.freeze(["any", "tailnet"]);
const kDefaultLanesMax = 3;
const kMaxLanes = 8;
const kLanePattern = /^[a-z0-9][a-z0-9-]{0,23}$/;

const isValidLane = (value) => typeof value === "string" && kLanePattern.test(value);

// The lane a value names, or null for the default lane. Anything else is
// not a lane and throws, so a typo never lands in the default queue.
const normalizeLane = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const lane = String(value).trim().toLowerCase();
  if (!isValidLane(lane)) throw Object.assign(new Error("lane must be 1-24 of a-z, 0-9 and -, starting with a letter or digit."), { code: "invalid_input" });
  return lane;
};

const bindingVerdict = ({ binding, client, now }) => {
  if (!binding) return { trust: "peer", reason: "not_bound" };
  if (!client || client.revokedAt || !client.consentedAt) return { trust: "peer", reason: "client_revoked" };
  if (binding.deadAt) return { trust: "peer", reason: "binding_dead" };
  if (!(Number(binding.until) > now)) return { trust: "peer", reason: "binding_expired" };
  return null;
};

const limitsOf = (grant) => ({
  lanesMax: Number.isInteger(grant?.lanesMax) && grant.lanesMax > 0 ? Math.min(kMaxLanes, grant.lanesMax) : kDefaultLanesMax,
  hourlyCap: Number.isInteger(grant?.hourlyCap) && grant.hourlyCap > 0 ? grant.hourlyCap : null,
  requireRoute: kRoutes.includes(grant?.requireRoute) ? grant.requireRoute : "any",
});

// { trust, reason, grantId, lanesMax, hourlyCap, requireRoute }. grants are
// every row for this agent's principal, revoked ones included.
const resolveGrant = ({ binding, client, grants = [], fallbackAgents = null, narrowTo = null, now = Date.now() }) => {
  const base = { grantId: null, ...limitsOf(null) };
  const lapsed = bindingVerdict({ binding, client, now });
  if (lapsed) return { ...lapsed, ...base };
  const agent = String(binding.agent || "").toLowerCase();
  if (Array.isArray(narrowTo) && !narrowTo.length) return { trust: "peer", reason: "delegates_off", ...base };
  if (Array.isArray(narrowTo) && !narrowTo.map((entry) => String(entry).toLowerCase()).includes(agent)) {
    return { trust: "peer", reason: "agent_not_delegate", ...base };
  }
  const rows = (Array.isArray(grants) ? grants : []).filter(Boolean);
  const live = rows.filter((grant) => !grant.revokedAt && kGrantTiers.includes(grant.tier));
  const livePeer = live.find((grant) => grant.tier === "peer");
  if (livePeer) return { trust: "peer", reason: "grant_peer", grantId: livePeer.id, ...limitsOf(livePeer) };
  const delegate = live
    .filter((grant) => grant.tier === "delegate")
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt) || String(b.id).localeCompare(String(a.id)))[0];
  if (delegate) return { trust: "delegate", reason: "grant", grantId: delegate.id, ...limitsOf(delegate) };
  if (rows.some((grant) => grant.revokedAt)) return { trust: "peer", reason: "grant_revoked", ...base };
  if (Array.isArray(fallbackAgents) && fallbackAgents.map((entry) => String(entry).toLowerCase()).includes(agent)) {
    return { trust: "delegate", reason: "env_fallback", ...base };
  }
  return { trust: "peer", reason: "no_grant", ...base };
};

const principalKeyFor = (agent) => "agent:" + String(agent || "").trim().toLowerCase();
// A Capy grant's key: the OAuth client it owns, so every binding made
// through that client finds it.
const principalKeyForClient = (clientId) => "client:" + String(clientId || "").trim();

module.exports = {
  resolveGrant,
  principalKeyFor,
  principalKeyForClient,
  normalizeLane,
  isValidLane,
  kGrantTiers,
  kRoutes,
  kDefaultLanesMax,
  kMaxLanes,
  kLanePattern,
};
