const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const {
  createLoginThrottle,
  createMemoryLoginThrottleStore,
} = require("../../lib/server/login-throttle");
const {
  kLoginBaseLockMs,
  kLoginGlobalMaxAttempts,
  kLoginMaxAttempts,
} = require("../../lib/server/constants");
const { getClientKey } = require("../../lib/server/helpers");
const timingSafe = require("../../lib/server/utils/timing-safe");
const {
  kDeploymentOnlyEnvKeys,
  kDeploymentSecretEnvKeys,
  resolveEnvFileOverlay,
} = require("../../lib/server/deployment-only-env");
const { blankDeniedGatewayEnvKeys } = require("../../lib/server/gateway-env-policy");

const kAuthPath = require.resolve("../../lib/server/routes/auth");
const kClientIpPath = "../../lib/server/login-client-ip";
const kRecoveryEnvKey = "ALPHACLAW_LOGIN_RECOVERY_CODE";
const kSetupPasswordEnvKey = "SETUP_PASSWORD";
const kPassCookie = "alphaclaw_device";
const kOwnerPeer = "198.51.100.10";
const kDayMs = 24 * 60 * 60 * 1000;

const randomValue = (bytes = 24) => crypto.randomBytes(bytes).toString("hex");
// 198.18.0.0/15 (benchmarking) is public to the limiter and routes nowhere.
const attackerPeer = (i) => "198.18." + Math.floor(i / 250) + "." + ((i % 250) + 1);
const forgedAddress = (i) => "192.0.2." + ((i % 250) + 1);

const kOwnerPassword = randomValue();
const kRecoveryCode = randomValue(32);

const createMembersStore = (list) => {
  const tokenKeys = new Map(list.map((m) => [m.id, randomValue(32)]));
  const find = (email) =>
    list.find((m) => m.email === String(email || "").trim().toLowerCase()) || null;
  const toModel = (m) =>
    m ? { id: m.id, email: m.email, displayName: m.email, role: m.role, disabled: false } : null;
  return {
    verifyMemberPassword: vi.fn(({ email, password }) => {
      const member = find(email);
      return member && password === member.password ? toModel(member) : null;
    }),
    getMemberByEmail: (email) => toModel(find(email)),
    getMember: (id) => toModel(list.find((m) => m.id === id)),
    getTokenSecret: (id) => tokenKeys.get(id) || null,
    rotateTokenSecret: (id) => {
      tokenKeys.set(id, randomValue(32));
      return true;
    },
    acceptInvite: vi.fn(() => ({ ok: false, code: "invite_invalid" })),
  };
};

const credentialsOf = (member) => ({ email: member.email, password: member.password });

const memberA = { id: "member-a", email: "a@example.test", password: randomValue(), role: "admin" };
const memberB = { id: "member-b", email: "b@example.test", password: randomValue(), role: "member" };

const servers = [];
let compareSpy;

// keyMode "login": the login-scoped client IP (the production wiring);
// "express": req.ip, for the throughput guards that must also run on main.
const createHarness = async ({
  team = false,
  legacyOff = false,
  members = [],
  statePath = null,
  setupPassword = kOwnerPassword,
  recoveryCode = kRecoveryCode,
  keyMode = "login",
} = {}) => {
  Object.assign(process.env, { [kSetupPasswordEnvKey]: setupPassword });
  if (recoveryCode === null) delete process.env[kRecoveryEnvKey];
  else process.env[kRecoveryEnvKey] = recoveryCode;
  delete require.cache[kAuthPath];
  const { registerAuthRoutes } = require(kAuthPath);
  const store = createMemoryLoginThrottleStore();
  const loginThrottle = {
    ...createLoginThrottle({ store }),
    getClientKey:
      keyMode === "express"
        ? getClientKey
        : (req) => require(kClientIpPath).resolveLoginClientIp(req),
  };
  const membersStore = createMembersStore(members);
  const app = express();
  app.set("trust proxy", 1);
  // Stands in for the TCP peer: supertest always connects over loopback.
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: String(req.headers["x-test-peer"] || kOwnerPeer),
      configurable: true,
    });
    next();
  });
  app.use(express.json());
  registerAuthRoutes({
    app,
    loginThrottle,
    membersStore,
    readTeamSettings: () => ({ enabled: team, disableLegacyLogin: legacyOff }),
    legacySessionStatePath: statePath,
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  return { server, store, membersStore };
};

const signIn = (h, { peer = kOwnerPeer, xff, password, email, recoveryCode, pass, cookie } = {}) => {
  let req = request(h.server).post("/api/auth/login").set("x-test-peer", peer);
  if (xff) req = req.set("X-Forwarded-For", xff);
  const cookies = [pass ? kPassCookie + "=" + pass : "", cookie || ""].filter(Boolean);
  if (cookies.length) req = req.set("Cookie", cookies.join("; "));
  const body = { password };
  if (email) body.email = email;
  if (recoveryCode !== undefined) body.recoveryCode = recoveryCode;
  return req.send(body);
};

const setCookies = (res) => res.headers["set-cookie"] || [];
const readPass = (res) => {
  const entry = setCookies(res).find((c) => c.startsWith(kPassCookie + "="));
  return entry ? entry.split(";")[0].slice(kPassCookie.length + 1) : "";
};
// A well-formed pass whose MAC no longer matches.
const tamper = (pass) => pass.slice(0, -2) + (pass.endsWith("AA") ? "BB" : "AA");
const readSession = (res) => {
  const entry = setCookies(res).find((c) => c.startsWith("setup_token="));
  return entry ? entry.split(";")[0] : "";
};

// Rotating clients (a botnet, each also forging X-Forwarded-For) lock the
// box-wide bucket.
const lockShared = async (h, { email, count = kLoginGlobalMaxAttempts + 10, offset = 0 } = {}) => {
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      signIn(h, {
        peer: attackerPeer(offset + i),
        xff: forgedAddress(i),
        password: "wrong-" + i,
        email,
      }),
    ),
  );
  const probe = await signIn(h, {
    peer: attackerPeer(offset + count + 1),
    password: email ? memberA.password : kOwnerPassword,
    email,
  });
  expect(probe.status).toBe(429);
};

const passwordChecks = (h) =>
  compareSpy.mock.calls.filter(([, expected]) => expected === process.env.SETUP_PASSWORD).length +
  h.membersStore.verifyMemberPassword.mock.calls.length;

const resetPasswordChecks = (h) => {
  compareSpy.mockClear();
  h.membersStore.verifyMemberPassword.mockClear();
};

const auditLines = (...spies) =>
  spies
    .flatMap((spy) => spy.mock.calls.map((args) => String(args[0])))
    .filter((line) => line.startsWith("[auth] sign-in"));

describe("sign-in: owner lane past the shared login bucket", { timeout: 30000 }, () => {
  beforeEach(() => {
    compareSpy = vi.spyOn(timingSafe, "timingSafeStringEqual");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
    delete process.env.SETUP_PASSWORD;
    delete process.env[kRecoveryEnvKey];
  });

  describe("owner access during an attack", () => {
    it("the owner's known-browser pass gets past a blocked IP and a locked shared bucket", async () => {
      const h = await createHarness();
      const first = await signIn(h, { password: kOwnerPassword });
      expect(first.status).toBe(200);
      const pass = readPass(first);
      expect(pass).not.toBe("");
      for (let i = 0; i < kLoginMaxAttempts; i += 1) await signIn(h, { password: "wrong-" + i });
      expect((await signIn(h, { password: kOwnerPassword })).status).toBe(429);
      await lockShared(h);

      const res = await signIn(h, { password: kOwnerPassword, pass });
      expect(res.status).toBe(200);
      expect(readSession(res)).toMatch(/^setup_token=/);
    });

    it("the recovery code gets a new device past a blocked IP and a locked shared bucket", async () => {
      const h = await createHarness();
      const newDevice = "198.51.100.44";
      for (let i = 0; i < kLoginMaxAttempts; i += 1) {
        await signIn(h, { peer: newDevice, password: "wrong-" + i });
      }
      await lockShared(h);

      const res = await signIn(h, { peer: newDevice, password: kOwnerPassword, recoveryCode: kRecoveryCode });
      expect(res.status).toBe(200);
      expect(readSession(res)).toMatch(/^setup_token=/);
    });

    it("the right password with neither credential still gets 429 while the shared bucket is locked", async () => {
      const h = await createHarness();
      await lockShared(h);
      const res = await signIn(h, { peer: "198.51.100.45", password: kOwnerPassword });
      expect(res.status).toBe(429);
      expect(readSession(res)).toBe("");
    });

    it("team mode: an owner whose shared-password login is off signs in with the recovery code and their own password", async () => {
      const h = await createHarness({ team: true, legacyOff: true, members: [memberA] });
      await lockShared(h, { email: "nobody@example.test" });

      const wrong = await signIn(h, {
        email: memberA.email,
        password: "wrong",
        recoveryCode: kRecoveryCode,
      });
      expect(wrong.status).toBe(401);
      const res = await signIn(h, { ...credentialsOf(memberA), recoveryCode: kRecoveryCode });
      expect(res.status).toBe(200);
      expect(readSession(res)).toMatch(/^setup_token=v2\./);
    });
  });

  describe("per-IP block", () => {
    it("trips at the failure limit, expires after its lock, and locks longer on a repeat", async () => {
      let clock = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const h = await createHarness();
      const peer = "198.51.100.50";
      const statuses = [];
      for (let i = 0; i < kLoginMaxAttempts; i += 1) {
        statuses.push((await signIn(h, { peer, password: "wrong-" + i })).status);
      }
      expect(statuses).toEqual([...Array(kLoginMaxAttempts - 1).fill(401), 429]);
      expect((await signIn(h, { peer, password: kOwnerPassword })).status).toBe(429);

      clock += kLoginBaseLockMs + 1;
      let last;
      for (let i = 0; i < kLoginMaxAttempts; i += 1) last = await signIn(h, { peer, password: "again-" + i });
      expect(last.status).toBe(429);
      expect(last.body.retryAfterSec).toBe((2 * kLoginBaseLockMs) / 1000);

      clock += 2 * kLoginBaseLockMs + 1;
      expect((await signIn(h, { peer, password: kOwnerPassword })).status).toBe(200);
    });

    it("a forged X-Forwarded-For does not dodge a block", async () => {
      const h = await createHarness();
      const peer = "198.51.100.60";
      let last;
      for (let i = 0; i < kLoginMaxAttempts; i += 1) {
        last = await signIn(h, { peer, xff: forgedAddress(i), password: "wrong-" + i });
      }
      expect(last.status).toBe(429);
      const dodge = await signIn(h, { peer, xff: forgedAddress(99), password: kOwnerPassword });
      expect(dodge.status).toBe(429);
    });

    it("a forged X-Forwarded-For cannot get another address blocked", async () => {
      const h = await createHarness();
      for (let i = 0; i < kLoginMaxAttempts + 3; i += 1) {
        await signIn(h, { peer: "198.51.100.61", xff: kOwnerPeer, password: "wrong-" + i });
      }
      const owner = await signIn(h, { peer: kOwnerPeer, password: kOwnerPassword });
      expect(owner.status).toBe(200);
    });

    it("behind a private proxy hop, the right-most X-Forwarded-For entry is the client", async () => {
      const h = await createHarness();
      const proxy = "10.0.0.2";
      let last;
      for (let i = 0; i < kLoginMaxAttempts; i += 1) {
        last = await signIn(h, { peer: proxy, xff: forgedAddress(i) + ", 198.51.100.20", password: "wrong-" + i });
      }
      expect(last.status).toBe(429);
      const neighbour = await signIn(h, { peer: proxy, xff: "192.0.2.9, 198.51.100.21", password: kOwnerPassword });
      expect(neighbour.status).toBe(200);
      const blocked = await signIn(h, { peer: proxy, xff: "192.0.2.77, 198.51.100.20", password: kOwnerPassword });
      expect(blocked.status).toBe(429);
    });
  });

  describe("sign-in audit lines", () => {
    it("write one line per outcome with the client IP and the actor type, and nothing secret", async () => {
      const warn = vi.spyOn(console, "warn");
      const log = vi.spyOn(console, "log");
      const h = await createHarness();
      const peer = "198.51.100.30";
      await signIn(h, { peer, password: "wrong-guess" });
      const ok = await signIn(h, { peer, password: kOwnerPassword });
      const pass = readPass(ok);
      for (let i = 0; i < kLoginMaxAttempts; i += 1) await signIn(h, { peer, password: "wrong-" + i });
      await signIn(h, { peer, password: kOwnerPassword, recoveryCode: randomValue(32) });

      const t = await createHarness({ team: true, members: [memberA] });
      await signIn(t, { peer, email: memberA.email, password: "wrong-member" });
      await request(t.server)
        .post("/api/auth/accept-invite")
        .set("x-test-peer", peer)
        .send({ token: randomValue(8), password: memberB.password, email: memberB.email });

      const lines = auditLines(warn, log);
      const route = 'route=POST /api/auth/login ip="198.51.100.30"';
      expect(lines).toContain("[auth] sign-in failed " + route + " actor=owner lane=shared");
      expect(lines).toContain("[auth] sign-in ok " + route + " actor=owner lane=shared");
      expect(lines).toContain("[auth] sign-in rate_limited " + route + " actor=owner lane=shared");
      expect(lines).toContain("[auth] sign-in failed " + route + " actor=owner lane=recovery");
      expect(lines).toContain("[auth] sign-in failed " + route + " actor=member lane=shared");
      expect(lines).toContain('[auth] sign-in failed route=POST /api/auth/accept-invite ip="198.51.100.30" actor=invitee lane=shared');
      for (const secretish of [kOwnerPassword, kRecoveryCode, pass, memberA.email, memberB.email, memberB.password]) {
        expect(lines.join("\n")).not.toContain(secretish);
      }
    });
  });

  describe("box-wide guess throughput (d1a)", () => {
    it("rotating keys, forged and expired passes, a pass for another subject and wrong codes get at most the shared cap of password checks", async () => {
      let clock = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const h = await createHarness({ team: true, members: [memberA], keyMode: "express" });
      const expiredPass = readPass(await signIn(h, { peer: "198.51.100.70", password: kOwnerPassword }));
      clock += 91 * kDayMs;
      const memberPass = readPass(await signIn(h, { peer: "198.51.100.71", email: memberA.email, password: memberA.password }));
      const tamperedPass = tamper(readPass(await signIn(h, { peer: "198.51.100.73", password: kOwnerPassword })));
      resetPasswordChecks(h);

      const attempts = [
        ...Array.from({ length: 300 }, (_, i) => ({ peer: attackerPeer(i), xff: forgedAddress(i), password: "guess-" + i })),
        ...Array.from({ length: 50 }, (_, i) => ({ peer: attackerPeer(400 + i), password: "guess-f" + i, pass: "v1." + randomValue(40) })),
        ...Array.from({ length: 25 }, (_, i) => ({ peer: attackerPeer(500 + i), password: "guess-e" + i, pass: expiredPass })),
        ...Array.from({ length: 25 }, (_, i) => ({ peer: attackerPeer(550 + i), password: "guess-t" + i, pass: tamperedPass })),
        ...Array.from({ length: 25 }, (_, i) => ({ peer: attackerPeer(600 + i), password: "guess-m" + i, pass: memberPass })),
        ...Array.from({ length: 50 }, (_, i) => ({ peer: attackerPeer(700 + i), password: "guess-c" + i, recoveryCode: randomValue(32) })),
      ];
      const results = await Promise.all(attempts.map((a) => signIn(h, a)));

      expect(results.filter((r) => r.status === 200)).toHaveLength(0);
      expect(passwordChecks(h)).toBeGreaterThan(0);
      expect(passwordChecks(h)).toBeLessThanOrEqual(kLoginGlobalMaxAttempts);
    });

    it("a valid stolen pass adds at most one pass's worth of password checks", async () => {
      const h = await createHarness({ keyMode: "express" });
      const stolen = readPass(await signIn(h, { peer: "198.51.100.72", password: kOwnerPassword }));
      resetPasswordChecks(h);

      const attempts = [
        ...Array.from({ length: 300 }, (_, i) => ({ peer: attackerPeer(i), xff: forgedAddress(i), password: "guess-" + i })),
        ...Array.from({ length: 60 }, (_, i) => ({ peer: attackerPeer(400 + i), password: "guess-s" + i, pass: stolen })),
      ];
      const results = await Promise.all(attempts.map((a) => signIn(h, a)));

      expect(results.filter((r) => r.status === 200)).toHaveLength(0);
      expect(passwordChecks(h)).toBeLessThanOrEqual(kLoginGlobalMaxAttempts + kLoginMaxAttempts);
    });
  });

  describe("the recovery code is not an oracle (F2)", () => {
    it("a wrong code gets 401 without a password check, junk codes cannot lock the lane, and 429 comes only from the recovery bucket", async () => {
      const h = await createHarness();
      await lockShared(h);
      resetPasswordChecks(h);

      for (let i = 0; i < 20; i += 1) {
        const junk = await signIn(h, { peer: attackerPeer(900 + i), password: kOwnerPassword, recoveryCode: randomValue(32) });
        expect(junk.status).toBe(401);
      }
      expect(passwordChecks(h)).toBe(0);
      expect((await signIn(h, { peer: "198.51.100.80", password: kOwnerPassword, recoveryCode: kRecoveryCode })).status).toBe(200);

      const statuses = [];
      for (let i = 0; i < kLoginMaxAttempts; i += 1) {
        statuses.push((await signIn(h, { peer: "198.51.100.81", password: "wrong-" + i, recoveryCode: kRecoveryCode })).status);
      }
      expect(statuses).toEqual([...Array(kLoginMaxAttempts - 1).fill(401), 429]);
      const junkWhileLocked = await signIn(h, { peer: "198.51.100.82", password: kOwnerPassword, recoveryCode: randomValue(32) });
      expect(junkWhileLocked.status).toBe(429);
    });

    it("rejects a short or repetitive code at boot with a warning that names only the key", async () => {
      for (const weak of ["ab".repeat(20), randomValue(16).slice(0, 31)]) {
        const warn = vi.spyOn(console, "warn");
        const h = await createHarness({ recoveryCode: weak });
        const warnings = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes(kRecoveryEnvKey));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("openssl rand -hex 32");
        expect(warnings[0]).not.toContain(weak);
        await lockShared(h);
        const res = await signIn(h, { peer: "198.51.100.83", password: kOwnerPassword, recoveryCode: weak });
        expect(res.status).toBe(401);
        expect(readSession(res)).toBe("");
        warn.mockRestore();
      }
    });
  });

  describe("known-browser passes (F3, F4)", () => {
    it("is an HttpOnly, SameSite=Strict cookie scoped to /api/auth", async () => {
      const h = await createHarness();
      const res = await signIn(h, { password: kOwnerPassword });
      const entry = setCookies(res).find((c) => c.startsWith(kPassCookie + "="));
      expect(entry).toBeDefined();
      expect(entry).toMatch(/; Path=\/api\/auth(;|$)/);
      expect(entry).toMatch(/; HttpOnly(;|$)/);
      expect(entry).toMatch(/; SameSite=Strict(;|$)/);
      expect(entry).toMatch(/; Max-Age=7776000(;|$)/);
      expect(setCookies(res)[0]).toMatch(/^setup_token=/);
    });

    it("a forged pass creates no throttle rows of its own", async () => {
      const h = await createHarness();
      const real = readPass(await signIn(h, { password: kOwnerPassword }));
      const forged = tamper(real);
      await Promise.all(
        Array.from({ length: 30 }, (_, i) => signIn(h, { peer: attackerPeer(i), password: "wrong-" + i, pass: i % 2 ? forged : "v1." + randomValue(30) })),
      );
      expect(h.store.entries().filter(([key]) => !key.startsWith("client:") && !key.startsWith("global:"))).toEqual([]);
    });

    it("concurrent attempts on one pass stay within that pass's failure limit", async () => {
      const h = await createHarness();
      const stolen = readPass(await signIn(h, { password: kOwnerPassword }));
      resetPasswordChecks(h);
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => signIn(h, { peer: attackerPeer(i), password: "wrong-" + i, pass: stolen })),
      );
      expect(passwordChecks(h)).toBe(kLoginMaxAttempts);
      expect(results.filter((r) => r.status === 401)).toHaveLength(kLoginMaxAttempts - 1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(0);
    });

    it("a success through the pass leaves the shared bucket untouched (MW3)", async () => {
      const h = await createHarness();
      const pass = readPass(await signIn(h, { password: kOwnerPassword }));
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => signIn(h, { peer: attackerPeer(i), password: "wrong-" + i })),
      );
      expect(h.store.get("global:login").attempts).toBe(10);
      expect((await signIn(h, { password: kOwnerPassword, pass })).status).toBe(200);
      expect(h.store.get("global:login").attempts).toBe(10);
    });

    it("a pass works only for the exact subject it was issued to", async () => {
      const h = await createHarness({ team: true, members: [memberA, memberB] });
      const ownerPass = readPass(await signIn(h, { password: kOwnerPassword }));
      const passA = readPass(await signIn(h, { email: memberA.email, password: memberA.password }));
      await lockShared(h);

      expect((await signIn(h, { pass: ownerPass, email: memberA.email, password: memberA.password })).status).toBe(429);
      expect((await signIn(h, { pass: passA, email: memberB.email, password: memberB.password })).status).toBe(429);
      expect((await signIn(h, { pass: passA, password: kOwnerPassword })).status).toBe(429);
      expect((await signIn(h, { pass: passA, email: memberA.email, password: memberA.password })).status).toBe(200);
    });

    it("owner logout revokes every owner pass and clears this browser's", async () => {
      const h = await createHarness();
      const first = await signIn(h, { password: kOwnerPassword });
      const pass = readPass(first);
      await lockShared(h);
      const during = await signIn(h, { password: kOwnerPassword, pass });
      expect(during.status).toBe(200);

      const logout = await request(h.server).post("/api/auth/logout").set("x-test-peer", kOwnerPeer).set("Cookie", readSession(during));
      expect(logout.status).toBe(200);
      expect(setCookies(logout).some((c) => c.startsWith(kPassCookie + "=;") && c.includes("Path=/api/auth"))).toBe(true);
      expect((await signIn(h, { password: kOwnerPassword, pass })).status).toBe(429);
    });

    it("a SETUP_PASSWORD change revokes owner passes", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-lane-"));
      const statePath = path.join(dir, "legacy-session.json");
      const issuer = await createHarness({ statePath });
      const pass = readPass(await signIn(issuer, { password: kOwnerPassword }));

      const same = await createHarness({ statePath });
      await lockShared(same);
      expect((await signIn(same, { password: kOwnerPassword, pass })).status).toBe(200);

      const changed = randomValue();
      const rotated = await createHarness({ statePath, setupPassword: changed });
      await lockShared(rotated);
      expect((await signIn(rotated, { password: changed, pass })).status).toBe(429);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("a member's logout revokes that member's pass", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      const first = await signIn(h, { email: memberA.email, password: memberA.password });
      const passA = readPass(first);
      const logout = await request(h.server).post("/api/auth/logout").set("x-test-peer", kOwnerPeer).set("Cookie", readSession(first));
      expect(logout.status).toBe(200);
      await lockShared(h);
      expect((await signIn(h, { pass: passA, email: memberA.email, password: memberA.password })).status).toBe(429);
    });
  });

  describe("the recovery code is deployment-only", () => {
    it("is never taken from .env and reaches the gateway child empty", () => {
      expect(kDeploymentOnlyEnvKeys).toContain(kRecoveryEnvKey);
      expect(kDeploymentSecretEnvKeys).toContain(kRecoveryEnvKey);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const overlay = resolveEnvFileOverlay([{ key: kRecoveryEnvKey, value: randomValue(32) }]);
      expect(overlay.has(kRecoveryEnvKey)).toBe(false);
      expect(warn.mock.calls.map((args) => String(args[0])).join("\n")).not.toMatch(/[0-9a-f]{64}/);
      expect(blankDeniedGatewayEnvKeys({ [kRecoveryEnvKey]: randomValue(32) })[kRecoveryEnvKey]).toBe("");
    });
  });
});
