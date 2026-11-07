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
// When TRUST_PROXY_HOPS is set explicitly, the operator has declared the
// proxy chain (for example a CDN or load balancer that connects from a public
// address), so the hop-counted req.ip is used whatever the peer is.
// Residual: with it unset, a client on the same private network, or behind a
// private hop that does not append X-Forwarded-For (Docker Desktop, rootless
// Docker's userland proxy, a Tailscale peer), can still choose its address.
const kTrustProxyHopsDeclared = String(process.env.TRUST_PROXY_HOPS ?? "").trim() !== "";
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

// With TRUST_PROXY_HOPS unset, a proxy or CDN that connects from a public
// address would put all its clients behind one per-address block, so the
// first public peer gets one warning per process. Key name only.
let publicPeerWarned = false;
const warnPublicPeerOnce = () => {
  if (publicPeerWarned) return;
  publicPeerWarned = true;
  console.warn(
    "[auth] Sign-in limits are keyed on the connecting address: TRUST_PROXY_HOPS is not set and a sign-in came straight from a public address, so a proxy or CDN on a public address in front of AlphaClaw would put all its clients behind one block: set TRUST_PROXY_HOPS=0 if nothing sits in front; set it to the number of proxies otherwise.",
  );
};

const resolveLoginClientIp = (req) => {
  const peer = normalizeIp(req?.socket?.remoteAddress || "");
  if (!peer) return "unknown";
  if (!kTrustProxyHopsDeclared && !isProxyHopAddress(peer)) {
    warnPublicPeerOnce();
    return peer;
  }
  return normalizeIp(req?.ip || "") || peer;
};

// The per-address limiter key. One IPv6 subscriber usually holds a whole /64,
// so an IPv6 address is keyed on its /64 ("2001:db8:aa:bb::/64"). An address
// that carries an IPv4 client in its last 32 bits (IPv4-mapped ::ffff:0:0/96,
// NAT64 64:ff9b::/96, and the local-use 64:ff9b:1::/48 with a /96 NAT64
// prefix) is keyed on that IPv4, the key the client gets on a direct IPv4
// connection, so one /64 is not shared by every IPv4 client. IPv4 and
// anything unparsable are keyed as they are. Audit lines keep the full address.
const loginLimiterKey = (address) => {
  const value = String(address || "").split("%")[0];
  if (net.isIP(value) !== 6) return String(address || "");
  let text = value.toLowerCase();
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[2].split(".").map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail === null ? [] : tail ? tail.split(":") : [];
  const groups =
    tail === null
      ? headGroups
      : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups];
  const words = groups.map((group) => parseInt(group, 16));
  const embedsIpv4 =
    (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) ||
    (words[0] === 0x64 && words[1] === 0xff9b && (words[2] === 1 || words.slice(2, 6).every((word) => word === 0)));
  if (embedsIpv4) return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join(".");
  return `${words.slice(0, 4).map((word) => word.toString(16)).join(":")}::/64`;
};

module.exports = { isProxyHopAddress, loginLimiterKey, resolveLoginClientIp };
