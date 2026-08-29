const kIntegerFormatter = new Intl.NumberFormat("en-US");
const kCompactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const kUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

// Date/time formatters use the browser's default locale (undefined) and, by
// default, the browser's default time zone — unlike the en-US-pinned number
// formatters above. Tests pass an explicit `timeZone` here to prove the
// conversion math on the exact construction path production uses.
export const createFormatters = (timeZone = undefined) => {
  const tz = timeZone ? { timeZone } : {};
  return {
    dateTime: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...tz,
    }),
    dateTimeWithSeconds: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
      ...tz,
    }),
    date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", ...tz }),
    time: new Intl.DateTimeFormat(undefined, { timeStyle: "short", ...tz }),
    timeWithSeconds: new Intl.DateTimeFormat(undefined, {
      timeStyle: "medium",
      ...tz,
    }),
    hour: new Intl.DateTimeFormat(undefined, { hour: "numeric", ...tz }),
    // timeZoneName cannot be combined with dateStyle/timeStyle, so the
    // zone-bearing variant is built from component options.
    dateTimeWithZone: new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "shortOffset",
      ...tz,
    }),
  };
};

// Locale and time zone are captured once at module load; an OS time-zone
// change mid-session keeps showing the old zone until reload (accepted
// trade-off — the x-client-timezone header in api.js pins the same zone so
// display and server-side bucketing can never diverge mid-session).
const kFormatters = createFormatters();

// Memoized at module load — the same capture point as the formatters above —
// so the x-client-timezone request header always names the zone the display
// formatters actually render in; the two can never diverge mid-session.
const kBrowserTimeZone = (() => {
  try {
    return kFormatters.time.resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
})();

export const getBrowserTimeZone = () => kBrowserTimeZone;

const toDateValue = (
  value,
  { valueIsUnixSeconds = false, valueIsEpochMs = false } = {},
) => {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value;
  if (valueIsUnixSeconds) return new Date(Number(value) * 1000);
  if (valueIsEpochMs) return new Date(Number(value));
  return new Date(value);
};

export const isSameLocalDay = (left, right) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

export const toLocalDayKey = (value) => {
  const dateValue = value instanceof Date ? value : new Date(value ?? Date.now());
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const formatInteger = (value) =>
  kIntegerFormatter.format(Number(value || 0));

export const formatCompactNumber = (value) => {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue)) return "0";
  if (Math.abs(numberValue) < 1000) return formatInteger(numberValue);
  return kCompactNumberFormatter.format(numberValue);
};

export const formatBytes = (value) => {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let nextValue = bytes;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  const precision = nextValue >= 100 || unitIndex === 0 ? 0 : nextValue >= 10 ? 1 : 2;
  return `${nextValue.toFixed(precision)} ${units[unitIndex]}`;
};

export const formatUsd = (value) => kUsdFormatter.format(Number(value || 0));

// Shared guard shell for the absolute-time formatters: coerce → validate →
// format with the picked singleton, falling back on any invalid/throwing
// input. Keeps the five public wrappers one-liners instead of five copies of
// the same try/catch block.
const formatWithGuards = (value, options, pickFormatter) => {
  const {
    fallback = "\u2014",
    valueIsUnixSeconds = false,
    valueIsEpochMs = false,
  } = options || {};
  try {
    const dateValue = toDateValue(value, { valueIsUnixSeconds, valueIsEpochMs });
    if (!dateValue || Number.isNaN(dateValue.getTime())) return fallback;
    return pickFormatter(options || {}, dateValue).format(dateValue);
  } catch {
    return fallback;
  }
};

export const formatLocaleDateTime = (value, options) =>
  formatWithGuards(value, options, ({ withSeconds }) =>
    withSeconds ? kFormatters.dateTimeWithSeconds : kFormatters.dateTime,
  );

export const formatLocaleDate = (value, options) =>
  formatWithGuards(value, options, () => kFormatters.date);

export const formatLocaleTime = (value, options) =>
  formatWithGuards(value, options, ({ withSeconds }) =>
    withSeconds ? kFormatters.timeWithSeconds : kFormatters.time,
  );

export const formatLocaleDateTimeWithTodayTime = (value, options) =>
  formatWithGuards(value, options, ({ withSeconds }, dateValue) =>
    isSameLocalDay(dateValue, new Date())
      ? withSeconds
        ? kFormatters.timeWithSeconds
        : kFormatters.time
      : withSeconds
        ? kFormatters.dateTimeWithSeconds
        : kFormatters.dateTime,
  );

// Absolute time with the numeric UTC offset ("Mar 10, 2026, 7:45:02 PM GMT-7")
// — for precision surfaces (tooltips) where a DST fall-back could otherwise
// render two ambiguous identical local times.
export const formatLocaleDateTimeWithZone = (value, options) =>
  formatWithGuards(value, options, () => kFormatters.dateTimeWithZone);

// Range formatter that elides the repeated date ("Aug 29, 2026, 3:11 – 4:12 PM").
// formatRange throws RangeError on invalid or reversed inputs, so any failure
// falls back to the two separately formatted endpoints (info-preserving,
// never misleadingly start-only); both-invalid returns `fallback`.
export const formatLocaleDateTimeRange = (
  startValue,
  endValue,
  { fallback = "—", valueIsUnixSeconds = false, valueIsEpochMs = false } = {},
) => {
  const opts = { valueIsUnixSeconds, valueIsEpochMs };
  const startDate = toDateValue(startValue, opts);
  const endDate = toDateValue(endValue, opts);
  const startValid = startDate && !Number.isNaN(startDate.getTime());
  const endValid = endDate && !Number.isNaN(endDate.getTime());
  if (!startValid && !endValid) return fallback;
  if (startValid && endValid && startDate.getTime() <= endDate.getTime()) {
    try {
      return kFormatters.dateTime.formatRange(startDate, endDate);
    } catch {
      // fall through to the two-endpoint fallback
    }
  }
  const startLabel = formatLocaleDateTime(startValue, { fallback, ...opts });
  const endLabel = formatLocaleDateTime(endValue, { fallback, ...opts });
  return `${startLabel} – ${endLabel}`;
};

export const formatDurationCompactMs = (value) => {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
};

export const formatDurationLongMs = (ms) => {
  const safeMs = Number(ms || 0);
  if (!Number.isFinite(safeMs) || safeMs <= 0) return "0s";
  const totalSeconds = Math.floor(safeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours % 24}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const kRelativeUnitLabels = {
  s: { compact: "s", long: "second" },
  m: { compact: "m", long: "minute" },
  h: { compact: "h", long: "hour" },
  d: { compact: "d", long: "day" },
};

const renderRelative = (count, unit, { style, isFuture }) => {
  if (style === "long") {
    const noun = `${count} ${kRelativeUnitLabels[unit].long}${count === 1 ? "" : "s"}`;
    return isFuture ? `in ${noun}` : `${noun} ago`;
  }
  const stamp = `${count}${kRelativeUnitLabels[unit].compact}`;
  return isFuture ? `in ${stamp}` : `${stamp} ago`;
};

// One relative-time dialect for the whole UI (thresholds: 60s/60m/24h, floor).
// styles: "compact" ("5m ago"), "long" ("5 minutes ago"), "unit" ("5m", "2mo" —
// direction-less absolute delta, adds ≥30d/≥365d tiers). Future values render
// ("in 5m") ONLY with `allowFuture` — past-only feeds keep the "just now"
// clamp so server clock skew never shows "in 3s" on a past event.
export const formatRelativeTime = (
  value,
  { nowMs = Date.now(), fallback = "—", style = "compact", allowFuture = false } = {},
) => {
  const dateValue = toDateValue(value);
  if (!dateValue || Number.isNaN(dateValue.getTime())) return fallback;
  const deltaMs = nowMs - dateValue.getTime();
  const isFuture = deltaMs < 0;
  const totalSeconds = Math.floor(Math.abs(deltaMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (style === "unit") {
    if (totalSeconds < 60) return `${totalSeconds}s`;
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    if (days < 365) return `${months}mo`;
    return `${Math.floor(days / 365)}y`;
  }
  if (isFuture && !allowFuture) return "just now";
  if (!isFuture && totalSeconds < 5) return "just now";
  if (totalSeconds < 60) {
    return renderRelative(Math.max(1, totalSeconds), "s", { style, isFuture });
  }
  if (minutes < 60) return renderRelative(minutes, "m", { style, isFuture });
  if (hours < 24) return renderRelative(hours, "h", { style, isFuture });
  return renderRelative(days, "d", { style, isFuture });
};

const parseDayKeyToLocalDate = (dayKey = "") => {
  const rawValue = String(dayKey || "").trim();
  const match = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const monthIndex = Number.parseInt(match[2], 10) - 1;
  const dayOfMonth = Number.parseInt(match[3], 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(monthIndex) ||
    !Number.isFinite(dayOfMonth)
  ) {
    return null;
  }
  return new Date(year, monthIndex, dayOfMonth);
};

export const formatChartBucketLabel = (
  value,
  { range = "7d", valueType = "epoch-ms" } = {},
) => {
  let dateValue = null;
  if (valueType === "day-key") {
    dateValue = parseDayKeyToLocalDate(value);
  } else if (valueType === "epoch-ms") {
    const numericValue = Number(value);
    dateValue = Number.isFinite(numericValue) ? new Date(numericValue) : null;
  } else {
    dateValue = toDateValue(value);
  }
  if (!dateValue || Number.isNaN(dateValue.getTime())) return String(value ?? "");
  const normalizedRange = String(range || "").trim().toLowerCase();
  if (normalizedRange === "24h") {
    return dateValue.toLocaleTimeString([], {
      hour: "numeric",
    });
  }
  if (normalizedRange === "7d") {
    return dateValue.toLocaleDateString([], {
      weekday: "short",
      month: "numeric",
      day: "numeric",
    });
  }
  return dateValue.toLocaleDateString([], {
    month: "numeric",
    day: "numeric",
  });
};
