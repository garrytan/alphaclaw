const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { listOps } = require("../../../lib/server/admin-manifest");

// Guard: an unknown /api route answers an AUTHENTICATED caller 404 (405 for a
// routed path under another method), never a 403 that reads as a permissions
// problem, while an UNAUTHENTICATED caller cannot tell real routes from
// unknown ones (identical 401). Runs the real lib/server.js so the production
// mount order is what is tested: requireAuth → member scope → agent
// enforcement → routes → proxy catch-all → JSON miss handler.
//
// The coverage case sends OPTIONS for every manifest path as the agent:
// enforcement refuses OPTIONS before any handler runs, so nothing executes,
// and the answer says whether the route table holds that path (403) or not
// (404). A new manifest op whose route is missing or misspelled fails here.

const kRepoRoot = path.resolve(__dirname, "..", "..", "..");
const kServerPath = path.join(kRepoRoot, "lib", "server.js");
const kPassword = "route-miss-guard-pass";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const acquirePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

let tmpDir = "";
let openclawDir = "";
let child = null;
let output = "";
let base = "";
let cookie = "";
let agentToken = "";

const call = async (method, url, { headers = {}, body } = {}) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, allow: res.headers.get("allow"), type: res.headers.get("content-type") };
};
const asAgent = (method, url, options = {}) =>
  call(method, url, { ...options, headers: { authorization: `Bearer ${agentToken}` } });
const asHuman = (method, url, options = {}) =>
  call(method, url, { ...options, headers: { cookie } });

const concretePath = (opPath) => opPath.replace(/:[A-Za-z_]+/g, "x1");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-route-miss-guard-"));
  const rootDir = path.join(tmpDir, "root");
  openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(path.join(openclawDir, "workspace"), { recursive: true });
  const deadGatewayPort = await acquirePort();
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify({ gateway: { port: deadGatewayPort } }),
  );
  fs.writeFileSync(
    path.join(openclawDir, "alphaclaw.json"),
    JSON.stringify({ features: { agentAdmin: { enabled: true } } }),
  );
  agentToken = "c".repeat(64);
  fs.mkdirSync(path.join(openclawDir, ".alphaclaw"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(openclawDir, ".alphaclaw", "agent-admin-token"), `${agentToken}\n`, {
    mode: 0o600,
  });
  const port = await acquirePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["-e", `require(${JSON.stringify(kServerPath)})`], {
    env: {
      ...process.env,
      SETUP_PASSWORD: kPassword,
      PORT: String(port),
      ALPHACLAW_ROOT_DIR: rootDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  let healthy = false;
  for (let i = 0; i < 200 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`${base}/health`)).status === 200;
    } catch {}
    if (!healthy) await sleep(100);
  }
  if (!healthy) throw new Error(`server never became healthy. Output:\n${output}`);
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: kPassword }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}. Output:\n${output}`);
  cookie = String(res.headers.get("set-cookie") || "").split(";")[0];
}, 40000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      sleep(10000).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");
  }
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("api route-miss guard (real server)", () => {
  it("answers an unauthenticated caller the same 401 for real and unknown routes", async () => {
    const realGets = listOps()
      .filter((op) => op.method === "GET" && !op.path.includes(":"))
      .map((op) => ["GET", op.path]);
    expect(realGets.length).toBeGreaterThan(20);
    const probes = [
      ...realGets,
      ["POST", "/api/watchdog/repair"],
      ["GET", "/api/watchdog/history"],
      ["POST", "/api/watchdog/events"],
      ["GET", "/api/doctor/nope"],
      ["GET", "/api/definitely-not-a-route"],
      ["DELETE", "/api/agents/x1/nope"],
    ];
    const answers = new Set();
    for (const [method, url] of probes) {
      const res = await call(method, url);
      answers.add(JSON.stringify([res.status, res.text, res.allow]));
    }
    expect([...answers]).toEqual([JSON.stringify([401, '{"error":"Unauthorized"}', null])]);
  });

  it("answers the agent 404 / 405 for unknown routes and 403 for real ones", async () => {
    const unknown = await asAgent("GET", "/api/watchdog/history");
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ ok: false, code: "route_not_found" });
    const wrongMethod = await asAgent("POST", "/api/watchdog/events", { body: {} });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.allow).toBe("GET, HEAD");
    const gateway = await asAgent("GET", "/api/definitely-not-a-route");
    expect(gateway.status).toBe(403);
    expect(gateway.json.code).toBe("op_not_in_manifest");
    const events = await asAgent("GET", "/api/watchdog/events?limit=1&includeRoutine=1");
    expect(events.status).toBe(200);
    expect(events.json).toMatchObject({ ok: true, limit: 1 });
    expect(typeof events.json.hasMore).toBe("boolean");
  });

  it("answers a signed-in human JSON 404 instead of an HTML page", async () => {
    const unknown = await asHuman("GET", "/api/watchdog/history");
    expect(unknown.status).toBe(404);
    expect(unknown.type).toMatch(/application\/json/);
    expect(unknown.json.code).toBe("route_not_found");
    const wrongMethod = await asHuman("DELETE", "/api/watchdog/events");
    expect(wrongMethod.status).toBe(405);
    const real = await asHuman("GET", "/api/watchdog/events?limit=1");
    expect(real.status).toBe(200);
  });

  it("finds a route for every manifest op path (agent OPTIONS: 403, never 404)", async () => {
    const missing = [];
    for (const op of listOps()) {
      const res = await asAgent("OPTIONS", concretePath(op.path));
      if (res.status !== 403) missing.push(`${op.method} ${op.path} → ${res.status}`);
    }
    expect(missing).toEqual([]);
  });
});
