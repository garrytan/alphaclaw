const path = require("path");
const { applyRelayGuardEntry, buildRelayGuardEntry, resolveDesiredRelayGuardEntry, kRelayGuardPluginPath } = require("../../lib/server/relay/guard-entry");

describe("relay guard plugin entry (openclaw.json)", () => {
  const rootDir = "/data/alphaclaw";
  const desired = buildRelayGuardEntry({ rootDir });
  const quiet = { log: () => {} };

  it("loads AlphaClaw's bundled relay-guard plugin, owner-marked, with the root dir, while the relay is on", () => {
    expect(resolveDesiredRelayGuardEntry({ env: {}, rootDir })).toEqual(desired);
    expect(resolveDesiredRelayGuardEntry({ env: { ALPHACLAW_RELAY: "off" }, rootDir })).toBeNull();
    const cfg = { plugins: { allow: ["usage-tracker"], load: { paths: ["/old/node_modules/alphaclaw/lib/plugin/relay-guard"] }, entries: {} } };
    expect(applyRelayGuardEntry(cfg, desired, quiet)).toEqual({ changed: true, conflict: false });
    expect(cfg.plugins.allow).toEqual(["usage-tracker", "relay-guard"]);
    expect(cfg.plugins.load.paths).toEqual([kRelayGuardPluginPath]);
    expect(kRelayGuardPluginPath).toBe(path.resolve(__dirname, "../../lib/plugin/relay-guard"));
    expect(cfg.plugins.entries["relay-guard"]).toEqual({ enabled: true, config: { _alphaclawManaged: "relay", rootDir } });
    expect(applyRelayGuardEntry(cfg, desired, quiet)).toEqual({ changed: false, conflict: false });
  });

  it("re-enables its own entry, never touches one someone else owns, and removes only its own when the relay is off", () => {
    const disabled = { plugins: { allow: [], load: { paths: [] }, entries: { "relay-guard": { enabled: false, config: { _alphaclawManaged: "relay" } } } } };
    expect(applyRelayGuardEntry(disabled, desired, quiet).changed).toBe(true);
    expect(disabled.plugins.entries["relay-guard"].enabled).toBe(true);
    const foreign = { plugins: { entries: { "relay-guard": { enabled: false } } } };
    const before = JSON.stringify(foreign);
    expect(applyRelayGuardEntry(foreign, desired, quiet)).toEqual({ changed: false, conflict: true });
    expect(applyRelayGuardEntry(foreign, null, quiet)).toEqual({ changed: false, conflict: false });
    expect(JSON.stringify(foreign)).toBe(before);
    const ours = { plugins: { allow: ["relay-guard", "usage-tracker"], load: { paths: [kRelayGuardPluginPath, "/x/plugin/usage-tracker"] }, entries: {} } };
    applyRelayGuardEntry(ours, desired, quiet);
    expect(applyRelayGuardEntry(ours, null, quiet)).toEqual({ changed: true, conflict: false });
    expect(ours.plugins).toEqual({ allow: ["usage-tracker"], load: { paths: ["/x/plugin/usage-tracker"] }, entries: {} });
    expect(applyRelayGuardEntry({}, null, quiet)).toEqual({ changed: false, conflict: false });
  });
});
