const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { writeFileAtomic, writeFileAtomicIfChanged } = require("./utils/safe-file");
const { normalizeGitCredentialsConfig } = require("./git-credential-routes");
const { runGit, buildGitEnv, helperChainOf } = require("./git-push-checks");

// One managed GitHub credential helper (GST-3351). A global credential store
// keeps every token that ever worked for github.com and hands back the first
// one for any repository: git runs "store" on every helper after a
// successful authentication, so whichever token worked last moves to the
// front, and a wrapper that turns "erase" into a no-op means a token GitHub
// refuses is never evicted. GitHub answers "Repository not found" for a
// private repository the token cannot see, git never falls back, and reads
// (fetch, ls-remote) can still succeed with a different token.
//
// With alphaclaw.json gitCredentials set, AlphaClaw writes a launcher for
// lib/scripts/git-credential-alphaclaw.js under <openclaw dir>/.alphaclaw/bin/
// (rewritten at each check, so it follows the running node and package) that
// answers github.com by repository path from gitCredentials.routes and stores
// nothing. With gitCredentials.manageGlobalConfig true it also keeps the
// global git config's [credential "https://github.com"] section at exactly
//     helper =                 (clears every helper read before it)
//     helper = <launcher>
//     useHttpPath = true       (so git sends owner/repo to helpers)
// at the end of the file, at boot and at every push check: a section that
// drifted (gh auth setup-git rewrites it) is backed up (0600, the newest 5
// kept) and rewritten, and the owner is told once. Other hosts' helpers and
// every checkout's own .git/config are never touched: a checkout that pins its
// own helper after an empty reset keeps it. Without manageGlobalConfig the
// routes run in preview: the push checks test each checkout's push path with
// the managed helper alone and log the result, and nothing is written.
const kHelperScript = path.join(__dirname, "..", "scripts", "git-credential-alphaclaw.js");
const kSafePathPattern = /^\/[A-Za-z0-9._/-]+$/;
const kMaxBackups = 5;

const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

const createManagedGitCredentials = ({
  openclawDir,
  configPath,
  envFilePath,
  readConfig,
  refusedEnvKeys = [],
  notify,
  githubUrl = "https://github.com",
  nodePath = process.execPath,
  scriptPath = kHelperScript,
  execFileImpl = execFile,
  fsModule = fs,
  logger = console,
  nowFn = Date.now,
}) => {
  const launcherPath = path.join(openclawDir, ".alphaclaw", "bin", "git-credential-alphaclaw");
  const backupDir = path.join(openclawDir, ".alphaclaw", "git-credentials");
  const section = "credential." + githubUrl;
  const probeUrl = githubUrl + "/alphaclaw/probe.git";
  let lastLogged = "";
  let lastRepairNote = "";
  let failureAnnounced = false;

  const readSettings = () => normalizeGitCredentialsConfig(readConfig?.() || {}, { refusedEnvKeys });

  const writeLauncher = () => {
    const assignments = [
      "ALPHACLAW_GIT_CREDENTIAL_CONFIG=" + shellQuote(configPath),
      "ALPHACLAW_GIT_CREDENTIAL_ENV_FILE=" + shellQuote(envFilePath || ""),
      "ALPHACLAW_GIT_CREDENTIAL_REFUSED=" + shellQuote(refusedEnvKeys.join(",")),
      "ALPHACLAW_GIT_CREDENTIAL_URL=" + shellQuote(githubUrl),
    ];
    const text = [
      "#!/bin/sh",
      "# Written by AlphaClaw: its GitHub credential helper (gitCredentials in alphaclaw.json). Rewritten at every check.",
      assignments.join(" ") + " exec " + shellQuote(nodePath) + " " + shellQuote(scriptPath) + ' "$@"',
      "",
    ].join("\n");
    fsModule.mkdirSync(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
    writeFileAtomicIfChanged(launcherPath, text, { fsModule, mode: 0o700 });
    fsModule.chmodSync(launcherPath, 0o700);
  };

  // Read outside any checkout, so only system and global config count.
  const git = (args, env) => runGit(execFileImpl, args, { cwd: "/", env: { ...env, GIT_CEILING_DIRECTORIES: "/" } });

  const inspectGlobal = async (env) => {
    const listing = await git(["config", "--show-scope", "--show-origin", "--get-regexp", "^credential\\..*helper$"], env);
    const chain = helperChainOf(listing.stdout, probeUrl, { withValues: true });
    const httpPath = (await git(["config", "--type=bool", "--get-urlmatch", "credential.useHttpPath", probeUrl], env)).stdout.trim() === "true";
    const ok = httpPath && chain.length === 1 && chain[0].scope === "global" && chain[0].value === launcherPath;
    const origins = [...new Set(chain.filter((entry) => entry.value !== launcherPath).map((entry) => entry.scope + " config (" + entry.origin + ")"))];
    const others = chain.filter((entry) => entry.value !== launcherPath).length;
    const parts = [];
    if (others > 0) parts.push(others + " other helper(s) from " + origins.join(", "));
    if (!chain.some((entry) => entry.value === launcherPath)) parts.push("no AlphaClaw helper");
    if (!httpPath) parts.push("credential.useHttpPath off");
    return { ok, note: parts.join(", ") };
  };

  const globalFileOf = (env) => {
    if (env.GIT_CONFIG_GLOBAL) return env.GIT_CONFIG_GLOBAL;
    const home = path.join(env.HOME || "", ".gitconfig");
    const xdg = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || "", ".config"), "git", "config");
    return !fsModule.existsSync(home) && fsModule.existsSync(xdg) ? xdg : home;
  };

  const backupGlobal = (file) => {
    let content;
    try {
      content = fsModule.readFileSync(file);
    } catch {
      return "";
    }
    fsModule.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, "gitconfig-" + new Date(nowFn()).toISOString().replace(/[:.]/g, "-") + ".bak");
    writeFileAtomic(backupPath, content, { fsModule, mode: 0o600 });
    const backups = fsModule.readdirSync(backupDir).filter((name) => /^gitconfig-.*\.bak$/.test(name)).sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - kMaxBackups))) {
      try {
        fsModule.rmSync(path.join(backupDir, name), { force: true });
      } catch {}
    }
    return backupPath;
  };

  const send = async (message, id) => {
    try {
      const result = await notify?.(message, { eventType: "health", id });
      if (result?.ok === false && result.skipped !== true) throw new Error(String(result.reason || "the notifier did not accept it"));
      return true;
    } catch (error) {
      logger.warn?.("[alphaclaw] git-credentials notification failed, retrying next check: " + error.message);
      return false;
    }
  };

  const report = (result) => {
    const line = "[alphaclaw] git-credentials: " + result.status + " routes=" + result.routes + (result.note ? " (" + result.note + ")" : "") + (result.backupPath ? " backup=" + result.backupPath : "");
    if (line !== lastLogged) {
      lastLogged = line;
      (result.status === "failed" ? logger.warn : logger.log)?.(line);
    }
    return result;
  };

  const ensure = async (baseEnv = process.env) => {
    const settings = readSettings();
    const routes = settings.routes.length;
    if (routes === 0 && !settings.manageGlobalConfig) return { status: "off", routes, settings, launcherPath: "" };
    if (!kSafePathPattern.test(launcherPath)) return report({ status: "failed", routes, settings, launcherPath: "", note: "the launcher path has characters git cannot run" });
    try {
      writeLauncher();
    } catch (error) {
      return report({ status: "failed", routes, settings, launcherPath: "", note: "could not write the launcher: " + error.message });
    }
    if (!settings.manageGlobalConfig) return report({ status: "preview", routes, settings, launcherPath });
    const env = buildGitEnv(baseEnv);
    const file = globalFileOf(env);
    const before = await inspectGlobal(env);
    if (before.ok) {
      failureAnnounced = false;
      return report({ status: "ok", routes, settings, launcherPath });
    }
    let backupPath = "";
    try {
      backupPath = backupGlobal(file);
    } catch (error) {
      return failed({ routes, settings, file, note: "could not back up " + file + ": " + error.message });
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!(await git(["config", "--global", "--remove-section", section], env)).ok) break;
    }
    const writes = [
      ["config", "--global", "--add", section + ".helper", ""],
      ["config", "--global", "--add", section + ".helper", launcherPath],
      ["config", "--global", section + ".useHttpPath", "true"],
    ];
    for (const args of writes) {
      const written = await git(args, env);
      if (!written.ok) return failed({ routes, settings, file, backupPath, note: "git config exited " + written.exitCode });
    }
    const after = await inspectGlobal(env);
    if (!after.ok) return failed({ routes, settings, file, backupPath, note: "still " + after.note + " after the rewrite" });
    failureAnnounced = false;
    if (before.note !== lastRepairNote) {
      const sent = await send(
        [
          "🔧 AlphaClaw put its GitHub credential helper back in the global git config (" + file + "). Before, it found " + before.note + " for github.com, so pushes could go out with a stale or wrong token.",
          "Pushes to GitHub now use the token that gitCredentials.routes in alphaclaw.json names for each repository. The old file is backed up at " + (backupPath || "(no file before)") + ".",
        ].join("\n"),
        "git-credentials-repaired-" + nowFn(),
      );
      if (sent) lastRepairNote = before.note;
    }
    return report({ status: "repaired", routes, settings, launcherPath, note: before.note, backupPath });
  };

  const failed = async ({ routes, settings, file, backupPath = "", note }) => {
    if (!failureAnnounced) {
      failureAnnounced = await send(
        [
          "⚠️ AlphaClaw could not set its GitHub credential helper in the global git config (" + file + "): " + note + ". Pushes to GitHub may use another helper's token.",
          "Fix: check that file" + (backupPath ? " (backup: " + backupPath + ")" : "") + ", or set gitCredentials.manageGlobalConfig to false in alphaclaw.json.",
        ].join("\n"),
        "git-credentials-failed-" + nowFn(),
      );
    }
    return report({ status: "failed", routes, settings, launcherPath, note, backupPath });
  };

  return { ensure, launcherPath };
};

module.exports = { createManagedGitCredentials, kHelperScript };
