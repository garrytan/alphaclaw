// Guard: every OPENCLAW_CONFIG_PATH handed to an OpenClaw child comes from
// resolveOpenclawChildConfigPath (lib/server/openclaw-config-path.js). A
// literal "<stateDir>/openclaw.json" breaks every OpenClaw config write on a
// symlinked state dir (issue #144: OpenClaw 2026.10's atomic writer refuses a
// symlinked parent). Reads of process.env.OPENCLAW_CONFIG_PATH are fine; only
// assignments (object keys, env-file lines, process.env writes) are scanned.
const { auditTree, formatHits, lineOf, stripComments } = require("./guard-utils");

const kAssignment = /OPENCLAW_CONFIG_PATH(?:\s*:\s*|=\$\{|=\$\{shQuote\(|\s*=\s*)(?!\s*=)([^,\n;]*)/g;

const scanConfigPathAssignments = (rawText, relPath) => {
  if (relPath === "lib/server/openclaw-config-path.js") return [];
  const text = stripComments(rawText);
  const hits = [];
  for (const m of text.matchAll(kAssignment)) {
    const value = m[1] || "";
    if (/resolveOpenclawChildConfigPath\(/.test(value)) continue;
    if (/^\s*(?:env|process\.env|input|options|params)\.OPENCLAW_CONFIG_PATH\b/.test(value)) continue;
    const line = lineOf(text, m.index);
    hits.push({ key: `${relPath}::${line}`, file: relPath, line });
  }
  return hits;
};

// Each entry: a child env that deliberately passes an explicit config path.
const kKnownOffenders = {};

describe("guard: OPENCLAW_CONFIG_PATH comes from resolveOpenclawChildConfigPath", () => {
  it("flags literal assignments in each form and accepts the resolver (self-test)", () => {
    const fixture = [
      "const a = { OPENCLAW_CONFIG_PATH: path.join(dir, \"openclaw.json\") };",
      "process.env.OPENCLAW_CONFIG_PATH = path.join(dir, \"openclaw.json\");",
      "const line = `OPENCLAW_CONFIG_PATH=${path.join(dir, \"openclaw.json\")}`;",
      "const ok = { OPENCLAW_CONFIG_PATH: resolveOpenclawChildConfigPath(dir) };",
      "process.env.OPENCLAW_CONFIG_PATH = resolveOpenclawChildConfigPath(dir);",
      "if (env.OPENCLAW_CONFIG_PATH === x) {}",
    ].join("\n");
    const hits = scanConfigPathAssignments(fixture, "lib/server/planted.js");
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  it("has no literal OPENCLAW_CONFIG_PATH assignment outside the resolver, and no stale entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib", "bin"],
      scan: scanConfigPathAssignments,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `Literal OPENCLAW_CONFIG_PATH — use resolveOpenclawChildConfigPath(openclawDir):\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(stale, `Stale allowlist entries:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
