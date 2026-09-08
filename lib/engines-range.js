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
// Grammar — exactly the subset upstream publishes (npm `engines.node`):
//
//   range        := alternative ( "||" alternative )*
//   alternative  := comparator+                 (whitespace-joined AND)
//   comparator   := ( ">=" | ">" | "<=" | "<" | "=" ) version
//   version      := major [ "." minor [ "." patch ] ]   (missing parts = 0)
//
// e.g. ">=24.16.0 <25 || >=26.1.0". Anything outside that grammar (`^`, `~`,
// `x`/`*` wildcards, hyphen ranges, bare X-ranges like `24`) is UNPARSEABLE:
// `parseEngineRange` returns null and `satisfiesEngines` answers true — the
// warn-only posture npm itself takes on engines, so an exotic spec can never
// block an install. Callers that want to know the difference call
// `parseEngineRange` and check for null.
//
// Like lib/channel-boundary.js this is dependency-free CommonJS: the server
// requires it directly and the esbuild UI bundle imports its named exports,
// so it must never require a node builtin or a server module.

const kComparatorPattern = /^(>=|<=|>|<|=)\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const kVersionTriplePattern = /^v?(\d+)\.(\d+)\.(\d+)/;

// "24.16.0" / "v24.16.0" / "24.16.0-nightly" → [24, 16, 0]; anything else → null.
const parseVersionTriple = (value) => {
  const match = String(value ?? "")
    .trim()
    .match(kVersionTriplePattern);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareTriples = (a, b) => {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
};

// A comparator token like ">=24.16.0" or "<25". Operators and versions may be
// separated by whitespace in the wild (">= 24.16.0"); `parseAlternative`
// re-joins those before calling this. Returns null for anything else.
const parseComparator = (token) => {
  const match = String(token ?? "")
    .trim()
    .match(kComparatorPattern);
  if (!match) return null;
  return {
    op: match[1],
    version: [
      Number(match[2]),
      match[3] === undefined ? 0 : Number(match[3]),
      match[4] === undefined ? 0 : Number(match[4]),
    ],
  };
};

// Split an alternative into comparator tokens, re-attaching a bare operator to
// the version that follows it (">= 24.16.0" → ">=24.16.0").
const tokenizeAlternative = (alternative) => {
  const raw = String(alternative ?? "").trim().split(/\s+/).filter(Boolean);
  const tokens = [];
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (/^(>=|<=|>|<|=)$/.test(token)) {
      if (index + 1 >= raw.length) return null;
      tokens.push(`${token}${raw[index + 1]}`);
      index += 1;
    } else {
      tokens.push(token);
    }
  }
  return tokens;
};

const parseAlternative = (alternative) => {
  const tokens = tokenizeAlternative(alternative);
  if (!tokens || tokens.length === 0) return null;
  const comparators = [];
  for (const token of tokens) {
    const comparator = parseComparator(token);
    if (!comparator) return null;
    comparators.push(comparator);
  }
  return comparators;
};

// Array of alternatives (each an array of { op, version }) or null when the
// spec is empty or outside the supported grammar.
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

const comparatorHolds = (comparator, version) => {
  const cmp = compareTriples(version, comparator.version);
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
  const triple = parseVersionTriple(version);
  if (!triple) return true;
  return range.some((alternative) =>
    alternative.every((comparator) => comparatorHolds(comparator, triple)),
  );
};

module.exports = {
  parseVersionTriple,
  parseEngineRange,
  satisfiesEngines,
};
