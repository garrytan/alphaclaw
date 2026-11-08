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
  kLoginWindowMs,
} = require("../../lib/server/constants");
const {
  kHashGateQueueLimit,
  kHashGateReservedSlots,
  kHashGateRetryAfterSec,
  kHashGateSlots,
} = require("../../lib/server/utils/hash-gate");
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
const kTrustProxyHopsEnvKey = "TRUST_PROXY_HOPS";
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

const createMembersStore = (list, { checkDelayMs = 0 } = {}) => {
  const tokenKeys = new Map(list.map((m) => [m.id, randomValue(32)]));
  const find = (email) =>
    list.find((m) => m.email === String(email || "").trim().toLowerCase()) || null;
  const toModel = (m) =>
    m ? { id: m.id, email: m.email, displayName: m.email, role: m.role, disabled: false } : null;
  const verifyMemberPassword = vi.fn(({ email, password }) => {
    const member = find(email);
    return member && password === member.password ? toModel(member) : null;
  });
  // Each call that stands for a password hash (a member check, a decoy, an
  // invite accept) is counted while it runs; a test sets checkHook to hold
  // hashes open, or to throw mid-hash.
  const hashes = { started: 0, inFlight: 0, peak: 0 };
  const hashed = async (args, result) => {
    hashes.started += 1;
    hashes.inFlight += 1;
    hashes.peak = Math.max(hashes.peak, hashes.inFlight);
    try {
      if (checkDelayMs) await new Promise((resolve) => setTimeout(resolve, checkDelayMs));
      if (store.checkHook) await store.checkHook(args);
      return result();
    } finally {
      hashes.inFlight -= 1;
    }
  };
  const store = {
    checkHook: null,
    hashes,
    verifyMemberPassword,
    verifyMemberPasswordAsync: (args) => {
      const member = verifyMemberPassword(args);
      return hashed(args, () => member);
    },
    getMemberByEmail: (email) => toModel(find(email)),
    getMember: (id) => toModel(list.find((m) => m.id === id)),
    getTokenSecret: (id) => tokenKeys.get(id) || null,
    rotateTokenSecret: (id) => {
      tokenKeys.set(id, randomValue(32));
      return true;
    },
    acceptInvite: vi.fn((args) => hashed(args, () => ({ ok: false, code: "invite_invalid" }))),
    burnDecoyVerification: vi.fn((password) => hashed({ password }, () => undefined)),
  };
  return store;
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
  checkDelayMs = 0,
} = {}) => {
  Object.assign(process.env, { [kSetupPasswordEnvKey]: setupPassword });
  if (recoveryCode === null) delete process.env[kRecoveryEnvKey];
  else process.env[kRecoveryEnvKey] = recoveryCode;
  delete require.cache[kAuthPath];
  delete require.cache[require.resolve("../../lib/server/utils/sign-in-audit")];
  const { registerAuthRoutes } = require(kAuthPath);
  delete require.cache[require.resolve(kClientIpPath)];
  const { resolveLoginClientIp } = require(kClientIpPath);
  const store = createMemoryLoginThrottleStore();
  const loginThrottle = {
    ...createLoginThrottle({ store }),
    getClientKey:
      keyMode === "express"
        ? getClientKey
        : (req) => resolveLoginClientIp(req),
  };
  const membersStore = createMembersStore(members, { checkDelayMs });
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
  return { server, store, membersStore, loginThrottle };
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

const gateStats = () => require("../../lib/server/utils/hash-gate").hashGate.stats();

const acceptInvite = (h, { peer = kOwnerPeer, ...body } = {}) =>
  request(h.server).post("/api/auth/accept-invite").set("x-test-peer", peer).send(body);

// Collects answers as they arrive; settled() resolves once none arrived for a while.
const tracker = () => {
  const answered = [];
  const sent = [];
  return {
    answered,
    sent,
    send: (pending) => {
      sent.push(pending.then((res) => {
        answered.push(res);
        return res;
      }));
    },
    settled: async () => {
      let seen = -1;
      while (answered.length !== seen) {
        seen = answered.length;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return sent.length - answered.length;
    },
  };
};

const stalledHashes = (h, { except = () => false } = {}) => {
  let release;
  const stall = new Promise((resolve) => {
    release = resolve;
  });
  h.membersStore.checkHook = (args) => (except(args) ? undefined : stall);
  return release;
};

const auditLines = (...spies) =>
  spies
    .flatMap((spy) => spy.mock.calls.map((args) => String(args[0])))
    .filter((line) => line.startsWith("[auth] sign-in"));

describe("sign-in: owner lane past the shared login bucket", { timeout: 30000 }, () => {
  let savedTrustProxyHops;
  beforeAll(() => {
    savedTrustProxyHops = process.env[kTrustProxyHopsEnvKey];
    delete process.env[kTrustProxyHopsEnvKey];
  });
  afterAll(() => {
    if (savedTrustProxyHops !== undefined) process.env[kTrustProxyHopsEnvKey] = savedTrustProxyHops;
  });

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

    it("the recovery code gets a new device past a locked shared bucket", async () => {
      const h = await createHarness();
      const newDevice = "198.51.100.44";
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
      const ok = await signIn(h, { peer, password: kOwnerPassword });
      const pass = readPass(ok);
      await signIn(h, { peer, password: kOwnerPassword, recoveryCode: randomValue(32) });
      for (let i = 0; i < kLoginMaxAttempts - 1; i += 1) await signIn(h, { peer, password: "wrong-" + i });

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

    it("a right, wrong or absent code gets the same answer and the same work on a policy refusal", async () => {
      // Unknown member emails are covered by the known/unknown comparison below.
      const answers = async (h, base) => {
        const out = [];
        for (const recoveryCode of [kRecoveryCode, randomValue(32), undefined]) {
          resetPasswordChecks(h);
          const res = await signIn(h, { ...base, peer: "198.51.100.90", recoveryCode });
          out.push({ status: res.status, body: res.body, checks: passwordChecks(h), decoys: h.membersStore.burnDecoyVerification.mock.calls.length });
          h.membersStore.burnDecoyVerification.mockClear();
        }
        return out;
      };
      const teamOff = await createHarness({ team: false, members: [memberA] });
      const [right, wrong, absent] = await answers(teamOff, credentialsOf(memberA));
      expect(right.status).toBe(403);
      expect(right.body.code).toBe("team_disabled");
      expect(wrong).toEqual(right);
      expect(absent).toEqual(right);

      const legacyOff = await createHarness({ team: true, legacyOff: true, members: [memberA] });
      const legacy = await answers(legacyOff, { password: kOwnerPassword });
      expect(legacy[0].status).toBe(403);
      expect(legacy[0].body.code).toBe("legacy_login_disabled");
      expect(legacy[1]).toEqual(legacy[0]);
      expect(legacy[2]).toEqual(legacy[0]);

    });

    it("a wrong code on a member sign-in costs a decoy password check, like a right code", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      resetPasswordChecks(h);
      await signIn(h, { peer: "198.51.100.91", ...credentialsOf(memberA), recoveryCode: randomValue(32) });
      expect(h.membersStore.verifyMemberPassword).not.toHaveBeenCalled();
      expect(h.membersStore.burnDecoyVerification).toHaveBeenCalledTimes(1);
    });

    it("wrong codes from one address trip that address's block", async () => {
      const h = await createHarness();
      const peer = "198.51.100.92";
      const statuses = [];
      for (let i = 0; i < kLoginMaxAttempts; i += 1) {
        statuses.push((await signIn(h, { peer, password: kOwnerPassword, recoveryCode: randomValue(32) })).status);
      }
      expect(statuses).toEqual([...Array(kLoginMaxAttempts - 1).fill(401), 429]);
      expect((await signIn(h, { peer, password: kOwnerPassword })).status).toBe(429);
      expect(h.store.get("global:login")?.attempts || 0).toBe(0);
    });

    it("a blocked address gets 429 for a right code too, without the code being compared", async () => {
      const h = await createHarness();
      const peer = "198.51.100.93";
      for (let i = 0; i < kLoginMaxAttempts; i += 1) await signIn(h, { peer, password: "wrong-" + i });
      compareSpy.mockClear();
      const right = await signIn(h, { peer, password: kOwnerPassword, recoveryCode: kRecoveryCode });
      const wrong = await signIn(h, { peer, password: kOwnerPassword, recoveryCode: randomValue(32) });
      expect(right.status).toBe(429);
      expect(wrong.status).toBe(429);
      expect(compareSpy.mock.calls.filter(([, expected]) => expected === kRecoveryCode)).toHaveLength(0);
    });

    it("wrong codes from many addresses do not lock the code for a clean address", async () => {
      const h = await createHarness();
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          Promise.all(
            Array.from({ length: kLoginMaxAttempts + 1 }, () =>
              signIn(h, { peer: attackerPeer(i), password: kOwnerPassword, recoveryCode: randomValue(32) }),
            ),
          ),
        ),
      );
      const res = await signIn(h, { peer: "198.51.100.94", password: kOwnerPassword, recoveryCode: kRecoveryCode });
      expect(res.status).toBe(200);
    });

    it("a known and an unknown member email get the same answer and work when a code is sent, with and without the box-wide lock", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      let n = 0;
      const attempt = async (email, extra) => {
        resetPasswordChecks(h);
        h.membersStore.burnDecoyVerification.mockClear();
        n += 1;
        const res = await signIn(h, { peer: "198.51.101." + n, email, ...extra });
        return { status: res.status, body: res.body, checks: passwordChecks(h), decoys: h.membersStore.burnDecoyVerification.mock.calls.length };
      };
      const compare = async () => {
        for (const extra of [
          { password: "wrong", recoveryCode: randomValue(32) },
          { password: "wrong", recoveryCode: kRecoveryCode },
        ]) {
          const known = await attempt(memberA.email, extra);
          const unknown = await attempt("nobody@example.test", extra);
          expect(unknown).toEqual(known);
        }
      };
      await compare();
      await lockShared(h, { email: "nobody@example.test" });
      await compare();
    });

    it("a junk code runs no decoy hash once the box-wide bucket is locked", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      await lockShared(h, { email: "nobody@example.test" });
      h.membersStore.burnDecoyVerification.mockClear();
      resetPasswordChecks(h);
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          signIn(h, { peer: "2001:db8:" + (100 + i).toString(16) + "::1", ...credentialsOf(memberA), recoveryCode: randomValue(32) }),
        ),
      );
      expect(results.every((r) => r.status === 401)).toBe(true);
      expect(h.membersStore.burnDecoyVerification).not.toHaveBeenCalled();
      expect(passwordChecks(h)).toBe(0);
    });

    it("IPv6 addresses in one /64 share a per-address bucket, and the audit line keeps the full address", async () => {
      const warn = vi.spyOn(console, "warn");
      const h = await createHarness();
      for (let i = 0; i < kLoginMaxAttempts - 1; i += 1) {
        await signIn(h, { peer: "2001:db8:aa:bb::" + (i + 1).toString(16), password: "wrong-" + i });
      }
      const sibling = await signIn(h, { peer: "2001:db8:aa:bb:ffff:1:2:3", password: "wrong-last" });
      expect(sibling.status).toBe(429);
      expect((await signIn(h, { peer: "2001:db8:aa:bb::99", password: kOwnerPassword })).status).toBe(429);
      expect((await signIn(h, { peer: "2001:db8:aa:bc::1", password: kOwnerPassword })).status).toBe(200);
      expect(auditLines(warn)).toContain('[auth] sign-in failed route=POST /api/auth/login ip="2001:db8:aa:bb::2" actor=owner lane=shared');
    });

    it("a valid pass takes the pass lane even when a mistyped code is also sent", async () => {
      const h = await createHarness();
      const pass = readPass(await signIn(h, { password: kOwnerPassword }));
      await lockShared(h);
      const res = await signIn(h, { password: kOwnerPassword, pass, recoveryCode: randomValue(32) });
      expect(res.status).toBe(200);
    });

    it("junk codes from 300 IPv6 /64s run at most the box-wide limit of decoy hashes", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      h.membersStore.burnDecoyVerification.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 20)));
      for (let j = 0; j < kLoginMaxAttempts - 1; j += 1) {
        const results = await Promise.all(
          Array.from({ length: 300 }, (_, i) =>
            signIn(h, {
              peer: "2001:db8:" + (0x1000 + i).toString(16) + "::" + (j + 1),
              email: "nobody@example.test",
              password: "guess",
              recoveryCode: randomValue(32),
            }),
          ),
        );
        // A decoy the full hash gate refuses gets the gate's 429, which a right
        // code gets too while the gate is full; never anything that tells codes apart.
        const gateBusy = (r) => r.status === 429 && r.headers["retry-after"] === String(kHashGateRetryAfterSec);
        expect(results.every((r) => r.status === 401 || gateBusy(r))).toBe(true);
      }
      const decoys = h.membersStore.burnDecoyVerification.mock.calls.length;
      expect(decoys).toBeGreaterThan(0);
      expect(decoys).toBeLessThanOrEqual(kLoginGlobalMaxAttempts);
    });

    // Counts the decoy hashes run before the owner's answer instead of timing
    // it: each decoy is real scrypt work, so the count bounds the delay.
    it("an owner sign-in during a junk-code flood is answered after at most the box-wide limit of decoy hashes", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      const pass = readPass(await signIn(h, { password: kOwnerPassword }));
      const decoys = h.membersStore.burnDecoyVerification;
      const flood = Array.from({ length: 1200 }, (_, n) =>
        signIn(h, {
          peer: "2001:db8:" + (0x2000 + (n % 300)).toString(16) + "::" + (Math.floor(n / 300) + 1),
          email: "nobody@example.test",
          password: "guess",
          recoveryCode: randomValue(32),
        }).then((res) => res),
      );
      const owner = await signIn(h, { password: kOwnerPassword, pass });
      const decoysBeforeAnswer = decoys.mock.calls.length;
      await Promise.all(flood);
      expect(owner.status).toBe(200);
      expect(decoysBeforeAnswer).toBeLessThanOrEqual(kLoginGlobalMaxAttempts);
      expect(decoys.mock.calls.length).toBeLessThanOrEqual(kLoginGlobalMaxAttempts);
    });

    it("concurrent member sign-ins whose password check awaits stay within the box-wide, pass and code limits", async () => {
      const h = await createHarness({ team: true, members: [memberA], checkDelayMs: 50 });
      const memberPass = readPass(await signIn(h, { peer: "198.51.100.74", ...credentialsOf(memberA) }));
      const burst = async (count, offset, extra) => {
        resetPasswordChecks(h);
        const results = await Promise.all(
          Array.from({ length: count }, (_, i) =>
            signIn(h, { peer: attackerPeer(offset + i), email: memberA.email, password: "guess-" + i, ...extra }),
          ),
        );
        expect(results.filter((r) => r.status === 200)).toHaveLength(0);
        return passwordChecks(h);
      };
      expect(await burst(200, 0, {})).toBeLessThanOrEqual(kLoginGlobalMaxAttempts);
      expect(await burst(40, 300, { pass: memberPass })).toBeLessThanOrEqual(kLoginMaxAttempts);
      expect(await burst(40, 400, { recoveryCode: kRecoveryCode })).toBeLessThanOrEqual(kLoginMaxAttempts);
    });

    it("five typos on the owner's browser lock its pass, and the right password and code with that pass still sign in", async () => {
      const h = await createHarness();
      const pass = readPass(await signIn(h, { password: kOwnerPassword }));
      const typos = [];
      for (let i = 0; i < kLoginMaxAttempts; i += 1) {
        typos.push((await signIn(h, { password: "typo-" + i, pass })).status);
      }
      expect(typos).toEqual([...Array(kLoginMaxAttempts - 1).fill(401), 429]);
      const res = await signIn(h, { password: kOwnerPassword, recoveryCode: kRecoveryCode, pass });
      expect(res.status).toBe(200);
      expect(readSession(res)).toMatch(/^setup_token=/);
    });

    it("a password check that throws mid-request answers 500, counts as a failure and gives its hash slot back", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      const peer = "198.51.100.110";
      h.membersStore.checkHook = () => {
        throw new Error("store went away");
      };
      const statuses = [(await signIn(h, { peer, email: memberA.email, password: "guess-0" })).status];
      h.membersStore.checkHook = null;
      for (let i = 1; i < kLoginMaxAttempts; i += 1) {
        statuses.push((await signIn(h, { peer, email: memberA.email, password: "guess-" + i })).status);
      }
      expect(statuses).toEqual([500, ...Array(kLoginMaxAttempts - 2).fill(401), 429]);

      h.membersStore.checkHook = () => {
        throw new Error("scrypt failed");
      };
      for (let i = 0; i < 8; i += 1) {
        expect((await signIn(h, { peer: attackerPeer(i), email: memberA.email, password: "throw-" + i })).status).toBe(500);
      }
      expect(gateStats()).toEqual({ running: 0, queued: 0 });
      const release = stalledHashes(h);
      const t = tracker();
      for (let i = 0; i < kHashGateSlots; i += 1) {
        t.send(signIn(h, { peer: attackerPeer(100 + i), email: memberA.email, password: "stall-" + i }));
      }
      await t.settled();
      expect(h.membersStore.hashes.inFlight).toBe(kHashGateSlots - kHashGateReservedSlots);
      release();
      await Promise.all(t.sent);
    });

    it("six invite accepts sent at once from one address: the sixth is refused", async () => {
      const h = await createHarness({ team: true });
      h.membersStore.acceptInvite.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: "invite_invalid" }), 50)),
      );
      const results = await Promise.all(
        Array.from({ length: kLoginMaxAttempts + 1 }, (_, i) =>
          request(h.server)
            .post("/api/auth/accept-invite")
            .set("x-test-peer", "198.51.100.120")
            .send({ token: randomValue(), password: "long-enough-" + i }),
        ),
      );
      expect(results.map((res) => res.status).sort()).toEqual([...Array(kLoginMaxAttempts).fill(400), 429]);
      expect(gateStats()).toEqual({ running: 0, queued: 0 });
    });

    it("a password, code or token that is not a string gets a normal answer, never a 500, and leaves the hash gate idle", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      const odd = { toString: 1 };
      const send = (path, body) => request(h.server).post(path).set("x-test-peer", "198.51.100.121").send(body);
      expect((await send("/api/auth/login", { password: odd })).status).toBe(401);
      expect((await send("/api/auth/login", { email: memberA.email, password: odd })).status).toBe(401);
      expect((await send("/api/auth/login", { email: odd, password: "guess" })).status).toBe(400);
      expect((await send("/api/auth/login", { email: memberA.email, password: odd, recoveryCode: odd })).status).toBe(401);
      expect((await send("/api/auth/accept-invite", { token: odd, password: "long-enough-guess" })).status).toBe(400);
      expect((await send("/api/auth/accept-invite", { token: "t", password: odd })).status).toBe(400);
      expect(gateStats()).toEqual({ running: 0, queued: 0 });
    });

    it("rejects a short or repetitive code at boot with a warning that names only the key", async () => {
      const elevenSymbols = "abcdefghijk";
      const fewSymbols = Array.from({ length: 40 }, (_, i) => elevenSymbols[(i * 7 + Math.floor(i / 3)) % 11]).join("");
      for (const weak of ["ab".repeat(20), randomValue(16).slice(0, 31), "abcdefghijklmnop".repeat(2), fewSymbols]) {
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

  describe("one hash gate for every sign-in hash", () => {
    // Rotating IPv4 and IPv6 /64 clients on every lane: known and unknown
    // member emails, a pass issued to another subject and a tampered pass,
    // the right code with wrong passwords, junk codes, and invite accepts.
    const flood = (h, t, { offset, passB }) => {
      for (let i = 0; i < 30; i += 1) {
        const n = offset + i;
        t.send(signIn(h, { peer: attackerPeer(n), xff: forgedAddress(i), email: i % 2 ? memberA.email : "nobody@example.test", password: "guess-" + n }));
        t.send(signIn(h, { peer: "2001:db8:" + n.toString(16) + "::1", email: "nobody@example.test", password: "guess", recoveryCode: randomValue(32) }));
        t.send(signIn(h, { peer: attackerPeer(n + 2000), email: memberA.email, password: "guess-p" + n, pass: i % 2 ? passB : tamper(passB) }));
        t.send(signIn(h, { peer: "2001:db8:1:" + n.toString(16) + "::1", email: memberA.email, password: "guess-c" + n, recoveryCode: kRecoveryCode }));
        t.send(acceptInvite(h, { peer: attackerPeer(n + 4000), token: randomValue(), password: "long-enough-" + n }));
      }
    };

    const expectRefusedAtOnce = (answered) => {
      for (const res of answered) {
        expect([401, 429]).toContain(res.status);
        if (res.status === 429) expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      }
    };

    it("with hashes stalled past the box-wide window, at most the gate's slots run and its queue waits, overflow gets 429 at once and never runs later", async () => {
      let clock = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const h = await createHarness({ team: true, members: [memberA, memberB] });
      const passB = readPass(await signIn(h, { peer: "198.51.100.75", ...credentialsOf(memberB) }));
      const hashes = h.membersStore.hashes;
      const startedBefore = hashes.started;
      const release = stalledHashes(h);
      const t = tracker();
      try {
        flood(h, t, { offset: 0, passB });
        const waiting = await t.settled();
        expect(hashes.inFlight).toBeLessThanOrEqual(kHashGateSlots);
        expect(waiting - hashes.inFlight).toBeLessThanOrEqual(kHashGateQueueLimit);
        expectRefusedAtOnce(t.answered);
        expect(t.answered.some((res) => res.status === 429 && res.headers["retry-after"] === String(kHashGateRetryAfterSec))).toBe(true);

        clock += kLoginWindowMs + 60 * 1000;
        flood(h, t, { offset: 500, passB });
        const stillWaiting = await t.settled();
        expect(hashes.peak).toBeLessThanOrEqual(kHashGateSlots);
        expect(stillWaiting - hashes.inFlight).toBeLessThanOrEqual(kHashGateQueueLimit);
        expectRefusedAtOnce(t.answered);

        const waitingAtRelease = stillWaiting;
        release();
        await Promise.all(t.sent);
        expect(hashes.started - startedBefore).toBe(waitingAtRelease);
        expect(hashes.peak).toBeLessThanOrEqual(kHashGateSlots);
      } finally {
        release();
        await Promise.all(t.sent);
      }
    });

    it("the owner with a known-browser pass signs in during that flood, through the reserved slot", async () => {
      let clock = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const h = await createHarness({ team: true, members: [memberA, memberB] });
      const passA = readPass(await signIn(h, { peer: "198.51.100.76", ...credentialsOf(memberA) }));
      const passB = readPass(await signIn(h, { peer: "198.51.100.75", ...credentialsOf(memberB) }));
      const ownerPass = readPass(await signIn(h, { password: kOwnerPassword }));
      const release = stalledHashes(h, { except: (args) => args?.password === memberA.password });
      const t = tracker();
      try {
        flood(h, t, { offset: 0, passB });
        await t.settled();
        clock += kLoginWindowMs + 60 * 1000;
        flood(h, t, { offset: 500, passB });
        await t.settled();

        const admin = await signIn(h, { ...credentialsOf(memberA), pass: passA });
        expect(admin.status).toBe(200);
        expect(readSession(admin)).toMatch(/^setup_token=v2\./);
        const owner = await signIn(h, { password: kOwnerPassword, pass: ownerPass });
        expect(owner.status).toBe(200);
        expect(h.membersStore.hashes.peak).toBeLessThanOrEqual(kHashGateSlots);
      } finally {
        release();
        await Promise.all(t.sent);
      }
    });

    it("a pipelined burst from one address gets at most its five checks, across sign-ins, junk codes and invite accepts", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      const release = stalledHashes(h);
      const t = tracker();
      const peer = "198.51.100.131";
      try {
        for (let i = 0; i < 12; i += 1) {
          t.send(signIn(h, { peer, email: memberA.email, password: "burst-" + i }));
          t.send(signIn(h, { peer, email: "nobody@example.test", password: "burst", recoveryCode: randomValue(32) }));
          t.send(acceptInvite(h, { peer, token: randomValue(), password: "long-enough-" + i }));
        }
        await t.settled();
      } finally {
        release();
        await Promise.all(t.sent);
      }
      expect(h.membersStore.hashes.started).toBeLessThanOrEqual(kLoginMaxAttempts);
      expect(t.answered.filter((res) => res.status === 429).length).toBeGreaterThanOrEqual(36 - kLoginMaxAttempts);
    });

    it("a sign-in or invite accept whose email is present but not text gets 400 and no check", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      for (const email of [["x"], { address: memberA.email }, 7, true]) {
        const res = await signIn(h, { email, password: kOwnerPassword });
        expect(res.status, JSON.stringify(email)).toBe(400);
        expect(readSession(res)).toBe("");
        const member = await signIn(h, { email, password: memberA.password });
        expect(member.status).toBe(400);
      }
      const invite = await acceptInvite(h, { token: randomValue(), password: "long-enough-guess", email: ["new@example.test"] });
      expect(invite.status).toBe(400);
      expect(h.membersStore.acceptInvite).not.toHaveBeenCalled();
      expect(h.membersStore.verifyMemberPassword).not.toHaveBeenCalled();
    });
  });

  describe("a success clears only the lock its own count set", () => {
    it("24 wrong sign-ins and a correct 25th leave the box-wide bucket open, with the 24 still counted", async () => {
      const h = await createHarness();
      for (let i = 0; i < kLoginGlobalMaxAttempts - 1; i += 1) {
        expect((await signIn(h, { peer: attackerPeer(i), password: "wrong-" + i })).status).toBe(401);
      }
      expect((await signIn(h, { peer: attackerPeer(100), password: kOwnerPassword })).status).toBe(200);
      expect((await signIn(h, { peer: attackerPeer(101), password: kOwnerPassword })).status).toBe(200);
      expect((await signIn(h, { peer: attackerPeer(102), password: "wrong-last" })).status).toBe(429);
    });

    it("25 wrong sign-ins lock the box-wide bucket, and a correct pass-lane sign-in leaves that lock for the next shared-lane attempt", async () => {
      const h = await createHarness();
      const pass = readPass(await signIn(h, { password: kOwnerPassword }));
      for (let i = 0; i < kLoginGlobalMaxAttempts; i += 1) await signIn(h, { peer: attackerPeer(i), password: "wrong-" + i });
      expect((await signIn(h, { password: kOwnerPassword, pass })).status).toBe(200);
      expect((await signIn(h, { peer: attackerPeer(200), password: kOwnerPassword })).status).toBe(429);
    });

    it("a correct sign-in still in its check does not lift the address lock that later wrong attempts from that address set", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      const peer = "198.51.100.140";
      const release = stalledHashes(h, { except: (args) => args?.password !== memberA.password });
      const t = tracker();
      try {
        t.send(signIn(h, { peer, ...credentialsOf(memberA) }));
        await vi.waitFor(() => expect(h.membersStore.hashes.inFlight).toBe(1));
        const wrong = [];
        for (let i = 0; i < kLoginMaxAttempts; i += 1) {
          wrong.push((await signIn(h, { peer, email: memberA.email, password: "wrong-" + i })).status);
        }
        expect(wrong).toEqual([...Array(kLoginMaxAttempts - 2).fill(401), 429, 429]);
      } finally {
        release();
        await Promise.all(t.sent);
      }
      expect(t.answered[0].status).toBe(200);
      expect((await signIn(h, { peer, ...credentialsOf(memberA) })).status).toBe(429);
    });
  });

  describe("a recovery-code success takes back only its own count", () => {
    it("a member who knows the code cannot keep guessing an admin's password by signing in to their own account in between", async () => {
      const h = await createHarness({ team: true, members: [memberA, memberB] });
      const statuses = [];
      let peer = 0;
      for (let cycle = 0; cycle < 2; cycle += 1) {
        for (let i = 0; i < kLoginMaxAttempts - 1; i += 1) {
          const res = await signIn(h, { peer: attackerPeer(peer++), email: memberA.email, password: "wrong-" + cycle + "-" + i, recoveryCode: kRecoveryCode });
          statuses.push(res.status);
        }
        const own = await signIn(h, { peer: attackerPeer(peer++), ...credentialsOf(memberB), recoveryCode: kRecoveryCode });
        statuses.push(own.status);
      }
      expect(statuses.slice(0, kLoginMaxAttempts)).toEqual([...Array(kLoginMaxAttempts - 1).fill(401), 200]);
      expect(statuses[kLoginMaxAttempts]).toBe(429);
    });

    it("a recovery-code attempt turned away by a full hash gate does not count against the recovery bucket", async () => {
      const h = await createHarness({ team: true, members: [memberA] });
      const release = stalledHashes(h);
      const t = tracker();
      try {
        for (let i = 0; i < kHashGateSlots - kHashGateReservedSlots + kHashGateQueueLimit; i += 1) {
          t.send(signIn(h, { peer: attackerPeer(i), email: memberA.email, password: "wrong-" + i }));
        }
        await vi.waitFor(() => expect(gateStats().queued).toBe(kHashGateQueueLimit));
        for (let i = 0; i < kLoginMaxAttempts; i += 1) {
          const res = await signIn(h, { peer: attackerPeer(100 + i), ...credentialsOf(memberA), recoveryCode: kRecoveryCode });
          expect(res.status).toBe(429);
        }
      } finally {
        release();
        await Promise.all(t.sent);
      }
      const res = await signIn(h, { peer: attackerPeer(200), ...credentialsOf(memberA), recoveryCode: kRecoveryCode });
      expect(res.status).toBe(200);
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
