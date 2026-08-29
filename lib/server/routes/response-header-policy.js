// Shared response-header strip policy for the gateway proxy paths. Any response
// relayed from the OpenClaw gateway back to an external client must drop
// hop-by-hop headers and never forward a Set-Cookie across the AlphaClaw
// boundary — otherwise the gateway could set a cookie in the caller's browser
// on the unauthenticated /hooks/* path (MW2).
const kHopByHopResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const kAlwaysStrippedResponseHeaders = new Set(["set-cookie"]);

const shouldForwardResponseHeader = (key) => {
  const lowerKey = String(key || "").toLowerCase();
  return (
    !kHopByHopResponseHeaders.has(lowerKey) &&
    !kAlwaysStrippedResponseHeaders.has(lowerKey)
  );
};

module.exports = {
  kHopByHopResponseHeaders,
  kAlwaysStrippedResponseHeaders,
  shouldForwardResponseHeader,
};
