// Shared `engines.node` range evaluator (v0.9.80, the OpenClaw 2026.9.3 pin).
//
// ONE function answers "does this Node satisfy that engines requirement?" for
// every consumer: AlphaClaw's own boot floor (lib/node-runtime.js,
// `kAlphaclawNodeEngines`), the apply preflight's engines gate
// (`enginesSatisfied` in lib/server/openclaw-channel-sync.js) and the Upgrade
// tab's catalog rows (`buildEnginesGateModel` in
// lib/public/js/components/upgrade-tab/helpers.js). Before this module the
// preflight compared MAJOR versions only (`>=24` let Node 24.14 through to a
// build that refuses to start, and let Node 25 through although excluded),
// and the UI never read the requirement at all.
//
// Grammar — the comparator subset of npm's `engines.node` ranges, with npm's
// semantics for partial versions (X-ranges):
//
//   range        := alternative ( "||" alternative )*
//   alternative  := comparator+          (AND; whitespace between comparators
//                                          is optional — ">=24.16.0<25" is legal)
//   comparator   := [ ">=" | ">" | "<=" | "<" | "=" ] version
//   version      := major [ "." minor [ "." patch ] ]
//
//   >=X / <X       the missing parts are 0            (>=24 → >=24.0.0)
//   >X.Y           strictly above the whole X.Y line  (>24 → >=25.0.0)
//   <=X.Y          up to the end of the X.Y line      (<=24 → <25.0.0)
//   =X.Y, X.Y      the whole line                     (24 → >=24.0.0 <25.0.0)
//
// e.g. ">=24.16.0 <25 || >=26.1.0". Anything outside that grammar (`^`, `~`,
// `x`/`*` wildcards, hyphen ranges, an empty alternative, a dangling operator)
// is UNPARSEABLE: `parseEngineRange` returns null and `satisfiesEngines`
// answers true — the warn-only posture npm itself takes on engines, so an
// exotic spec can never block an install. Callers that want to know the
// difference call `parseEngineRange` and check for null.
//
// A runtime carrying a prerelease tag ("24.16.0-nightly20260908",
// "25.0.0-rc.1") never satisfies a parseable range — npm/semver's rule: a
// prerelease only matches a comparator set that names a prerelease on the same
// major.minor.patch, and engines ranges never do. That is also what the pinned
// OpenClaw's own engines check answers, so AlphaClaw refuses the same nightly
// builds upstream refuses. A version without a parseable `major.minor.patch`
// never blocks.
//
// Like lib/channel-boundary.js this is dependency-free CommonJS: the server
// requires it directly and the esbuild UI bundle imports its named exports,
// so it must never require a node builtin or a server module.

const kVersionPattern = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;
// Sticky scanner: optional operator, optional "v", 1-3 numeric parts, then
// any whitespace. Each `exec` must start exactly where the previous one ended.
const kComparatorScanner = /\s*(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*/y;

// "24.16.0" / "v24.16.0" / "24.16.0-nightly" → [24, 16, 0]; anything else → null.
const parseVersionTriple = (value) => {
  const match = String(value ?? "").trim().match(kVersionPattern);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

// { triple, prerelease } or null.
const parseRuntimeVersion = (value) => {
  const match = String(value ?? "").trim().match(kVersionPattern);
  if (!match) return null;
  return {
    triple: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
};

const compareTriples = (a, b) => {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
};

// One scanned token → one or two full comparators (npm X-range semantics).
const expandComparator = ({ op, major, minor, patch }) => {
  const full = [major, minor ?? 0, patch ?? 0];
  // The first version past the partial's line: 24 → 25.0.0, 24.16 → 24.17.0.
  const next =
    minor === null ? [major + 1, 0, 0] : patch === null ? [major, minor + 1, 0] : null;
  switch (op) {
    case ">=":
      return [{ op: ">=", version: full }];
    case "<":
      return [{ op: "<", version: full }];
    case ">":
      return next ? [{ op: ">=", version: next }] : [{ op: ">", version: full }];
    case "<=":
      return next ? [{ op: "<", version: next }] : [{ op: "<=", version: full }];
    default: // "=" or a bare version
      return next
        ? [
            { op: ">=", version: full },
            { op: "<", version: next },
          ]
        : [{ op: "=", version: full }];
  }
};

// One alternative → its comparators, or null when any character is outside
// the grammar or the alternative is empty.
const parseAlternative = (alternative) => {
  const text = String(alternative ?? "");
  const comparators = [];
  let index = 0;
  while (index < text.length) {
    kComparatorScanner.lastIndex = index;
    const match = kComparatorScanner.exec(text);
    if (!match || match.index !== index || match[0].length === 0) {
      // Trailing whitespace alone is fine; anything else is foreign grammar.
      return /^\s*$/.test(text.slice(index)) && comparators.length > 0 ? comparators : null;
    }
    index = kComparatorScanner.lastIndex;
    comparators.push(
      ...expandComparator({
        op: match[1] ?? "=",
        major: Number(match[2]),
        minor: match[3] === undefined ? null : Number(match[3]),
        patch: match[4] === undefined ? null : Number(match[4]),
      }),
    );
  }
  return comparators.length > 0 ? comparators : null;
};

// Array of alternatives (each an array of { op, version: [maj, min, patch] })
// or null when the spec is empty or outside the supported grammar.
const parseEngineRange = (spec) => {
  const text = String(spec ?? "").trim();
  if (!text) return null;
  const alternatives = [];
  for (const alternative of text.split("||")) {
    const comparators = parseAlternative(alternative);
    if (!comparators) return null;
    alternatives.push(comparators);
  }
  return alternatives;
};

const comparatorHolds = (comparator, runtime) => {
  const cmp = compareTriples(runtime.triple, comparator.version);
  switch (comparator.op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    default:
      return false;
  }
};

// true when `version` satisfies `spec`; ALSO true when the spec is empty,
// unparseable, or the version is unparseable (warn-only posture). Use
// `parseEngineRange(spec) !== null` when the distinction matters.
const satisfiesEngines = (spec, version) => {
  const range = parseEngineRange(spec);
  if (!range) return true;
  const runtime = parseRuntimeVersion(version);
  if (!runtime) return true;
  // semver: a prerelease runtime is outside every release-only range.
  if (runtime.prerelease) return false;
  return range.some((alternative) =>
    alternative.every((comparator) => comparatorHolds(comparator, runtime)),
  );
};

module.exports = {
  parseVersionTriple,
  parseEngineRange,
  satisfiesEngines,
};
