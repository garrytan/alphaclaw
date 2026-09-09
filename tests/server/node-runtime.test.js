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
    for (const spec of ["^20 || ~18.17", "24.x", "*", "20 - 22", ">=", "|| >=24", ">=24 ||", "", "  ", ">=24.16.0 <25 banana"]) {
      expect(parseEngineRange(spec), spec).toBeNull();
      expect(satisfiesEngines(spec, "20.0.0"), spec).toBe(true);
    }
    expect(satisfiesEngines(undefined, "20.0.0")).toBe(true);
    expect(satisfiesEngines(null, "20.0.0")).toBe(true);
    // An unparseable RUNTIME version never blocks either.
    expect(satisfiesEngines(kOpenclaw2026_9_3Engines, "unknown")).toBe(true);
    expect(satisfiesEngines(kOpenclaw2026_9_3Engines, "24.16")).toBe(true);
  });

  it("accepts glued comparators the way npm does", () => {
    // npm/semver treats ">=24.16.0<25" as two comparators; refusing it would
    // silently DISABLE the gate for a spec that means exactly the pinned range.
    expect(parseEngineRange(">=24.16.0<25||>=26.1.0")).toEqual(parseEngineRange(kOpenclaw2026_9_3Engines));
    expect(satisfiesEngines(">=24.16.0<25", "24.14.1")).toBe(false);
    expect(satisfiesEngines(">=24.16.0<25", "24.16.0")).toBe(true);
    expect(parseEngineRange("\t>=24.16.0\n<25")).toEqual(parseEngineRange(">=24.16.0 <25"));
  });

  it("gives partial versions npm's X-range meaning instead of padding zeros", () => {
    // >24 is "strictly above the whole 24 line", not ">24.0.0".
    expect(satisfiesEngines(">24", "24.16.0")).toBe(false);
    expect(satisfiesEngines(">24", "25.0.0")).toBe(true);
    // <=24 is "up to the end of the 24 line", not "<=24.0.0".
    expect(satisfiesEngines("<=24", "24.16.0")).toBe(true);
    expect(satisfiesEngines("<=24", "25.0.0")).toBe(false);
    // =24 / a bare 24 is the whole line.
    expect(satisfiesEngines("=24", "24.16.0")).toBe(true);
    expect(satisfiesEngines("=24", "25.0.0")).toBe(false);
    expect(satisfiesEngines("24", "24.16.0")).toBe(true);
    expect(satisfiesEngines("24", "23.9.9")).toBe(false);
    expect(satisfiesEngines("24.16", "24.16.9")).toBe(true);
    expect(satisfiesEngines("24.16", "24.17.0")).toBe(false);
    // >= and < keep their plain floor/ceiling meaning.
    expect(satisfiesEngines(">=24", "24.0.0")).toBe(true);
    expect(satisfiesEngines("<25", "24.99.99")).toBe(true);
    expect(satisfiesEngines("<25", "25.0.0")).toBe(false);
    // Full triples are exact.
    expect(satisfiesEngines("=24.16.0", "24.16.0")).toBe(true);
    expect(satisfiesEngines("=24.16.0", "24.16.1")).toBe(false);
    expect(parseEngineRange(">24")).toEqual([[{ op: ">=", version: [25, 0, 0] }]]);
    expect(parseEngineRange("<=24.16")).toEqual([[{ op: "<", version: [24, 17, 0] }]]);
    expect(parseEngineRange("24")).toEqual([[{ op: ">=", version: [24, 0, 0] }, { op: "<", version: [25, 0, 0] }]]);
  });

  it("keeps prerelease runtimes outside every release-only range, as semver (and OpenClaw's own check) do", () => {
    // A nightly below the floor, a nightly above it, and a Node 25 release
    // candidate that would otherwise slip under `<25`: none satisfy.
    expect(satisfiesEngines(">=24.16.0", "24.16.0-nightly20260908")).toBe(false);
    expect(satisfiesEngines(">=24.16.0", "24.16.1-rc.1")).toBe(false);
    expect(satisfiesEngines("<25", "25.0.0-rc.1")).toBe(false);
    expect(satisfiesEngines(kOpenclaw2026_9_3Engines, "24.20.0-nightly")).toBe(false);
    expect(satisfiesEngines("=24.16.0", "24.16.0-pre")).toBe(false);
    expect(isSupportedNodeVersion("24.20.0-nightly20260908")).toBe(false);
    // An unparseable spec still never blocks, prerelease or not.
    expect(satisfiesEngines("^24", "24.20.0-nightly")).toBe(true);
  });

  it("fails CLOSED on its own floor: an unparseable kAlphaclawNodeEngines is a load-time error", () => {
    expect(parseEngineRange(kAlphaclawNodeEngines)).not.toBeNull();
    // The module guards the constant at load; a bad string must throw rather
    // than let isSupportedNodeVersion answer true for every runtime.
    const source = require("node:fs").readFileSync(require.resolve("../../lib/node-runtime"), "utf8");
    expect(source).toMatch(/if \(!parseEngineRange\(kAlphaclawNodeEngines\)\) \{\s*throw new Error/);
  });

  it("stays dependency-free so the UI bundle can import it (lib/channel-boundary.js contract)", () => {
    const source = require("node:fs").readFileSync(require.resolve("../../lib/engines-range"), "utf8");
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bimport\b\s/);
    expect(source).toMatch(/module\.exports\s*=/);
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

describe("node-runtime — the floor, the pin and the image move together (v0.9.80)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const repoRoot = path.join(__dirname, "..", "..");

  it("equals the pinned OpenClaw's own engines.node — not a hand-typed lookalike", () => {
    // AlphaClaw cannot run a gateway its own runtime cannot; when upstream
    // moves its floor the pin bump must move this string (and the image).
    const openclawEngines = require(path.join(repoRoot, "node_modules", "openclaw", "package.json")).engines.node;
    expect(kAlphaclawNodeEngines).toBe(openclawEngines);
  });

  it("the Dockerfile base image (and README's copy of it) runs a Node line inside the range", () => {
    const fromLine = (file) => {
      const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const match = text.match(/^FROM node:(\d+)-slim$/m);
      expect(match, `${file} FROM node:<major>-slim`).not.toBeNull();
      return match;
    };
    const dockerfile = fromLine("Dockerfile");
    const readme = fromLine("README.md");
    expect(readme[0]).toBe(dockerfile[0]);
    const major = Number(dockerfile[1]);
    // The tag floats within its major line: its newest patch must be inside
    // the range, and the line must be one the range names at all.
    expect(satisfiesEngines(kAlphaclawNodeEngines, `${major}.999.0`)).toBe(true);
    expect(parseEngineRange(kAlphaclawNodeEngines).some((alt) =>
      alt.some((c) => c.version[0] === major))).toBe(true);
  });

  it("CI's required lane runs a Node line inside the range", () => {
    const ci = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const matrix = ci.match(/node-version:\s*\[([^\]]+)\]/);
    expect(matrix).not.toBeNull();
    const majors = matrix[1].split(",").map((s) => Number(s.trim()));
    // Every lane must be able to run the suite at its newest patch level.
    for (const major of majors) {
      expect(satisfiesEngines(kAlphaclawNodeEngines, `${major}.999.0`), `node ${major}`).toBe(true);
    }
  });
});
