import { describe, expect, it } from "vitest";
import { resolveDoctorFocus } from "../../lib/public/js/components/doctor/helpers.js";
import { readHashQueryParam } from "../../lib/public/js/lib/hash-query.js";

const hardeningCard = (overrides = {}) => ({
  id: 7,
  runId: 42,
  status: "open",
  sourceKey: "det:hardening:blocked",
  ...overrides,
});

describe("frontend/doctor focus deep-link", () => {
  it("parses the focus param off the hash route", () => {
    expect(readHashQueryParam("#/doctor?focus=context", "focus")).toBe("context");
    expect(readHashQueryParam("#/doctor", "focus")).toBe("");
    expect(readHashQueryParam("", "focus")).toBe("");
    expect(readHashQueryParam("#/watchdog?incident=9", "incident")).toBe("9");
  });

  it("targets the context section and the fresh open hardening finding", () => {
    const resolved = resolveDoctorFocus({
      focusParam: "context",
      cards: [hardeningCard()],
      latestCompletedRunId: 42,
      meterAvailable: true,
    });
    expect(resolved.scrollTarget).toBe("context-section");
    expect(resolved.highlightCardId).toBe("7");
  });

  it("never highlights a stale, resolved, or non-hardening finding", () => {
    const base = { focusParam: "context", latestCompletedRunId: 42, meterAvailable: true };
    // Stale: finding from an older run than the latest completed one.
    expect(
      resolveDoctorFocus({ ...base, cards: [hardeningCard({ runId: 41 })] })
        .highlightCardId,
    ).toBe("");
    // Resolved: dismissed/fixed findings never outrank live state.
    expect(
      resolveDoctorFocus({ ...base, cards: [hardeningCard({ status: "dismissed" })] })
        .highlightCardId,
    ).toBe("");
    // Non-hardening deterministic cards are not the answer.
    expect(
      resolveDoctorFocus({
        ...base,
        cards: [hardeningCard({ sourceKey: "det:extra-invalid:x" })],
      }).highlightCardId,
    ).toBe("");
    // No completed run at all → nothing to highlight.
    expect(
      resolveDoctorFocus({ ...base, latestCompletedRunId: 0, cards: [hardeningCard()] })
        .highlightCardId,
    ).toBe("");
  });

  it("falls back to the section scroll when the cards are unavailable", () => {
    const resolved = resolveDoctorFocus({
      focusParam: "context",
      cards: [],
      latestCompletedRunId: 42,
      meterAvailable: true,
    });
    expect(resolved.scrollTarget).toBe("context-section");
    expect(resolved.highlightCardId).toBe("");
  });

  it("ignores unknown params and yields null scroll when the section can't render", () => {
    // Allowlist: only focus=context exactly is honored.
    expect(
      resolveDoctorFocus({ focusParam: "evil", cards: [hardeningCard()], meterAvailable: true }),
    ).toEqual({ scrollTarget: null, highlightCardId: "" });
    expect(resolveDoctorFocus({ focusParam: "", meterAvailable: true })).toEqual({
      scrollTarget: null,
      highlightCardId: "",
    });
    expect(
      resolveDoctorFocus({ focusParam: "context", meterAvailable: false })
        .scrollTarget,
    ).toBe(null);
  });
});
