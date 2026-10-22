const crypto = require("crypto");
const { timingSafeStringEqual } = require("../../lib/server/utils/timing-safe");

describe("server/utils/timing-safe timingSafeStringEqual", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches only identical non-empty strings", () => {
    expect(timingSafeStringEqual("secret-token", "secret-token")).toBe(true);
    expect(timingSafeStringEqual("secret-token", "secret-tokeN")).toBe(false);
    expect(timingSafeStringEqual("ünïcode-✓", "ünïcode-✓")).toBe(true);
  });

  it("refuses wrong-length values without throwing", () => {
    expect(timingSafeStringEqual("short", "a-much-longer-expected-secret")).toBe(false);
    expect(timingSafeStringEqual("a-much-longer-presented-value", "short")).toBe(false);
    expect(timingSafeStringEqual("secret-token-", "secret-token")).toBe(false);
    expect(timingSafeStringEqual("secret-toke", "secret-token")).toBe(false);
  });

  it("never matches an empty value on either side, including both empty", () => {
    expect(timingSafeStringEqual("", "secret")).toBe(false);
    expect(timingSafeStringEqual("secret", "")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(false);
  });

  it("refuses non-strings instead of coercing them", () => {
    for (const value of [undefined, null, 0, 12345, ["secret"], { toString: () => "secret" }, Buffer.from("secret")]) {
      expect(timingSafeStringEqual(value, "secret"), String(value)).toBe(false);
      expect(timingSafeStringEqual("secret", value), String(value)).toBe(false);
    }
    expect(timingSafeStringEqual(undefined, undefined)).toBe(false);
  });

  it("compares fixed-length sha256 digests, so the expected value's length never reaches timingSafeEqual", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    timingSafeStringEqual("x", "a".repeat(512));
    timingSafeStringEqual("a".repeat(512), "a".repeat(512));
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [left, right] of spy.mock.calls) {
      expect(left).toHaveLength(32);
      expect(right).toHaveLength(32);
    }
  });
});
