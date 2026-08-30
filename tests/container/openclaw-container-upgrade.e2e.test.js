// vitest globals (describe/test/expect/hooks) are on via vitest.config.js.
const fs = require("node:fs");
const path = require("node:path");
const {
  describeContainer,
  strict,
  repoRoot,
  docker,
  ensureArtifactsDir,
  assertDockerAvailable,
  buildImage,
  createVolume,
  seedVolume,
  runContainer,
  getMappedPort,
  execInContainer,
  execDetachedInContainer,
  containerLogs,
  restartCount,
  containerStartedAt,
  removeContainer,
  removeVolume,
  sleep,
  waitFor,
  compareLooseVersions,
  loginForCookie,
  fetchJsonWithCookie,
} = require("./container-helpers.js");

// -----------------------------------------------------------------------------
// Container E2E: the production container journey, end to end.
//
//   real image from this checkout (npm pack → docker build)
//   → real stable OpenClaw gateway boots against a seeded /data volume
//   → the REAL browser UI (headless Chromium) drives a stable→beta upgrade
//     while a churner writes/deletes gateway-adjacent files
//   → the container restarts (restartProcess() exits under /.dockerenv and
//     --restart=always brings it back) and comes back ON THE BETA
//   → the UI verdict, the live binary (`openclaw --version`), and the
//     gateway /healthz all agree
//   → the volume survives a container replacement AND a docker restart.
//
// Opt-in via OPENCLAW_CONTAINER_E2E=1 (npm run test:container). Requires a
// running docker daemon with outbound network. ~20-35 min end to end.
// -----------------------------------------------------------------------------

const kRunId = Date.now().toString(36);
const kImageTag = `alphaclaw-container-e2e:${kRunId}`;
const kVolume = `alphaclaw-e2e-data-${kRunId}`;
const kContainerA = `alphaclaw-e2e-${kRunId}`;
const kContainerB = `alphaclaw-e2e-${kRunId}-fresh`;
const kSetupPassword = "container-e2e-pass";
const kGatewayToken = "container-e2e-token";
const kGatewayPort = 18789;
const kStateDbPath = "/data/.openclaw/state/openclaw.sqlite";
const kChurnScriptPath = "/data/e2e-churn.sh";
const kChurnControlPath = "/data/e2e-churn-on";

const kMin = 60 * 1000;

// The seeded stable-accepted config (plan constraint C12). Verified against
// openclaw@2026.7.1-2 during the baseline smoke: the stable gateway boots
// healthy with ALL of these keys present. `meta.lastTouchedAt` is the
// retired-looking #20 seed; `mcp.servers.nessie` carries a ${NESSIE_TOKEN}
// env reference that MUST survive the upgrade byte-for-byte (issue #20's
// incident was a migration mangling exactly this shape).
const buildSeedConfig = () => ({
  gateway: {
    mode: "local",
    bind: "loopback",
    port: kGatewayPort,
    auth: { token: kGatewayToken },
  },
  meta: { lastTouchedAt: "2026-07-01T00:00:00Z" },
  mcp: {
    servers: {
      nessie: {
        url: "https://example.com/mcp",
        headers: { Authorization: "${NESSIE_TOKEN}" },
      },
    },
  },
});

const containerEnv = () => {
  const env = {
    SETUP_PASSWORD: kSetupPassword,
    OPENCLAW_GATEWAY_TOKEN: kGatewayToken,
  };
  // Authenticated GitHub API calls (release notes) — the anonymous quota is
  // shared per runner IP and flakes in CI.
  if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  return env;
};

// ---------------------------------------------------------------------------
// Shared journey state. Vitest runs tests in a file sequentially; the steps
// below are one ordered journey, so each carries the state forward.
// ---------------------------------------------------------------------------
const ctx = {
  stablePin: null,
  beta: null,
  port: null,
  cookie: null,
  bootStartedAt: null,
  placeholderObserved: null,
  metaKeyAfterUpgrade: undefined,
  activeContainer: kContainerA,
};

// Registry sanity outcome. Vitest cannot skip mid-suite, so the non-strict
// "beta missing / not newer" outcome sets this flag and every step logs +
// returns early — honest about the skip without failing the run.
let skipReason = null;
// When an earlier step fails, later steps of the ordered journey cannot mean
// anything; they fail fast naming the broken step instead of green-lying.
let journeyBroken = null;

const step = (name, timeoutMs, fn) => {
  // retry: 0 overrides the global retry: 1 — re-running a mid-journey step
  // (re-clicking Apply, re-seeding) is never safe, and a broken journey must
  // fail deterministically.
  test(name, { timeout: timeoutMs, retry: 0 }, async () => {
    if (skipReason) {
      console.warn(`[container-e2e] SKIP "${name}" — ${skipReason}`);
      return;
    }
    if (journeyBroken) {
      throw new Error(`journey already broken at step "${journeyBroken}" — cannot run "${name}"`);
    }
    try {
      await fn();
    } catch (err) {
      journeyBroken = name;
      throw err;
    }
  });
};

const baseUrl = () => `http://127.0.0.1:${ctx.port}`;

// Cookie-carrying status poll that survives session resets across restarts:
// re-login once on any auth failure, then retry the read.
const readStatus = async () => {
  const attempt = async () =>
    fetchJsonWithCookie(`${baseUrl()}/api/status`, ctx.cookie);
  try {
    if (!ctx.cookie) throw new Error("no session yet");
    return await attempt();
  } catch {
    ctx.cookie = await loginForCookie(baseUrl(), kSetupPassword);
    return attempt();
  }
};

const gatewayHealthzOk = async (container) => {
  try {
    await execInContainer(container, [
      "curl",
      "-fsS",
      `http://127.0.0.1:${kGatewayPort}/healthz`,
    ]);
    return true;
  } catch {
    return false;
  }
};

const waitForUiUp = async (container, timeoutMs) => {
  await waitFor(
    async () => {
      ctx.port = await getMappedPort(container);
      const res = await fetch(`${baseUrl()}/login.html`, {
        headers: { Accept: "text/html" },
      });
      return res.status === 200;
    },
    { timeoutMs, intervalMs: 2000, label: `login page 200 on ${container}` },
  );
};

// /api/status reports "2026.7.1-2 (0790d9f)" — version + build sha — so the
// match is "equals, or the version followed by a space" (never a bare
// startsWith: "2026.7.1-2" must not match "2026.7.1-20").
const versionMatches = (reported, expected) =>
  typeof reported === "string" &&
  (reported === expected || reported.startsWith(`${expected} `));

const waitForVersion = async (container, version, timeoutMs) => {
  await waitFor(
    async () => {
      ctx.port = await getMappedPort(container);
      const status = await readStatus();
      return versionMatches(status.openclawVersion, version);
    },
    {
      timeoutMs,
      intervalMs: 3000,
      label: `/api/status openclawVersion matches ${version} on ${container}`,
    },
  );
};

const screenshotOnFailure = async (page, name) => {
  try {
    const dir = ensureArtifactsDir();
    await page.screenshot({ path: path.join(dir, `${name}-${kRunId}.png`), fullPage: true });
  } catch {}
};

const pageBodyText = async (page) => {
  try {
    return await page.evaluate(() => document.body.innerText);
  } catch {
    return "";
  }
};

const loginThroughBrowser = async (page) => {
  await page.goto(`${baseUrl()}/login.html`, { waitUntil: "domcontentloaded" });
  await page.fill("#password", kSetupPassword);
  await page.click("#submit-btn");
  // login.html sets window.location.href = "/" on success.
  await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 60_000 });
};

describeContainer("container E2E: stable→beta upgrade in the production image", () => {
  beforeAll(async () => {
    await assertDockerAvailable();

    // (a) Resolve stable pin (repo package.json) + beta (registry dist-tags).
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    ctx.stablePin = pkg.dependencies.openclaw;
    expect(ctx.stablePin).toBeTruthy();

    const res = await fetch("https://registry.npmjs.org/openclaw", {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) throw new Error(`npm registry returned ${res.status} for openclaw`);
    const doc = await res.json();
    ctx.beta = doc["dist-tags"]?.beta || null;

    const betaIsNewer =
      Boolean(ctx.beta) && compareLooseVersions(ctx.beta, ctx.stablePin) > 0;
    if (!betaIsNewer) {
      const message =
        `registry sanity failed: beta dist-tag ${JSON.stringify(ctx.beta)} is not newer ` +
        `than the stable pin ${ctx.stablePin} — the stable→beta journey cannot run`;
      if (strict) throw new Error(`[STRICT] ${message}`);
      skipReason = message;
      console.warn(`[container-e2e] ${message} — skipping the journey (non-strict)`);
    } else {
      console.log(`[container-e2e] stable pin ${ctx.stablePin} → beta ${ctx.beta}`);
    }
  }, 2 * kMin);

  afterAll(async () => {
    // Stop the churner loop (best-effort; it also dies with its container).
    try {
      await execInContainer(ctx.activeContainer, ["rm", "-f", kChurnControlPath]);
    } catch {}
    // Preserve evidence before teardown when the journey broke.
    if (journeyBroken) {
      const dir = ensureArtifactsDir();
      for (const name of [kContainerA, kContainerB]) {
        try {
          const logs = await containerLogs(name, { tail: 600 });
          fs.writeFileSync(path.join(dir, `${name}-logs.txt`), logs);
        } catch {}
      }
    }
    // ALWAYS tear down — never leave containers or volumes behind.
    await removeContainer(kContainerA);
    await removeContainer(kContainerB);
    await removeVolume(kVolume);
  }, 5 * kMin);

  step("builds the production image from the local checkout", 15 * kMin, async () => {
    await buildImage({ tag: kImageTag });
  });

  step("boots stable against the seeded volume: UI login + pin + gateway healthz", 12 * kMin, async () => {
    // (b) Seed the volume: onboarded marker + a stable-accepted config
    // carrying the #20-shaped keys.
    await createVolume(kVolume);
    await seedVolume(kVolume, {
      "/data/onboarded.json": JSON.stringify({ onboardedAt: new Date().toISOString() }),
      "/data/.openclaw/openclaw.json": JSON.stringify(buildSeedConfig(), null, 2),
    });

    // (c) Run with the production env shape and wait out first boot.
    await runContainer({
      name: kContainerA,
      image: kImageTag,
      volume: kVolume,
      env: containerEnv(),
    });
    await waitForUiUp(kContainerA, 3 * kMin);

    ctx.cookie = await loginForCookie(baseUrl(), kSetupPassword);
    await waitForVersion(kContainerA, ctx.stablePin, 5 * kMin);

    // The STABLE gateway must become healthy with every seed key present —
    // if this times out, check `docker logs` for exit-78 config rejections.
    await waitFor(() => gatewayHealthzOk(kContainerA), {
      timeoutMs: 5 * kMin,
      intervalMs: 3000,
      label: `stable gateway /healthz inside ${kContainerA} (seeded config accepted?)`,
    });

    ctx.bootStartedAt = await containerStartedAt(kContainerA);
  });

  step("arms the hard gate: a real sqlite state DB exists", 3 * kMin, async () => {
    // (d) The cross-channel apply's DB preflight/backup gates only engage
    // when a state DB exists — make sure one does.
    const exists = await execInContainer(kContainerA, ["test", "-f", kStateDbPath])
      .then(() => true)
      .catch(() => false);
    if (exists) {
      console.log(`[container-e2e] state DB already present at ${kStateDbPath}`);
      return;
    }
    await execInContainer(kContainerA, ["mkdir", "-p", path.posix.dirname(kStateDbPath)]);
    const createScript = `const{DatabaseSync}=require('node:sqlite');new DatabaseSync(${JSON.stringify(
      kStateDbPath,
    )}).exec('CREATE TABLE IF NOT EXISTS t(x)');`;
    // node:sqlite needs --experimental-sqlite on some 22.x lines and is
    // unflagged on later ones — try both before giving up.
    try {
      await execInContainer(kContainerA, ["node", "-e", createScript]);
    } catch {
      await execInContainer(kContainerA, ["node", "--experimental-sqlite", "-e", createScript]);
    }
    await execInContainer(kContainerA, ["test", "-f", kStateDbPath]);
  });

  step("starts the gateway-liveness-aware churner", 2 * kMin, async () => {
    // (e) Live file churn during the upgrade: lock-file create/delete plus a
    // plugin catalog rewrite every ~30ms, but ONLY while the gateway is
    // healthy — when it goes down for quiesce/restart the loop idles instead
    // of fighting the backup. NOTE: `docker exec -d` processes die with the
    // container, so churn covers preflight→backup→install and stops at the
    // restart boundary by construction.
    const churnScript = [
      "#!/bin/sh",
      "mkdir -p /data/.openclaw/agents/main/sessions /data/.openclaw/agents/main/agent/plugins/groq",
      "i=0",
      `while [ -f ${kChurnControlPath} ]; do`,
      `  if curl -fsS -m 1 http://127.0.0.1:${kGatewayPort}/healthz >/dev/null 2>&1; then`,
      "    i=$((i+1))",
      '    f="/data/.openclaw/agents/main/sessions/$i.jsonl.lock"',
      '    : > "$f"',
      '    rm -f "$f"',
      "    printf '{\"models\":[\"e2e-churn\"],\"i\":%s}' \"$i\" > /data/.openclaw/agents/main/agent/plugins/groq/catalog.json",
      "    sleep 0.03",
      "  else",
      "    sleep 0.3",
      "  fi",
      "done",
    ].join("\n");
    await seedVolume(kVolume, {
      [kChurnScriptPath]: churnScript,
      [kChurnControlPath]: "1",
    });
    await execDetachedInContainer(kContainerA, ["sh", kChurnScriptPath]);
    // Prove it is actually running before moving on.
    await waitFor(
      () =>
        execInContainer(kContainerA, [
          "test",
          "-f",
          "/data/.openclaw/agents/main/agent/plugins/groq/catalog.json",
        ])
          .then(() => true)
          .catch(() => false),
      { timeoutMs: 30_000, intervalMs: 1000, label: "churner writing catalog.json" },
    );
  });

  step("drives the stable→beta apply through the real browser UI", 20 * kMin, async () => {
    // (f) Headless Chromium against the real served UI.
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    const page = await browser.newContext().then((c) => c.newPage());
    try {
      await loginThroughBrowser(page);
      await page.goto(`${baseUrl()}/#/upgrade`, { waitUntil: "domcontentloaded" });

      // Catalog card renders version rows (catalog fetch hits the registry).
      await page.getByText("Version catalog").first().waitFor({ timeout: 3 * kMin });

      // Prefer the exact resolved beta row (scoped to the Beta catalog
      // section so version strings elsewhere on the page can't match); fall
      // back to the first actionable Beta-section row if the catalog trimmed
      // the exact version.
      const betaSection = page
        .locator("h3", { hasText: /^Beta$/ })
        .locator("xpath=parent::div");
      let applyButton = null;
      const betaVersionText = betaSection.getByText(ctx.beta, { exact: true }).first();
      try {
        await betaVersionText.waitFor({ timeout: 2 * kMin });
        const row = betaVersionText.locator(
          'xpath=ancestor::div[contains(@class,"py-2.5")][1]',
        );
        applyButton = row.getByRole("button", { name: /^(Upgrade|Switch|Try again)$/ });
      } catch {
        console.warn(
          `[container-e2e] no catalog row with exact text ${ctx.beta} — falling back to the first Beta-section row`,
        );
        applyButton = betaSection
          .getByRole("button", { name: /^(Upgrade|Switch|Try again)$/ })
          .first();
      }
      await applyButton.first().click({ timeout: 60_000 });

      // U3 confirm dialog → the primary "Apply" button, scoped to the modal
      // overlay so it can never collide with catalog-row buttons.
      const dialog = page.locator("div.fixed.inset-0");
      await dialog.waitFor({ timeout: 30_000 });
      await dialog
        .getByRole("button", { name: "Apply", exact: true })
        .click({ timeout: 30_000 });

      // Progress card: heading "Updating to <beta>", then the Backup step,
      // then Restarting. Steps run in order, so "Restarting" appearing means
      // Backup completed; the green step dot is checked when reachable.
      await waitFor(
        async () => (await pageBodyText(page)).includes(`Updating to ${ctx.beta}`),
        { timeoutMs: 2 * kMin, intervalMs: 2000, label: "progress card heading" },
      );
      await waitFor(async () => (await pageBodyText(page)).includes("Backup"), {
        timeoutMs: 5 * kMin,
        intervalMs: 2000,
        label: "Backup step visible",
      });
      await waitFor(
        async () => {
          const text = await pageBodyText(page);
          if (text.includes("Restarting")) return true;
          // Belt-and-suspenders: the Backup row's status dot turning green.
          try {
            const backupRow = page
              .getByText("Backup", { exact: true })
              .locator("xpath=parent::*");
            const greenDots = await backupRow
              .locator('span[class*="bg-green-500"]')
              .count();
            if (greenDots > 0) return true;
          } catch {}
          if (text.includes("failed") && text.includes(`Update to ${ctx.beta}`)) {
            throw new Error(`UI reports the update FAILED:\n${text.slice(0, 4000)}`);
          }
          return false;
        },
        {
          timeoutMs: 14 * kMin,
          intervalMs: 3000,
          label: "Backup completed / Restarting step visible",
        },
      );
    } catch (err) {
      await screenshotOnFailure(page, "apply-failed");
      throw err;
    } finally {
      await browser.close().catch(() => {});
    }
  });

  step("container restarts under the orchestrator policy and comes back on beta", 15 * kMin, async () => {
    // (g) restartProcess() → process.exit(1) under /.dockerenv →
    // --restart=always brings the container back. Detect via RestartCount or
    // a StartedAt change.
    await waitFor(
      async () => {
        if ((await restartCount(kContainerA)) >= 1) return true;
        return (await containerStartedAt(kContainerA)) !== ctx.bootStartedAt;
      },
      { timeoutMs: 10 * kMin, intervalMs: 2000, label: "container restart observed" },
    );

    // Best-effort placeholder observation: the boot placeholder window is
    // timing-dependent (503 + updating page between bind and real server) —
    // record whether we caught it, never fail on it.
    ctx.placeholderObserved = false;
    const placeholderDeadline = Date.now() + 90_000;
    while (Date.now() < placeholderDeadline && !ctx.placeholderObserved) {
      try {
        const port = await getMappedPort(kContainerA);
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          headers: { Accept: "text/html" },
        });
        if (res.status === 503) {
          const body = await res.text();
          if (/Updating to OpenClaw|AlphaClaw is updating|Restarting/i.test(body)) {
            ctx.placeholderObserved = true;
            break;
          }
        } else if (res.status === 200) {
          break; // real server already back — window missed
        }
      } catch {}
      await sleep(500);
    }
    console.log(
      `[container-e2e] boot placeholder observed during restart window: ${ctx.placeholderObserved}`,
    );

    // (g cont.) Dynamic host port can be re-published on restart; sessions
    // may reset — waitForVersion re-resolves both.
    ctx.cookie = null;
    await waitForUiUp(kContainerA, 5 * kMin);
    await waitForVersion(kContainerA, ctx.beta, 10 * kMin);
  });

  step("browser shows the beta verdict after a fresh login", 8 * kMin, async () => {
    // (h) The verdict banner may have expired after reloads — accept either
    // the banner or the status card's Running row showing the beta.
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    const page = await browser.newContext().then((c) => c.newPage());
    try {
      await loginThroughBrowser(page);
      await page.goto(`${baseUrl()}/#/upgrade`, { waitUntil: "domcontentloaded" });
      await page.getByText("Release channel").first().waitFor({ timeout: 2 * kMin });
      await waitFor(
        async () => {
          const text = await pageBodyText(page);
          if (text.includes(`Now on OpenClaw ${ctx.beta}`)) return true;
          try {
            const runningValue = await page
              .locator('dt:text-is("Running")')
              .locator("xpath=following-sibling::dd[1]")
              .innerText({ timeout: 5000 });
            if (runningValue.includes(ctx.beta)) return true;
          } catch {}
          return false;
        },
        {
          timeoutMs: 3 * kMin,
          intervalMs: 3000,
          label: `verdict banner or Running row shows ${ctx.beta}`,
        },
      );
    } catch (err) {
      await screenshotOnFailure(page, "verdict-missing");
      throw err;
    } finally {
      await browser.close().catch(() => {});
    }
  });

  step("live instance runs the beta and the #20 config seeds survived", 5 * kMin, async () => {
    // (i) The LIVE binary — not just the UI's opinion of it.
    const { stdout: versionOut } = await execInContainer(kContainerA, [
      "openclaw",
      "--version",
    ]);
    expect(versionOut).toContain(ctx.beta);
    // The boot reconciler (settings/DB migration) runs BEFORE the gateway
    // launches on the new build — poll rather than single-shot: /api/status
    // answers as soon as the server listens, minutes before the gateway can
    // be healthy on a migration-heavy boot.
    await waitFor(() => gatewayHealthzOk(kContainerA), {
      timeoutMs: 4 * kMin,
      intervalMs: 3000,
      label: "beta gateway healthz after the activation boot",
    });

    const { stdout: configOut } = await execInContainer(kContainerA, [
      "cat",
      "/data/.openclaw/openclaw.json",
    ]);
    const config = JSON.parse(configOut);
    // #20 hard assertion: the mcp server block and its ${ENV} reference must
    // survive the upgrade byte-for-byte (never resolved, never stripped).
    expect(config.mcp?.servers?.nessie?.url).toBe("https://example.com/mcp");
    expect(config.mcp?.servers?.nessie?.headers?.Authorization).toBe("${NESSIE_TOKEN}");
    // The retired-looking `meta` key is the settings reconciler's call (that
    // slice ships in parallel) — record what happened, never hard-fail on it.
    // The incident-defining outcome is "gateway healthy with the config as
    // reconciled", asserted above.
    ctx.metaKeyAfterUpgrade = config.meta;
    console.log(
      `[container-e2e] retired seed key meta after upgrade: ${JSON.stringify(config.meta) ?? "(removed)"}`,
    );
  });

  step("durability leg A: a FRESH container on the same volume boots the beta", 12 * kMin, async () => {
    // (j) The upgrade must live in /data, not in the replaced container.
    await removeContainer(kContainerA);
    await runContainer({
      name: kContainerB,
      image: kImageTag,
      volume: kVolume,
      env: containerEnv(),
    });
    ctx.activeContainer = kContainerB;
    ctx.cookie = null;
    await waitForUiUp(kContainerB, 5 * kMin);
    await waitForVersion(kContainerB, ctx.beta, 10 * kMin);
    await waitFor(() => gatewayHealthzOk(kContainerB), {
      timeoutMs: 5 * kMin,
      intervalMs: 3000,
      label: `gateway /healthz inside ${kContainerB} after container replacement`,
    });
  });

  step("durability leg B: docker restart boots the beta again", 12 * kMin, async () => {
    // (k) And it survives a plain restart of the same container.
    await docker(["restart", kContainerB], { timeoutMs: 2 * kMin });
    ctx.cookie = null;
    await waitForUiUp(kContainerB, 5 * kMin);
    await waitForVersion(kContainerB, ctx.beta, 10 * kMin);
    await waitFor(() => gatewayHealthzOk(kContainerB), {
      timeoutMs: 5 * kMin,
      intervalMs: 3000,
      label: `gateway /healthz inside ${kContainerB} after docker restart`,
    });
  });
});
