const { readFileSync } = require("node:fs");
const path = require("node:path");

// Policy guard: CLAUDE.md's merge-unification safety rules must exist and keep
// their enforceable teeth. Born from the v0.9.34–v0.9.60 wave, where #13
// rewrote day-old #8, #14 dropped #6, and #32 grafted its migration engine
// over main's #29 fix — each by declaring itself "the base" without
// reconciling. A phrase-presence guard, not behavior enforcement.
const kClaudeMd = readFileSync(
  path.join(__dirname, "..", "..", "CLAUDE.md"),
  "utf8",
);

describe("CLAUDE.md merge unification safety policy", () => {
  it("has the policy section", () => {
    expect(kClaudeMd).toContain("## Merge unification safety");
  });

  it("keeps the enforceable rules intact", () => {
    const section = kClaudeMd.split("## Merge unification safety")[1] ?? "";
    expect(section).toContain("gh pr list"); // pre-work overlap check
    expect(section).toContain("two concurrent branches"); // sequence, don't parallelize
    expect(section).toContain("git merge origin/main"); // merge main first
    expect(section).toContain("file-by-file"); // reconciliation disclosure
    expect(section).toContain("test:container"); // full-suite + container tier on reconcile
    expect(section).toContain("Supersedes recent work"); // recent-rewrite justification
    expect(section).toContain("7 days"); // the recency window
  });
});
