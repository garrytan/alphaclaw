const {
  createBootPlaceholderHandler,
  renderPlaceholderPage,
} = require("../../lib/boot-placeholder");

const createFakeRes = () => ({ writeHead: vi.fn(), end: vi.fn() });
const call = (handler, url, headers = {}) => {
  const res = createFakeRes();
  handler({ url, headers }, res);
  return { status: res.writeHead.mock.calls[0][0], headers: res.writeHead.mock.calls[0][1], body: String(res.end.mock.calls[0][0]) };
};

describe("boot placeholder: Preparing only, public frame", () => {
  it("answers /boot-progress.json with the fixed preparing frame, its own bootId and the stuck verdict", () => {
    let t = 1_000;
    const handler = createBootPlaceholderHandler({ startedAtMs: 1_000, maxUpdatingWindowMs: 60_000, now: () => t, bootId: "abc123" });
    const fresh = call(handler, "/boot-progress.json");
    expect(fresh.status).toBe(200);
    expect(fresh.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(fresh.body)).toEqual({
      v: 1, source: "placeholder", kind: "preparing", label: "Restarting", bootId: "abc123", stage: "preparing", stuck: false,
    });
    t = 1_000 + 60_001;
    expect(JSON.parse(call(handler, "/boot-progress.json?x=1").body).stuck).toBe(true);
    // The /health flip and its deadline are unchanged.
    expect(call(handler, "/health").status).toBe(503);
  });

  it("says updating only for a pending self-update", () => {
    const restart = createBootPlaceholderHandler({ now: () => Date.now() });
    const update = createBootPlaceholderHandler({ kind: "updating", now: () => Date.now() });
    expect(call(restart, "/", { accept: "text/html" }).body).toContain("<h1>AlphaClaw is restarting</h1>");
    expect(call(restart, "/", { accept: "text/html" }).body).not.toContain("updating");
    expect(call(update, "/", { accept: "text/html" }).body).toContain("<h1>AlphaClaw is updating</h1>");
    expect(JSON.parse(call(update, "/boot-progress.json").body).label).toBe("Updating AlphaClaw");
  });

  it("derives a stable opaque bootId per placeholder process when none is injected", () => {
    const handler = createBootPlaceholderHandler({ startedAtMs: 42, now: () => 43 });
    const a = JSON.parse(call(handler, "/boot-progress.json").body).bootId;
    const b = JSON.parse(call(handler, "/boot-progress.json").body).bootId;
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(b);
  });

  it("renders the stage Preparing with elapsed time outside the live region", () => {
    const html = renderPlaceholderPage({ elapsedMs: 65_000 });
    expect(html).toContain('<span role="status">Preparing</span>');
    expect(html).toMatch(/<span class="elapsed" aria-hidden="true">&middot; <span id="elapsed">1m 5s<\/span>/);
    expect(html).toContain('<p class="stuck" id="stuck" role="alert" hidden>');
    expect(renderPlaceholderPage({ stuck: true })).toContain('<p class="stuck" id="stuck" role="alert">');
    expect(renderPlaceholderPage({ stuck: true })).toContain("restart AlphaClaw from your host's dashboard");
  });

  it("respects the light theme: prefers-color-scheme plus the dashboard's saved choice, no hard-coded body colors", () => {
    const html = renderPlaceholderPage();
    expect(html).toContain("@media (prefers-color-scheme: light)");
    expect(html).toContain("background:var(--bg)");
    expect(html).not.toContain("background:#0b0e14");
    expect(html).toContain("alphaclaw.ui.theme");
    expect(html).toContain('<meta name="color-scheme" content="dark light">');
  });

  it("reloads into the app when /boot-progress.json is answered by anything but the placeholder", () => {
    const html = renderPlaceholderPage();
    expect(html).toContain("fetch('/boot-progress.json'");
    expect(html).toContain("f.source!=='placeholder'");
    expect(html).toContain("location.reload()");
  });

  it("names no version, path or error in the page or the frame", () => {
    const handler = createBootPlaceholderHandler({ kind: "updating", now: () => Date.now() });
    const page = call(handler, "/", { accept: "text/html" }).body;
    const frame = call(handler, "/boot-progress.json").body;
    for (const text of [page, frame]) {
      expect(text).not.toMatch(/\d+\.\d+\.\d+/);
      expect(text).not.toMatch(/\/(data|home|root|tmp|app)\//);
      expect(text).not.toMatch(/error|doctor|openclaw\.json/i);
    }
  });
});
