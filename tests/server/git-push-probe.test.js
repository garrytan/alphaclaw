const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createGitPushChecks } = require("../../lib/server/git-push-checks");
const { startGitHttpServer } = require("./helpers/git-http-server");

// GST-3351: a box pushed with a stored token that could read a repository but
// not push to it. fetch and ls-remote passed, every push got "Repository not
// found", and nothing noticed. These run real git against a local smart-HTTP
// server (git http-backend) that records every request, so they show what the
// write probe sends: one authenticated GET of the receive-pack advertisement,
// never a POST, and no ref changes on the remote.
const kWriteToken = "write-token-0123456789";
const kReadToken = "read-token-0123456789";
const kNoAccessToken = "none-token-0123456789";

const baseGitEnv = (home) => {
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_ASKPASS", "GITHUB_TOKEN", "GH_TOKEN", "XDG_CONFIG_HOME"]) delete env[key];
  return env;
};

const run = (cwd, args, env) =>
  new Promise((resolve, reject) =>
    execFile("git", args, { cwd, env, encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout))),
  );

// A helper that answers get with the given token and appends every operation
// it is asked for to a log, so a test can see that nothing was stored or erased.
const loggingHelper = (token, logFile) =>
  "!f() { echo \"$1\" >> " + logFile + "; test \"$1\" = get && echo username=x-access-token && echo password=" + token + "; }; f";

let server = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const setup = async ({ repos = ["acme/private"], anonymousRead = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-push-probe-"));
  const home = path.join(root, "home");
  const projects = path.join(root, "srv");
  const openclawDir = path.join(root, ".openclaw");
  for (const dir of [home, openclawDir]) fs.mkdirSync(dir, { recursive: true });
  const env = baseGitEnv(home);
  server = await startGitHttpServer({ projectRoot: projects, tokens: { [kWriteToken]: "write", [kReadToken]: "read" }, anonymousRead });
  const helperLog = path.join(root, "helper-ops.log");
  const clone = async (repo, dir, { token = kWriteToken, localHelper = true } = {}) => {
    const bare = path.join(projects, repo + ".git");
    if (!fs.existsSync(bare)) {
      fs.mkdirSync(path.dirname(bare), { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env });
    }
    fs.mkdirSync(dir, { recursive: true });
    await run(dir, ["init", "-q", "-b", "main"], env);
    await run(dir, ["remote", "add", "origin", server.url + "/" + repo + ".git"], env);
    await run(dir, ["commit", "-q", "--allow-empty", "-m", "seed"], env);
    await run(dir, ["-c", "credential.helper=", "-c", "credential.helper=" + loggingHelper(kWriteToken, path.join(root, "seed.log")), "push", "-q", "-u", "origin", "main"], env);
    if (localHelper) await run(dir, ["config", "--local", "credential.helper", loggingHelper(token, helperLog)], env);
    return { dir, bare };
  };
  const checkouts = {};
  for (const repo of repos) checkouts[repo] = await clone(repo, path.join(root, "work", repo.split("/")[1]));
  return { root, home, openclawDir, env, helperLog, clone, checkouts };
};

const createChecks = (ctx, config) => {
  const notify = vi.fn(async () => ({ ok: true }));
  const logged = [];
  const checks = createGitPushChecks({
    openclawDir: ctx.openclawDir,
    readConfig: () => config,
    getEnv: () => ctx.env,
    notify,
    recordEvent: vi.fn(),
    githubUrl: server.url,
    logger: { log: (line) => logged.push(line), warn: (line) => logged.push(line) },
  });
  return { checks, notify, logged };
};

const refsOf = (bare) => execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: bare, encoding: "utf8" });

describe("git push write probe", () => {
  it("alerts when the credential git picks can read the repository but not push to it, sending nothing", async () => {
    const ctx = await setup();
    const { dir, bare } = ctx.checkouts["acme/private"];
    await run(dir, ["config", "--local", "credential.helper", loggingHelper(kReadToken, ctx.helperLog)], ctx.env);
    await run(dir, ["commit", "-q", "--allow-empty", "-m", "waiting"], ctx.env);
    const before = refsOf(bare);
    server.requests.length = 0;
    const { checks, notify, logged } = createChecks(ctx, { checkouts: [{ path: dir, name: "private" }] });

    const { results } = await checks.check();
    expect(results[0].routing).toBeNull();
    expect(results[0].write).toMatchObject({ code: "push_denied" });
    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0];
    expect(message).toContain("Pushes from \"private\" (" + dir + ")");
    expect(message).toContain("would fail");
    expect(message).toContain("gitCredentials.routes");
    expect(message).toContain("repo \"acme/private\"");
    expect(message).not.toContain(kReadToken);
    expect(logged.join("\n")).toContain("git-push-check private: remote=origin routing=ok write=push_denied stuck=none tracked_ignored=0");

    // The read path worked; the write path was only asked for its ref
    // advertisement; nothing was posted to either service.
    expect(server.requests.some((entry) => entry.service === "git-upload-pack" && entry.access === "read")).toBe(true);
    expect(server.requests.some((entry) => entry.service === "git-receive-pack" && entry.method === "GET" && entry.access === "read")).toBe(true);
    expect(server.requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(refsOf(bare)).toBe(before);
    expect(fs.readFileSync(ctx.helperLog, "utf8").trim().split("\n").every((line) => line === "get")).toBe(true);

    await checks.check();
    expect(notify).toHaveBeenCalledTimes(1);

    await run(dir, ["config", "--local", "credential.helper", loggingHelper(kWriteToken, ctx.helperLog)], ctx.env);
    expect((await checks.check()).results[0].write).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain("can push to its remote again");
  });

  it("passes with a token that can push, still without a POST or a ref change", async () => {
    const ctx = await setup();
    const { dir, bare } = ctx.checkouts["acme/private"];
    await run(dir, ["commit", "-q", "--allow-empty", "-m", "ahead"], ctx.env);
    const before = refsOf(bare);
    server.requests.length = 0;
    const { checks, notify } = createChecks(ctx, { checkouts: [{ path: dir }] });
    const { results } = await checks.check();
    expect(results[0]).toMatchObject({ routing: null, write: null, writeProbe: "ok" });
    expect(notify).not.toHaveBeenCalled();
    expect(server.requests.filter((entry) => entry.service === "git-receive-pack").map((entry) => entry.method + " " + (entry.access || "anonymous"))).toEqual(["GET anonymous", "GET write"]);
    expect(server.requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(refsOf(bare)).toBe(before);
    expect(fs.readFileSync(ctx.helperLog, "utf8").trim().split("\n").every((line) => line === "get")).toBe(true);
  });

  it("alerts when a listed checkout of a public repository has no credential to push with", async () => {
    const ctx = await setup({ anonymousRead: true });
    const { dir } = ctx.checkouts["acme/private"];
    await run(dir, ["config", "--local", "--unset-all", "credential.helper"], ctx.env);
    server.requests.length = 0;
    const { checks, notify } = createChecks(ctx, { checkouts: [{ path: dir, name: "public" }] });
    const { results } = await checks.check();
    expect(results[0]).toMatchObject({ routing: null, write: { code: "no_credential" } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("no credential helper gives git a credential");
    expect(server.requests.filter((entry) => entry.service === "git-receive-pack")).toEqual([]);
  });

  it("reports an unreachable remote once, from ls-remote, and does not probe the write path on top", async () => {
    const ctx = await setup();
    const { dir } = ctx.checkouts["acme/private"];
    await run(dir, ["config", "--local", "--unset-all", "credential.helper"], ctx.env);
    const { checks, notify } = createChecks(ctx, { checkouts: [{ path: dir }] });
    const { results } = await checks.check();
    expect(results[0].routing).toMatchObject({ code: "auth_failed" });
    expect(results[0].write).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("git push checks with a token only the pushing process has", () => {
  it("reads the env files gitPushChecks.envFiles names, so a checkout helper that reads such a token is not reported silent", async () => {
    const ctx = await setup();
    const { dir, bare } = ctx.checkouts["acme/private"];
    // The checkout's own helper, after a reset, reads a token from an env var
    // that a cron job or a worker has and the AlphaClaw server does not.
    await run(dir, ["config", "--local", "--unset-all", "credential.helper"], ctx.env);
    await run(dir, ["config", "--local", "--add", "credential.helper", ""], ctx.env);
    await run(dir, ["config", "--local", "--add", "credential.helper", "!f() { test \"$1\" = get && echo username=x-access-token && echo password=$PUSHER_ONLY_TOKEN; }; f"], ctx.env);
    await run(dir, ["commit", "-q", "--allow-empty", "-m", "ahead"], ctx.env);
    const before = refsOf(bare);
    expect(ctx.env.PUSHER_ONLY_TOKEN).toBeUndefined();

    const silent = createChecks(ctx, { checkouts: [{ path: dir, name: "pinned" }] });
    expect((await silent.checks.check()).results[0].routing).toMatchObject({ code: "own_helper_silent" });
    expect(silent.notify.mock.calls[0][0]).toContain("gitPushChecks.envFiles");

    const envFile = path.join(ctx.root, "pusher.env");
    fs.writeFileSync(envFile, "# the pushing job's env\nPUSHER_ONLY_TOKEN=" + kWriteToken + "\nPATH=/nowhere\n", { mode: 0o600 });
    fs.rmSync(path.join(ctx.openclawDir, ".alphaclaw"), { recursive: true, force: true });
    const missing = path.join(ctx.root, "missing.env");
    const fixed = createChecks(ctx, { checkouts: [{ path: dir, name: "pinned" }], envFiles: [envFile, missing] });
    const { results } = await fixed.checks.check();
    expect(results[0]).toMatchObject({ routing: null, write: null, writeProbe: "ok" });
    expect(fixed.notify).not.toHaveBeenCalled();
    expect(server.requests.some((entry) => entry.service === "git-receive-pack" && entry.access === "write")).toBe(true);
    expect(refsOf(bare)).toBe(before);
    expect(fixed.logged).toContain("[alphaclaw] git-push-check env file unreadable: " + missing + " (ENOENT)");
    expect(fixed.logged).toContain("[alphaclaw] git-push-check pinned: remote=origin routing=ok write=ok stuck=none tracked_ignored=0");
    const state = fs.readFileSync(path.join(ctx.openclawDir, ".alphaclaw", "git-push-checks.json"), "utf8");
    for (const text of [state, fixed.logged.join("\n"), JSON.stringify(results)]) expect(text).not.toContain(kWriteToken);
    expect(ctx.env.PUSHER_ONLY_TOKEN).toBeUndefined();
  });

  it("never refills a secret AlphaClaw withholds from the gateway as an empty value", async () => {
    const ctx = await setup();
    const { dir } = ctx.checkouts["acme/private"];
    const seen = path.join(ctx.root, "helper-env.log");
    await run(dir, ["config", "--local", "--unset-all", "credential.helper"], ctx.env);
    await run(dir, ["config", "--local", "--add", "credential.helper", ""], ctx.env);
    await run(dir, ["config", "--local", "--add", "credential.helper", "!f() { echo \"setup=$SETUP_PASSWORD\" >> " + seen + "; test \"$1\" = get && echo username=x-access-token && echo password=$PUSHER_ONLY_TOKEN; }; f"], ctx.env);
    const envFile = path.join(ctx.root, "alphaclaw.env");
    fs.writeFileSync(envFile, "SETUP_PASSWORD=withheld-setup-password\nPUSHER_ONLY_TOKEN=" + kWriteToken + "\n", { mode: 0o600 });
    ctx.env.SETUP_PASSWORD = "";

    const { checks } = createChecks(ctx, { checkouts: [{ path: dir, name: "pinned" }], envFiles: [envFile] });
    const { results } = await checks.check();
    expect(results[0]).toMatchObject({ routing: null, write: null, writeProbe: "ok" });
    const lines = fs.readFileSync(seen, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line === "setup=")).toBe(true);
  });
});

describe("git push checks keep withheld secrets from checkout helpers", () => {
  it("runs a helper planted in a checkout's config with every secret AlphaClaw withholds from the gateway blanked, and no key the gateway policy denies from an env file", async () => {
    const ctx = await setup({ repos: [] });
    const roots = path.join(ctx.root, "data");
    const planted = await ctx.clone("acme/planted", path.join(roots, "planted"));
    const seen = path.join(ctx.root, "planted-saw.txt");
    // Anything that can write a checkout's .git/config can name a helper.
    await run(planted.dir, ["config", "--local", "--unset-all", "credential.helper"], ctx.env);
    await run(planted.dir, ["config", "--local", "--add", "credential.helper", ""], ctx.env);
    await run(planted.dir, ["config", "--local", "--add", "credential.helper", "!f() { echo \"setup=$SETUP_PASSWORD slack=$SLACK_OAUTH_CLIENT_SECRET relay=$ALPHACLAW_RELAY_TAILNET_AUTHKEY local=$CLAUDE_CODE_LOCAL_TOKEN extra=$EXTRA_FROM_FILE\" >> " + seen + "; test \"$1\" = get && echo username=x && echo password=" + kWriteToken + "; }; f"], ctx.env);
    await run(planted.dir, ["commit", "-q", "--allow-empty", "-m", "ahead"], ctx.env);
    const envFile = path.join(ctx.root, "pusher.env");
    fs.writeFileSync(envFile, "SETUP_PASSWORD=file-setup-secret\nSLACK_OAUTH_CLIENT_SECRET=file-slack-secret\nALPHACLAW_RELAY_TAILNET_AUTHKEY=file-relay-key\nCLAUDE_CODE_LOCAL_TOKEN=file-local-token\nEXTRA_FROM_FILE=fine\n");
    const checks = createGitPushChecks({
      openclawDir: ctx.openclawDir,
      readConfig: () => ({ checkouts: [], envFiles: [envFile], discover: { roots: [roots], maxDepth: 2 } }),
      // The server's own environment, as if a caller passed it by mistake.
      getEnv: () => ({ ...ctx.env, SETUP_PASSWORD: "server-setup-secret", SLACK_OAUTH_CLIENT_SECRET: "server-slack-secret" }),
      notify: vi.fn(async () => ({ ok: true })),
      githubUrl: server.url,
      logger: { log() {}, warn() {} },
    });
    const { results } = await checks.check();
    expect(results[0]).toMatchObject({ routing: null, write: null, writeProbe: "ok" });
    const lines = fs.readFileSync(seen, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toBe("setup= slack= relay= local= extra=fine");
  });

  it("keeps an open push alert through a check that could not probe, and says it cleared only after a probe passes", async () => {
    const ctx = await setup();
    const { dir } = ctx.checkouts["acme/private"];
    await run(dir, ["config", "--local", "credential.helper", loggingHelper(kReadToken, ctx.helperLog)], ctx.env);
    const { checks, notify } = createChecks(ctx, { checkouts: [{ path: dir }] });
    expect((await checks.check()).results[0].write).toMatchObject({ code: "push_denied" });
    expect(notify).toHaveBeenCalledTimes(1);
    // The remote is briefly unreachable: ls-remote fails, no probe runs.
    await run(dir, ["remote", "set-url", "origin", "http://127.0.0.1:1/acme/private.git"], ctx.env);
    expect((await checks.check()).results[0]).toMatchObject({ write: null, writeProbe: "skipped" });
    expect(notify).toHaveBeenCalledTimes(1);
    await run(dir, ["remote", "set-url", "origin", server.url + "/acme/private.git"], ctx.env);
    await checks.check();
    expect(notify).toHaveBeenCalledTimes(1);
    await run(dir, ["config", "--local", "credential.helper", loggingHelper(kWriteToken, ctx.helperLog)], ctx.env);
    await checks.check();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain("can push to its remote again");
  });

  it("skips an env file that is not a regular file instead of blocking on it", async () => {
    const ctx = await setup();
    const { dir } = ctx.checkouts["acme/private"];
    const fifo = path.join(ctx.root, "pipe.env");
    execFileSync("mkfifo", [fifo]);
    const { checks, logged } = createChecks(ctx, { checkouts: [{ path: dir }], envFiles: [fifo] });
    const { results } = await checks.check();
    expect(results[0].writeProbe).toBe("ok");
    expect(logged).toContain("[alphaclaw] git-push-check env file unreadable: " + fifo + " (not_a_file)");
  });
});

describe("git push checkout discovery", () => {
  it("finds github checkouts under the roots, probes the ones that push, and alerts on any stuck one", async () => {
    const ctx = await setup({ repos: [] });
    const roots = path.join(ctx.root, "data");
    // Neither pins a helper: both use the global one, which can only read.
    // The reader has nothing to push, so it is not probed; the pusher has a
    // stranded commit.
    await run(ctx.root, ["config", "--global", "credential.helper", loggingHelper(kReadToken, ctx.helperLog)], ctx.env);
    const pusher = await ctx.clone("acme/pusher", path.join(roots, "projects", "pusher"), { localHelper: false });
    const reader = await ctx.clone("acme/reader", path.join(roots, "projects", "reader"), { localHelper: false });
    await ctx.clone("acme/deep", path.join(roots, "a", "b", "c", "d", "deep"));
    await ctx.clone("acme/excluded", path.join(roots, "scratch", "excluded"));
    await ctx.clone("acme/modules", path.join(roots, "node_modules", "dep"));
    const own = await ctx.clone("acme/workspace", path.join(roots, "projects", "own"), { token: kReadToken });
    const other = path.join(roots, "projects", "elsewhere");
    fs.mkdirSync(other, { recursive: true });
    await run(other, ["init", "-q", "-b", "main"], ctx.env);
    await run(other, ["remote", "add", "origin", "https://example.com/acme/elsewhere.git"], ctx.env);
    fs.symlinkSync(pusher.dir, path.join(roots, "projects", "link"));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await run(pusher.dir, ["commit", "-q", "--allow-empty", "-m", "stranded"], { ...ctx.env, GIT_COMMITTER_DATE: old });

    server.requests.length = 0;
    const { checks, notify, logged } = createChecks(ctx, {
      checkouts: [{ path: own.dir, name: "own" }],
      discover: { roots: [roots], maxDepth: 3, exclude: [path.join(roots, "scratch")] },
    });
    const { results } = await checks.check();
    const byName = Object.fromEntries(results.map((entry) => [entry.checkout.name, entry]));
    expect(Object.keys(byName).sort()).toEqual(["own", "projects/pusher", "projects/reader"]);
    expect(byName["projects/pusher"]).toMatchObject({ write: { code: "push_denied" }, stuck: { code: "stuck_push", count: 1 } });
    expect(byName["projects/reader"]).toMatchObject({ routing: null, write: null, writeProbe: "skipped", stuck: null });
    expect(byName.own).toMatchObject({ write: { code: "push_denied" } });
    expect(notify.mock.calls.map((call) => call[0].split("\n")[0])).toEqual([
      expect.stringContaining("Pushes from \"own\""),
      expect.stringContaining("Pushes from \"projects/pusher\" (" + pusher.dir + ")"),
      expect.stringMatching(/Push checkout "projects\/pusher" .* has 1 commit\(s\) that are not on origin\/main/),
    ]);
    // own, pusher, reader and the non-GitHub one, which is then skipped.
    expect(logged).toContain("[alphaclaw] git-push-check discovery: found 4 git checkout(s) under " + roots + " (depth 3)");
    expect(logged).toContain("[alphaclaw] git-push-check projects/reader: remote=origin routing=ok write=skipped stuck=none");
    const receive = server.requests.filter((entry) => entry.service === "git-receive-pack");
    expect(receive.some((entry) => entry.path.includes("/acme/reader"))).toBe(false);
    expect(server.requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(reader.dir).toBeTruthy();
  });

  it("never discovers the openclaw dir, which git sync already watches", async () => {
    const ctx = await setup({ repos: [] });
    await ctx.clone("acme/state", ctx.openclawDir);
    const { checks } = createChecks(ctx, { checkouts: [], discover: { roots: [ctx.root], maxDepth: 2 } });
    expect((await checks.check()).results.map((entry) => entry.checkout.path)).not.toContain(ctx.openclawDir);
  });
});

describe("git push checks follow the remote the branch pushes to", () => {
  // GST-3629: a checkout whose branch pushes to a second remote (an agents
  // fork) read push_denied because the probe tested origin, which it never
  // pushes to. This helper, with credential.useHttpPath, gives the token that
  // can push only for repositories under agents/, and the read token for the
  // rest, so a probe of the wrong remote fails.
  const pathHelper = (logFile) =>
    "!f() { echo \"$1\" >> " + logFile + "; test \"$1\" = get || exit 0; t=" + kReadToken + "; while read l; do case \"$l\" in path=agents/*) t=" + kWriteToken + ";; esac; done; echo username=x-access-token; echo password=$t; }; f";
  const addAgentsRemote = async (ctx, dir, repo) => {
    const bare = path.join(ctx.root, "srv", "agents", repo + ".git");
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: ctx.env });
    await run(dir, ["remote", "add", "agents", server.url + "/agents/" + repo + ".git"], ctx.env);
    await run(dir, ["-c", "credential.helper=", "-c", "credential.helper=" + loggingHelper(kWriteToken, path.join(ctx.root, "seed.log")), "push", "-q", "agents", "main"], ctx.env);
    await run(dir, ["config", "--local", "credential.useHttpPath", "true"], ctx.env);
    await run(dir, ["config", "--local", "credential.helper", pathHelper(ctx.helperLog)], ctx.env);
    return bare;
  };
  const pathsOf = (service) => server.requests.filter((entry) => entry.service === service).map((entry) => entry.path);

  it("probes, lists and counts against branch.<name>.pushRemote instead of origin", async () => {
    const ctx = await setup();
    const { dir } = ctx.checkouts["acme/private"];
    const bare = await addAgentsRemote(ctx, dir, "private");
    await run(dir, ["config", "--local", "branch.main.pushRemote", "agents"], ctx.env);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await run(dir, ["commit", "-q", "--allow-empty", "-m", "stranded"], { ...ctx.env, GIT_COMMITTER_DATE: old });
    const before = refsOf(bare);
    server.requests.length = 0;
    const { checks, notify, logged } = createChecks(ctx, { checkouts: [{ path: dir, name: "split" }] });

    const { results } = await checks.check();
    expect(results[0]).toMatchObject({ remote: "agents", routing: null, write: null, writeProbe: "ok", stuck: { code: "stuck_push", count: 1 } });
    expect(pathsOf("git-receive-pack").length).toBeGreaterThan(0);
    expect(pathsOf("git-receive-pack").every((entry) => entry.startsWith("/agents/private.git/"))).toBe(true);
    expect(pathsOf("git-upload-pack").every((entry) => entry.startsWith("/agents/private.git/"))).toBe(true);
    expect(server.requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(refsOf(bare)).toBe(before);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("that are not on agents/main");
    expect(notify.mock.calls[0][0]).toContain("push agents main");
    expect(logged).toContain("[alphaclaw] git-push-check split: remote=agents routing=ok write=ok stuck=1 tracked_ignored=0");
    expect(fs.readFileSync(ctx.helperLog, "utf8").trim().split("\n").every((line) => line === "get")).toBe(true);

    // A listed checkout's remote other than origin is checked as configured.
    await run(dir, ["remote", "add", "mirror", server.url + "/acme/private.git"], ctx.env);
    const named = createChecks(ctx, { checkouts: [{ path: dir, name: "named", remote: "mirror" }] });
    expect((await named.checks.check()).results[0]).toMatchObject({ remote: "mirror", write: { code: "push_denied" } });
    const origin = createChecks(ctx, { checkouts: [{ path: dir, name: "origin", remote: "origin" }] });
    expect((await origin.checks.check()).results[0]).toMatchObject({ remote: "agents", write: null });
  });

  it("keeps origin when pushRemote names a remote with no URL, or a URL, which is not a remote name", async () => {
    const ctx = await setup();
    const { dir } = ctx.checkouts["acme/private"];
    for (const value of ["gone", server.url + "/agents/private.git"]) {
      await run(dir, ["config", "--local", "branch.main.pushRemote", value], ctx.env);
      const { checks, logged } = createChecks(ctx, { checkouts: [{ path: dir, name: "fallback" }] });
      expect((await checks.check()).results[0]).toMatchObject({ remote: "origin", routing: null, write: null });
      expect(logged).toContain("[alphaclaw] git-push-check fallback: remote=origin routing=ok write=ok stuck=none tracked_ignored=0");
    }
  });

  it("uses remote.pushDefault, then branch.<name>.remote, so a discovered checkout with no origin is found, and keeps origin on a detached HEAD", async () => {
    const ctx = await setup({ repos: [] });
    const roots = path.join(ctx.root, "data");
    const fork = await ctx.clone("acme/fork", path.join(roots, "fork"));
    await addAgentsRemote(ctx, fork.dir, "fork");
    await run(fork.dir, ["config", "--local", "remote.pushDefault", "agents"], ctx.env);
    // An off-box archive: its only remote is offbox, which main tracks.
    const archive = await ctx.clone("agents/archive", path.join(roots, "archive"));
    await run(archive.dir, ["remote", "rename", "origin", "offbox"], ctx.env);
    server.requests.length = 0;
    const { checks, logged } = createChecks(ctx, { checkouts: [], discover: { roots: [roots], maxDepth: 2 } });

    const { results } = await checks.check();
    const byName = Object.fromEntries(results.map((entry) => [entry.checkout.name, entry]));
    expect(Object.keys(byName).sort()).toEqual(["archive", "fork"]);
    expect(byName.fork).toMatchObject({ remote: "agents", routing: null, write: null, writeProbe: "ok" });
    expect(byName.archive).toMatchObject({ remote: "offbox", routing: null, write: null, writeProbe: "ok" });
    expect(pathsOf("git-receive-pack").some((entry) => entry.startsWith("/acme/"))).toBe(false);
    expect(logged).toContain("[alphaclaw] git-push-check fork: remote=agents routing=ok write=ok stuck=none");
    expect(logged).toContain("[alphaclaw] git-push-check archive: remote=offbox routing=ok write=ok stuck=none");
    expect(logged.join("\n")).not.toContain(server.url);

    await run(archive.dir, ["checkout", "-q", "--detach"], ctx.env);
    await run(fork.dir, ["checkout", "-q", "--detach"], ctx.env);
    const detached = Object.fromEntries((await checks.check()).results.map((entry) => [entry.checkout.name, entry]));
    expect(Object.keys(detached)).toEqual(["fork"]);
    expect(detached.fork).toMatchObject({ remote: "origin" });
  });
});

