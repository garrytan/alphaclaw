import { describe, expect, it } from "vitest";

const loadCard = () =>
  import("../../lib/public/js/components/watchdog-tab/overseer-card.js");

const kNow = Date.parse("2026-08-29T12:00:00Z");

const reviewed = (id, current, overrides = {}) => ({
  id,
  status: "resolved",
  openedAt: new Date(kNow - 3_600_000).toISOString(),
  overseer: { v: 1, current, history: [] },
  ...overrides,
});

const doneVerdict = (overrides = {}) => ({
  state: "done",
  verdict: "action_needed",
  action: "repair",
  headline: "Repairs exhausted",
  summary: "Two failed repairs.",
  recommendation: "Run Repair manually.",
  at: kNow - 120_000,
  ...overrides,
});

describe("buildWatchdogOverseerModel", () => {
  it("returns null with no reviewed incident", async () => {
    const { buildWatchdogOverseerModel } = await loadCard();
    expect(buildWatchdogOverseerModel([], kNow)).toBe(null);
    expect(
      buildWatchdogOverseerModel([{ id: 1, status: "resolved", overseer: null }], kNow),
    ).toBe(null);
  });

  it("maps verdict states to badges and surfaces the CTA action when current", async () => {
    const { buildWatchdogOverseerModel } = await loadCard();
    const model = buildWatchdogOverseerModel([reviewed(5, doneVerdict())], kNow);
    expect(model.kind).toBe("verdict");
    expect(model.badge).toEqual({ tone: "danger", label: "Action needed" });
    expect(model.action).toBe("repair");
    expect(model.headline).toBe("Repairs exhausted");
    expect(model.reviewedAgo).toBe("2m ago");
  });

  it("gates CTAs: no action when a newer incident exists, one is open, or the verdict is stale", async () => {
    const { buildWatchdogOverseerModel } = await loadCard();
    // Newer unreviewed incident above the reviewed one.
    const notNewest = buildWatchdogOverseerModel(
      [
        { id: 6, status: "resolved", overseer: null },
        reviewed(5, doneVerdict()),
      ],
      kNow,
    );
    expect(notNewest.action).toBe("none");
    // Open incident anywhere kills actions.
    const withOpen = buildWatchdogOverseerModel(
      [reviewed(5, doneVerdict()), { id: 4, status: "open", overseer: null }],
      kNow,
    );
    expect(withOpen.action).toBe("none");
    // Stale review keeps the record but no action.
    const stale = buildWatchdogOverseerModel(
      [reviewed(5, doneVerdict({ state: "stale" }))],
      kNow,
    );
    expect(stale.stale).toBe(true);
    expect(stale.action).toBe("none");
  });

  it("renders pending/unavailable/failed as lines, not verdicts", async () => {
    const { buildWatchdogOverseerModel } = await loadCard();
    expect(
      buildWatchdogOverseerModel(
        [reviewed(5, { state: "pending", at: kNow })],
        kNow,
      ).kind,
    ).toBe("pending");
    expect(
      buildWatchdogOverseerModel(
        [reviewed(5, { state: "unavailable", reason: "cli_flags_unverifiable", summary: "no flags" })],
        kNow,
      ),
    ).toMatchObject({ kind: "unavailable", line: "no flags" });
    expect(
      buildWatchdogOverseerModel(
        [reviewed(5, { state: "failed", summary: "timed out" })],
        kNow,
      ),
    ).toMatchObject({ kind: "failed", line: "timed out" });
  });

  it("treats corrupt overseer blobs as unreviewed", async () => {
    const { buildWatchdogOverseerModel } = await loadCard();
    expect(
      buildWatchdogOverseerModel(
        [{ id: 5, status: "resolved", overseer: { unreadable: true } }],
        kNow,
      ),
    ).toBe(null);
  });
});
