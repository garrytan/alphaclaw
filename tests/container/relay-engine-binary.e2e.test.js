// vitest globals (describe/test/expect/hooks) are on via vitest.config.js.
const fs = require("node:fs");
const path = require("node:path");
const {
  describeContainer,
  repoRoot,
  ensureArtifactsDir,
  assertDockerAvailable,
  docker,
  removeContainer,
} = require("./container-helpers.js");

// -----------------------------------------------------------------------------
// Container E2E: the Agent Relay engine in the production base image.
//
// The relay engine ships as upstream's standalone binary (no native addon),
// fetched at first boot and checked against the sha256 pinned in
// lib/server/relay/constants.js. This proves, in node:24-slim (the
// Dockerfile's base), with the real release download:
//   - ensureEngineBinary downloads, verifies and installs it (0755)
//   - a second call re-hashes the file on disk and does not download again
//   - a binary changed on disk is replaced by a fresh verified download
//   - the binary starts with only the env AlphaClaw gives it and serves /health
//   - anonymous workspace creation is refused; the internal secret creates one
//   - its resident memory after start (the plan's RSS measurement)
// Opt-in via OPENCLAW_CONTAINER_E2E=1.
// -----------------------------------------------------------------------------

const kRunId = Date.now().toString(36);
const kContainer = "alphaclaw-relay-engine-e2e-" + kRunId;
const kImage = "node:24-slim";
const kMin = 60 * 1000;

const kScript = String.raw`
const fs = require("fs");
const { spawn } = require("child_process");
const { ensureEngineBinary, resolveEnginePlatform } = require("/src/lib/server/relay/engine-binary.js");
const { relayPaths } = require("/src/lib/server/relay/constants.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = { target: resolveEnginePlatform() };
  const paths = relayPaths("/data");
  const quiet = { log() {}, warn() {} };
  const first = await ensureEngineBinary({ binDir: paths.binDir, logger: quiet });
  out.first = { downloaded: first.downloaded, mode: (fs.statSync(first.path).mode & 0o777).toString(8) };
  const second = await ensureEngineBinary({ binDir: paths.binDir, logger: quiet });
  out.second = { downloaded: second.downloaded };
  fs.appendFileSync(first.path, "tampered");
  const third = await ensureEngineBinary({ binDir: paths.binDir, logger: quiet });
  out.third = { downloaded: third.downloaded };
  out.leftovers = fs.readdirSync(paths.binDir).filter((name) => name.endsWith(".part"));
  fs.writeFileSync(paths.internalSecretFile, require("crypto").randomBytes(32).toString("hex"), { mode: 0o600 });
  const child = spawn(third.path, ["--db", paths.engineDb, "--port", "18787"], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: paths.dir,
      RELAYCAST_INTERNAL_SECRET_FILE: paths.internalSecretFile,
      RELAYCAST_PUBLIC_WORKSPACE_CREATE: "false",
      RELAYCAST_MESSAGE_TTL_DAYS: "90",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const base = "http://127.0.0.1:18787";
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(base + "/health");
      if (r.ok) { out.health = await r.json(); break; }
    } catch {}
    if (Date.now() - started > 60000) { out.health = null; break; }
    await sleep(250);
  }
  out.startMs = Date.now() - started;
  const pub = await fetch(base + "/v1/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  out.publicCreate = { status: pub.status, ok: (await pub.json().catch(() => ({})))?.ok === true };
  const internal = await fetch(base + "/internal/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + fs.readFileSync(paths.internalSecretFile, "utf8") },
    body: JSON.stringify({ name: "alphaclaw" }),
  });
  const body = await internal.json().catch(() => ({}));
  const data = body.data || body;
  out.internalCreate = { status: internal.status, hasWorkspaceId: Boolean(data.workspace_id || data.id), keyShape: /^rk_live_/.test(String(data.api_key || "")) };
  await sleep(2000);
  const status = fs.readFileSync("/proc/" + child.pid + "/status", "utf8");
  out.rssKb = Number((status.match(/VmRSS:\s+(\d+)/) || [])[1]) || null;
  child.kill("SIGTERM");
  const code = await new Promise((r) => child.once("exit", (c, s) => r(c === null ? s : c)));
  out.exit = code;
  out.logTail = log.replace(/rk_live_\w+/g, "rk_live_REDACTED").slice(-1500);
  console.log("RESULT " + JSON.stringify(out));
})().catch((e) => { console.log("RESULT " + JSON.stringify({ error: String(e && (e.code || "") + " " + e.message) })); process.exit(1); });
`;

describeContainer("container E2E: the relay engine binary downloads, verifies and serves in node:24-slim", () => {
  let result = null;

  beforeAll(async () => {
    await assertDockerAvailable();
  }, kMin);

  afterAll(async () => {
    await removeContainer(kContainer).catch(() => {});
    if (result) {
      fs.writeFileSync(path.join(ensureArtifactsDir(), "relay-engine-binary.json"), JSON.stringify(result, null, 2) + "\n");
    }
  }, kMin);

  test("download, re-verify, tamper recovery, start, auth and memory", async () => {
    await removeContainer(kContainer).catch(() => {});
    const { stdout } = await docker(
      [
        "run", "--rm", "--name", kContainer, "--memory=512m",
        "-v", path.join(repoRoot, "lib") + ":/src/lib:ro",
        "--tmpfs", "/data:exec,mode=0755",
        kImage, "node", "-e", kScript,
      ],
      { timeoutMs: 8 * kMin },
    );
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
    expect(line, stdout).toBeTruthy();
    result = JSON.parse(line.slice("RESULT ".length));
    console.log("[relay-engine] " + JSON.stringify({ target: result.target, startMs: result.startMs, rssKb: result.rssKb }));
    expect(result.error, result.logTail).toBeUndefined();
    expect(result.first).toEqual({ downloaded: true, mode: "755" });
    expect(result.second).toEqual({ downloaded: false });
    expect(result.third).toEqual({ downloaded: true });
    expect(result.leftovers).toEqual([]);
    expect(result.health, result.logTail).toBeTruthy();
    expect(result.publicCreate.ok).toBe(false);
    expect(result.internalCreate).toEqual({ status: 201, hasWorkspaceId: true, keyShape: true });
    expect(result.rssKb).toBeGreaterThan(0);
    expect(result.rssKb).toBeLessThan(400 * 1024);
  }, 10 * kMin);
});
