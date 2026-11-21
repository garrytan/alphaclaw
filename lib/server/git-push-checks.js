const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { writeFileAtomic } = require("./utils/safe-file");
const { sanitizeLabel } = require("./utils/sanitize-label");
const { repoOfPath, resolveGitCredentialRoute } = require("./git-credential-routes");
const { parseEnvFileContent } = require("./utils/env-file-format");

// Push checkouts (GST-2960): for each checkout listed in alphaclaw.json
// gitPushChecks.checkouts, a read-only check at boot and every
// intervalMinutes that
//   1. asks git for the credential it would push with (git credential fill on
//      the remote's push URL) and for the one the checkout's own helpers give
//      alone (global and system config hidden); a checkout that pins its own
//      helper must push with that identity. A helper set outside the checkout
//      that answers first (gh auth setup-git writes one into the global
//      gitconfig) silently replaces it, and GitHub answers "Repository not
//      found" for a repository the other identity cannot see;
//   2. runs git ls-remote on the remote;
//   3. counts commits on the branch that are not on the remote and how old
//      the oldest one is;
//   4. lists tracked files that match the checkout's ignore rules (git
//      ls-files -ci --exclude-standard): files committed despite .gitignore
//      are pushed anyway. Paths only, never contents; the alert names a few
//      and the full list goes to a 0600 file under .alphaclaw/, never to the
//      process log the agent can read through the admin API.
//   5. (GST-3351) tests the write path: a dry-run push of a refspec that
//      matches no local ref (kProbeRefspec) authenticates against the
//      remote's git-receive-pack and reads its ref advertisement, which needs
//      push access, and sends nothing: with no ref to update git never POSTs
//      to git-receive-pack (tests/server/git-push-probe.test.js records every
//      request a real git sends). fetch and ls-remote only exercise the read
//      path, so a token that can read but not push passes them.
// gitPushChecks.discover adds every checkout found under its roots (to
// maxDepth) whose push URL is on github.com over https, at every check, so a
// checkout nobody listed is still covered. Discovered checkouts get the
// routing, ls-remote and stuck checks, and the write probe when they look
// like push checkouts (commits ahead of the remote, a pinned helper, or an
// explicit gitCredentials route); the tracked-ignored check stays opt-in per
// listed checkout. The openclaw dir (git sync's own repo) is never discovered.
// Each problem is announced to the owner once per episode, with the checkout
// and the fix, and once more when it clears. Credentials are compared by a
// hash of user and password and never logged, stored or sent; git runs in the
// gateway's environment (the one the agent pushes from) with prompts off,
// and nothing is fetched, written or pushed in the checkout.
const kStateFileName = "git-push-checks.json";
const kGitTimeoutMs = 20_000;
const kMaxCheckouts = 32;
const kMaxAheadCommits = 500;
const kMaxListedPaths = 5000;
const kShownPaths = 3;
const kIntervalBounds = Object.freeze({ min: 5, max: 1440, fallback: 10 });
const kStuckBounds = Object.freeze({ min: 5, max: 10080, fallback: 30 });
const kRemotePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const kBranchRefPattern = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;
// Codes that can be a passing network blip are announced only when two
// checks in a row see them.
const kRetryCodes = new Set(["ls_remote_failed", "ls_remote_timeout", "push_probe_failed", "push_probe_timeout"]);
const kProbeRefspec = "refs/alphaclaw-push-probe/none/*:refs/alphaclaw-push-probe/none/*";
const kMaxDiscovered = 64;
const kMaxVisitedDirs = 5000;
const kDepthBounds = Object.freeze({ min: 0, max: 6, fallback: 3 });
const kSkippedDirNames = new Set(["node_modules", ".git", ".cache", ".npm", ".nvm", ".bun", ".cargo", ".rustup", "proc", "sys", "lost+found"]);
// ls-remote over https runs the checkout's helper chain through one helper
// that answers only "get" (a nested git credential fill on the same chain):
// git sends "store" after a success and "erase" after a 401, and either one
// would rewrite or delete a token a helper saved, which a read-only check
// must never do.
const kGetOnlyHelper = "!f() { test \"$1\" = get || exit 0; GIT_CONFIG_PARAMETERS= git -c core.askPass= credential fill; }; f";

const boundedMinutes = (value, bounds) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(number)));
};

const normalizeGitPushChecksConfig = (raw = {}) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const checkouts = [];
  const seen = new Set();
  for (const entry of Array.isArray(base.checkouts) ? base.checkouts : []) {
    const rawPath = typeof entry?.path === "string" ? entry.path.trim() : "";
    if (!rawPath || !path.isAbsolute(rawPath) || checkouts.length >= kMaxCheckouts) continue;
    const checkoutPath = path.resolve(rawPath);
    if (seen.has(checkoutPath)) continue;
    seen.add(checkoutPath);
    const remote = typeof entry.remote === "string" && kRemotePattern.test(entry.remote.trim()) ? entry.remote.trim() : "origin";
    const name = typeof entry.name === "string" ? sanitizeLabel(entry.name, { maxLength: 60 }) : "";
    checkouts.push({ path: checkoutPath, remote, ...(name ? { name } : {}) });
  }
  const rawDiscover = base.discover && typeof base.discover === "object" && !Array.isArray(base.discover) ? base.discover : {};
  const absolutePaths = (list) => [...new Set((Array.isArray(list) ? list : []).filter((entry) => typeof entry === "string" && path.isAbsolute(entry.trim())).map((entry) => path.resolve(entry.trim())))];
  const roots = absolutePaths(rawDiscover.roots).slice(0, 8);
  const envFiles = absolutePaths(base.envFiles).slice(0, 8);
  const depth = Number(rawDiscover.maxDepth);
  return {
    checkouts,
    intervalMinutes: boundedMinutes(base.intervalMinutes, kIntervalBounds),
    stuckMinutes: boundedMinutes(base.stuckMinutes, kStuckBounds),
    ...(envFiles.length > 0 ? { envFiles } : {}),
    ...(roots.length > 0
      ? {
          discover: {
            roots,
            maxDepth: Number.isFinite(depth) ? Math.min(kDepthBounds.max, Math.max(kDepthBounds.min, Math.round(depth))) : kDepthBounds.fallback,
            exclude: absolutePaths(rawDiscover.exclude).slice(0, 64),
          },
        }
      : {}),
  };
};

// gitPushChecks.envFiles: .env-format files whose variables the checks add
// to git's environment when the server's own environment lacks them, so a
// checkout helper that reads a token only the pushing process has (a cron
// job's or a worker's env file) answers here too. Never overrides a variable
// the server has, never sets PATH, HOME or a GIT_, LD_ or NODE_ variable, and
// the values are never logged.
const kProtectedEnvKey = /^(PATH|HOME|SHELL|USER|GIT_.*|LD_.*|NODE_.*|DYLD_.*)$/;
const readEnvFiles = (files, fsModule) => {
  const values = {};
  const unreadable = [];
  for (const file of files || []) {
    let content;
    try {
      content = fsModule.readFileSync(file, "utf8");
    } catch (error) {
      unreadable.push(file + " (" + (error.code || "unreadable") + ")");
      continue;
    }
    for (const { key, value } of parseEnvFileContent(content)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || kProtectedEnvKey.test(key) || key in values) continue;
      if (typeof value === "string" && value && !/[\r\n\0]/.test(value)) values[key] = value;
    }
  }
  return { values, unreadable };
};

const isWithin = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// Directories under the roots that hold a .git entry, breadth bounded by
// maxDepth, kMaxDiscovered and kMaxVisitedDirs; symlinks are not followed and
// a checkout's own subdirectories (submodules, nested clones) are not searched.
const discoverCheckouts = async ({ roots, maxDepth, exclude, fsModule }) => {
  const found = [];
  let visited = 0;
  const walk = async (dir, depth, root) => {
    if (found.length >= kMaxDiscovered || visited >= kMaxVisitedDirs) return;
    visited += 1;
    let entries;
    try {
      entries = await fsModule.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      found.push({ path: dir, root });
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory() || kSkippedDirNames.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (exclude.some((skip) => isWithin(child, skip))) continue;
      await walk(child, depth + 1, root);
    }
  };
  for (const root of roots) {
    if (!exclude.some((skip) => isWithin(root, skip))) await walk(root, 0, root);
  }
  return found;
};

const runGit = (execFileImpl, args, { cwd, env, input = "", timeoutMs = kGitTimeoutMs }) =>
  new Promise((resolve) => {
    let child = null;
    try {
      child = execFileImpl(
        "git",
        ["-c", "core.askPass=", ...args],
        { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) =>
          resolve({
            ok: !error,
            exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
            timedOut: Boolean(error?.killed),
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
          }),
      );
    } catch (error) {
      resolve({ ok: false, exitCode: null, timedOut: false, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    child?.stdin?.on?.("error", () => {});
    child?.stdin?.end?.(input);
  });

const buildGitEnv = (baseEnv) => {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return env;
};

// A URL safe to show: no user, password, query or fragment.
const safeUrl = (url) => {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "").replace(/\/\/[^/@]*@/, "//");
  }
};

const credentialOf = (stdout) => {
  const fields = {};
  for (const line of String(stdout || "").split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  if (!fields.password) return null;
  const username = fields.username || "";
  return {
    username,
    hash: crypto.createHash("sha256").update(username + "\n" + fields.password).digest("hex"),
  };
};

// credential.helper and credential.<url>.helper entries that apply to url,
// in the order git reads them (an empty value clears the ones before it).
const urlMatches = (pattern, url) => {
  if (!pattern) return true;
  try {
    const want = new URL(pattern);
    const have = new URL(url);
    if (want.protocol !== have.protocol || want.hostname.toLowerCase() !== have.hostname.toLowerCase()) return false;
    if (want.port && want.port !== have.port) return false;
    const prefix = want.pathname.replace(/\/+$/, "");
    return !prefix || have.pathname === prefix || have.pathname.startsWith(prefix + "/");
  } catch {
    return false;
  }
};

const helperChainOf = (stdout, url, { withValues = false } = {}) => {
  let chain = [];
  for (const line of String(stdout || "").split("\n")) {
    const [scope, origin, rest] = line.split("\t");
    if (rest === undefined) continue;
    const space = rest.indexOf(" ");
    const key = space < 0 ? rest : rest.slice(0, space);
    const value = space < 0 ? "" : rest.slice(space + 1);
    const lower = key.toLowerCase();
    if (!lower.startsWith("credential.") || !lower.endsWith(".helper")) continue;
    if (!urlMatches(key.slice("credential.".length, -".helper".length), url)) continue;
    if (!value.trim()) chain = [];
    else chain.push({ scope, origin: origin.replace(/^file:/, ""), ...(withValues ? { value } : {}) });
  }
  return chain;
};

const isLocalScope = (scope) => scope === "local" || scope === "worktree";

const describeOrigins = (entries) => {
  const unique = [...new Set(entries.map((entry) => entry.scope + " config (" + entry.origin + ")"))];
  return unique.join(", ");
};

const classifyProbe = (run) => {
  const text = run.stderr;
  if (run.timedOut) return "push_probe_timeout";
  if (/repository not found|not found/i.test(text)) return "push_repo_not_found";
  if (/error: 403|permission to .* denied|permission denied|denied to/i.test(text)) return "push_denied";
  if (/error: 401|authentication failed|invalid username or password|could not read (username|password)/i.test(text)) return "push_auth_failed";
  return "push_probe_failed";
};

// A dry-run push that can update nothing: kProbeRefspec matches no local ref,
// so git reads the remote's receive-pack ref advertisement (where the remote
// checks push access) and stops; --no-verify and an empty hooks path keep
// every hook out, and the submodule check is off.
const probeWrite = (git, remote, helperArgs) =>
  git([...helperArgs, "-c", "core.hooksPath=/dev/null", "-c", "push.gpgSign=false", "push", "--dry-run", "--no-verify", "--porcelain", "--recurse-submodules=no", "--", remote, kProbeRefspec], {
    timeoutMs: kGitTimeoutMs * 2,
  });

const isManagedUrl = (url, githubUrl) => {
  try {
    const have = new URL(url);
    const want = new URL(githubUrl);
    return have.protocol === want.protocol && have.host.toLowerCase() === want.host.toLowerCase();
  } catch {
    return false;
  }
};

const inspectCheckout = async ({ checkout, env, execFileImpl, nowMs, stuckMinutes, credentials = null, githubUrl = "https://github.com" }) => {
  const cwd = checkout.path;
  const git = (args, options = {}) => runGit(execFileImpl, args, { cwd, env, ...options });
  const result = { routing: null, write: null, stuck: null, ignored: null, url: "", branch: "", writeProbe: "skipped" };

  if (!checkout.discovered) {
    const ignoredRead = await git(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]);
    const ignoredPaths = ignoredRead.ok ? ignoredRead.stdout.split("\0").filter(Boolean) : [];
    if (ignoredPaths.length > 0) result.ignored = { code: "tracked_ignored", count: ignoredPaths.length, paths: ignoredPaths };
  }

  const urlRead = await git(["remote", "get-url", "--push", checkout.remote]);
  const url = urlRead.ok ? urlRead.stdout.trim() : "";
  if (checkout.discovered && !isManagedUrl(url, githubUrl)) return { ...result, skipped: true };
  if (!url) {
    result.routing = { code: "not_a_checkout" };
    return result;
  }
  result.url = safeUrl(url);
  const isHttp = /^https?:\/\//i.test(url);

  let pinned = false;
  let actual = null;
  if (isHttp) {
    const configRead = await git(["config", "--show-scope", "--show-origin", "--get-regexp", "^credential\\..*helper$"]);
    const chain = helperChainOf(configRead.stdout, url);
    pinned = chain.some((entry) => isLocalScope(entry.scope));
    const request = "url=" + url + "\n\n";
    actual = credentialOf((await git(["credential", "fill"], { input: request })).stdout);
    if (pinned) {
      const own = credentialOf(
        (await git(["credential", "fill"], {
          input: request,
          env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        })).stdout,
      );
      const ahead = chain.slice(0, chain.findIndex((entry) => isLocalScope(entry.scope))).filter((entry) => !isLocalScope(entry.scope));
      if (!own) {
        result.routing = { code: "own_helper_silent", ahead: describeOrigins(ahead) };
      } else if (!actual || actual.hash !== own.hash) {
        result.routing = {
          code: "wrong_identity",
          answered: Boolean(actual),
          sameUser: Boolean(actual) && actual.username === own.username,
          ahead: describeOrigins(ahead) || "a helper set outside this checkout",
        };
      }
    }
  }

  const branchRead = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchRead.ok ? branchRead.stdout.trim() : "";
  let remoteRef = "";
  if (branch) {
    const upstreamRemote = (await git(["config", "--get", "branch." + branch + ".remote"])).stdout.trim();
    const merge = (await git(["config", "--get", "branch." + branch + ".merge"])).stdout.trim();
    remoteRef = upstreamRemote === checkout.remote && kBranchRefPattern.test(merge) ? merge : "refs/heads/" + branch;
    if (!kBranchRefPattern.test(remoteRef)) remoteRef = "";
  }
  result.branch = remoteRef.replace(/^refs\/heads\//, "");

  const getOnly = isHttp ? ["-c", "credential.helper=", "-c", "credential.helper=" + kGetOnlyHelper] : [];
  const listed = await git([...getOnly, "ls-remote", "--", checkout.remote, ...(remoteRef ? [remoteRef] : ["HEAD"])], {
    timeoutMs: kGitTimeoutMs * 2,
  });
  let remoteSha = "";
  if (listed.ok) {
    remoteSha = (listed.stdout.split("\n")[0] || "").split("\t")[0].trim();
  } else if (!result.routing) {
    const text = listed.stderr;
    let code = "ls_remote_failed";
    if (listed.timedOut) code = "ls_remote_timeout";
    else if (/repository not found|not found/i.test(text)) code = "repo_not_found";
    else if (/authentication failed|invalid username or password|permission denied|403|could not read username/i.test(text)) code = "auth_failed";
    result.routing = { code, exitCode: listed.exitCode };
  }

  let aheadCount = 0;
  if (remoteRef) {
    let base = "";
    if (/^[0-9a-f]{40,64}$/.test(remoteSha) && (await git(["cat-file", "-e", remoteSha + "^{commit}"])).ok) {
      base = remoteSha;
    } else {
      const tracking = "refs/remotes/" + checkout.remote + "/" + result.branch;
      if ((await git(["rev-parse", "--verify", "--quiet", tracking + "^{commit}"])).ok) base = tracking;
    }
    const log = base ? await git(["log", "--format=%ct", "--max-count=" + kMaxAheadCommits, base + "..HEAD"]) : null;
    const times = log?.ok ? log.stdout.split("\n").map(Number).filter((value) => Number.isFinite(value) && value > 0) : [];
    aheadCount = times.length;
    if (times.length > 0) {
      const oldestMs = Math.min(...times) * 1000;
      if (nowMs - oldestMs >= stuckMinutes * 60_000) {
        result.stuck = { code: "stuck_push", count: times.length, capped: times.length >= kMaxAheadCommits, oldestMs };
      }
    }
  }

  if (!isHttp || result.routing) return result;
  let repo = "";
  try {
    repo = repoOfPath(new URL(url).pathname);
  } catch {}
  result.repo = repo;
  const routes = credentials?.settings?.routes || [];
  const explicitRoute = routes.some((route) => route.repo !== "*" && (route.repo === repo || route.repo === repo.split("/")[0] + "/*"));
  if (!checkout.discovered || pinned || aheadCount > 0 || explicitRoute) {
    if (!actual) {
      result.write = { code: "no_credential" };
    } else {
      const probed = await probeWrite(git, checkout.remote, getOnly);
      result.writeProbe = "ok";
      if (!probed.ok) result.write = { code: classifyProbe(probed), exitCode: probed.exitCode };
    }
  }
  if (credentials?.status === "preview" && credentials.launcherPath && isManagedUrl(url, githubUrl)) {
    if (!resolveGitCredentialRoute(routes, repo)) {
      result.managed = "no_route";
    } else {
      const managed = await probeWrite(git, checkout.remote, ["-c", "credential.helper=", "-c", "credential.helper=" + credentials.launcherPath, "-c", "credential.useHttpPath=true"]);
      result.managed = managed.ok ? "ok" : classifyProbe(managed);
    }
  }
  return result;
};

const formatDuration = (ms) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return minutes + " min";
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + " h" : Math.round(hours / 24) + " days";
};

const kReachReasons = {
  not_a_checkout: (c) => "it is not a git checkout with a remote named \"" + c.remote + "\"",
  repo_not_found: () => "GitHub answers \"Repository not found\", which usually means the credential git picks cannot see this repository",
  auth_failed: () => "the remote refuses the credential git picks (authentication failed)",
  ls_remote_timeout: () => "git ls-remote timed out on two checks in a row",
  ls_remote_failed: (c, p) => "git ls-remote failed on two checks in a row" + (p.exitCode !== null && p.exitCode !== undefined ? " (exit " + p.exitCode + ")" : ""),
};

const kWriteReasons = {
  no_credential: "no credential helper gives git a credential for it, so a push has nothing to authenticate with",
  push_repo_not_found: "GitHub answers \"Repository not found\" on the push service, which means the credential git picks cannot push to this repository (or cannot see it)",
  push_denied: "the remote refuses pushes with the credential git picks (permission denied)",
  push_auth_failed: "the remote refuses the credential git picks for pushing (authentication failed)",
  push_probe_timeout: "the push check timed out on two checks in a row",
  push_probe_failed: "the push check failed on two checks in a row",
};

const buildProblemMessage = (checkout, kind, problem, { url, branch, stuckMinutes, nowMs, listPath, repo }) => {
  const label = checkout.name || path.basename(checkout.path);
  const where = "\"" + label + "\" (" + checkout.path + ")";
  if (kind === "ignored") {
    const shown = problem.paths.slice(0, kShownPaths).map((entry) => sanitizeLabel(entry, { maxLength: 120 })).join(", ");
    const more = problem.count > kShownPaths ? " and " + (problem.count - kShownPaths) + " more" : "";
    return [
      "⚠️ Push checkout " + where + " tracks " + problem.count + " file(s) that its ignore rules exclude, so they are committed and pushed anyway: " + shown + more + "." + (listPath ? " Full list: " + listPath + "." : ""),
      "Fix: untrack them with git -C " + checkout.path + " rm --cached -- <path> and commit. Files already pushed stay in the remote's history until it is rewritten.",
    ].join("\n");
  }
  const inspect = "git -C " + checkout.path + " config --show-origin --get-regexp '^credential\\.'";
  if (kind === "write") {
    const reason = kWriteReasons[problem.code] || kWriteReasons.push_probe_failed;
    return [
      "⚠️ Pushes from " + where + " to " + url + " would fail: " + reason + ". Fetch and ls-remote can still work, because they only read.",
      "Fix: give this repository a token that can push, with a gitCredentials.routes entry in alphaclaw.json (repo \"" + (repo || "owner/repo") + "\", tokenEnv naming the env var that holds the token), or check which helpers answer with " + inspect + ".",
    ].join("\n");
  }
  if (kind === "stuck") {
    const count = problem.count + (problem.capped ? "+" : "");
    return [
      "⚠️ Push checkout " + where + " has " + count + " commit(s) that are not on " + checkout.remote + "/" + branch + ", the oldest from " + new Date(problem.oldestMs).toISOString().replace(".000Z", "Z") + " (" + formatDuration(nowMs - problem.oldestMs) + " ago, over the " + stuckMinutes + "-minute limit). Its pushes may be failing.",
      "Fix: run git -C " + checkout.path + " push " + checkout.remote + " " + branch + " and read the error. If it says \"Repository not found\", check which credential helpers answer with " + inspect + ".",
    ].join("\n");
  }
  if (problem.code === "wrong_identity") {
    const answer = problem.answered
      ? problem.sameUser
        ? "a different token for the same user"
        : "as a different user"
      : "with nothing";
    return [
      "⚠️ Pushes from " + where + " to " + url + " use the wrong GitHub credential. The checkout's own credential helper answers, but git asks " + problem.ahead + " first and that answers " + answer + ", so pushes can fail with \"Repository not found\".",
      "Fix: in " + checkout.path + "/.git/config, add an empty \"helper =\" line right above the checkout's own \"helper = ...\" line. That clears every helper set outside this checkout for this checkout only, so other repositories and gh keep working.",
    ].join("\n");
  }
  if (problem.code === "own_helper_silent") {
    return [
      "⚠️ The credential helper that " + where + " pins for " + url + " returns no credential in AlphaClaw's environment, so its pushes use whatever other helper answers" + (problem.ahead ? " (" + problem.ahead + ")" : "") + ".",
      "Fix: check that helper in " + checkout.path + "/.git/config and the token it reads. If the token is only in the environment of the process that pushes (a cron job or a worker), add the env file that holds it to gitPushChecks.envFiles in alphaclaw.json so the check sees it too.",
    ].join("\n");
  }
  const reason = (kReachReasons[problem.code] || kReachReasons.ls_remote_failed)(checkout, problem);
  if (problem.code === "not_a_checkout") {
    return "⚠️ AlphaClaw cannot check push checkout " + where + ": " + reason + ".\nFix: correct gitPushChecks.checkouts in alphaclaw.json.";
  }
  return [
    "⚠️ Push checkout " + where + " cannot reach " + url + ": " + reason + ".",
    "Fix: see which credential helpers answer with " + inspect + ". If a helper outside the checkout comes first, add an empty \"helper =\" line right above the checkout's own \"helper = ...\" line in its .git/config.",
  ].join("\n");
};

const buildClearedMessage = (checkout, kind, stuckMinutes) => {
  const label = checkout.name || path.basename(checkout.path);
  if (kind === "ignored") return "✅ Push checkout \"" + label + "\" no longer tracks files its ignore rules exclude.";
  if (kind === "write") return "✅ Push checkout \"" + label + "\" can push to its remote again.";
  return kind === "stuck"
    ? "✅ Push checkout \"" + label + "\" has no unpushed commits older than " + stuckMinutes + " min any more."
    : "✅ Push checkout \"" + label + "\" pushes with its own credential and reaches its remote again.";
};

const createGitPushChecks = ({
  openclawDir,
  readConfig,
  getEnv = () => process.env,
  notify,
  recordEvent,
  execFileImpl = execFile,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  managedCredentials = null,
  githubUrl = "https://github.com",
}) => {
  const statePath = path.join(openclawDir, ".alphaclaw", kStateFileName);
  const listPathOf = (checkout) =>
    path.join(openclawDir, ".alphaclaw", "git-push-checks", "tracked-ignored-" + crypto.createHash("sha256").update(checkout.path).digest("hex").slice(0, 12) + ".txt");
  const writeList = (checkout, paths) => {
    const listPath = listPathOf(checkout);
    try {
      fsModule.mkdirSync(path.dirname(listPath), { recursive: true, mode: 0o700 });
      // eslint-disable-next-line no-control-regex
      const listed = paths.slice(0, kMaxListedPaths).map((entry) => entry.replace(/[\u0000-\u001F\u007F]/g, "?"));
      const tail = paths.length > listed.length ? ["… and " + (paths.length - listed.length) + " more"] : [];
      writeFileAtomic(listPath, [checkout.path, ...listed, ...tail].join("\n") + "\n", { fsModule, mode: 0o600 });
      return listPath;
    } catch (error) {
      logger.warn?.("[alphaclaw] git-push-check list write failed: " + error.message);
      return "";
    }
  };
  const lastLogged = new Map();
  let lastDiscovery = "";
  let lastEnvLine = "";
  let timer = null;
  let running = null;
  let stopped = false;

  const readState = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(statePath, "utf8"));
      return parsed && typeof parsed.checkouts === "object" && parsed.checkouts ? parsed : { checkouts: {} };
    } catch {
      return { checkouts: {} };
    }
  };
  const writeState = (state) => {
    try {
      fsModule.mkdirSync(path.dirname(statePath), { recursive: true });
      writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n", { fsModule, mode: 0o600 });
    } catch (error) {
      logger.warn?.("[alphaclaw] git-push-check state write failed: " + error.message);
    }
  };
  const send = async (message, id, event) => {
    try {
      const result = await notify?.(message, { eventType: "health", id });
      if (result?.ok === false && result.skipped !== true) throw new Error(String(result.reason || "the notifier did not accept it"));
    } catch (error) {
      logger.warn?.("[alphaclaw] git-push-check notification " + id + " failed, retrying next check: " + error.message);
      return false;
    }
    try {
      recordEvent?.(event);
    } catch {}
    return true;
  };

  const settle = async ({ checkout, kind, problem, previous, context }) => {
    const nowMs = context.nowMs;
    const label = checkout.name || path.basename(checkout.path);
    if (!problem) {
      if (kind === "ignored") {
        try {
          fsModule.rmSync(listPathOf(checkout), { force: true });
        } catch {}
      }
      if (!previous?.notifiedAt) return null;
      const sent = await send(buildClearedMessage(checkout, kind, context.stuckMinutes), "git-push-check-" + kind + "-cleared-" + checkout.path + "-" + previous.since, {
        eventType: "git_push_check", source: "git-push-check", status: "ok", details: { checkout: label, kind, code: previous.code, since: previous.since },
      });
      return sent ? null : previous;
    }
    const same = previous?.code === problem.code;
    const next = {
      code: problem.code,
      since: same ? previous.since : new Date(nowMs).toISOString(),
      runs: same ? (Number(previous.runs) || 0) + 1 : 1,
      notifiedAt: same ? previous.notifiedAt || null : null,
    };
    if (next.notifiedAt || next.runs < (kRetryCodes.has(problem.code) ? 2 : 1)) return next;
    const listPath = kind === "ignored" ? writeList(checkout, problem.paths) : "";
    const sent = await send(buildProblemMessage(checkout, kind, problem, { ...context, listPath }), "git-push-check-" + kind + "-" + checkout.path + "-" + next.since, {
      eventType: "git_push_check", source: "git-push-check", status: "warning", details: { checkout: label, kind, code: problem.code, since: next.since, ...(kind === "ignored" ? { count: problem.count } : {}) },
    });
    if (sent) next.notifiedAt = new Date(nowMs).toISOString();
    return next;
  };

  const listCheckouts = async (config) => {
    if (!config.discover) return config.checkouts;
    const listed = new Set(config.checkouts.map((checkout) => checkout.path));
    const found = await discoverCheckouts({ ...config.discover, exclude: [...config.discover.exclude, path.resolve(openclawDir)], fsModule });
    const discovered = found
      .filter((entry) => !listed.has(entry.path))
      .map((entry) => ({ path: entry.path, remote: "origin", name: sanitizeLabel(path.relative(entry.root, entry.path) || path.basename(entry.path), { maxLength: 60 }), discovered: true }));
    const line = "[alphaclaw] git-push-check discovery: found " + found.length + " git checkout(s) under " + config.discover.roots.join(", ") + " (depth " + config.discover.maxDepth + ")" + (found.length >= kMaxDiscovered ? ", capped" : "");
    if (line !== lastDiscovery) {
      lastDiscovery = line;
      logger.log?.(line);
    }
    return [...config.checkouts, ...discovered];
  };

  const check = async () => {
    const config = normalizeGitPushChecksConfig(readConfig?.() || {});
    const state = readState();
    const nextState = { checkouts: {} };
    const credentials = managedCredentials ? await managedCredentials.ensure(getEnv() || {}) : null;
    if (config.checkouts.length === 0 && !config.discover) {
      if (Object.keys(state.checkouts).length > 0) writeState(nextState);
      return { config, credentials, results: [] };
    }
    const baseEnv = getEnv() || {};
    const extra = readEnvFiles(config.envFiles, fsModule);
    const envLine = extra.unreadable.length > 0 ? "[alphaclaw] git-push-check env file unreadable: " + extra.unreadable.join(", ") : "";
    if (envLine !== lastEnvLine) {
      lastEnvLine = envLine;
      if (envLine) logger.warn?.(envLine);
    }
    const filled = Object.fromEntries(Object.entries(extra.values).filter(([key]) => !baseEnv[key]));
    const env = buildGitEnv({ ...baseEnv, ...filled });
    const results = [];
    for (const checkout of await listCheckouts(config)) {
      const nowMs = nowFn();
      const inspected = await inspectCheckout({ checkout, env, execFileImpl, nowMs, stuckMinutes: config.stuckMinutes, credentials, githubUrl });
      if (inspected.skipped) continue;
      const context = { url: inspected.url, branch: inspected.branch, repo: inspected.repo, stuckMinutes: config.stuckMinutes, nowMs };
      const previous = state.checkouts[checkout.path] || {};
      const entry = {};
      for (const kind of ["routing", "write", "stuck", "ignored"]) {
        const settled = await settle({ checkout, kind, problem: inspected[kind], previous: previous[kind], context });
        if (settled) entry[kind] = settled;
      }
      if (Object.keys(entry).length > 0) nextState.checkouts[checkout.path] = entry;
      const summary = [
        inspected.routing?.code || "routing=ok",
        "write=" + (inspected.write?.code || inspected.writeProbe),
        ...(inspected.managed ? ["managed=" + inspected.managed] : []),
        inspected.stuck ? "stuck=" + inspected.stuck.count : "stuck=none",
        ...(checkout.discovered ? [] : ["tracked_ignored=" + (inspected.ignored?.count || 0)]),
      ].join(" ");
      if (lastLogged.get(checkout.path) !== summary) {
        lastLogged.set(checkout.path, summary);
        logger.log?.("[alphaclaw] git-push-check " + (checkout.name || path.basename(checkout.path)) + ": " + summary);
      }
      results.push({ checkout, ...inspected, ignored: inspected.ignored ? { code: inspected.ignored.code, count: inspected.ignored.count } : null });
    }
    writeState(nextState);
    return { config, credentials, results };
  };

  const schedule = (delayMs) => {
    if (stopped) return;
    timer = setTimer(async () => {
      timer = null;
      let intervalMinutes = kIntervalBounds.fallback;
      try {
        running = check();
        intervalMinutes = (await running).config.intervalMinutes;
      } catch (error) {
        logger.warn?.("[alphaclaw] git-push-check failed: " + error.message);
      } finally {
        running = null;
      }
      schedule(intervalMinutes * 60_000);
    }, delayMs);
    timer?.unref?.();
  };

  const start = () => {
    if (timer || running || stopped) return;
    schedule(0);
  };
  const stop = () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  };

  return { check, start, stop };
};

module.exports = {
  createGitPushChecks,
  runGit,
  buildGitEnv,
  discoverCheckouts,
  kProbeRefspec,
  normalizeGitPushChecksConfig,
  helperChainOf,
  safeUrl,
  kStuckBounds,
  kIntervalBounds,
};
