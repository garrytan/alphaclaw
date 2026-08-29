const express = require("express");
const request = require("supertest");
const { wrapAsync } = require("../../lib/server/utils/wrap-async");

describe("server/utils/wrap-async", () => {
  it("passes async handler rejections to next", async () => {
    const boom = new Error("boom");
    const handler = wrapAsync(async () => {
      throw boom;
    });
    const next = vi.fn();

    await handler({}, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(boom);
  });

  it("does not call next with an error when the handler resolves", async () => {
    const res = { json: vi.fn() };
    const handler = wrapAsync(async (_req, response) => {
      response.json({ ok: true });
    });
    const next = vi.fn();

    await handler({}, res, next);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("routes a rejected async handler to the express error middleware (no hang)", async () => {
    const app = express();
    app.get(
      "/boom",
      wrapAsync(async () => {
        throw new Error("async kaboom");
      }),
    );
    // Express 4 never sees unwrapped async rejections — the request would
    // hang forever. With wrapAsync, this error middleware answers instead.
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err.message });
    });

    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "async kaboom" });
  });

  it("serves successful async handlers through express normally", async () => {
    const app = express();
    app.get(
      "/ok",
      wrapAsync(async (_req, res) => {
        res.json({ ok: true });
      }),
    );
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err.message });
    });

    const res = await request(app).get("/ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
