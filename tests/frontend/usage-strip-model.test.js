import { describe, expect, it } from "vitest";
import {
  buildPeriodSummary,
  buildUsageStripCells,
  findMostUsedModel,
  hasUsage,
  windowStartDayKey,
} from "../../lib/public/js/components/usage-tab/strip-model.js";

const kNow = new Date(2026, 10, 7, 12, 0, 0).getTime();

describe("frontend/usage strip model", () => {
  it("counts calendar days across a DST change", () => {
    expect(windowStartDayKey(1, kNow)).toBe("2026-11-07");
    expect(windowStartDayKey(7, kNow)).toBe("2026-11-01");
    expect(windowStartDayKey(30, kNow)).toBe("2026-10-09");
  });

  it("sums today, 7 and 30 day spend from the daily rows", () => {
    const totals = buildPeriodSummary(
      [
        { date: "2026-11-07", totalTokens: 10, totalCost: 1 },
        { date: "2026-11-02", totalTokens: 20, totalCost: 2 },
        { date: "2026-10-20", totalTokens: 40, totalCost: 4 },
        { date: "2026-09-01", totalTokens: 80, totalCost: 8 },
      ],
      kNow,
    );
    expect(totals.today).toEqual({ tokens: 10, cost: 1 });
    expect(totals.week).toEqual({ tokens: 30, cost: 3 });
    expect(totals.month).toEqual({ tokens: 70, cost: 7 });
  });

  it("finds the model with the most tokens and its share", () => {
    const top = findMostUsedModel([
      { models: [{ model: "a", totalTokens: 30 }, { model: "b", totalTokens: 10 }] },
      { models: [{ model: "b", totalTokens: 40 }] },
    ]);
    expect(top).toEqual({ model: "b", tokens: 50, share: 50 / 80 });
    expect(findMostUsedModel([])).toBe(null);
  });

  it("knows when there is no usage", () => {
    expect(hasUsage({ totals: {} })).toBe(false);
    expect(hasUsage({ totals: { turnCount: 1 } })).toBe(true);
  });

  it("builds Spend, Turns, Tokens and Most used model", () => {
    const cells = buildUsageStripCells({
      summary: {
        totals: { turnCount: 4, totalTokens: 4000, totalCost: 2 },
        daily: [{ date: "2026-11-07", totalTokens: 4000, totalCost: 2, models: [{ model: "m1", totalTokens: 4000 }] }],
      },
      days: 30,
      nowMs: kNow,
    });
    expect(cells.map((cell) => cell.label)).toEqual(["Spend 30d", "Turns", "Tokens", "Most used model"]);
    expect(cells[1].value).toBe("4");
    expect(cells[3]).toMatchObject({ value: "m1", mono: true, detail: "100% of tokens" });
  });

  it("shows a dash and the cause in every cell when the read fails", () => {
    const cells = buildUsageStripCells({
      summary: { totals: { turnCount: 9 } },
      error: new Error("usage down"),
    });
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(cell).toMatchObject({ value: "—", detail: "usage down", error: true });
  });

  it("marks cells loading before the first read", () => {
    for (const cell of buildUsageStripCells({ loading: true })) expect(cell.loading).toBe(true);
  });
});
