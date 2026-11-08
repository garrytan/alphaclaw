const { execFileSync, spawnSync } = require("child_process");
const path = require("path");

// ALPH-71 L-5: TRUST_PROXY_HOPS=0 is the right setting for an install with
// nothing in front of it (README), so it must be honored instead of falling
// back to 1, which trusts the client's own X-Forwarded-For.
const kConstantsPath = path.join(__dirname, "..", "..", "lib", "server", "constants.js");

const bootWarnings = (value) => {
  const env = { ...process.env, TRUST_PROXY_HOPS: value };
  const run = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(kConstantsPath)})`], { env, encoding: "utf8" });
  return run.stderr.split("\n").filter((line) => line.includes("TRUST_PROXY_HOPS"));
};

const readHops = (value) => {
  const env = { ...process.env };
  if (value === undefined) delete env.TRUST_PROXY_HOPS;
  else env.TRUST_PROXY_HOPS = value;
  return Number(
    execFileSync(
      process.execPath,
      ["-e", `process.stdout.write(String(require(${JSON.stringify(kConstantsPath)}).kTrustProxyHops))`],
      { env, encoding: "utf8" },
    ),
  );
};

describe("TRUST_PROXY_HOPS", () => {
  it("honors 0 (no proxy in front)", () => {
    expect(readHops("0")).toBe(0);
    expect(readHops(" 0 ")).toBe(0);
  });

  it("keeps the default 1 when unset or junk, and positive counts as given", () => {
    expect(readHops(undefined)).toBe(1);
    expect(readHops("")).toBe(1);
    expect(readHops("abc")).toBe(1);
    expect(readHops("-1")).toBe(1);
    expect(readHops("2")).toBe(2);
  });

  it("a value that is not a whole number gets one boot warning that names the key, never the value", () => {
    for (const value of ["yes-proxied", "-1", "1.5"]) {
      const warnings = bootWarnings(value);
      expect(warnings, value).toHaveLength(1);
      expect(warnings[0]).not.toContain(value);
    }
    expect(bootWarnings("2")).toEqual([]);
    expect(bootWarnings("0")).toEqual([]);
  });
});
