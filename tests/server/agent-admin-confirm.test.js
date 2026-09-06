const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  initAgentAdminDb,
  closeAgentAdminDb,
} = require("../../lib/server/db/agent-admin");
const {
  createConfirmService,
  kTtlMs,
  kMaxPending,
} = require("../../lib/server/agent-admin/confirm-service");

// Not exported by the module; asserted here as a fixed contract (A8).
const kMaxRedeemAttempts = 3;

// A fake request in the shape computeParamsHash reads: method + baseUrl+path +
// query + body + the request-context header.
const makeReq = (overrides = {}) => ({
  method: "DELETE",
  baseUrl: "/api",
  path: "/agents/foo",
  query: {},
  body: null,
  headers: {},
  ...overrides,
});

const kOp = {
  id: "agents.delete",
  title: "Delete agent foo",
  method: "DELETE",
  path: "/api/agents/:id",
};

describe("agent-admin confirm service", () => {
  let rootDir;
  let currentMs; // mutable clock so tests can advance past the TTL
  let deliver;
  let service;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-confirm-"));
    // initAgentAdminDb opens <rootDir>/db/agent-admin.db but never mkdirs the
    // db/ subdir (matching the doctor/watchdog DB init helpers), so create it.
    fs.mkdirSync(path.join(rootDir, "db"), { recursive: true });
    initAgentAdminDb({ rootDir });
    currentMs = 1_700_000_000_000;
    deliver = vi.fn();
    service = createConfirmService({
      now: () => currentMs,
      hasAdminTargets: () => true,
      deliver,
    });
  });

  afterEach(() => {
    closeAgentAdminDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("mints a confirm and returns 428 confirm_required on first contact", () => {
    const outcome = service.gate({ req: makeReq(), op: kOp });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(428);
    expect(outcome.body.code).toBe("confirm_required");
    expect(outcome.confirmId).toBeTruthy();
    expect(outcome.body.confirmId).toBe(outcome.confirmId);
    expect(outcome.body.summary).toBe("Delete agent foo");
    expect(outcome.body.expiresAt).toBeTruthy();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("proceeds when the correct code is supplied", () => {
    const req = makeReq();
    service.gate({ req, op: kOp });
    const code = deliver.mock.calls[0][0].code;

    const outcome = service.gate({ req, op: kOp, confirmCode: code });

    expect(outcome.ok).toBe(true);
    expect(outcome.confirmId).toBeTruthy();
  });

  it("rejects a second redemption of the same code (single-use)", () => {
    const req = makeReq();
    service.gate({ req, op: kOp });
    const code = service.listPending()[0].code;

    expect(service.gate({ req, op: kOp, confirmCode: code }).ok).toBe(true);

    const second = service.gate({ req, op: kOp, confirmCode: code });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(403);
    expect(second.body.code).toBe("confirm_invalid");
  });

  it("exhausts the confirm after kMaxRedeemAttempts wrong codes", () => {
    const req = makeReq();
    service.gate({ req, op: kOp });

    let outcome;
    for (let i = 0; i < kMaxRedeemAttempts; i += 1) {
      outcome = service.gate({ req, op: kOp, confirmCode: "WRNG-CODE" });
    }

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(403);
    expect(outcome.body.code).toBe("confirm_attempts_exhausted");
  });

  it("reports confirm_expired once the TTL has elapsed", () => {
    const req = makeReq();
    service.gate({ req, op: kOp });
    const code = service.listPending()[0].code;

    currentMs += kTtlMs + 1000; // advance past the 10-minute TTL

    const outcome = service.gate({ req, op: kOp, confirmCode: code });
    expect(outcome.ok).toBe(false);
    expect(outcome.body.code).toBe("confirm_expired");
  });

  it("binds a code to its exact params (different body ⇒ confirm_invalid)", () => {
    service.gate({ req: makeReq(), op: kOp });
    const code = service.listPending()[0].code;

    // Same op + path, but a different body hashes to a different paramsHash.
    const outcome = service.gate({
      req: makeReq({ body: { x: 1 } }),
      op: kOp,
      confirmCode: code,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.body.code).toBe("confirm_invalid");
  });

  it("dedups identical op+params into a single pending confirm", () => {
    const first = service.gate({ req: makeReq(), op: kOp });
    const second = service.gate({ req: makeReq(), op: kOp });

    expect(service.listPending()).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(2);
    // Both deliveries carry the same minted code (reuse, not re-mint).
    expect(deliver.mock.calls[0][0].code).toBe(deliver.mock.calls[1][0].code);
    expect(first.confirmId).toBe(second.confirmId);
  });

  it("returns 409 no_admin_targets when no admin channel is configured", () => {
    const svc = createConfirmService({
      now: () => currentMs,
      hasAdminTargets: () => false,
      deliver: vi.fn(),
    });

    const outcome = svc.gate({ req: makeReq(), op: kOp });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(409);
    expect(outcome.body.code).toBe("no_admin_targets");
  });

  it("rejects new confirms once the backlog cap (kMaxPending) is full", () => {
    // Distinct bodies ⇒ distinct paramsHashes ⇒ distinct pending confirms.
    for (let i = 0; i < kMaxPending; i += 1) {
      const outcome = service.gate({ req: makeReq({ body: { n: i } }), op: kOp });
      expect(outcome.status).toBe(428);
    }
    expect(service.pendingCount()).toBe(kMaxPending);

    const overflow = service.gate({
      req: makeReq({ body: { n: kMaxPending } }),
      op: kOp,
    });
    expect(overflow.ok).toBe(false);
    expect(overflow.status).toBe(429);
    expect(overflow.body.code).toBe("confirm_backlog_full");
  });
});

describe("agent-admin confirm service delivery copy (F073)", () => {
  let rootDir;
  let deliver;
  let service;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-confirm-copy-"));
    fs.mkdirSync(path.join(rootDir, "db"), { recursive: true });
    initAgentAdminDb({ rootDir });
    deliver = vi.fn();
    service = createConfirmService({
      now: () => 1_700_000_000_000,
      hasAdminTargets: () => true,
      deliver,
    });
  });

  afterEach(() => {
    closeAgentAdminDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("says a code was sent on first contact, and that the EARLIER code still stands on a dedup repeat", () => {
    const first = service.gate({ req: makeReq(), op: kOp });
    expect(first.status).toBe(428);
    expect(first.body.delivery).toMatch(/^A code was sent to your admin channel/);

    const repeat = service.gate({ req: makeReq(), op: kOp });
    expect(repeat.status).toBe(428);
    expect(repeat.confirmId).toBe(first.confirmId);
    expect(repeat.body.delivery).toMatch(/earlier code is still valid \(not re-sent\)/);
    expect(repeat.body.delivery).not.toMatch(/^A code was sent/);
  });

  it("names the dashboard as the only source when delivery throws on first contact", () => {
    deliver.mockImplementationOnce(() => {
      throw new Error("channel down");
    });
    const first = service.gate({ req: makeReq(), op: kOp });
    expect(first.status).toBe(428);
    expect(first.body.delivery).toMatch(/^The code appears in the dashboard/);
  });
});
