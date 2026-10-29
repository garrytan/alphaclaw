// Compare two v8/istanbul coverage-final.json files location by location.
//
// For every source file whose statement, branch and function maps are
// identical in both runs (the file did not change), each statement, branch
// arm and function covered before must still be covered after: an equal
// percentage cannot hide a swapped branch. Files that changed shape are
// listed with their percentages. Locations whose coverage differs between
// identical runs (timing-dependent paths) are the noise list.
//
// Usage: node scripts/ci/coverage-diff.mjs <before.json> <after.json> [--noise <noise.json>]
//        node scripts/ci/coverage-diff.mjs --noise-from <run1.json> <run2.json> [...]   (prints a noise list)
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const commonDir = (paths) => {
  if (paths.length === 0) return "";
  let prefix = path.dirname(paths[0]);
  for (const p of paths) while (prefix && !(p + "/").startsWith(prefix + "/")) prefix = path.dirname(prefix) === prefix ? "" : path.dirname(prefix);
  return prefix;
};

export const normalize = (coverage) => {
  let root = commonDir(Object.keys(coverage));
  if (["lib", "bin", "scripts", "tests"].includes(path.basename(root))) root = path.dirname(root);
  return Object.fromEntries(Object.entries(coverage).map(([file, data]) => [path.relative(root, file).split(path.sep).join("/"), data]));
};

const sameShape = (a, b) =>
  JSON.stringify(a.statementMap) === JSON.stringify(b.statementMap) &&
  JSON.stringify(a.branchMap) === JSON.stringify(b.branchMap) &&
  JSON.stringify(a.fnMap) === JSON.stringify(b.fnMap);

export const covered = (data) => {
  const set = new Set();
  for (const [id, hits] of Object.entries(data.s)) if (hits > 0) set.add(`s${id}`);
  for (const [id, hits] of Object.entries(data.f)) if (hits > 0) set.add(`f${id}`);
  for (const [id, arms] of Object.entries(data.b)) arms.forEach((hits, arm) => hits > 0 && set.add(`b${id}.${arm}`));
  return set;
};

const pct = (data) => {
  const ratio = (hits) => (hits.length ? (100 * hits.filter((n) => n > 0).length) / hits.length : 100);
  return {
    statements: ratio(Object.values(data.s)),
    branches: ratio(Object.values(data.b).flat()),
    functions: ratio(Object.values(data.f)),
  };
};

// Locations covered in some of several identical runs but not in all of them.
export const noiseBetween = (...runs) => {
  const [first, ...rest] = runs.map(normalize);
  const noise = {};
  for (const [file, data] of Object.entries(first)) {
    if (rest.some((run) => !run[file] || !sameShape(data, run[file]))) continue;
    const sets = [data, ...rest.map((run) => run[file])].map(covered);
    const all = new Set(sets.flatMap((set) => [...set]));
    const differing = [...all].filter((loc) => !sets.every((set) => set.has(loc)));
    if (differing.length) noise[file] = differing.sort();
  }
  return noise;
};

export const diffCoverage = (beforeRaw, afterRaw, { noise = {} } = {}) => {
  const before = normalize(beforeRaw);
  const after = normalize(afterRaw);
  const losses = [];
  const changed = [];
  for (const [file, data] of Object.entries(before)) {
    if (!after[file]) {
      losses.push({ file, lost: ["(file no longer covered at all)"] });
      continue;
    }
    if (!sameShape(data, after[file])) {
      changed.push({ file, before: pct(data), after: pct(after[file]) });
      continue;
    }
    const now = covered(after[file]);
    const allowed = new Set(noise[file] ?? []);
    const lost = [...covered(data)].filter((loc) => !now.has(loc) && !allowed.has(loc));
    if (lost.length) losses.push({ file, lost });
  }
  const added = Object.keys(after).filter((file) => !before[file]);
  return { losses, changed, added, files: Object.keys(before).length };
};

export const renderCoverageDiff = ({ losses, changed, added, files }) => {
  const f = (n) => n.toFixed(1);
  const lines = ["### Coverage (hermetic, location by location)", "", `Files compared: ${files}; changed shape: ${changed.length}; new: ${added.length}.`, ""];
  if (changed.length) {
    lines.push("| changed file | statements | branches | functions |", "|---|---|---|---|");
    for (const c of changed) {
      lines.push(`| ${c.file} | ${f(c.before.statements)} → ${f(c.after.statements)} | ${f(c.before.branches)} → ${f(c.after.branches)} | ${f(c.before.functions)} → ${f(c.after.functions)} |`);
    }
    lines.push("");
  }
  if (losses.length === 0) lines.push("No covered location in an unchanged file lost its coverage.");
  else for (const l of losses) lines.push(`- LOST in ${l.file}: ${l.lost.slice(0, 20).join(", ")}${l.lost.length > 20 ? ` (+${l.lost.length - 20})` : ""}`);
  return lines.join("\n");
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  if (args[0] === "--noise-from" && args.length >= 3) {
    console.log(JSON.stringify(noiseBetween(...args.slice(1).map(read)), null, 1));
    process.exit(0);
  }
  const i = args.indexOf("--noise");
  const noise = i === -1 ? {} : read(args.splice(i, 2)[1]);
  if (args.length !== 2) {
    console.error("usage: coverage-diff.mjs <before.json> <after.json> [--noise <noise.json>] | --noise-from <a.json> <b.json> [...]");
    process.exit(2);
  }
  const result = diffCoverage(read(args[0]), read(args[1]), { noise });
  const text = renderCoverageDiff(result);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  if (result.losses.length) process.exit(1);
}
