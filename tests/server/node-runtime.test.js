const {
  kAlphaclawNodeEngines,
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  parseNodeVersion,
} = require("../../lib/node-runtime");
const {
  parseEngineRange,
  parseVersionTriple,
  satisfiesEngines,
} = require("../../lib/engines-range");

// The engines requirement OpenClaw 2026.9.3 publishes on npm (verified
// 2026-09-08): Node 22 and 25 are gone, 24 needs 24.16.0+, 26 needs 26.1.0+.
const kOpenclaw2026_9_3Engines = ">=24.16.0 <25 || >=26.1.0";

describe("node-runtime", () => {
  it("parses semantic Node versions", () => {
    expect(parseNodeVersion("22.22.3")).toEqual([22, 22, 3]);
    expect(parseNodeVersion("v24.15.0")).toBeNull();
  });

  it("shares ONE engines string with package.json", () => {
    // The boot floor, the npm engines field and the node:24-slim image move
    // together (v0.9.80). A drift here means `npm install` and boot disagree.
    expect(kAlphaclawNodeEngines).toBe(
      require("../../package.json").engines.node,
    );
    expect(kAlphaclawNodeEngines).toBe(kOpenclaw2026_9_3Engines);
  });

  it("enforces the OpenClaw 2026.9.3 Node floors (24.16+, 26.1+; 22 and 25 dropped)", () => {
    expect(isSupportedNodeVersion("22.22.3")).toBe(false);
    expect(isSupportedNodeVersion("22.99.0")).toBe(false);
    expect(isSupportedNodeVersion("23.9.0")).toBe(false);
    expect(isSupportedNodeVersion("24.14.1")).toBe(false);
    expect(isSupportedNodeVersion("24.15.9")).toBe(false);
    expect(isSupportedNodeVersion("24.16.0")).toBe(true);
    expect(isSupportedNodeVersion("24.20.0")).toBe(true);
    expect(isSupportedNodeVersion("25.9.0")).toBe(false);
    expect(isSupportedNodeVersion("26.0.0")).toBe(false);
    expect(isSupportedNodeVersion("26.1.0")).toBe(true);
    expect(isSupportedNodeVersion("27.0.0")).toBe(true);
    expect(isSupportedNodeVersion("garbage")).toBe(false);
  });

  it("throws an actionable error for unsupported runtimes", () => {
    expect(() => assertSupportedNodeVersion("22.22.3")).toThrow(
      "requires Node.js >=24.16.0 <25 || >=26.1.0",
    );
    expect(() => assertSupportedNodeVersion("24.14.1")).toThrow(/SQLite text/);
    expect(() => assertSupportedNodeVersion("24.16.0")).not.toThrow();
  });
});

describe("engines-range (shared server + UI evaluator)", () => {
  it("parses upstream's published grammar", () => {
    expect(parseEngineRange(kOpenclaw2026_9_3Engines)).toEqual([
      [
        { op: ">=", version: [24, 16, 0] },
        { op: "<", version: [25, 0, 0] },
      ],
      [{ op: ">=", version: [26, 1, 0] }],
    ]);
    // Operator/version separated by whitespace, and partial versions.
    expect(parseEngineRange(">= 22.22.3 <23")).toEqual([
      [
        { op: ">=", version: [22, 22, 3] },
        { op: "<", version: [23, 0, 0] },
      ],
    ]);
    expect(parseEngineRange("=24.16.0")).toEqual([[{ op: "=", version: [24, 16, 0] }]]);
  });

  it("refuses to guess about grammar it does not implement (npm warn-only posture)", () => {
    for (const spec of ["^20 || ~18.17", "24", "24.x", "*", "20 - 22", ">=", "|| >=24", ""]) {
      expect(parseEngineRange(spec), spec).toBeNull();
      expect(satisfiesEngines(spec, "20.0.0"), spec).toBe(true);
    }
    expect(satisfiesEngines(undefined, "20.0.0")).toBe(true);
    expect(satisfiesEngines(null, "20.0.0")).toBe(true);
    // An unparseable RUNTIME version never blocks either.
    expect(satisfiesEngines(kOpenclaw2026_9_3Engines, "unknown")).toBe(true);
  });

  it("judges the 2026.9.3 requirement on real runtimes", () => {
    const table = [
      ["22.22.3", false],
      ["23.9.0", false],
      ["24.14.1", false],
      ["24.15.9", false],
      ["24.16.0", true],
      ["v24.16.0", true],
      ["24.20.0", true],
      ["25.9.0", false],
      ["26.0.9", false],
      ["26.1.0", true],
      ["27.0.0", true],
    ];
    for (const [version, expected] of table) {
      expect(satisfiesEngines(kOpenclaw2026_9_3Engines, version), version).toBe(expected);
    }
  });

  it("judges the 2026.9.2 requirement the same way the old major-only gate could not", () => {
    const spec = ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0";
    expect(satisfiesEngines(spec, "22.22.2")).toBe(false);
    expect(satisfiesEngines(spec, "22.22.3")).toBe(true);
    expect(satisfiesEngines(spec, "23.0.0")).toBe(false);
    expect(satisfiesEngines(spec, "24.14.1")).toBe(false);
    expect(satisfiesEngines(spec, "24.15.0")).toBe(true);
    expect(satisfiesEngines(spec, "25.8.0")).toBe(false);
    expect(satisfiesEngines(spec, "25.9.0")).toBe(true);
    expect(satisfiesEngines(spec, "26.0.0")).toBe(true);
  });

  it("keeps the simple major-floor semantics the preflight already relied on", () => {
    expect(satisfiesEngines(">=22", "20.0.0")).toBe(false);
    expect(satisfiesEngines(">=22", "22.1.0")).toBe(true);
    expect(satisfiesEngines(">22", "22.0.0")).toBe(false);
    expect(satisfiesEngines("<=22.1.0", "22.1.0")).toBe(true);
    expect(satisfiesEngines("<=22.1.0", "22.1.1")).toBe(false);
  });

  it("parses version triples leniently and never throws", () => {
    expect(parseVersionTriple("v24.16.0")).toEqual([24, 16, 0]);
    expect(parseVersionTriple("24.16.0-nightly20260908")).toEqual([24, 16, 0]);
    expect(parseVersionTriple("24.16")).toBeNull();
    expect(parseVersionTriple(null)).toBeNull();
    expect(parseVersionTriple({})).toBeNull();
  });
});
