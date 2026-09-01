const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerGoogleRoutes } = require("../../lib/server/routes/google");
const { readGoogleState, writeGoogleState } = require("../../lib/server/google-state");

// PR #35 regression (clientArg scoping): the v0.9.49 /tmp-hardening refactor
// moved `clientArg` inside the withPrivateTokenFile callback while the
// post-callback `gog auth remove` still referenced it, so every disconnect
// threw ReferenceError AFTER the upstream revocation — token revoked at
// Google, account never removed locally, retries failing identically. These
// tests pin the whole disconnect contract, including the revocation gate:
// only a token-already-dead response (200, or 400 with invalid_token/
// invalid_grant) may fall through to removal; every other failure keeps the
// account and surfaces `retryable: true`. When there is nothing to revoke
// (export failed, no refresh_token), removal proceeds best-effort — the
// pre-fix contract, pinned here so any future "gate everything" change is a
// conscious decision.

const buildDisconnectApp = ({
  accounts = [],
  exportOk = true,
  exportTimedOut = false,
  removeOk = true,
  tokenData,
  stopGmailWatch,
} = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gdisc-"));
  const statePath = path.join(tmpDir, "google-state.json");
  if (accounts.length) {
    writeGoogleState({ fs, statePath, state: { version: 2, accounts } });
  }
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
      if (cmd.includes("tokens export")) {
        if (exportTimedOut) return { ok: false, stdout: "", stderr: "", timedOut: true, code: null };
        if (!exportOk) return { ok: false, stdout: "", stderr: "export failed", timedOut: false, code: 1 };
        // Stage the token file at the --out path so the route finds a
        // refresh token and exercises the revocation fetch.
        const outMatch = cmd.match(/--out "([^"]+)"/);
        if (outMatch) {
          const staged = tokenData === undefined ? { refresh_token: "rt-1" } : tokenData;
          fs.writeFileSync(outMatch[1], JSON.stringify(staged));
        }
      }
      if (cmd.includes("auth remove") && !removeOk) {
        return { ok: false, stdout: "", stderr: "keyring locked" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    getBaseUrl: () => "http://127.0.0.1:3000",
    readGoogleCredentials: () => ({ clientId: "cid", clientSecret: "sec" }),
    getApiEnableUrl: () => "",
    stopGmailWatch,
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
  return { app, tmpDir, statePath, gogCalls };
};

const baseAccount = (overrides = {}) => ({
  id: "acc1",
  email: "user@example.com",
  client: "acme-client",
  services: ["gmail"],
  authenticated: true,
  ...overrides,
});

const readAccounts = (statePath) => readGoogleState({ fs, statePath }).accounts || [];

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

describe("server/routes POST /api/google/disconnect (PR #35 clientArg regression)", () => {
  const realFetch = global.fetch;
  let tmpDirs = [];

  const build = (opts) => {
    const built = buildDisconnectApp(opts);
    tmpDirs.push(built.tmpDir);
    return built;
  };

  afterEach(() => {
    global.fetch = realFetch;
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs = [];
  });

  // Fix wave (v0.9.64): the three deferred red-team findings on disconnect.
  it("stops the account's Gmail watch before revocation (orphaned-serve-process fix)", async () => {
    global.fetch = okFetch;
    const stopCalls = [];
    const { app } = build({
      accounts: [baseAccount()],
      stopGmailWatch: async (args) => {
        stopCalls.push(args);
        return { ok: true };
      },
    });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(true);
    expect(stopCalls).toEqual([{ accountId: "acc1" }]);
  });

  it("continues the disconnect when Gmail watch stop throws (best-effort)", async () => {
    global.fetch = okFetch;
    const { app, statePath } = build({
      accounts: [baseAccount()],
      stopGmailWatch: async () => {
        throw new Error("watch stop boom");
      },
    });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(true);
    expect(readAccounts(statePath)).toHaveLength(0);
  });

  it("keeps the account (retryable) when the token export TIMES OUT — never orphans a live token", async () => {
    global.fetch = async () => {
      throw new Error("revocation must not run when export timed out");
    };
    const { app, statePath, gogCalls } = build({
      accounts: [baseAccount()],
      exportTimedOut: true,
    });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(false);
    expect(res.body.retryable).toBe(true);
    expect(res.body.accountId).toBe("acc1");
    expect(gogCalls.some((c) => c.includes("auth remove"))).toBe(false);
    expect(readAccounts(statePath)).toHaveLength(1);
  });

  it("removes the account and invokes gog auth remove (clientArg scoping regression)", async () => {
    const fetchCalls = [];
    global.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return okFetch();
    };
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount()] });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.ok).toBe(true);
    expect(gogCalls[0]).toMatch(/^--client "acme-client" auth tokens export "user@example\.com" --out "/);
    expect(gogCalls[1]).toBe('--client "acme-client" auth remove "user@example.com" --force');
    expect(readAccounts(statePath)).toHaveLength(0);
    // The credential travels in the form body, never the URL.
    expect(fetchCalls[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(fetchCalls[0].options.body)).toBe("token=rt-1");
  });

  it("emits no --client prefix for the default client", async () => {
    global.fetch = okFetch;
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount({ client: "default" })] });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body).toEqual({ ok: true });
    expect(gogCalls[1]).toBe('auth remove "user@example.com" --force');
    expect(readAccounts(statePath)).toHaveLength(0);
  });

  it("treats an unknown account in an empty state as a no-op success", async () => {
    global.fetch = okFetch;
    const { app, gogCalls } = build({ accounts: [] });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "nope" });

    expect(res.body).toEqual({ ok: true });
    expect(gogCalls).toHaveLength(0);
  });

  it("leaves existing accounts untouched when the accountId is unknown", async () => {
    global.fetch = okFetch;
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount()] });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "nope" });

    expect(res.body).toEqual({ ok: true });
    expect(gogCalls).toHaveLength(0);
    expect(readAccounts(statePath)).toHaveLength(1);
  });

  it("refuses an accountId-less disconnect when multiple accounts exist (no destructive fallback)", async () => {
    global.fetch = okFetch;
    const { app, statePath, gogCalls } = build({
      accounts: [baseAccount(), baseAccount({ id: "acc2", email: "two@example.com" })],
    });

    const res = await request(app).post("/api/google/disconnect").send({});

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/accountId is required/);
    expect(gogCalls).toHaveLength(0);
    expect(readAccounts(statePath)).toHaveLength(2);
  });

  it("falls back to the only account when no accountId is sent and exactly one exists", async () => {
    global.fetch = okFetch;
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount()] });

    const res = await request(app).post("/api/google/disconnect").send({});

    expect(res.body.ok).toBe(true);
    expect(gogCalls[1]).toBe('--client "acme-client" auth remove "user@example.com" --force');
    expect(readAccounts(statePath)).toHaveLength(0);
  });

  it("still removes the account when the token is already revoked upstream (400 invalid_token)", async () => {
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_token" }) });
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount()] });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(true);
    expect(gogCalls[1]).toBe('--client "acme-client" auth remove "user@example.com" --force');
    expect(readAccounts(statePath)).toHaveLength(0);
  });

  it("treats a 400 WITHOUT an invalid-token body as retryable (account kept)", async () => {
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_request" }) });
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount()] });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(false);
    expect(res.body.retryable).toBe(true);
    expect(res.body.accountId).toBe("acc1");
    expect(gogCalls.some((cmd) => cmd.includes("auth remove"))).toBe(false);
    expect(readAccounts(statePath)).toHaveLength(1);
  });

  it("keeps the account and returns a retryable error on revocation timeout/5xx", async () => {
    global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount()] });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(false);
    expect(res.body.retryable).toBe(true);
    // Echoes the RESOLVED accountId so accountId-less retries can pin the
    // target instead of re-resolving fallback-to-first onto another account.
    expect(res.body.accountId).toBe("acc1");
    // No auth remove, and the account survives for a retry.
    expect(gogCalls.some((cmd) => cmd.includes("auth remove"))).toBe(false);
    expect(readAccounts(statePath)).toHaveLength(1);

    // Network-level failure behaves the same way.
    global.fetch = async () => {
      throw new Error("socket hang up");
    };
    const retry = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });
    expect(retry.body.ok).toBe(false);
    expect(retry.body.retryable).toBe(true);
    expect(readAccounts(statePath)).toHaveLength(1);
  });

  it("removes the account without revocation when token export fails (nothing to revoke)", async () => {
    global.fetch = async () => {
      throw new Error("fetch must not be called when export fails");
    };
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount()], exportOk: false });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(true);
    expect(gogCalls[1]).toBe('--client "acme-client" auth remove "user@example.com" --force');
    expect(readAccounts(statePath)).toHaveLength(0);
  });

  it("does not clobber accounts written concurrently during the awaited revocation (fresh-read removal)", async () => {
    const { app, statePath } = build({ accounts: [baseAccount()] });
    // Simulate an OAuth-callback completion landing while the disconnect is
    // parked on the revoke fetch: the state file gains acc2 mid-flight. A
    // removal derived from the pre-await snapshot would erase acc2.
    global.fetch = async () => {
      writeGoogleState({
        fs,
        statePath,
        state: {
          version: 2,
          accounts: [baseAccount(), baseAccount({ id: "acc2", email: "two@example.com" })],
        },
      });
      return okFetch();
    };

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(true);
    const remaining = readAccounts(statePath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("acc2");
  });

  it("surfaces a warning when gog auth remove fails but state removal proceeds", async () => {
    global.fetch = okFetch;
    const { app, statePath } = build({ accounts: [baseAccount()], removeOk: false });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(true);
    expect(res.body.warning).toMatch(/credential entry may remain/);
    expect(readAccounts(statePath)).toHaveLength(0);
  });

  it("removes the account without revocation when the staged file has no refresh_token", async () => {
    global.fetch = async () => {
      throw new Error("fetch must not be called without a refresh token");
    };
    const { app, statePath, gogCalls } = build({ accounts: [baseAccount()], tokenData: {} });

    const res = await request(app).post("/api/google/disconnect").send({ accountId: "acc1" });

    expect(res.body.ok).toBe(true);
    expect(gogCalls[1]).toBe('--client "acme-client" auth remove "user@example.com" --force');
    expect(readAccounts(statePath)).toHaveLength(0);
  });
});
