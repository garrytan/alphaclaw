// Boot placeholder request handler, extracted from bin/alphaclaw.js so the
// stuck-window flip and content negotiation are unit-testable with an
// injected clock (the bin wraps this in an http.Server it closes right before
// the real server binds).
//
//   /health              → 200 {status:"updating"}  (same 200-always semantics
//                           as the real server, so platforms don't restart-loop
//                           a container mid-boot)
//   /boot-progress.json  → 200 { v, source:"placeholder", kind:"preparing",
//                           bootId, stage:"preparing", stuck } — the same path
//                           the real server answers with its boot timeline;
//                           the dashboard's reconnect logic counts the
//                           placeholder → server handoff as ONE boot
//   browser requests     → 503 + "AlphaClaw is restarting" page (Preparing
//                           only: everything after Preparing is the dashboard's
//                           boot card), reloads into the app as soon as the
//                           real server answers
//   everything else      → 503 JSON + Retry-After
//
// Stuck-window semantics: /health flips to 503 once boot has run longer than
// maxUpdatingWindowMs, or longer than absoluteMaxMs (an independent hard cap
// that stays tunable on its own), whichever comes first. The same verdict is
// the JSON frame's `stuck` flag and switches the page to its host-recovery
// advice.
//
// Nothing here names a version, a path or an error: the page and the frame
// are served to anyone who can reach the port.
const crypto = require("crypto");

const kMaxUpdatingWindowMs = 15 * 60 * 1000;
const kPlaceholderAbsoluteMaxMs = 60 * 60 * 1000;

const kHeadlines = Object.freeze({
  restarting: "AlphaClaw is restarting",
  updating: "AlphaClaw is updating",
});

// Theme values mirror lib/public/css/theme.css (dark default; light when the
// OS asks for it; an explicit choice saved by the dashboard's theme toggle
// wins). min-height (not height) keeps flex centering without the
// centered-overflow trap on short viewports.
const kPageStyle = [
  ":root{--bg:#0d121b;--text:#c9d1d9;--text-bright:#f3f4f6;--text-muted:#6e7681;--accent:#63ebff;--border:rgba(255,255,255,.06);color-scheme:dark}",
  "@media (prefers-color-scheme: light){:root{--bg:#f8f9fb;--text:#1f2937;--text-bright:#111827;--text-muted:#6b7280;--accent:#0891b2;--border:rgba(0,0,0,.08);color-scheme:light}}",
  ":root[data-theme=dark]{--bg:#0d121b;--text:#c9d1d9;--text-bright:#f3f4f6;--text-muted:#6e7681;--accent:#63ebff;--border:rgba(255,255,255,.06);color-scheme:dark}",
  ":root[data-theme=light]{--bg:#f8f9fb;--text:#1f2937;--text-bright:#111827;--text-muted:#6b7280;--accent:#0891b2;--border:rgba(0,0,0,.08);color-scheme:light}",
  "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:var(--bg);color:var(--text)}",
  "main{max-width:28rem;padding:2rem 1.25rem;box-sizing:border-box;width:100%}",
  "h1{font-size:1.25rem;margin:0 0 .75rem;color:var(--text-bright)}",
  ".stage{display:flex;align-items:center;gap:.5rem;margin:0 0 .75rem;font-size:.95rem}",
  ".dot{width:.55rem;height:.55rem;border-radius:50%;background:var(--accent);flex:none;animation:pulse 1.6s ease-in-out infinite}",
  "@media (prefers-reduced-motion: reduce){.dot{animation:none}}",
  "@keyframes pulse{50%{opacity:.35}}",
  ".elapsed{color:var(--text-muted);font-variant-numeric:tabular-nums}",
  "p{color:var(--text-muted);line-height:1.5;margin:0 0 .5rem;font-size:.9rem}",
  ".stuck{border:1px solid var(--border);border-radius:.6rem;padding:.75rem;color:var(--text)}",
].join("");

// The elapsed clock and the reload probe. The clock ticks OUTSIDE the live
// region (only the stage line is announced); the probe reloads as soon as
// /boot-progress.json is answered by the real server instead of this page.
const kPageScript = [
  "(function(){",
  "try{var t=localStorage.getItem('alphaclaw.ui.theme');",
  "if(t==='system')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';",
  "if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;}catch(e){}",
  "var start=Date.now()-Number(document.body.getAttribute('data-elapsed-ms')||0);",
  "var el=document.getElementById('elapsed');",
  "function fmt(ms){var s=Math.max(0,Math.floor(ms/1000));var m=Math.floor(s/60);var h=Math.floor(m/60);",
  "if(h>0)return h+'h '+(m%60)+'m';if(m>0)return m+'m '+(s%60)+'s';return s+'s';}",
  "function tick(){if(el)el.textContent=fmt(Date.now()-start);}",
  "tick();setInterval(tick,1000);",
  "function probe(){fetch('/boot-progress.json',{cache:'no-store'}).then(function(r){return r.json().catch(function(){return null;});}).then(function(f){",
  "if(!f||f.source!=='placeholder'){location.reload();return;}",
  "if(f.stuck){var s=document.getElementById('stuck');if(s)s.hidden=false;}",
  "}).catch(function(){}).then(function(){setTimeout(probe,2000);});}",
  "setTimeout(probe,2000);",
  "})();",
].join("");

const formatElapsed = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const renderPlaceholderPage = ({ kind = "restarting", elapsedMs = 0, stuck = false } = {}) => {
  const headline = kHeadlines[kind] || kHeadlines.restarting;
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    // Without a viewport meta, phones render the page in a ~980px fallback
    // viewport.
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"color-scheme\" content=\"dark light\">",
    // No-JS fallback only: with JS the probe reloads exactly when the real
    // server answers (one reload mechanism, not two).
    "<noscript><meta http-equiv=\"refresh\" content=\"5\"></noscript>",
    `<title>${headline}</title>`,
    `<style>${kPageStyle}</style>`,
    `</head><body data-elapsed-ms="${Math.max(0, Math.round(elapsedMs))}"><main>`,
    `<h1>${headline}</h1>`,
    "<p class=\"stage\"><span class=\"dot\" aria-hidden=\"true\"></span>",
    "<span role=\"status\">Preparing</span>",
    `<span class="elapsed" aria-hidden="true">&middot; <span id="elapsed">${formatElapsed(elapsedMs)}</span></span></p>`,
    "<p>AlphaClaw is getting ready to start. This page opens the dashboard as soon as AlphaClaw answers, where each startup stage is shown as it happens.</p>",
    `<p class="stuck" id="stuck" role="alert"${stuck ? "" : " hidden"}>AlphaClaw has been preparing for a long time without finishing. If this persists, restart AlphaClaw from your host's dashboard (Render, Railway).</p>`,
    "</main>",
    `<script>${kPageScript}</script>`,
    "</body></html>",
  ].join("");
};

const createBootPlaceholderHandler = ({
  startedAtMs = Date.now(),
  maxUpdatingWindowMs = kMaxUpdatingWindowMs,
  absoluteMaxMs = kPlaceholderAbsoluteMaxMs,
  now = Date.now,
  // "updating" only when bin found the pending self-update marker; a plain
  // restart never says "updating".
  kind = "restarting",
  bootId = crypto.createHash("sha256").update(`placeholder:${process.pid}:${startedAtMs}`).digest("hex").slice(0, 12),
} = {}) => (req, res) => {
  const elapsedMs = now() - startedAtMs;
  const stuck = elapsedMs > maxUpdatingWindowMs || elapsedMs > absoluteMaxMs;
  const pathname = String(req.url || "").split("?")[0];
  if (pathname === "/health") {
    res.writeHead(stuck ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "updating", gateway: "starting" }));
    return;
  }
  if (pathname === "/boot-progress.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      v: 1,
      source: "placeholder",
      kind: "preparing",
      label: kind === "updating" ? "Updating AlphaClaw" : "Restarting",
      bootId,
      stage: "preparing",
      stuck,
    }));
    return;
  }
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/html")) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Retry-After": "5", "Cache-Control": "no-store" });
    res.end(renderPlaceholderPage({ kind, elapsedMs, stuck }));
    return;
  }
  res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
  res.end(JSON.stringify({ ok: false, error: "AlphaClaw is restarting", status: "updating" }));
};

module.exports = {
  createBootPlaceholderHandler,
  renderPlaceholderPage,
  kMaxUpdatingWindowMs,
  kPlaceholderAbsoluteMaxMs,
};
