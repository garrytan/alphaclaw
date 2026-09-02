import { describe, expect, it } from "vitest";
import { buildIncidentReviewAction } from "../../lib/public/js/components/watchdog-tab/incidents/index.js";

const settled = (overrides = {}) => ({
  id: 5,
  status: "resolved",
  openedAt: "2026-08-29T11:00:00.000Z",
  resolvedAt: "2026-08-29T11:10:00.000Z",
  eventCount: 4,
  summary: {},
  ...overrides,
});

const available = { available: true, reason: null, message: "ok" };

describe("buildIncidentReviewAction (\"Review this incident\" row action, DD15)", () => {
  it("is disabled while the server mutex is held by another review, but not by its own", () => {
    const nowMs = Date.parse("2026-08-29T12:00:00Z");
    const other = buildIncidentReviewAction({
      incident: settled(),
      overseerEnabled: true,
      availability: available,
      situation: { inFlight: { kind: "automatic", incidentId: 9, startedAt: nowMs - 1000 }, nextManualAt: 0 },
      nowMs,
    });
    expect(other).toMatchObject({ disabled: true, loading: false, title: "A review is already running" });
    // Our own click for THIS incident renders as loading, never as "busy".
    const own = buildIncidentReviewAction({
      incident: settled(),
      overseerEnabled: true,
      availability: available,
      reviewInFlight: 5,
      situation: { inFlight: { kind: "incident", incidentId: 5, startedAt: nowMs - 1000 }, nextManualAt: 0 },
      nowMs,
    });
    expect(own).toMatchObject({ loading: true });
    expect(own.title).toBe("");
  });

  it("honors the shared manual rate limit with a countdown title", () => {
    const nowMs = Date.parse("2026-08-29T12:00:00Z");
    const limited = buildIncidentReviewAction({
      incident: settled(),
      overseerEnabled: true,
      availability: available,
      situation: { inFlight: null, nextManualAt: nowMs + 72_000 },
      nowMs,
    });
    expect(limited.disabled).toBe(true);
    expect(limited.title).toBe("Available in 1m 12s");
    const expired = buildIncidentReviewAction({
      incident: settled(),
      overseerEnabled: true,
      availability: available,
      situation: { inFlight: null, nextManualAt: nowMs - 1 },
      nowMs,
    });
    expect(expired.disabled).toBe(false);
    expect(expired.title).toBe("");
  });

  it("is hidden when the overseer is off, the row is open, or the record is unreadable", () => {
    expect(
      buildIncidentReviewAction({ incident: settled(), overseerEnabled: false, availability: available }),
    ).toBe(null);
    expect(
      buildIncidentReviewAction({
        incident: settled({ status: "open", resolvedAt: null }),
        overseerEnabled: true,
        availability: available,
      }),
    ).toBe(null);
    expect(
      buildIncidentReviewAction({
        incident: settled({ summary: { unreadable: true } }),
        overseerEnabled: true,
        availability: available,
      }),
    ).toBe(null);
    expect(buildIncidentReviewAction({ incident: null, overseerEnabled: true })).toBe(null);
  });

  it("is interactive on settled rows when claude is available and nothing is running", () => {
    expect(
      buildIncidentReviewAction({ incident: settled(), overseerEnabled: true, availability: available }),
    ).toEqual({ loading: false, disabled: false, title: "", error: null });
    // Abandoned rows are settled too.
    expect(
      buildIncidentReviewAction({
        incident: settled({ status: "abandoned" }),
        overseerEnabled: true,
        availability: available,
      }).disabled,
    ).toBe(false);
  });

  it("is disabled with a reason while claude is unavailable or still probing", () => {
    for (const availability of [null, { available: false }, { available: null }]) {
      expect(
        buildIncidentReviewAction({ incident: settled(), overseerEnabled: true, availability }),
      ).toMatchObject({ disabled: true, title: "Waiting for claude availability" });
    }
  });

  it("one shared reviewInFlight: this row loads, other rows and the situation path disable it", () => {
    expect(
      buildIncidentReviewAction({
        incident: settled(),
        overseerEnabled: true,
        availability: available,
        reviewInFlight: 5,
      }),
    ).toMatchObject({ loading: true, disabled: false });
    expect(
      buildIncidentReviewAction({
        incident: settled(),
        overseerEnabled: true,
        availability: available,
        reviewInFlight: 6,
      }),
    ).toMatchObject({ loading: false, disabled: true, title: "A review is already running" });
    expect(
      buildIncidentReviewAction({
        incident: settled(),
        overseerEnabled: true,
        availability: available,
        reviewInFlight: "situation",
      }),
    ).toMatchObject({ loading: false, disabled: true, title: "A review is already running" });
  });

  it("threads only this row's error", () => {
    const error = { incidentId: 5, error: new Error("No incident with that id."), message: "No incident with that id." };
    expect(
      buildIncidentReviewAction({
        incident: settled(),
        overseerEnabled: true,
        availability: available,
        incidentReviewError: error,
      }).error,
    ).toBe(error);
    expect(
      buildIncidentReviewAction({
        incident: settled({ id: 6 }),
        overseerEnabled: true,
        availability: available,
        incidentReviewError: error,
      }).error,
    ).toBe(null);
  });
});
