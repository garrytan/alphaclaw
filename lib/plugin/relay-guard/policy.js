const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveCanonicalPath, isPathInsideRoot } = require("../../server/utils/safe-path");

// The relay guard's policy, kept apart from the plugin entry so it can be
// tested without OpenClaw. A relay call is one OpenClaw runs for a relay
// peer: session key agent:<id>:relay-<peer>, or the bridge's run id
// relay-<message id> (bridge.js relayRunId). It may use only the read-only
// tools below; session_status only on its own session and without a model
// change (its model param patches the session). read, ls, glob and grep are contained to the agent workspace
// and the log dirs, checked on the canonical (realpath) target with the same
// rule as the Setup UI's file browser (utils/safe-path.js), and /proc, /sys,
// .env files, the relay directory, auth profiles and databases are refused
// wherever they are. Only plain paths are checked: a reference with a URI
// scheme or a MEDIA: prefix (OpenClaw resolves file:, media:// and others to
// places outside the workspace) is refused before any resolution, and so is
// a relative path while a run cwd is configured, since OpenClaw then resolves
// it against that cwd. Only this tool-name allowlist is published; the private
// path rules are AlphaClaw's own.
const kRelayAllowedTools = Object.freeze(["read", "ls", "glob", "grep", "session_status", "agents_list"]);
const kPathTools = new Set(["read", "ls", "glob", "grep"]);
const kRelaySessionPattern = /^agent:[^:]+:relay-/i;
const kRelayRunPrefix = "relay-";
const kActiveRelayStates = ["dispatched", "completing", "reconciling"];
const kWalkBudget = 5000;
const kDatabasePattern = /\.(?:db|sqlite3?)(?:-wal|-shm|-journal)?$/i;
const kGlobCharPattern = /[*?[\]{}!]/;
const kReferencePattern = /^[@\s]*(?:[A-Za-z][A-Za-z0-9+.-]*:|MEDIA\s*:)/i;
const kPathKeys = {
  read: ["path", "file_path", "filePath", "file"],
  ls: ["path", "dir", "directory"],
  glob: ["path", "cwd", "dir", "directory", "root"],
  grep: ["path", "cwd", "dir", "directory", "root", "file"],
};

// "relay": a relay peer's call. "other": a session that is provably not a
// relay session. "unknown": OpenClaw passed neither a session key nor a run
// id (the tool_search catalog and plugin-tools MCP wrappers can do that).
const classifyCall = ({ sessionKey, runId } = {}) => {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const run = typeof runId === "string" ? runId.trim() : "";
  if (kRelaySessionPattern.test(key) || run.startsWith(kRelayRunPrefix)) return "relay";
  return key || run ? "other" : "unknown";
};

const agentIdOf = ({ agentId, sessionKey } = {}) => {
  if (typeof agentId === "string" && agentId.trim()) return agentId.trim().toLowerCase();
  const match = /^agent:([^:]+):/i.exec(String(sessionKey || ""));
  return match ? match[1].toLowerCase() : "main";
};

const expandHome = (value) => (value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value);

// The agent's workspace as OpenClaw resolves it for the common layouts: its
// own agents.list entry, else the defaults' workspace (a sub-folder for a
// non-default agent), else <state dir>/workspace[-<id>].
const resolveAgentWorkspace = ({ config, agentId, rootDir, env = process.env }) => {
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const entry = list.find((agent) => String(agent?.id || "").trim().toLowerCase() === agentId);
  if (typeof entry?.workspace === "string" && entry.workspace.trim()) return path.resolve(expandHome(entry.workspace.trim()));
  const defaultId = String((list.find((agent) => agent?.default === true) || list[0])?.id || "main").trim().toLowerCase();
  const fallback = config?.agents?.defaults?.workspace;
  if (typeof fallback === "string" && fallback.trim()) {
    const base = path.resolve(expandHome(fallback.trim()));
    return agentId === defaultId ? base : path.join(base, agentId);
  }
  const stateDir = env.OPENCLAW_STATE_DIR || path.join(rootDir, ".openclaw");
  return path.join(stateDir, agentId === defaultId ? "workspace" : "workspace-" + agentId);
};

const canonicalOrNull = (target, fsModule) => {
  try {
    return fsModule.realpathSync(target);
  } catch {
    return null;
  }
};

const privateReason = (absolutePath, relayDirs) => {
  if (isPathInsideRoot(absolutePath, "/proc") || isPathInsideRoot(absolutePath, "/sys")) return "system files";
  const base = path.basename(absolutePath);
  if (base === ".env" || base.startsWith(".env.")) return "an env file";
  if (relayDirs.some((dir) => isPathInsideRoot(absolutePath, dir))) return "relay data";
  if (absolutePath.split(path.sep).some((segment) => segment.toLowerCase().includes("auth-profiles"))) return "auth profiles";
  if (kDatabasePattern.test(base)) return "a database";
  return null;
};

const buildScope = ({ config, ctx, rootDir, logDirs, env = process.env, fsModule = fs }) => {
  const workspace = resolveAgentWorkspace({ config, agentId: agentIdOf(ctx), rootDir, env });
  const relayDir = path.join(rootDir, "relay");
  const realRelayDir = canonicalOrNull(relayDir, fsModule);
  const roots = [workspace, ...logDirs].map((dir) => canonicalOrNull(dir, fsModule)).filter(Boolean);
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const cwdConfigured = [config?.agents?.defaults?.cwd, ...list.map((agent) => agent?.cwd)].some((cwd) => typeof cwd === "string" && cwd.trim());
  return { workspace, roots, cwdConfigured, relayDirs: realRelayDir && realRelayDir !== relayDir ? [relayDir, realRelayDir] : [relayDir], fsModule };
};

const toAbsolute = (raw, workspace) => path.resolve(workspace, expandHome(raw));

// One requested path against the scope: refused when it names a private
// file, before or after symlinks are resolved, or when its canonical target
// is outside every readable root.
const checkPath = (raw, scope) => {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "an empty path" };
  if (kReferencePattern.test(text)) return { ok: false, reason: "a URL or media reference" };
  const variants = text.startsWith("@") ? [text, text.slice(1).trim()] : [text];
  let canonical = null;
  for (const variant of variants) {
    if (scope.cwdConfigured && !path.isAbsolute(expandHome(variant))) return { ok: false, reason: "a relative path while a run cwd is configured" };
    const absolute = toAbsolute(variant, scope.workspace);
    const lexical = privateReason(absolute, scope.relayDirs);
    if (lexical) return { ok: false, reason: lexical };
    try {
      canonical = resolveCanonicalPath(absolute, { fsModule: scope.fsModule });
    } catch {
      return { ok: false, reason: "a path that cannot be resolved" };
    }
    const resolved = privateReason(canonical, scope.relayDirs);
    if (resolved) return { ok: false, reason: resolved };
    if (!scope.roots.some((root) => isPathInsideRoot(canonical, root))) return { ok: false, reason: "a path outside the agent workspace and logs" };
  }
  return { ok: true, canonical };
};

// glob and grep read a whole tree: every link in it must stay inside the
// readable roots, and grep (which reads contents) refuses a tree holding a
// private file. Over the walk budget counts as unverifiable.
const checkTree = (canonicalDir, scope, { contents }) => {
  let stat;
  try {
    stat = scope.fsModule.statSync(canonicalDir);
  } catch {
    return { ok: true };
  }
  if (!stat.isDirectory()) return { ok: true };
  const stack = [canonicalDir];
  let budget = kWalkBudget;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = scope.fsModule.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { ok: false, reason: "a folder that cannot be read" };
    }
    for (const entry of entries) {
      budget -= 1;
      if (budget <= 0) return { ok: false, reason: "a folder too large to check" };
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = canonicalOrNull(entryPath, scope.fsModule);
        if (!target || privateReason(target, scope.relayDirs) || !scope.roots.some((root) => isPathInsideRoot(target, root))) {
          return { ok: false, reason: "a folder with a link that leaves the agent workspace" };
        }
        continue;
      }
      if (contents && privateReason(entryPath, scope.relayDirs)) return { ok: false, reason: "a folder that holds " + privateReason(entryPath, scope.relayDirs) };
      if (entry.isDirectory()) stack.push(entryPath);
    }
  }
  return { ok: true };
};

const globBase = (pattern) => {
  const parts = String(pattern).split(/[\\/]/);
  const fixed = [];
  for (const part of parts) {
    if (kGlobCharPattern.test(part)) break;
    fixed.push(part);
  }
  const rest = parts.slice(fixed.length);
  if (rest.includes("..")) return null;
  if (!rest.length) fixed.pop();
  const base = fixed.join("/");
  return base || (String(pattern).startsWith("/") ? "/" : ".");
};

const firstString = (params, keys) => {
  for (const key of keys) if (typeof params?.[key] === "string" && params[key].trim()) return params[key];
  return null;
};

// { allow: true } or { allow: false, reason }. Throws only on a bug; the
// plugin turns a throw into a deny for relay calls.
const decideRelayToolCall = ({ toolName, params = {}, derivedPaths = [], scope, sessionKey }) => {
  const name = String(toolName || "").trim().toLowerCase();
  if (!kRelayAllowedTools.includes(name)) return { allow: false, reason: name + " is not available in a relay session" };
  if (name === "session_status") {
    if (params?.model !== undefined && params?.model !== null) return { allow: false, reason: "changing the model is not allowed in a relay session" };
    const target = params?.sessionKey;
    if (target === undefined || target === null || target === "") return { allow: true };
    const own = typeof sessionKey === "string" ? sessionKey.trim().toLowerCase() : "";
    if (own && typeof target === "string" && target.trim().toLowerCase() === own) return { allow: true };
    return { allow: false, reason: "session_status of another session is not allowed in a relay session" };
  }
  if (!kPathTools.has(name)) return { allow: true };
  if (!scope.roots.length) return { allow: false, reason: "the agent workspace could not be found" };
  const requested = firstString(params, kPathKeys[name]);
  if (name === "read" && !requested) return { allow: false, reason: "read needs a path" };
  const targets = [];
  if (name === "glob" && typeof params.pattern === "string" && params.pattern.trim()) {
    if (kReferencePattern.test(params.pattern)) return { allow: false, reason: "a glob pattern with a URL or media reference is not allowed in a relay session" };
    if (/[{}]/.test(params.pattern)) return { allow: false, reason: "a glob pattern with braces is not allowed in a relay session" };
    const base = globBase(params.pattern.trim());
    if (base === null) return { allow: false, reason: "a glob pattern that climbs out with .." };
    targets.push(path.isAbsolute(base) ? base : path.join(requested || ".", base));
  } else {
    targets.push(requested || ".");
  }
  for (const derived of Array.isArray(derivedPaths) ? derivedPaths : []) if (typeof derived === "string") targets.push(derived);
  for (const target of targets) {
    const checked = checkPath(target, scope);
    if (!checked.ok) return { allow: false, reason: name + " of " + checked.reason + " is not allowed in a relay session" };
    if (name === "glob" || name === "grep") {
      const tree = checkTree(checked.canonical, scope, { contents: name === "grep" });
      if (!tree.ok) return { allow: false, reason: name + " over " + tree.reason + " is not allowed in a relay session" };
    }
  }
  return { allow: true };
};

// Whether the bridge has a relay run in flight (relay/bridge.db, read-only).
// No database means no relay on this box.
const relayRunActive = ({ rootDir, fsModule = fs }) => {
  const dbPath = path.join(rootDir, "relay", "bridge.db");
  if (!fsModule.existsSync(dbPath)) return false;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const placeholders = kActiveRelayStates.map(() => "?").join(", ");
    return Boolean(db.prepare("SELECT 1 AS active FROM relay_messages WHERE state IN (" + placeholders + ") LIMIT 1").get(...kActiveRelayStates));
  } finally {
    db.close();
  }
};

module.exports = {
  kRelayAllowedTools,
  classifyCall,
  agentIdOf,
  resolveAgentWorkspace,
  buildScope,
  decideRelayToolCall,
  relayRunActive,
};
