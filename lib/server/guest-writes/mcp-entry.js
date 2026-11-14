const fs = require("fs");
const path = require("path");
const { kGuestNotesMcpServerName, kGuestNotesManagedOwner, guestWritesPaths } = require("./constants");

// The openclaw.json entry that gives the agent the guest_save tool, applied
// inside ensureGatewayProxyConfig's locked writer beside the relay's entry.
// It is present only while the broker's gbrain credential exists
// (guest-writes/broker-client.json), so a box without guest notes never
// sees the tool; turning one group on or off never rewrites openclaw.json,
// because the broker checks the group's setting on every save.
// "_alphaclawManaged": "guest-notes" marks it ours; an entry someone else
// owns under the same name is left alone. The entry holds no secret.
const kManagedMarker = "_alphaclawManaged";
const kStdioScript = path.join(__dirname, "mcp-stdio.js");

const buildGuestNotesMcpEntry = ({ rootDir, appPort, nodePath = process.execPath }) => ({
  command: nodePath,
  args: [kStdioScript, "--root-dir", rootDir, "--app-port", String(appPort)],
  [kManagedMarker]: kGuestNotesManagedOwner,
});

const sameEntry = (a, b) =>
  Boolean(a) &&
  a.command === b.command &&
  Array.isArray(a.args) &&
  a.args.length === b.args.length &&
  a.args.every((arg, index) => arg === b.args[index]) &&
  a[kManagedMarker] === b[kManagedMarker];

const resolveDesiredGuestNotesMcpEntry = ({ rootDir, appPort = require("../constants").PORT, fsModule = fs }) =>
  fsModule.existsSync(guestWritesPaths(rootDir).clientFile) ? buildGuestNotesMcpEntry({ rootDir, appPort }) : null;

// Returns { changed, conflict }. desired null removes our entry.
const applyGuestNotesMcpEntry = (cfg, desired, { log = console.log } = {}) => {
  const existing = cfg?.mcp?.servers?.[kGuestNotesMcpServerName];
  const ours = existing && typeof existing === "object" && existing[kManagedMarker] === kGuestNotesManagedOwner;
  if (existing && !ours) {
    if (desired) log("[alphaclaw] guest-notes: mcp.servers." + kGuestNotesMcpServerName + " is not managed by AlphaClaw; leaving it and not adding guest_save");
    return { changed: false, conflict: Boolean(desired) };
  }
  if (!desired) {
    if (!ours) return { changed: false, conflict: false };
    delete cfg.mcp.servers[kGuestNotesMcpServerName];
    log("[alphaclaw] guest-notes: removed the guest_notes MCP server entry (no broker credential)");
    return { changed: true, conflict: false };
  }
  if (ours && sameEntry(existing, desired)) return { changed: false, conflict: false };
  if (!cfg.mcp) cfg.mcp = {};
  if (!cfg.mcp.servers) cfg.mcp.servers = {};
  cfg.mcp.servers[kGuestNotesMcpServerName] = { ...(ours ? existing : {}), ...desired };
  log("[alphaclaw] guest-notes: configured the guest_notes MCP server entry");
  return { changed: true, conflict: false };
};

module.exports = { buildGuestNotesMcpEntry, resolveDesiredGuestNotesMcpEntry, applyGuestNotesMcpEntry, kStdioScript };
