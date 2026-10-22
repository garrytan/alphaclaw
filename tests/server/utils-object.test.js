const { isNonArrayObject } = require("../../lib/server/utils/object");

describe("utils/object isNonArrayObject", () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [Object.create(null), true],
    [new Date(0), true],
    [[], false],
    [null, false],
    [undefined, false],
    [0, false],
    ["object", false],
    [() => {}, false],
  ])("%o → %s", (value, expected) => {
    expect(isNonArrayObject(value)).toBe(expected);
  });
});
