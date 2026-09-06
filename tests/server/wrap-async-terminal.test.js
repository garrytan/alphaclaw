const express = require("express");
const request = require("supertest");

const { wrapAsync } = require("../../lib/server/utils/wrap-async");

// Fix wave PR 2a: every async route handler in lib/server goes through
// wrapAsync (guard test route-async-wrap holds the count at zero). This pins
// the contract the sweep relies on end to end: a rejection BEFORE res.json
// reaches the terminal JSON error middleware (the shape lib/server.js
// installs) instead of hanging the request forever and surfacing only as an
// unhandledRejection.
const buildApp = () => {
  const app = express();
  app.get(
    "/api/boom",
    wrapAsync(async () => {
      throw Object.assign(new Error("db exploded: /data/secret/path"), { status: undefined });
    }),
  );
  app.get(
    "/api/teapot",
    wrapAsync(async () => {
      throw Object.assign(new Error("short and stout"), { status: 418 });
    }),
  );
  app.get(
    "/api/ok",
    wrapAsync(async (req, res) => {
      res.json({ ok: true });
    }),
  );
  // Mirror of the terminal middleware in lib/server.js.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.destroy();
    const status = Number(err?.status || err?.statusCode) || 500;
    const message = status >= 500 ? "Internal server error" : err?.message || "Request failed";
    res.status(status).json({ ok: false, error: message });
  });
  return app;
};

describe("wrapAsync + terminal JSON error middleware", () => {
  it("turns a pre-response rejection into a JSON 500 without leaking the message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(buildApp()).get("/api/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("/data/secret/path");
    errorSpy.mockRestore();
  });

  it("honors an explicit 4xx status and message", async () => {
    const res = await request(buildApp()).get("/api/teapot");
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ ok: false, error: "short and stout" });
  });

  it("does not interfere with a handler that responds normally", async () => {
    const res = await request(buildApp()).get("/api/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
