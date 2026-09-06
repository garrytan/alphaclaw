// Shared helpers for the structural guard tests (fix wave, PR 1). The guards
// are regression TRIPWIRES, not proofs: each scans the tree with regexes for
// one defect class the audit found repeatedly, carries a kKnownOffenders
// allowlist (with a why-comment per entry, the kUnmanifestedRoutes pattern),
// and goes red when a NEW offender appears. Later fix-wave PRs shrink the
// lists to zero; ESLint no-restricted-syntax is the eventual home (TODOS).
const fs = require("fs");
const path = require("path");

const kRepoRoot = path.join(__dirname, "..", "..", "..");
const kSkippedDirs = new Set([
  "node_modules",
  "dist",
  "coverage",
  "vendor",
  ".git",
  "artifacts",
]);

const walkJsFiles = (relRoots) => {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (kSkippedDirs.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  for (const rel of relRoots) {
    const abs = path.join(kRepoRoot, rel);
    if (fs.existsSync(abs)) visit(abs);
  }
  return out.sort();
};

const toRel = (absPath) => path.relative(kRepoRoot, absPath).split(path.sep).join("/");

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// Strip // and /* */ comments so commented-out examples never trip a guard
// (string contents are left alone — a literal is exactly what we scan for).
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));

// Run a scanner over every file under the roots and diff against the
// allowlist. Returns { unexpected, stale } so a test can fail on new
// offenders AND on allowlist entries that no longer match (a fixed offender
// must be removed from the list, keeping it honest).
const auditTree = ({ roots, scan, allowlist }) => {
  const found = new Map();
  for (const abs of walkJsFiles(roots)) {
    const rel = toRel(abs);
    const text = fs.readFileSync(abs, "utf8");
    for (const hit of scan(text, rel)) {
      found.set(hit.key, hit);
    }
  }
  const allowed = new Set(Object.keys(allowlist));
  const unexpected = [...found.values()].filter((hit) => !allowed.has(hit.key));
  const stale = [...allowed].filter((key) => !found.has(key));
  return { found, unexpected, stale };
};

const formatHits = (hits) =>
  hits.map((hit) => `  ${hit.key}  (${hit.file}:${hit.line})`).join("\n");

module.exports = {
  kRepoRoot,
  walkJsFiles,
  toRel,
  lineOf,
  stripComments,
  auditTree,
  formatHits,
};
