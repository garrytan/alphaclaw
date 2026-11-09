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

const bootGateway = async (kPort, hooksToken, extraEnv) => {
  const rootDir = mkTemp("alphaclaw-live-hooks-");
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
  const config = {
    gateway: { mode: "local", bind: "loopback", port: kPort, auth: { token: "live-e2e-token-000000000000000000000000" } },
    hooks: { enabled: true, path: "/hooks", token: hooksToken },
  };
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
