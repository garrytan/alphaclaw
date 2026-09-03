const express = require("express");
const compression = require("compression");
const request = require("supertest");

const { shouldCompress } = require("../../lib/server/compression-filter");

describe("server/compression-filter", () => {
  const createApp = () => {
    const app = express();
    app.use(compression({ filter: shouldCompress, threshold: 0 }));
    app.get("/api/big", (req, res) => {
      res.json({ data: "x".repeat(4096) });
    });
    app.get("/api/stream", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.write("data: hello\n\n");
      res.end();
    });
    return app;
  };

  it("gzips JSON responses when the client accepts it", async () => {
    const res = await request(createApp())
      .get("/api/big")
      .set("Accept-Encoding", "gzip");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.body.data).toHaveLength(4096);
  });

  it("never compresses event streams", async () => {
    const res = await request(createApp())
      .get("/api/stream")
      .set("Accept", "text/event-stream")
      .set("Accept-Encoding", "gzip");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.text).toContain("data: hello");
  });

  it("skips streams identified by response content type alone", async () => {
    // A reconnecting EventSource may omit the Accept header; the response's
    // own Content-Type must still bypass compression.
    const res = await request(createApp())
      .get("/api/stream")
      .set("Accept-Encoding", "gzip");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
  });
});
