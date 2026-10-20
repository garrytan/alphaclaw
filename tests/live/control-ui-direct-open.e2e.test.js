const { kLiveEnabled, openclawCliUsable, waitFor } = require("./live-helpers");
const {
  kBootTimeoutMs,
  startControlUiInstall,
  launchChromium,
  loginInPage,
  chatRoundTrip,
} = require("./control-ui-live");

// LIVE tier, REAL browser: a signed-in admin opens the Control UI by typing
// its URL, with no /gateway/launch hop, and it connects.
//
//   fresh browser ── GET /openclaw/chat ──▶ 302 /gateway/attach?to=/openclaw/chat
//        page POSTs /gateway/attach ──▶ token ──▶ sessionStorage ──▶ /openclaw/chat ──▶ hello-ok
//
// Before, the gateway token only reached a tab through /gateway/launch's
// #token=, and the sidebar logout clears both storages, so a fresh tab, a new
// browser or a log-out/log-in landed on "This Gateway expects its token".
// 2026.10.5+ also answered a fresh /openclaw/chat/<session> with the 404
// "Conversation unavailable" public-share page. Every journey below must reach
// hello-ok, and the gateway token must never appear in any URL the browser
// requested, any redirect Location, or the server log.
//
// Run: OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/control-ui-direct-open.e2e.test.js --no-file-parallelism
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 4 * 60 * 1000;
const kSetupPassword = "live-control-ui-direct-open-pass";
const kGatewayToken = `live-direct-open-${Date.now().toString(36)}-gwtoken`;

describeLive("live: a signed-in admin opens the Control UI directly (real browser)", () => {
  const cliUsable = openclawCliUsable();
  const itLive = cliUsable ? it : it.skip;

  let install;
  let base;
  let browser = null;
  let browserSkipReason = null;

  beforeAll(async () => {
    if (!cliUsable) return;
    install = await startControlUiInstall({
      label: "control-ui-direct-open",
      setupPassword: kSetupPassword,
      gatewayToken: kGatewayToken,
      extraEnv: (port) => ({ ALPHACLAW_SETUP_URL: `http://127.0.0.1:${port}` }),
    });
    base = `http://127.0.0.1:${install.port}`;
    ({ browser = null, skipReason: browserSkipReason = null } = await launchChromium({
      label: "control-ui-direct-open",
    }));
  }, kBootTimeoutMs + 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } catch {}
    await install?.stop();
  }, 90_000);

  // A browser context that records every URL, redirect target and WS frame.
  const openContext = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const seen = { urls: [], locations: [], frames: [] };
    context.on("request", (req) => seen.urls.push(req.url()));
    context.on("response", (res) => {
      const location = res.headers().location;
      if (location) seen.locations.push(location);
    });
    const page = await context.newPage();
    page.on("websocket", (ws) => {
      ws.on("framereceived", ({ payload }) => {
        seen.frames.push(typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"));
      });
    });
    return { context, page, seen };
  };

  // Call BEFORE the navigation it checks: only frames after "from" count.
  const connectMark = (seen) => seen.frames.length;
  const expectConnected = async (seen, label, from) => {
    const connectAnswers = () =>
      seen.frames
        .slice(from)
        .filter((f) => f.includes("hello-ok") || /"code":"(?:INVALID_REQUEST|UNAUTHORIZED)"/.test(f));
    await waitFor(() => connectAnswers().length > 0, 60_000, `a connect answer for ${label}`).catch(() => {});
    const evidence = `${label}: ${JSON.stringify(connectAnswers().slice(0, 3))}\nlog tail: ${install.logTail()}`;
    expect(connectAnswers()[0] || "", evidence).toContain("hello-ok");
  };

  const expectTokenNeverExposed = (seen) => {
    expect(seen.urls.filter((u) => u.includes(kGatewayToken))).toEqual([]);
    expect(seen.locations.filter((l) => l.includes(kGatewayToken))).toEqual([]);
    expect(install.getServerLog().includes(kGatewayToken)).toBe(false);
  };

  const skipWithoutBrowser = (ctx) => {
    if (browser) return false;
    ctx.skip(`browser unavailable: ${browserSkipReason || "not launched"}`);
    return true;
  };

  itLive(
    "a fresh browser types /openclaw/chat: it connects, chats, survives a reload, and the token never rides a URL",
    async (ctx) => {
      if (skipWithoutBrowser(ctx)) return;
      const { context, page, seen } = await openContext();
      try {
        expect(await loginInPage(page, base, kSetupPassword)).toBe(200);
        let mark = connectMark(seen);
        await page.goto(`${base}/openclaw/chat`, { waitUntil: "load" });
        await page.waitForURL((url) => url.pathname.startsWith("/openclaw/chat"), { timeout: 30_000 });
        await expectConnected(seen, "fresh /openclaw/chat", mark);
        await chatRoundTrip(page);

        const detoursBefore = seen.urls.filter((u) => u.includes("/gateway/attach")).length;
        mark = connectMark(seen);
        await page.reload({ waitUntil: "load" });
        await expectConnected(seen, "reload", mark);
        expect(seen.urls.filter((u) => u.includes("/gateway/attach")).length).toBe(detoursBefore);
        expectTokenNeverExposed(seen);
      } finally {
        await context.close().catch(() => {});
      }
    },
    kTestTimeoutMs,
  );

  itLive(
    "a fresh tab deep-links a session (/openclaw/chat/main) and connects instead of the public-share 404",
    async (ctx) => {
      if (skipWithoutBrowser(ctx)) return;
      const { context, page, seen } = await openContext();
      try {
        expect(await loginInPage(page, base, kSetupPassword)).toBe(200);
        const mark = connectMark(seen);
        await page.goto(`${base}/openclaw/chat/main`, { waitUntil: "load" });
        await page.waitForURL((url) => url.pathname.startsWith("/openclaw/chat/main"), { timeout: 30_000 });
        await expectConnected(seen, "fresh /openclaw/chat/main", mark);
        expect(await page.evaluate(() => document.body.innerText)).not.toContain("Conversation unavailable");
        await chatRoundTrip(page);
        expectTokenNeverExposed(seen);
      } finally {
        await context.close().catch(() => {});
      }
    },
    kTestTimeoutMs,
  );

  itLive(
    "log out (sidebar semantics) then log back in: signed out gets the login page and 401s, signed in connects directly again",
    async (ctx) => {
      if (skipWithoutBrowser(ctx)) return;
      const { context, page, seen } = await openContext();
      try {
        expect(await loginInPage(page, base, kSetupPassword)).toBe(200);
        let mark = connectMark(seen);
        await page.goto(`${base}/openclaw/agents`, { waitUntil: "load" });
        await page.waitForURL((url) => url.pathname.startsWith("/openclaw/agents"), { timeout: 30_000 });
        await expectConnected(seen, "first open", mark);

        await page.goto(`${base}/`, { waitUntil: "load" });
        await page.evaluate(async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          localStorage.clear();
          sessionStorage.clear();
        });
        // The dashboard may itself bounce to /login.html once its session is
        // gone, aborting this navigation; either way the tab must end there.
        await page.goto(`${base}/openclaw/chat`, { waitUntil: "load" }).catch(() => {});
        await page.waitForURL((url) => url.pathname === "/login.html", { timeout: 30_000 });
        const signedOut = await page.evaluate(async () => {
          const asset = await fetch("/openclaw/sw.js", { redirect: "manual" });
          const attach = await fetch("/gateway/attach", {
            method: "POST",
            redirect: "manual",
            headers: { "x-alphaclaw-attach": "1" },
          });
          return { asset: asset.status, attach: attach.status, attachBody: await attach.text() };
        });
        expect(signedOut.asset).toBe(401);
        expect(signedOut.attach).toBe(401);

        expect(await loginInPage(page, base, kSetupPassword)).toBe(200);
        mark = connectMark(seen);
        await page.goto(`${base}/openclaw/chat`, { waitUntil: "load" });
        await page.waitForURL((url) => url.pathname.startsWith("/openclaw/chat"), { timeout: 30_000 });
        await expectConnected(seen, "after re-login", mark);
        await chatRoundTrip(page);
        expectTokenNeverExposed(seen);
      } finally {
        await context.close().catch(() => {});
      }
    },
    kTestTimeoutMs,
  );
});
