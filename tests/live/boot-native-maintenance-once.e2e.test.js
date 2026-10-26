// LIVE TIER — boot native maintenance (the Codex migration and the Codex
// plugin reconciliation) runs once per OpenClaw build, against the REAL
// pinned OpenClaw (ALPH-44). A first boot runs both helpers and records the
// build; a same-build reboot skips them; a config with a legacy Codex auth
// profile, and a record from another OpenClaw build, run them again.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { kLiveEnabled, mkTemp, repoBinDir, scrubTestRunnerEnv, waitFor, readDeclaredPin } = require("./live-helpers");

const describeLive = kLiveEnabled ? describe : describe.skip;
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const kRunning = "[alphaclaw] Codex migration and plugin reconciliation running: ";
const kSkipped = "[alphaclaw] Codex migration and plugin reconciliation skipped: ";
const kReconciled = "[alphaclaw] Codex plugin reconciliation completed";

describeLive(`LIVE boot native maintenance once per build on the ${readDeclaredPin()} pin`, () => {
  let root;
  let stateDir;
  let configPath;
  let stampPath;
  let env;
  let base;
  let server = null;
  let lines = [];

  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 30_000);
      server.once("exit", () => { clearTimeout(timer); resolve(); });
      server.kill("SIGTERM");
    });
  };

  // One AlphaClaw boot to a running gateway. Every output line is kept with
  // its arrival time, which times the maintenance step from the outside.
  const boot = async () => {
    lines = [];
    const startedAt = Date.now();
    server = spawn(process.execPath, [path.resolve(__dirname, "../../bin/alphaclaw.js"), "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    const onData = (data) => {
      pending += data;
      const parts = pending.split("\n");
      pending = parts.pop();
      for (const text of parts) lines.push({ at: Date.now(), text });
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    try {
      await waitFor(async () => {
        if (server.exitCode !== null) throw new Error(`AlphaClaw exited ${server.exitCode}`);
        try {
          const res = await fetch(`${base}/health`);
          const body = await res.json();
          return res.ok && ["running", "up"].includes(body.gateway);
        } catch { return false; }
      }, 240_000, "AlphaClaw and pinned gateway readiness");
    } catch (error) {
      throw new Error(`${error.message}\n${lines.slice(-80).map((line) => line.text).join("\n")}`);
    }
    const find = (prefix) => lines.find((line) => line.text.includes(prefix));
    const running = find(kRunning);
    const reconciled = find(kReconciled);
    return {
      readyMs: Date.now() - startedAt,
      running: running ? running.text.slice(running.text.indexOf(kRunning) + kRunning.length) : null,
      skipped: find(kSkipped)?.text || null,
      maintenanceMs: running && reconciled ? reconciled.at - running.at : null,
      diagnostics: lines.filter((line) => /Codex (migration|plugin reconciliation) (completed with diagnostics|process failed)/.test(line.text)).map((line) => line.text),
    };
  };

  beforeAll(async () => {
    root = mkTemp("alphaclaw-live-native-once-");
    stateDir = path.join(root, ".openclaw");
    configPath = path.join(stateDir, "openclaw.json");
    stampPath = path.join(stateDir, ".alphaclaw", "codex-maintenance.json");
    fs.mkdirSync(stateDir, { recursive: true });
    const port = await freePort();
    const gatewayPort = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = {
      ...scrubTestRunnerEnv(), HOME: root, ALPHACLAW_ROOT_DIR: root, OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, XDG_CONFIG_HOME: stateDir,
      OPENCLAW_NO_AUTO_UPDATE: "1", OPENCLAW_SKIP_CHANNELS: "1", ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "1", ALPHACLAW_SKIP_PROFILE_ENV: "1",
      ALPHACLAW_GIT_SHIM_PATH: path.join(root, "bin", "git"), ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(root, "bin", "openclaw"),
      ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(root, "profile.d", "alphaclaw-openclaw.sh"),
      PORT: String(port), OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token", SETUP_PASSWORD: "synthetic-setup-password",
      ALPHACLAW_ALLOW_LEGACY_LOGIN: "1", ALPHACLAW_SETUP_URL: base,
      PATH: `${repoBinDir()}:${process.env.PATH}`,
    };
    delete env.OPENCLAW_GIT_DIR;
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token: "synthetic-gateway-token" } },
      agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
      plugins: { allow: [] },
    }));
    fs.writeFileSync(path.join(root, "onboarded.json"), JSON.stringify({ onboarded: true }));
  }, 60_000);
  afterAll(async () => { await stop(); }, 60_000);

  it("runs on the first boot, skips a same-build reboot, and runs again for a legacy profile or another build", { timeout: 15 * 60_000, retry: 0 }, async () => {
    const pin = readDeclaredPin();
    const report = {};

    // A fresh install's first boot writes AlphaClaw's defaults into
    // openclaw.json after the helpers ran. Converge it once, then drop the
    // record: that is a box upgrading from an AlphaClaw without the stamp.
    report.fresh = await boot();
    await stop();
    fs.rmSync(stampPath, { force: true });

    report.first = await boot();
    expect(report.first.running).toBe("no record of a completed run");
    expect(report.first.maintenanceMs).toBeGreaterThan(0);
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    expect(stamp.inputs.openclawBuild.startsWith(`${pin}-`) || stamp.inputs.openclawBuild === pin).toBe(true);
    await stop();

    report.second = await boot();
    expect(report.second.running).toBe(null);
    expect(report.second.skipped).toContain(`already done for OpenClaw ${stamp.inputs.openclawBuild}`);
    expect(report.second.diagnostics).toEqual([]);
    await stop();

    // An unmigrated config: the deprecated Codex profile id AlphaClaw's own
    // Connect Codex writes. The migration must run and rewrite it.
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.auth = { profiles: { "openai:codex-cli": { provider: "openai", mode: "oauth" } } };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    report.legacy = await boot();
    expect(report.legacy.running).toBe("openclaw.json changed");
    expect(Object.keys(JSON.parse(fs.readFileSync(configPath, "utf8")).auth?.profiles || {})).not.toContain("openai:codex-cli");
    await stop();

    // A record from another OpenClaw build stands for a pin change.
    const recorded = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    fs.writeFileSync(stampPath, JSON.stringify({ ...recorded, inputs: { ...recorded.inputs, openclawBuild: "2026.10.6-release-0000000" } }));
    report.otherBuild = await boot();
    expect(report.otherBuild.running).toBe("OpenClaw build changed");
    await stop();

    report.third = await boot();
    expect(report.third.running).toBe(null);
    expect(report.third.skipped).not.toBe(null);

    console.log(`[live] native maintenance once per build: ${JSON.stringify(report)}`);
  });
});
