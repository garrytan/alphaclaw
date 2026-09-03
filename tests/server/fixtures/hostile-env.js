// ONE hostile .env fixture shared by the two shell-parser suites
// (hourly-git-sync.test.js and git-shim.test.js) so the twin parsers in
// lib/setup/hourly-git-sync.sh and lib/scripts/git cannot drift apart
// silently (issue #26 [5A]). Every shape here is a real-world case:
// spaced values (the incident's NODE_OPTIONS), command substitution (root
// code execution if ever evaluated), quoted values (the tested dequoting
// contract), comments, blanks, invalid lines, and last-wins duplicates.
const buildHostileEnv = ({ pwnedPath, githubToken = "ghp_env_token_2" }) =>
  [
    "# comment line",
    "",
    "NODE_OPTIONS=--max-old-space-size=8192 --heapsnapshot-signal=SIGUSR2",
    `LD_PRELOAD=$(touch "${pwnedPath}")`,
    "GITHUB_TOKEN=ghp_first",
    // Last assignment wins, matching the JS reader's dedupe.
    `GITHUB_TOKEN='${githubToken}'`,
    "GITHUB_WORKSPACE_REPO=owner/repo with spaces",
    "OPENCLAW_STATE_DIR='/data/.openclaw'",
    "not a valid line",
    "1BADKEY=nope",
  ].join("\n");

module.exports = { buildHostileEnv };
