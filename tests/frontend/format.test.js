const loadFormatModule = async () => import("../../lib/public/js/lib/format.js");

class ThrowingDate extends Date {
  getTime() {
    throw new Error("boom");
  }
}

// Expected values are computed through the same Intl presets production uses,
// so assertions stay locale- and timezone-agnostic in CI.
const kDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const kDateTimeWithSeconds = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const kDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const kTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const kTimeWithSeconds = new Intl.DateTimeFormat(undefined, {
  timeStyle: "medium",
});

describe("frontend/format", () => {
  it("formatInteger formats with grouping and defaults to zero", async () => {
    const { formatInteger } = await loadFormatModule();

    expect(formatInteger(1234567)).toBe("1,234,567");
    expect(formatInteger(undefined)).toBe("0");
  });

  it("formatCompactNumber handles small, large, and non-finite values", async () => {
    const { formatCompactNumber } = await loadFormatModule();

    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(-999)).toBe("-999");
    expect(formatCompactNumber(1500)).toBe("1.5K");
    expect(formatCompactNumber(-2500000)).toBe("-2.5M");
    expect(formatCompactNumber(Infinity)).toBe("0");
    expect(formatCompactNumber(undefined)).toBe("0");
  });

  it("formatBytes scales through units with adaptive precision", async () => {
    const { formatBytes } = await loadFormatModule();

    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Infinity)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatBytes(15 * 1024)).toBe("15.0 KB");
    expect(formatBytes(200 * 1024)).toBe("200 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.00 GB");
    expect(formatBytes(2000 * 1024 ** 4)).toBe("2000 TB");
  });

  it("formatUsd formats currency values", async () => {
    const { formatUsd } = await loadFormatModule();

    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0.005)).toBe("$0.005");
    expect(formatUsd(undefined)).toBe("$0.00");
  });

  it("formatLocaleDateTime renders medium date + short time for all value shapes", async () => {
    const { formatLocaleDateTime } = await loadFormatModule();
    const date = new Date(2026, 0, 2, 3, 4, 5);

    expect(formatLocaleDateTime(date)).toBe(kDateTime.format(date));
    expect(formatLocaleDateTime(1700000000, { valueIsUnixSeconds: true })).toBe(
      kDateTime.format(new Date(1700000000 * 1000)),
    );
    expect(formatLocaleDateTime(date.getTime(), { valueIsEpochMs: true })).toBe(
      kDateTime.format(date),
    );
    expect(formatLocaleDateTime("2026-01-02T03:04:05")).toBe(
      kDateTime.format(new Date("2026-01-02T03:04:05")),
    );
  });

  it("formatLocaleDateTime withSeconds keeps seconds for sub-minute event surfaces", async () => {
    const { formatLocaleDateTime } = await loadFormatModule();
    const date = new Date(2026, 0, 2, 3, 4, 5);

    expect(formatLocaleDateTime(date, { withSeconds: true })).toBe(
      kDateTimeWithSeconds.format(date),
    );
  });

  it("formatLocaleDateTime falls back for empty, invalid, and throwing values", async () => {
    const { formatLocaleDateTime } = await loadFormatModule();

    expect(formatLocaleDateTime(null)).toBe("—");
    expect(formatLocaleDateTime("")).toBe("—");
    expect(formatLocaleDateTime("not-a-date")).toBe("—");
    expect(formatLocaleDateTime("not-a-date", { fallback: "n/a" })).toBe("n/a");
    expect(formatLocaleDateTime(new ThrowingDate())).toBe("—");
  });

  it("formatLocaleDate renders date-only", async () => {
    const { formatLocaleDate } = await loadFormatModule();
    const date = new Date(2026, 0, 2, 3, 4, 5);

    expect(formatLocaleDate(date)).toBe(kDate.format(date));
    expect(formatLocaleDate(date.getTime(), { valueIsEpochMs: true })).toBe(
      kDate.format(date),
    );
    expect(formatLocaleDate(null)).toBe("—");
    expect(formatLocaleDate("nope", { fallback: "" })).toBe("");
    expect(formatLocaleDate(new ThrowingDate())).toBe("—");
  });

  it("formatLocaleTime renders time-only with optional seconds", async () => {
    const { formatLocaleTime } = await loadFormatModule();
    const date = new Date(2026, 0, 2, 3, 4, 5);

    expect(formatLocaleTime(date)).toBe(kTime.format(date));
    expect(formatLocaleTime(date, { withSeconds: true })).toBe(
      kTimeWithSeconds.format(date),
    );
    expect(formatLocaleTime(date.getTime(), { valueIsEpochMs: true })).toBe(
      kTime.format(date),
    );
    expect(formatLocaleTime(null)).toBe("—");
    expect(formatLocaleTime("nope", { fallback: null })).toBe(null);
    expect(formatLocaleTime(new ThrowingDate())).toBe("—");
  });

  it("formatLocaleDateTimeWithTodayTime prints time only for today", async () => {
    const { formatLocaleDateTimeWithTodayTime } = await loadFormatModule();
    // Freeze midday so the internal new Date() same-day check can never
    // straddle local midnight between the two evaluations.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29, 12, 0, 0));
    const now = new Date();
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);

    expect(formatLocaleDateTimeWithTodayTime(now)).toBe(kTime.format(now));
    expect(formatLocaleDateTimeWithTodayTime(now, { withSeconds: true })).toBe(
      kTimeWithSeconds.format(now),
    );
    expect(formatLocaleDateTimeWithTodayTime(twoDaysAgo)).toBe(
      kDateTime.format(twoDaysAgo),
    );
    expect(
      formatLocaleDateTimeWithTodayTime(twoDaysAgo, { withSeconds: true }),
    ).toBe(kDateTimeWithSeconds.format(twoDaysAgo));
    expect(formatLocaleDateTimeWithTodayTime(null)).toBe("—");
    expect(formatLocaleDateTimeWithTodayTime("nope", { fallback: "x" })).toBe("x");
    expect(formatLocaleDateTimeWithTodayTime(new ThrowingDate())).toBe("—");
    expect(
      formatLocaleDateTimeWithTodayTime(1700000000, { valueIsUnixSeconds: true }),
    ).toBe(kDateTime.format(new Date(1700000000 * 1000)));
    vi.useRealTimers();
  });

  it("formatLocaleDateTimeWithZone appends the numeric UTC offset", async () => {
    const { formatLocaleDateTimeWithZone } = await loadFormatModule();
    const date = new Date(2026, 0, 2, 3, 4, 5);
    const expected = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "shortOffset",
    }).format(date);

    expect(formatLocaleDateTimeWithZone(date)).toBe(expected);
    expect(formatLocaleDateTimeWithZone(date)).toMatch(/GMT|UTC/);
    expect(formatLocaleDateTimeWithZone(null)).toBe("—");
    expect(formatLocaleDateTimeWithZone("nope", { fallback: "" })).toBe("");
  });

  it("formatLocaleDateTimeRange elides the repeated date and falls back safely", async () => {
    const { formatLocaleDateTimeRange, formatLocaleDateTime } =
      await loadFormatModule();
    const start = new Date(2026, 7, 29, 15, 11);
    const end = new Date(2026, 7, 29, 16, 12);

    expect(formatLocaleDateTimeRange(start, end)).toBe(
      kDateTime.formatRange(start, end),
    );
    // end invalid → two separately formatted endpoints
    expect(formatLocaleDateTimeRange(start, "nope")).toBe(
      `${formatLocaleDateTime(start)} – —`,
    );
    // reversed → two endpoints, never a throw
    expect(formatLocaleDateTimeRange(end, start)).toBe(
      `${formatLocaleDateTime(end)} – ${formatLocaleDateTime(start)}`,
    );
    // both invalid → fallback
    expect(formatLocaleDateTimeRange(null, "nope")).toBe("—");
    expect(formatLocaleDateTimeRange(null, null, { fallback: "n/a" })).toBe("n/a");
    // epoch-ms shape
    expect(
      formatLocaleDateTimeRange(start.getTime(), end.getTime(), {
        valueIsEpochMs: true,
      }),
    ).toBe(kDateTime.formatRange(start, end));
  });

  it("createFormatters with an explicit timeZone proves conversion on the production path", async () => {
    const { createFormatters } = await loadFormatModule();
    // 2026-03-10T02:45:00Z → Mar 9, 6:45 PM in Los Angeles (UTC-8, pre-DST),
    // and 8:30 AM the next morning in Kathmandu (UTC+5:45).
    const instant = new Date(Date.UTC(2026, 2, 10, 2, 45, 0));

    const la = createFormatters("America/Los_Angeles");
    expect(la.dateTime.format(instant)).toBe(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Los_Angeles",
      }).format(instant),
    );
    expect(la.dateTime.resolvedOptions().timeZone).toBe("America/Los_Angeles");

    const ktm = createFormatters("Asia/Kathmandu");
    expect(ktm.time.format(instant)).toBe(
      new Intl.DateTimeFormat(undefined, {
        timeStyle: "short",
        timeZone: "Asia/Kathmandu",
      }).format(instant),
    );
    // Kathmandu's +5:45 half-quarter offset must shift the minutes. ICU may
    // canonicalize to the legacy "Asia/Katmandu" spelling — accept either.
    expect(ktm.time.resolvedOptions().timeZone).toMatch(/^Asia\/Kath?mandu$/);
  });

  it("createFormatters pinned to en-US produces the canonical target strings", async () => {
    const { createFormatters } = await loadFormatModule();
    const instant = new Date(Date.UTC(2026, 2, 10, 19, 45, 2));
    const utc = createFormatters("UTC");
    const enUsDateTime = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    });

    // Locale is browser-default by design; only assert exact strings when the
    // runtime locale is en-US (true in CI, guarded elsewhere).
    if (enUsDateTime.resolvedOptions().locale.startsWith("en-US")) {
      expect(utc.dateTime.format(instant)).toBe("Mar 10, 2026, 7:45 PM");
      expect(utc.timeWithSeconds.format(instant)).toBe("7:45:02 PM");
      expect(utc.date.format(instant)).toBe("Mar 10, 2026");
      expect(utc.hour.format(instant)).toBe("7 PM");
    }
  });

  it("renders distinct offsets across a DST fall-back pair (fold disambiguation)", async () => {
    const { createFormatters } = await loadFormatModule();
    const la = createFormatters("America/Los_Angeles");
    // 2026-11-01: PDT (GMT-7) folds back to PST (GMT-8) at 02:00 local.
    const beforeFold = new Date(Date.UTC(2026, 10, 1, 8, 29, 30)); // 01:29:30 GMT-7
    const afterFold = new Date(Date.UTC(2026, 10, 1, 9, 30, 0)); // 01:30:00 GMT-8
    const first = la.dateTimeWithZone.format(beforeFold);
    const second = la.dateTimeWithZone.format(afterFold);
    expect(first).not.toBe(second);
    expect(first).toMatch(/[-\u2212]0?7/);
    expect(second).toMatch(/[-\u2212]0?8/);
  });

  it("toLocalDayKey and isSameLocalDay use the local calendar", async () => {
    const { toLocalDayKey, isSameLocalDay } = await loadFormatModule();
    const date = new Date(2026, 6, 1, 13, 30);

    expect(toLocalDayKey(date)).toBe("2026-07-01");
    expect(toLocalDayKey(date.getTime())).toBe("2026-07-01");
    expect(isSameLocalDay(date, new Date(2026, 6, 1, 0, 0, 1))).toBe(true);
    expect(isSameLocalDay(date, new Date(2026, 6, 2, 0, 0, 1))).toBe(false);
  });

  it("formatDurationCompactMs formats durations", async () => {
    const { formatDurationCompactMs } = await loadFormatModule();

    expect(formatDurationCompactMs(0)).toBe("0s");
    expect(formatDurationCompactMs(-10)).toBe("0s");
    expect(formatDurationCompactMs(Infinity)).toBe("0s");
    expect(formatDurationCompactMs(500)).toBe("500ms");
    expect(formatDurationCompactMs(5000)).toBe("5s");
    expect(formatDurationCompactMs(59_400)).toBe("59s");
    expect(formatDurationCompactMs(60_000)).toBe("1m 0s");
    expect(formatDurationCompactMs(125_000)).toBe("2m 5s");
  });

  it("formatRelativeTime compact style uses floor thresholds and clamps the future", async () => {
    const { formatRelativeTime } = await loadFormatModule();
    const nowMs = Date.UTC(2026, 7, 29, 12, 0, 0);
    const at = (deltaMs) => new Date(nowMs - deltaMs);

    expect(formatRelativeTime(at(0), { nowMs })).toBe("just now");
    expect(formatRelativeTime(at(4_000), { nowMs })).toBe("just now");
    expect(formatRelativeTime(at(42_000), { nowMs })).toBe("42s ago");
    expect(formatRelativeTime(at(75_000), { nowMs })).toBe("1m ago");
    expect(formatRelativeTime(at(59 * 60_000), { nowMs })).toBe("59m ago");
    expect(formatRelativeTime(at(3 * 3_600_000), { nowMs })).toBe("3h ago");
    expect(formatRelativeTime(at(2 * 86_400_000), { nowMs })).toBe("2d ago");
    // future clamps without allowFuture (clock-skew guard)
    expect(formatRelativeTime(at(-30_000), { nowMs })).toBe("just now");
    expect(formatRelativeTime(null, { nowMs })).toBe("—");
    expect(formatRelativeTime("nope", { nowMs, fallback: "x" })).toBe("x");
  });

  it("formatRelativeTime allowFuture renders bidirectional stamps", async () => {
    const { formatRelativeTime } = await loadFormatModule();
    const nowMs = Date.UTC(2026, 7, 29, 12, 0, 0);
    const at = (deltaMs) => new Date(nowMs - deltaMs);

    expect(formatRelativeTime(at(-30_000), { nowMs, allowFuture: true })).toBe(
      "in 30s",
    );
    expect(formatRelativeTime(at(-5 * 60_000), { nowMs, allowFuture: true })).toBe(
      "in 5m",
    );
    expect(
      formatRelativeTime(at(-3 * 3_600_000), { nowMs, allowFuture: true }),
    ).toBe("in 3h");
    expect(
      formatRelativeTime(at(-2 * 86_400_000), { nowMs, allowFuture: true }),
    ).toBe("in 2d");
    // past values are unaffected by allowFuture
    expect(formatRelativeTime(at(75_000), { nowMs, allowFuture: true })).toBe(
      "1m ago",
    );
  });

  it("formatRelativeTime long style spells out units with pluralization", async () => {
    const { formatRelativeTime } = await loadFormatModule();
    const nowMs = Date.UTC(2026, 7, 29, 12, 0, 0);
    const at = (deltaMs) => new Date(nowMs - deltaMs);

    expect(formatRelativeTime(at(42_000), { nowMs, style: "long" })).toBe(
      "42 seconds ago",
    );
    expect(formatRelativeTime(at(60_000), { nowMs, style: "long" })).toBe(
      "1 minute ago",
    );
    expect(formatRelativeTime(at(5 * 60_000), { nowMs, style: "long" })).toBe(
      "5 minutes ago",
    );
    expect(formatRelativeTime(at(3_600_000), { nowMs, style: "long" })).toBe(
      "1 hour ago",
    );
    expect(formatRelativeTime(at(2 * 86_400_000), { nowMs, style: "long" })).toBe(
      "2 days ago",
    );
    expect(
      formatRelativeTime(at(-2 * 60_000), {
        nowMs,
        style: "long",
        allowFuture: true,
      }),
    ).toBe("in 2 minutes");
  });

  it("formatRelativeTime unit style is direction-less with mo/y tiers", async () => {
    const { formatRelativeTime } = await loadFormatModule();
    const nowMs = Date.UTC(2026, 7, 29, 12, 0, 0);
    const at = (deltaMs) => new Date(nowMs - deltaMs);

    expect(formatRelativeTime(at(42_000), { nowMs, style: "unit" })).toBe("42s");
    expect(formatRelativeTime(at(5 * 60_000), { nowMs, style: "unit" })).toBe("5m");
    expect(formatRelativeTime(at(3 * 3_600_000), { nowMs, style: "unit" })).toBe(
      "3h",
    );
    expect(formatRelativeTime(at(6 * 86_400_000), { nowMs, style: "unit" })).toBe(
      "6d",
    );
    expect(formatRelativeTime(at(65 * 86_400_000), { nowMs, style: "unit" })).toBe(
      "2mo",
    );
    expect(
      formatRelativeTime(at(400 * 86_400_000), { nowMs, style: "unit" }),
    ).toBe("1y");
    // unit ignores direction (used for "last run Xm" style badges)
    expect(formatRelativeTime(at(-5 * 60_000), { nowMs, style: "unit" })).toBe(
      "5m",
    );
  });

  it("formatChartBucketLabel formats day keys per range", async () => {
    const { formatChartBucketLabel } = await loadFormatModule();
    const date = new Date(2026, 6, 1);

    expect(
      formatChartBucketLabel("2026-07-01", { range: "7d", valueType: "day-key" }),
    ).toBe(
      date.toLocaleDateString([], {
        weekday: "short",
        month: "numeric",
        day: "numeric",
      }),
    );
    expect(
      formatChartBucketLabel("2026-07-01", { range: "30d", valueType: "day-key" }),
    ).toBe(date.toLocaleDateString([], { month: "numeric", day: "numeric" }));
    expect(formatChartBucketLabel("not-a-day", { valueType: "day-key" })).toBe(
      "not-a-day",
    );
    expect(formatChartBucketLabel(null, { valueType: "day-key" })).toBe("");
  });

  it("formatChartBucketLabel formats epoch and date values", async () => {
    const { formatChartBucketLabel } = await loadFormatModule();
    const date = new Date(2026, 6, 1, 13, 30);

    expect(formatChartBucketLabel(date.getTime(), { range: "24h" })).toBe(
      date.toLocaleTimeString([], { hour: "numeric" }),
    );
    expect(formatChartBucketLabel(date.getTime())).toBe(
      date.toLocaleDateString([], {
        weekday: "short",
        month: "numeric",
        day: "numeric",
      }),
    );
    expect(formatChartBucketLabel("abc", {})).toBe("abc");
    expect(formatChartBucketLabel(date, { range: "30d", valueType: "date" })).toBe(
      date.toLocaleDateString([], { month: "numeric", day: "numeric" }),
    );
    expect(formatChartBucketLabel("nope", { valueType: "date" })).toBe("nope");
  });
});
