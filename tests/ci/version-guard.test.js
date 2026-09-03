const path = require("node:path");

// The version guard is an ESM module (.mjs); import it dynamically.
const loadGuard = () =>
  import(
    path.join(__dirname, "..", "..", "scripts", "ci", "assert-version-advances.mjs")
  );

describe("ci/assert-version-advances", () => {
  it("parseCore pads MICRO and rejects garbage", async () => {
    const { parseCore } = await loadGuard();
    expect(parseCore("0.9.60").nums).toEqual([0, 9, 60, 0]);
    expect(parseCore("0.9.60.2").nums).toEqual([0, 9, 60, 2]);
    expect(parseCore("1.2.3-beta.4").pre).toBe("beta.4");
    expect(() => parseCore("not.a.version")).toThrow();
    expect(() => parseCore("1.2")).toThrow();
  });

  it("advances on patch/minor/major/micro bumps", async () => {
    const { versionAdvances } = await loadGuard();
    expect(versionAdvances("0.9.61", "0.9.60")).toBe(true);
    expect(versionAdvances("0.10.0", "0.9.60")).toBe(true);
    expect(versionAdvances("1.0.0", "0.9.60")).toBe(true);
    expect(versionAdvances("0.9.60.1", "0.9.60")).toBe(true);
  });

  it("rejects equal or regressing versions", async () => {
    const { versionAdvances } = await loadGuard();
    expect(versionAdvances("0.9.60", "0.9.60")).toBe(false);
    expect(versionAdvances("0.9.59", "0.9.60")).toBe(false);
    expect(versionAdvances("0.9.60.0", "0.9.60")).toBe(false); // equal (micro pad)
    expect(versionAdvances("0.8.99", "0.9.0")).toBe(false);
  });

  it("orders prereleases below their release, above the prior release", async () => {
    const { versionAdvances } = await loadGuard();
    expect(versionAdvances("0.9.61-beta.1", "0.9.60")).toBe(true); // beta of next > prior
    expect(versionAdvances("0.9.61", "0.9.61-beta.1")).toBe(true); // release > its beta
    expect(versionAdvances("0.9.61-beta.1", "0.9.61")).toBe(false); // beta < release
    expect(versionAdvances("0.9.61-beta.2", "0.9.61-beta.1")).toBe(true); // beta counter up
  });
});
