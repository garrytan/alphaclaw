const fs = require("fs");
const crypto = require("crypto");
const { writeFileAtomic } = require("../utils/safe-file");
const { RelayError } = require("./errors");

// First-boot provisioning of the relay: the relay directory (0700), the
// engine's internal secret in its own 0600 file (the engine reads it through
// RELAYCAST_INTERNAL_SECRET_FILE), the single workspace and the box agent's
// token in secrets.json (0600). Idempotent: an existing workspace key and a
// token that still works are reused.
//
// A relay database with no keys beside it is secrets_missing, never a quiet
// second workspace: that would orphan every earlier message. The one
// exception is our own interrupted provisioning, which leaves secrets.json
// with state "creating" before it asks the engine for a workspace.
const kSecretsVersion = 1;

const ensureRelayDir = (paths, fsModule = fs) => {
  fsModule.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try {
    fsModule.chmodSync(paths.dir, 0o700);
  } catch {}
};

const ensureInternalSecret = (paths, fsModule = fs) => {
  try {
    const existing = fsModule.readFileSync(paths.internalSecretFile, "utf8").trim();
    if (existing.length >= 32) return false;
  } catch {}
  writeFileAtomic(paths.internalSecretFile, crypto.randomBytes(32).toString("hex"), { fsModule, mode: 0o600 });
  return true;
};

const readInternalSecret = (paths, fsModule = fs) => fsModule.readFileSync(paths.internalSecretFile, "utf8").trim();

const readRelaySecrets = (paths, fsModule = fs) => {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(paths.secretsFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const writeRelaySecrets = (paths, secrets, fsModule = fs) =>
  writeFileAtomic(paths.secretsFile, JSON.stringify({ version: kSecretsVersion, ...secrets }, null, 2) + "\n", {
    fsModule,
    mode: 0o600,
  });

// The box agent's relay name is chosen once, at first provisioning, and kept
// in secrets.json: renaming the OpenClaw agent later must not move it to a new
// relay identity with an empty history. ALPHACLAW_RELAY_AGENT_NAME overrides.
const resolveBoxAgentName = ({ secrets, config }) =>
  config.agentNameFromEnv ? config.agentName : secrets?.boxAgent || config.agentName;

const readAgentToken = (paths, agentName, fsModule = fs) => {
  const token = readRelaySecrets(paths, fsModule)?.agents?.[agentName]?.token;
  return typeof token === "string" && token ? token : null;
};

const tokenWorks = async (client, token) => {
  try {
    await client.inbox(token);
    return true;
  } catch (error) {
    if (error?.engineStatus === 401 || error?.engineStatus === 403) return false;
    throw error;
  }
};

const provisionRelay = async ({
  client,
  paths,
  agentName,
  agentPersona = "",
  engineDbExistedAtStart,
  fsModule = fs,
  now = () => new Date().toISOString(),
  logger = console,
}) => {
  let secrets = readRelaySecrets(paths, fsModule);
  if (!secrets?.workspaceKey) {
    if (engineDbExistedAtStart && secrets?.state !== "creating") {
      throw new RelayError(
        "secrets_missing",
        "relay/relaycast.db exists but relay/secrets.json is missing or unreadable.",
      );
    }
    writeRelaySecrets(paths, { state: "creating", startedAt: now() }, fsModule);
    const workspace = await client.createWorkspace(readInternalSecret(paths, fsModule), "alphaclaw");
    if (!workspace?.api_key || !workspace?.workspace_id) {
      throw new RelayError("provisioning_failed", "The relay engine created a workspace but returned no key.");
    }
    secrets = {
      state: "ready",
      workspaceId: String(workspace.workspace_id),
      workspaceKey: workspace.api_key,
      createdAt: now(),
      agents: {},
    };
    writeRelaySecrets(paths, secrets, fsModule);
    logger.log("[relay] workspace created");
  }

  const agents = { ...(secrets.agents || {}) };
  let token = agents[agentName]?.token || null;
  if (token && !(await tokenWorks(client, token))) {
    logger.warn("[relay] agent " + agentName + "'s token was refused; registering it again");
    token = null;
  }
  if (!token) {
    let registered;
    try {
      registered = await client.registerAgent(secrets.workspaceKey, agentName, agentPersona);
    } catch (error) {
      if (error?.engineStatus !== 409) throw error;
      await client.deleteAgent(secrets.workspaceKey, agentName);
      registered = await client.registerAgent(secrets.workspaceKey, agentName, agentPersona);
    }
    if (!registered?.token) throw new RelayError("provisioning_failed", "The relay engine registered " + agentName + " but returned no token.");
    token = registered.token;
    agents[agentName] = { token, createdAt: now() };
    secrets = { ...secrets, agents, boxAgent: agentName };
    writeRelaySecrets(paths, secrets, fsModule);
    logger.log("[relay] agent " + agentName + " registered");
  } else if (secrets.boxAgent !== agentName) {
    secrets = { ...secrets, boxAgent: agentName };
    writeRelaySecrets(paths, secrets, fsModule);
  }
  return {
    workspaceId: secrets.workspaceId,
    workspaceKey: secrets.workspaceKey,
    agentName,
    agentToken: token,
  };
};

module.exports = {
  ensureRelayDir,
  ensureInternalSecret,
  readInternalSecret,
  readRelaySecrets,
  writeRelaySecrets,
  readAgentToken,
  resolveBoxAgentName,
  provisionRelay,
};
