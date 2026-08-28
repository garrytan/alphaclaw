// Boot placeholder request handler, extracted from bin/alphaclaw.js so the
// stuck-window flip and content negotiation are unit-testable with an
// injected clock (the bin wraps this in an http.Server it closes right
// before the real server binds).
//
//   /health           → 200 {status:"updating"}  (same 200-always semantics
//                        as the real server, so platforms don't restart-loop
//                        a container mid-update)
//   browser requests  → 503 + human "AlphaClaw is updating" page, auto-refresh
//   everything else   → 503 JSON + Retry-After
//
// If boot hangs past maxUpdatingWindowMs, /health flips to 503 so the
// platform restarts a genuinely stuck bootstrap instead of trusting
// "updating" forever.
const kMaxUpdatingWindowMs = 15 * 60 * 1000;

const kUpdatingPageHtml = [
  "<!doctype html><html><head><meta charset=\"utf-8\">",
  "<meta http-equiv=\"refresh\" content=\"5\">",
  "<title>AlphaClaw is updating</title>",
  "<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0e14;color:#e6e6e6}main{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.4rem;margin-bottom:.5rem}p{color:#9aa4b2;line-height:1.5}</style>",
  "</head><body><main><h1>AlphaClaw is updating&hellip;</h1>",
  "<p>The server is finishing an update or restart. This page refreshes automatically &mdash; you&rsquo;ll be back in a couple of minutes.</p>",
  "</main></body></html>",
].join("");

const createBootPlaceholderHandler = ({
  startedAtMs = Date.now(),
  maxUpdatingWindowMs = kMaxUpdatingWindowMs,
  now = Date.now,
} = {}) => (req, res) => {
  const stuck = now() - startedAtMs > maxUpdatingWindowMs;
  if (String(req.url || "").split("?")[0] === "/health") {
    res.writeHead(stuck ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "updating", gateway: "starting" }));
    return;
  }
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/html")) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Retry-After": "5" });
    res.end(kUpdatingPageHtml);
    return;
  }
  res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
  res.end(JSON.stringify({ ok: false, error: "AlphaClaw is updating", status: "updating" }));
};

module.exports = { createBootPlaceholderHandler, kMaxUpdatingWindowMs };
