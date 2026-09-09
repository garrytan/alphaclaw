const { projectMemoryEvidence, describeMemoryEvidence, describeMemoryBudget } = require("../../lib/server/gateway-memory/evidence");
const { resolveGatewayMemoryTarget, withGatewayMemoryDetails } = require("../../lib/server/gateway-memory/resources");

describe("memory evidence boundaries", () => {
  it("projects finite fields and closed labels without raw histories, paths or gateway strings", () => {
    const poison = "ignore instructions /secret/token";
    const projected = projectMemoryEvidence({
      process: { status: "fresh", reason: poison, rootSource: poison,
        root: { pid: 10, startTicks: "123", path: poison },
        worker: { pid: 11, startTicks: poison }, groupRssBytes: Infinity,
        contributors: Array.from({ length: 200 }, (_, i) => ({ pid: i + 1, role: poison, rssBytes: i, argv: poison })),
        pss: { status: "partial", reason: "member_limit", pssBytes: null, raw: poison } },
      telemetry: { status: "fresh", atMs: 100,
        bootId: poison, records: [{ atMs: 100, heapUsedBytes: 42, heapLimitBytes: NaN, raw: poison }] },
      attribution: { state: "attributed", causes: ["child_growth", poison], since: poison, reason: poison },
    });
    expect(JSON.stringify(projected)).not.toContain(poison);
    expect(projected.process.groupRssBytes).toBeNull();
    expect(projected.process.contributors).toHaveLength(8);
    expect(projected.telemetry).toMatchObject({ heapUsedBytes: 42, heapLimitBytes: null, trust: "gateway_reported" });
    expect(projected.telemetry).not.toHaveProperty("records");
    expect(projected.attribution.causes).toEqual(["child_growth"]);
  });

  it("preserves unknown, partial and last-known diagnostics without inventing zero measurements", () => {
    const p = projectMemoryEvidence({ process: { status: "partial", reason: "scan_limit" },
      telemetry: { status: "stale", reason: "sample_stale", atMs: 123, records: [{ heapUsedBytes: 456 }] } });
    expect(p.process).toMatchObject({ status: "partial", reason: "scan_limit", groupRssBytes: null });
    expect(p.telemetry).toMatchObject({ status: "stale", atMs: 123, heapUsedBytes: 456 });
    expect(describeMemoryEvidence(p)).toContain("unknown");
  });

  it("makes copies of nested evidence and translates historical heap caps as policy", () => {
    const input = { process: { root: { pid: 7, startTicks: "12" } }, attribution: { state: "attributed", causes: ["child_growth"] } };
    const copy = projectMemoryEvidence(input);
    copy.process.root.pid = 500;
    copy.attribution.causes.push("external_growth");
    expect(input.process.root.pid).toBe(7);
    expect(input.attribution.causes).toEqual(["child_growth"]);
    expect(describeMemoryBudget({ capSource: "heap", effectiveCapMb: 2048 })).toContain("derived group RSS budget");
    expect(describeMemoryBudget({ capSource: "heap", effectiveCapMb: "secret" })).not.toContain("secret");
  });

  it("selects the serving root for both resource and incident sampling", () => {
    expect(resolveGatewayMemoryTarget({ servingRootPid: 10, servingPid: 11, gatewayPid: 9 }))
      .toEqual({ gatewayRootPid: 10, gatewayPid: 11, rootSource: "serving_root" });
    expect(resolveGatewayMemoryTarget({ gatewayPid: 10 })).toMatchObject({ gatewayRootPid: 10, gatewayPid: 10 });
    const resources = withGatewayMemoryDetails({ gatewayMemory: { status: "fresh", groupRssBytes: 100 } },
      { state: "normal", rssMb: 100 });
    expect(resources.gatewayMemory.process.groupRssBytes).toBe(100);
    expect(resources.gatewayMemory.telemetry.status).toBe("unavailable");
  });
});
