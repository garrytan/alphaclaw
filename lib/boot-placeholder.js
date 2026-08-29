// Boot placeholder request handler, extracted from bin/alphaclaw.js so the
// stuck-window flip, content negotiation, and live update-progress rendering
// are unit-testable with an injected clock (the bin wraps this in an
// http.Server it closes right before the real server binds).
//
//   /health           → 200 {status:"updating"}  (same 200-always semantics
//                        as the real server, so platforms don't restart-loop
//                        a container mid-update)
//   browser requests  → 503 + human "AlphaClaw is updating" page, auto-refresh.
//                        When the on-disk channel-state/run records are
//                        readable the page shows live step progress; any read
//                        or parse problem falls open to the static copy.
//   everything else   → 503 JSON + Retry-After
//
// Stuck-window semantics: /health flips to 503 after maxUpdatingWindowMs
// WITHOUT observed step progress (any new step name or step status change in
// the run ledger re-arms the baseline — long dev builds keep reporting steps,
// a hung boot doesn't), and kPlaceholderAbsoluteMaxMs from process start
// flips it regardless, so a boot that "progresses" forever is still treated
// as stuck.
const fs = require("fs");
const path = require("path");
const { buildStepListModel, formatElapsed } = require("./update-progress-model.js");

const kMaxUpdatingWindowMs = 15 * 60 * 1000;
const kPlaceholderAbsoluteMaxMs = 60 * 60 * 1000;

// Progress reader tuning: re-stat/re-read the on-disk records at most every
// 2s (the page meta-refreshes every 5s), never read a file over 512KB
// (treated as unreadable → static page), and only accept operation ids that
// can't traverse out of the runs/ directory.
const kProgressReadIntervalMs = 2000;
const kMaxProgressFileBytes = 512 * 1024;
const kOperationIdPattern = /^[0-9a-fA-F-]{8,64}$/;

// Terminal runs older than this render the static page (the update is long
// over — this boot is something else); fresh terminal failures render an
// explicit failure note instead of pretending progress.
const kTerminalFreshWindowMs = 30 * 60 * 1000;
const kFailedTerminalStates = new Set(["failed", "activation_failed", "interrupted"]);
// A running step silent for this long gets an honest "still working" note.
const kStallNoteAfterMs = 5 * 60 * 1000;

// SECURITY: everything interpolated into the page goes through esc() — HTML
// entity escaping plus a hard length cap. The page may only ever contain step
// names/labels/statuses/timestamps/elapsed, the target version+channel, the
// backup-verified time, and fixed copy. Step detail/error, file paths, and
// gatewayHold contents (blamedKeys, reason) must NEVER be rendered.
const kMaxInterpolatedChars = 128;
const kHtmlEscapes = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value) =>
  String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => kHtmlEscapes[ch]);
const esc = (value) =>
  escapeHtml(String(value == null ? "" : value).slice(0, kMaxInterpolatedChars));

const kStepGlyphs = {
  completed: "✓",
  running: "▸",
  warning: "⚠",
  failed: "✕",
};

const kPageStyle = [
  "body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0e14;color:#e6e6e6}",
  "main{text-align:center;max-width:28rem;padding:2rem}",
  "h1{font-size:1.4rem;margin-bottom:.5rem}",
  "p{color:#9aa4b2;line-height:1.5}",
  "ul.steps{list-style:none;display:inline-block;text-align:left;margin:1rem 0;padding:0}",
  "ul.steps li{color:#9aa4b2;line-height:1.7}",
  "ul.steps li.current{color:#e6e6e6}",
  "ul.steps .elapsed{color:#6b7684;font-size:.85rem;margin-left:1.25rem}",
  "p.note{color:#c9a227}",
].join("");

const renderPlaceholderPage = (bodyHtml) => [
  "<!doctype html><html><head><meta charset=\"utf-8\">",
  "<meta http-equiv=\"refresh\" content=\"5\">",
  "<title>AlphaClaw is updating</title>",
  `<style>${kPageStyle}</style>`,
  "</head><body><main>",
  bodyHtml,
  "</main></body></html>",
].join("");

// Static fallback — served when no readable update run exists (plain
// restarts, fresh installs, unreadable/garbage state — fail-open).
const kUpdatingPageHtml = renderPlaceholderPage(
  "<h1>AlphaClaw is updating&hellip;</h1>" +
    "<p>The server is finishing an update or restart. This page refreshes automatically &mdash; you&rsquo;ll be back in a couple of minutes.</p>",
);

// Fixed copy only — never any data from the run record or gatewayHold.
const kUpdateFailedPageHtml = renderPlaceholderPage(
  "<h1>AlphaClaw is updating&hellip;</h1>" +
    "<p>The update did not complete &mdash; AlphaClaw will show details when it finishes starting.</p>",
);
const kGatewayHoldPageHtml = renderPlaceholderPage(
  "<h1>AlphaClaw is updating&hellip;</h1>" +
    "<p>Settings migration needs attention &mdash; sign in once AlphaClaw finishes starting.</p>",
);

const toMs = (value) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const pad2 = (n) => String(n).padStart(2, "0");
const formatUtcHhMm = (ms) => {
  const date = new Date(ms);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
};

// Which page shape a progress snapshot maps to. gatewayHold wins (it needs
// the operator's attention regardless of run age); a terminal run past the
// freshness window means the update is history — static; a FRESH terminal
// failure gets the explicit failure copy; everything else (running, or a
// fresh restart_expected/activated/noop whose boot steps are still being
// appended) renders live progress.
const resolvePlaceholderView = (progress, nowMs) => {
  if (!progress || typeof progress !== "object") return "static";
  if (progress.gatewayHold) return "hold";
  const run = progress.run;
  if (!run || typeof run !== "object") return "static";
  const state = String(run.state || "");
  const terminal = state !== "" && state !== "running";
  if (terminal) {
    const finishedAtMs = toMs(run.finishedAt);
    const fresh = finishedAtMs != null && nowMs - finishedAtMs <= kTerminalFreshWindowMs;
    if (!fresh) return "static";
    if (kFailedTerminalStates.has(state)) return "failure";
  }
  return "progress";
};

const renderProgressPage = (progress, nowMs) => {
  const run = progress.run;
  const parts = ["<h1>AlphaClaw is updating&hellip;</h1>"];

  const target = run.target && typeof run.target === "object" ? run.target : null;
  if (target && target.version && target.channel) {
    parts.push(`<p>Updating to OpenClaw ${esc(target.version)} (${esc(target.channel)})</p>`);
  }

  const steps = buildStepListModel(Array.isArray(run.steps) ? run.steps : []);
  let newestStepAtMs = null;
  if (steps.length > 0) {
    const currentIndex = steps.findLastIndex((step) => step.status === "running");
    const rows = steps.map((step, index) => {
      const glyph = kStepGlyphs[step.status] || "·";
      const atMs = toMs(step.at);
      if (atMs != null && (newestStepAtMs == null || atMs > newestStepAtMs)) {
        newestStepAtMs = atMs;
      }
      const elapsed =
        index === currentIndex && atMs != null
          ? `<div class="elapsed">${esc(formatElapsed(atMs, nowMs))} elapsed</div>`
          : "";
      const cls = index === currentIndex ? " class=\"current\"" : "";
      return `<li${cls}>${glyph} ${esc(step.label)}${elapsed}</li>`;
    });
    parts.push(`<ul class="steps">${rows.join("")}</ul>`);
  }

  const backup = progress.backup && typeof progress.backup === "object" ? progress.backup : null;
  if (backup && backup.verified === true) {
    const backupAtMs = toMs(backup.at);
    if (backupAtMs != null) {
      parts.push(`<p>Verified backup taken at ${esc(formatUtcHhMm(backupAtMs))}</p>`);
    }
  }

  if (
    String(run.state || "") === "running" &&
    newestStepAtMs != null &&
    nowMs - newestStepAtMs > kStallNoteAfterMs
  ) {
    parts.push(
      "<p class=\"note\">Still working &mdash; this step is taking longer than expected.</p>",
    );
  }

  parts.push(
    "<p>Large updates can take several minutes &mdash; this page shows live progress and refreshes automatically.</p>",
  );
  return renderPlaceholderPage(parts.join(""));
};

// Progress fingerprint for the stuck-window baseline: a new step name or a
// step status change (each is a new ledger entry) changes it; timestamps
// alone don't, so a re-written-but-identical ledger can't fake progress.
const fingerprintRun = (run) => {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const events = steps
    .map((step) => `${(step && step.name) || ""}:${(step && step.status) || ""}`)
    .join(",");
  return `${run.operationId || ""}|${run.state || ""}|${events}`;
};

// Real on-disk progress reader factory (the handler's default). Returns a
// zero-arg reader the handler calls per request; each call is cheap — cached
// by (channel-state mtime + run-file mtime) and re-read at most every 2s.
// Returns null (→ static page) on ANY read/parse problem: missing root,
// missing/garbage files, oversized files, malformed operation ids.
const createProgressReader = ({
  rootDir = process.env.ALPHACLAW_ROOT_DIR,
  fsImpl = fs,
  now = Date.now,
  readIntervalMs = kProgressReadIntervalMs,
} = {}) => {
  if (!rootDir) return () => null;
  const alphaclawDir = path.join(rootDir, ".openclaw", ".alphaclaw");
  const statePath = path.join(alphaclawDir, "openclaw-channel-state.json");
  const runsDir = path.join(alphaclawDir, "runs");

  let lastAttemptMs = -Infinity;
  let cached = null; // { stateMtimeMs, runPath, runMtimeMs, value }

  const readJsonCapped = (filePath) => {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size > kMaxProgressFileBytes) {
      throw new Error("progress file unreadable");
    }
    return { mtimeMs: stat.mtimeMs, json: JSON.parse(fsImpl.readFileSync(filePath, "utf8")) };
  };

  return () => {
    const nowMs = now();
    if (nowMs - lastAttemptMs < readIntervalMs) return cached ? cached.value : null;
    lastAttemptMs = nowMs;
    try {
      const stateStat = fsImpl.statSync(statePath);
      if (cached && cached.stateMtimeMs === stateStat.mtimeMs) {
        if (!cached.runPath) return cached.value;
        try {
          if (fsImpl.statSync(cached.runPath).mtimeMs === cached.runMtimeMs) {
            return cached.value;
          }
        } catch {}
      }

      const state = readJsonCapped(statePath).json;
      if (!state || typeof state !== "object") throw new Error("bad channel state");

      let runPath = null;
      let runMtimeMs = null;
      let run = null;
      const pointer =
        state.lastUpdateRun && state.lastUpdateRun.operationId != null
          ? String(state.lastUpdateRun.operationId)
          : null;
      if (pointer != null) {
        // Validate BEFORE building the path — the id becomes a filename.
        if (!kOperationIdPattern.test(pointer)) throw new Error("bad operation id");
        runPath = path.join(runsDir, `${pointer}.json`);
        const read = readJsonCapped(runPath);
        run = read.json;
        runMtimeMs = read.mtimeMs;
      } else {
        // No pointer: newest runs/*.json by startedAt (skip unreadable ones).
        let names = [];
        try {
          names = fsImpl.readdirSync(runsDir);
        } catch {}
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          if (!kOperationIdPattern.test(name.slice(0, -".json".length))) continue;
          let read = null;
          try {
            read = readJsonCapped(path.join(runsDir, name));
          } catch {
            continue;
          }
          if (!read.json || typeof read.json !== "object") continue;
          const startedAt = toMs(read.json.startedAt) || 0;
          if (!run || startedAt > (toMs(run.startedAt) || 0)) {
            run = read.json;
            runPath = path.join(runsDir, name);
            runMtimeMs = read.mtimeMs;
          }
        }
      }

      const backups = Array.isArray(state.backups) ? state.backups : [];
      const value = {
        run: run && typeof run === "object" ? run : null,
        backup: backups[0] && typeof backups[0] === "object" ? backups[0] : null,
        gatewayHold:
          state.gatewayHold && typeof state.gatewayHold === "object" ? state.gatewayHold : null,
      };
      cached = { stateMtimeMs: stateStat.mtimeMs, runPath, runMtimeMs, value };
      return value;
    } catch {
      cached = null;
      return null;
    }
  };
};

const createBootPlaceholderHandler = ({
  startedAtMs = Date.now(),
  maxUpdatingWindowMs = kMaxUpdatingWindowMs,
  absoluteMaxMs = kPlaceholderAbsoluteMaxMs,
  now = Date.now,
  readProgress = createProgressReader(),
} = {}) => {
  let baselineMs = startedAtMs;
  let lastFingerprint = null;
  return (req, res) => {
    const nowMs = now();
    let progress = null;
    try {
      progress = typeof readProgress === "function" ? readProgress() : null;
    } catch {
      progress = null;
    }
    if (progress && progress.run && typeof progress.run === "object") {
      const fingerprint = fingerprintRun(progress.run);
      // First observation only records; later CHANGES re-arm the baseline.
      if (lastFingerprint !== null && fingerprint !== lastFingerprint) {
        baselineMs = nowMs;
      }
      lastFingerprint = fingerprint;
    }
    const stuck =
      nowMs - baselineMs > maxUpdatingWindowMs || nowMs - startedAtMs > absoluteMaxMs;
    if (String(req.url || "").split("?")[0] === "/health") {
      res.writeHead(stuck ? 503 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "updating", gateway: "starting" }));
      return;
    }
    const accept = String(req.headers.accept || "");
    if (accept.includes("text/html")) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Retry-After": "5" });
      let html = kUpdatingPageHtml;
      try {
        const view = resolvePlaceholderView(progress, nowMs);
        if (view === "hold") html = kGatewayHoldPageHtml;
        else if (view === "failure") html = kUpdateFailedPageHtml;
        else if (view === "progress") html = renderProgressPage(progress, nowMs);
      } catch {
        html = kUpdatingPageHtml;
      }
      res.end(html);
      return;
    }
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
    res.end(JSON.stringify({ ok: false, error: "AlphaClaw is updating", status: "updating" }));
  };
};

module.exports = {
  createBootPlaceholderHandler,
  createProgressReader,
  escapeHtml,
  kMaxUpdatingWindowMs,
  kPlaceholderAbsoluteMaxMs,
};
