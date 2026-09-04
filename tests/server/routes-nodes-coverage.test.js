const net = require("net");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerNodeRoutes } = require("../../lib/server/routes/nodes");

const kBaseUrlEnvNames = [
  "ALPHACLAW_SETUP_URL",
  "ALPHACLAW_BASE_URL",
  "RENDER_EXTERNAL_URL",
  "URL",
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_STATIC_URL",
];

const withEnv = async (values, fn) => {
  const names = Object.keys(values);
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  for (const name of names) {
    if (values[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = values[name];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

const clearBaseUrlEnv = Object.fromEntries(
  kBaseUrlEnvNames.map((name) => [name, undefined]),
);

const createMemoryFs = (initialFiles = {}) => {
  const files = new Map(
    Object.entries(initialFiles).map(([filePath, contents]) => [
      filePath,
      String(contents),
    ]),
  );
  return {
    files,
    existsSync: (filePath) => files.has(filePath),
    readFileSync: (filePath) => {
      if (!files.has(filePath)) throw new Error(`File not found: ${filePath}`);
      return files.get(filePath);
    },
    writeFileSync: (filePath, contents) => {
      files.set(filePath, String(contents));
    },
    unlinkSync: (filePath) => {
      files.delete(filePath);
    },
    mkdirSync: () => {},
  };
};

const openclawDir = "/tmp/openclaw-nodes";
const approvalsPath = path.join(openclawDir, "exec-approvals.json");

const createApp = ({
  clawCmd,
  clawCmdWithRetry = null,
  openclawCapabilities = null,
  resolveExecApprovalsBackend = null,
  fsModule,
  gatewayToken = "",
  getGatewayToken = null,
  getGatewayAuthMode = null,
} = {}) => {
  const app = express();
  app.use(express.json());
  registerNodeRoutes({
    app,
    clawCmd: clawCmd || vi.fn(async () => ({ ok: true, stdout: "{}", stderr: "" })),
    clawCmdWithRetry,
    openclawCapabilities,
    resolveExecApprovalsBackend,
    openclawDir,
    gatewayToken,
    getGatewayToken,
    getGatewayAuthMode,
    fsModule: fsModule || createMemoryFs(),
  });
  return app;
};

// SQLite-era openclaw (issue #23): the `approvals` CLI exists and the legacy
// exec-approvals.json must never be created by these routes.
const sqliteEraCapabilities = { get: async (key) => key === "execApprovalsCli" };

// Real-socket proxy tests are timing-sensitive under parallel machine
// load; one retry absorbs transient connect races without masking
// deterministic failures.
describe("server/routes/nodes coverage", { retry: 1 }, () => {
  describe("GET /api/nodes", () => {
    it("surfaces non-timeout status failures with stderr", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: false,
        stdout: "",
        stderr: "  status exploded  ",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "status exploded" });
    });

    it("falls back to a generic status error when stderr is empty", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stdout: "", stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "Could not load nodes status" });
    });

    it("dedupes pending entries and drops entries without ids", async () => {
      const clawCmd = vi.fn(async (cmd) => {
        if (cmd === "nodes status --json") {
          return {
            ok: true,
            stdout: JSON.stringify({ nodes: [] }),
            stderr: "",
          };
        }
        if (cmd === "nodes pending --json") {
          return {
            ok: true,
            stdout: JSON.stringify({
              requests: [
                { requestId: "req-1", nodeId: "node-1" },
                { requestId: "req-2", nodeId: "node-1" },
                { id: "node-3" },
                { requestId: "" },
                null,
                "bogus",
              ],
            }),
            stderr: "",
          };
        }
        return { ok: true, stdout: "{}", stderr: "" };
      });
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes");
      expect(res.status).toBe(200);
      expect(res.body.pending).toEqual([
        { requestId: "req-1", nodeId: "node-1", id: "req-1", paired: false },
        { id: "node-3", nodeId: "node-3", paired: false },
      ]);
    });

    it("parses pending list from nodes key when requests missing", async () => {
      const clawCmd = vi.fn(async (cmd) => {
        if (cmd === "nodes status --json") {
          return { ok: true, stdout: "not json", stderr: "" };
        }
        if (cmd === "nodes pending --json") {
          return {
            ok: true,
            stdout: JSON.stringify({ nodes: [{ nodeId: "n-9" }] }),
            stderr: "",
          };
        }
        return { ok: true, stdout: "{}", stderr: "" };
      });
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes");
      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual([]);
      expect(res.body.pending).toEqual([
        { nodeId: "n-9", id: "n-9", paired: false },
      ]);
    });

    it("handles noisy pending output without arrays", async () => {
      const clawCmd = vi.fn(async (cmd) => {
        if (cmd === "nodes status --json") {
          return {
            ok: true,
            stdout: JSON.stringify({ nodes: [{ id: "a", paired: true }] }),
            stderr: "",
          };
        }
        return { ok: true, stdout: "garbage", stderr: "" };
      });
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes");
      expect(res.status).toBe(200);
      expect(res.body.pending).toEqual([]);
    });
  });

  describe("POST /api/nodes/:id/approve", () => {
    it("rejects invalid node ids", async () => {
      const app = createApp();
      const res = await request(app).post("/api/nodes/bad%20id/approve");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "Invalid node id" });
    });

    it("returns stderr when approval fails", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "denied" }));
      const app = createApp({ clawCmd });
      const res = await request(app).post("/api/nodes/node-1/approve");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "denied" });
    });

    it("falls back to generic approval error", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app).post("/api/nodes/node-1/approve");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "Could not approve node" });
    });

    it("approves a node with a quoted CLI arg", async () => {
      const clawCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app).post("/api/nodes/node-1.a:b/approve");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(clawCmd).toHaveBeenCalledWith("nodes approve 'node-1.a:b'");
    });
  });

  describe("POST /api/nodes/:id/route", () => {
    it("rejects invalid node ids", async () => {
      const app = createApp();
      const res = await request(app).post("/api/nodes/%24bad/route");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "Invalid node id" });
    });

    it("returns trimmed stderr on non-timeout routing failure", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: false,
        stderr: " routing broke ",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).post("/api/nodes/node-1/route");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "routing broke" });
    });

    it("falls back to a generic routing error", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app).post("/api/nodes/node-1/route");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        ok: false,
        error: "Could not apply node routing",
      });
    });

    it("routes via one merged tools.exec write with mode ask (upstream's allowlist+on-miss conversion)", async () => {
      const clawCmd = vi.fn(async (cmd) =>
        cmd.startsWith("config get")
          ? {
              ok: true,
              stdout: JSON.stringify({ strictInlineEval: false, security: "full", ask: "off" }),
              stderr: "",
            }
          : { ok: true, stdout: "", stderr: "" },
      );
      const app = createApp({ clawCmd });
      const res = await request(app).post("/api/nodes/node-9/route");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, restartRequired: true, nodeId: "node-9" });
      expect(clawCmd.mock.calls[0][0]).toBe("config get tools.exec --json");
      const setCall = clawCmd.mock.calls[1][0];
      expect(setCall).toMatch(/^config set tools\.exec '/);
      expect(setCall).toContain("--strict-json");
      expect(setCall).toContain('"mode":"ask"');
      expect(setCall).toContain('"host":"node"');
      expect(setCall).toContain('"node":"node-9"');
      // Unmanaged keys survive the merge; retired keys never do.
      expect(setCall).toContain('"strictInlineEval":false');
      expect(setCall).not.toContain('"security":');
      expect(setCall).not.toContain('"ask":');
    });
  });

  describe("DELETE /api/nodes/:id", () => {
    it("rejects invalid node ids", async () => {
      const app = createApp();
      const res = await request(app).delete("/api/nodes/bad%2Fid");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "Invalid node id" });
    });

    it("returns stderr when removal fails", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "cannot remove" }));
      const app = createApp({ clawCmd });
      const res = await request(app).delete("/api/nodes/node-1");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "cannot remove" });
    });

    it("falls back to generic removal error", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app).delete("/api/nodes/node-1");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "Could not remove node" });
    });

    it("removes nodes via devices remove", async () => {
      const clawCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app).delete("/api/nodes/node-1");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, nodeId: "node-1" });
      expect(clawCmd).toHaveBeenCalledWith("devices remove 'node-1'", {
        quiet: true,
      });
    });
  });

  describe("GET /api/nodes/connect-info", () => {
    it("uses explicit setup URL env with trailing slashes trimmed", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, ALPHACLAW_SETUP_URL: "https://setup.example.com///" },
        async () => {
          const app = createApp({ gatewayToken: "tok-1" });
          const res = await request(app).get("/api/nodes/connect-info");
          expect(res.status).toBe(200);
          expect(res.body).toEqual({
            ok: true,
            baseUrl: "https://setup.example.com",
            gatewayHost: "setup.example.com",
            gatewayPort: 443,
            gatewayToken: "tok-1",
            tls: true,
          });
        },
      );
    });

    it("uses base URL env with custom port", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, ALPHACLAW_BASE_URL: "http://base.example.com:8080" },
        async () => {
          const app = createApp();
          const res = await request(app).get("/api/nodes/connect-info");
          expect(res.body.baseUrl).toBe("http://base.example.com:8080");
          expect(res.body.gatewayPort).toBe(8080);
          expect(res.body.tls).toBe(false);
        },
      );
    });

    it("falls back to localhost when explicit URL is invalid", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, ALPHACLAW_SETUP_URL: "http://[invalid" },
        async () => {
          const app = createApp();
          const res = await request(app).get("/api/nodes/connect-info");
          // An empty token also carries token-unavailability metadata, so
          // this asserts the URL-derived fields rather than the exact shape.
          expect(res.body).toEqual(
            expect.objectContaining({
              ok: true,
              baseUrl: "http://localhost:3000",
              gatewayHost: "localhost",
              gatewayPort: 3000,
              gatewayToken: "",
              tls: false,
            }),
          );
        },
      );
    });

    it("builds https URL from railway public domain", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, RAILWAY_PUBLIC_DOMAIN: " app.up.railway.app " },
        async () => {
          const app = createApp();
          const res = await request(app).get("/api/nodes/connect-info");
          expect(res.body.baseUrl).toBe("https://app.up.railway.app");
          expect(res.body.tls).toBe(true);
        },
      );
    });

    it("uses railway static URL when set", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, RAILWAY_STATIC_URL: "http://static.example.com/" },
        async () => {
          const app = createApp();
          const res = await request(app).get("/api/nodes/connect-info");
          expect(res.body.baseUrl).toBe("http://static.example.com");
          expect(res.body.gatewayPort).toBe(80);
        },
      );
    });

    it("uses forwarded proto and host headers", async () => {
      await withEnv(clearBaseUrlEnv, async () => {
        const app = createApp();
        const res = await request(app)
          .get("/api/nodes/connect-info")
          .set("x-forwarded-proto", "https")
          .set("x-forwarded-host", "proxy.example.com");
        expect(res.body.baseUrl).toBe("https://proxy.example.com");
        expect(res.body.tls).toBe(true);
      });
    });

    it("falls back to the request host header", async () => {
      await withEnv(clearBaseUrlEnv, async () => {
        const app = createApp();
        const res = await request(app)
          .get("/api/nodes/connect-info")
          .set("host", "req-host.example.com:4567");
        expect(res.body.baseUrl).toBe("http://req-host.example.com:4567");
        expect(res.body.gatewayPort).toBe(4567);
      });
    });

    it("returns an empty gatewayToken when the lazy resolver reports trusted-proxy mode", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, ALPHACLAW_SETUP_URL: "https://setup.example.com" },
        async () => {
          // Team mode: the resolver sees trusted-proxy auth and returns "";
          // the static boot-time token must NOT be resurrected — the gateway
          // would reject it.
          const getGatewayToken = vi.fn(() => "");
          const app = createApp({ gatewayToken: "static-tok", getGatewayToken });
          const res = await request(app).get("/api/nodes/connect-info");
          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);
          expect(getGatewayToken).toHaveBeenCalled();
          expect(res.body.gatewayToken).toBe("");
          expect(JSON.stringify(res.body)).not.toContain("static-tok");
        },
      );
    });

    it("degrades to an empty gatewayToken when the lazy resolver throws", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, ALPHACLAW_SETUP_URL: "https://setup.example.com" },
        async () => {
          const getGatewayToken = vi.fn(() => {
            throw new Error("credential store unreadable");
          });
          const app = createApp({ gatewayToken: "static-tok", getGatewayToken });
          const res = await request(app).get("/api/nodes/connect-info");
          // A throwing resolver must never 500 the route.
          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);
          expect(res.body.gatewayToken).toBe("");
        },
      );
    });

    it("omits authMode metadata for an unconfigured token on a token-mode gateway", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, ALPHACLAW_SETUP_URL: "https://setup.example.com" },
        async () => {
          // Plain token mode with no token yet configured is NOT team mode:
          // the response must not claim token onboarding is unavailable.
          const getGatewayAuthMode = vi.fn(() => "token");
          const app = createApp({
            gatewayToken: "",
            getGatewayToken: vi.fn(() => ""),
            getGatewayAuthMode,
          });
          const res = await request(app).get("/api/nodes/connect-info");
          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);
          expect(getGatewayAuthMode).toHaveBeenCalled();
          expect(res.body.gatewayToken).toBe("");
          expect(res.body).not.toHaveProperty("authMode");
          expect(res.body).not.toHaveProperty("tokenUnavailableReason");
        },
      );
    });

    it("includes authMode and tokenUnavailableReason when a non-token gateway has no token", async () => {
      await withEnv(
        { ...clearBaseUrlEnv, ALPHACLAW_SETUP_URL: "https://setup.example.com" },
        async () => {
          const getGatewayAuthMode = vi.fn(() => "password");
          const app = createApp({
            gatewayToken: "",
            getGatewayToken: vi.fn(() => ""),
            getGatewayAuthMode,
          });
          const res = await request(app).get("/api/nodes/connect-info");
          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);
          expect(res.body.gatewayToken).toBe("");
          expect(res.body.authMode).toBe("password");
          expect(typeof res.body.tokenUnavailableReason).toBe("string");
          expect(res.body.tokenUnavailableReason.length).toBeGreaterThan(0);
        },
      );
    });

    it("falls back to localhost when no host header is present", async () => {
      await withEnv(clearBaseUrlEnv, async () => {
        const app = createApp();
        const server = app.listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        try {
          const rawResponse = await new Promise((resolve, reject) => {
            const socket = net.connect(server.address().port, "127.0.0.1", () => {
              socket.write("GET /api/nodes/connect-info HTTP/1.0\r\n\r\n");
            });
            const chunks = [];
            socket.on("data", (chunk) => chunks.push(chunk));
            socket.on("end", () =>
              resolve(Buffer.concat(chunks).toString("utf8")),
            );
            socket.on("error", reject);
          });
          const body = JSON.parse(rawResponse.split("\r\n\r\n")[1]);
          expect(body.baseUrl).toBe("http://localhost:3000");
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      });
    });
  });

  describe("GET /api/nodes/:id/browser-status", () => {
    it("rejects invalid node ids", async () => {
      const app = createApp();
      const res = await request(app).get("/api/nodes/bad%20id/browser-status");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "Invalid node id" });
    });

    it("returns stderr when node invoke fails", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "invoke failed" }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/node-1/browser-status");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "invoke failed" });
    });

    it("falls back to generic probe error", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/node-1/browser-status");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        ok: false,
        error: "Could not probe node browser status",
      });
    });

    it("returns 500 when browser status output cannot be parsed", async () => {
      const clawCmd = vi.fn(async () => ({ ok: true, stdout: "garbage", stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/node-1/browser-status");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        ok: false,
        error: "Could not parse node browser status",
      });
    });

    it("returns 500 when payload result is a non-JSON string", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ payload: { result: "plain text" } }),
        stderr: "",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/node-1/browser-status");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Could not parse node browser status");
    });

    it("decodes stringified JSON payload results with default profile", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({
          payload: { result: JSON.stringify({ running: true, tabs: 2 }) },
        }),
        stderr: "",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/node-1/browser-status");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        status: { running: true, tabs: 2 },
        profile: "user",
      });
      const command = clawCmd.mock.calls[0][0];
      expect(command).toContain("nodes invoke --node 'node-1'");
      expect(command).toContain("--command browser.proxy");
      expect(command).toContain('"profile":"user"');
      expect(clawCmd.mock.calls[0][1]).toEqual({ quiet: true, timeoutMs: 35000 });
    });

    it("unwraps nested result objects and honors profile query", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({
          payload: { result: { result: { running: false } } },
        }),
        stderr: "",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get(
        "/api/nodes/node-1/browser-status?profile=work",
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        status: { running: false },
        profile: "work",
      });
      expect(clawCmd.mock.calls[0][0]).toContain('"profile":"work"');
    });

    it("keeps non-object nested results as-is", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({
          payload: { result: { result: "still-a-string", other: 1 } },
        }),
        stderr: "",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get(
        "/api/nodes/node-1/browser-status?profile=%20",
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toEqual({ result: "still-a-string", other: 1 });
      expect(res.body.profile).toBe("user");
    });
  });

  describe("GET /api/nodes/exec-config", () => {
    it("returns default config when CLI fails", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stdout: "", stderr: "x" }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/exec-config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        config: { host: "gateway", security: "allowlist", ask: "on-miss", node: "" },
      });
    });

    it("normalizes and validates parsed exec config values", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: `noise before ${JSON.stringify({
          host: " NODE ",
          security: "FULL",
          ask: "ON",
          node: " node-7 ",
        })} noise after`,
        stderr: "",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/exec-config");
      expect(res.status).toBe(200);
      expect(res.body.config).toEqual({
        host: "node",
        security: "full",
        ask: "on-miss",
        node: "node-7",
      });
    });

    it("ignores unrecognized exec config values", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({
          host: "mars",
          security: "chaotic",
          ask: "sometimes",
          node: "",
        }),
        stderr: "",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/exec-config");
      expect(res.body.config).toEqual({
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
        node: "",
      });
    });
  });

  describe("POST /api/nodes/exec-config", () => {
    it("rejects invalid host", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "mars", security: "full", ask: "off" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid exec host");
    });

    it("rejects invalid security", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "gateway", security: "chaotic", ask: "off" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid exec security");
    });

    it("rejects invalid ask mode", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "gateway", security: "full", ask: "sometimes" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid exec ask mode");
    });

    it("requires a node target when host is node", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "node", security: "full", ask: "off", node: " " });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Node target is required when host is node");
    });

    it("handles missing request body defaults", async () => {
      const app = createApp();
      const res = await request(app).post("/api/nodes/exec-config");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid exec host");
    });

    it("returns stderr when the config write fails", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "cfg failed" }));
      const app = createApp({ clawCmd });
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "gateway", security: "deny", ask: "off" });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "cfg failed" });
    });

    it("falls back to a generic error message", async () => {
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "" }));
      const app = createApp({ clawCmd });
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "gateway", security: "deny", ask: "off" });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Could not apply exec config");
    });

    // The write is a read-merge-write of the whole tools.exec object in one
    // validated `config set … --strict-json` — never per-key writes of the
    // retired security/ask keys (the 2026.9.x beta flags those as legacy and
    // refuses every CLI command until doctor --fix).
    it("clears node target and converts allowlist+on-miss to mode ask", async () => {
      const clawCmd = vi.fn(async (cmd) =>
        cmd.startsWith("config get")
          ? { ok: true, stdout: "{}", stderr: "" }
          : { ok: true, stdout: "", stderr: "" },
      );
      const app = createApp({ clawCmd });
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "gateway", security: "allowlist", ask: "on" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, restartRequired: true });
      expect(clawCmd.mock.calls.map((call) => call[0])).toEqual([
        "config get tools.exec --json",
        `config set tools.exec '{"host":"gateway","node":"","mode":"ask"}' --strict-json`,
      ]);
    });

    it("keeps the legacy pair for the upstream bail-out combo (full + always)", async () => {
      const clawCmd = vi.fn(async (cmd) =>
        cmd.startsWith("config get")
          ? { ok: true, stdout: "{}", stderr: "" }
          : { ok: true, stdout: "", stderr: "" },
      );
      const app = createApp({ clawCmd });
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "node", security: "full", ask: "always", node: "node-3" });
      expect(res.status).toBe(200);
      expect(clawCmd.mock.calls.map((call) => call[0])).toEqual([
        "config get tools.exec --json",
        `config set tools.exec '{"host":"node","node":"node-3","security":"full","ask":"always"}' --strict-json`,
      ]);
    });

    it.each([
      ["full", "off", "full"],
      ["allowlist", "off", "allowlist"],
      ["deny", "off", "deny"],
      ["deny", "on-miss", "deny"],
      ["allowlist", "on-miss", "ask"],
    ])("converts %s + %s to mode %s", async (security, ask, mode) => {
      const clawCmd = vi.fn(async (cmd) =>
        cmd.startsWith("config get")
          ? { ok: true, stdout: "{}", stderr: "" }
          : { ok: true, stdout: "", stderr: "" },
      );
      const app = createApp({ clawCmd });
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "gateway", security, ask });
      expect(res.status).toBe(200);
      const setCall = clawCmd.mock.calls[1][0];
      expect(setCall).toContain(`"mode":"${mode}"`);
      expect(setCall).not.toContain('"security":');
      expect(setCall).not.toContain('"ask":');
    });

    it("preserves unmanaged tools.exec keys on write and keeps writing when the read fails", async () => {
      const clawCmd = vi.fn(async (cmd) =>
        cmd.startsWith("config get")
          ? {
              ok: true,
              stdout: JSON.stringify({
                security: "full",
                ask: "off",
                timeoutSeconds: 300,
                strictInlineEval: false,
              }),
              stderr: "",
            }
          : { ok: true, stdout: "", stderr: "" },
      );
      const app = createApp({ clawCmd });
      const res = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host: "gateway", security: "full", ask: "off" });
      expect(res.status).toBe(200);
      const setCall = clawCmd.mock.calls[1][0];
      expect(setCall).toContain('"timeoutSeconds":300');
      expect(setCall).toContain('"strictInlineEval":false');
      expect(setCall).toContain('"mode":"full"');
      // The retired keys never survive the merge.
      expect(setCall).not.toContain('"security":');
      expect(setCall).not.toContain('"ask":');

      // A failed read degrades to an empty merge base — the write still runs.
      const failingGet = vi.fn(async (cmd) =>
        cmd.startsWith("config get")
          ? { ok: false, stdout: "", stderr: "boom" }
          : { ok: true, stdout: "", stderr: "" },
      );
      const app2 = createApp({ clawCmd: failingGet });
      const res2 = await request(app2)
        .post("/api/nodes/exec-config")
        .send({ host: "gateway", security: "full", ask: "off" });
      expect(res2.status).toBe(200);
      expect(failingGet.mock.calls[1][0]).toContain('"mode":"full"');
    });

    it("GET derives the legacy pair from tools.exec.mode and reports the raw mode", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ host: "gateway", mode: "auto", node: "" }),
        stderr: "",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/exec-config");
      expect(res.status).toBe(200);
      // Upstream resolveExecPolicyForMode (both eras): ask/auto ⇒
      // allowlist + on-miss. Mapping these to full-security was a security
      // inversion (a GET→save cycle silently dropped allowlist enforcement).
      expect(res.body.config).toEqual({
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
        node: "",
        mode: "auto",
      });
    });

    it("GET→POST round-trip of mode ask is stable (no policy drift)", async () => {
      const clawCmd = vi.fn(async (cmd) =>
        cmd.startsWith("config get")
          ? {
              ok: true,
              stdout: JSON.stringify({ host: "gateway", mode: "ask", node: "" }),
              stderr: "",
            }
          : { ok: true, stdout: "", stderr: "" },
      );
      const app = createApp({ clawCmd });
      const getRes = await request(app).get("/api/nodes/exec-config");
      const { host, security, ask, node } = getRes.body.config;
      const postRes = await request(app)
        .post("/api/nodes/exec-config")
        .send({ host, security, ask, node });
      expect(postRes.status).toBe(200);
      // Saving exactly what GET displayed re-derives the same mode.
      const setCall = clawCmd.mock.calls.at(-1)[0];
      expect(setCall).toContain('"mode":"ask"');
      expect(setCall).not.toContain('"security":');
    });

    it("GET lets explicit legacy keys override the mode derivation", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ mode: "full", security: "deny" }),
        stderr: "",
      }));
      const app = createApp({ clawCmd });
      const res = await request(app).get("/api/nodes/exec-config");
      expect(res.body.config.security).toBe("deny");
      expect(res.body.config.ask).toBe("off");
      expect(res.body.config.mode).toBe("full");
    });
  });

  describe("exec approvals endpoints", () => {
    it("returns wildcard allowlist from approvals config", async () => {
      const fsModule = createMemoryFs({
        [approvalsPath]: JSON.stringify({
          version: 1,
          agents: {
            "*": {
              allowlist: [{ pattern: "git *", id: "id-1" }],
            },
          },
        }),
      });
      const app = createApp({ fsModule });
      const res = await request(app).get("/api/nodes/exec-approvals");
      expect(res.status).toBe(200);
      expect(res.body.allowlist).toEqual([{ pattern: "git *", id: "id-1" }]);
      expect(res.body.file.agents["*"].allowlist).toHaveLength(1);
    });

    it("builds wildcard defaults when approvals file is missing", async () => {
      const app = createApp({ fsModule: createMemoryFs() });
      const res = await request(app).get("/api/nodes/exec-approvals");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        file: { version: 1, agents: { "*": { allowlist: [] } } },
        allowlist: [],
      });
    });

    it("requires a pattern when adding allowlist entries", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "  " });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("pattern is required");
    });

    it("returns unchanged when pattern already exists", async () => {
      const fsModule = createMemoryFs({
        [approvalsPath]: JSON.stringify({
          version: 1,
          agents: { "*": { allowlist: [{ pattern: "npm *", id: "id-npm" }] } },
        }),
      });
      const app = createApp({ fsModule });
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: " npm * " });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        entry: { pattern: "npm *", id: "id-npm" },
        unchanged: true,
      });
      expect(fsModule.files.get(approvalsPath)).toContain("id-npm");
    });

    it("adds new allowlist entries and persists them", async () => {
      const fsModule = createMemoryFs();
      const app = createApp({ fsModule });
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "ls *" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.entry.pattern).toBe("ls *");
      expect(res.body.entry.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof res.body.entry.lastUsedAt).toBe("number");
      const stored = JSON.parse(fsModule.files.get(approvalsPath));
      expect(stored.agents["*"].allowlist).toHaveLength(1);
      expect(stored.agents["*"].allowlist[0].pattern).toBe("ls *");
    });

    it("rejects blank allowlist entry ids on delete", async () => {
      const app = createApp();
      const res = await request(app).delete(
        "/api/nodes/exec-approvals/allowlist/%20",
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("id is required");
    });

    it("returns 404 when allowlist entry does not exist", async () => {
      const fsModule = createMemoryFs({
        [approvalsPath]: JSON.stringify({
          version: 1,
          agents: { "*": { allowlist: [{ pattern: "a", id: "keep" }] } },
        }),
      });
      const app = createApp({ fsModule });
      const res = await request(app).delete(
        "/api/nodes/exec-approvals/allowlist/missing",
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Allowlist entry not found");
    });

    it("removes allowlist entries by id", async () => {
      const fsModule = createMemoryFs({
        [approvalsPath]: JSON.stringify({
          version: 1,
          agents: {
            "*": {
              allowlist: [
                { pattern: "a", id: "keep" },
                { pattern: "b", id: "remove-me" },
              ],
            },
          },
        }),
      });
      const app = createApp({ fsModule });
      const res = await request(app).delete(
        "/api/nodes/exec-approvals/allowlist/remove-me",
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const stored = JSON.parse(fsModule.files.get(approvalsPath));
      expect(stored.agents["*"].allowlist).toEqual([{ pattern: "a", id: "keep" }]);
    });
  });

  describe("exec approvals endpoints (sqlite-era, approvals CLI)", () => {
    const storeDoc = {
      version: 1,
      socket: { path: "/data/.openclaw/exec-approvals.sock", token: "sekret" },
      agents: { "*": { allowlist: [{ pattern: "git *", id: "id-1" }] } },
    };
    // The REAL `approvals get --json` output (verified live on 2026.7.1-2 and
    // 2026.9.1-beta.1) wraps the document: the doc lives under `file`, next
    // to path/exists/hash/effectivePolicy. The route must unwrap it — a
    // bare-doc fixture here previously masked a round-trip corruption bug.
    const wrapStoreDoc = (doc) =>
      JSON.stringify({
        path: "/data/.openclaw/state/openclaw.sqlite#exec_approvals_config",
        exists: true,
        hash: "abc123",
        file: doc,
        effectivePolicy: { scopes: [] },
      });

    const createCliHarness = ({ getResult } = {}) => {
      const fsModule = createMemoryFs();
      const clawCmd = vi.fn(async (cmd) => {
        if (cmd === "approvals get --json") {
          return (
            getResult || {
              ok: true,
              stdout: wrapStoreDoc(storeDoc),
              stderr: "",
            }
          );
        }
        return { ok: true, stdout: "", stderr: "" };
      });
      // The set flows through the retry-aware runner; capture the tmpfile
      // payload at call time (the route unlinks it in a finally).
      const setCalls = [];
      const clawCmdWithRetry = vi.fn(async (cmd) => {
        const match = cmd.match(/^approvals set --file '([^']+)'$/);
        setCalls.push({
          cmd,
          tmpFile: match ? match[1] : null,
          payload: match ? JSON.parse(fsModule.files.get(match[1])) : null,
        });
        return { ok: true, stdout: "", stderr: "" };
      });
      const app = createApp({
        clawCmd,
        clawCmdWithRetry,
        openclawCapabilities: sqliteEraCapabilities,
        fsModule,
      });
      return { app, clawCmd, clawCmdWithRetry, fsModule, setCalls };
    };

    it("reads approvals via `approvals get --json` without touching the legacy file", async () => {
      const { app, clawCmd, fsModule } = createCliHarness();
      const res = await request(app).get("/api/nodes/exec-approvals");
      expect(res.status).toBe(200);
      expect(res.body.allowlist).toEqual([{ pattern: "git *", id: "id-1" }]);
      expect(res.body.file.socket.token).toBe("sekret");
      expect(clawCmd).toHaveBeenCalledWith("approvals get --json", {
        quiet: true,
      });
      expect(fsModule.files.has(approvalsPath)).toBe(false);
    });

    it("surfaces a failed approvals get as 500 and never creates the legacy file", async () => {
      const { app, fsModule } = createCliHarness({
        getResult: { ok: false, stdout: "", stderr: "store exploded" },
      });
      const res = await request(app).get("/api/nodes/exec-approvals");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "store exploded" });
      expect(fsModule.files.has(approvalsPath)).toBe(false);
    });

    it("adds allowlist entries via get -> mutate -> set --file and never creates the legacy file", async () => {
      const { app, fsModule, clawCmdWithRetry, setCalls } = createCliHarness();
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "ls *" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.entry.pattern).toBe("ls *");
      expect(clawCmdWithRetry).toHaveBeenCalledTimes(1);
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].cmd).toMatch(/^approvals set --file '/);
      // Tmpfile lands under the OS temp dir, not the openclaw dir…
      expect(setCalls[0].tmpFile.startsWith(require("os").tmpdir())).toBe(true);
      // …carries the full mutated snapshot (socket.token preserved)…
      expect(setCalls[0].payload.socket.token).toBe("sekret");
      expect(
        setCalls[0].payload.agents["*"].allowlist.map((entry) => entry.pattern),
      ).toEqual(["git *", "ls *"]);
      // …and is unlinked afterwards. The legacy file is never created.
      expect(fsModule.files.has(setCalls[0].tmpFile)).toBe(false);
      expect(fsModule.files.has(approvalsPath)).toBe(false);
    });

    it("returns unchanged without a set when the pattern already exists in the store", async () => {
      const { app, clawCmdWithRetry, fsModule } = createCliHarness();
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: " git * " });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        entry: { pattern: "git *", id: "id-1" },
        unchanged: true,
      });
      expect(clawCmdWithRetry).not.toHaveBeenCalled();
      expect(fsModule.files.has(approvalsPath)).toBe(false);
    });

    it("removes allowlist entries through the CLI and never creates the legacy file", async () => {
      const { app, fsModule, setCalls } = createCliHarness();
      const res = await request(app).delete(
        "/api/nodes/exec-approvals/allowlist/id-1",
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].payload.agents["*"].allowlist).toEqual([]);
      expect(fsModule.files.has(setCalls[0].tmpFile)).toBe(false);
      expect(fsModule.files.has(approvalsPath)).toBe(false);
    });

    it("404s on an unknown id without calling set", async () => {
      const { app, clawCmdWithRetry, fsModule } = createCliHarness();
      const res = await request(app).delete(
        "/api/nodes/exec-approvals/allowlist/missing",
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Allowlist entry not found");
      expect(clawCmdWithRetry).not.toHaveBeenCalled();
      expect(fsModule.files.has(approvalsPath)).toBe(false);
    });

    it("surfaces a failed approvals set as 500 and still unlinks the tmpfile", async () => {
      const fsModule = createMemoryFs();
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify(storeDoc),
        stderr: "",
      }));
      const clawCmdWithRetry = vi.fn(async () => ({
        ok: false,
        stdout: "",
        stderr: "set exploded",
      }));
      const app = createApp({
        clawCmd,
        clawCmdWithRetry,
        openclawCapabilities: sqliteEraCapabilities,
        fsModule,
      });
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "ls *" });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: "set exploded" });
      // Tmpfile cleaned up in the finally; legacy file never created.
      expect([...fsModule.files.keys()]).toEqual([]);
    });

    it("fails legacy WRITES closed (503) when the era is indeterminate and the CLI is unavailable", async () => {
      // A capability-probe failure on a beta box must not let a dashboard
      // allowlist edit CREATE exec-approvals.json — the file whose existence
      // takes the gateway down (issue #23 fail-closed rule).
      const fsModule = createMemoryFs();
      const app = createApp({
        fsModule,
        openclawCapabilities: { get: async () => false }, // CLI "unavailable"
        resolveExecApprovalsBackend: async () => ({
          backend: "indeterminate",
          signal: "indeterminate",
          reapAllowed: false,
        }),
      });
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "ls *" });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/retry/i);
      // The legacy file was never created.
      expect(fsModule.files.has(approvalsPath)).toBe(false);
    });

    it("still allows legacy writes on a determinate file era", async () => {
      const fsModule = createMemoryFs();
      const app = createApp({
        fsModule,
        openclawCapabilities: { get: async () => false },
        resolveExecApprovalsBackend: async () => ({
          backend: "file",
          signal: "gate",
          reapAllowed: false,
        }),
      });
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "ls *" });
      expect(res.status).toBe(200);
      expect(fsModule.files.has(approvalsPath)).toBe(true);
    });

    it("falls back to the legacy file path when the capability probe throws", async () => {
      const fsModule = createMemoryFs();
      const app = createApp({
        openclawCapabilities: {
          get: async () => {
            throw new Error("probe exploded");
          },
        },
        fsModule,
      });
      const res = await request(app).get("/api/nodes/exec-approvals");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        file: { version: 1, agents: { "*": { allowlist: [] } } },
        allowlist: [],
      });
    });
  });

  describe("exec approvals file fallback fails closed on an unparseable file (fix wave F215)", () => {
    const torn = '{"version":1,"agents":{"*":{"allowlist":[{"pattern":"rm -rf *","id":"keep-me"';

    it("POST answers 409 config_unreadable and leaves the file byte-identical", async () => {
      const fsModule = createMemoryFs({ [approvalsPath]: torn });
      const app = createApp({ fsModule });
      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "ls *" });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, code: "config_unreadable", file: "exec-approvals.json" });
      expect(res.body.error).toMatch(/will not rewrite exec-approvals\.json/);
      expect(fsModule.files.get(approvalsPath)).toBe(torn);
    });

    it("DELETE answers 409 config_unreadable and leaves the file byte-identical", async () => {
      const fsModule = createMemoryFs({ [approvalsPath]: torn });
      const app = createApp({ fsModule });
      const res = await request(app).delete("/api/nodes/exec-approvals/allowlist/keep-me");
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("config_unreadable");
      expect(fsModule.files.get(approvalsPath)).toBe(torn);
    });

    it("GET stays lenient (display) — wildcard defaults, no write", async () => {
      const fsModule = createMemoryFs({ [approvalsPath]: torn });
      const app = createApp({ fsModule });
      const res = await request(app).get("/api/nodes/exec-approvals");
      expect(res.status).toBe(200);
      expect(res.body.allowlist).toEqual([]);
      expect(fsModule.files.get(approvalsPath)).toBe(torn);
    });
  });
});
