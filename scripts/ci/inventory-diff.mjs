// Compare two test inventories (scripts/ci/test-inventory.mjs) as multisets.
//
// A loss is: a test file or test that disappeared, a test that passed and is
// now skipped, todo or failed, a test that ran in two legs (duplicate key),
// and with --strict a lower assertion count, with --no-retries any retry.
// A removal or a deliberate skip is declared by a line in a commit message
// of the change (squash-safe; matched anywhere, not parsed as a git trailer):
//   Removed-test-file: <file>
//   Removed-test: <file> :: <full name>
//   Skipped-test: <file> :: <full name>
// Assertion-count changes are reported, never failed, without --strict: they
// vary with vi.waitFor / expect.poll timing.
//
// Usage: node scripts/ci/inventory-diff.mjs <base.json> <head.json>
//          [--declarations <file>] [--strict] [--no-retries] [--report-only]
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const testKey = (test) => `${test.file} :: ${test.name}${test.occurrence ? ` #${test.occurrence + 1}` : ""}`;

export const parseDeclarations = (text) => {
  const declarations = { removedFiles: new Set(), removedTests: new Set(), skippedTests: new Set() };
  const kinds = { "Removed-test-file": "removedFiles", "Removed-test": "removedTests", "Skipped-test": "skippedTests" };
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(Removed-test-file|Removed-test|Skipped-test):\s*(.+?)\s*$/);
    if (match) declarations[kinds[match[1]]].add(match[2]);
  }
  return declarations;
};

const keyed = (inventory, losses, label) => {
  const map = new Map();
  for (const test of inventory.tests) {
    const key = testKey(test);
    if (map.has(key)) losses.push({ kind: `ran twice (${label})`, key });
    map.set(key, test);
  }
  return map;
};

export const diffInventories = (base, head, { declarations = parseDeclarations(""), strict = false, noRetries = false } = {}) => {
  const losses = [];
  const notes = [];
  const baseTests = keyed(base, losses, "base");
  const headTests = keyed(head, losses, "head");
  const headFiles = new Set(head.files.map((entry) => entry.file));
  for (const { file } of base.files) {
    if (headFiles.has(file)) continue;
    if (declarations.removedFiles.has(file)) notes.push({ kind: "removed file (declared)", key: file });
    else losses.push({ kind: "removed file", key: file, declare: `Removed-test-file: ${file}` });
  }
  let assertionsBefore = 0;
  let assertionsAfter = 0;
  for (const [key, before] of baseTests) {
    const after = headTests.get(key);
    if (!after) {
      if (!headFiles.has(before.file)) continue;
      if (declarations.removedTests.has(key)) notes.push({ kind: "removed test (declared)", key });
      else losses.push({ kind: "removed test", key, declare: `Removed-test: ${key}` });
      continue;
    }
    if (before.status === "passed" && after.status !== "passed") {
      const skip = after.status === "skipped" || after.status === "todo";
      if (skip && declarations.skippedTests.has(key)) notes.push({ kind: `now ${after.status} (declared)`, key });
      else losses.push({ kind: `passed, now ${after.status}`, key, declare: skip ? `Skipped-test: ${key}` : null });
    }
    if (before.assertions != null && after.assertions != null) {
      assertionsBefore += before.assertions;
      assertionsAfter += after.assertions;
      if (after.assertions < before.assertions) {
        (strict ? losses : notes).push({ kind: "fewer assertions", key, detail: `${before.assertions} -> ${after.assertions}` });
      }
    }
  }
  for (const [key, after] of headTests) {
    if (!baseTests.has(key)) {
      notes.push({ kind: "added", key });
      if (after.status === "failed") losses.push({ kind: "failed", key });
    }
    if (noRetries && after.retries > 0) losses.push({ kind: "retried", key, detail: String(after.retries) });
  }
  return {
    losses,
    notes,
    counts: {
      baseFiles: base.files.length,
      headFiles: head.files.length,
      baseTests: base.tests.length,
      headTests: head.tests.length,
      assertionsBefore,
      assertionsAfter,
    },
  };
};

export const renderDiff = ({ losses, notes, counts }, { reportOnly = false } = {}) => {
  const lines = [
    "### Test inventory",
    "",
    `| | base | head |`,
    `|---|---|---|`,
    `| test files | ${counts.baseFiles} | ${counts.headFiles} |`,
    `| tests | ${counts.baseTests} | ${counts.headTests} |`,
    `| assertions (tests in both) | ${counts.assertionsBefore} | ${counts.assertionsAfter} |`,
    "",
  ];
  const byKind = (list) =>
    Object.entries(list.reduce((acc, entry) => ((acc[entry.kind] = (acc[entry.kind] ?? 0) + 1), acc), {}))
      .map(([kind, n]) => `${kind}: ${n}`)
      .join(", ") || "none";
  lines.push(`Changes: ${byKind(notes)}`, "");
  if (losses.length === 0) {
    lines.push("No coverage loss: every base test still runs with at least its base status.");
    return lines.join("\n");
  }
  lines.push(`**${losses.length} loss(es)${reportOnly ? " (report-only, not failing)" : ""}:**`, "");
  for (const loss of losses.slice(0, 200)) lines.push(`- ${loss.kind}: \`${loss.key}\`${loss.detail ? ` (${loss.detail})` : ""}`);
  const declare = losses.map((loss) => loss.declare).filter(Boolean);
  if (declare.length) {
    lines.push("", "If these are deliberate, add these lines to a commit message in the PR:", "", "```", ...declare, "```");
  }
  return lines.join("\n");
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };
  const take = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args.splice(i, 2)[1];
  };
  const strict = flag("--strict");
  const noRetries = flag("--no-retries");
  const reportOnly = flag("--report-only");
  const declarationsFile = take("--declarations");
  if (args.length !== 2) {
    console.error("usage: inventory-diff.mjs <base.json> <head.json> [--declarations <file>] [--strict] [--no-retries] [--report-only]");
    process.exit(2);
  }
  const [base, head] = args.map((file) => JSON.parse(readFileSync(file, "utf8")));
  const declarations = parseDeclarations(declarationsFile ? readFileSync(declarationsFile, "utf8") : "");
  const result = diffInventories(base, head, { declarations, strict, noRetries });
  const text = renderDiff(result, { reportOnly });
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  if (result.losses.length > 0) {
    if (reportOnly) {
      console.log(`::warning::Test inventory: ${result.losses.length} loss(es) against the base (report-only).`);
    } else {
      process.exit(1);
    }
  }
}
