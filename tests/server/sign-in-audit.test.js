const kModulePath = "../../lib/server/utils/sign-in-audit";
const loadAudit = () => {
  delete require.cache[require.resolve(kModulePath)];
  return require(kModulePath);
};

const fakeRequest = { method: "POST", path: "/api/auth/login" };
const lines = (...spies) => spies.flatMap((spy) => spy.mock.calls.map((args) => String(args[0])));

describe("server/utils/sign-in-audit", () => {
  let clock;
  let warn;
  let log;
  beforeEach(() => {
    clock = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("bounds failure lines per address per minute and summarises the rest", () => {
    const { logSignInAttempt, kSignInAuditLinesPerMinute } = loadAudit();
    const ip = "198.51.100.40";
    for (let i = 0; i < 100; i += 1) {
      logSignInAttempt({ req: fakeRequest, ip, actor: "owner", outcome: i % 2 ? "failed" : "rate_limited", lane: "shared" });
    }
    expect(lines(warn, log)).toHaveLength(kSignInAuditLinesPerMinute);

    clock += 60_000;
    logSignInAttempt({ req: fakeRequest, ip, actor: "owner", outcome: "failed", lane: "shared" });
    const all = lines(warn, log);
    expect(all).toHaveLength(kSignInAuditLinesPerMinute + 2);
    expect(all).toContain(`[auth] sign-in suppressed ip="${ip}" count=${100 - kSignInAuditLinesPerMinute} window=60s`);
    expect(all.at(-1)).toMatch(/^\[auth\] sign-in failed /);
  });

  it("always logs a success, even while failures from that address are suppressed", () => {
    const { logSignInAttempt, kSignInAuditLinesPerMinute } = loadAudit();
    const ip = "198.51.100.41";
    for (let i = 0; i < 20; i += 1) logSignInAttempt({ req: fakeRequest, ip, actor: "owner", outcome: "failed", lane: "shared" });
    logSignInAttempt({ req: fakeRequest, ip, actor: "owner", outcome: "ok", lane: "device" });
    expect(lines(warn)).toHaveLength(kSignInAuditLinesPerMinute);
    expect(lines(log)).toEqual([`[auth] sign-in ok route=POST /api/auth/login ip="${ip}" actor=owner lane=device`]);
  });

  it("writes the summary on a later minute even when the address went quiet", () => {
    const { logSignInAttempt, kSignInAuditLinesPerMinute } = loadAudit();
    for (let i = 0; i < 12; i += 1) logSignInAttempt({ req: fakeRequest, ip: "198.51.100.42", actor: "member", outcome: "failed", lane: "shared" });
    clock += 61_000;
    logSignInAttempt({ req: fakeRequest, ip: "198.51.100.43", actor: "owner", outcome: "ok", lane: "shared" });
    expect(lines(warn)).toContain(`[auth] sign-in suppressed ip="198.51.100.42" count=${12 - kSignInAuditLinesPerMinute} window=60s`);
  });

  it("keeps at most the address cap in memory", () => {
    const { logSignInAttempt, kSignInAuditMaxAddresses, signInAuditTrackedAddresses } = loadAudit();
    for (let i = 0; i < kSignInAuditMaxAddresses + 50; i += 1) {
      logSignInAttempt({ req: fakeRequest, ip: "198.18." + Math.floor(i / 250) + "." + (i % 250), actor: "owner", outcome: "failed", lane: "shared" });
    }
    expect(signInAuditTrackedAddresses()).toBe(kSignInAuditMaxAddresses);
  });
});
