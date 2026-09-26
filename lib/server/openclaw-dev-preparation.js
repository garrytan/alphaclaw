const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");

const withIsolatedDevPreparation = async ({ env, checkoutDir, fsModule = fs }, run) => {
  const root = fsModule.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-dev-preparation-"));
  fsModule.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspace = path.join(root, "workspace");
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    fsModule.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fsModule.mkdirSync(workspace, { mode: 0o700 });
    writeFileAtomic(configPath, JSON.stringify({ gateway: { mode: "local" }, agents: { defaults: { workspace } } }), { fsModule, mode: 0o600 });
    const isolated = Object.fromEntries(Object.entries(env || {}).filter(([key]) => !/^(OPENCLAW_|XDG_|PI_)/.test(key)));
    Object.assign(isolated, {
      HOME: root, USERPROFILE: root, OPENCLAW_HOME: root, OPENCLAW_GIT_DIR: checkoutDir,
      OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_DATA_HOME: path.join(root, "data"), NODE_COMPILE_CACHE: path.join(root, "compile-cache"),
    });
    return await run(Object.freeze(isolated));
  } finally {
    await (fsModule.promises || fs.promises).rm(root, { recursive: true, force: true });
  }
};

module.exports = { withIsolatedDevPreparation };
