// LIVE TIER — the agents roster AlphaClaw writes must pass the REAL pinned
// OpenClaw validator. OpenClaw 2026.10.1 turned `agents.list` and every
// boolean `agents.entries.*.default` marker into blocking config errors
// (legacy-*.mjs LEGACY_AGENT_ROSTER_RULES) and requires
// `agents.ownership: "explicit"` on multi-agent rosters. A marker written by
// any roster save made the next gateway start exit 78 and every CLI command
// refuse; the hermetic suites cannot see that, only the pinned validator can.
//
// Drives AlphaClaw's own agents domain (create / set default / update)
// against a real temp OpenClaw dir and runs `openclaw config
// validate --json` after every write, then replays the issue #126 loop: a
// legacy roster migrated by the pinned `doctor --fix`, followed by an
// AlphaClaw save.
//
// Requires: a supported Node; offline (no install). Runtime: ~1 min.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const liveHelpers = require("./live-helpers");

const { createAgentsService } = require("../../lib/server/agents/service");

const { kLiveEnabled, mkTemp, repoOpenclawBin, scrubTestRunnerEnv } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 5 * 60 * 1000;

const createBox = () => {
  const root = mkTemp("alphaclaw-live-roster-");
  const openclawDir = path.join(root, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  const configPath = path.join(openclawDir, "openclaw.json");
  const env = scrubTestRunnerEnv({
    PATH: process.env.PATH,
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: openclawDir,
    OPENCLAW_CONFIG_PATH: configPath,
  });
  const writeConfig = (config) => fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const cli = (args) =>
    spawnSync(process.execPath, [repoOpenclawBin(), ...args], {
      encoding: "utf8",
      timeout: 180_000,
      env,
    });
  const expectValid = (step) => {
    const result = cli(["config", "validate", "--json"]);
    let report = null;
    try {
      report = JSON.parse(result.stdout);
    } catch {}
    const detail = `${step}: exit ${result.status}\nstdout: ${result.stdout}\nstderr: ${String(result.stderr).slice(-1200)}\nconfig: ${fs.readFileSync(configPath, "utf8")}`;
    expect(report?.valid, detail).toBe(true);
    expect(result.status, detail).toBe(0);
  };
  const service = createAgentsService({
    fs,
    OPENCLAW_DIR: openclawDir,
    readEnvFile: () => [],
    writeEnvFile: () => {},
    reloadEnv: () => {},
    restartGateway: async () => {},
    clawCmd: async () => ({ ok: true, stdout: "", stderr: "" }),
  });
  return { root, openclawDir, writeConfig, readConfig, cli, expectValid, service };
};

describeLive("live: AlphaClaw's roster writes against the pinned validator", () => {
  it(
    "create, set default and update keep openclaw.json valid (a delete is OpenClaw's own agents.delete: agent-delete.e2e)",
    async () => {
      const box = createBox();
      box.writeConfig({
        gateway: { port: 47913 },
        channels: { telegram: { enabled: true, botToken: "123456:live-roster-fixture" } },
        agents: { entries: { main: { workspace: path.join(box.openclawDir, "workspace") } } },
      });
      box.expectValid("seed");

      box.service.createAgent({ id: "ops" });
      box.expectValid("createAgent ops");
      expect(box.readConfig()).toMatchObject({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" }, heartbeat: { agentId: "main" } },
        },
        talk: { agentId: "main" },
        bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "*" } }],
      });

      box.service.setDefaultAgent("ops");
      box.expectValid("setDefaultAgent ops");
      expect(box.readConfig().agents.defaults.systemAgent).toEqual({ agentId: "ops" });

      await box.service.updateAgent("main", { name: "Main" });
      box.expectValid("updateAgent main");

      box.service.setDefaultAgent("main");
      box.expectValid("setDefaultAgent main");
      expect(Object.keys(box.readConfig().agents.entries)).toEqual(["main", "ops"]);
    },
    kTestTimeoutMs,
  );

  it(
    "an AlphaClaw save after the pinned doctor --fix migrates a legacy roster stays valid (#126 loop)",
    async () => {
      const box = createBox();
      box.writeConfig({
        gateway: { port: 47914 },
        agents: {
          entries: {
            main: { default: true, workspace: path.join(box.openclawDir, "workspace") },
            second: { workspace: path.join(box.openclawDir, "workspace-second") },
          },
        },
      });
      const doctor = box.cli(["doctor", "--fix", "--yes", "--non-interactive"]);
      expect(doctor.status, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
      box.expectValid("after doctor --fix");

      box.service.createAgent({ id: "third" });
      box.expectValid("createAgent third after doctor");
      await box.service.updateAgent("second", { name: "Second" });
      box.expectValid("updateAgent second after doctor");
      expect(box.service.listAgents().find((agent) => agent.default).id).toBe("main");
    },
    kTestTimeoutMs,
  );
});
