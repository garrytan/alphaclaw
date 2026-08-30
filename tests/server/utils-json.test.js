const {
  parseJsonSafe,
  parseJsonObjectFromNoisyOutput,
  parseJsonValueFromNoisyOutput,
} = require("../../lib/server/utils/json");

describe("server/utils/json", () => {
  it("parses JSON safely with fallback", () => {
    expect(parseJsonSafe('{"ok":true}', null)).toEqual({ ok: true });
    expect(parseJsonSafe("not-json", { ok: false })).toEqual({ ok: false });
    expect(parseJsonSafe("", { ok: false })).toEqual({ ok: false });
  });

  it("supports trim option for parseJsonSafe", () => {
    expect(parseJsonSafe(' \n {"count":2} \t ', null, { trim: true })).toEqual({
      count: 2,
    });
  });

  it("extracts JSON object from noisy output", () => {
    expect(
      parseJsonObjectFromNoisyOutput('prefix\n{"ok":true,"count":2}\nsuffix'),
    ).toEqual({
      ok: true,
      count: 2,
    });
    expect(parseJsonObjectFromNoisyOutput("no braces")).toBeNull();
  });

  it("keeps scanning past valid-but-wrong JSON when a validate predicate is given", () => {
    const text = 'warn {} noise {"status":"ok"}\n{"protocol":"target","status":"accepted"}';
    expect(
      parseJsonValueFromNoisyOutput(text, {
        validate: (value) => value?.protocol === "target",
      }),
    ).toEqual({ protocol: "target", status: "accepted" });
    // Without the predicate the first balanced value wins.
    expect(parseJsonValueFromNoisyOutput(text)).toEqual({});
  });

  it("resumes scanning after a balanced-but-unparseable candidate", () => {
    const text = "log { not json } more {\"findings\":[1]}";
    expect(
      parseJsonValueFromNoisyOutput(text, {
        validate: (value) => Array.isArray(value?.findings),
      }),
    ).toEqual({ findings: [1] });
  });

  it("returns null when nothing satisfies the predicate", () => {
    expect(
      parseJsonValueFromNoisyOutput('{"a":1} [2,3] {"b":4}', {
        validate: () => false,
      }),
    ).toBeNull();
  });

  it("bails fast on pathological unmatched-opener input instead of scanning O(n²)", () => {
    // 200KB of "{": every position starts a candidate scan that walks to the
    // end without balancing — unbounded, that is ~2×10^10 steps on the event
    // loop. The work budget must return null well under real-time limits.
    const pathological = "{".repeat(200 * 1024);
    const startedAt = Date.now();
    expect(parseJsonValueFromNoisyOutput(pathological)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("still parses a valid payload at the end of 1MB of prefix noise", () => {
    const payload = { protocol: "target", findings: [{ id: 1 }], blob: "x".repeat(64) };
    const noise = "log line without json\n".repeat(Math.ceil((1024 * 1024) / 22));
    const text = `${noise}${JSON.stringify(payload)}\ntrailing`;
    expect(text.length).toBeGreaterThan(1024 * 1024);
    expect(
      parseJsonValueFromNoisyOutput(text, {
        validate: (value) => value?.protocol === "target",
      }),
    ).toEqual(payload);
  });

  it("survives a few unmatched openers in the noise before the payload", () => {
    // Each unmatched "{" burns a full-length candidate scan; the budget floor
    // must absorb several of them without dropping the real payload.
    const noise = "warn { starting\ninfo [ pending\nwarn { retrying\n".repeat(2);
    const text = `${noise}${"pad ".repeat(2048)}{"findings":[7]}`;
    expect(
      parseJsonValueFromNoisyOutput(text, {
        validate: (value) => Array.isArray(value?.findings),
      }),
    ).toEqual({ findings: [7] });
  });
});
