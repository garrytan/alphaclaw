const { resolveCodexMigrationBuild, loadOpenclawMigrationApi } = require("../server/openclaw-codex-migration-runtime");
const path = require("node:path");
const { isValidAgentId } = require("../server/agents/shared");
const { resolveDeclaredSchemaVersions, readSqliteUserVersion } = require("../server/openclaw-schema-versions");

const initialize = async () => {
  const build = resolveCodexMigrationBuild({ configPath: process.env.OPENCLAW_CONFIG_PATH, env: process.env });
  const declared = resolveDeclaredSchemaVersions(build?.packageDir);
  if (!declared.agent && build?.source !== "dev") {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(build?.version || "");
    if (!match) throw new Error("Cannot determine the installed auth store contract");
    if (Number(match[1]) < 2026 || (Number(match[1]) === 2026 && Number(match[2]) < 8)) return;
  }
  const agentId = process.argv[2] || "main";
  if (!isValidAgentId(agentId)) throw new Error("Invalid agent id");
  const agentDir = agentId === "main" ? undefined : path.join(process.env.OPENCLAW_STATE_DIR, "agents", agentId, "agent");
  for (const [kind, file] of [
    ["state", path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite")],
    ["agent", path.join(process.env.OPENCLAW_STATE_DIR, "agents", agentId, "agent", "openclaw-agent.sqlite")],
  ]) {
    const found = readSqliteUserVersion(file);
    if (found.status === "missing") continue;
    if (found.status !== "ok" || found.userVersion !== declared[kind]) {
      throw new Error("Auth initialization requires the existing boot migration guard");
    }
  }
  const api = await loadOpenclawMigrationApi({ build, prefix: "sqlite", functionNames: ["runAuthProfileWriteTransaction"] });
  api.runAuthProfileWriteTransaction(agentDir, () => {}, { env: process.env });
};

initialize().catch(() => {
  console.error("OpenClaw fresh auth store initialization failed; no credentials were written");
  process.exitCode = 1;
});
