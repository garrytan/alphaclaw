const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createManagedGitCredentials } = require("../../lib/server/git-credentials");
const { createGitPushChecks } = require("../../lib/server/git-push-checks");
const { normalizeGitCredentialsConfig, resolveGitCredentialRoute, repoOfPath } = require("../../lib/server/git-credential-routes");
const { startGitHttpServer } = require("./helpers/git-http-server");

// GST-3351: a box's global git config ran every github.com credential through
// one credential store whose "erase" did nothing. git runs "store" on every
// helper after any successful authentication, so the token that last worked
// anywhere moved to the front of the store, and git sent it for every
// repository, including ones it could not push to. GitHub answered
// "Repository not found", git never erased or fell back, and a checkout's own
// helper (added after the global one) was never asked. AlphaClaw now manages
// one github.com helper that answers by repository path from alphaclaw.json
// and stores nothing. Tokens here are fakes.
const kWriteToken = "write-token-0123456789";
const kReadToken = "read-token-0123456789";
const kOtherToken = "other-token-0123456789";

const baseEnv = (home) => {
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_ASKPASS", "GITHUB_TOKEN", "GH_TOKEN", "XDG_CONFIG_HOME", "PUSH_TOKEN", "OTHER_TOKEN", "FILE_TOKEN"]) delete env[key];
  return env;
};

const git = (cwd, args, env, input) =>
  new Promise((resolve) => {
    const child = execFile("git", args, { cwd, env, encoding: "utf8" }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }));
    child.stdin.end(input || "");
  });

let server = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const setup = async ({ routes = [], manageGlobalConfig = true, envFile = "" } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-credentials-"));
  const home = path.join(root, "home");
  const openclawDir = path.join(root, ".openclaw");
  const projects = path.join(root, "srv");
  for (const dir of [home, openclawDir, projects]) fs.mkdirSync(dir, { recursive: true });
  const env = baseEnv(home);
  const configPath = path.join(openclawDir, "alphaclaw.json");
  const envFilePath = path.join(root, ".env");
  fs.writeFileSync(envFilePath, envFile);
  fs.writeFileSync(configPath, JSON.stringify({ gitCredentials: { routes, manageGlobalConfig } }));
  const notify = vi.fn(async () => ({ ok: true }));
  const logged = [];
  const makeManaged = (githubUrl) =>
    createManagedGitCredentials({
      openclawDir,
      configPath,
      envFilePath,
      readConfig: () => JSON.parse(fs.readFileSync(configPath, "utf8")).gitCredentials,
      refusedEnvKeys: ["NPM_TOKEN"],
      notify,
      ...(githubUrl ? { githubUrl } : {}),
      logger: { log: (line) => logged.push(line), warn: (line) => logged.push(line) },
    });
  return { root, home, openclawDir, projects, env, configPath, envFilePath, notify, logged, makeManaged, managed: makeManaged(), globalFile: path.join(home, ".gitconfig") };
};

const fill = async (ctx, url, env = ctx.env) => {
  const result = await git(ctx.root, ["credential", "fill"], env, "url=" + url + "\n\n");
  const password = (result.stdout.match(/^password=(.*)$/m) || [])[1] || "";
  return { ok: result.ok, password, username: (result.stdout.match(/^username=(.*)$/m) || [])[1] || "" };
};

const makeRepo = async (ctx, repo) => {
  const bare = path.join(ctx.projects, repo + ".git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: ctx.env });
  const dir = path.join(ctx.root, "work", repo.replace("/", "-"));
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main"], ctx.env);
  await git(dir, ["remote", "add", "origin", server.url + "/" + repo + ".git"], ctx.env);
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "seed"], ctx.env);
  const seeded = await git(dir, ["-c", "credential.helper=", "-c", "credential.helper=!f() { test \"$1\" = get && echo username=seed && echo password=" + kWriteToken + "; }; f", "push", "-q", "-u", "origin", "main"], ctx.env);
  expect(seeded.ok).toBe(true);
  return { dir, bare };
};

describe("managed GitHub credential helper", () => {
  it("replaces a store that keeps sending the last token that worked, so each repository pushes with its own token and nothing is stored", async () => {
    const ctx = await setup({ routes: [{ repo: "acme/app", tokenEnv: "PUSH_TOKEN" }] });
    server = await startGitHttpServer({ projectRoot: ctx.projects, tokens: { [kWriteToken]: "write", [kReadToken]: "read" } });
    const store = path.join(ctx.home, ".git-credentials");
    fs.writeFileSync(store, "");
    // The box's wrapper: a credential store whose erase does nothing.
    await git(ctx.root, ["config", "--global", "credential.helper", "!f() { test \"$1\" = erase && exit 0; git credential-store --file=" + store + " \"$@\"; }; f"], ctx.env);
    const docs = await makeRepo(ctx, "acme/docs");
    const app = await makeRepo(ctx, "acme/app");
    // Each checkout adds its own helper after the global one (no reset).
    await git(docs.dir, ["config", "--local", "credential.helper", "!f() { test \"$1\" = get && echo username=reader && echo password=" + kReadToken + "; }; f"], ctx.env);
    await git(app.dir, ["config", "--local", "credential.helper", "!f() { test \"$1\" = get && echo username=pusher && echo password=" + kWriteToken + "; }; f"], ctx.env);

    // A fetch in docs works with its read-only token, and git stores it.
    expect((await git(docs.dir, ["fetch", "-q", "origin"], ctx.env)).ok).toBe(true);
    const stored = fs.readFileSync(store, "utf8").trim().split("\n");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain("http://reader:" + kReadToken + "@127.0.0.1");
    // app's push now gets the stored read-only token first, and keeps getting it.
    await git(app.dir, ["commit", "-q", "--allow-empty", "-m", "change"], ctx.env);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pushed = await git(app.dir, ["push", "-q", "origin", "main"], ctx.env);
      expect(pushed.ok).toBe(false);
      expect(pushed.stderr).toContain("403");
    }
    expect(fs.readFileSync(store, "utf8")).toContain(kReadToken);

    // AlphaClaw's managed helper, with the managed host pointed at the test server.
    const managedFor = ctx.makeManaged(server.url);
    const moved = { ...ctx.env, PUSH_TOKEN: kWriteToken };
    const storeBefore = fs.readFileSync(store, "utf8");
    const globalBefore = fs.readFileSync(ctx.globalFile, "utf8");
    const ensured = await managedFor.ensure(moved);
    expect(ensured.status).toBe("repaired");
    expect(fs.readFileSync(ensured.backupPath, "utf8")).toBe(globalBefore);
    expect(fs.statSync(ensured.backupPath).mode & 0o777).toBe(0o600);

    server.requests.length = 0;
    const pushed = await git(app.dir, ["push", "-q", "origin", "main"], moved);
    expect(pushed.stderr).toBe("");
    expect(pushed.ok).toBe(true);
    // docs has no route: the managed helper stays silent and its own helper answers.
    expect((await git(docs.dir, ["fetch", "-q", "origin"], moved)).ok).toBe(true);
    expect(fs.readFileSync(store, "utf8")).toBe(storeBefore);
    const logged = server.requests.filter((entry) => entry.method === "POST" && entry.service === "git-receive-pack");
    expect(logged).toHaveLength(1);
    expect(logged[0].access).toBe("write");
  });

  it("keeps the global github.com section at exactly its helper, backs up what it replaces, and tells the owner once", async () => {
    const ctx = await setup({ routes: [{ repo: "acme/*", tokenEnv: "PUSH_TOKEN" }] });
    // What gh auth setup-git writes, after an unscoped store helper.
    await git(ctx.root, ["config", "--global", "credential.helper", "store"], ctx.env);
    await git(ctx.root, ["config", "--global", "--add", "credential.https://github.com.helper", ""], ctx.env);
    await git(ctx.root, ["config", "--global", "--add", "credential.https://github.com.helper", "!gh auth git-credential"], ctx.env);
    await git(ctx.root, ["config", "--global", "user.name", "Someone"], ctx.env);
    const original = fs.readFileSync(ctx.globalFile, "utf8");

    const first = await ctx.managed.ensure(ctx.env);
    expect(first).toMatchObject({ status: "repaired", note: "1 other helper(s) from global config (" + ctx.globalFile + "), no AlphaClaw helper, credential.useHttpPath off" });
    expect(fs.readFileSync(first.backupPath, "utf8")).toBe(original);
    const helpers = (await git(ctx.root, ["config", "--global", "--get-all", "credential.https://github.com.helper"], ctx.env)).stdout;
    expect(helpers).toBe("\n" + ctx.managed.launcherPath + "\n");
    expect((await git(ctx.root, ["config", "--global", "--get", "credential.helper"], ctx.env)).stdout.trim()).toBe("store");
    expect((await git(ctx.root, ["config", "--global", "--get", "user.name"], ctx.env)).stdout.trim()).toBe("Someone");
    expect(fs.statSync(ctx.managed.launcherPath).mode & 0o777).toBe(0o700);
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.notify.mock.calls[0][0]).toContain("put its GitHub credential helper back in the global git config (" + ctx.globalFile + ")");

    const settled = fs.readFileSync(ctx.globalFile, "utf8");
    expect((await ctx.managed.ensure(ctx.env)).status).toBe("ok");
    expect(fs.readFileSync(ctx.globalFile, "utf8")).toBe(settled);
    expect(fs.readdirSync(path.dirname(first.backupPath))).toHaveLength(1);

    // gh auth setup-git again: the section is rewritten in place.
    await git(ctx.root, ["config", "--global", "--replace-all", "credential.https://github.com.helper", ""], ctx.env);
    await git(ctx.root, ["config", "--global", "--add", "credential.https://github.com.helper", "!gh auth git-credential"], ctx.env);
    expect((await ctx.managed.ensure(ctx.env)).status).toBe("repaired");
    expect((await git(ctx.root, ["config", "--global", "--get-all", "credential.https://github.com.helper"], ctx.env)).stdout).toBe("\n" + ctx.managed.launcherPath + "\n");
    expect(ctx.logged.filter((line) => line.includes("git-credentials: repaired"))).toHaveLength(2);
    for (const line of ctx.logged) expect(line).not.toContain("gh auth");
  });

  it("answers github.com by repository path from the routes, with tokens from the env or the .env file, and never stores or erases", async () => {
    const ctx = await setup({
      routes: [
        { repo: "acme/app", tokenEnv: "PUSH_TOKEN" },
        { repo: "acme/*", tokenEnv: "OTHER_TOKEN", username: "machine-user" },
        { repo: "beta/*", tokenEnv: "FILE_TOKEN" },
        { repo: "gamma/*", tokenEnv: "NPM_TOKEN" },
        { repo: "delta/*", tokenEnv: "MISSING_TOKEN" },
      ],
      envFile: "FILE_TOKEN='" + kReadToken + "'\nNPM_TOKEN=npm-token-0123\n",
    });
    expect((await ctx.managed.ensure(ctx.env)).status).toBe("repaired");
    const env = { ...ctx.env, PUSH_TOKEN: kWriteToken, OTHER_TOKEN: kOtherToken, NPM_TOKEN: "npm-token-0123" };
    expect(await fill(ctx, "https://github.com/acme/app.git", env)).toMatchObject({ ok: true, password: kWriteToken, username: "x-access-token" });
    expect(await fill(ctx, "https://github.com/ACME/App", env)).toMatchObject({ ok: true, password: kWriteToken });
    expect(await fill(ctx, "https://github.com/acme/site.git", env)).toMatchObject({ ok: true, password: kOtherToken, username: "machine-user" });
    expect(await fill(ctx, "https://github.com/beta/notes.git", env)).toMatchObject({ ok: true, password: kReadToken });
    for (const url of ["https://github.com/gamma/x.git", "https://github.com/delta/x.git", "https://github.com/zeta/x.git", "https://gitlab.com/acme/app.git", "http://github.com/acme/app.git"]) {
      expect(await fill(ctx, url, env)).toMatchObject({ ok: false, password: "" });
    }

    const before = JSON.stringify(fs.readdirSync(ctx.root, { recursive: true }).sort());
    for (const operation of ["store", "erase"]) {
      const result = await new Promise((resolve) => {
        const child = execFile(ctx.managed.launcherPath, [operation], { env, encoding: "utf8" }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
        child.stdin.end("protocol=https\nhost=github.com\npath=acme/app.git\nusername=x-access-token\npassword=" + kWriteToken + "\n\n");
      });
      expect(result).toMatchObject({ error: null, stdout: "", stderr: "" });
    }
    expect(JSON.stringify(fs.readdirSync(ctx.root, { recursive: true }).sort())).toBe(before);
  });

  it("in preview writes no git config and tests each checkout's push path with the managed helper alone", async () => {
    const ctx = await setup({ manageGlobalConfig: false, routes: [{ repo: "acme/app", tokenEnv: "PUSH_TOKEN" }] });
    server = await startGitHttpServer({ projectRoot: ctx.projects, tokens: { [kWriteToken]: "write", [kReadToken]: "read" } });
    const preview = ctx.makeManaged(server.url);
    const app = await makeRepo(ctx, "acme/app");
    const docs = await makeRepo(ctx, "acme/docs");
    for (const dir of [app.dir, docs.dir]) {
      await git(dir, ["config", "--local", "credential.helper", "!f() { test \"$1\" = get && echo username=x && echo password=" + kWriteToken + "; }; f"], ctx.env);
    }
    const logged = [];
    const checks = createGitPushChecks({
      openclawDir: ctx.openclawDir,
      readConfig: () => ({ checkouts: [{ path: app.dir, name: "app" }, { path: docs.dir, name: "docs" }] }),
      getEnv: () => ({ ...ctx.env, PUSH_TOKEN: kReadToken }),
      notify: ctx.notify,
      managedCredentials: preview,
      githubUrl: server.url,
      logger: { log: (line) => logged.push(line), warn: (line) => logged.push(line) },
    });
    const { credentials, results } = await checks.check();
    expect(credentials.status).toBe("preview");
    expect(fs.existsSync(ctx.globalFile)).toBe(false);
    expect(results.map((entry) => [entry.checkout.name, entry.write, entry.managed])).toEqual([
      ["app", null, "push_denied"],
      ["docs", null, "no_route"],
    ]);
    expect(ctx.notify).not.toHaveBeenCalled();
    expect(logged).toContain("[alphaclaw] git-push-check app: routing=ok write=ok managed=push_denied stuck=none tracked_ignored=0");
  });
});

describe("git credential routes", () => {
  it("keeps valid routes, refuses withheld env names, and resolves the most specific one", () => {
    const { routes, manageGlobalConfig } = normalizeGitCredentialsConfig(
      {
        routes: [
          { repo: "Acme/App.git", tokenEnv: "PUSH_TOKEN" },
          { repo: "acme/app", tokenEnv: "DUPLICATE" },
          { repo: "acme/*", tokenEnv: "OTHER_TOKEN", username: "bad user" },
          { repo: "*", tokenEnv: "DEFAULT_TOKEN" },
          { repo: "acme/app/extra", tokenEnv: "X" },
          { repo: "beta/*", tokenEnv: "ghp_literal-token" },
          { repo: "gamma/*", tokenEnv: "NPM_TOKEN" },
        ],
        manageGlobalConfig: "yes",
      },
      { refusedEnvKeys: ["NPM_TOKEN"] },
    );
    expect(manageGlobalConfig).toBe(false);
    expect(routes).toEqual([
      { repo: "acme/app", tokenEnv: "PUSH_TOKEN", username: "x-access-token" },
      { repo: "acme/*", tokenEnv: "OTHER_TOKEN", username: "x-access-token" },
      { repo: "*", tokenEnv: "DEFAULT_TOKEN", username: "x-access-token" },
    ]);
    expect(resolveGitCredentialRoute(routes, repoOfPath("/acme/app.git/")).tokenEnv).toBe("PUSH_TOKEN");
    expect(resolveGitCredentialRoute(routes, repoOfPath("acme/site")).tokenEnv).toBe("OTHER_TOKEN");
    expect(resolveGitCredentialRoute(routes, repoOfPath("")).tokenEnv).toBe("DEFAULT_TOKEN");
    expect(resolveGitCredentialRoute(routes.slice(0, 2), repoOfPath("other/x"))).toBeNull();
    expect(normalizeGitCredentialsConfig(undefined)).toEqual({ routes: [], manageGlobalConfig: false });
  });
});
