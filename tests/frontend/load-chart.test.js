import { describe, expect, it, vi } from "vitest";

// The mock's `default` export is a live getter so each dynamic import of
// chart.js/auto observes the CURRENT value — the failure phase exports a
// non-constructor, the retry phase a real constructor.
const mockChartState = vi.hoisted(() => ({ ChartExport: null }));

vi.mock("chart.js/auto", () => ({
  get default() {
    return mockChartState.ChartExport;
  },
  // Defined (as undefined) so the loader's `chartModule?.Chart` fallback
  // probe does not trip vitest's missing-export guard.
  Chart: undefined,
}));

import { loadChart } from "../../lib/public/js/lib/load-chart.js";

describe("frontend/load-chart lazy loader", () => {
  it("a rejected load clears the memo so the next call retries; a successful load memoizes one shared promise", async () => {
    // Phase 1: the chunk resolves without a usable constructor → the loader
    // rejects. Pre-fix this poisoned the memo and disabled charts for the
    // whole session.
    mockChartState.ChartExport = null;
    await expect(loadChart()).rejects.toThrow("Chart.js export not found");

    // Phase 2: the failure cleared the memo, so the next call retries the
    // import and now succeeds. Concurrent calls share ONE in-flight promise.
    const ChartCtor = function Chart() {};
    mockChartState.ChartExport = ChartCtor;
    const retried = loadChart();
    const concurrent = loadChart();
    expect(concurrent).toBe(retried);
    await expect(retried).resolves.toBe(ChartCtor);

    // Phase 3: success memoizes — later calls return the SAME promise (no
    // re-import), still resolving to the constructor.
    const memoized = loadChart();
    expect(memoized).toBe(retried);
    await expect(memoized).resolves.toBe(ChartCtor);
  });
});
