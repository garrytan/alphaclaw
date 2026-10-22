// Guard (c): every async Express route handler goes through wrapAsync.
// Express 4 does not catch async rejections — an unwrapped rejection hangs
// the request forever AND feeds the unhandledRejection storm brake
// (utils/wrap-async.js header; audit F203/F207 found ~95 unwrapped sites).
const { auditTree, formatHits } = require("./guard-utils");
const { scanUnwrappedAsyncRoutes } = require("./scanners");

// PR 2a (the wrapAsync sweep) drove lib/server/ to zero; refactor PR 15 added
// lib/server.js as a root. Do not add entries for new routes.
const kKnownOffenders = {
  // Deliberate: the chat history read belongs to the chat bridge, which the
  // refactor plan leaves alone (docs/designs/chat-reliability.md). Its body
  // catches every await itself, so no rejection escapes today.
  "lib/server.js::GET /api/chat/history": "intentional: chat is out of the refactor's scope",
};

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
      roots: ["lib/server", "lib/server.js"],
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
