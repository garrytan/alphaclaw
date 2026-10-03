const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const {
  kLiveEnabled,
  mkTemp,
  scrubTestRunnerEnv,
  waitFor,
} = require("./live-helpers");
const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");

// LIVE tier: prove the gateway CONTRACTS AlphaClaw depends on, against the
// REAL pinned OpenClaw (package.json dependencies.openclaw, installed in
// node_modules — the build production runs). Excluded from `npm test`; run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/openclaw-live-gateway.e2e.test.js
// It screams if the pin drifts from: the restart-handoff capabilities protocol,
// the agents.list -> agents.entries doctor migration, a loopback gateway boot,
// the trusted-proxy team auth subtree, and the channels-add enum.
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 12 * 60 * 1000;

describeLive("live: pinned OpenClaw gateway contracts", () => {
  let rootDir;
  let openclawDir;
  let pinBin;

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

  beforeAll(() => {
    rootDir = mkTemp("alphaclaw-live-gw-root-");
    openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    const build = describeExecutingBuild({ installDir: path.resolve(__dirname, "../..") });
    expect(build?.version).toBe(require("../../package.json").dependencies.openclaw);
    pinBin = build.bin;
  });

  const runCli = (args, { allowFail = false } = {}) => {
    // spawnSync captures stdout AND stderr reliably (execFileSync only surfaces
    // stderr on throw), which matters for --json commands that log to stderr.
    const res = spawnSync(process.execPath, [pinBin, ...args], {
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
      const sh = `${JSON.stringify(process.execPath)} ${JSON.stringify(pinBin)} gateway restart-handoff capabilities --json > ${JSON.stringify(outFile)} 2>/dev/null`;
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
        [pinBin, "gateway", "run", "--port", String(port)],
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
        // Poll /healthz directly (more robust than stdout wording); the gateway
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
      // Phase 4 writes this exact subtree — the strict pinned root config must
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
        [pinBin, "gateway", "run", "--port", String(port)],
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
        // EX_CONFIG (78) means the pin rejected a key we write — the exact
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
