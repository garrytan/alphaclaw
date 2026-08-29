import { describe, expect, it } from "vitest";
import {
  GeneralHardeningBadge,
  getHardeningBadgeModel,
} from "../../lib/public/js/components/general/hardening-badge.js";

const statusWithHardening = (state, extra = {}, hardeningExtra = {}) => ({
  releaseChannel: "stable",
  bootstrapContext: {
    hardening: { state, files: [], ...hardeningExtra },
  },
  ...extra,
});

describe("frontend/general hardening badge", () => {
  it("is hidden when the payload lacks hardening (old server)", () => {
    expect(getHardeningBadgeModel(null)).toBe(null);
    expect(getHardeningBadgeModel({})).toBe(null);
    expect(getHardeningBadgeModel({ bootstrapContext: {} })).toBe(null);
    expect(GeneralHardeningBadge({ doctorStatus: null })).toBe(null);
    expect(GeneralHardeningBadge({ doctorStatus: {} })).toBe(null);
  });

  it("maps hardening states to badge tones and labels", () => {
    expect(getHardeningBadgeModel(statusWithHardening("injected"))).toMatchObject({
      tone: "success",
      label: "Hardening: injected",
    });
    expect(getHardeningBadgeModel(statusWithHardening("starved"))).toMatchObject({
      tone: "warning",
      label: "Hardening: partial",
    });
    expect(getHardeningBadgeModel(statusWithHardening("blocked"))).toMatchObject({
      tone: "danger",
      label: "Hardening: blocked",
    });
    expect(getHardeningBadgeModel(statusWithHardening("unknown"))).toMatchObject({
      tone: "neutral",
      label: "Hardening: unknown",
    });
    // Unrecognized states collapse to unknown.
    expect(getHardeningBadgeModel(statusWithHardening("banana"))).toMatchObject({
      tone: "neutral",
      label: "Hardening: unknown",
    });
  });

  it("stays neutral for unknown with a config_unreadable reason, with a specific title", () => {
    // An unreadable openclaw.json (JSON5/env-include flavor) reports unknown,
    // never the danger "blocked" badge — with a title that says why.
    const model = getHardeningBadgeModel(
      statusWithHardening("unknown", {}, { reason: "config_unreadable" }),
    );
    expect(model).toMatchObject({ tone: "neutral", label: "Hardening: unknown" });
    expect(model.title).toContain("cannot parse");
    // Plain unknown keeps the generic title.
    expect(getHardeningBadgeModel(statusWithHardening("unknown")).title).toBe(
      "Prompt hardening state could not be determined.",
    );
  });

  it("shows unverified on the dev channel regardless of state", () => {
    expect(
      getHardeningBadgeModel(
        statusWithHardening("injected", { releaseChannel: "dev" }),
      ),
    ).toMatchObject({ tone: "warning", label: "Hardening: unverified" });
    expect(
      getHardeningBadgeModel(
        statusWithHardening("blocked", { releaseChannel: "dev" }),
      ),
    ).toMatchObject({ tone: "warning", label: "Hardening: unverified" });
  });

  it("renders a vnode when a model exists", () => {
    expect(
      GeneralHardeningBadge({ doctorStatus: statusWithHardening("injected") }),
    ).not.toBe(null);
  });
});
