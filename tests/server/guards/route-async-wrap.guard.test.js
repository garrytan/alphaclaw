// Guard (c): every async Express route handler goes through wrapAsync.
// Express 4 does not catch async rejections — an unwrapped rejection hangs
// the request forever AND feeds the unhandledRejection storm brake
// (utils/wrap-async.js header; audit F203/F207 found ~95 unwrapped sites).
const { auditTree, formatHits } = require("./guard-utils");
const { scanUnwrappedAsyncRoutes } = require("./scanners");

// PR 2a (the wrapAsync sweep) drives this list to zero. Until then every
// entry is a known unwrapped async handler: a throw before res.json hangs the
// request and lands as an unhandledRejection.
// PR 2a (the wrapAsync sweep) drove this list to zero: every async route
// handler in lib/server goes through wrapAsync. Keep it empty.
const kKnownOffenders = {};

describe("guard: async route handlers are wrapped with wrapAsync", () => {
  it("detects an unwrapped async handler, with and without middleware, and accepts wrapped ones (self-test)", () => {
    const fixture = [
      'app.get("/api/a", async (req, res) => { res.json({}); });',
      'app.post("/api/b", requireAdmin, async ({ body }, res) => { res.json(body); });',
      'app.put("/api/c", wrapAsync(async (req, res) => { res.json({}); }));',
      'app.delete("/api/d", (req, res) => { const run = async () => {}; run(); });',
    ].join("\n");
    const hits = scanUnwrappedAsyncRoutes(fixture, "lib/server/routes/planted.js");
    expect(hits.map((h) => h.key.split("::")[1])).toEqual(["GET /api/a", "POST /api/b"]);
  });

  it("has no unwrapped async route handlers outside the allowlist, and no stale entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib/server"],
      scan: scanUnwrappedAsyncRoutes,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `Unwrapped async route handler(s) — wrap with wrapAsync(...) from lib/server/utils/wrap-async.js:\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(stale, `Stale allowlist entries:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
