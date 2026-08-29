const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Hosts that drive git through their own credential helper (e.g. Conductor
// exports GIT_ASKPASS/ASKPASS_*) leak those vars into every child env. These
// tests assert what the SHIM injects, so ambient auth vars must be scrubbed
// before spreading — otherwise "does not inject auth" sees the host's
// credentials and fails on a machine that never touched the shim.
const cleanProcessEnv = () => {
  const env = { ...process.env };
  delete env.GIT_ASKPASS;
  delete env.ASKPASS_USER;
  delete env.ASKPASS_PASS;
  delete env.GIT_TERMINAL_PROMPT;
  return env;
};

const kGitShimPath = path.join(__dirname, "../../lib/scripts/git");
const kGitAskPassPath = path.join(__dirname, "../../lib/scripts/git-askpass");

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;

// A host environment can carry its own git auth (e.g. Conductor sandboxes
// export GIT_ASKPASS pointing at a live credential broker). The fake
// git.real probes $GIT_ASKPASS, so inherited host auth would pollute the
// logs and break the no-injection assertions — every spawn strips the
// git-auth vars the shim itself is responsible for setting (the full
// cleanProcessEnv scrub, including ambient ASKPASS_USER/ASKPASS_PASS).
const spawnEnv = (overrides = {}) => ({ ...cleanProcessEnv(), ...overrides });

const createBehaviorHarness = ({ repoRoot }) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-shim-"));
  const logPath = path.join(tempRoot, "git.log");
  const askPassPath = path.join(tempRoot, "git-askpass.sh");
  const realGitPath = path.join(tempRoot, "git.real");
  const shimPath = path.join(tempRoot, "git");

  fs.copyFileSync(kGitAskPassPath, askPassPath);
  fs.chmodSync(askPassPath, 0o755);

  fs.writeFileSync(
    realGitPath,
    [
      "#!/bin/sh",
      "{",
      '  printf "PWD=%s\\n" "$PWD"',
      "  i=1",
      '  for arg in "$@"; do',
      '    printf "ARG_%s=%s\\n" "$i" "$arg"',
      "    i=$((i + 1))",
      "  done",
      '  printf "GIT_ASKPASS=%s\\n" "${GIT_ASKPASS:-}"',
      '  printf "GIT_TERMINAL_PROMPT=%s\\n" "${GIT_TERMINAL_PROMPT:-}"',
      '  if [ -n "${GIT_ASKPASS:-}" ]; then',
      '    printf "ASKPASS_USER=%s\\n" "$("$GIT_ASKPASS" "Username for https://github.com")"',
      '    printf "ASKPASS_PASS=%s\\n" "$("$GIT_ASKPASS" "Password for https://github.com")"',
      "  fi",
      `} > ${shellQuote(logPath)}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const shimTemplate = fs.readFileSync(kGitShimPath, "utf8");
  const shimContent = shimTemplate
    .replace('REAL_GIT_HINT="@@REAL_GIT@@"', `REAL_GIT_HINT="${realGitPath}"`)
    .replace('OPENCLAW_REPO_ROOT="@@OPENCLAW_REPO_ROOT@@"', `OPENCLAW_REPO_ROOT="${repoRoot}"`)
    .replace('ASKPASS_PATH="@@ASKPASS_PATH@@"', `ASKPASS_PATH="${askPassPath}"`);
  fs.writeFileSync(shimPath, shimContent, { mode: 0o755 });

  return { tempRoot, logPath, shimPath };
};

describe("server git shim scripts", () => {
  it("keeps install-time placeholders in the shim template", () => {
    const content = fs.readFileSync(kGitShimPath, "utf8");
    expect(content).toContain('REAL_GIT_HINT="@@REAL_GIT@@"');
    expect(content).toContain('OPENCLAW_REPO_ROOT="@@OPENCLAW_REPO_ROOT@@"');
    expect(content).toContain('ASKPASS_PATH="@@ASKPASS_PATH@@"');
  });

  it("passes auth through for git -C repo push commands", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-root-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const harness = createBehaviorHarness({ repoRoot });
    execFileSync(harness.shimPath, ["-C", repoRoot, "push", "origin", "main"], {
      cwd: outsideDir,
      env: spawnEnv({ GITHUB_TOKEN: "ghp_test_token" }),
      stdio: "pipe",
    });

    const log = fs.readFileSync(harness.logPath, "utf8");
    expect(log).toContain(`ARG_1=-C`);
    expect(log).toContain(`ARG_2=${repoRoot}`);
    expect(log).toContain("ARG_3=push");
    expect(log).toContain("GIT_TERMINAL_PROMPT=0");
    expect(log).toContain("ASKPASS_USER=x-access-token");
    expect(log).toContain("ASKPASS_PASS=ghp_test_token");
  });

  it("passes auth through for git -c key=value -C repo push commands", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-root-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const harness = createBehaviorHarness({ repoRoot });
    execFileSync(harness.shimPath, ["-c", "http.extraHeader=test", "-C", repoRoot, "push", "origin", "main"], {
      cwd: outsideDir,
      env: spawnEnv({ GITHUB_TOKEN: "ghp_test_token" }),
      stdio: "pipe",
    });

    const log = fs.readFileSync(harness.logPath, "utf8");
    expect(log).toContain("ARG_1=-c");
    expect(log).toContain("ARG_2=http.extraHeader=test");
    expect(log).toContain("ARG_3=-C");
    expect(log).toContain(`ARG_4=${repoRoot}`);
    expect(log).toContain("ARG_5=push");
    expect(log).toContain("GIT_TERMINAL_PROMPT=0");
    expect(log).toContain("ASKPASS_PASS=ghp_test_token");
  });

  it("loads GITHUB_TOKEN from repo .env when exec env is sanitized", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-root-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".env"), 'GITHUB_TOKEN="ghp_env_token"\n');

    const harness = createBehaviorHarness({ repoRoot });
    const env = spawnEnv();
    delete env.GITHUB_TOKEN;
    execFileSync(harness.shimPath, ["-C", repoRoot, "push", "origin", "main"], {
      cwd: outsideDir,
      env,
      stdio: "pipe",
    });

    const log = fs.readFileSync(harness.logPath, "utf8");
    expect(log).toContain("ARG_1=-C");
    expect(log).toContain(`ARG_2=${repoRoot}`);
    expect(log).toContain("ARG_3=push");
    expect(log).toContain("GIT_TERMINAL_PROMPT=0");
    expect(log).toContain("ASKPASS_PASS=ghp_env_token");
  });

  it("parses .env without executing values and extracts only GITHUB_TOKEN (issue #26 sibling)", () => {
    // The shim used to `. .env` with errors hidden — a spaced value silently
    // dropped the var and $(…) in ANY value executed with the agent's
    // privileges. The parser must survive both and export nothing else.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-root-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideDir = path.join(tempRoot, "outside");
    const pwnedPath = path.join(tempRoot, "pwned");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".env"),
      [
        "NODE_OPTIONS=--max-old-space-size=8192 --heapsnapshot-signal=SIGUSR2",
        `LD_PRELOAD=$(touch "${pwnedPath}")`,
        "GITHUB_TOKEN=ghp_first",
        // Last assignment wins, matching the JS reader's dedupe.
        "GITHUB_TOKEN='ghp_env_token_2'",
        "",
      ].join("\n"),
    );

    const harness = createBehaviorHarness({ repoRoot });
    const env = spawnEnv();
    delete env.GITHUB_TOKEN;
    delete env.NODE_OPTIONS;
    execFileSync(harness.shimPath, ["-C", repoRoot, "push", "origin", "main"], {
      cwd: outsideDir,
      env,
      stdio: "pipe",
    });

    const log = fs.readFileSync(harness.logPath, "utf8");
    expect(log).toContain("ASKPASS_PASS=ghp_env_token_2");
    expect(fs.existsSync(pwnedPath)).toBe(false);
  });

  it("passes auth through when valued global options precede -C repo push commands", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-root-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const harness = createBehaviorHarness({ repoRoot });
    execFileSync(
      harness.shimPath,
      ["--super-prefix=subdir/", "--attr-source", "HEAD", "-C", repoRoot, "push", "origin", "main"],
      {
        cwd: outsideDir,
        env: spawnEnv({ GITHUB_TOKEN: "ghp_test_token" }),
        stdio: "pipe",
      },
    );

    const log = fs.readFileSync(harness.logPath, "utf8");
    expect(log).toContain("ARG_1=--super-prefix=subdir/");
    expect(log).toContain("ARG_2=--attr-source");
    expect(log).toContain("ARG_3=HEAD");
    expect(log).toContain("ARG_4=-C");
    expect(log).toContain(`ARG_5=${repoRoot}`);
    expect(log).toContain("ARG_6=push");
    expect(log).toContain("GIT_TERMINAL_PROMPT=0");
    expect(log).toContain("ASKPASS_PASS=ghp_test_token");
  });

  it("enables auth when the cwd is a symlinked workspace inside the repo root", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-root-"));
    const repoRoot = path.join(tempRoot, "repo");
    const workspaceDir = path.join(repoRoot, "workspace");
    const symlinkRoot = path.join(tempRoot, "home-openclaw");
    const symlinkWorkspaceDir = path.join(symlinkRoot, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.symlinkSync(repoRoot, symlinkRoot);

    const harness = createBehaviorHarness({ repoRoot });
    execFileSync(harness.shimPath, ["push", "origin", "main"], {
      cwd: symlinkWorkspaceDir,
      env: spawnEnv({ GITHUB_TOKEN: "ghp_test_token" }),
      stdio: "pipe",
    });

    const log = fs.readFileSync(harness.logPath, "utf8");
    expect(log).toContain(`PWD=${fs.realpathSync(workspaceDir)}`);
    expect(log).toContain("GIT_TERMINAL_PROMPT=0");
    expect(log).toContain("ASKPASS_PASS=ghp_test_token");
  });

  it("does not inject auth for git commands outside the managed repo root", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-root-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const harness = createBehaviorHarness({ repoRoot });
    execFileSync(harness.shimPath, ["push", "origin", "main"], {
      cwd: outsideDir,
      env: spawnEnv({ GITHUB_TOKEN: "ghp_test_token" }),
      stdio: "pipe",
    });

    const log = fs.readFileSync(harness.logPath, "utf8");
    expect(log).toContain(`PWD=${fs.realpathSync(outsideDir)}`);
    expect(log).toContain("GIT_ASKPASS=");
    expect(log).not.toContain("ASKPASS_USER=");
  });

  it("contains valid shell syntax for git askpass script", () => {
    execFileSync("sh", ["-n", kGitAskPassPath], { stdio: "pipe" });
    const content = fs.readFileSync(kGitAskPassPath, "utf8");
    expect(content).toContain("*Username*)");
    expect(content).toContain("*Password*)");
  });

  // H9: the askpass must answer with the token only for github.com, parsing the
  // host as the authority after the last '@' — a substring check leaks the token
  // to https://github.com@attacker.example/repo.
  describe("git-askpass host binding (H9)", () => {
    const askForPassword = (prompt) =>
      String(
        execFileSync("sh", [kGitAskPassPath, prompt], {
          env: { ...cleanProcessEnv(), GITHUB_TOKEN: "ghp_secret" },
          stdio: "pipe",
        }),
      );

    it("answers the token for a genuine github.com password prompt", () => {
      expect(
        askForPassword("Password for 'https://x-access-token@github.com': "),
      ).toBe("ghp_secret");
    });

    it("does NOT leak the token to an attacker host after github.com@", () => {
      expect(
        askForPassword(
          "Password for 'https://github.com@attacker.example/repo': ",
        ),
      ).toBe("");
    });

    it("does NOT leak the token to a non-github host", () => {
      expect(
        askForPassword("Password for 'https://gitlab.com/a/b': "),
      ).toBe("");
    });

    it("still answers the username prompt for github", () => {
      expect(
        String(
          execFileSync("sh", [kGitAskPassPath, "Username for 'https://github.com': "], {
            env: { ...cleanProcessEnv(), GITHUB_TOKEN: "ghp_secret" },
            stdio: "pipe",
          }),
        ),
      ).toBe("x-access-token");
    });
  });
});
