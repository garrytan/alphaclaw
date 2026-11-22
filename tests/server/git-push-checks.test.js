const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { createGitPushChecks, normalizeGitPushChecksConfig, helperChainOf } = require("../../lib/server/git-push-checks");

// GST-2960: a boot step ran gh auth setup-git, which put gh's helper (the
// box user's GITHUB_TOKEN) at the front of the global credential chain. A
// checkout that pinned its own repository token in .git/config then pushed
// as the wrong user and GitHub answered "Repository not found" for hours,
// unnoticed. These run real git against a temp HOME and a local bare repo;
// only ls-remote is pointed at the bare repo (or made to fail).
const kGlobalToken = "global-token-0123456789";
const kRepoToken = "repo-token-9876543210";
const kGlobalHelper = "!f() { test \"$1\" = get && echo username=garry && echo password=" + kGlobalToken + "; }; f";
const kRepoHelper = "!f() { test \"$1\" = get && echo username=agents && echo password=" + kRepoToken + "; }; f";
const kRemoteUrl = "https://github.com/acme/private.git";

const baseGitEnv = () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_ASKPASS;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return env;
};

const setup = ({ pin = true, reset = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-push-checks-"));
  const home = path.join(root, "home");
  const openclawDir = path.join(root, ".openclaw");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(openclawDir, { recursive: true });
  const env = { ...baseGitEnv(), HOME: home };
  const git = (cwd, args, extraEnv = {}) => execFileSync("git", args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", stdio: "pipe" });
  // What gh auth setup-git writes into the global gitconfig.
  git(root, ["config", "--global", "--add", "credential.https://github.com.helper", ""]);
  git(root, ["config", "--global", "--add", "credential.https://github.com.helper", kGlobalHelper]);
  const bare = path.join(root, "bare.git");
  git(root, ["init", "-q", "--bare", "-b", "main", bare]);
  const work = path.join(root, "work");
  git(root, ["clone", "-q", bare, work]);
  git(work, ["commit", "-q", "--allow-empty", "-m", "seed"]);
  git(work, ["push", "-q", "origin", "main"]);
  git(work, ["remote", "set-url", "origin", kRemoteUrl]);
  if (reset) git(work, ["config", "--local", "--add", "credential.helper", ""]);
  if (pin) git(work, ["config", "--local", "--add", "credential.helper", kRepoHelper]);
  return { root, home, openclawDir, env, git, bare, work };
};

// Real git for everything; ls-remote and the write probe's dry-run push go to
// the local bare repository, or ls-remote fails the way the caller says.
const makeExecFile = (bare, { lsRemote = null, calls = [] } = {}) => (file, args, options, callback) => {
  calls.push(args);
  const index = args.indexOf("ls-remote");
  if (index >= 0 && lsRemote) {
    setImmediate(() => callback(Object.assign(new Error("failed"), { code: 128 }), "", lsRemote));
    return { stdin: { on() {}, end() {} } };
  }
  const pushIndex = args.indexOf("push");
  const remoteIndex = index >= 0 ? index + 2 : pushIndex >= 0 ? args.indexOf("--", pushIndex) + 1 : -1;
  const realArgs = remoteIndex > 0 ? args.map((arg, i) => (i === remoteIndex ? bare : arg)) : args;
  return execFile(file, realArgs, options, callback);
};

const createChecks = (ctx, { config = {}, lsRemote = null, calls = [], nowFn = Date.now } = {}) => {
  const notify = vi.fn(async () => ({ ok: true }));
  const recordEvent = vi.fn();
  const checks = createGitPushChecks({
    openclawDir: ctx.openclawDir,
    readConfig: () => ({ checkouts: [{ path: ctx.work, name: "workspace" }], ...config }),
    getEnv: () => ctx.env,
    notify,
    recordEvent,
    execFileImpl: makeExecFile(ctx.bare, { lsRemote, calls }),
    nowFn,
    logger: { log() {}, warn() {} },
  });
  return { checks, notify, recordEvent };
};

const statePath = (ctx) => path.join(ctx.openclawDir, ".alphaclaw", "git-push-checks.json");

describe("git push checks", () => {
  it("alerts once when a global helper answers ahead of the checkout's own one, and once when the fix lands", async () => {
    const ctx = setup();
    const { checks, notify, recordEvent } = createChecks(ctx);
    const first = await checks.check();
    expect(first.results[0].routing).toMatchObject({ code: "wrong_identity", answered: true, sameUser: false });
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, options] = notify.mock.calls[0];
    expect(message).toContain(ctx.work);
    expect(message).toContain("answers as a different user");
    expect(message).toContain("global config (" + path.join(ctx.home, ".gitconfig") + ")");
    expect(message).toContain("add an empty \"helper =\" line");
    expect(options).toMatchObject({ eventType: "health" });
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "git_push_check", status: "warning", details: expect.objectContaining({ code: "wrong_identity" }) }));
    const stored = fs.readFileSync(statePath(ctx), "utf8");
    for (const text of [message, stored, JSON.stringify(first)]) {
      expect(text).not.toContain(kGlobalToken);
      expect(text).not.toContain(kRepoToken);
      // A username can carry a token (username=<token>, password=x-oauth-basic).
      expect(text).not.toContain("\"agents\"");
      expect(text).not.toContain("\"garry\"");
    }

    await checks.check();
    expect(notify).toHaveBeenCalledTimes(1);

    // Wintermute's hand fix: an empty reset before the checkout's helper.
    ctx.git(ctx.work, ["config", "--local", "--unset-all", "credential.helper"]);
    ctx.git(ctx.work, ["config", "--local", "--add", "credential.helper", ""]);
    ctx.git(ctx.work, ["config", "--local", "--add", "credential.helper", kRepoHelper]);
    const fixed = await checks.check();
    expect(fixed.results[0].routing).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain("pushes with its own credential");
    await checks.check();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("is quiet for a checkout whose own helper comes first, and for one that pins no helper", async () => {
    for (const options of [{ reset: true }, { pin: false }]) {
      const ctx = setup(options);
      const { checks, notify } = createChecks(ctx);
      const { results } = await checks.check();
      expect(results[0]).toMatchObject({ routing: null, stuck: null, branch: "main", url: kRemoteUrl });
      expect(notify).not.toHaveBeenCalled();
    }
  });

  it("alerts at once on Repository not found, and only on the second check for another ls-remote failure", async () => {
    const notFound = setup({ reset: true });
    const a = createChecks(notFound, { lsRemote: "remote: Repository not found.\nfatal: repository '" + kRemoteUrl + "/' not found" });
    expect((await a.checks.check()).results[0].routing).toMatchObject({ code: "repo_not_found" });
    expect(a.notify).toHaveBeenCalledTimes(1);
    expect(a.notify.mock.calls[0][0]).toContain("Repository not found");

    const flaky = setup({ reset: true });
    const b = createChecks(flaky, { lsRemote: "fatal: unable to access: Could not resolve host: github.com" });
    await b.checks.check();
    expect(b.notify).not.toHaveBeenCalled();
    await b.checks.check();
    expect(b.notify).toHaveBeenCalledTimes(1);
    expect(b.notify.mock.calls[0][0]).toContain("two checks in a row");
  });

  it("alerts when commits have waited on the branch longer than the limit", async () => {
    const ctx = setup({ reset: true });
    const fresh = createChecks(ctx);
    ctx.git(ctx.work, ["commit", "-q", "--allow-empty", "-m", "new"]);
    expect((await fresh.checks.check()).results[0].stuck).toBeNull();
    expect(fresh.notify).not.toHaveBeenCalled();

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    ctx.git(ctx.work, ["commit", "-q", "--allow-empty", "-m", "old"], { GIT_COMMITTER_DATE: old });
    const { results } = await fresh.checks.check();
    expect(results[0].stuck).toMatchObject({ code: "stuck_push", count: 2 });
    expect(fresh.notify).toHaveBeenCalledTimes(1);
    expect(fresh.notify.mock.calls[0][0]).toMatch(/has 2 commit\(s\) that are not on origin\/main/);
    expect(fresh.notify.mock.calls[0][0]).toContain("over the 30-minute limit");
  });

  it("alerts once on tracked files that match an ignore rule, with paths only and the full list in a private file", async () => {
    const ctx = setup({ reset: true });
    const logged = [];
    const notify = vi.fn(async () => ({ ok: true }));
    const checks = createGitPushChecks({
      openclawDir: ctx.openclawDir,
      readConfig: () => ({ checkouts: [{ path: ctx.work, name: "brain" }] }),
      getEnv: () => ctx.env,
      notify,
      execFileImpl: makeExecFile(ctx.bare),
      logger: { log: (line) => logged.push(line), warn: (line) => logged.push(line) },
    });
    fs.mkdirSync(path.join(ctx.work, "exports"));
    for (const name of ["a.xml", "b.xml", "c.xml", "d.xml"]) fs.writeFileSync(path.join(ctx.work, "exports", name), "secret health data");
    ctx.git(ctx.work, ["add", "exports"]);
    ctx.git(ctx.work, ["commit", "-q", "-m", "exports"]);
    ctx.git(ctx.work, ["push", "-q", ctx.bare, "HEAD:main"]);
    expect((await checks.check()).results[0].ignored).toBeNull();
    fs.writeFileSync(path.join(ctx.work, ".gitignore"), "exports/\n");

    const { results } = await checks.check();
    expect(results[0].ignored).toEqual({ code: "tracked_ignored", count: 4 });
    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0];
    expect(message).toContain("tracks 4 file(s) that its ignore rules exclude");
    expect(message).toContain("exports/a.xml, exports/b.xml, exports/c.xml and 1 more");
    expect(message).not.toContain("health data");
    const listPath = message.match(/Full list: (\S+)\.\n/)[1];
    expect(listPath.startsWith(path.join(ctx.openclawDir, ".alphaclaw"))).toBe(true);
    expect(fs.statSync(listPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(listPath, "utf8")).toContain("exports/d.xml");
    expect(logged.join("\n")).not.toContain("exports/");

    await checks.check();
    expect(notify).toHaveBeenCalledTimes(1);
    ctx.git(ctx.work, ["rm", "-q", "-r", "--cached", "exports"]);
    ctx.git(ctx.work, ["commit", "-q", "-m", "untrack"]);
    await checks.check();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain("no longer tracks files its ignore rules exclude");
    expect(fs.existsSync(listPath)).toBe(false);
  });

  it("never makes a helper store or erase a credential when the remote refuses it", async () => {
    const ctx = setup({ pin: false });
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization || "");
      res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"git\"" });
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = "http://127.0.0.1:" + server.address().port;
      const store = path.join(ctx.root, "stored-credentials");
      const saved = "http://agents:" + kRepoToken + "@127.0.0.1:" + server.address().port + "\n";
      fs.writeFileSync(store, saved);
      ctx.git(ctx.work, ["config", "--local", "--add", "credential.helper", "store --file=" + store]);
      ctx.git(ctx.work, ["remote", "set-url", "origin", origin + "/acme/private.git"]);
      const checks = createGitPushChecks({
        openclawDir: ctx.openclawDir,
        readConfig: () => ({ checkouts: [{ path: ctx.work }] }),
        getEnv: () => ctx.env,
        notify: vi.fn(async () => ({ ok: true })),
        logger: { log() {}, warn() {} },
      });
      const { results } = await checks.check();
      expect(results[0].routing).toMatchObject({ code: "auth_failed" });
      expect(seen).toContain("Basic " + Buffer.from("agents:" + kRepoToken).toString("base64"));
      expect(fs.readFileSync(store, "utf8")).toBe(saved);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("writes a counts-only summary for fix probes: probes run and passed, and problems the owner was never told about", async () => {
    const healthy = setup({ reset: true });
    await createChecks(healthy).checks.check();
    const summary = JSON.parse(fs.readFileSync(statePath(healthy), "utf8")).summary;
    expect(summary).toMatchObject({ listed: 1, listedProbed: 1, listedWriteOk: 1, discovered: 0, problems: 0, untold: 0 });
    expect(Number.isFinite(Date.parse(summary.finishedAt))).toBe(true);

    // A routing problem skips the write probe; once the owner is told it is
    // not "untold". When the notice keeps failing, the second check counts it.
    const broken = setup();
    const told = createChecks(broken);
    await told.checks.check();
    expect(JSON.parse(fs.readFileSync(statePath(broken), "utf8")).summary).toMatchObject({ listed: 1, listedProbed: 0, problems: 1, untold: 0 });
    const silent = setup();
    const failing = createChecks(silent);
    failing.notify.mockImplementation(async () => ({ ok: false, reason: "telegram down" }));
    await failing.checks.check();
    expect(JSON.parse(fs.readFileSync(statePath(silent), "utf8")).summary).toMatchObject({ problems: 1, untold: 0 });
    await failing.checks.check();
    const text = fs.readFileSync(statePath(silent), "utf8");
    expect(JSON.parse(text).summary).toMatchObject({ problems: 1, untold: 1 });
    expect(text).not.toContain(kGlobalToken);
    expect(text).not.toContain(kRepoToken);
  });

  it("runs no git when no checkout is listed", async () => {
    const ctx = setup();
    const calls = [];
    const { checks, notify } = createChecks(ctx, { config: { checkouts: [] }, calls });
    expect((await checks.check()).results).toEqual([]);
    expect(calls).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("git push checks config", () => {
  it("is off by default and keeps only absolute, distinct checkouts", () => {
    expect(normalizeGitPushChecksConfig(undefined)).toEqual({ checkouts: [], intervalMinutes: 10, stuckMinutes: 30 });
    expect(
      normalizeGitPushChecksConfig({
        checkouts: [{ path: "/srv/a/" }, { path: "/srv/a" }, { path: "relative" }, { path: "/srv/b", remote: "--upload-pack=x", name: "B\nrepo" }, null],
        intervalMinutes: 1,
        stuckMinutes: 99999,
      }),
    ).toEqual({ checkouts: [{ path: "/srv/a", remote: "origin" }, { path: "/srv/b", remote: "origin", name: "B repo" }], intervalMinutes: 5, stuckMinutes: 10080 });
  });

  it("reads the helper chain in config order and lets an empty value clear it", () => {
    const listing = [
      "system\tfile:/etc/gitconfig\tcredential.helper store",
      "global\tfile:/home/u/.gitconfig\tcredential.https://github.com.helper ",
      "global\tfile:/home/u/.gitconfig\tcredential.https://github.com.helper !gh auth git-credential",
      "global\tfile:/home/u/.gitconfig\tcredential.https://gitlab.com.helper other",
      "local\tfile:.git/config\tcredential.helper !repo-helper",
    ].join("\n");
    expect(helperChainOf(listing, kRemoteUrl)).toEqual([
      { scope: "global", origin: "/home/u/.gitconfig" },
      { scope: "local", origin: ".git/config" },
    ]);
  });
});
