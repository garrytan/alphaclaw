// The real /readyz body shapes (2026.9.8 and 2026.10.2,
// dist/server-start-*.mjs createReadinessChecker → handleGatewayProbeRequest
// `JSON.stringify(result)`, local-direct callers get the details): there is
// no `status` field — `status` belongs to /startupz (docs/gateway/health.md).
// Transitional phases are a single failing[] entry beside ready:false.
const {
  classifyReadinessResponse,
  probeGatewayReadiness,
  waitForGatewayReadiness,
} = require("../../lib/server/gateway-readiness");

const jsonResponse = (httpStatus, body) => ({
  status: httpStatus,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

describe("classifyReadinessResponse — real 2026.9.8 / 2026.10.2 /readyz shapes", () => {
  it("{ready:false, failing:['startup-sidecars']} (503 while startup sidecars settle) is the transitional `starting` phase, not a component failure", () => {
    expect(
      classifyReadinessResponse({
        httpStatus: 503,
        body: { ready: false, failing: ["startup-sidecars"], uptimeMs: 812 },
      }),
    ).toMatchObject({
      ok: true,
      kind: "not_ready",
      ready: false,
      status: "starting",
      unreadyReason: "starting",
      failing: ["startup-sidecars"],
    });
  });

  it("{ready:false, failing:['gateway-draining']} (503 during drain) is the transitional `draining` phase", () => {
    expect(
      classifyReadinessResponse({
        httpStatus: 503,
        body: { ready: false, failing: ["gateway-draining"], uptimeMs: 99_000 },
      }),
    ).toMatchObject({ kind: "not_ready", status: "draining", unreadyReason: "draining" });
  });

  it("only an exact single phase entry is a phase: a real component, a phase beside a component, or a phase without ready:false stays what it was", () => {
    expect(
      classifyReadinessResponse({ httpStatus: 503, body: { ready: false, failing: ["state-database"], stateDatabase: { reason: "x" } } }),
    ).toMatchObject({ kind: "not_ready", status: null, unreadyReason: "components" });
    expect(
      classifyReadinessResponse({ httpStatus: 503, body: { ready: false, failing: ["agent-database:main"] } }),
    ).toMatchObject({ status: null, unreadyReason: "components" });
    expect(
      classifyReadinessResponse({ httpStatus: 503, body: { ready: false, failing: ["startup-sidecars", "telegram"] } }),
    ).toMatchObject({ status: null, unreadyReason: "components", failing: ["startup-sidecars", "telegram"] });
    expect(
      classifyReadinessResponse({ httpStatus: 200, body: { ready: true, failing: ["gateway-draining"] } }),
    ).toMatchObject({ kind: "ready", status: null, unreadyReason: null });
    // An inherited Object key is not a phase.
    expect(
      classifyReadinessResponse({ httpStatus: 503, body: { ready: false, failing: ["constructor"] } }),
    ).toMatchObject({ status: null, unreadyReason: "components" });
  });

  it("2026.10.2 reports ready while agent database inspection is pending: ready stays ready and the pending count is telemetry", () => {
    const body = {
      ready: true,
      failing: [],
      uptimeMs: 4_000,
      agentDatabases: [
        { agentId: "main", code: "agent-database-inspection-pending" },
        { agentId: "helper", code: "agent-database-inspection-pending" },
        { agentId: "old", code: "agent-database-inspection-failed" },
        null,
      ],
    };
    expect(classifyReadinessResponse({ httpStatus: 200, body })).toMatchObject({
      kind: "ready",
      ready: true,
      unreadyReason: null,
      agentDatabasesPending: 2,
    });
    expect(classifyReadinessResponse({ httpStatus: 200, body: { ready: true, failing: [] } })).toMatchObject({
      agentDatabasesPending: 0,
    });
    expect(
      classifyReadinessResponse({ httpStatus: 200, body: { ready: true, failing: [], agentDatabases: "pending" } }),
    ).toMatchObject({ agentDatabasesPending: 0 });
  });
});

describe("probeGatewayReadiness / waitForGatewayReadiness over the real shapes", () => {
  it("the probe reads a 503 startup-sidecars body as `starting`", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { ready: false, failing: ["startup-sidecars"], uptimeMs: 50 }));
    await expect(probeGatewayReadiness({ url: "http://127.0.0.1:18789/readyz", fetchImpl })).resolves.toMatchObject({
      ok: true,
      kind: "not_ready",
      status: "starting",
      unreadyReason: "starting",
    });
  });

  it("the restart ready wait keeps polling through startup-sidecars and returns on the real ready body", async () => {
    const bodies = [
      [503, { ready: false, failing: ["startup-sidecars"], uptimeMs: 10 }],
      [503, { ready: false, failing: ["startup-sidecars"], uptimeMs: 510 }],
      [200, { ready: true, failing: [], uptimeMs: 1_010 }],
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(...bodies.shift()));
    const observations = [];
    const result = await waitForGatewayReadiness({
      url: "http://127.0.0.1:18789/readyz",
      budgetMs: 60_000,
      fetchImpl,
      sleep: async () => {},
      onObservation: (observation) => observations.push(observation.status),
    });
    expect(result).toMatchObject({ ready: true, aborted: false });
    expect(observations).toEqual(["starting", "starting", null]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
