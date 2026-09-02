const express = require("express");
const request = require("supertest");
const { registerCodexRoutes } = require("../../lib/server/routes/codex");

const createApp = ({ changed = true } = {}) => {
  const app = express();
  app.use(express.json());
  const onAuthChanged = vi.fn();
  registerCodexRoutes({
    app,
    createPkcePair: () => ({ verifier: "verifier", challenge: "challenge" }),
    parseCodexAuthorizationInput: () => ({}),
    getCodexAccountId: () => null,
    authProfiles: {
      getCodexProfile: () => null,
      removeCodexProfiles: () => changed,
    },
    onAuthChanged,
  });
  return { app, onAuthChanged };
};

describe("server/routes/codex", () => {
  it("invalidates model discovery when Codex auth is disconnected", async () => {
    const { app, onAuthChanged } = createApp();

    await request(app).post("/api/codex/disconnect").expect(200, {
      ok: true,
      changed: true,
    });

    expect(onAuthChanged).toHaveBeenCalledOnce();
  });

  it("does not invalidate model discovery when disconnect changes nothing", async () => {
    const { app, onAuthChanged } = createApp({ changed: false });

    await request(app).post("/api/codex/disconnect").expect(200, {
      ok: true,
      changed: false,
    });

    expect(onAuthChanged).not.toHaveBeenCalled();
  });

  it("maps a state-DB quiet-period disconnect to 409 backup_in_progress with Retry-After", async () => {
    const { StateDbQuietError } = require("../../lib/server/state-db-quiet");
    const app = express();
    app.use(express.json());
    const onAuthChanged = vi.fn();
    registerCodexRoutes({
      app,
      createPkcePair: () => ({ verifier: "verifier", challenge: "challenge" }),
      parseCodexAuthorizationInput: () => ({}),
      getCodexAccountId: () => null,
      authProfiles: {
        getCodexProfile: () => null,
        removeCodexProfiles: () => {
          throw new StateDbQuietError();
        },
      },
      onAuthChanged,
    });

    const res = await request(app).post("/api/codex/disconnect");

    expect(res.status).toBe(409);
    expect(res.headers["retry-after"]).toBe("120");
    expect(res.body).toEqual({
      ok: false,
      code: "backup_in_progress",
      error: "A backup is in progress; retry in about two minutes.",
    });
    expect(onAuthChanged).not.toHaveBeenCalled();
  });

  it("keeps the 503 retry mapping for other fail-closed auth-store errors", async () => {
    const app = express();
    app.use(express.json());
    registerCodexRoutes({
      app,
      createPkcePair: () => ({ verifier: "verifier", challenge: "challenge" }),
      parseCodexAuthorizationInput: () => ({}),
      getCodexAccountId: () => null,
      authProfiles: {
        getCodexProfile: () => null,
        removeCodexProfiles: () => {
          throw new Error("state/openclaw.sqlite is busy");
        },
      },
      onAuthChanged: vi.fn(),
    });

    const res = await request(app).post("/api/codex/disconnect");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: "state/openclaw.sqlite is busy" });
  });
});
