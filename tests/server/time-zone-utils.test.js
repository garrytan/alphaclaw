const {
  resolveTimeZone,
  normalizeTimeZone,
  toTimeZoneDayKey,
  getTimeZoneDayStartMs,
  getNextTimeZoneDayStartMs,
  kDayKeyFormatterCache,
  kFormatterCacheMaxEntries,
} = require("../../lib/server/utils/time-zone");

const kHourMs = 60 * 60 * 1000;

// Raw Intl wall-clock probe (independent of the module under test) used to
// verify tzdata rules before asserting on them, per the plan's "verify with
// Node's ICU inside the test and skip gracefully if the rule differs".
const wallClock = (zone, ms) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}:${read("second")}`;
};

// Zones whose DST spring-forward skips midnight itself (day starts at 01:00).
const kMidnightSkipCandidates = [
  // Chile: DST starts the first Sunday of September at 00:00 → 01:00.
  { zone: "America/Santiago", transitionUtcMs: Date.UTC(2026, 8, 6, 4, 0) },
  // Cuba: DST starts the second Sunday of March at 00:00 → 01:00.
  { zone: "America/Havana", transitionUtcMs: Date.UTC(2026, 2, 8, 5, 0) },
  // Paraguay (historic; DST abolished in 2024): started October at 00:00 → 01:00.
  { zone: "America/Asuncion", transitionUtcMs: Date.UTC(2022, 9, 2, 4, 0) },
];

const findMidnightSkipCandidate = () =>
  kMidnightSkipCandidates.find(({ zone, transitionUtcMs }) => {
    try {
      const atTransition = wallClock(zone, transitionUtcMs);
      const beforeTransition = wallClock(zone, transitionUtcMs - 60 * 1000);
      return (
        atTransition.endsWith("01:00:00") &&
        beforeTransition.endsWith("23:59:00") &&
        atTransition.slice(0, 10) !== beforeTransition.slice(0, 10)
      );
    } catch {
      return false;
    }
  });

describe("server/utils/time-zone resolveTimeZone", () => {
  it("resolves valid zones to a canonical id", () => {
    expect(resolveTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    // ICU may canonicalize to either side of the alias pair depending on
    // version (Asia/Kathmandu ↔ Asia/Katmandu) — accept both, require one.
    expect(resolveTimeZone("Asia/Kathmandu")).toMatch(/^Asia\/Kat(h)?mandu$/);
    expect(resolveTimeZone("UTC")).toBe("UTC");
  });

  it("canonicalizes case variants", () => {
    expect(resolveTimeZone("america/los_angeles")).toBe("America/Los_Angeles");
    expect(resolveTimeZone("AMERICA/LOS_ANGELES")).toBe("America/Los_Angeles");
    expect(resolveTimeZone("utc")).toBe("UTC");
  });

  it("returns null for garbage", () => {
    expect(resolveTimeZone("Not/AZone")).toBeNull();
    expect(resolveTimeZone("<script>alert(1)</script>")).toBeNull();
  });

  it("rejects oversized input fast via the 64-char cap", () => {
    const oversized = "x".repeat(10 * 1024);
    const startedAt = Date.now();
    for (let index = 0; index < 100; index += 1) {
      expect(resolveTimeZone(oversized)).toBeNull();
    }
    // 100 probes of a capped 64-char string: generous bound, guards against
    // accidentally probing the full 10KB payload.
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("returns null for empty and nullish values", () => {
    expect(resolveTimeZone("")).toBeNull();
    expect(resolveTimeZone("   ")).toBeNull();
    expect(resolveTimeZone(null)).toBeNull();
    expect(resolveTimeZone(undefined)).toBeNull();
  });
});

describe("server/utils/time-zone normalizeTimeZone", () => {
  it("preserves the UTC fallback semantics", () => {
    expect(normalizeTimeZone("Not/AZone")).toBe("UTC");
    expect(normalizeTimeZone("")).toBe("UTC");
    expect(normalizeTimeZone("   ")).toBe("UTC");
    expect(normalizeTimeZone(null)).toBe("UTC");
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
  });
});

describe("server/utils/time-zone getTimeZoneDayStartMs", () => {
  it("buckets a boundary instant into the client zone's day, not UTC's", () => {
    // Aug 29, 2026 23:30 PT === Aug 30, 2026 06:30 UTC.
    const boundaryMs = Date.UTC(2026, 7, 30, 6, 30);
    expect(getTimeZoneDayStartMs(boundaryMs, "America/Los_Angeles")).toBe(
      Date.UTC(2026, 7, 29, 7), // Aug 29 00:00 PDT
    );
    expect(getTimeZoneDayStartMs(boundaryMs, "UTC")).toBe(Date.UTC(2026, 7, 30));
    expect(toTimeZoneDayKey(boundaryMs, "America/Los_Angeles")).toBe("2026-08-29");
    expect(toTimeZoneDayKey(boundaryMs, "UTC")).toBe("2026-08-30");
  });

  it("handles the non-hour offset of Asia/Kathmandu (+05:45)", () => {
    // Aug 29 20:00 UTC === Aug 30 01:45 in Kathmandu.
    const instantMs = Date.UTC(2026, 7, 29, 20, 0);
    const dayStartMs = getTimeZoneDayStartMs(instantMs, "Asia/Kathmandu");
    expect(dayStartMs).toBe(Date.UTC(2026, 7, 29, 18, 15)); // Aug 30 00:00 NPT
    expect(getNextTimeZoneDayStartMs(dayStartMs, "Asia/Kathmandu")).toBe(
      Date.UTC(2026, 7, 30, 18, 15),
    );
  });

  it("treats an exact-midnight instant as the start of that same day", () => {
    const laMidnightMs = Date.UTC(2026, 7, 29, 7); // Aug 29 00:00 PDT
    expect(getTimeZoneDayStartMs(laMidnightMs, "America/Los_Angeles")).toBe(
      laMidnightMs,
    );
    const utcMidnightMs = Date.UTC(2026, 7, 29);
    expect(getTimeZoneDayStartMs(utcMidnightMs, "UTC")).toBe(utcMidnightMs);
  });

  it("handles the 23h spring-forward day (America/Los_Angeles 2026-03-08)", () => {
    const zone = "America/Los_Angeles";
    // Noon PDT on the transition day.
    const springDayStartMs = getTimeZoneDayStartMs(Date.UTC(2026, 2, 8, 19, 0), zone);
    expect(springDayStartMs).toBe(Date.UTC(2026, 2, 8, 8)); // 00:00 PST
    // Before the 02:00 skip (01:30 PST) and after it (03:30 PDT) share the day start.
    expect(getTimeZoneDayStartMs(Date.UTC(2026, 2, 8, 9, 30), zone)).toBe(springDayStartMs);
    expect(getTimeZoneDayStartMs(Date.UTC(2026, 2, 8, 10, 30), zone)).toBe(springDayStartMs);
    // Stepping into and out of the 23h day.
    expect(getNextTimeZoneDayStartMs(Date.UTC(2026, 2, 7, 8), zone)).toBe(springDayStartMs);
    expect(getNextTimeZoneDayStartMs(springDayStartMs, zone)).toBe(Date.UTC(2026, 2, 9, 7));
    expect(Date.UTC(2026, 2, 9, 7) - springDayStartMs).toBe(23 * kHourMs);
  });

  it("handles the 25h fall-back day (America/Los_Angeles 2026-11-01)", () => {
    const zone = "America/Los_Angeles";
    // Noon PST on the transition day.
    const fallDayStartMs = getTimeZoneDayStartMs(Date.UTC(2026, 10, 1, 20, 0), zone);
    expect(fallDayStartMs).toBe(Date.UTC(2026, 10, 1, 7)); // 00:00 PDT
    // Both instants of the ambiguous 01:30 wall time land in the same day.
    expect(getTimeZoneDayStartMs(Date.UTC(2026, 10, 1, 8, 30), zone)).toBe(fallDayStartMs); // 01:30 PDT
    expect(getTimeZoneDayStartMs(Date.UTC(2026, 10, 1, 9, 30), zone)).toBe(fallDayStartMs); // 01:30 PST
    // Stepping into and out of the 25h day.
    expect(getNextTimeZoneDayStartMs(Date.UTC(2026, 9, 31, 7), zone)).toBe(fallDayStartMs);
    expect(getNextTimeZoneDayStartMs(fallDayStartMs, zone)).toBe(Date.UTC(2026, 10, 2, 8));
    expect(Date.UTC(2026, 10, 2, 8) - fallDayStartMs).toBe(25 * kHourMs);
  });

  const skipCandidate = findMidnightSkipCandidate();
  (skipCandidate ? it : it.skip)(
    "starts the day at the first existing instant when DST skips midnight",
    () => {
      const { zone, transitionUtcMs } = skipCandidate;
      // Mid-day instant: exercises the 15-minute forward-scan branch (the
      // offset guess lands in the previous day because midnight is missing).
      expect(getTimeZoneDayStartMs(transitionUtcMs + 10 * kHourMs, zone)).toBe(
        transitionUtcMs,
      );
      // Just after the skip.
      expect(getTimeZoneDayStartMs(transitionUtcMs + 30 * 60 * 1000, zone)).toBe(
        transitionUtcMs,
      );
      // The first existing instant is its own day start.
      expect(getTimeZoneDayStartMs(transitionUtcMs, zone)).toBe(transitionUtcMs);
      // Stepping from the previous day's start crosses the skipped midnight.
      const previousDayStartMs = getTimeZoneDayStartMs(
        transitionUtcMs - 12 * kHourMs,
        zone,
      );
      expect(getNextTimeZoneDayStartMs(previousDayStartMs, zone)).toBe(transitionUtcMs);
    },
  );

  // Cuba ends DST at 01:00 → 00:00, so the midnight HOUR repeats; the day
  // start must be the FIRST 00:00 (the CDT one). Verified against tzdata and
  // skipped gracefully if the rule differs.
  const havanaFallBackApplies = (() => {
    try {
      return (
        wallClock("America/Havana", Date.UTC(2026, 10, 1, 4, 0)).endsWith("00:00:00") &&
        wallClock("America/Havana", Date.UTC(2026, 10, 1, 5, 0)).endsWith("00:00:00")
      );
    } catch {
      return false;
    }
  })();
  (havanaFallBackApplies ? it : it.skip)(
    "returns the first occurrence of a repeated midnight (America/Havana fall-back)",
    () => {
      expect(
        getTimeZoneDayStartMs(Date.UTC(2026, 10, 1, 17, 0), "America/Havana"),
      ).toBe(Date.UTC(2026, 10, 1, 4)); // Nov 1 00:00 CDT, not the later 00:00 CST
    },
  );
});

describe("server/utils/time-zone formatter cache", () => {
  it("shares one entry across case variants of the same zone", () => {
    kDayKeyFormatterCache.clear();
    const timestampMs = Date.UTC(2026, 7, 30, 6, 30);
    expect(toTimeZoneDayKey(timestampMs, "America/Los_Angeles")).toBe("2026-08-29");
    expect(toTimeZoneDayKey(timestampMs, "AMERICA/LOS_ANGELES")).toBe("2026-08-29");
    expect(toTimeZoneDayKey(timestampMs, "america/los_angeles")).toBe("2026-08-29");
    expect(kDayKeyFormatterCache.size).toBe(1);
    expect(kDayKeyFormatterCache.has("America/Los_Angeles")).toBe(true);
  });

  it("clears the cache instead of growing past the cap", () => {
    kDayKeyFormatterCache.clear();
    for (let index = 0; index < kFormatterCacheMaxEntries; index += 1) {
      kDayKeyFormatterCache.set(`fake-zone-${index}`, {});
    }
    expect(kDayKeyFormatterCache.size).toBe(kFormatterCacheMaxEntries);
    // Next insert clears the map first, then caches the fresh formatter.
    expect(toTimeZoneDayKey(Date.UTC(2026, 7, 30, 6, 30), "UTC")).toBe("2026-08-30");
    expect(kDayKeyFormatterCache.size).toBe(1);
    expect(kDayKeyFormatterCache.has("UTC")).toBe(true);
    kDayKeyFormatterCache.clear();
  });

  it("still throws for invalid zones exactly like the pre-move implementation", () => {
    expect(() => toTimeZoneDayKey(Date.now(), "Not/AZone")).toThrow(RangeError);
  });
});
