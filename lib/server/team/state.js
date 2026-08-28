const fs = require("fs");
const path = require("path");

// Revert metadata for team mode lives in ALPHACLAW state, never in
// openclaw.json (C6 — beta's strict root config rejects unknown top-level
// keys). Shape:
//   { enabledAt, previousGatewayAuth: <full gateway.auth subtree before enable> }
const kTeamStateFileName = "team-state.json";

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
    fsModule.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmpPath = `${statePath}.tmp`;
    fsModule.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    fsModule.renameSync(tmpPath, statePath);
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
