// Shared IANA time-zone helpers: zone resolution/normalization, day-key
// formatting (moved here from db/usage/shared.js), and DST-safe day-start
// arithmetic used by the cron trends day bucketing.

const kUtcTimeZone = "UTC";
const kDayMs = 24 * 60 * 60 * 1000;
const kQuarterHourMs = 15 * 60 * 1000;
// The forward/backward scans probe in 15-minute steps (every modern zone
// offset is a multiple of 15 minutes) bounded at 3h — midnight DST skips are
// at most 2h in real tzdata.
const kMaxScanSteps = 12;
// ~600 canonical IANA zone ids exist, so real traffic can never approach this
// cap; it is purely an unbounded-growth backstop (e.g. a client cycling
// crafted-but-valid variants must not bloat the maps). On overflow we clear
// the whole cache — the simplest correct behavior, and rebuilding a formatter
// is cheap relative to how rarely this can trigger.
const kFormatterCacheMaxEntries = 1000;
const kDayKeyFormatterCache = new Map();
const kWallClockFormatterCache = new Map();
// Raw-input → canonical-id memo. resolveTimeZone constructs a probe
// Intl.DateTimeFormat (~0.1ms) — far too hot for per-row day-key lookups
// (usage summaries call toTimeZoneDayKey per event row). Keyed by the capped
// raw string so repeat lookups are a Map hit; nulls are cached too so invalid
// zones are also probed once. Same cap/clear backstop as the formatter maps.
const kCanonicalZoneCache = new Map();

// Resolve a client-supplied time zone to its CANONICAL IANA id, or null when
// invalid/empty. Capped before probing: Intl throws on garbage but a multi-KB
// string still costs a parse attempt, and no IANA zone id is anywhere near
// 64 chars.
const resolveTimeZone = (tz) => {
  const raw = String(tz ?? "").slice(0, 64).trim();
  if (!raw) return null;
  if (kCanonicalZoneCache.has(raw)) return kCanonicalZoneCache.get(raw);
  let canonical = null;
  try {
    // Canonicalize via resolvedOptions(): Intl accepts case-insensitive zone
    // ids ("america/new_york"), so caching by the raw string would let case
    // variants create duplicate formatter-cache entries.
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: raw })
      .resolvedOptions().timeZone;
  } catch {
    canonical = null;
  }
  if (kCanonicalZoneCache.size >= kFormatterCacheMaxEntries) {
    kCanonicalZoneCache.clear();
  }
  kCanonicalZoneCache.set(raw, canonical);
  return canonical;
};

// Existing semantics preserved for all usage callers: invalid/empty → "UTC".
const normalizeTimeZone = (tz) => resolveTimeZone(tz) ?? kUtcTimeZone;

const getCachedFormatter = (cache, timeZone, buildFormatter) => {
  // Keyed by canonical zone; invalid zones fall through to the raw Intl
  // constructor so they throw exactly like the pre-move implementation did.
  const canonicalZone = resolveTimeZone(timeZone);
  if (canonicalZone == null) return buildFormatter(timeZone);
  const cached = cache.get(canonicalZone);
  if (cached) return cached;
  if (cache.size >= kFormatterCacheMaxEntries) cache.clear();
  const formatter = buildFormatter(canonicalZone);
  cache.set(canonicalZone, formatter);
  return formatter;
};

const getDayKeyFormatter = (timeZone) =>
  getCachedFormatter(kDayKeyFormatterCache, timeZone, (zone) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }));

const getWallClockFormatter = (timeZone) =>
  getCachedFormatter(kWallClockFormatterCache, timeZone, (zone) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }));

const toTimeZoneDayKey = (timestampMs, timeZone) => {
  const parts = getDayKeyFormatter(timeZone).formatToParts(new Date(timestampMs));
  const year = parts.find((part) => part.type === "year")?.value || "0000";
  const month = parts.find((part) => part.type === "month")?.value || "01";
  const day = parts.find((part) => part.type === "day")?.value || "01";
  return `${year}-${month}-${day}`;
};

const readWallClockParts = (formatter, timestampMs) => {
  const parts = formatter.formatToParts(new Date(timestampMs));
  const read = (type) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
};

const toNumericDayKey = (parts) =>
  parts.year * 10000 + parts.month * 100 + parts.day;

const wallClockMsOfDay = (parts) =>
  ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000;

// Epoch ms of the FIRST EXISTING instant of the calendar day (in `timeZone`)
// that contains `timestampMs`. Skipped-midnight convention: when a DST
// spring-forward removes midnight (e.g. America/Santiago jumps 00:00 → 01:00),
// the day starts at the first instant that exists (01:00).
const getTimeZoneDayStartMs = (timestampMs, timeZone) => {
  const formatter = getWallClockFormatter(timeZone);
  const ms = Math.floor(Number(timestampMs));
  // (1) y/m/d of the input instant in the zone.
  const target = readWallClockParts(formatter, ms);
  const targetKey = toNumericDayKey(target);
  // (2) First-guess offset: the zone's offset at the INPUT instant, derived
  // from its formatted wall clock vs the instant itself. Offsets are whole
  // seconds, so compare at second granularity.
  const wallUtcMs = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  const offsetMs = wallUtcMs - Math.floor(ms / 1000) * 1000;
  let candidate = Date.UTC(target.year, target.month - 1, target.day) - offsetMs;
  let parts = readWallClockParts(formatter, candidate);

  // (3) The guess is exact unless a DST transition sits between the day start
  // and the input instant. Correct a whole-day miss by ±24h once (guarded so
  // a spring-forward day never over-corrects past the target).
  if (toNumericDayKey(parts) > targetKey) {
    candidate -= kDayMs;
    parts = readWallClockParts(formatter, candidate);
  } else if (toNumericDayKey(parts) < targetKey) {
    const bumped = candidate + kDayMs;
    const bumpedParts = readWallClockParts(formatter, bumped);
    if (toNumericDayKey(bumpedParts) <= targetKey) {
      candidate = bumped;
      parts = bumpedParts;
    }
  }

  // Landed inside the target day but after its start (the offset changed
  // between day start and the input — e.g. a fall-back day): back up by the
  // wall-clock remainder, which is exact whenever midnight exists. Bounded
  // loop: each pass strictly decreases the candidate.
  for (
    let pass = 0;
    pass < 3 && toNumericDayKey(parts) === targetKey && wallClockMsOfDay(parts) > 0;
    pass += 1
  ) {
    candidate -= wallClockMsOfDay(parts);
    parts = readWallClockParts(formatter, candidate);
  }

  if (toNumericDayKey(parts) === targetKey && wallClockMsOfDay(parts) === 0) {
    // Fall-back transitions that repeat the midnight hour (e.g. America/Havana
    // ends DST at 01:00 → 00:00) can leave the guess on the SECOND occurrence
    // of 00:00. Walk back while the earlier instant still formats to the
    // target day. (Historic fall-backs that revert the DATE itself, e.g.
    // pre-2019 America/Sao_Paulo, are out of scope for this refinement.)
    for (let step = 0; step < kMaxScanSteps; step += 1) {
      const earlier = candidate - kQuarterHourMs;
      if (toNumericDayKey(readWallClockParts(formatter, earlier)) !== targetKey) {
        break;
      }
      candidate = earlier;
    }
    return candidate;
  }

  // (4) The candidate now sits in the day BEFORE the target: either the offset
  // guess was short of a mid-day transition, or the day's exact midnight does
  // not exist (DST spring-forward at midnight, e.g. America/Santiago). Scan
  // FORWARD in 15-minute steps to the first instant whose formatted date
  // equals the target day.
  for (let step = 1; step <= kMaxScanSteps; step += 1) {
    const probe = candidate + step * kQuarterHourMs;
    if (toNumericDayKey(readWallClockParts(formatter, probe)) === targetKey) {
      return probe;
    }
  }
  // Unreachable for real IANA data (the input instant itself lies in the
  // target day); prefer a slightly-off bucket edge over throwing.
  return candidate;
};

// Invariant: no IANA zone has calendar days longer than 26h (the longest real
// day is 25h on a fall-back), so `dayStartMs + 30h` always lands INSIDE the
// next calendar day — never two days ahead and never back inside the same day —
// making this stepping safe for building consecutive day buckets.
const getNextTimeZoneDayStartMs = (dayStartMs, timeZone) =>
  getTimeZoneDayStartMs(dayStartMs + 30 * 60 * 60 * 1000, timeZone);

// The browser auto-sends this header on every authFetch; routes read it with
// an explicit ?timeZone= override for curl/tests. Shared here so the literal
// and the read expression exist exactly once server-side.
const kClientTimeZoneHeader = "x-client-timezone";
const readClientTimeZone = (req) =>
  String(req.get(kClientTimeZoneHeader) || req.query.timeZone || "").trim();

module.exports = {
  kUtcTimeZone,
  kClientTimeZoneHeader,
  kFormatterCacheMaxEntries,
  kDayKeyFormatterCache,
  readClientTimeZone,
  resolveTimeZone,
  normalizeTimeZone,
  toTimeZoneDayKey,
  getTimeZoneDayStartMs,
  getNextTimeZoneDayStartMs,
};
