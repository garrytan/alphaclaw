const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const {
  kLiveEnabled,
  mkTemp,
  scrubTestRunnerEnv,
  waitFor,
} = require("./live-helpers");
const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { normalizeBootConfig } = require("../../lib/server/boot-config-normalization");

// LIVE tier: OpenClaw's own file log follows the logging.file AlphaClaw's boot
// normalization writes, so it lands under <root>/logs/openclaw instead of the
// container's /tmp/openclaw (a small, separately limited volume on Render).
// Run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/openclaw-file-log.e2e.test.js
// Screams if the pin stops honoring logging.file, stops rolling the literal
// openclaw-YYYY-MM-DD.log basename per day, or if `openclaw logs` (the
// gateway's logs.tail RPC) stops reading the configured file.
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 6 * 60 * 1000;
const kPort = 18993;
const kToken = "live-e2e-token-000000000000000000000000";
const kDefaultTmpLogDir = "/tmp/openclaw";

const formatLocalDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const fileSize = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
};

describeLive("live: OpenClaw file log under AlphaClaw's log dir", () => {
  let rootDir;
  let openclawDir;
  let logDir;
  let pinBin;

  const gatewayEnv = () => {
    const env = withOpenclawStartupEnv({
      ...scrubTestRunnerEnv(),
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: openclawDir,
      XDG_CONFIG_HOME: openclawDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
      OPENCLAW_GATEWAY_PORT: String(kPort),
      TMPDIR: path.join(rootDir, "tmp"),
    });
    delete env.OPENCLAW_PROFILE;
    return env;
  };

  beforeAll(() => {
    rootDir = mkTemp("alphaclaw-live-filelog-");
    openclawDir = path.join(rootDir, ".openclaw");
    logDir = path.join(rootDir, "logs", "openclaw");
    fs.mkdirSync(path.join(rootDir, "tmp"), { recursive: true });
    fs.mkdirSync(openclawDir, { recursive: true });
    const build = describeExecutingBuild({ installDir: path.resolve(__dirname, "../..") });
    expect(build?.version).toBe(require("../../package.json").dependencies.openclaw);
    pinBin = build.bin;
  });

  it(
    "writes the gateway's file log to the managed path and serves it through `openclaw logs`",
    async () => {
      const configPath = path.join(openclawDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { mode: "local", bind: "loopback", port: kPort, auth: { token: kToken } },
        }),
      );
      const logged = [];
      const managedFile = path.join(logDir, "openclaw-YYYY-MM-DD.log");
      expect(
        normalizeBootConfig({
          hold: { isValid: () => true },
          env: { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: openclawDir },
          logger: { log: (line) => logged.push(line) },
          logFile: managedFile,
        }),
      ).toEqual({ changed: true });
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).logging).toEqual({ file: managedFile });
      expect(logged).toContain(`[alphaclaw] OpenClaw file log set to ${managedFile} (logging.file was unset)`);

      const startDate = formatLocalDate(new Date());
      const tmpLog = path.join(kDefaultTmpLogDir, `openclaw-${startDate}.log`);
      const tmpLogBefore = fileSize(tmpLog);

      const child = spawn(process.execPath, [pinBin, "gateway", "run", "--port", String(kPort)], {
        env: gatewayEnv(),
        stdio: "pipe",
      });
      let output = "";
      child.stdout.on("data", (c) => (output += c.toString()));
      child.stderr.on("data", (c) => (output += c.toString()));
      try {
        await waitFor(
          async () => {
            try {
              return (await fetch(`http://127.0.0.1:${kPort}/healthz`)).ok;
            } catch {
              return false;
            }
          },
          150_000,
          "gateway /healthz",
        );

        const todayFile = () => path.join(logDir, `openclaw-${formatLocalDate(new Date())}.log`);
        await waitFor(
          () => fileSize(todayFile()) > 0 && fs.readFileSync(todayFile(), "utf8").includes(`log file: ${todayFile()}`),
          60_000,
          "gateway lines in today's managed log file",
        );
        const activeFile = todayFile();
        const lines = fs.readFileSync(activeFile, "utf8").trim().split("\n");
        expect(lines.length).toBeGreaterThan(1);
        const messages = lines.map((line) => String(JSON.parse(line).message));
        expect(messages.some((message) => message.startsWith("http server listening"))).toBe(true);
        expect(output).toContain(`log file: ${activeFile}`);
        expect(fs.readdirSync(logDir).every((name) => /^openclaw-\d{4}-\d{2}-\d{2}(\.\d)?\.log$/.test(name))).toBe(true);

        // `logs --json` streams one JSON document per line (meta, then records),
        // so runCliJson's single-document contract does not apply here.
        const res = spawnSync(process.execPath, [pinBin, "logs", "--json", "--limit", "20", "--token", kToken], {
          env: gatewayEnv(),
          encoding: "utf8",
          timeout: 120_000,
        });
        expect(res.status, `openclaw logs exited ${res.status}: ${String(res.stderr).slice(-600)}`).toBe(0);
        const records = String(res.stdout)
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .map((line) => JSON.parse(line));
        const meta = records.find((record) => record.type === "meta");
        expect(meta, `no meta record in: ${String(res.stdout).slice(0, 600)}`).toBeTruthy();
        expect(meta.file).toBe(activeFile);
        expect(meta.sourceKind).toBe("file");
        expect(meta.localFallback).toBeUndefined();
        expect(records.some((record) => record.type === "log" || record.type === "raw")).toBe(true);

        const tmpLogAfter = fileSize(tmpLog);
        if (tmpLogAfter > Math.max(tmpLogBefore, 0)) {
          const added = fs.readFileSync(tmpLog, "utf8").slice(Math.max(tmpLogBefore, 0));
          expect(added.includes(rootDir) || added.includes(`:${kPort}`), `this gateway wrote to ${tmpLog}`).toBe(false);
        } else {
          expect(tmpLogAfter).toBe(tmpLogBefore);
        }
      } catch (error) {
        error.message += `\n--- gateway output tail ---\n${output.slice(-1500)}`;
        throw error;
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 25_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    kTestTimeoutMs,
  );
});
