import { describe, expect, it } from "vitest";
import { localizeLogTimestamps } from "../../lib/public/js/components/watchdog-tab/helpers.js";

// Computed expectation built from the same plain-Date primitives the helper
// uses (tz-agnostic: correct in whatever zone the test process runs in).
const pad = (value, width = 2) => String(value).padStart(width, "0");
const expectedLocalStamp = (iso) => {
  const date = new Date(iso);
  const offsetMinutes = date.getTimezoneOffset();
  // getTimezoneOffset() is minutes BEHIND UTC, so the printed sign inverts.
  const sign = offsetMinutes > 0 ? "-" : "+";
  const absMinutes = Math.abs(offsetMinutes);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`
  );
};

describe("frontend/watchdog localizeLogTimestamps", () => {
  it("rewrites a leading ISO stamp to local fixed-width form and drops milliseconds", () => {
    const iso = "2026-08-28T10:00:02.114Z";
    const out = localizeLogTimestamps(`${iso} gateway started`);
    expect(out).toBe(`${expectedLocalStamp(iso)} gateway started`);
    // Fixed-width shape including the numeric UTC offset; no ms, no "T"/"Z".
    expect(out).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2} gateway started$/,
    );
    expect(out).not.toContain(".114");
  });

  it("rewrites ms-less stamps but passes naive (designator-less) ones through", () => {
    const noMs = "2026-08-28T10:00:02Z";
    expect(localizeLogTimestamps(`${noMs} line`)).toBe(
      `${expectedLocalStamp(noMs)} line`,
    );
    // A stamp with NO zone designator is ambiguous — rewriting it would
    // assume browser-local and silently mislabel child-process output
    // (red-team finding). It passes through like mid-line ISO strings.
    const noZone = "2026-08-28T10:00:02";
    expect(localizeLogTimestamps(`${noZone} line`)).toBe(`${noZone} line`);
  });

  it("leaves lines without a leading stamp byte-for-byte unchanged (mid-line ISO stays UTC)", () => {
    const midLine = "retrying since 2026-08-28T10:00:02.114Z per backoff";
    expect(localizeLogTimestamps(midLine)).toBe(midLine);
    const plain = "[warn] no stamp on this line";
    expect(localizeLogTimestamps(plain)).toBe(plain);
    const indented = " 2026-08-28T10:00:02Z leading space defeats the anchor";
    expect(localizeLogTimestamps(indented)).toBe(indented);
  });

  it("leaves a shape-matching stamp that parses to NaN unchanged", () => {
    const bogus = "9999-99-99T99:99:99Z gateway started";
    expect(localizeLogTimestamps(bogus)).toBe(bogus);
  });

  it("handles empty and nullish input", () => {
    expect(localizeLogTimestamps("")).toBe("");
    expect(localizeLogTimestamps(null)).toBe("");
    expect(localizeLogTimestamps(undefined)).toBe("");
  });

  it("rewrites only matching lines in multi-line text and preserves the trailing newline", () => {
    const isoA = "2026-08-28T10:00:02.114Z";
    const isoB = "2026-08-28T10:00:05Z";
    const input = [
      `${isoA} first`,
      "  stack frame without a stamp",
      `${isoB} second, body keeps 2026-08-28T10:00:05Z as-is`,
      "",
    ].join("\n");
    expect(localizeLogTimestamps(input)).toBe(
      [
        `${expectedLocalStamp(isoA)} first`,
        "  stack frame without a stamp",
        `${expectedLocalStamp(isoB)} second, body keeps 2026-08-28T10:00:05Z as-is`,
        "",
      ].join("\n"),
    );
  });

  it("rewrites offset-bearing stamps using their real offset (never naive-local)", () => {
    // +02:00 stamp = 10:00:00Z — must render the browser-local time of that
    // INSTANT, never a naive parse of the wall-clock digits.
    const line = "2026-08-29T12:00:00+02:00 [gateway] child says hi";
    const out = localizeLogTimestamps(line);
    const expected = new Date("2026-08-29T12:00:00+02:00");
    expect(out).toContain(`:${String(expected.getMinutes()).padStart(2, "0")}:`);
    expect(out).not.toContain("+02:00 [gateway]");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2} \[gateway\] child says hi$/);
  });

  it("passes naive (designator-less) stamps through unchanged — ambiguous zone", () => {
    const line = "2026-08-29T12:00:00 [tool] naive stamp from a child process";
    expect(localizeLogTimestamps(line)).toBe(line);
  });
});
