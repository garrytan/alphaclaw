// Guard: a modelPolicy list is written only while no gateway serves. On
// OpenClaw 2026.10.8 a hot reload of any modelPolicy change, even one that
// only adds a model, revokes in-flight session events (a background exec's
// completion is refused and its result is lost; ALPH-24 saw it on a live
// box). So the one writer is applyModelPolicyGaps in lib/server/model-policy.js,
// and its only caller outside that module is requestGatewayLaunch in
// lib/server/gateway.js, after the old gateway is gone and before the spawn.
const { auditTree, formatHits, lineOf, stripComments } = require("./guard-utils");

const kWriteRe = /(?<!\b(?:const|let|var)\s+)\bmodelPolicy\b(?:\s*(?:\.\s*allow|\[\s*["'`]allow["'`]\s*\]))?\s*(?:=(?![=>])|\.\s*(?:push|unshift|splice)\s*\()|["'`]agents\.[^"'`\n]*\bmodelPolicy\b/g;
const kCallRe = /\b(applyModelPolicyGaps|applyModelPolicyBeforeLaunch)\s*\(/g;
const kDeclarationRe = /^\s*const\s+(applyModelPolicyGaps|applyModelPolicyBeforeLaunch)\s*=/;

const scanModelPolicyWrites = (rawText, relPath) => {
  const text = stripComments(rawText);
  const hits = [];
  const ordinals = new Map();
  const push = (index, label) => {
    const n = (ordinals.get(label) || 0) + 1;
    ordinals.set(label, n);
    hits.push({ key: `${relPath}::${label}#${n}`, file: relPath, line: lineOf(text, index) });
  };
  for (const m of text.matchAll(kWriteRe)) push(m.index, "write");
  for (const m of text.matchAll(kCallRe)) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    if (kDeclarationRe.test(text.slice(lineStart, m.index + m[0].length))) continue;
    push(m.index, m[1]);
  }
  return hits;
};

const kSanctioned = {
  // The one writer: appends the missing refs to the governing allow list.
  "lib/server/model-policy.js::write#1": true,
  // applyModelPolicyBeforeLaunch closes the gaps inside its locked write.
  "lib/server/model-policy.js::applyModelPolicyGaps#1": true,
  // requestGatewayLaunch, in the no-gateway window beside the snapshot sweep.
  "lib/server/gateway.js::applyModelPolicyBeforeLaunch#1": true,
};

describe("guard: modelPolicy is written only before a gateway launch", () => {
  it("detects assignments, list mutation and CLI paths (self-test)", () => {
    const fixture = [
      "cfg.agents.defaults.modelPolicy.allow = [...list, ref];",
      'cfg.agents.defaults.modelPolicy["allow"].push(ref);',
      "agent.modelPolicy = { allow: [] };",
      'execFileCmd("openclaw", ["config", "set", "agents.defaults.modelPolicy.allow", value]);',
      'run("agents.defaults.modelPolicy", { allow });',
      "applyModelPolicyGaps(config);",
      "if (node.modelPolicy.allow === list) return; // a comparison, not a write",
      "const allow = node.modelPolicy.allow;",
    ].join("\n");
    expect(scanModelPolicyWrites(fixture, "lib/server/planted.js").map((hit) => hit.key)).toEqual([
      "lib/server/planted.js::write#1",
      "lib/server/planted.js::write#2",
      "lib/server/planted.js::write#3",
      "lib/server/planted.js::write#4",
      "lib/server/planted.js::write#5",
      "lib/server/planted.js::applyModelPolicyGaps#1",
    ]);
  });

  it("has no modelPolicy writer or launch-writer caller outside the launch window", () => {
    const { unexpected, stale } = auditTree({ roots: ["lib", "bin"], scan: scanModelPolicyWrites, allowlist: kSanctioned });
    expect(
      unexpected,
      `A modelPolicy write outside the launch window. A served modelPolicy hot reload revokes in-flight work on OpenClaw 2026.10.8; leave the gap for applyModelPolicyBeforeLaunch and mark the model_policy_pending restart reason (noteModelPolicyGaps):\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(stale, `Sanctioned sites no longer match, update the list:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
