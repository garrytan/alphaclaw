const net = require("net");
const { normalizeIp } = require("./utils/network");

// The client address the sign-in limiter keys its per-IP block on. Express's
// `trust proxy` (TRUST_PROXY_HOPS, default 1) takes the right-most
// X-Forwarded-For entry whatever the socket peer is, so on a bare install with
// no proxy in front a client picks its own address: it could dodge its block
// or get someone else's address blocked. Here the hop-counted req.ip counts
// only when the socket peer is loopback or a private address, where a proxy
// hop sits (a local Caddy, Render's and Railway's internal network, a Docker
// bridge); any other peer is the client itself. Express's global setting is
// left alone because req.secure and req.ip everywhere else depend on it.
// Residual: a client on the same private network, or behind a private hop
// that does not append X-Forwarded-For, can still choose its address.
const kProxyHopRanges = new net.BlockList();
for (const [address, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
]) {
  kProxyHopRanges.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
]) {
  kProxyHopRanges.addSubnet(address, prefix, "ipv6");
}

const isProxyHopAddress = (address) => {
  const family = net.isIP(address);
  if (!family) return false;
  return kProxyHopRanges.check(address, family === 6 ? "ipv6" : "ipv4");
};

const resolveLoginClientIp = (req) => {
  const peer = normalizeIp(req?.socket?.remoteAddress || "");
  if (!peer) return "unknown";
  if (!isProxyHopAddress(peer)) return peer;
  return normalizeIp(req?.ip || "") || peer;
};

module.exports = { isProxyHopAddress, resolveLoginClientIp };
