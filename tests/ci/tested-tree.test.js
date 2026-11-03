const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "..", "scripts", "ci", "tested-tree.mjs"));

const kHead = "a".repeat(40);
const kMerge = "b".repeat(40);
const kTree = "c".repeat(40);

const report = (overrides = {}) => ({
  success: true,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numPassedTests: 5,
  testResults: [
    { name: "/r/tests/server/b.test.js", status: "passed", assertionResults: [{ status: "passed" }, { status: "skipped" }] },
    { name: "/r/tests/a.test.js", status: "passed", assertionResults: [{ status: "passed" }] },
    { name: "/r/tests/skipped.test.js", status: "passed", assertionResults: [{ status: "skipped" }, { status: "pending" }, { status: "todo" }] },
  ],
  ...overrides,
});

const env = (overrides = {}) => ({
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_EVENT_NAME: "push",
  GITHUB_SHA: kHead,
  RUNNER_OS: "Linux",
  ...overrides,
});

describe("ci/tested-tree", () => {
  it("records a push run's tree with every file that ran a passing test, repo-relative and sorted", async () => {
    const { buildTreeRecord } = await load();
    expect(buildTreeRecord(report(), { root: "/r", env: env(), head: kHead, tree: kTree })).toEqual({
      run_id: 123,
      run_attempt: 2,
      event: "push",
      sha: kHead,
      head_sha: kHead,
      tree: kTree,
      os: "Linux",
      files: ["tests/a.test.js", "tests/server/b.test.js"],
      tests: 5,
    });
  });

  it("names the merge commit as sha and the pull request head as head_sha on a pull_request run", async () => {
    const { buildTreeRecord } = await load();
    const record = buildTreeRecord(report(), {
      root: "/r",
      env: env({ GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: kMerge, PR_HEAD_SHA: kHead }),
      head: kMerge,
      tree: kTree,
    });
    expect(record).toMatchObject({ event: "pull_request", sha: kMerge, head_sha: kHead, tree: kTree });
    expect(() =>
      buildTreeRecord(report(), { root: "/r", env: env({ GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: kMerge }), head: kMerge, tree: kTree }),
    ).toThrow(/PR_HEAD_SHA/);
  });

  it("writes no record from a red or empty report", async () => {
    const { buildTreeRecord } = await load();
    const opts = { root: "/r", env: env(), head: kHead, tree: kTree };
    expect(() => buildTreeRecord(report({ success: false, numFailedTests: 1 }), opts)).toThrow(/not green/);
    expect(() => buildTreeRecord(report({ numFailedTestSuites: 1 }), opts)).toThrow(/not green/);
    expect(() => buildTreeRecord(report({ testResults: [] }), opts)).toThrow(/no test files/);
    expect(() =>
      buildTreeRecord(report({ testResults: [{ name: "/r/tests/a.test.js", status: "passed", assertionResults: [{ status: "skipped" }] }] }), opts),
    ).toThrow(/no test file ran a passing test/);
  });

  it("refuses a checkout that is not the commit the run names, a malformed run id or tree, and an unsupported event", async () => {
    const { buildTreeRecord } = await load();
    expect(() => buildTreeRecord(report(), { root: "/r", env: env(), head: kMerge, tree: kTree })).toThrow(/not the run's commit/);
    expect(() => buildTreeRecord(report(), { root: "/r", env: env({ GITHUB_SHA: "" }), head: "", tree: kTree })).toThrow(/not the run's commit/);
    expect(() => buildTreeRecord(report(), { root: "/r", env: env(), head: kHead, tree: "nope" })).toThrow(/not a tree id/);
    expect(() => buildTreeRecord(report(), { root: "/r", env: env({ GITHUB_EVENT_NAME: "schedule" }), head: kHead, tree: kTree })).toThrow(/unsupported event/);
    expect(() => buildTreeRecord(report(), { root: "/r", env: env({ GITHUB_RUN_ID: "" }), head: kHead, tree: kTree })).toThrow(/positive integers/);
  });
});
