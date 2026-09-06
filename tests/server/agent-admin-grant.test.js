const {
  attachEnforcementGrant,
  readEnforcementGrant,
  computeRequestDigests,
  stableStringify,
} = require("../../lib/server/agent-admin/grant");

const makeReq = (overrides = {}) => ({
  method: "POST",
  baseUrl: "/api",
  path: "/team/invites",
  query: { dryRun: "1" },
  body: { email: "a@example.com", role: "member" },
  ...overrides,
});

const op = { id: "team.invites.create" };

describe("agent-admin enforcement grant (F067 / E8)", () => {
  it("attaches a frozen grant bound to method, path, and query/body digests", () => {
    const req = makeReq();
    const grant = attachEnforcementGrant({ req, op, tier: "write", confirmId: "c-1" });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(grant).toMatchObject({
      opId: "team.invites.create",
      tier: "write",
      method: "POST",
      path: "/api/team/invites",
      confirmId: "c-1",
    });
    expect(grant).toEqual(expect.objectContaining(computeRequestDigests(req)));
    expect(readEnforcementGrant(req)).toBe(grant);
  });

  it("is invisible to enumeration and JSON serialization (no plain property to copy)", () => {
    const req = makeReq();
    attachEnforcementGrant({ req, op, tier: "safe" });
    expect(Object.keys(req)).not.toContain("alphaclawGrant");
    expect(Object.getOwnPropertySymbols(req)).toHaveLength(1);
    expect(JSON.stringify(req)).not.toMatch(/team\.invites\.create/);
  });

  it("a forged plain property is not a grant", () => {
    const req = makeReq();
    const { paramsDigest, bodyDigest } = computeRequestDigests(req);
    req.alphaclawGrant = {
      opId: "team.invites.create",
      method: "POST",
      path: "/api/team/invites",
      paramsDigest,
      bodyDigest,
    };
    expect(readEnforcementGrant(req)).toBeNull();
  });

  it("a grant minted under a look-alike symbol is not a grant", () => {
    const req = makeReq();
    req[Symbol("alphaclaw.enforcementGrant")] = {
      opId: "team.invites.create",
      method: "POST",
      path: "/api/team/invites",
      ...computeRequestDigests(req),
    };
    expect(readEnforcementGrant(req)).toBeNull();
  });

  it("stops matching when the body is rewritten after the grant", () => {
    const req = makeReq();
    attachEnforcementGrant({ req, op, tier: "write" });
    req.body.role = "admin";
    expect(readEnforcementGrant(req)).toBeNull();
  });

  it("stops matching when the query is rewritten after the grant", () => {
    const req = makeReq();
    attachEnforcementGrant({ req, op, tier: "write" });
    req.query = { dryRun: "0" };
    expect(readEnforcementGrant(req)).toBeNull();
  });

  it("stops matching when the method or path differ from the granted request", () => {
    const req = makeReq();
    attachEnforcementGrant({ req, op, tier: "write" });
    expect(readEnforcementGrant({ ...req, method: "DELETE" })).toBeNull();
    expect(readEnforcementGrant({ ...req, path: "/team/members" })).toBeNull();
    expect(readEnforcementGrant({ ...req, baseUrl: "" })).toBeNull();
  });

  it("digests are key-order independent for objects but order-sensitive for arrays", () => {
    expect(stableStringify({ b: 1, a: [1, 2] })).toBe(stableStringify({ a: [1, 2], b: 1 }));
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
    expect(computeRequestDigests({ query: {}, body: undefined })).toEqual(
      computeRequestDigests({ query: {}, body: null }),
    );
  });

  it("cannot be re-attached or overwritten once set", () => {
    const req = makeReq();
    const first = attachEnforcementGrant({ req, op, tier: "write" });
    expect(() => attachEnforcementGrant({ req, op: { id: "other" }, tier: "safe" })).toThrow();
    expect(readEnforcementGrant(req)).toBe(first);
  });

  it("returns null for requests without a grant", () => {
    expect(readEnforcementGrant(makeReq())).toBeNull();
    expect(readEnforcementGrant(null)).toBeNull();
    expect(readEnforcementGrant(undefined)).toBeNull();
  });
});
