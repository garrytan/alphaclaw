const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { registerGuestWritesRoutes } = require("../../lib/server/routes/guest-writes");
const { GuestWriteError } = require("../../lib/server/guest-writes");

const kSecret = "a".repeat(64);

const build = ({ actor = null, guestWrites: overrides = {} } = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (actor) req.alphaclawActor = actor;
    next();
  });
  const guestWrites = {
    isInternalSecret: (bearer) => bearer === kSecret,
    claim: vi.fn(() => ({ ok: true, claim_ref: "ref" })),
    save: vi.fn(async () => ({ status: "saved", slug: "guests/x", say: "Saved as a guest note." })),
    status: vi.fn(async () => ({ available: false, reason: "no_guest_marker", groups: {} })),
    setGroup: vi.fn(async ({ groupKey, enabled }) => ({ enabled, dailyCap: 20, liveCap: 200, groupKey })),
    ...overrides,
  };
  registerGuestWritesRoutes({ app, requireAuth: (req, res, next) => next(), guestWrites, log: () => {} });
  return { app, guestWrites };
};

describe("guest notes routes", () => {
  it("answers the internal routes like no route without the secret or through a proxy", async () => {
    const { app, guestWrites } = build();
    await request(app).post("/internal/guest-writes/claim").send({}).expect(404);
    await request(app).post("/internal/guest-writes/claim").set("authorization", "Bearer wrong").send({}).expect(404);
    await request(app).post("/internal/guest-writes/save").set("authorization", "Bearer " + kSecret).set("x-forwarded-for", "1.2.3.4").send({}).expect(404);
    await request(app).post("/internal/guest-writes/save").set("authorization", "Bearer " + kSecret).set("forwarded", "for=1.2.3.4").send({}).expect(404);
    expect(guestWrites.claim).not.toHaveBeenCalled();
    expect(guestWrites.save).not.toHaveBeenCalled();
    const ok = await request(app).post("/internal/guest-writes/claim").set("authorization", "Bearer " + kSecret).send({ run_id: "r" }).expect(200);
    expect(ok.body).toEqual({ ok: true, claim_ref: "ref" });
  });

  it("returns a save's refusal code and nothing internal", async () => {
    const { app } = build({ guestWrites: { save: async () => { throw new GuestWriteError("guest_cap_reached", "daily"); } } });
    const res = await request(app).post("/internal/guest-writes/save").set("authorization", "Bearer " + kSecret).send({}).expect(200);
    expect(res.body).toEqual({ ok: false, code: "guest_cap_reached" });
  });

  it("keeps turning a group on or off to people, and refuses on until the brain supports it", async () => {
    await request(build({ actor: { type: "agent" } }).app).put("/api/guest-notes/groups/telegram%3A-1001").send({ enabled: true }).expect(403);
    const { app } = build({ guestWrites: { setGroup: async () => { throw new GuestWriteError("guest_saves_unavailable"); } } });
    const res = await request(app).put("/api/guest-notes/groups/telegram%3A-1001").send({ enabled: true }).expect(409);
    expect(res.body.code).toBe("guest_saves_unavailable");
    const human = build();
    const done = await request(human.app).put("/api/guest-notes/groups/telegram%3A-1001").send({ enabled: false }).expect(200);
    expect(human.guestWrites.setGroup).toHaveBeenCalledWith({ groupKey: "telegram:-1001", enabled: false });
    expect(done.body.ok).toBe(true);
  });

  it("serves status to the agent", async () => {
    const res = await request(build({ actor: { type: "agent" } }).app).get("/api/guest-notes").expect(200);
    expect(res.body).toMatchObject({ ok: true, available: false, reason: "no_guest_marker" });
  });
});
