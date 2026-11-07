import { describe, expect, it } from "vitest";
import {
  buildDoctorHeadline,
  countRecentFailedRuns,
} from "../../lib/public/js/components/doctor/headline-model.js";

const kNow = Date.parse("2026-11-07T15:00:00Z");
const twoHoursAgo = "2026-11-07T13:00:00Z";

describe("frontend/doctor headline model", () => {
  it("waits for the runs read", () => {
    expect(buildDoctorHeadline({ runs: null })).toBe("Loading…");
  });

  it("says Doctor has not run yet", () => {
    expect(buildDoctorHeadline({ doctorStatus: {}, runs: [], nowMs: kNow })).toBe("Doctor has not run yet.");
  });

  it("reports open findings from the latest completed run", () => {
    const text = buildDoctorHeadline({
      doctorStatus: { lastRunAt: twoHoursAgo },
      runs: [{ status: "completed", statusCounts: { open: 3 } }],
      nowMs: kNow,
    });
    expect(text).toMatch(/^Last run .+ found 3 things to fix\.$/);
  });

  it("uses words for one and two findings", () => {
    const one = buildDoctorHeadline({
      doctorStatus: { lastRunAt: twoHoursAgo },
      runs: [{ status: "completed", statusCounts: { open: 1 } }],
      nowMs: kNow,
    });
    expect(one).toMatch(/found one thing to fix\.$/);
  });

  it("says no findings when the latest run found none", () => {
    const text = buildDoctorHeadline({
      doctorStatus: { lastRunAt: twoHoursAgo },
      runs: [{ status: "completed", statusCounts: { open: 0 } }],
      nowMs: kNow,
    });
    expect(text).toMatch(/^No findings\. Last run .+\.$/);
  });

  it("counts consecutive failed runs, newest first", () => {
    const runs = [{ status: "running" }, { status: "failed" }, { status: "failed" }, { status: "completed" }];
    expect(countRecentFailedRuns(runs)).toBe(2);
    expect(buildDoctorHeadline({ doctorStatus: {}, runs: runs.slice(1), nowMs: kNow })).toBe(
      "Doctor's last two runs failed.",
    );
    expect(buildDoctorHeadline({ doctorStatus: {}, runs: [{ status: "failed" }], nowMs: kNow })).toBe(
      "Doctor's last run failed.",
    );
  });

  it("says Doctor is running while a run is in progress", () => {
    expect(buildDoctorHeadline({ doctorStatus: { runInProgress: true }, runs: [], nowMs: kNow })).toBe(
      "Doctor is running.",
    );
  });
});
