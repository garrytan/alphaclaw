const express = require("express");
const request = require("supertest");

const { classifySecretDropKey } = require("../../lib/server/utils/env-keys");
const { createSecretDropRequests } = require("../../lib/server/secret-drop/requests");
const { createSecretDropApplier, normalizeSecretValue, configReferencesStoreId } = require("../../lib/server/secret-drop/apply");
const { registerSecretDropRoutes } = require("../../lib/server/routes/secret-drop");
const { createTerminalErrorHandler } = require("../../lib/server/terminal-error-handler");

const kCanary = "cnry7Q2xVb9LmZp4Wt8sK3dF";
const kPrefix = kCanary.slice(0, 8);
const kOrigin = "https://box.example.com";

// A fake openclaw CLI: records argv and stdin, answers the store list from
// `kinds`, and fails the commands `fail` names.
const createFakeCli = ({ kinds = {}, fail = [] } = {}) => {
  const calls = [];
  const execFileCmd = vi.fn(async (file, args, opts) => {
    calls.push({ file, args: [...args], input: opts?.input ?? null, processGroup: opts?.processGroup === true });
    const joined = args.join(" ");
    if (fail.some((pattern) => joined.includes(pattern))) {
      throw Object.assign(new Error("Grouped command failed"), { code: 1, stdout: "", stderr: "boom " + (opts?.input || "") });
    }
    if (joined === "secrets store list --json") {
      return JSON.stringify(Object.entries(kinds).map(([name, kind]) => ({ name, kind, ...(kind === "env" ? { valuePreview: "pre" } : {}) })));
    }
    return "ok";
  });
  return { execFileCmd, calls };
};

const createHarness = ({ kinds, fail, envFails = false, config = {}, ttlMs, envVars = [{ key: "OTHER", value: "x" }], lockGate = null } = {}) => {
  const cli = createFakeCli({ kinds, fail });
  const envWrites = [];
  const lockEvents = [];
  const notices = [];
  const lines = [];
  const logger = {
    log: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
  let now = 1_800_000_000_000;
  const requests = createSecretDropRequests({ nowFn: () => now, ...(ttlMs ? { ttlMs } : {}) });
  const applier = createSecretDropApplier({
    execFileCmd: cli.execFileCmd,
    gatewayEnv: () => ({ OPENCLAW_STATE_DIR: "/tmp/state" }),
    readEnvFile: () => envVars,
    setEnvKey: async (req, key, value) => {
      lockEvents.push("env");
      if (envFails) throw new Error("ENOSPC: no space left on device");
      envWrites.push({ key, value });
      return { ok: true };
    },
    readOpenclawConfig: () => config,
    gatewayLifecycleLock: {
      acquire: async (kind) => {
        lockEvents.push(`acquire:${kind}`);
        if (lockGate) await lockGate;
        return () => lockEvents.push("release");
      },
    },
    resolveEnvKeyReach: () => "never",
  });
  const app = express();
  app.use(express.json());
  // Identity from a test header: admin, member or none. The agent bearer is
  // never an identity (requireAuth marks it as the agent actor for /api).
  const resolveRequestIdentity = (req) => {
    const who = req.get("x-test-identity");
    if (who === "admin") return { kind: "legacy", role: "admin" };
    if (who === "member") return { kind: "member", role: "member", memberId: "m1" };
    return null;
  };
  const requireAuth = (req, res, next) => {
    if (resolveRequestIdentity(req)) return next();
    if (req.get("authorization") === "Bearer agent") {
      req.alphaclawActor = { type: "agent" };
      return next();
    }
    return res.status(401).json({ error: "Unauthorized" });
  };
  registerSecretDropRoutes({
    app,
    requireAuth,
    resolveRequestIdentity,
    requests,
    applier,
    resolveSetupUrl: () => kOrigin,
    notify: async (message) => notices.push(message),
    logger,
  });
  app.use(createTerminalErrorHandler({ logger }));
  return { app, cli, envWrites, lockEvents, notices, lines, requests, advance: (ms) => { now += ms; } };
};

const askForLink = async (h, name = "GITHUB_TOKEN") => {
  const res = await request(h.app).post("/api/secrets/requests").set("Authorization", "Bearer agent").send({ name, reason: "open PRs" });
  expect(res.status).toBe(201);
  const token = new URL(res.body.url).pathname.split("/").pop();
  return { res, token, id: res.body.request.id };
};

const openPage = async (h, token, who = "admin") => {
  const res = await request(h.app).get(`/secret/${token}`).set("x-test-identity", who);
  const csrf = /name="csrf" value="([^"]+)"/.exec(res.text)?.[1] || "";
  return { res, csrf };
};

const save = (h, token, fields, { who = "admin", origin = kOrigin } = {}) => {
  let call = request(h.app).post(`/secret/${token}`).type("form").set("x-test-identity", who);
  if (origin) call = call.set("Origin", origin);
  return call.send(fields);
};

// Every place a value could leak to: console and logger lines, notices,
// response bodies and headers, the request records, and every CLI argv.
const expectNoCanary = (h, responses) => {
  const surfaces = [
    ...h.lines,
    ...h.notices,
    ...responses.map((res) => `${res.text ?? ""}${JSON.stringify(res.body ?? {})}${JSON.stringify(res.headers ?? {})}`),
    ...h.cli.calls.map((call) => call.args.join(" ")),
  ].join("\n");
  expect(surfaces).not.toContain(kPrefix);
};

describe("secret drop: names it may store", () => {
  it.each([
    ["GITHUB_TOKEN", true],
    ["MYSVC_API_KEY", true],
    ["github_token", false],
    ["1TOKEN", false],
    ["A".repeat(129), false],
    ["SETUP_PASSWORD", false],
    ["OPENCLAW_STATE_DIR", false],
    ["TELEGRAM_BOT_TOKEN", false],
    ["TELEGRAM_BOT_TOKEN_SECOND", false],
    ["CLAUDE_CODE_ROUTINE_TOKEN", false],
    ["ANTHROPIC_TOKEN", false],
    ["ALPHACLAW_GATEWAY_LOCKED_ENV", false],
  ])("%s → ok=%s", (name, ok) => {
    expect(classifySecretDropKey(name).ok).toBe(ok);
  });

  it("refuses an operator-locked key such as WM_GUARDS_MODE", () => {
    const saved = process.env.ALPHACLAW_GATEWAY_LOCKED_ENV;
    const mods = ["../../lib/server/deployment-only-env", "../../lib/server/utils/env-keys"];
    mods.forEach((m) => delete require.cache[require.resolve(m)]);
    process.env.ALPHACLAW_GATEWAY_LOCKED_ENV = "WM_GUARDS_MODE";
    try {
      const fresh = require("../../lib/server/utils/env-keys");
      expect(fresh.classifySecretDropKey("WM_GUARDS_MODE")).toMatchObject({ ok: false, reason: "deployment_only" });
    } finally {
      if (saved === undefined) delete process.env.ALPHACLAW_GATEWAY_LOCKED_ENV;
      else process.env.ALPHACLAW_GATEWAY_LOCKED_ENV = saved;
      mods.forEach((m) => delete require.cache[require.resolve(m)]);
    }
  });
});

describe("secret drop: value normalization and store refs", () => {
  it("drops one trailing line break and turns CRLF into LF", () => {
    expect(normalizeSecretValue("abc\n")).toBe("abc");
    expect(normalizeSecretValue("abc\r\n")).toBe("abc");
    expect(normalizeSecretValue("abc\n\n")).toBe("abc\n");
    expect(normalizeSecretValue("a\r\nb\r\n")).toBe("a\nb");
  });

  it("finds a store SecretRef by id anywhere in the config", () => {
    const config = { models: { providers: { x: { apiKey: { source: "store", provider: "default", id: "X_KEY" } } } } };
    expect(configReferencesStoreId(config, "X_KEY")).toBe(true);
    expect(configReferencesStoreId(config, "Y_KEY")).toBe(false);
  });
});

describe("secret drop: requests", () => {
  it("keeps only the token hash, opens once, and expires after 15 minutes", () => {
    let now = 0;
    const requests = createSecretDropRequests({ nowFn: () => now });
    const created = requests.create({ name: "GITHUB_TOKEN" });
    expect(created.ok).toBe(true);
    expect(JSON.stringify(requests.get(created.request.id))).not.toContain(created.token);
    expect(requests.resolveToken(created.token)?.name).toBe("GITHUB_TOKEN");
    expect(requests.resolveToken(created.token.slice(0, -1) + (created.token.endsWith("A") ? "B" : "A"))).toBeNull();
    now += 15 * 60 * 1000;
    expect(requests.resolveToken(created.token)).toBeNull();
    expect(requests.get(created.request.id).status).toBe("expired");
  });

  it("refuses a locked name when the link is requested", async () => {
    const h = createHarness();
    const res = await request(h.app).post("/api/secrets/requests").set("Authorization", "Bearer agent").send({ name: "SETUP_PASSWORD" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("reserved");
  });
});

describe("secret drop: the page and Save", () => {
  it("stores the same bytes in both stores, on stdin, under the lifecycle lock, and spends the link", async () => {
    const h = createHarness();
    const { res: asked, token, id } = await askForLink(h);
    expect(asked.body.url).toMatch(/^https:\/\/box\.example\.com\/secret\/[A-Za-z0-9_-]{43}$/);
    const { res: page, csrf } = await openPage(h, token);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.text).toContain('type="password"');

    const saved = await save(h, token, { csrf, value: kCanary + "\n" });
    expect(saved.status).toBe(200);
    expect(saved.text).toContain("Stored");
    expect(h.envWrites).toEqual([{ key: "GITHUB_TOKEN", value: kCanary }]);
    const set = h.cli.calls.filter((call) => call.args[2] === "set");
    expect(set.map((call) => call.args)).toEqual([
      ["secrets", "store", "set", "GITHUB_TOKEN", "--kind", "secret", "--dry-run"],
      ["secrets", "store", "set", "GITHUB_TOKEN", "--kind", "secret"],
    ]);
    for (const call of set) {
      expect(call.input).toBe(kCanary);
      expect(call.processGroup).toBe(true);
    }
    expect(h.lockEvents).toEqual(["acquire:secret_drop", "env", "release"]);
    const status = await request(h.app).get(`/api/secrets/requests/${id}`).set("Authorization", "Bearer agent");
    expect(status.body.request).toMatchObject({ status: "stored", stores: { env: true, store: true } });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("GITHUB_TOKEN");
    const reused = await save(h, token, { csrf, value: kCanary });
    expect(reused.status).toBe(410);
    expectNoCanary(h, [asked, page, saved, status, reused]);
  });

  it("keeps an existing store entry's kind and passes no --kind", async () => {
    const h = createHarness({ kinds: { GITHUB_TOKEN: "env" } });
    const { token } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    const saved = await save(h, token, { csrf, value: kCanary });
    expect(saved.status).toBe(200);
    expect(saved.text).toContain("keeps it that way");
    expect(h.cli.calls.filter((call) => call.args[2] === "set").map((call) => call.args)).toEqual([
      ["secrets", "store", "set", "GITHUB_TOKEN", "--dry-run"],
      ["secrets", "store", "set", "GITHUB_TOKEN"],
    ]);
    expectNoCanary(h, [saved]);
  });

  it("reloads OpenClaw's secrets only when a store SecretRef names the key", async () => {
    const h = createHarness({ config: { models: { providers: { gh: { apiKey: { source: "store", provider: "default", id: "GITHUB_TOKEN" } } } } } });
    const { token } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    await save(h, token, { csrf, value: kCanary });
    expect(h.cli.calls.map((call) => call.args.join(" "))).toContain("secrets reload --json");
  });

  it("writes nothing when OpenClaw's dry run refuses the value", async () => {
    const h = createHarness({ fail: ["--dry-run"] });
    const { token } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    const saved = await save(h, token, { csrf, value: kCanary });
    expect(saved.status).toBe(400);
    expect(saved.text).toContain("Nothing was saved");
    expect(h.envWrites).toEqual([]);
    expect(h.lockEvents).toEqual([]);
    expect(h.notices).toEqual([]);
    expectNoCanary(h, [saved]);
  });

  it("a CLI failure on the real write is partial: the link stays open and Retry asks again", async () => {
    const h = createHarness({ fail: ["set GITHUB_TOKEN --kind secret"] });
    h.cli.execFileCmd.mockImplementation(async (file, args, opts) => {
      h.cli.calls.push({ file, args: [...args], input: opts?.input ?? null });
      const joined = args.join(" ");
      if (joined === "secrets store list --json") return "[]";
      if (joined === "secrets store set GITHUB_TOKEN --kind secret") throw Object.assign(new Error("Grouped command failed"), { code: 1, stderr: String(opts?.input) });
      return "ok";
    });
    const { token, id } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    const saved = await save(h, token, { csrf, value: kCanary });
    expect(saved.status).toBe(200);
    expect(saved.text).toContain("Partly stored");
    expect(saved.text).toContain('name="value"');
    expect(h.requests.get(id)).toMatchObject({ status: "partial", stores: { env: true, store: false } });
    expect(h.notices[0]).toContain("partly");
    const again = await openPage(h, token);
    expect(again.res.status).toBe(200);
    expectNoCanary(h, [saved, again.res]);
  });

  it("a multi-line value goes to the store only, with a notice", async () => {
    const h = createHarness();
    const { token } = await askForLink(h, "TLS_PRIVATE_KEY");
    const { csrf } = await openPage(h, token);
    const pem = `-----BEGIN KEY-----\r\n${kCanary}\r\n-----END KEY-----\r\n`;
    const saved = await save(h, token, { csrf, value_multiline: pem });
    expect(saved.status).toBe(200);
    expect(h.envWrites).toEqual([]);
    expect(h.cli.calls.find((call) => call.args.join(" ") === "secrets store set TLS_PRIVATE_KEY --kind secret").input).toBe(
      `-----BEGIN KEY-----\n${kCanary}\n-----END KEY-----`,
    );
    expect(saved.text).toContain("store only");
    expectNoCanary(h, [saved]);
  });

  it("a multi-line value says when .env still holds an older value of the key", async () => {
    const h = createHarness({ envVars: [{ key: "TLS_PRIVATE_KEY", value: "old-one-line" }] });
    const { token } = await askForLink(h, "TLS_PRIVATE_KEY");
    const { csrf } = await openPage(h, token);
    const saved = await save(h, token, { csrf, value_multiline: `-----BEGIN KEY-----\n${kCanary}\n-----END KEY-----` });
    expect(saved.status).toBe(200);
    expect(h.envWrites).toEqual([]);
    expect(saved.text).toContain(".env still holds an older TLS_PRIVATE_KEY");
    expectNoCanary(h, [saved]);
  });

  it("a second Save while the first is still running writes nothing", async () => {
    let openGate;
    const h = createHarness({ lockGate: new Promise((resolve) => { openGate = resolve; }) });
    const { token, id } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    const first = save(h, token, { csrf, value: kCanary }).then((res) => res);
    await vi.waitFor(() => expect(h.lockEvents).toContain("acquire:secret_drop"));
    const second = await save(h, token, { csrf, value: kCanary + "x" });
    expect(second.status).toBe(409);
    openGate();
    const done = await first;
    expect(done.status).toBe(200);
    expect(h.envWrites).toEqual([{ key: "GITHUB_TOKEN", value: kCanary }]);
    expect(h.cli.calls.filter((call) => call.args[2] === "set" && !call.args.includes("--dry-run"))).toHaveLength(1);
    expect(h.requests.get(id)).toMatchObject({ status: "stored" });
    expectNoCanary(h, [second, done]);
  });

  it("an env write failure is partial and names the store that holds it", async () => {
    const h = createHarness({ envFails: true });
    const { token, id } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    const saved = await save(h, token, { csrf, value: kCanary });
    expect(h.requests.get(id)).toMatchObject({ status: "partial", stores: { env: false, store: true } });
    expect(saved.text).toContain(".env was not written");
    expectNoCanary(h, [saved]);
  });

  it("sends a signed-out browser to the login page with a return path", async () => {
    const h = createHarness();
    const { token } = await askForLink(h);
    const res = await request(h.app).get(`/secret/${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/login.html?next=${encodeURIComponent(`/secret/${token}`)}`);
  });

  it("refuses members, the agent bearer, a cross-origin post and a wrong CSRF token", async () => {
    const h = createHarness();
    const { token } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    const member = await save(h, token, { csrf, value: kCanary }, { who: "member" });
    expect(member.status).toBe(403);
    const agent = await request(h.app).post(`/secret/${token}`).type("form").set("Authorization", "Bearer agent").send({ csrf, value: kCanary });
    expect(agent.status).toBe(401);
    const cross = await save(h, token, { csrf, value: kCanary }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const forged = await save(h, token, { csrf: "x".repeat(32), value: kCanary });
    expect(forged.status).toBe(403);
    expect(h.envWrites).toEqual([]);
    expect(h.cli.calls.filter((call) => call.args[2] === "set")).toEqual([]);
    expectNoCanary(h, [member, agent, cross, forged]);
  });

  it("an expired link writes nothing", async () => {
    const h = createHarness();
    const { token } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    h.advance(16 * 60 * 1000);
    const saved = await save(h, token, { csrf, value: kCanary });
    expect(saved.status).toBe(410);
    expect(h.envWrites).toEqual([]);
    expectNoCanary(h, [saved]);
  });

  it("a link that expired after a failed save does not say a save stands", async () => {
    const h = createHarness({ fail: ["--dry-run"] });
    const { token } = await askForLink(h);
    const { csrf } = await openPage(h, token);
    const failed = await save(h, token, { csrf, value: kCanary });
    expect(failed.status).toBe(400);
    h.advance(16 * 60 * 1000);
    const { res: gone } = await openPage(h, token);
    expect(gone.status).toBe(410);
    expect(gone.text).toContain("This visit saved nothing");
    expect(gone.text).toContain("only if its page said Stored or Partly stored");
    expect(gone.text).not.toContain("that save stands");
    expect(h.envWrites).toEqual([]);
    expectNoCanary(h, [failed, gone]);
  });

  it("a malformed or oversized body is answered without echoing it", async () => {
    const h = createHarness();
    const { token } = await askForLink(h);
    const json = await request(h.app).post(`/secret/${token}`).set("x-test-identity", "admin").set("Origin", kOrigin).set("Content-Type", "application/json").send('{"value":"' + kCanary);
    expect([400, 403]).toContain(json.status);
    const big = await save(h, token, { csrf: "x", value: kCanary + "y".repeat(70 * 1024) });
    expect(big.status).toBe(413);
    expect(h.envWrites).toEqual([]);
    expectNoCanary(h, [json, big]);
  });
});
