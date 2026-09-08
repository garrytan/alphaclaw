const { parseEngineRange, satisfiesEngines } = require("./engines-range");

// AlphaClaw's supported Node runtimes — ONE string, shared verbatim with
// `package.json` `engines.node` (tests/server/node-runtime.test.js pins the two
// equal) and with the `node:24-slim` production image. It is exactly what the
// pinned OpenClaw declares: 2026.9.3 dropped Node 22 and 25 ("upgrade Node
// before OpenClaw to prevent SQLite text truncation"), so AlphaClaw cannot run
// a gateway its own runtime cannot. Moving this string, the image tag and the
// CI matrix (`test (24)` required, `test (26)` advisory) is one change.
const kAlphaclawNodeEngines = ">=24.16.0 <25 || >=26.1.0";

// The evaluator answers `true` for a spec it cannot parse (npm's warn-only
// posture) — right for a third-party row, wrong for OUR floor, which must
// fail CLOSED. A typo here is a programming error caught at module load and
// by the test suite, never a boot that waves every runtime through.
if (!parseEngineRange(kAlphaclawNodeEngines)) {
  throw new Error(
    `kAlphaclawNodeEngines is not a parseable engines range: ${JSON.stringify(kAlphaclawNodeEngines)}`,
  );
}

const parseNodeVersion = (value = process.versions.node) => {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
};

const isSupportedNodeVersion = (value = process.versions.node) => {
  if (!parseNodeVersion(value)) return false;
  return satisfiesEngines(kAlphaclawNodeEngines, value);
};

const getUnsupportedNodeMessage = (value = process.versions.node) =>
  `Node.js ${value} is not supported. AlphaClaw requires Node.js ${kAlphaclawNodeEngines} (Node 24.16 or newer on the 24 line, or Node 26.1 or newer): OpenClaw 2026.9.3 dropped Node 22 and 25, and older runtimes truncate SQLite text.`;

const assertSupportedNodeVersion = (value = process.versions.node) => {
  if (isSupportedNodeVersion(value)) return;
  throw new Error(getUnsupportedNodeMessage(value));
};

module.exports = {
  kAlphaclawNodeEngines,
  assertSupportedNodeVersion,
  getUnsupportedNodeMessage,
  isSupportedNodeVersion,
  parseNodeVersion,
  satisfiesEngines,
};
