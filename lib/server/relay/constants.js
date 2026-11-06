const path = require("path");

// Agent Relay (self-hosted Relaycast engine) constants. The engine ships as
// upstream's standalone binary (Bun-embedded, SQLite built in): the npm
// package needs better-sqlite3, which has no Node 24 prebuild, and node:24-slim
// cannot compile it. Each platform's sha256 is pinned here and checked before
// the binary ever runs; bump the version and every hash together.
const kRelayEngineVersion = "12.8.0";
const kRelayEngineSha256 = Object.freeze({
  "linux-x64": "77743cfe096194101d6f3e8a5c26118ab883d4e9fe13aa85cea686a10f22e9f9",
  "linux-arm64": "d3b951f17a7da0557bb94cb7ae2d7ff5580929e1c657949e35155c004e7d98ba",
  "linux-musl-x64": "082adf99fbb99b72c3d847d0f67d5974cab915c96107b82aaefae18722a5d4ca",
  "linux-musl-arm64": "5d82226cb43135dc93123762a5088a36f31d75dc97ef699e3236c7e638c060cd",
  "darwin-arm64": "ee654595a3685b92bfccc81abc821eca41eaca6ac3e851c186e77c98303f2e41",
  "darwin-x64": "fa036f8dac2c1893164516b70836d3d58c976c3306e149972fc35328a1b4e9e5",
});
const kRelayEngineReleaseBase = "https://github.com/AgentWorkforce/relaycast/releases/download";

const kRelaySidecarName = "relay-engine";
const kRelayMcpServerName = "relay";
const kRelayManagedOwner = "relay";
const kRelaySessionPrefix = "relay-";
const kRelayDefaultPort = 18787;
const kRelayDefaultAgentName = "openclaw";

const relayPaths = (rootDir) => {
  const dir = path.join(rootDir, "relay");
  return {
    dir,
    binDir: path.join(dir, "bin"),
    engineDb: path.join(dir, "relaycast.db"),
    bridgeDb: path.join(dir, "bridge.db"),
    internalSecretFile: path.join(dir, "internal.secret"),
    secretsFile: path.join(dir, "secrets.json"),
  };
};

module.exports = {
  kRelayEngineVersion,
  kRelayEngineSha256,
  kRelayEngineReleaseBase,
  kRelaySidecarName,
  kRelayMcpServerName,
  kRelayManagedOwner,
  kRelaySessionPrefix,
  kRelayDefaultPort,
  kRelayDefaultAgentName,
  relayPaths,
};
