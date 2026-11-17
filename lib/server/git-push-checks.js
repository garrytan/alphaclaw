const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { writeFileAtomic } = require("./utils/safe-file");
const { sanitizeLabel } = require("./utils/sanitize-label");

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
const kRetryCodes = new Set(["ls_remote_failed", "ls_remote_timeout"]);

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
  return {
    checkouts,
    intervalMinutes: boundedMinutes(base.intervalMinutes, kIntervalBounds),
    stuckMinutes: boundedMinutes(base.stuckMinutes, kStuckBounds),
  };
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

const helperChainOf = (stdout, url) => {
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
    else chain.push({ scope, origin: origin.replace(/^file:/, "") });
  }
  return chain;
};

const isLocalScope = (scope) => scope === "local" || scope === "worktree";

const describeOrigins = (entries) => {
  const unique = [...new Set(entries.map((entry) => entry.scope + " config (" + entry.origin + ")"))];
  return unique.join(", ");
};

const inspectCheckout = async ({ checkout, env, execFileImpl, nowMs, stuckMinutes }) => {
  const cwd = checkout.path;
  const git = (args, options = {}) => runGit(execFileImpl, args, { cwd, env, ...options });
  const result = { routing: null, stuck: null, ignored: null, url: "", branch: "" };

  const ignoredRead = await git(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]);
  const ignoredPaths = ignoredRead.ok ? ignoredRead.stdout.split("\0").filter(Boolean) : [];
  if (ignoredPaths.length > 0) result.ignored = { code: "tracked_ignored", count: ignoredPaths.length, paths: ignoredPaths };

  const urlRead = await git(["remote", "get-url", "--push", checkout.remote]);
  const url = urlRead.ok ? urlRead.stdout.trim() : "";
  if (!url) {
    result.routing = { code: "not_a_checkout" };
    return result;
  }
  result.url = safeUrl(url);
  const isHttp = /^https?:\/\//i.test(url);

  if (isHttp) {
    const configRead = await git(["config", "--show-scope", "--show-origin", "--get-regexp", "^credential\\..*helper$"]);
    const chain = helperChainOf(configRead.stdout, url);
    const pinned = chain.some((entry) => isLocalScope(entry.scope));
    if (pinned) {
      const request = "url=" + url + "\n\n";
      const actual = credentialOf((await git(["credential", "fill"], { input: request })).stdout);
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
          ownUser: own.username,
          actualUser: actual?.username || "",
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

  const listed = await git(["ls-remote", "--", checkout.remote, ...(remoteRef ? [remoteRef] : ["HEAD"])], {
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

  if (!remoteRef) return result;
  let base = "";
  if (/^[0-9a-f]{40,64}$/.test(remoteSha) && (await git(["cat-file", "-e", remoteSha + "^{commit}"])).ok) {
    base = remoteSha;
  } else {
    const tracking = "refs/remotes/" + checkout.remote + "/" + result.branch;
    if ((await git(["rev-parse", "--verify", "--quiet", tracking + "^{commit}"])).ok) base = tracking;
  }
  if (!base) return result;
  const log = await git(["log", "--format=%ct", "--max-count=" + kMaxAheadCommits, base + "..HEAD"]);
  const times = log.ok ? log.stdout.split("\n").map(Number).filter((value) => Number.isFinite(value) && value > 0) : [];
  if (times.length === 0) return result;
  const oldestMs = Math.min(...times) * 1000;
  if (nowMs - oldestMs >= stuckMinutes * 60_000) {
    result.stuck = { code: "stuck_push", count: times.length, capped: times.length >= kMaxAheadCommits, oldestMs };
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

const buildProblemMessage = (checkout, kind, problem, { url, branch, stuckMinutes, nowMs, listPath }) => {
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
  if (kind === "stuck") {
    const count = problem.count + (problem.capped ? "+" : "");
    return [
      "⚠️ Push checkout " + where + " has " + count + " commit(s) that are not on " + checkout.remote + "/" + branch + ", the oldest from " + new Date(problem.oldestMs).toISOString().replace(".000Z", "Z") + " (" + formatDuration(nowMs - problem.oldestMs) + " ago, over the " + stuckMinutes + "-minute limit). Its pushes may be failing.",
      "Fix: run git -C " + checkout.path + " push " + checkout.remote + " " + branch + " and read the error. If it says \"Repository not found\", check which credential helpers answer with " + inspect + ".",
    ].join("\n");
  }
  if (problem.code === "wrong_identity") {
    const answer = problem.actualUser
      ? problem.sameUser
        ? "a different token for the same user"
        : "as \"" + problem.actualUser + "\""
      : "with nothing";
    return [
      "⚠️ Pushes from " + where + " to " + url + " use the wrong GitHub credential. The checkout's own credential helper answers as \"" + problem.ownUser + "\", but git asks " + problem.ahead + " first and that answers " + answer + ", so pushes can fail with \"Repository not found\".",
      "Fix: in " + checkout.path + "/.git/config, add an empty \"helper =\" line right above the checkout's own \"helper = ...\" line. That clears every helper set outside this checkout for this checkout only, so other repositories and gh keep working.",
    ].join("\n");
  }
  if (problem.code === "own_helper_silent") {
    return [
      "⚠️ The credential helper that " + where + " pins for " + url + " returns no credential, so its pushes use whatever other helper answers" + (problem.ahead ? " (" + problem.ahead + ")" : "") + ".",
      "Fix: check that helper in " + checkout.path + "/.git/config and the token it reads.",
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

  const check = async () => {
    const config = normalizeGitPushChecksConfig(readConfig?.() || {});
    const state = readState();
    const nextState = { checkouts: {} };
    if (config.checkouts.length === 0) {
      if (Object.keys(state.checkouts).length > 0) writeState(nextState);
      return { config, results: [] };
    }
    const env = buildGitEnv(getEnv() || {});
    const results = [];
    for (const checkout of config.checkouts) {
      const nowMs = nowFn();
      const inspected = await inspectCheckout({ checkout, env, execFileImpl, nowMs, stuckMinutes: config.stuckMinutes });
      const context = { url: inspected.url, branch: inspected.branch, stuckMinutes: config.stuckMinutes, nowMs };
      const previous = state.checkouts[checkout.path] || {};
      const entry = {};
      for (const kind of ["routing", "stuck", "ignored"]) {
        const settled = await settle({ checkout, kind, problem: inspected[kind], previous: previous[kind], context });
        if (settled) entry[kind] = settled;
      }
      if (Object.keys(entry).length > 0) nextState.checkouts[checkout.path] = entry;
      const summary = (inspected.routing?.code || "routing=ok") + " " + (inspected.stuck ? "stuck=" + inspected.stuck.count : "stuck=none") + " tracked_ignored=" + (inspected.ignored?.count || 0);
      if (lastLogged.get(checkout.path) !== summary) {
        lastLogged.set(checkout.path, summary);
        logger.log?.("[alphaclaw] git-push-check " + (checkout.name || path.basename(checkout.path)) + ": " + summary);
      }
      results.push({ checkout, ...inspected, ignored: inspected.ignored ? { code: inspected.ignored.code, count: inspected.ignored.count } : null });
    }
    writeState(nextState);
    return { config, results };
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
  normalizeGitPushChecksConfig,
  helperChainOf,
  safeUrl,
  kStuckBounds,
  kIntervalBounds,
};
