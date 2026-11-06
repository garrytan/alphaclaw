const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

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
      `    printf "ASKPASS_USER=%s\\n" "$("$GIT_ASKPASS" "Username for 'https://github.com': ")"`,
      `    printf "ASKPASS_PASS=%s\\n" "$("$GIT_ASKPASS" "Password for 'https://github.com': ")"`,
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
    const { buildHostileEnv } = require("./fixtures/hostile-env");
    fs.writeFileSync(
      path.join(repoRoot, ".env"),
      buildHostileEnv({ pwnedPath }),
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

  it("reads a single-quoted GITHUB_TOKEN with bash's '\\'' escape the way bash does", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-root-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".env"), "GITHUB_TOKEN='ghp a'\\''b $x'\n");

    const harness = createBehaviorHarness({ repoRoot });
    const env = spawnEnv();
    delete env.GITHUB_TOKEN;
    execFileSync(harness.shimPath, ["-C", repoRoot, "push", "origin", "main"], {
      cwd: outsideDir,
      env,
      stdio: "pipe",
    });

    expect(fs.readFileSync(harness.logPath, "utf8")).toContain("ASKPASS_PASS=ghp a'b $x\n");
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

  describe("absolute paths through symlinked directories (GST-1654)", () => {
    const kSystemGit = String(execFileSync("sh", ["-c", "command -v git"])).trim();

    const createSymlinkFixture = () => {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-git-symlink-")));
      const repoRoot = path.join(base, "stronghold", "repo");
      const workspaceDir = path.join(repoRoot, "workspace");
      const outsideDir = path.join(base, "outside");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "note.md"), "note\n");
      fs.writeFileSync(path.join(outsideDir, "stray.md"), "stray\n");
      fs.symlinkSync(workspaceDir, path.join(base, "workspace-link"));
      fs.symlinkSync(repoRoot, path.join(base, "repo-link"));
      fs.symlinkSync(outsideDir, path.join(base, "outside-link"));
      fs.symlinkSync("workspace/note.md", path.join(repoRoot, "note-link"));
      execFileSync(kSystemGit, ["init", "-q", repoRoot], { env: spawnEnv(), stdio: "pipe" });

      const logPath = path.join(base, "git.log");
      const loggingGitPath = path.join(base, "git.real");
      fs.writeFileSync(
        loggingGitPath,
        [
          "#!/bin/sh",
          `printf 'CALL\\n' >> ${shellQuote(logPath)}`,
          `for arg in "$@"; do printf 'ARG=%s\\n' "$arg" >> ${shellQuote(logPath)}; done`,
          `exec ${shellQuote(kSystemGit)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const shimPath = path.join(base, "git");
      fs.writeFileSync(
        shimPath,
        fs
          .readFileSync(kGitShimPath, "utf8")
          .replace('REAL_GIT_HINT="@@REAL_GIT@@"', `REAL_GIT_HINT="${loggingGitPath}"`)
          .replace('OPENCLAW_REPO_ROOT="@@OPENCLAW_REPO_ROOT@@"', `OPENCLAW_REPO_ROOT="${repoRoot}"`)
          .replace('ASKPASS_PATH="@@ASKPASS_PATH@@"', `ASKPASS_PATH="${kGitAskPassPath}"`),
        { mode: 0o755 },
      );

      const env = spawnEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
      delete env.GITHUB_TOKEN;
      delete env.ALPHACLAW_REAL_GIT;
      const run = (args, cwd) => spawnSync(shimPath, args, { cwd, env, encoding: "utf8" });
      const lastCallArgs = () =>
        fs
          .readFileSync(logPath, "utf8")
          .split("CALL\n")
          .pop()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.replace(/^ARG=/, ""));
      const staged = () =>
        String(
          execFileSync(kSystemGit, ["-C", repoRoot, "ls-files", "-s"], { env, stdio: "pipe" }),
        );
      return { base, repoRoot, workspaceDir, outsideDir, run, lastCallArgs, staged };
    };

    it("maps a path through a symlinked dir onto the physical repo it points into", () => {
      const fx = createSymlinkFixture();
      const linkedPath = path.join(fx.base, "workspace-link", "note.md");

      const result = fx.run(["add", linkedPath], fx.repoRoot);

      expect(result.stderr).not.toContain("outside repository");
      expect(result.status).toBe(0);
      expect(fx.lastCallArgs()).toEqual(["add", path.join(fx.workspaceDir, "note.md")]);
      expect(fx.staged()).toContain("workspace/note.md");
    });

    it("accepts paths when the repo itself is reached through a symlink", () => {
      const fx = createSymlinkFixture();
      const linkedCwd = path.join(fx.base, "repo-link", "workspace");
      const physicalPath = path.join(fx.workspaceDir, "note.md");

      const physicalResult = fx.run(["add", physicalPath], linkedCwd);
      expect(physicalResult.status).toBe(0);
      expect(fx.lastCallArgs()).toEqual(["add", physicalPath]);

      const linkedResult = fx.run(
        ["-C", linkedCwd, "rm", "-q", "--cached", path.join(fx.base, "workspace-link", "note.md")],
        fx.base,
      );
      expect(linkedResult.stderr).not.toContain("outside repository");
      expect(linkedResult.status).toBe(0);
      expect(fx.lastCallArgs()).toEqual(["-C", linkedCwd, "rm", "-q", "--cached", physicalPath]);
      expect(fx.staged()).toBe("");
    });

    it("maps a not-yet-existing file under a symlinked dir via its nearest existing ancestor", () => {
      const fx = createSymlinkFixture();
      const newPath = path.join(fx.base, "workspace-link", "new-dir", "deeper", "new.md");

      const result = fx.run(["status", "--short", "--", newPath], fx.repoRoot);

      expect(result.stderr).not.toContain("outside repository");
      expect(result.stderr).not.toContain("Invalid path");
      expect(result.status).toBe(0);
      expect(fx.lastCallArgs()).toEqual([
        "status",
        "--short",
        "--",
        path.join(fx.workspaceDir, "new-dir", "deeper", "new.md"),
      ]);
    });

    it("still refuses a path that is truly outside the repo, symlinked or not", () => {
      const fx = createSymlinkFixture();
      for (const outsidePath of [
        path.join(fx.outsideDir, "stray.md"),
        path.join(fx.base, "outside-link", "stray.md"),
      ]) {
        const result = fx.run(["add", outsidePath], fx.repoRoot);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("outside repository");
        expect(fx.lastCallArgs()).toEqual(["add", outsidePath]);
      }
      expect(fx.staged()).toBe("");
    });

    it("keeps commit messages and symlinks inside the repo as written", () => {
      const fx = createSymlinkFixture();
      const linkedPath = path.join(fx.base, "workspace-link", "note.md");
      const physicalParentPath = `${fx.base}/workspace-link/../note-link`;
      expect(fx.run(["add", physicalParentPath], fx.repoRoot).status).toBe(0);
      expect(fx.lastCallArgs()).toEqual(["add", path.join(fx.repoRoot, "note-link")]);
      expect(fx.staged()).toMatch(/^120000 \S+ 0\tnote-link$/m);

      const commit = fx.run(
        ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", linkedPath],
        fx.repoRoot,
      );
      expect(commit.status).toBe(0);
      expect(fx.lastCallArgs()).toEqual([
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "-m",
        linkedPath,
      ]);
    });

    it("never rewrites a newline-ending path or a bundled -m message", () => {
      const fx = createSymlinkFixture();
      const notePath = path.join(fx.workspaceDir, "note.md");
      execFileSync(kSystemGit, ["-C", fx.repoRoot, "add", notePath], { stdio: "pipe" });

      const newlinePath = `${path.join(fx.base, "workspace-link", "note.md")}\n`;
      const rm = fx.run(["rm", "-q", "-f", "--", newlinePath], fx.repoRoot);
      expect(rm.status).not.toBe(0);
      expect(fx.lastCallArgs()).toEqual(["rm", "-q", "-f", "--", newlinePath.trimEnd()]);
      expect(fs.existsSync(notePath)).toBe(true);
      expect(fx.staged()).toContain("workspace/note.md");

      const plainDir = path.join(fx.repoRoot, "sub");
      const newlineDir = `${plainDir}\n`;
      fs.mkdirSync(plainDir);
      fs.mkdirSync(newlineDir);
      fs.writeFileSync(path.join(plainDir, "f"), "plain\n");
      fs.writeFileSync(path.join(newlineDir, "f"), "newline\n");
      execFileSync(kSystemGit, ["-C", fx.repoRoot, "add", "--", "sub/f", "sub\n/f"], { stdio: "pipe" });
      fs.symlinkSync(newlineDir, path.join(fx.base, "newline-dir-link"));
      const viaNewlineDir = path.join(fx.base, "newline-dir-link", "f");
      const rmViaDir = fx.run(["rm", "-q", "-f", viaNewlineDir], fx.repoRoot);
      expect(rmViaDir.status).not.toBe(0);
      expect(fx.lastCallArgs()).toEqual(["rm", "-q", "-f", viaNewlineDir]);
      expect(fs.existsSync(path.join(plainDir, "f"))).toBe(true);
      expect(fx.staged()).toMatch(/\tsub\/f$/m);

      const linkedPath = path.join(fx.base, "workspace-link", "note.md");
      const commit = fx.run(
        ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", linkedPath],
        fx.repoRoot,
      );
      expect(commit.status).toBe(0);
      expect(fx.lastCallArgs().slice(-2)).toEqual(["-qam", linkedPath]);

      const amend = fx.run(
        ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--amend", "--mess", linkedPath],
        fx.repoRoot,
      );
      expect(amend.status).toBe(0);
      expect(fx.lastCallArgs().slice(-2)).toEqual(["--mess", linkedPath]);
    });
  });

  it("contains valid shell syntax for git askpass script", () => {
    execFileSync("sh", ["-n", kGitAskPassPath], { stdio: "pipe" });
    const content = fs.readFileSync(kGitAskPassPath, "utf8");
    expect(content).toContain("host=${authority##*@}");
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

    const ask = (prompt) =>
      String(
        execFileSync("sh", [kGitAskPassPath, prompt], {
          env: { ...cleanProcessEnv(), GITHUB_TOKEN: "ghp_secret" },
          stdio: "pipe",
        }),
      );

    it.each([
      "https://github.com",
      "https://github.com/org/repo.git",
      "https://x-access-token@github.com",
      "https://user@github.com:443/org/repo.git",
    ])("answers Git's exact HTTPS prompts for %s", (url) => {
      expect(ask(`Username for '${url}': `)).toBe("x-access-token");
      expect(ask(`Password for '${url}': `)).toBe("ghp_secret");
    });

    it.each([
      "https://attacker.invalid",
      "https://github.com.attacker.invalid",
      "https://evilgithub.com",
      "https://github.com@attacker.invalid",
      "https://attacker.invalid/github.com",
      "https://attacker.invalid/path@github.com",
      "https://attacker.invalid?@github.com",
      "https://attacker.invalid#@github.com",
      "https://github.com:8443",
      "http://github.com",
      "https://github.com\\@attacker.invalid",
      "https://github.com\n.attacker.invalid",
    ])("answers nothing for an untrusted authority: %s", (url) => {
      expect(ask(`Username for '${url}': `)).toBe("");
      expect(ask(`Password for '${url}': `)).toBe("");
    });

    it.each([
      "",
      "Password",
      "Password for https://github.com",
      "prefix Password for 'https://github.com': ",
    ])("answers nothing for a malformed prompt: %j", (prompt) => {
      expect(ask(prompt)).toBe("");
    });

    it("answers real Git credential prompts without contacting a server", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-askpass-"));
      const script = path.join(dir, "askpass");
      fs.copyFileSync(kGitAskPassPath, script);
      fs.chmodSync(script, 0o700);
      try {
        const env = {
          ...cleanProcessEnv(),
          GIT_ASKPASS: script,
          GIT_TERMINAL_PROMPT: "0",
          GITHUB_TOKEN: "ghp_secret",
          LC_ALL: "C",
        };
        const args = ["-c", "credential.helper=", "credential", "fill"];
        const fill = (host) =>
          execFileSync("git", args, {
            env,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            input: `protocol=https\nhost=${host}\n\n`,
          });
        const granted = fill("github.com");
        expect(granted).toContain("username=x-access-token");
        expect(granted).toContain("password=ghp_secret");
        for (const host of ["attacker.invalid", "github.com.attacker.invalid"]) {
          const denied = fill(host);
          expect(denied).not.toContain("ghp_secret");
          expect(denied).not.toContain("x-access-token");
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
