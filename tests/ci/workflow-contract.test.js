const { readFileSync, readdirSync } = require("node:fs");
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
  it("ci.yml keeps the required check name 'test (24)', runs Node 26 as a non-blocking lane, and runs the version guard on PRs", () => {
    const ci = wf("ci.yml");
    // The ruleset requires the context "test (24)" (job `test`, node matrix
    // leading with 24 — v0.9.80 moved the runtime floor to Node 24.16 for the
    // OpenClaw 2026.9.3 pin; Node 22 left the matrix). Node 26 is the
    // early-warning lane (fix wave F178 pattern): it must stay non-blocking
    // until the ruleset lists "test (26)" as required.
    expect(ci).toMatch(/job.*\n\s*test:|^\s{2}test:/m);
    expect(ci).toMatch(/node-version:\s*\[24,\s*26\]/);
    expect(ci).not.toMatch(/node-version:\s*\[22/);
    expect(ci).toMatch(/continue-on-error:\s*\$\{\{\s*matrix\.node-version == 26\s*\}\}/);
    expect(ci).toMatch(/fail-fast:\s*false/);
    expect(ci).toContain("assert-version-advances.mjs");
    expect(ci).toMatch(/if:\s*github\.event_name == 'pull_request' && matrix\.node-version == 24/);
  });

  it("every live/container workflow runs the Node the pinned OpenClaw requires (>=24.22.1)", () => {
    // OpenClaw 2026.10.6 declares `>=24.22.1 <25 || >=26.12.1`; a lane below
    // it spawns a CLI whose `gateway run` exits 1 and fails every real install.
    for (const name of ["container-e2e.yml", "live-e2e.yml"]) {
      const text = wf(name);
      expect(text, name).not.toMatch(/node-version:\s*22\b/);
      expect(text, name).toMatch(/node-version:\s*24\b/);
    }
  });

  it("every setup-node step resolves the newest patch (the runner's cached Node can sit below the pin's floor)", () => {
    for (const name of ["ci.yml", "container-e2e.yml", "live-e2e.yml"]) {
      const text = wf(name);
      const steps = text.split("uses: actions/setup-node").slice(1);
      expect(steps.length, name).toBeGreaterThan(0);
      for (const step of steps) expect(step.split(/\n\s*- /)[0], name).toMatch(/check-latest:\s*true/);
    }
  });

  it("every workflow that runs third-party code holds a read-only token (fix wave F177)", () => {
    for (const name of ["ci.yml", "container-e2e.yml", "live-e2e.yml"]) {
      expect(wf(name), name).toMatch(/^permissions:\n\s+contents: read/m);
    }
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
      // The bin-phase boot spine the durability journey seeds against.
      "lib/server/boot-",
      "lib/server/server-pidfile\\.js",
      // The journey waits on login.html (fix wave F173).
      "lib/public/login\\.html",
    ]) {
      expect(c).toContain(p);
    }
    // A pin bump is a CONTENT match on the openclaw dependency line — never
    // the bare `package.json` path, which every version bump touches.
    expect(c).toMatch(/git diff .*-- package\.json \| grep -qE '\^\[-\+\]\\s\*"openclaw":'/);
    expect(c).not.toMatch(/pattern='[^']*package\.json/);
  });

  it("container-e2e runs one job per shard-map leg, each with exactly its own files, and covers every container test file once", () => {
    const c = wf("container-e2e.yml");
    const { legs } = JSON.parse(
      readFileSync(path.join(__dirname, "..", "container", "shards.json"), "utf8"),
    );
    const matrixLegs = c.match(/leg:\s*\[([^\]]+)\]/)[1].split(",").map((leg) => leg.trim());
    expect(matrixLegs.sort()).toEqual(Object.keys(legs).sort());
    const sharded = Object.values(legs).flatMap((leg) => leg.files);
    expect(Object.values(legs).every((leg) => leg.files.length > 0)).toBe(true);
    expect(new Set(sharded).size).toBe(sharded.length);
    const containerFiles = readdirSync(path.join(__dirname, "..", "container"))
      .filter((name) => name.endsWith(".test.js"))
      .map((name) => `tests/container/${name}`);
    expect(sharded.sort()).toEqual(containerFiles.sort());
    // Vitest gets the leg's files only: the test:container script's own
    // tests/container argument would select every file in every leg.
    expect(c).toMatch(/npx vitest run --no-file-parallelism \$LEG_FILES/);
    expect(c).not.toMatch(/run:\s*npm run test:container/);
    expect(c).toMatch(/OPENCLAW_CONTAINER_E2E: "1"/);
    expect(c).toMatch(/fail-fast:\s*false/);
    expect(c).toMatch(/upload-artifact[\s\S]*if: always\(\)[\s\S]*name: container-e2e-artifacts-\$\{\{ matrix\.leg \}\}/);
    expect(c).toMatch(/gate:[\s\S]*needs: \[filter, container-e2e\]/);
    // Edits that change what the tier runs also run it.
    expect(c).toContain("vitest\\.config\\.js");
    expect(c).toContain("\\.github/workflows/container-e2e\\.yml");
    expect(c).toMatch(/grep -qE '\^\[-\+\]\\s\*"test:container":'/);
  });

  it("ci.yml records a test inventory on every run, publishes main's, guards PRs against the exact base, and covers main", () => {
    const ci = wf("ci.yml");
    expect(ci).toMatch(/^permissions:\n\s+contents: read\n(\s+#.*\n)*\s+actions: read/m);
    expect(ci).toContain("npm test -- --reporter=default --reporter=json --outputFile=test-reports/vitest.json");
    expect(ci).toContain("node scripts/ci/test-inventory.mjs --out test-reports/inventory.json test-reports/vitest.json");
    expect(ci).toMatch(/if: always\(\) && github\.event_name == 'push' && matrix\.node-version == 24[^\n]*\n\s+with:\n\s+name: test-inventory-node24/);
    const guard = ci.split("name: Test inventory guard")[1].split(/\n\s{2}\w/)[0];
    expect(guard).toMatch(/if: github\.event_name == 'pull_request' && matrix\.node-version == 24/);
    expect(guard).toContain("BASE_SHA: ${{ github.event.pull_request.base.sha }}");
    expect(guard).toMatch(/INVENTORY_GUARD: (report|enforce)/);
    expect(guard).toContain("run: bash scripts/ci/inventory-guard.sh");
    expect(ci).toMatch(/^\s{2}coverage:\n\s+if: github\.event_name == 'push'/m);
    expect(ci).toContain("--coverage.reportOnFailure=true --coverage.reporter=json");
    expect(readFileSync(path.join(__dirname, "..", "..", "vitest.config.js"), "utf8")).toContain('"tests/setup-inventory.js"');
  });

  it("live-e2e lifts the runner's user-namespace restriction with the heartbeat test's own probe and keeps its JSON report", () => {
    const live = wf("live-e2e.yml");
    const probeFlags = readFileSync(
      path.join(__dirname, "..", "live", "gateway-stale-heartbeat-relaunch.e2e.test.js"),
      "utf8",
    ).match(/kNamespaceFlags = \[([^\]]+)\]/)[1].match(/"([^"]+)"/g).map((flag) => flag.slice(1, -1));
    expect(live).toMatch(/runs-on:\s*ubuntu-24\.04/);
    expect(live).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(live).toContain(`unshare ${probeFlags.join(" ")} true`);
    expect(live).toMatch(/npm run test:live -- --reporter=default --reporter=json --outputFile=tests\/live\/artifacts\/report\.json/);
    expect(live).toMatch(/upload-artifact[\s\S]*if: always\(\)[\s\S]*path: tests\/live\/artifacts\//);
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
