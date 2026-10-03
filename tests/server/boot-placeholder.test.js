const {
  createBootPlaceholderHandler,
  kMaxUpdatingWindowMs,
  kPlaceholderAbsoluteMaxMs,
} = require("../../lib/boot-placeholder");

// The placeholder handler is plain (req, res) — no Express, no sockets — so
// fake objects with writeHead/end spies cover the full behavior with an
// injected clock.
const createFakeReq = ({ url = "/", headers = {} } = {}) => ({ url, headers });

const createFakeRes = () => {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return res;
};

const parseJsonBody = (res) => JSON.parse(String(res.end.mock.calls[0][0]));

describe("boot-placeholder", () => {
  it("exports a 15 minute stuck-window default", () => {
    expect(kMaxUpdatingWindowMs).toBe(15 * 60 * 1000);
  });

  it("answers /health 200 {status:updating} inside the updating window", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 30_000,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/health" }), res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });
    expect(parseJsonBody(res)).toEqual({ status: "updating", gateway: "starting" });
  });

  it("flips /health to 503 with the same body once boot exceeds maxUpdatingWindowMs", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 60_001,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/health" }), res);

    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "application/json",
    });
    expect(parseJsonBody(res)).toEqual({ status: "updating", gateway: "starting" });
  });

  it("matches /health with a query string", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 5_000,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/health?probe=1" }), res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });
    expect(parseJsonBody(res)).toEqual({ status: "updating", gateway: "starting" });
  });

  it("serves browsers a 503 auto-refreshing HTML page with Retry-After", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 5_000,
    });
    const res = createFakeRes();

    handler(
      createFakeReq({
        url: "/",
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
      res,
    );

    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "text/html; charset=utf-8",
      "Retry-After": "5",
    });
    const body = String(res.end.mock.calls[0][0]);
    expect(body).toContain('<meta http-equiv="refresh" content="5">');
    expect(body).toContain("AlphaClaw is updating");
  });

  it("renders mobile-safe: viewport meta and min-height centering", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 5_000,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/", headers: { accept: "text/html" } }), res);

    const body = String(res.end.mock.calls[0][0]);
    // Phones fall back to a ~980px viewport without this meta.
    expect(body).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    // min-height keeps flex centering without trapping overflow off-screen.
    expect(body).toContain("min-height:100vh");
    expect(body).not.toContain(";height:100vh");
  });

  it("serves non-browser clients a 503 JSON body with Retry-After", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 5_000,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/api/watchdog/status", headers: {} }), res);

    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "application/json",
      "Retry-After": "5",
    });
    expect(parseJsonBody(res)).toEqual({
      ok: false,
      error: "AlphaClaw is updating",
      status: "updating",
    });
  });
});

describe("boot-placeholder absolute cap", () => {
  it("exports a 60 minute absolute cap default", () => {
    expect(kPlaceholderAbsoluteMaxMs).toBe(60 * 60 * 1000);
  });

  const healthStatus = (handler) => {
    const res = createFakeRes();
    handler(createFakeReq({ url: "/health" }), res);
    return res.writeHead.mock.calls[0][0];
  };

  it("flips /health to 503 at the absolute cap when it is shorter than the window", () => {
    let t = 0;
    const handler = createBootPlaceholderHandler({
      startedAtMs: 0,
      maxUpdatingWindowMs: 10_000_000,
      absoluteMaxMs: 100_000,
      now: () => t,
    });

    t = 99_000;
    expect(healthStatus(handler)).toBe(200);
    t = 101_000;
    expect(healthStatus(handler)).toBe(503);
  });

  it("serves the static page with no run or hold copy", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 0,
      maxUpdatingWindowMs: 60_000,
      now: () => 5_000,
    });
    const res = createFakeRes();
    handler(createFakeReq({ url: "/", headers: { accept: "text/html" } }), res);

    const body = String(res.end.mock.calls[0][0]);
    expect(body).toContain("couple of minutes");
    expect(body).not.toContain("Updating to OpenClaw");
    expect(body).not.toContain("migration");
  });
});
