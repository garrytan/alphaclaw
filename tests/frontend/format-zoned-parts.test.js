import { describe, expect, it } from "vitest";
import {
  isKnownTimeZone,
  readZonedDateParts,
} from "../../lib/public/js/lib/format.js";

// Fix wave F167: the cron calendar evaluates a job's `schedule.tz`, so the
// shared formatter module owns the one Intl.DateTimeFormat field reader.
describe("frontend/lib format readZonedDateParts", () => {
  // 2026-06-15T00:30:00Z: Monday. Tokyo = 09:30 Mon, Los Angeles = 17:30 Sun.
  const instant = Date.UTC(2026, 5, 15, 0, 30, 0);

  it("reads wall-clock fields in the requested IANA zone", () => {
    expect(readZonedDateParts(instant, "Asia/Tokyo")).toEqual({
      year: 2026,
      month: 6,
      dayOfMonth: 15,
      dayOfWeek: 1,
      hour: 9,
      minute: 30,
    });
    expect(readZonedDateParts(new Date(instant), "America/Los_Angeles")).toEqual({
      year: 2026,
      month: 6,
      dayOfMonth: 14,
      dayOfWeek: 0,
      hour: 17,
      minute: 30,
    });
    expect(readZonedDateParts(instant, "UTC").hour).toBe(0);
  });

  it("falls back to the browser-local getters for an empty or unknown zone", () => {
    const local = new Date(instant);
    const expected = {
      year: local.getFullYear(),
      month: local.getMonth() + 1,
      dayOfMonth: local.getDate(),
      dayOfWeek: local.getDay(),
      hour: local.getHours(),
      minute: local.getMinutes(),
    };
    expect(readZonedDateParts(instant, "")).toEqual(expected);
    expect(readZonedDateParts(instant, "Not/AZone")).toEqual(expected);
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
    expect(isKnownTimeZone("Europe/Berlin")).toBe(true);
    expect(isKnownTimeZone("")).toBe(false);
  });

  it("handles DST transitions in the zone, not the browser's", () => {
    // 2026-03-29 in Europe/Berlin: clocks jump 02:00 -> 03:00 (CET -> CEST).
    const beforeJump = Date.UTC(2026, 2, 29, 0, 59, 0); // 01:59 CET
    const afterJump = Date.UTC(2026, 2, 29, 1, 0, 0); // 03:00 CEST
    expect(readZonedDateParts(beforeJump, "Europe/Berlin")).toMatchObject({ hour: 1, minute: 59 });
    expect(readZonedDateParts(afterJump, "Europe/Berlin")).toMatchObject({ hour: 3, minute: 0 });
  });
});
