const express = require("express");
const request = require("supertest");
const { registerOpenclawChannelRoutes } = require("../../lib/server/routes/openclaw-channel");
const manifest = require("../../lib/server/admin-manifest");

const operationId = "2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d";
const endpoint = "/api/openclaw/recovery/cancel";
const harness = ({ agent = false, result, unavailable = false } = {}) => {
  const cancelRecoveryReview = vi.fn(async () => result || {
    status: 200, body: { ok: true, resumed: true, operationId },
  });
  const app = express();
  app.use(express.json());
  if (agent) app.use((req, res, next) => {
    req.alphaclawActor = { type: "agent" };
    next();
  });
  registerOpenclawChannelRoutes({ app, openclawChannelService: unavailable ? {} : { cancelRecoveryReview } });
  return { app, cancelRecoveryReview };
};

describe("held recovery review cancellation route", () => {
  it("resumes only the named held operation and disables response caching", async () => {
    const h = harness();
    const response = await request(h.app).post(endpoint).set("Cookie", "setup_token=test-human-session").send({ operationId });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, resumed: true, operationId });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(h.cancelRecoveryReview).toHaveBeenCalledExactlyOnceWith({ operationId });
  });

  it("denies an agent even when it supplies a human-looking cookie", async () => {
    const h = harness({ agent: true });
    const response = await request(h.app).post(endpoint).set("Cookie", "setup_token=test-human-session").send({ operationId });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("humans_only");
    expect(h.cancelRecoveryReview).not.toHaveBeenCalled();
    expect(manifest.findOp("POST", endpoint).tier).toBe("denied");
  });

  it("requires a human session", async () => {
    const h = harness();
    const response = await request(h.app).post(endpoint).send({ operationId });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("human_session_required");
    expect(h.cancelRecoveryReview).not.toHaveBeenCalled();
  });

  it.each([{}, [], { operationId: "../../other" }, { operationId: 42 },
    { operationId, sourceBuild: "forged" }, { operationId, confirmNoBackup: true }])(
    "rejects malformed or expanded cancellation bodies: %j", async (body) => {
      const h = harness();
      const response = await request(h.app).post(endpoint).set("Cookie", "setup_token=test-human-session").send(body);
      expect(response.status).toBe(400);
      expect(h.cancelRecoveryReview).not.toHaveBeenCalled();
    },
  );

  it.each(["recovery_review_stale", "recovery_source_changed", "db_preflight_failed", "gateway_relaunch_failed"])(
    "preserves service refusal %s without reporting a resume", async (code) => {
      const h = harness({ result: { status: 409, body: { ok: false, code, hint: "Keep the gateway held." } } });
      const response = await request(h.app).post(endpoint).set("Cookie", "setup_token=test-human-session").send({ operationId });
      expect(response.status).toBe(409);
      expect(response.body).toEqual({ ok: false, code, hint: "Keep the gateway held." });
    },
  );

  it("refuses when the recovery service is unavailable", async () => {
    const h = harness({ unavailable: true });
    const response = await request(h.app).post(endpoint).set("Cookie", "setup_token=test-human-session").send({ operationId });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("recovery_cancel_unavailable");
  });
});
