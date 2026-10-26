// MCP servers that fail to start in the gateway (ALPH-40). OpenClaw starts
// an MCP server lazily, the first time a session needs it, and reports a
// failure only as a bundle-mcp warning in the gateway output; the
// agent just runs without that server's tools. This reads those lines, keeps
// each server's last event and last error for GET /api/box/mcp, and tells
// the owner once per server per gateway launch when a server fails to start
// or is skipped. It never restarts or reconfigures anything.
const { redactLine } = require("./utils/redact");
const { sanitizeLabel } = require("./utils/sanitize-label");

const kMaxOutputCarry = 4096;
const kMaxServers = 64;
const kMaxMessageChars = 300;

// kind, whether it is a start failure the owner hears about, and how to read
// the server name and message from the match. OpenClaw writes these as
// "bundle-mcp: ..." and its gateway log renders them as "[bundle-mcp] ...".
const kPrefix = /(?:bundle-mcp:|\[bundle-mcp\]) /.source;
const line = (rest) => new RegExp(kPrefix + rest.source);
const kLinePatterns = [
  { kind: "start_failed", alert: true, pattern: line(/failed to start server "([^"]{1,200})"(.*)$/) },
  { kind: "refresh_failed", alert: false, pattern: line(/failed to refresh server "([^"]{1,200})"(.*)$/) },
  { kind: "skipped", alert: true, pattern: line(/skipped server "([^"]{1,200})" because (.*)$/) },
  { kind: "resolver_failed", alert: true, pattern: line(/connection resolver for server "([^"]{1,200})" (.*)$/) },
  { kind: "tool_list_failed", alert: false, pattern: line(/failed to refresh changed tool list for server "([^"]{1,200})": (.*)$/) },
  { kind: "recycled", alert: false, pattern: line(/recycling server "([^"]{1,200})" after (.*)$/) },
  { kind: "closed", alert: false, pattern: line(/server "([^"]{1,200})" closed; next request reconnects/) },
];
const kErrorKinds = new Set(["start_failed", "refresh_failed", "skipped", "resolver_failed", "tool_list_failed"]);

// "failed to start server "x" (stdio uvx thing): boom" -> "boom"
const messageOf = (kind, rest) => {
  const text = String(rest || "");
  if (kind === "start_failed" || kind === "refresh_failed") {
    const index = text.lastIndexOf("): ");
    if (index >= 0) return text.slice(index + 3);
    return text.replace(/^:\s*/, "");
  }
  return text;
};

const createMcpWatch = ({
  notify = null,
  insertEvent = null,
  getSecrets = () => [],
  now = () => Date.now(),
} = {}) => {
  const servers = new Map();
  const alerted = new Set();
  let launchKey = null;
  let launchAtMs = null;
  let outputCarry = "";

  const alert = (name, entry) => {
    const label = sanitizeLabel(name, { maxLength: 80 });
    const what = entry.lastError.kind === "skipped" ? "was skipped" : "failed to start";
    console.warn(`[alphaclaw] mcp-watch: MCP server "${label}" ${what}: ${entry.lastError.message}`);
    try {
      insertEvent?.({ eventType: "mcp_server_failed", source: "mcp_watch", status: entry.lastError.kind, details: { server: label, message: entry.lastError.message } });
    } catch {}
    if (typeof notify !== "function") return;
    const message = [
      "🐺 *AlphaClaw Watchdog*",
      `⚠️ MCP server "${label}" ${what}`,
      `OpenClaw reported: ${entry.lastError.message || "no detail"}`,
      "Agents keep running without this server's tools. Check its entry under mcp.servers (or run openclaw mcp doctor); GET /api/box/mcp shows every server's last error.",
    ].join("\n");
    void Promise.resolve()
      .then(() => notify(message, { eventType: "mcp_server_failed", id: `mcp-${label}-${launchKey ?? "unknown"}` }))
      .catch(() => {});
  };

  const observeLine = (line) => {
    if (!line.includes("bundle-mcp")) return;
    for (const { kind, alert: shouldAlert, pattern } of kLinePatterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const name = match[1];
      if (!servers.has(name) && servers.size >= kMaxServers) return;
      const atMs = now();
      const entry = servers.get(name) || { name, counts: {}, lastEvent: null, lastError: null };
      entry.counts[kind] = (entry.counts[kind] || 0) + 1;
      entry.lastEvent = { kind, atMs, launchKey };
      if (kErrorKinds.has(kind)) {
        let secrets = [];
        try { secrets = getSecrets() || []; } catch {}
        entry.lastError = { kind, atMs, launchKey, message: redactLine(messageOf(kind, match[2]), { secrets, maxLength: kMaxMessageChars }) };
      }
      servers.set(name, entry);
      if (shouldAlert && !alerted.has(name)) {
        alerted.add(name);
        alert(name, entry);
      }
      return;
    }
  };

  const observeGatewayOutput = (text) => {
    const lines = (outputCarry + String(text ?? "")).split("\n");
    outputCarry = lines.pop().slice(-kMaxOutputCarry);
    for (const line of lines) observeLine(line);
  };

  // OpenClaw announces each launch twice (listening, then ready); only a new
  // generation resets the once-per-launch alerts.
  const onGatewayLaunch = (payload = {}) => {
    const key = payload.generation ?? payload.rootPid ?? null;
    if (key !== null && key === launchKey) return;
    launchKey = key;
    launchAtMs = now();
    alerted.clear();
    outputCarry = "";
  };

  const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const getState = () => ({
    launchAt: toIso(launchAtMs),
    servers: [...servers.values()].map((entry) => ({
      name: entry.name,
      counts: { ...entry.counts },
      lastEvent: entry.lastEvent ? { kind: entry.lastEvent.kind, at: toIso(entry.lastEvent.atMs), thisLaunch: entry.lastEvent.launchKey === launchKey } : null,
      lastError: entry.lastError ? { kind: entry.lastError.kind, at: toIso(entry.lastError.atMs), thisLaunch: entry.lastError.launchKey === launchKey, message: entry.lastError.message } : null,
    })),
  });

  return { observeGatewayOutput, onGatewayLaunch, getState };
};

module.exports = { createMcpWatch };
