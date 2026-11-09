const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { kLiveEnabled, mkTemp, scrubTestRunnerEnv, runCliJson, repoOpenclawBin, repoBinDir } = require("./live-helpers");
const { createCommands } = require("../../lib/server/commands");
const { createSecretDropApplier } = require("../../lib/server/secret-drop/apply");
const { decideGatewayPublicOrigin } = require("../../lib/server/gateway-public-origin");

// LIVE tier: the secret drop's OpenClaw side against the pinned CLI. The
// value goes to `openclaw secrets store set` on stdin; a new name becomes a
// secret entry and an existing entry keeps its kind. The gateway.publicOrigin
// AlphaClaw writes is one the pinned schema accepts, and the http LAN origin
// it skips is one the schema refuses. Run:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/secret-drop-store.e2e.test.js
const describeLive = kLiveEnabled ? describe : describe.skip;

const kCanary = "liveCanary-9f3Kq2Lz8Wp1";

const makeState = (config = {}) => {
  const root = mkTemp("alphaclaw-live-secret-drop-");
  const stateDir = path.join(root, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
  const env = scrubTestRunnerEnv({
    PATH: `${repoBinDir()}:${process.env.PATH || ""}`,
    HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  });
  return { stateDir, env };
};

const runCli = (args, { env, input = null }) =>
  spawnSync(process.execPath, [repoOpenclawBin(), ...args], { encoding: "utf8", timeout: 120_000, env, ...(input === null ? {} : { input }) });

describeLive("secret drop against the pinned OpenClaw", () => {
  it("stores a new name as a secret from stdin, keeps an existing env entry's kind, and never lists a secret's value", async () => {
    const { env } = makeState();
    expect(runCli(["secrets", "store", "set", "KEPT_SETTING", "--kind", "env"], { env, input: "old" }).status).toBe(0);
    const { execFileCmd } = createCommands({ gatewayEnv: () => env });
    const envWrites = [];
    const applier = createSecretDropApplier({
      execFileCmd,
      gatewayEnv: () => env,
      readEnvFile: () => [],
      setEnvKey: async (req, key, value) => envWrites.push({ key, value }),
      resolveEnvKeyReach: () => "never",
    });

    const fresh = await applier.apply({ req: {}, name: "LIVE_DROP_TOKEN", rawValue: `${kCanary}\n` });
    expect(fresh).toMatchObject({ status: "stored", stores: { env: true, store: true }, reach: { storeKind: "secret" } });
    const kept = await applier.apply({ req: {}, name: "KEPT_SETTING", rawValue: "new-value" });
    expect(kept).toMatchObject({ status: "stored", keptKind: "env", reach: { storeKind: "env" } });
    expect(envWrites).toEqual([
      { key: "LIVE_DROP_TOKEN", value: kCanary },
      { key: "KEPT_SETTING", value: "new-value" },
    ]);

    const listing = runCliJson(repoOpenclawBin(), ["secrets", "store", "list", "--json"], { env });
    const byName = new Map(listing.map((row) => [row.name, row]));
    expect(byName.get("LIVE_DROP_TOKEN").kind).toBe("secret");
    expect(byName.get("KEPT_SETTING").kind).toBe("env");
    expect(JSON.stringify(listing)).not.toContain(kCanary.slice(0, 8));
    const get = runCli(["secrets", "store", "get", "KEPT_SETTING"], { env });
    expect(get.stdout.trim()).toBe("KEPT_SETTING=new-value");
  }, 180_000);

  it.each([
    ["https://box.example.com", {}, true],
    ["http://localhost:3000", {}, true],
    ["http://192.168.1.20:3000", {}, false],
    ["https://box.portals.example.com", { portals: { ingress: { domain: "portals.example.com", port: 8443 } } }, false],
  ])("publicOrigin from %s is written only when the pinned schema accepts it", (setupUrl, gateway, written) => {
    const decision = decideGatewayPublicOrigin({ gateway }, setupUrl);
    expect(Boolean(decision.write)).toBe(written);
    const candidate = { gateway: { ...gateway, publicOrigin: new URL(setupUrl).origin } };
    const { env } = makeState(candidate);
    const result = runCliJson(repoOpenclawBin(), ["config", "validate", "--json"], { env, exits: [0, 1] });
    expect(result.valid).toBe(written);
  }, 180_000);
});
