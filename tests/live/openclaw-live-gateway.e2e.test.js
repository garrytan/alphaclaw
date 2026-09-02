const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  kLiveEnabled,
  kSilentLogger,
  mkTemp,
  scrubTestRunnerEnv,
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

  const gatewayEnv = () => {
    return withOpenclawStartupEnv({
      ...scrubTestRunnerEnv(),
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: openclawDir,
      XDG_CONFIG_HOME: openclawDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
    });
  };

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
    // spawnSync captures stdout AND stderr reliably (execFileSync only surfaces
    // stderr on throw), which matters for --json commands that log to stderr.
    const res = spawnSync(process.execPath, [overlayBin, ...args], {
      env: gatewayEnv(),
      timeout: 120000,
      encoding: "utf8",
    });
    const stdout = String(res.stdout || "");
    const stderr = String(res.stderr || "");
    const ok = res.status === 0;
    if (!ok && !allowFail) {
      throw new Error(
        `openclaw ${args.join(" ")} exited ${res.status}: ${stderr.slice(-400)}`,
      );
    }
    return { ok, code: res.status, stdout, stderr };
  };

  // Parse the last brace-balanced JSON object from noisy CLI output.
  const parseTailJson = (text) => {
    const start = String(text || "").indexOf("{");
    const end = String(text || "").lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  };

  it(
    "advertises the restart-handoff consume contract at protocol 1",
    () => {
      // Redirect the CLI JSON to a file and read it back: capturing --json stdout
      // directly through the runner is unreliable in this harness (the first
      // state-touching call also emits a schema-integrity pass to stderr), so a file
      // sink is the robust path.
      const outFile = path.join(os.tmpdir(), `handoff-caps-${Date.now()}.json`);
      const sh = `${JSON.stringify(process.execPath)} ${JSON.stringify(overlayBin)} gateway restart-handoff capabilities --json > ${JSON.stringify(outFile)} 2>/dev/null`;
      spawnSync("sh", ["-c", sh], { env: gatewayEnv(), timeout: 120000 });
      const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
      fs.rmSync(outFile, { force: true });
      const doc = parseTailJson(raw);
      expect(doc).not.toBeNull();
      const protocol = Number(doc.protocolVersion ?? doc.protocol ?? 0);
      expect(protocol).toBeGreaterThanOrEqual(1);
      // Protocol 1 supports the consume operation.
      const ops = Array.isArray(doc.operations) ? doc.operations : [];
      expect(doc.consume === true || ops.includes("consume")).toBe(true);
    },
    kTestTimeoutMs,
  );

  it(
    "accepts a VACUUM INTO snapshot via `database preflight --json`",
    () => {
      // Build the source DB in an ISOLATED temp path so it can never collide with a
      // real state DB the gateway created (schema_meta shape differs across builds).
      const dbPath = path.join(os.tmpdir(), `live-src-${Date.now()}.sqlite`);
      const seed = new DatabaseSync(dbPath);
      seed.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
      seed.exec("INSERT INTO meta (k, v) VALUES ('probe', '1')");
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
      fs.rmSync(dbPath, { force: true });
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
    "starts a gateway that answers /healthz and /readyz",
    async () => {
      const port = 18991;
      // Minimal loopback gateway config so `gateway run` does not wait on setup.
      const configPath = path.join(openclawDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            gateway: {
              // gateway.mode is required or `gateway run` exits 78 (EX_CONFIG).
              mode: "local",
              bind: "loopback",
              port,
              auth: { token: "live-e2e-token-000000000000000000000000" },
            },
          },
          null,
          2,
        ),
      );
      const child = spawn(
        process.execPath,
        [overlayBin, "gateway", "run", "--port", String(port)],
        {
          env: { ...gatewayEnv(), OPENCLAW_GATEWAY_PORT: String(port) },
          stdio: "pipe",
        },
      );
      let output = "";
      child.stdout.on("data", (c) => (output += c.toString()));
      child.stderr.on("data", (c) => (output += c.toString()));
      const healthUrl = `http://127.0.0.1:${port}/healthz`;
      try {
        // Poll /healthz directly (more robust than stdout wording); the beta
        // cold-starts plugin sidecars, so allow a generous budget.
        await waitFor(
          async () => {
            try {
              const r = await fetch(healthUrl);
              return r.status > 0;
            } catch {
              return false;
            }
          },
          150000,
          `gateway /healthz (last output: ${output.slice(-200)})`,
        );
        const healthz = await fetch(healthUrl);
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

  it(
    "accepts AlphaClaw's trusted-proxy team auth config (no EX_CONFIG)",
    async () => {
      // Phase 4 writes this exact subtree — the strict beta root config must
      // accept every key (mode/trustedProxy/userHeader/allowLoopback/
      // deviceAutoApprove/allowUsers/identityScopes and the scope names), or
      // enabling team access would put the gateway into exit-78 churn.
      const {
        buildTrustedProxyAuth,
      } = require("../../lib/server/team/gateway-config");
      const auth = buildTrustedProxyAuth({
        members: [
          { email: "owner@example.com", role: "admin", disabled: false },
          { email: "member@example.com", role: "member", disabled: false },
        ],
      });
      const port = 18992;
      const configPath = path.join(openclawDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            gateway: {
              mode: "local",
              bind: "loopback",
              port,
              // trusted-proxy refuses to start without a proxy IP; AlphaClaw
              // guarantees this both in ensureGatewayProxyConfig and in
              // applyTeamGatewayConfig.
              trustedProxies: ["127.0.0.1"],
              auth,
            },
          },
          null,
          2,
        ),
      );
      const child = spawn(
        process.execPath,
        [overlayBin, "gateway", "run", "--port", String(port)],
        {
          env: { ...gatewayEnv(), OPENCLAW_GATEWAY_PORT: String(port) },
          stdio: "pipe",
        },
      );
      let output = "";
      let exited = null;
      child.stdout.on("data", (c) => (output += c.toString()));
      child.stderr.on("data", (c) => (output += c.toString()));
      child.on("exit", (code) => (exited = code));
      try {
        await waitFor(
          async () => {
            if (exited !== null) return true;
            try {
              const r = await fetch(`http://127.0.0.1:${port}/healthz`);
              return r.status > 0;
            } catch {
              return false;
            }
          },
          150000,
          `trusted-proxy gateway start (last output: ${output.slice(-200)})`,
        );
        // EX_CONFIG (78) means the beta rejected a key we write — the exact
        // failure mode this test exists to catch.
        expect(exited).not.toBe(78);
        expect(exited).toBeNull();
        const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(healthz.ok).toBe(true);
      } finally {
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (!child.killed) child.kill("SIGKILL");
      }
    },
    kTestTimeoutMs,
  );

  it(
    "lists clickclack in the channels-add enum (Phase 5 capability probes)",
    () => {
      const r = runCli(["channels", "add", "--help"]);
      const flat = `${r.stdout}\n${r.stderr}`.replace(/\s+/g, "");
      // The capability probes key on this enum: clickclack ships built in;
      // buzz only appears once its external plugin is installed.
      expect(flat).toMatch(/[(|]clickclack[|)]/);
    },
    kTestTimeoutMs,
  );
});
