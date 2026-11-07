const loadCodexOauthWindow = async () =>
  import("../../lib/public/js/lib/codex-oauth-window.js");

const kAuthorizeUrl = "https://auth.openai.com/oauth/authorize?state=abc";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("frontend/codex-oauth-window", () => {
  beforeEach(() => {
    vi.resetModules();
    global.window = {
      open: vi.fn(),
      postMessage: vi.fn(),
      location: { href: "http://localhost/", origin: "http://localhost" },
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: kAuthorizeUrl }),
    }));
  });

  afterEach(() => {
    delete global.fetch;
  });

  it("uses popup features when opening Codex auth", async () => {
    const popup = { closed: false, location: { href: "about:blank" }, close: vi.fn() };
    global.window.open.mockReturnValue(popup);
    const mod = await loadCodexOauthWindow();

    const opened = mod.openCodexAuthWindow();

    expect(global.window.open).toHaveBeenCalledWith(
      "",
      "codex-auth",
      "popup=yes,width=640,height=780",
    );
    expect(opened).toBe(popup);
    await flush();
    expect(popup.location.href).toBe(kAuthorizeUrl);
  });

  it("starts with a same-origin POST, never a GET another site could trigger (ALPH-71 L-10)", async () => {
    global.window.open.mockReturnValue({ closed: false, location: { href: "" }, close: vi.fn() });
    const mod = await loadCodexOauthWindow();

    mod.openCodexAuthWindow();
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("/auth/codex/start");
    expect(options.method).toBe("POST");
  });

  it("falls back to navigating the current page when opening fails", async () => {
    global.window.open.mockReturnValue(null);
    const mod = await loadCodexOauthWindow();

    const opened = mod.openCodexAuthWindow();

    expect(opened).toBeNull();
    await flush();
    expect(global.window.location.href).toBe(kAuthorizeUrl);
  });

  it("closes the popup and reports a refused start to this origin only", async () => {
    const popup = { closed: false, location: { href: "" }, close: vi.fn() };
    global.window.open.mockReturnValue(popup);
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "Cross-origin request refused", code: "origin_mismatch" }),
    }));
    const mod = await loadCodexOauthWindow();

    mod.openCodexAuthWindow();
    await flush();

    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe("");
    expect(global.window.postMessage).toHaveBeenCalledWith(
      { codex: "error", message: "Cross-origin request refused" },
      "http://localhost",
    );
  });

  it("detects automatic localhost callback messages", async () => {
    const mod = await loadCodexOauthWindow();

    expect(
      mod.isCodexAuthCallbackMessage({
        codex: "callback-input",
        input: "http://localhost:1455/auth/callback?code=abc&state=def",
      }),
    ).toBe(true);
    expect(mod.isCodexAuthCallbackMessage({ codex: "success" })).toBe(false);
    expect(
      mod.isCodexAuthCallbackMessage({
        codex: "callback-input",
        input: "   ",
      }),
    ).toBe(false);
  });
});
