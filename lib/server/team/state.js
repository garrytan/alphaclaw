const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../utils/safe-file");

// Revert metadata for team mode lives in ALPHACLAW state, never in
// openclaw.json (C6 — beta's strict root config rejects unknown top-level
// keys). Shape:
//   { enabledAt, previousGatewayAuth: <full gateway.auth subtree before enable> }
const kTeamStateFileName = "team-state.json";
// previousGatewayAuth holds the pre-team gateway.auth subtree, which can carry
// a resolved gateway password — same sensitivity as the 0600
// team-auth-snapshot.json, so this file gets the same owner-only mode (H6).
const kTeamStateFileMode = 0o600;

const createTeamStateStore = ({
  rootDir,
  fsModule = fs,
  fileName = kTeamStateFileName,
} = {}) => {
  const statePath = path.join(rootDir, "db", fileName);

  const read = () => {
    try {
      const raw = JSON.parse(fsModule.readFileSync(statePath, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  };

  const write = (state) => {
    writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, {
      fsModule,
      mode: kTeamStateFileMode,
      durable: false,
    });
    return state;
  };

  return {
    path: statePath,
    read,
    write,
    update: (mutate) => write(mutate(read()) || {}),
    clear: () => write({}),
  };
};

module.exports = { createTeamStateStore, kTeamStateFileName };
