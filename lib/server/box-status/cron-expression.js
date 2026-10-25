// A small cron expression reader for the box status (ALPH-40): the next time
// a crontab line fires, in the container's local time like cron itself.
// Five fields (minute hour day-of-month month day-of-week) with *, lists,
// ranges, steps and month/day names, plus the @hourly-style macros. When
// both day fields are restricted, a day matches either one (Vixie cron).
// Anything else (seconds fields, L, W, #, ?) is "unsupported": the line is
// still listed, without a next run.
const kMacros = Object.freeze({
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
});
const kMonthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const kDayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const kFields = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: kMonthNames, nameBase: 1 },
  { min: 0, max: 7, names: kDayNames, nameBase: 0 },
];
const kMaxDaysAhead = 366 * 5;

const parseValue = (text, field) => {
  const lower = text.toLowerCase();
  if (field.names) {
    const index = field.names.indexOf(lower);
    if (index >= 0) return index + field.nameBase;
  }
  if (!/^\d{1,2}$/.test(text)) return null;
  const value = Number(text);
  return value >= field.min && value <= field.max ? value : null;
};

const parseField = (text, field) => {
  const values = new Set();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) return null;
    const step = stepText === undefined ? 1 : /^\d{1,2}$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) return null;
    let low;
    let high;
    if (range === "*") {
      low = field.min;
      high = field.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined) return null;
      low = parseValue(a, field);
      high = parseValue(b, field);
      if (low === null || high === null || low > high) return null;
    } else {
      low = parseValue(range, field);
      if (low === null) return null;
      high = stepText === undefined ? low : field.max;
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
};

// { ok: true, fields, restrictedDom, restrictedDow } | { ok: false, reboot? }
const parseCronExpression = (expression) => {
  const text = String(expression || "").trim();
  if (text.toLowerCase() === "@reboot") return { ok: false, reboot: true };
  const expanded = kMacros[text.toLowerCase()] || text;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) return { ok: false };
  const fields = parts.map((part, index) => parseField(part, kFields[index]));
  if (fields.some((field) => !field || field.size === 0)) return { ok: false };
  if (fields[4].has(7)) fields[4].add(0);
  return { ok: true, fields, restrictedDom: parts[2] !== "*", restrictedDow: parts[4] !== "*" };
};

// The first matching minute strictly after fromMs, in local time, or null.
const nextCronRunMs = (parsed, fromMs) => {
  if (!parsed?.ok) return null;
  const [minutes, hours, doms, months, dows] = parsed.fields;
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < kMaxDaysAhead; i += 1, day.setDate(day.getDate() + 1)) {
    if (!months.has(day.getMonth() + 1)) continue;
    const domMatch = doms.has(day.getDate());
    const dowMatch = dows.has(day.getDay());
    const dayMatch = parsed.restrictedDom && parsed.restrictedDow ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatch) continue;
    for (const hour of [...hours].sort((a, b) => a - b)) {
      for (const minute of [...minutes].sort((a, b) => a - b)) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (candidate.getHours() !== hour) continue;
        if (candidate.getTime() >= start.getTime()) return candidate.getTime();
      }
    }
  }
  return null;
};

module.exports = { parseCronExpression, nextCronRunMs };
