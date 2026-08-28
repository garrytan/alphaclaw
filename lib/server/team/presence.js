// Who's-online presence (4.5): an in-memory TTL map fed by authenticated
// member activity (proxied requests, chat websocket traffic). Entries expire
// after kPresenceTtlMs without a touch (~3 missed 10s heartbeats, CEO finding
// 5) so a dropped bridge can never show people online forever.
//
// Division of ownership (E-C9): the headline profile/avatar experience is
// GATEWAY-owned — this map only powers the lightweight roster dots on the
// AlphaClaw Team page.
const kPresenceTtlMs = 30 * 1000;

const createTeamPresence = ({ nowFn = Date.now, ttlMs = kPresenceTtlMs } = {}) => {
  const entries = new Map();

  const touch = (identity) => {
    if (!identity || identity.kind !== "member" || !identity.email) return;
    entries.set(identity.email, {
      email: identity.email,
      displayName: identity.displayName || "",
      role: identity.role || "member",
      lastSeenAt: nowFn(),
    });
  };

  const list = () => {
    const now = nowFn();
    const online = [];
    for (const [email, entry] of entries) {
      if (now - entry.lastSeenAt > ttlMs) {
        entries.delete(email);
        continue;
      }
      online.push(entry);
    }
    return online.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  };

  const remove = (email) => entries.delete(String(email || ""));
  const clear = () => entries.clear();

  return { touch, list, remove, clear, ttlMs };
};

module.exports = { createTeamPresence, kPresenceTtlMs };
