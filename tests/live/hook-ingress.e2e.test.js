const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const request = require("supertest");

const { kLiveEnabled, mkTemp, scrubTestRunnerEnv, waitFor } = require("./live-helpers");
const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { blankDeniedGatewayEnvKeys, filterGatewayChildEnv } = require("../../lib/server/gateway-env-policy");
const { createWebhookMiddleware } = require("../../lib/server/webhook-middleware");
const { createHookIngress } = require("../../lib/server/hook-ingress");

// LIVE tier (GST-2134): AlphaClaw's /hooks edge decision must match the
// pinned gateway's own hooks.token check for every credential shape, with
// hooks.token both a literal and the standard "${WEBHOOK_TOKEN}" reference
// (the reference case must admit a valid token). Run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/hook-ingress.e2e.test.js
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 6 * 60 * 1000;
const kHookToken = "live-hook-token-1111111111111111";

const bootGateway = async (kPort, hooksToken, extraEnv, { mappings = null, transformSources = {} } = {}) => {
  const rootDir = mkTemp("alphaclaw-live-hooks-");
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
  const config = {
    gateway: { mode: "local", bind: "loopback", port: kPort, auth: { token: "live-e2e-token-000000000000000000000000" } },
    hooks: { enabled: true, path: "/hooks", token: hooksToken, ...(mappings ? { mappings } : {}) },
  };
  for (const [name, source] of Object.entries(transformSources)) {
    fs.mkdirSync(path.join(openclawDir, "hooks", "transforms"), { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "hooks", "transforms", name), source);
  }
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify(config));
  const source = withOpenclawStartupEnv({
    ...scrubTestRunnerEnv(),
    HOME: rootDir,
    OPENCLAW_HOME: rootDir,
    OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: openclawDir,
    XDG_CONFIG_HOME: openclawDir,
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_GATEWAY_PORT: String(kPort),
    ...extraEnv,
  });
  const quiet = { log: () => {}, warn: () => {} };
  const env = blankDeniedGatewayEnvKeys(filterGatewayChildEnv(source, { logger: quiet }));
  const build = describeExecutingBuild({ installDir: path.resolve(__dirname, "../..") });
  const child = spawn(process.execPath, [build.bin, "gateway", "run", "--port", String(kPort)], {
    env,
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
  });
  await waitFor(
    async () => {
      try {
        return (await fetch("http://127.0.0.1:" + kPort + "/readyz")).ok;
      } catch {
        return false;
      }
    },
    150000,
    "gateway /readyz",
  );
  return { env, config, child, rootDir, openclawDir, kPort };
};

const buildApps = ({ env, config, rootDir, openclawDir, kPort }) => {
  const gatewayUrl = "http://127.0.0.1:" + kPort;
  const hookIngress = createHookIngress({
    openclawDir,
    rootDir,
    readOpenclawConfig: () => config,
    getLaunchEnv: () => env,
    logger: { warn: () => {}, log: () => {}, error: () => {} },
  });
  const mount = (middleware) => {
    const app = express();
    app.use("/hooks", express.raw({ type: "*/*", limit: "5mb" }));
    app.all(/^\/hooks\/.+/, middleware);
    return app;
  };
  return {
    edge: mount(createWebhookMiddleware({ gatewayUrl, insertRequest: () => {}, hookIngress })),
    plain: mount(createWebhookMiddleware({ gatewayUrl, insertRequest: () => {} })),
  };
};

const kShapes = [
  { label: "Bearer valid", path: "/hooks/probe", headers: { authorization: "Bearer " + kHookToken } },
  { label: "Bearer wrong", path: "/hooks/probe", headers: { authorization: "Bearer nope" } },
  { label: "x-openclaw-token valid", path: "/hooks/probe", headers: { "x-openclaw-token": kHookToken } },
  { label: "x-openclaw-token wrong", path: "/hooks/probe", headers: { "x-openclaw-token": "nope" } },
  { label: "?token= valid", path: "/hooks/probe?token=" + kHookToken, headers: {} },
  { label: "?token= wrong", path: "/hooks/probe?token=nope", headers: {} },
  { label: "Bearer wrong + x-openclaw-token valid", path: "/hooks/probe", headers: { authorization: "Bearer nope", "x-openclaw-token": kHookToken } },
  { label: "Basic + x-openclaw-token valid", path: "/hooks/probe", headers: { authorization: "Basic abc", "x-openclaw-token": kHookToken } },
  { label: "empty", path: "/hooks/probe", headers: {} },
];

const runMatrix = async (apps) => {
  const results = [];
  for (const shape of kShapes) {
    const send = (app) => {
      let req = request(app).post(shape.path).set("content-type", "application/json");
      for (const [key, value] of Object.entries(shape.headers)) req = req.set(key, value);
      return req.send(JSON.stringify({ text: "probe" }));
    };
    const plain = await send(apps.plain);
    const edge = await send(apps.edge);
    const edgeRefused = edge.status === 401 && edge.headers["content-type"]?.includes("application/json");
    results.push({ label: shape.label, gateway: plain.status, edge: edge.status, edgeAdmits: !edgeRefused, gatewayAdmits: plain.status !== 401 });
  }
  return results;
};

describeLive("live: AlphaClaw's /hooks edge verdict matches the pinned gateway", () => {
  for (const variant of [
    { name: "reference", port: 18994, token: "${WEBHOOK_TOKEN}", env: { WEBHOOK_TOKEN: kHookToken } },
    { name: "literal", port: 18995, token: kHookToken, env: { WEBHOOK_TOKEN: "differs-from-the-literal-000000" } },
  ]) {
    it(
      "hooks.token as a " + variant.name,
      async () => {
        const booted = await bootGateway(variant.port, variant.token, variant.env);
        try {
          const results = await runMatrix(buildApps(booted));
          for (const row of results) {
            expect({ label: row.label, edgeAdmits: row.edgeAdmits }).toEqual({ label: row.label, edgeAdmits: row.gatewayAdmits });
            if (row.edgeAdmits) expect({ label: row.label, status: row.edge }).toEqual({ label: row.label, status: row.gateway });
          }
          const valid = results.find((row) => row.label === "Bearer valid");
          expect(valid.gatewayAdmits).toBe(true);
          expect(valid.edgeAdmits).toBe(true);
        } finally {
          try {
            process.kill(-booted.child.pid, "SIGKILL");
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      },
      kTestTimeoutMs,
    );
  }
});

// PR 2: a signed delivery through the edge reaches the pinned gateway's
// mapping transform with the signed body, no query string, the sender's
// signature header and AlphaClaw's header set, its
// replay is answered without a second dispatch, the shared token is refused
// once the overlap closes, and a Circleback-size body near the gateway's
// 256 KiB limit is admitted.
describeLive("live: signed hook deliveries through the edge reach the pinned gateway", () => {
  it(
    "admits a signed delivery once, refuses its replay and the shared token after close",
    async () => {
      const crypto = require("crypto");
      const webhooksDb = require("../../lib/server/db/webhooks");
      const kPort = 18996;
      const preRoot = mkTemp("alphaclaw-live-signed-");
      const capturePath = path.join(preRoot, "captures.jsonl");
      const transformSource =
        'import fs from "node:fs";\n' +
        "export default function transform(ctx) {\n" +
        "  fs.appendFileSync(" + JSON.stringify(capturePath) + ", JSON.stringify({ headers: Object.fromEntries(Object.entries(ctx.headers || {})), url: String(ctx.url || \"\"), path: String(ctx.path || \"\"), payload: ctx.payload }) + \"\\n\");\n" +
        "  return null;\n" +
        "}\n";
      const booted = await bootGateway(kPort, "$" + "{WEBHOOK_TOKEN}", { WEBHOOK_TOKEN: kHookToken }, {
        mappings: [{ id: "meetings", match: { path: "meetings" }, action: "wake", transform: { module: "meetings.mjs" } }],
        transformSources: { "meetings.mjs": transformSource },
      });
      const clock = { now: Date.now() };
      webhooksDb.initWebhooksDb({ rootDir: booted.rootDir });
      try {
        const hookIngress = createHookIngress({
          openclawDir: booted.openclawDir,
          rootDir: booted.rootDir,
          readOpenclawConfig: () => booted.config,
          getLaunchEnv: () => booted.env,
          hasReplayKey: webhooksDb.hasReplayKey,
          recordReplayKey: webhooksDb.recordReplayKey,
          deleteReplayKeysByHook: webhooksDb.deleteReplayKeysByHook,
          listHookNames: () => ["meetings"],
          nowMs: () => clock.now,
          logger: { warn: () => {}, log: () => {}, error: () => {} },
        });
        hookIngress.runHooksPolicyMigration();
        const secret = crypto.randomBytes(24).toString("base64url");
        hookIngress.setIngress("meetings", { preset: "circleback", secret });
        const app = express();
        app.use("/hooks", express.raw({ type: "*/*", limit: "5mb" }));
        app.all(/^\/hooks\/.+/, createWebhookMiddleware({ gatewayUrl: "http://127.0.0.1:" + kPort, insertRequest: () => {}, hookIngress }));
        const sign = (body) => crypto.createHmac("sha256", secret).update(body).digest("hex");
        const post = (body, extra = {}, query = "") => {
          let req = request(app).post("/hooks/meetings" + query).set("content-type", "application/json").set("x-signature", sign(body));
          for (const [key, value] of Object.entries(extra)) req = req.set(key, value);
          return req.send(body);
        };
        const captures = () => (fs.existsSync(capturePath) ? fs.readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

        const body = JSON.stringify({ id: "m-1", title: "Standup" });
        const first = await post(body, { "x-event-type": "meeting.done" }, "?token=" + kHookToken + "&leak=1");
        expect(first.status).toBe(204);
        expect(captures()).toHaveLength(1);
        const captured = captures()[0];
        expect(captured.payload).toEqual(JSON.parse(body));
        expect(captured.url).not.toContain("leak");
        expect(captured.url).not.toContain("token");
        expect(captured.headers["x-event-type"]).toBeUndefined();
        expect(captured.headers["x-signature"]).toBe(sign(body));
        expect(captured.headers["idempotency-key"]).toBe("circleback:" + sign(body));

        const replay = await post(body);
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual({ ok: true, deduped: true });
        expect(captures()).toHaveLength(1);

        const big = JSON.stringify({ id: "m-2", transcript: "x".repeat(250 * 1024) });
        expect((await post(big)).status).toBe(204);
        expect(captures()).toHaveLength(2);

        const shared = () => request(app).post("/hooks/meetings").set("authorization", "Bearer " + kHookToken).send(JSON.stringify({ id: "m-3" }));
        expect((await shared()).status).toBe(204);
        clock.now += 24 * 60 * 60 * 1000 + 1000;
        const refused = await shared();
        expect(refused.status).toBe(401);
        expect(captures()).toHaveLength(3);

        // PR 3: the hook moved to its own token; the gateway admits a delivery
        // with it (forwarded with the gateway credential) and the shared token
        // stays closed.
        const { secret: own } = hookIngress.generateIngressSecret("meetings", { preset: "per_hook_token" });
        const viaOwn = await request(app).post("/hooks/meetings?token=" + own).send(JSON.stringify({ id: "m-4" }));
        expect(viaOwn.status).toBe(204);
        expect(captures()).toHaveLength(4);
        expect(captures()[3].payload.id).toBe("m-4");
        expect((await shared()).status).toBe(401);
      } finally {
        webhooksDb.closeWebhooksDb();
        try {
          process.kill(-booted.child.pid, "SIGKILL");
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    },
    kTestTimeoutMs,
  );
});
