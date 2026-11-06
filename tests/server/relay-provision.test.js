const fs = require("fs");
const os = require("os");
const path = require("path");
const { relayPaths } = require("../../lib/server/relay/constants");
const {
  ensureRelayDir,
  ensureInternalSecret,
  provisionRelay,
  readRelaySecrets,
  resolveBoxAgentName,
} = require("../../lib/server/relay/provision");
const { readRelayConfig } = require("../../lib/server/relay/config");

const quiet = { log: () => {}, warn: () => {} };

const createFakeClient = () => {
  const agents = new Map();
  let workspaces = 0;
  let tokenSeq = 0;
  const client = {
    workspaces: () => workspaces,
    agents,
    createWorkspace: vi.fn(async (secret) => {
      if (!secret || secret.length < 32) throw Object.assign(new Error("unauthorized"), { engineStatus: 401 });
      workspaces += 1;
      return { workspace_id: "ws" + workspaces, api_key: "rk_live_" + workspaces };
    }),
    registerAgent: vi.fn(async (key, name) => {
      if (agents.has(name)) throw Object.assign(new Error("exists"), { engineStatus: 409 });
      const token = "at_live_" + ++tokenSeq;
      agents.set(name, token);
      return { name, token };
    }),
    deleteAgent: vi.fn(async (key, name) => {
      agents.delete(name);
    }),
    inbox: vi.fn(async (token) => {
      if (![...agents.values()].includes(token)) throw Object.assign(new Error("unauthorized"), { engineStatus: 401 });
      return { unread_dms: [] };
    }),
  };
  return client;
};

describe("relay provisioning", () => {
  let root;
  let paths;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-prov-"));
    paths = relayPaths(root);
    ensureRelayDir(paths);
    ensureInternalSecret(paths);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("creates the directory 0700 and the internal secret 0600, once", () => {
    expect(fs.statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.internalSecretFile).mode & 0o777).toBe(0o600);
    const secret = fs.readFileSync(paths.internalSecretFile, "utf8");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureInternalSecret(paths)).toBe(false);
    expect(fs.readFileSync(paths.internalSecretFile, "utf8")).toBe(secret);
  });

  it("first boot creates one workspace and the box agent, written 0600; a second boot reuses both", async () => {
    const client = createFakeClient();
    const first = await provisionRelay({ client, paths, agentName: "wintermute", engineDbExistedAtStart: false, logger: quiet });
    expect(first).toMatchObject({ workspaceId: "ws1", workspaceKey: "rk_live_1", agentName: "wintermute", agentToken: "at_live_1" });
    expect(fs.statSync(paths.secretsFile).mode & 0o777).toBe(0o600);
    expect(readRelaySecrets(paths)).toMatchObject({ version: 1, state: "ready", boxAgent: "wintermute" });
    const second = await provisionRelay({ client, paths, agentName: "wintermute", engineDbExistedAtStart: true, logger: quiet });
    expect(second).toEqual(first);
    expect(client.workspaces()).toBe(1);
    expect(client.registerAgent).toHaveBeenCalledTimes(1);
  });

  it("a database with no secrets beside it is secrets_missing, never a second workspace", async () => {
    const client = createFakeClient();
    await expect(
      provisionRelay({ client, paths, agentName: "wintermute", engineDbExistedAtStart: true, logger: quiet }),
    ).rejects.toMatchObject({ code: "secrets_missing" });
    expect(client.createWorkspace).not.toHaveBeenCalled();
  });

  it("an interrupted first provisioning (state creating) resumes even though the database now exists", async () => {
    fs.writeFileSync(paths.secretsFile, JSON.stringify({ version: 1, state: "creating" }), { mode: 0o600 });
    const client = createFakeClient();
    await expect(
      provisionRelay({ client, paths, agentName: "wintermute", engineDbExistedAtStart: true, logger: quiet }),
    ).resolves.toMatchObject({ workspaceKey: "rk_live_1" });
  });

  it("a refused agent token is replaced, and a name already taken is deleted and registered again", async () => {
    const client = createFakeClient();
    await provisionRelay({ client, paths, agentName: "wintermute", engineDbExistedAtStart: false, logger: quiet });
    client.agents.set("wintermute", "at_live_rotated_elsewhere");
    const again = await provisionRelay({ client, paths, agentName: "wintermute", engineDbExistedAtStart: true, logger: quiet });
    expect(client.deleteAgent).toHaveBeenCalledWith("rk_live_1", "wintermute");
    expect(again.agentToken).toBe(client.agents.get("wintermute"));
    expect(readRelaySecrets(paths).agents.wintermute.token).toBe(again.agentToken);
  });

  it("the box agent's name is chosen once; only ALPHACLAW_RELAY_AGENT_NAME moves it", () => {
    const stored = { boxAgent: "wintermute" };
    expect(resolveBoxAgentName({ secrets: stored, config: readRelayConfig({ env: {}, defaultAgentLabel: "Renamed Bot" }) })).toBe("wintermute");
    expect(resolveBoxAgentName({ secrets: null, config: readRelayConfig({ env: {}, defaultAgentLabel: "Wintermute" }) })).toBe("wintermute");
    expect(resolveBoxAgentName({ secrets: stored, config: readRelayConfig({ env: { ALPHACLAW_RELAY_AGENT_NAME: "box-two" } }) })).toBe("box-two");
  });
});
