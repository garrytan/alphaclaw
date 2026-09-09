const { withGatewayMemoryDetails } = require("../../lib/server/gateway-memory/resources");

describe("live memory attribution identity and freshness", () => {
  const processSnapshot = () => ({
    status: "fresh", atMs: 100000,
    root: { pid: 2147480, startTicks: "100" },
    worker: { pid: 2147481, startTicks: "101" },
  });
  const run = ({ current = processSnapshot(), previous = processSnapshot(), nowMs = 100001 } = {}) => {
    const trend = { evidence: { process: previous,
      attribution: { state: "attributed", causes: ["possible_heap_retention"] } },
      lastEpisodeSummary: { evidence: { attribution: { state: "attributed", causes: ["child_growth"] } } } };
    const result = withGatewayMemoryDetails({ gatewayMemory: current }, trend, { nowMs });
    expect(result.gatewayMemoryTrend.lastEpisodeSummary.evidence.attribution.causes).toEqual(["child_growth"]);
    return result.gatewayMemory.attribution;
  };

  it("keeps a recent explanation for the exact same root and worker", () => {
    expect(run()).toMatchObject({ state: "attributed", causes: ["possible_heap_retention"] });
  });

  it.each(["root", "worker"])("rejects predecessor attribution when the %s PID is reused", (field) => {
    const current = processSnapshot();
    current[field].startTicks = "999";
    expect(run({ current })).toMatchObject({ state: "unknown", reason: "process_changed", causes: [] });
  });

  it("rejects partial process evidence and a missing worker", () => {
    expect(run({ current: { ...processSnapshot(), status: "partial" } }))
      .toMatchObject({ state: "unknown", reason: "process_unavailable" });
    expect(run({ current: { ...processSnapshot(), worker: null } }))
      .toMatchObject({ state: "unknown", reason: "process_changed" });
  });

  it("rejects stale or future explanations without changing historical evidence", () => {
    expect(run({ nowMs: 190001 })).toMatchObject({ state: "unknown", reason: "stale_process" });
    expect(run({ nowMs: 99999 })).toMatchObject({ state: "unknown", reason: "stale_process" });
  });
});
