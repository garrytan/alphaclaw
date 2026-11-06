const path = require("path");
const { kRelayMcpServerName, kRelayManagedOwner, relayPaths } = require("./constants");
const { readRelayConfig } = require("./config");

// The openclaw.json entry that gives the box agent its relay tools. It is
// applied inside ensureGatewayProxyConfig's locked writer, beside the managed
// REMOTE_MCP entry, and owner-scoped: "_alphaclawManaged": "relay" marks it
// ours, so the REMOTE_MCP cleanup (which owns entries marked true) never
// removes it, and this function never touches an entry someone else owns.
// The entry holds no secret: the node binary, mcp-stdio.js and three plain
// arguments (the relay directory, the engine port and AlphaClaw's own port,
// which the tools mask every outgoing message through). It is removed when
// the relay is off.
const kManagedMarker = "_alphaclawManaged";
const kStdioScript = path.join(__dirname, "mcp-stdio.js");

const buildRelayMcpEntry = ({ relayDir, port, appPort, nodePath = process.execPath }) => ({
  command: nodePath,
  args: [kStdioScript, "--relay-dir", relayDir, "--port", String(port), "--app-port", String(appPort)],
  [kManagedMarker]: kRelayManagedOwner,
});

const sameEntry = (a, b) =>
  Boolean(a) &&
  a.command === b.command &&
  Array.isArray(a.args) &&
  a.args.length === b.args.length &&
  a.args.every((arg, index) => arg === b.args[index]) &&
  a[kManagedMarker] === b[kManagedMarker];

const resolveDesiredRelayMcpEntry = ({ env = process.env, rootDir, appPort = require("../constants").PORT }) => {
  const config = readRelayConfig({ env });
  return config.enabled ? buildRelayMcpEntry({ relayDir: relayPaths(rootDir).dir, port: config.port, appPort }) : null;
};

// Returns { changed, conflict }. desired null removes our entry.
const applyRelayMcpEntry = (cfg, desired, { log = console.log } = {}) => {
  const existing = cfg?.mcp?.servers?.[kRelayMcpServerName];
  const ours = existing && typeof existing === "object" && existing[kManagedMarker] === kRelayManagedOwner;
  if (existing && !ours) {
    if (desired) log('[alphaclaw] relay: mcp.servers.' + kRelayMcpServerName + ' is not managed by AlphaClaw; leaving it and not adding the relay tools');
    return { changed: false, conflict: Boolean(desired) };
  }
  if (!desired) {
    if (!ours) return { changed: false, conflict: false };
    delete cfg.mcp.servers[kRelayMcpServerName];
    log("[alphaclaw] relay: removed the relay MCP server entry (relay off)");
    return { changed: true, conflict: false };
  }
  if (ours && sameEntry(existing, desired)) return { changed: false, conflict: false };
  if (!cfg.mcp) cfg.mcp = {};
  if (!cfg.mcp.servers) cfg.mcp.servers = {};
  cfg.mcp.servers[kRelayMcpServerName] = { ...(ours ? existing : {}), ...desired };
  log("[alphaclaw] relay: configured the relay MCP server entry");
  return { changed: true, conflict: false };
};

module.exports = { buildRelayMcpEntry, resolveDesiredRelayMcpEntry, applyRelayMcpEntry, kStdioScript, kManagedMarker };
