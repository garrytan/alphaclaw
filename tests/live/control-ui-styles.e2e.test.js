const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const {
  kLiveEnabled,
  mkTemp,
  openclawCliUsable,
  repoOpenclawBin,
  repoBinDir,
  scrubTestRunnerEnv,
  waitFor,
} = require("./live-helpers");

// LIVE tier, REAL browser: the test that literally checks the message from the
// bug screenshot — "Styles failed to load, so the page may look broken.
// [Reload]" — against a REAL AlphaClaw supervising a REAL OpenClaw gateway,
// rendered by a REAL Chromium through AlphaClaw's /openclaw proxy.
//
//   openclaw onboard (writes openclaw.json WITHOUT gateway.controlUi.basePath —
//   exactly an EXISTING install migrating onto this release)
//     └─► bin/alphaclaw.js start ── ensureGatewayProxyConfig adds basePath=/openclaw
//           └─► real gateway launches, stamps <html data-openclaw-control-ui-base-path="/openclaw">
//                 └─► Chromium opens /openclaw/#token=… THROUGH the proxy
//                       fonts, themes, sw.js, bootstrap config all under /openclaw/…
//
// Why each assertion exists:
//   - THE BANNER. OpenClaw's installMissingStylesheetRecovery() shows the
//     screenshot banner when `--openclaw-css-ok` is not "1" at load or when
//     ANY <link rel=stylesheet> fires `error`. The old prefix-strip mount made
//     the gateway stamp an EMPTY base path, so the UI fetched
//     /fonts/<face>.css from AlphaClaw's root, got a 404/HTML and tripped it.
//     We assert no alert with that text (and, locale-independently, no alert
//     holding a "Reload" button), the css-ok sentinel, every stylesheet's
//     `sheet`, and that the woff2 files REALLY rendered (`document.fonts.load`)
//     — a loaded stylesheet alone proves nothing about the font files.
//   - THE SERVICE-WORKER CACHE-POISONING CLASS. The fix makes the pinned
//     ui/public/sw.js register for the first time (scope /openclaw/). It caches
//     ANY `response.ok` under the requested URL. An expired AlphaClaw session
//     used to turn a chunk/font GET into 302 → /login.html (200, ok), which the
//     worker would cache under the asset URL and serve forever. requireAuth now
//     answers Control UI RESOURCES with 401 (documents still redirect). Step 4
//     is the browser-side demo: clear the cookie under a CONTROLLING worker,
//     force an uncached chunk fetch, and prove no text/html sits under any
//     /openclaw/assets/ or /openclaw/fonts/ cache key — then that a hard reload
//     still lands on the login page.
//   - THE CANARY. A context with service workers BLOCKED (a worker would fetch
//     fonts itself and bypass page.route) and every /openclaw/fonts/** request
//     aborted MUST show the banner (after the UI's one automatic reload).
//     Without it a green run could not distinguish "fixed" from "the detector
//     never ran".
//   - THE ROLLBACK DRILL. ALPHACLAW_CONTROL_UI_MOUNT=legacy is the no-code-
//     revert fallback. On the SAME install and browser context (worker still
//     registered) we respawn in legacy mode and prove the key is removed, the
//     gateway restarted in root mode (stamp ""), the page still renders, and
//     then round-trip back to the default with the key restored.
//
// Excluded from `npm test`; run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/control-ui-styles.e2e.test.js --no-file-parallelism
// or `npm run test:live:control-ui`. Needs a Chromium: CHROME_BIN, else
// `google-chrome` on PATH, else Playwright's bundled browser
// (`npx playwright install chromium`). In CI a missing browser FAILS the
// suite — a silently skipped browser test would be a hole in the only real
// integration proof of the fix.
const describeLive = kLiveEnabled ? describe : describe.skip;

const kBootTimeoutMs = 4 * 60 * 1000;
const kTestTimeoutMs = 6 * 60 * 1000;
const kRenderTimeoutMs = 60_000;
const kWorkerControlTimeoutMs = 30_000;
const kCanaryBannerTimeoutMs = 45_000;
const kSetupPassword = "live-control-ui-styles-pass";
// The mount path AlphaClaw's proxy, dashboard links and the gateway's
// gateway.controlUi.basePath all agree on (lib/server/control-ui-mount.js).
const kMountPath = "/openclaw";
const kBasePathAttr = "data-openclaw-control-ui-base-path";
// Exact English text of OpenClaw's lazyView.stylesFailed string (the
// screenshot). The button-shaped check below is the locale-independent twin.
const kBannerText = "Styles failed to load";
const kReloadButtonText = "Reload";
// Playwright's `websocket` observer sees the CONNECT handshake's hello-ok
// frame — the same frame lib/server/chat-ws.js treats as "connected".
const kHelloOkMarker = "hello-ok";

// Browser resolution order (tests/browser/watchdog-memory-smoke.mjs uses the
// same first two): an explicit CHROME_BIN, the system google-chrome, else
// undefined so Playwright launches its bundled Chromium.
const resolveChromeExecutable = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const found = execFileSync("which", ["google-chrome"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found) return found;
  } catch {}
  return undefined;
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

const httpGet = async (url, { cookie, redirect = "manual", method = "GET" } = {}) => {
  const res = await fetch(url, {
    method,
    redirect,
    headers: cookie ? { cookie } : {},
  });
  return {
    status: res.status,
    headers: res.headers,
    body: await res.text(),
  };
};

const pathnameOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url || "");
  }
};

// A stylesheet-class resource: what the banner's detector reacts to (the
// stylesheet link) plus the files it pulls in (theme/font CSS, woff2 faces).
const isStyleResource = ({ url, resourceType }) => {
  const pathname = pathnameOf(url);
  return (
    resourceType === "stylesheet" ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".woff2")
  );
};

// Observers MUST be attached before the first navigation: Playwright only
// reports responses/failures/sockets that happen after the listener exists,
// and the font CSS + WS connect fire during the initial load.
const observePage = (page) => {
  const observed = { responses: [], failed: [], sockets: [] };
  page.on("response", (res) => {
    observed.responses.push({
      url: res.url(),
      status: res.status(),
      resourceType: res.request().resourceType(),
    });
  });
  page.on("requestfailed", (req) => {
    observed.failed.push({
      url: req.url(),
      resourceType: req.resourceType(),
      error: req.failure()?.errorText || "",
    });
  });
  page.on("websocket", (ws) => {
    const entry = { url: ws.url(), frames: [] };
    observed.sockets.push(entry);
    ws.on("framereceived", ({ payload }) => {
      entry.frames.push(
        typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"),
      );
    });
  });
  return observed;
};

// Two probes installed BEFORE any script of the page runs — context-wide so
// every page (including an auto-reloaded one) gets them:
//   - latch the app's "rendered" event (a promise installed after navigation
//     would race it);
//   - record the URL the document LANDED on. The Control UI consumes
//     `#token=` and rewrites the URL through its router (first run even
//     routes to /settings/model-setup), so `page.url()` after render can
//     never prove the fragment survived the gateway's /openclaw → /openclaw/
//     redirect; the landing href, captured before the app touched it, can.
const installPageProbes = (context) =>
  context.addInitScript(() => {
    window.__acLandingHref = window.location.href;
    window.addEventListener("openclaw-control-ui-rendered", () => {
      window.__acRendered = true;
    });
  });

const readLandingHref = (page) => page.evaluate(() => window.__acLandingHref || null);

// DOM facts the banner assertions need, read in ONE round-trip so a late
// re-render cannot skew them against each other.
const readStyleState = (page) =>
  page.evaluate(
    async ({ bannerText, reloadButtonText }) => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
      const bannerAlerts = alerts
        .filter((el) => String(el.textContent || "").includes(bannerText))
        .map((el) => String(el.textContent || "").trim());
      const reloadAlerts = alerts
        .filter((el) =>
          Array.from(el.querySelectorAll("button")).some(
            (button) => String(button.textContent || "").trim() === reloadButtonText,
          ),
        )
        .map((el) => String(el.textContent || "").trim());
      const cssOk = getComputedStyle(document.documentElement)
        .getPropertyValue("--openclaw-css-ok")
        .trim();
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
        (link) => ({ id: link.id, href: link.href, loaded: link.sheet !== null }),
      );
      const typefaces = links.filter((link) => link.id.startsWith("openclaw-typeface-"));
      const loadFaces = async (spec) =>
        (await document.fonts.load(spec)).map((face) => ({
          family: face.family,
          status: face.status,
        }));
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        bannerAlerts,
        reloadAlerts,
        cssOk,
        links,
        typefaces,
        instrumentSans: await loadFaces('16px "Instrument Sans"'),
        jetbrainsMono: await loadFaces('16px "JetBrains Mono"'),
        basePathAttr: document.documentElement.getAttribute(
          "data-openclaw-control-ui-base-path",
        ),
        serviceWorkerScope: registration ? registration.scope : null,
      };
    },
    { bannerText: kBannerText, reloadButtonText: kReloadButtonText },
  );

// Every cached response under a Control UI RESOURCE key, with its
// content-type — the poisoning class is "text/html under an asset URL".
const readResourceCacheEntries = (page) =>
  page.evaluate(async () => {
    const entries = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) {
        const pathname = new URL(request.url).pathname;
        if (
          !pathname.includes("/openclaw/assets/") &&
          !pathname.includes("/openclaw/fonts/")
        ) {
          continue;
        }
        const response = await cache.match(request);
        entries.push({
          cache: key,
          url: request.url,
          status: response ? response.status : null,
          contentType: response ? String(response.headers.get("content-type") || "") : "",
        });
      }
    }
    return entries;
  });

describeLive("live: Control UI styles render through the /openclaw proxy (real browser)", () => {
  const cliUsable = openclawCliUsable();
  const itLive = cliUsable ? it : it.skip;
  if (kLiveEnabled && !cliUsable) {
    // eslint-disable-next-line no-console
    console.warn(
      "[live] pinned openclaw CLI cannot run on this Node " +
        `(${process.version}) — control-ui-styles live suite skipped. ` +
        "Run vitest with a Node satisfying openclaw's engines.",
    );
  }

  let rootDir;
  let openclawConfigPath;
  let port;
  let gatewayPort;
  let baseUrl;
  let serverChild;
  let gatewayToken;
  let serverLog = "";

  // Browser state shared by the sequential steps below.
  let browser = null;
  let browserSkipReason = null;
  let context = null;
  let page = null;
  let observed = null;
  let cookieValue = null;
  let launchLocation = null;
  let token = null;

  const readOpenclawJson = () => JSON.parse(fs.readFileSync(openclawConfigPath, "utf8"));

  const logTail = (chars = 1500) => serverLog.slice(-chars);

  const spawnServer = (extraEnv = {}) => {
    const serverEnv = {
      ...scrubTestRunnerEnv(),
      ALPHACLAW_ROOT_DIR: rootDir,
      SETUP_PASSWORD: kSetupPassword,
      PORT: String(port),
      ALPHACLAW_SETUP_URL: baseUrl,
      PATH: `${repoBinDir()}${path.delimiter}${process.env.PATH || ""}`,
      ...extraEnv,
    };
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "../../bin/alphaclaw.js"), "start"],
      { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => {
      serverLog += String(d);
    });
    child.stderr.on("data", (d) => {
      serverLog += String(d);
    });
    return child;
  };

  const waitHealthy = (label) =>
    waitFor(
      async () => {
        try {
          const res = await fetch(`${baseUrl}/health`);
          if (res.status !== 200) return false;
          const body = await res.json();
          return body?.gateway === "running" || body?.gateway === "up";
        } catch {
          return false;
        }
      },
      kBootTimeoutMs,
      `${label}: alphaclaw + real gateway healthy on :${port} (log tail: ${logTail(400)})`,
    );

  // SIGTERM → gracefulExit drains and reaps the managed gateway child
  // (lib/server/init/server-lifecycle.js), so a respawn on the SAME ports
  // relaunches the gateway fresh against the current openclaw.json.
  const stopServer = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        resolve();
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      child.kill("SIGTERM");
    });
  };

  const login = async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: kSetupPassword }),
    });
    expect(res.status).toBe(200);
    const cookie = String(res.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).toMatch(/^setup_token=/);
    return cookie;
  };

  const cookieValueOf = (cookie) => cookie.slice(cookie.indexOf("=") + 1);

  const browserCookie = (value) => ({
    name: "setup_token",
    value,
    url: baseUrl,
    httpOnly: true,
    sameSite: "Lax",
  });

  // Same it.skip semantics as the CLI preflight, but the browser can only be
  // probed asynchronously (in beforeAll), so each browser step skips itself.
  const requireBrowser = (ctx) => {
    if (browser) return true;
    ctx.skip(`browser unavailable: ${browserSkipReason || "not launched"}`);
    return false;
  };

  beforeAll(async () => {
    if (!cliUsable) return;
    rootDir = mkTemp("alphaclaw-live-control-ui-root-");
    const openclawDir = path.join(rootDir, ".openclaw");
    const workspaceDir = path.join(rootDir, "workspace");
    openclawConfigPath = path.join(openclawDir, "openclaw.json");
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    port = await findFreePort();
    // A UNIQUE gateway port per run: on the default 18789 a concurrently
    // running gateway (another checkout, an operator instance) wins the
    // healthy-incumbent step-aside race and this suite would render the
    // WRONG gateway's UI.
    gatewayPort = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    // Real onboarding, exactly the args AlphaClaw's onboarding service passes
    // (lib/server/onboarding/openclaw.js buildOnboardArgs), no provider auth.
    // It writes openclaw.json WITHOUT gateway.controlUi.basePath — the
    // existing-install migration case this suite exists to prove.
    gatewayToken = `live-styles-${Date.now().toString(36)}-token`;
    const onboardEnv = {
      ...scrubTestRunnerEnv(),
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_CONFIG_PATH: openclawConfigPath,
      OPENCLAW_STATE_DIR: openclawDir,
      XDG_CONFIG_HOME: openclawDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
    };
    const onboard = spawnSync(
      process.execPath,
      [
        repoOpenclawBin(),
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--flow",
        "quickstart",
        "--gateway-bind",
        "loopback",
        "--gateway-port",
        String(gatewayPort),
        "--gateway-auth",
        "token",
        "--gateway-token",
        gatewayToken,
        "--no-install-daemon",
        "--skip-health",
        "--workspace",
        workspaceDir,
        "--auth-choice",
        "skip",
      ],
      { encoding: "utf8", env: onboardEnv, timeout: 120_000 },
    );
    if (onboard.status !== 0) {
      throw new Error(
        `openclaw onboard failed (${onboard.status}): ${String(
          onboard.stderr || onboard.stdout || "",
        ).slice(-500)}`,
      );
    }
    // Acquisition precondition: onboarding itself must NOT have written the
    // key, otherwise step 1 would prove nothing about AlphaClaw's boot.
    const onboarded = readOpenclawJson();
    if (onboarded?.gateway?.controlUi?.basePath !== undefined) {
      throw new Error(
        `precondition: openclaw onboard already wrote gateway.controlUi.basePath=${JSON.stringify(
          onboarded.gateway.controlUi.basePath,
        )} — the migration case cannot be exercised on this OpenClaw line`,
      );
    }
    fs.writeFileSync(
      path.join(rootDir, "onboarded.json"),
      JSON.stringify(
        { onboarded: true, reason: "live_e2e", markedAt: new Date().toISOString() },
        null,
        2,
      ),
    );

    // Boot the REAL server: it supervises the real gateway as a child.
    serverChild = spawnServer();
    await waitHealthy("initial boot");

    // Browser AFTER the server is up so a slow boot never eats the browser
    // launch budget. A missing browser is a red job in CI, a loud skip locally.
    const { chromium } = require("playwright");
    const executablePath = resolveChromeExecutable();
    try {
      browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
    } catch (error) {
      const detail = String(error?.message || error).split("\n")[0];
      if (process.env.CI) {
        throw new Error(
          `[live] no Chromium could be launched in CI (executablePath=${
            executablePath || "<playwright bundled>"
          }): ${detail} — install one (npx playwright install --with-deps chromium) or set CHROME_BIN; ` +
            "a skipped browser test in CI is a silent hole in the only real proof of the styles fix",
        );
      }
      browserSkipReason = detail;
      // eslint-disable-next-line no-console
      console.warn(
        `[live] no Chromium could be launched (executablePath=${
          executablePath || "<playwright bundled>"
        }): ${detail} — the browser steps of control-ui-styles are SKIPPED. ` +
          "Set CHROME_BIN or run `npx playwright install chromium`.",
      );
    }
  }, kBootTimeoutMs + 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } catch {}
    await stopServer(serverChild);
  }, 90_000);

  // ── Step 1: acquisition + activation, no browser ─────────────────────────
  itLive(
    "1. an onboarded install ACQUIRES gateway.controlUi.basePath at boot and the gateway ACTIVATES it",
    async () => {
      // Acquisition: `openclaw onboard` wrote no basePath (asserted in
      // beforeAll); AlphaClaw's boot must have added the canonical string.
      const cfg = readOpenclawJson();
      expect(cfg?.gateway?.controlUi?.basePath, `openclaw.json gateway.controlUi: ${JSON.stringify(
        cfg?.gateway?.controlUi,
      )}\nlog tail: ${logTail()}`).toBe(kMountPath);
      expect(serverLog).toContain("control_ui_mount=basepath");

      // Activation: the GATEWAY (not AlphaClaw — nothing in lib/ rewrites
      // HTML) stamps the base path into the document it serves at the mount.
      const cookie = await login();
      const res = await httpGet(`${baseUrl}${kMountPath}/`, { cookie });
      expect(res.status, `GET ${kMountPath}/ → ${res.status}\n${res.body.slice(0, 300)}`).toBe(200);
      expect(res.headers.get("content-type") || "").toMatch(/text\/html/);
      expect(res.body).toContain(`${kBasePathAttr}="${kMountPath}"`);
    },
    kTestTimeoutMs,
  );

  // ── Step 2: open the launcher URL in Chromium ────────────────────────────
  itLive(
    "2. the launcher's /openclaw/#token=… renders in Chromium and the no-slash form keeps its fragment",
    async (ctx) => {
      if (!requireBrowser(ctx)) return;
      const cookie = await login();
      cookieValue = cookieValueOf(cookie);
      const launch = await httpGet(`${baseUrl}/gateway/launch`, { cookie });
      expect(launch.status).toBe(302);
      launchLocation = String(launch.headers.get("location") || "");
      expect(launchLocation).toMatch(new RegExp(`^${kMountPath}/#token=`));
      token = decodeURIComponent(launchLocation.split("#token=")[1] || "");
      expect(token).toBe(gatewayToken);

      // vitest.config.js retries a failed test once: a re-run must not leak
      // the previous attempt's context (its worker would stay registered).
      if (context) await context.close().catch(() => {});
      context = await browser.newContext();
      await installPageProbes(context);
      await context.addCookies([browserCookie(cookieValue)]);

      // Service workers ENABLED (real behavior). The very first load is fully
      // visible to page.on("response") because no worker controls it yet.
      page = await context.newPage();
      observed = observePage(page);
      await page.goto(`${baseUrl}${launchLocation}`, { waitUntil: "load" });
      expect(await readLandingHref(page)).toBe(`${baseUrl}${launchLocation}`);
      await page.waitForFunction(() => window.__acRendered === true, null, {
        timeout: kRenderTimeoutMs,
      });
      // The app has consumed the fragment and may have routed (first run →
      // model setup); it must still be INSIDE the mount.
      expect(pathnameOf(page.url()).startsWith(`${kMountPath}/`), page.url()).toBe(true);

      // The no-slash form: the gateway 302s /openclaw → /openclaw/ with a
      // relative Location and no fragment; the browser re-attaches #token=.
      // On a second page so the main page's observers stay a clean record
      // of ONE uncontrolled first load.
      const noSlashPage = await context.newPage();
      await noSlashPage.goto(`${baseUrl}${kMountPath}#token=${encodeURIComponent(token)}`, {
        waitUntil: "load",
      });
      const noSlashLanding = String(await readLandingHref(noSlashPage));
      expect(
        noSlashLanding.endsWith(`${kMountPath}/#token=${encodeURIComponent(token)}`),
        `landed on ${noSlashLanding}`,
      ).toBe(true);
      await noSlashPage.waitForFunction(() => window.__acRendered === true, null, {
        timeout: kRenderTimeoutMs,
      });
      await noSlashPage.close();
    },
    kTestTimeoutMs,
  );

  // ── Step 3: the screenshot's banner is gone and the styles REALLY loaded ──
  itLive(
    "3. no 'Styles failed to load' banner: sentinel set, every stylesheet and both typefaces loaded, fonts and WS over /openclaw, worker registered",
    async (ctx) => {
      if (!requireBrowser(ctx)) return;
      // The typeface links are appended by the theme bootstrap after first
      // paint and the worker registers after render — give them a moment to
      // settle; the assertions below still fail with a precise message if
      // they never do.
      await page
        .waitForFunction(
          () =>
            document.querySelector('link[id^="openclaw-typeface-"]') !== null &&
            Array.from(document.querySelectorAll('link[rel="stylesheet"]')).every(
              (link) => link.sheet !== null,
            ),
          null,
          { timeout: 30_000 },
        )
        .catch(() => {});
      await page
        .waitForFunction(
          async () => Boolean(await navigator.serviceWorker.getRegistration()),
          null,
          { timeout: 30_000 },
        )
        .catch(() => {});

      const state = await readStyleState(page);
      const evidence = `\nstyle state: ${JSON.stringify(state, null, 2)}\nlog tail: ${logTail()}`;
      // The bug itself, exactly as the screenshot shows it.
      expect(state.bannerAlerts, `banner present${evidence}`).toEqual([]);
      // Locale-independent twin: the recovery banner is the only alert with a
      // Reload button.
      expect(state.reloadAlerts, `alert with Reload button present${evidence}`).toEqual([]);
      expect(state.basePathAttr, `stamped base path${evidence}`).toBe(kMountPath);
      // Detector input #1: the entry stylesheet's sentinel.
      expect(state.cssOk, `--openclaw-css-ok${evidence}`).toBe("1");
      // Detector input #2: no stylesheet link errored (sheet stays null).
      expect(state.links.length, `no stylesheet links${evidence}`).toBeGreaterThan(0);
      expect(
        state.links.filter((link) => !link.loaded),
        `stylesheet links without a sheet${evidence}`,
      ).toEqual([]);
      // The fonts the old mount 404'd: the typeface stylesheet exists AND the
      // woff2 files rendered (document.fonts.load resolves loaded faces).
      expect(state.typefaces.length, `no openclaw-typeface-* link${evidence}`).toBeGreaterThan(0);
      expect(state.instrumentSans.length, `Instrument Sans faces${evidence}`).toBeGreaterThan(0);
      expect(
        state.instrumentSans.every((face) => face.status === "loaded"),
        `Instrument Sans status${evidence}`,
      ).toBe(true);
      expect(state.jetbrainsMono.length, `JetBrains Mono faces${evidence}`).toBeGreaterThan(0);
      expect(
        state.jetbrainsMono.every((face) => face.status === "loaded"),
        `JetBrains Mono status${evidence}`,
      ).toBe(true);

      // Network record of the uncontrolled first load: nothing style-shaped
      // failed, and the fonts came from under the mount.
      const badStyleResponses = observed.responses.filter(
        (res) => res.status >= 400 && isStyleResource(res),
      );
      expect(badStyleResponses, `style responses >= 400${evidence}`).toEqual([]);
      expect(
        observed.failed.filter(isStyleResource),
        `style requests failed${evidence}`,
      ).toEqual([]);
      expect(
        observed.responses.some((res) => pathnameOf(res.url).includes(`${kMountPath}/fonts/`)),
        `no response under ${kMountPath}/fonts/ — URLs: ${JSON.stringify(
          observed.responses.map((res) => pathnameOf(res.url)),
        )}`,
      ).toBe(true);

      // The gateway connection works over the NEW path: the UI derives its WS
      // URL from the route base path (ws://host/openclaw), AlphaClaw's upgrade
      // handler authenticates the cookie and forwards it intact.
      const gatewaySocket = observed.sockets.find((socket) =>
        pathnameOf(socket.url).startsWith(kMountPath),
      );
      expect(
        gatewaySocket,
        `no websocket to ${kMountPath} — sockets: ${JSON.stringify(observed.sockets.map((s) => s.url))}`,
      ).toBeTruthy();
      // …and it goes THROUGH AlphaClaw (its port), not straight to the gateway.
      expect(new URL(gatewaySocket.url).port, gatewaySocket.url).toBe(String(port));
      await waitFor(
        () => gatewaySocket.frames.some((frame) => frame.includes(kHelloOkMarker)),
        30_000,
        `hello-ok frame on ${gatewaySocket.url} (frames: ${gatewaySocket.frames.length})`,
      );

      // The worker registered under the mount — never AlphaClaw's origin root.
      expect(state.serviceWorkerScope, `service worker scope${evidence}`).toMatch(
        new RegExp(`${kMountPath}/$`),
      );

      // One evidence line for the CI log: what the browser actually fetched.
      // eslint-disable-next-line no-console
      console.log(
        `[live] control-ui styles OK: css-ok=${state.cssOk} stylesheets=${state.links.length} ` +
          `typefaces=${state.typefaces.map((link) => link.id).join(",")} ` +
          `fonts=${observed.responses
            .filter((res) => pathnameOf(res.url).includes(`${kMountPath}/fonts/`))
            .map((res) => `${res.status} ${pathnameOf(res.url)}`)
            .join(" | ")} ws=${gatewaySocket.url} sw=${state.serviceWorkerScope}`,
      );
    },
    kTestTimeoutMs,
  );

  // ── Step 4: worker-controlled load + session-expiry demo ─────────────────
  itLive(
    "4. under a CONTROLLING worker an expired session never caches HTML under an asset URL, and a hard reload lands on login",
    async (ctx) => {
      if (!requireBrowser(ctx)) return;
      // Registration is not control: only a navigation AFTER activation is
      // served by the worker. Reload and wait for a controller.
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
        timeout: kWorkerControlTimeoutMs,
      });
      await page.waitForFunction(() => window.__acRendered === true, null, {
        timeout: kRenderTimeoutMs,
      });

      // Browser-side equivalent of the 7-day expiry: the session cookie is a
      // stateless HMAC, so time cannot be fast-forwarded — but a cookie the
      // browser no longer sends is indistinguishable to the server.
      const responsesBeforeExpiry = observed.responses.length;
      await context.clearCookies();

      // Force an UNCACHED chunk fetch through the worker: a client-side route
      // change to a lazy view. Prefer the UI's own sidebar link; fall back to
      // the history API the router listens to.
      const sidebarLink = page.locator(`a[href$="${kMountPath}/dashboards"]`).first();
      if ((await sidebarLink.count()) > 0 && (await sidebarLink.isVisible())) {
        await sidebarLink.click({ noWaitAfter: true }).catch(() => {});
      } else {
        await page
          .evaluate((route) => {
            window.history.pushState({}, "", route);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }, `${kMountPath}/dashboards`)
          .catch(() => {});
      }
      // Wait for the SIGNAL, not a fixed sleep: at least one post-expiry
      // resource fetch under /openclaw/{assets,fonts}/ answered 401 (Playwright
      // reports worker-fulfilled page requests too). Without this the step
      // would pass vacuously if no request ever left the page after expiry —
      // e.g. if a future pin folds the lazy views into the core chunk.
      const expiredResourceHits = () =>
        observed.responses
          .slice(responsesBeforeExpiry)
          .filter(
            (res) =>
              res.status === 401 &&
              /\/openclaw\/(assets|fonts)\//.test(pathnameOf(res.url)),
          );
      await waitFor(
        () => expiredResourceHits().length > 0,
        20_000,
        `a 401 for a post-expiry /openclaw/{assets,fonts}/ fetch (saw: ${JSON.stringify(
          observed.responses.slice(responsesBeforeExpiry).map((r) => `${r.status} ${pathnameOf(r.url)}`),
        )})`,
      );
      expect(expiredResourceHits().length).toBeGreaterThan(0);
      await page.waitForLoadState("load").catch(() => {});

      // The Cache API is origin-scoped, so this reads correctly whether the
      // tab is still on the UI or the UI's recovery already sent it to login.
      const entries = await readResourceCacheEntries(page);
      expect(
        entries.length,
        `no /openclaw/assets|fonts entries in any worker cache — the worker did not serve this page (log tail: ${logTail()})`,
      ).toBeGreaterThan(0);
      const poisoned = entries.filter((entry) =>
        entry.contentType.toLowerCase().startsWith("text/html"),
      );
      expect(poisoned, `text/html cached under a resource URL: ${JSON.stringify(poisoned, null, 2)}`).toEqual([]);

      // A document navigation (the worker skips mode=navigate) still gets the
      // login redirect — the expired-session journey is unchanged.
      await page.goto(`${baseUrl}${kMountPath}/`, { waitUntil: "load" });
      expect(pathnameOf(page.url()), page.url()).toMatch(/\/login\.html$/);
    },
    kTestTimeoutMs,
  );

  // ── Step 5: canary — the detector can still fire ─────────────────────────
  itLive(
    "5. canary: with fonts blocked (workers off) the banner DOES appear, so a green step 3 means fixed, not detector-never-ran",
    async (ctx) => {
      if (!requireBrowser(ctx)) return;
      // serviceWorkers: "block" — a worker would fetch the fonts itself and
      // bypass page.route, turning the canary green for the wrong reason.
      const canaryContext = await browser.newContext({ serviceWorkers: "block" });
      try {
        await installPageProbes(canaryContext);
        await canaryContext.addCookies([browserCookie(cookieValue)]);
        const canaryPage = await canaryContext.newPage();
        const canaryObserved = observePage(canaryPage);
        await canaryPage.route(`**${kMountPath}/fonts/**`, (route) => route.abort());
        await canaryPage.goto(`${baseUrl}${launchLocation}`, { waitUntil: "load" });
        // The UI first HEAD-probes and reloads itself once per build id, THEN
        // shows the banner on the reloaded page — hence the generous wait.
        const banner = canaryPage.getByRole("alert").filter({ hasText: kBannerText }).first();
        await banner.waitFor({ state: "visible", timeout: kCanaryBannerTimeoutMs }).catch((error) => {
          throw new Error(
            `canary banner never appeared: ${error.message}\nfailed requests: ${JSON.stringify(
              canaryObserved.failed.map((f) => `${f.resourceType} ${pathnameOf(f.url)} ${f.error}`),
            )}\nlog tail: ${logTail()}`,
          );
        });
        expect(await banner.isVisible()).toBe(true);
        expect(
          canaryObserved.failed.some(
            (f) => pathnameOf(f.url).includes(`${kMountPath}/fonts/`),
          ),
          "the canary did not actually block a font request",
        ).toBe(true);
      } finally {
        await canaryContext.close().catch(() => {});
      }
    },
    kTestTimeoutMs,
  );

  // ── Step 6: rollback drill on the SAME install and browser context ───────
  itLive(
    "6. rollback drill: ALPHACLAW_CONTROL_UI_MOUNT=legacy removes the key and root-mounts the gateway; the default restores it",
    async (ctx) => {
      if (!requireBrowser(ctx)) return;
      // Legacy respawn: boot must REMOVE our key so the strip-mode proxy and
      // the (relaunched) gateway agree again.
      await stopServer(serverChild);
      serverLog += "\n[test] ---- respawn with ALPHACLAW_CONTROL_UI_MOUNT=legacy ----\n";
      serverChild = spawnServer({ ALPHACLAW_CONTROL_UI_MOUNT: "legacy" });
      await waitHealthy("legacy respawn");
      const legacyCfg = readOpenclawJson();
      expect(
        legacyCfg?.gateway?.controlUi?.basePath,
        `legacy boot left gateway.controlUi=${JSON.stringify(legacyCfg?.gateway?.controlUi)}\nlog tail: ${logTail()}`,
      ).toBeUndefined();
      expect(serverLog).toContain("control_ui_mount=legacy");

      // The gateway restarted in ROOT mode: the document at the mount (proxy
      // strips the prefix again) carries an EMPTY base path.
      const legacyCookie = await login();
      const legacyDoc = await httpGet(`${baseUrl}${kMountPath}/`, {
        cookie: legacyCookie,
        redirect: "follow",
      });
      expect(legacyDoc.status, legacyDoc.body.slice(0, 300)).toBe(200);
      expect(legacyDoc.body).toContain(`${kBasePathAttr}=""`);

      // ORIGINAL context: the worker from the basepath phase is still
      // registered at scope /openclaw/. The page must still render (the
      // legacy banner is the KNOWN pre-fix state and is allowed here).
      await context.addCookies([browserCookie(cookieValueOf(legacyCookie))]);
      await page.goto(`${baseUrl}${kMountPath}/`, { waitUntil: "load" });
      // Known pre-fix state: the root-mounted UI 404s its font CSS, so the
      // recovery reloads the tab ONCE (sub-second after load) and then shows
      // the banner. Let that settle — bounded, never required — so the
      // evaluates below cannot land in a context the reload just destroyed.
      await page
        .getByRole("alert")
        .filter({ hasText: kBannerText })
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => {});
      await page.waitForFunction(() => document.querySelector("openclaw-app") !== null, null, {
        timeout: kRenderTimeoutMs,
      });
      expect(
        await page.evaluate(() =>
          document.documentElement.getAttribute("data-openclaw-control-ui-base-path"),
        ),
      ).toBe("");
      // Per the service-worker spec a 404 on the script URL during update()
      // unregisters; but in legacy mode /openclaw/sw.js is STRIPPED to the
      // gateway's root /sw.js (which a root-mounted gateway serves), and
      // browsers may defer the check anyway — so a lingering registration is
      // reported, not failed. What matters is that navigation still works.
      const stillRegistered = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        try {
          await registration?.update();
        } catch {}
        return Boolean(await navigator.serviceWorker.getRegistration());
      });
      if (stillRegistered) {
        // eslint-disable-next-line no-console
        console.warn(
          `[live] legacy mount: the ${kMountPath}/ service worker registration is still present after update() — ` +
            "expected when the stripped /sw.js is still served; navigation rendered fine",
        );
      }

      // Round-trip: default env → the key returns, the stamp returns, and the
      // page renders WITHOUT the banner again in the same context.
      await stopServer(serverChild);
      serverLog += "\n[test] ---- respawn with the default mount ----\n";
      serverChild = spawnServer();
      await waitHealthy("default respawn");
      const restoredCfg = readOpenclawJson();
      expect(
        restoredCfg?.gateway?.controlUi?.basePath,
        `default boot left gateway.controlUi=${JSON.stringify(restoredCfg?.gateway?.controlUi)}\nlog tail: ${logTail()}`,
      ).toBe(kMountPath);
      const restoredCookie = await login();
      const restoredDoc = await httpGet(`${baseUrl}${kMountPath}/`, { cookie: restoredCookie });
      expect(restoredDoc.status).toBe(200);
      expect(restoredDoc.body).toContain(`${kBasePathAttr}="${kMountPath}"`);

      await context.addCookies([browserCookie(cookieValueOf(restoredCookie))]);
      await page.goto(`${baseUrl}${launchLocation}`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__acRendered === true, null, {
        timeout: kRenderTimeoutMs,
      });
      const restoredState = await readStyleState(page);
      expect(restoredState.basePathAttr).toBe(kMountPath);
      expect(
        restoredState.bannerAlerts,
        `banner after the round-trip: ${JSON.stringify(restoredState, null, 2)}`,
      ).toEqual([]);
      expect(restoredState.cssOk).toBe("1");
    },
    kTestTimeoutMs,
  );
});
