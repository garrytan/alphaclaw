// Write the tree.json a gstack run profile reads (gstack docs/pregate.md,
// "Run evidence" and "CI carry"): which run tested which git tree, and every
// test file it ran. /ship carries a lane that .gstack/pregate.json maps in
// `ship_lanes_from` from this record instead of running the suite again, so it
// is written only from a green report: a failed test, an empty report or a
// checkout that is not the commit the run names is an error, never a record.
//
// Usage: node scripts/ci/tested-tree.mjs [--root <dir>] --out <tree.json> <vitest report.json>
// Reads GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_EVENT_NAME, GITHUB_SHA,
// RUNNER_OS and, on a pull_request run, PR_HEAD_SHA (GitHub tests the merge
// commit, GITHUB_SHA; the verifier accepts it only when its tree is the head's).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const kSha = /^[0-9a-f]{40}$/;

export const buildTreeRecord = (report, { root, env, head, tree }) => {
  if (!report?.testResults?.length) throw new Error("the report lists no test files");
  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0) {
    throw new Error(`the report is not green (${report.numFailedTests} failed tests, ${report.numFailedTestSuites} failed files)`);
  }
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isInteger(runId) || runId <= 0 || !Number.isInteger(runAttempt) || runAttempt <= 0) {
    throw new Error("GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be positive integers");
  }
  const event = env.GITHUB_EVENT_NAME;
  if (!["push", "pull_request", "workflow_dispatch"].includes(event)) throw new Error(`unsupported event ${event}`);
  const sha = env.GITHUB_SHA;
  if (!kSha.test(sha ?? "") || head !== sha) throw new Error(`the checkout (${head}) is not the run's commit (${sha})`);
  const headSha = event === "pull_request" ? env.PR_HEAD_SHA : sha;
  if (!kSha.test(headSha ?? "")) throw new Error("a pull_request run needs PR_HEAD_SHA");
  if (!kSha.test(tree ?? "")) throw new Error(`not a tree id: ${tree}`);
  const files = report.testResults
    .filter((result) => result.status === "passed")
    .map((result) => path.relative(root, result.name).split(path.sep).join("/"))
    .sort();
  if (!files.length) throw new Error("no test file passed");
  return {
    run_id: runId,
    run_attempt: runAttempt,
    event,
    sha,
    head_sha: headSha,
    tree,
    os: env.RUNNER_OS,
    files,
    tests: report.numPassedTests,
  };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args.splice(i, 2)[1];
  };
  const out = take("--out");
  const root = path.resolve(take("--root") ?? process.cwd());
  if (!out || args.length !== 1) {
    console.error("usage: tested-tree.mjs [--root <dir>] --out <tree.json> <vitest report.json>");
    process.exit(2);
  }
  const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
  try {
    const record = buildTreeRecord(JSON.parse(readFileSync(args[0], "utf8")), {
      root,
      env: process.env,
      head: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
    });
    writeFileSync(out, JSON.stringify(record, null, 1) + "\n");
    console.log(`tested tree ${record.tree}: ${record.files.length} files, ${record.tests} tests -> ${out}`);
  } catch (err) {
    console.error(`tested-tree ERROR: ${err.message}`);
    process.exit(1);
  }
}
