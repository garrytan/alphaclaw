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
});
