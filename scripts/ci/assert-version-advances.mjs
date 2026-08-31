// CI version guard: fail a PR whose package.json version does not strictly
// advance the base branch's version. This surfaces the concurrent-version-claim
// races the v0.9.34–v0.9.60 wave hit (multiple open PRs claiming the same
// number, forcing unreviewed renumber+merge reconciliation) at PR time instead
// of at merge time. Deliberately serializes version claims — that cost IS the
// fix. Every PR, including reverts, must bump.
//
// Usage: node scripts/ci/assert-version-advances.mjs <base-package.json> <head-package.json>
import { readFileSync } from "node:fs";

// Parse "MAJOR.MINOR.PATCH[.MICRO][-prerelease.N]" into comparable parts.
export const parseCore = (version) => {
  const raw = String(version || "").trim();
  const [core, ...preParts] = raw.split("-");
  const pre = preParts.join("-");
  const nums = core.split(".").map((n) => Number(n));
  if (nums.length < 3 || nums.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`unparseable version: ${JSON.stringify(raw)}`);
  }
  // Pad to 4 components (MICRO defaults to 0) so 0.9.60 and 0.9.60.0 compare equal.
  while (nums.length < 4) nums.push(0);
  return { nums: nums.slice(0, 4), pre };
};

// Returns true iff `next` is a strictly greater release than `prev`.
// Rules: numeric cores compare left-to-right. A prerelease (has `-tag`) is
// LOWER than the same core without one (0.9.61-beta.1 < 0.9.61), matching npm
// and the repo's --preid=beta flow; two prereleases of the same core compare
// lexically (beta.2 > beta.10 would be wrong, but the repo only uses single
// increasing counters and this guard just needs monotonicity, not full semver).
export const versionAdvances = (nextVersion, prevVersion) => {
  const next = parseCore(nextVersion);
  const prev = parseCore(prevVersion);
  for (let i = 0; i < 4; i += 1) {
    if (next.nums[i] > prev.nums[i]) return true;
    if (next.nums[i] < prev.nums[i]) return false;
  }
  // Cores equal — decide on the prerelease tail.
  if (next.pre === prev.pre) return false; // identical version, no advance
  if (!next.pre && prev.pre) return true; // release > its own prerelease
  if (next.pre && !prev.pre) return false; // prerelease < the release
  return next.pre > prev.pre; // both prerelease: lexical (single counters only)
};

const readVersion = (path) => {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (!pkg.version) throw new Error(`no version field in ${path}`);
  return pkg.version;
};

// CLI entry (skipped when imported by tests).
const isMain =
  process.argv[1] && process.argv[1].endsWith("assert-version-advances.mjs");
if (isMain) {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error(
      "usage: assert-version-advances.mjs <base-package.json> <head-package.json>",
    );
    process.exit(2);
  }
  try {
    const base = readVersion(basePath);
    const head = readVersion(headPath);
    if (!versionAdvances(head, base)) {
      console.error(
        `Version guard FAILED: package.json version ${head} does not advance base ${base}. ` +
          `Bump the version (every PR must, including reverts) — main moves fast, so claim the ` +
          `next free number at merge time. See CLAUDE.md "Merge unification safety".`,
      );
      process.exit(1);
    }
    console.log(`Version guard OK: ${head} advances ${base}.`);
  } catch (err) {
    console.error(`Version guard ERROR: ${err.message}`);
    process.exit(1);
  }
}
