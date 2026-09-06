const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerGoogleRoutes } = require("../../lib/server/routes/google");
const { writeGoogleState } = require("../../lib/server/google-state");

// F098: the live `gog auth list --check` probe decides `authenticated`; the
// sticky state flag stands in only when gog did not answer for that client.
const buildApp = ({ accounts, gogAuthList }) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gaccts-"));
  const statePath = path.join(tmpDir, "google-state.json");
  writeGoogleState({ fs, statePath, state: { version: 2, accounts } });
  fs.writeFileSync(path.join(tmpDir, "creds.json"), "{}");
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
      if (cmd.includes("auth list")) return gogAuthList(cmd);
      return { ok: true, stdout: "", stderr: "" };
    },
    getBaseUrl: () => "http://127.0.0.1:3000",
    readGoogleCredentials: () => ({ clientId: "cid", clientSecret: "sec" }),
    getApiEnableUrl: () => "",
    constants: {
      GOG_CONFIG_DIR: tmpDir,
      GOG_STATE_PATH: statePath,
      WORKSPACE_DIR: path.join(tmpDir, "workspace"),
      OPENCLAW_DIR: path.join(tmpDir, "openclaw"),
      API_TEST_COMMANDS: {},
      BASE_SCOPES: ["openid"],
      SCOPE_MAP: { gmail: "gmail-scope" },
      REVERSE_SCOPE_MAP: { "gmail-scope": "gmail" },
      kMaxGoogleAccounts: 5,
      gogClientCredentialsPath: () => path.join(tmpDir, "creds.json"),
    },
  });
  return { app, tmpDir };
};

const kAccount = {
  id: "acc1",
  email: "user@example.com",
  client: "default",
  services: ["gmail"],
  authenticated: true,
};

describe("server/routes/google accounts: the live probe wins over the sticky flag (F098)", () => {
  it("a revoked grant (probe says invalid) reads as NOT connected even though state says authenticated", async () => {
    const { app, tmpDir } = buildApp({
      accounts: [kAccount],
      gogAuthList: async () => ({
        ok: true,
        stdout: JSON.stringify({ accounts: [{ email: "user@example.com", client: "default", valid: false }] }),
        stderr: "",
      }),
    });
    const list = await request(app).get("/api/google/accounts");
    expect(list.status).toBe(200);
    expect(list.body.accounts[0].authenticated).toBe(false);
    const status = await request(app).get("/api/google/status?accountId=acc1");
    expect(status.body.authenticated).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a valid probe entry reads as connected; an account the probe does not list reads as not connected", async () => {
    const { app, tmpDir } = buildApp({
      accounts: [kAccount, { ...kAccount, id: "acc2", email: "gone@example.com" }],
      gogAuthList: async () => ({
        ok: true,
        stdout: JSON.stringify({ accounts: [{ email: "user@example.com", client: "default", valid: true }] }),
        stderr: "",
      }),
    });
    const list = await request(app).get("/api/google/accounts");
    expect(list.body.accounts.map((a) => [a.id, a.authenticated])).toEqual([
      ["acc1", true],
      ["acc2", false],
    ]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("when gog itself does not answer, the last known flag stands in (never a false 'disconnected')", async () => {
    const { app, tmpDir } = buildApp({
      accounts: [kAccount, { ...kAccount, id: "acc2", email: "never@example.com", authenticated: false }],
      gogAuthList: async () => ({ ok: false, stdout: "", stderr: "keyring locked" }),
    });
    const list = await request(app).get("/api/google/accounts");
    expect(list.body.accounts.map((a) => [a.id, a.authenticated])).toEqual([
      ["acc1", true],
      ["acc2", false],
    ]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
