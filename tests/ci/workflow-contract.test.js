const { readFileSync } = require("node:fs");
const path = require("node:path");

// Structural guards over the merge-gate CI (which cannot be executed in the
// hermetic suite). They pin the contract the GitHub ruleset binds to — a
// rename that breaks a required check should fail HERE, in the PR that makes
// it, not silently at merge time.
const wf = (name) =>
  readFileSync(
    path.join(__dirname, "..", "..", ".github", "workflows", name),
    "utf8",
  );

describe("ci/merge-gate workflow contract", () => {
  it("ci.yml keeps the required check name 'test (22)' and runs the version guard on PRs", () => {
    const ci = wf("ci.yml");
    // The ruleset requires the context "test (22)" (job `test`, node matrix [22]).
    expect(ci).toMatch(/job.*\n\s*test:|^\s{2}test:/m);
    expect(ci).toMatch(/node-version:\s*\[22\]/);
    expect(ci).toContain("assert-version-advances.mjs");
    expect(ci).toMatch(/if:\s*github\.event_name == 'pull_request'/);
  });

  it("container-e2e keeps the always-running 'gate' aggregator and covers the boot-journey paths", () => {
    const c = wf("container-e2e.yml");
    // `gate` is the required context (container-e2e itself is conditionally skipped).
    expect(c).toMatch(/^\s{2}gate:/m);
    expect(c).toMatch(/if:\s*always\(\)/);
    // The widened filter must cover the surfaces the boot journey exercises.
    for (const p of [
      "lib/server/watchdog",
      "lib/server/doctor",
      "lib/server/routes/",
      "lib/server\\.js",
    ]) {
      expect(c).toContain(p);
    }
  });

  it("the soak gate stays removed (v0.9.65 owner decision — see AGENTS.md merge-gate section)", () => {
    // soak.yml (v0.9.62) was deleted deliberately, not lost in a refactor.
    // This inverse pin keeps a well-meaning cleanup from resurrecting it and
    // silently re-imposing the 2h RED-until-ripe merge window.
    expect(() => wf("soak.yml")).toThrow(/ENOENT/);
  });

  it("tag-release.yml tags on main push and trips on a duplicate-version collision", () => {
    const t = wf("tag-release.yml");
    expect(t).toMatch(/branches:\s*\[main\]/);
    expect(t).toContain("contents: write");
    expect(t).toContain('git tag "$tag"');
    // The renumber-race tripwire: same tag, different sha → fail.
    expect(t).toMatch(/already exists at .* but this push is/);
  });
});
