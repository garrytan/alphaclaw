const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerGoogleRoutes } = require("../../lib/server/routes/google");
const { isValidGoogleClientName } = require("../../lib/server/google-state");

// Fix wave F094/F206: the `client` slot name is interpolated into the gog
// credentials filename (credentials-<client>.json). Unvalidated, three `..`
// segments escaped GOG_CONFIG_DIR and could overwrite openclaw.json.
const buildApp = () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gcreds-"));
  const gogCalls = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.alphaclawIdentity = { kind: "member", role: "admin" };
    next();
  });
  registerGoogleRoutes({
    app,
    fs,
    isGatewayRunning: async () => false,
    gogCmd: async (cmd) => {
      gogCalls.push(cmd);
      return { ok: true, stdout: "", stderr: "" };
    },
    getBaseUrl: () => "http://127.0.0.1:3000",
    readGoogleCredentials: () => ({ clientId: "cid", clientSecret: "sec" }),
    getApiEnableUrl: () => "",
    stopGmailWatch: async () => {},
    constants: {
      GOG_CONFIG_DIR: tmpDir,
      GOG_STATE_PATH: path.join(tmpDir, "google-state.json"),
      WORKSPACE_DIR: path.join(tmpDir, "workspace"),
      OPENCLAW_DIR: path.join(tmpDir, "openclaw"),
      API_TEST_COMMANDS: {},
      BASE_SCOPES: ["openid"],
      SCOPE_MAP: { gmail: "gmail-scope" },
      REVERSE_SCOPE_MAP: { "gmail-scope": "gmail" },
      kMaxGoogleAccounts: 5,
      // The real shape: the client name lands in the filename.
      gogClientCredentialsPath: (name = "default") =>
        name === "default"
          ? path.join(tmpDir, "credentials.json")
          : path.join(tmpDir, `credentials-${name}.json`),
    },
  });
  return { app, tmpDir, gogCalls };
};

describe("server/routes/google client-name boundary", () => {
  let warn;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("rejects a traversal client on POST /api/google/credentials before writing anything", async () => {
    const { app, tmpDir, gogCalls } = buildApp();
    const outside = path.join(path.dirname(tmpDir), "escaped-credentials.json");
    const res = await request(app).post("/api/google/credentials").send({
      clientId: "cid",
      clientSecret: "sec",
      email: "user@example.com",
      client: "../escaped-credentials",
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "Invalid client name" });
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(gogCalls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("POST /api/google/credentials field=client reason=invalid_shape"),
    );
  });

  it("rejects a traversal client on POST /api/google/accounts", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/google/accounts")
      .send({ email: "user@example.com", client: "../../openclaw/openclaw" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid client name");
  });

  it("validator: accepts slugs, rejects paths, prototype keys, and overlong names", () => {
    for (const good of ["default", "personal", "acme-client", "Team_2", "a"]) {
      expect(isValidGoogleClientName(good), good).toBe(true);
    }
    for (const bad of ["../x", "a/b", "a\\b", "__proto__", "", " ", "a..b", "-a", "a-", "x".repeat(65)]) {
      expect(isValidGoogleClientName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
