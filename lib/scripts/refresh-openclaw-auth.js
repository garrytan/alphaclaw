const { resolveCodexMigrationBuild, loadOpenclawMigrationApi } = require("../server/openclaw-codex-migration-runtime");
const { isValidAgentId } = require("../server/agents/shared");

const refresh = async () => {
  const agentId = process.argv[2] || "main";
  if (!isValidAgentId(agentId)) throw new Error("Invalid agent id");
  const build = resolveCodexMigrationBuild({ configPath: process.env.OPENCLAW_CONFIG_PATH, env: process.env });
  const api = await loadOpenclawMigrationApi({ build, prefix: "auth-refresh", functionNames: ["refreshRunningGatewayAuthState"] });
  const result = await api.refreshRunningGatewayAuthState(agentId === "main" ? undefined : agentId, "update", { error() {} });
  process.stdout.write(JSON.stringify({ refreshed: result === "refreshed" }));
};

refresh().catch(() => { process.exitCode = 1; });
