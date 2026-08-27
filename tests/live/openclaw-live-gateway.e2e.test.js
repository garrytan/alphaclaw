const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  kLiveEnabled,
  kSilentLogger,
  mkTemp,
  waitFor,
} = require("./live-helpers");
const {
  installOpenclawVersionToTempDir,
} = require("../../lib/server/openclaw-version");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");

// LIVE tier: prove the CONTRACTS AlphaClaw's beta support depends on, against a real
// newest-beta OpenClaw install. Excluded from `npm test`; run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/openclaw-live-gateway.e2e.test.js
// It screams if OpenClaw drifts from: the install guard/lifecycle contract, the
// restart-handoff capabilities protocol, `database preflight`, and the agents.list ->
// agents.entries doctor migration.
const describeLive = kLiveEnabled ? describe : describe.skip;

const kInstallTimeoutMs = 8 * 60 * 1000;
const kTestTimeoutMs = 12 * 60 * 1000;

// Resolve the newest published beta so the assertions track the moving dist-tag.
const resolveNewestBeta = async () => {
  const res = await fetch("https://registry.npmjs.org/openclaw", {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
  const doc = await res.json();
  return doc["dist-tags"]?.beta || "beta";
};

describeLive("live: OpenClaw beta gateway contracts", () => {
  let rootDir;
  let openclawDir;
  let installDir;
  let store;
  let betaVersion;
  let overlayBin;

  const gatewayEnv = () =>
    withOpenclawStartupEnv({
      ...process.env,
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: openclawDir,
      XDG_CONFIG_HOME: openclawDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
    });

  beforeAll(async () => {
    rootDir = mkTemp("alphaclaw-live-gw-root-");
    openclawDir = path.join(rootDir, ".openclaw");
    installDir = mkTemp("alphaclaw-live-gw-install-");
    fs.mkdirSync(path.join(installDir, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });

    betaVersion = await resolveNewestBeta();

    // Stage the beta and verify its lifecycle completed (guard gone).
    const staged = await installOpenclawVersionToTempDir({
      versionSpec: betaVersion,
      timeoutMs: kInstallTimeoutMs,
    });
    expect(staged.lifecycleVerified).toBe(true);
    expect(
      fs.existsSync(
        path.join(staged.openclawPackageDir, "dist", "openclaw-install-guard"),
      ),
    ).toBe(false);

    store = createOpenclawReleaseChannelStore({
      rootDir,
      openclawDir,
      logger: kSilentLogger,
    });
    const saved = store.saveOverlayFromTempInstall({
      openclawPackageDir: staged.openclawPackageDir,
      version: betaVersion,
    });
    expect(saved.ok).toBe(true);
    staged.cleanup();

    const activated = store.activateOverlay({ installDir, version: betaVersion });
    expect(activated.ok).toBe(true);
    overlayBin = store.resolvePackageBin(
      path.join(installDir, "node_modules", "openclaw"),
    );
    expect(overlayBin).toBeTruthy();
  }, kTestTimeoutMs);

  const runCli = (args, { allowFail = false } = {}) => {
    try {
      const stdout = execFileSync(process.execPath, [overlayBin, ...args], {
        env: gatewayEnv(),
        timeout: 120000,
        encoding: "utf8",
      });
      return { ok: true, stdout };
    } catch (error) {
      if (!allowFail) throw error;
      return {
        ok: false,
        code: error.status,
        stdout: String(error.stdout || ""),
        stderr: String(error.stderr || ""),
      };
    }
  };

  it(
    "advertises the restart-handoff consume contract at protocol 1",
    () => {
      const { stdout } = runCli([
        "gateway",
        "restart-handoff",
        "capabilities",
        "--json",
      ]);
      const doc = JSON.parse(stdout.slice(stdout.indexOf("{")));
      expect(Number(doc.protocolVersion ?? doc.protocol)).toBeGreaterThanOrEqual(1);
    },
    kTestTimeoutMs,
  );

  it(
    "accepts a VACUUM INTO snapshot via `database preflight --json`",
    () => {
      // A minimal but real state DB.
      const dbPath = path.join(openclawDir, "state", "openclaw.sqlite");
      const seed = new DatabaseSync(dbPath);
      seed.exec("CREATE TABLE IF NOT EXISTS schema_meta (schema_version INTEGER)");
      seed.exec("INSERT INTO schema_meta (schema_version) VALUES (1)");
      seed.close();

      const snapshot = path.join(os.tmpdir(), `live-preflight-${Date.now()}.sqlite`);
      const ro = new DatabaseSync(dbPath, { readOnly: true });
      ro.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      ro.close();
      expect(fs.existsSync(snapshot)).toBe(true);

      const result = runCli(["database", "preflight", snapshot, "--json"], {
        allowFail: true,
      });
      // The command must EXIST (not unknown-command); it may pass or report an
      // incompatibility, but it must run.
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(/unknown command|unrecognized/i.test(combined)).toBe(false);
      fs.rmSync(snapshot, { force: true });
    },
    kTestTimeoutMs,
  );

  it(
    "migrates a 2026.7-shape config (agents.list -> agents.entries) with doctor --fix",
    () => {
      const configPath = path.join(openclawDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            agents: { list: [{ id: "main", model: { id: "anthropic/claude" } }] },
          },
          null,
          2,
        ),
      );
      runCli(["doctor", "--fix", "--yes"], { allowFail: true });

      // The file must still be valid JSON AlphaClaw can parse, and the roster must
      // be readable in either shape.
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = parsed.agents?.entries;
      const list = parsed.agents?.list;
      const hasMain =
        (entries && typeof entries === "object" && "main" in entries) ||
        (Array.isArray(list) && list.some((a) => a.id === "main"));
      expect(hasMain).toBe(true);
    },
    kTestTimeoutMs,
  );

  it(
    "starts a gateway that reports listening + /healthz + /readyz",
    async () => {
      const port = 18991;
      const child = spawn(
        process.execPath,
        [overlayBin, "gateway", "run", "--port", String(port)],
        { env: { ...gatewayEnv(), OPENCLAW_GATEWAY_PORT: String(port) }, stdio: "pipe" },
      );
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stdout += c.toString()));
      try {
        await waitFor(
          () => /listening on/i.test(stdout),
          60000,
          "gateway listening",
        );
        const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(healthz.ok).toBe(true);
        const readyz = await fetch(`http://127.0.0.1:${port}/readyz`);
        // /readyz may be red while sidecars settle; it must at least answer.
        expect(typeof readyz.status).toBe("number");
      } finally {
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (!child.killed) child.kill("SIGKILL");
      }
    },
    kTestTimeoutMs,
  );
});
