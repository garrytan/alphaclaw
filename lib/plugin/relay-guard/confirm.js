const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { fileURLToPath } = require("url");

// Owner confirmations for a delegate's high-risk calls (relay trust v2 PR2,
// GST-2090). Shared by AlphaClaw's relay guard and Wintermute's own guard,
// which both load this file from the plugin directory, so "may this call run"
// has one answer and one record: relay/bridge.db's relay_confirmations.
//
// A guard asks checkConfirmation for one call (sender, action, target,
// binding generation). The first ask writes a "requested" row and the call is
// refused; AlphaClaw's bridge sends the owner one message with a one-time
// link (lib/server/relay/confirmations.js). Approve makes the row "confirmed"
// for 15 minutes and tells the sender, which sends the request again with the
// confirmation_ref; the next matching call is admitted once and the row is
// spent in the same transaction, so two guards, two lanes or a retry after a
// gateway restart can never spend it twice. Anything missing, unreadable or
// mismatched refuses the call.
//
// Kinds:
//   low     the grant is enough (files, shell, memory and the brain)
//   medium  a send to a named person: the carried approval, as before
//   high    config, env, secrets, guard or access changes: a confirmation
// The kind is derived here from the call, never taken from the caller.
// Canonical action and target name key names and paths only, never values.
const kConfirmTtlMs = 15 * 60 * 1000;
const kConfirmationRefPattern = /^rc_[a-f0-9]{16}$/;
const kOpenStates = Object.freeze(["requested", "pending"]);

const kProtectedNames = /^(openclaw\.json|alphaclaw\.json|exec-approvals\.json|\.env(\..+)?|secrets\.json|internal\.secret|provenance-key\.json|auth-profiles\.json)$/i;
const kProtectedSegments = Object.freeze(["relay-guard", "wm-guards"]);
const kRelayFiles = /^((bridge|remote|relaycast|archive)\.db(-wal|-shm|-journal)?|secrets\.json|internal\.secret|provenance-key\.json)$/i;
const kPatchFilePattern = /^\s*\*\*\* (?:Add|Update|Delete) File: (.+)$|^\s*\*\*\* Move to: (.+)$/gm;
const kMutatingAdmin = /\balphaclaw\s+admin\s+(POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s|;&]*)/i;
const kOpenclawChanges = Object.freeze({
  config: ["set", "unset", "apply"],
  secrets: null,
  plugins: ["install", "uninstall", "enable", "disable", "update"],
  gateway: ["install", "uninstall"],
});
// A protected file named anywhere in a shell command (or in input written to
// a running process): the names above, the guards' directories, and the
// relay's databases, by name when sqlite3 opens them or under a relay/ path.
const kShellProtected = /(?:^|[^\w.-])(openclaw\.json|alphaclaw\.json|exec-approvals\.json|secrets\.json|internal\.secret|provenance-key\.json|auth-profiles\.json|\.env(?:\.[\w.-]+)?)(?![\w.-])|(?:^|\/)(relay-guard|wm-guards)\/|relay\/((?:bridge|remote|relaycast|archive)\.db)/;
const kSqliteRelayDb = /\bsqlite3?\b[^|;&]*\b((?:bridge|remote|relaycast|archive)\.db)\b/;
// A command that only reads: every segment starts with one of these and
// nothing redirects, substitutes or runs a nested command.
const kReadOnlyCommands = new Set(["cat", "head", "tail", "grep", "egrep", "fgrep", "wc", "ls", "stat", "file", "jq", "diff", "cmp", "sha256sum", "md5sum", "cd", "test", "true", "pwd"]);
// A command word counts only as a bare name or as /bin/<name> or
// /usr/bin/<name>: /tmp/cat or ./cat is whatever program sits there.
const kBareCommand = /^[A-Za-z0-9_.+-]+$/;
const kSystemCommand = /^(?:\/usr)?\/bin\/([A-Za-z0-9_.+-]+)$/;
const kGlobChars = /[*?[]/;
// The single-line match the guard used before the token scan above: a
// change it caught is always held, whatever the scan makes of the command.
const kOpenclawChangeLoose = /\bopenclaw\s+(config\s+(?:set|unset|apply)|secrets\s+[a-z-]+|plugins\s+(?:install|uninstall|enable|disable|update)|gateway\s+(?:install|uninstall))\b(?:\s+([A-Za-z0-9_.:@\/\[\]-]{1,120}))?/i;
// The automations tool's actions (OpenClaw 2026.11.2 CRON_ACTIONS): a
// delegate reads with the first set; the second changes or starts a job and
// is held for the owner (PR4, GST-2090).
const kAutomationReadActions = Object.freeze(["status", "list", "get", "runs", "next_check"]);
const kAutomationWriteActions = Object.freeze(["add", "update", "remove", "run", "wake"]);
const kMaxOpenPerSender = 5;

// What the delegate chose (a path, a route, a key) reaches the owner's notice
// and its page, so it is cut to letters, digits and . _ / @ + , - before it is
// stored: no transport can build a link, mention or markup from what is left,
// and no redaction pattern can reach past it. Anything else becomes "?".
const kUnsafeChars = /[^A-Za-z0-9._\/@+,-]/g;
const safe = (value, max) => String(value || "").replace(kUnsafeChars, "?").slice(0, max);
const commandHash = (command) => crypto.createHash("sha256").update(String(command)).digest("hex").slice(0, 16);

const matchesProtected = (file, relayDirs) => {
  const segments = file.split("/").filter(Boolean);
  if (kProtectedNames.test(segments[segments.length - 1] || "")) return true;
  if (segments.some((segment) => kProtectedSegments.includes(segment.toLowerCase()))) return true;
  if (segments.length > 1 && segments[segments.length - 2].toLowerCase() === "relay" && kRelayFiles.test(segments[segments.length - 1])) return true;
  return path.posix.isAbsolute(file) && relayDirs.some((dir) => file.startsWith(dir));
};

// The path as OpenClaw's write and edit tools read it (path-utils expandPath
// in 2026.11.2): one leading @ marks a file reference and is dropped (@@x is
// the literal ./@x), and a file: URL is decoded, %2D and %2E included.
// Trailing spaces are kept, as OpenClaw keeps them.
const openclawPathOf = (value) => {
  const referenced = value.startsWith("@") ? value.slice(1) : value;
  const normalized = referenced.startsWith("@") ? "./" + referenced : referenced;
  if (!normalized.startsWith("file://")) return normalized;
  try {
    return fileURLToPath(normalized);
  } catch {
    return normalized;
  }
};

// Every spelling a tool may act on: as written (a literal @ name can exist),
// as OpenClaw reads it, and both trimmed.
const spellingsOf = (value) => {
  const raw = String(value || "").replace(/\\/g, "/");
  const spellings = new Set();
  for (const spelling of [raw, raw.trim()]) {
    spellings.add(spelling);
    spellings.add(openclawPathOf(spelling).replace(/\\/g, "/"));
  }
  return [...spellings].filter((spelling) => spelling.trim());
};

// Where an absolute path lands, walked the way the kernel walks it: one
// component at a time, a symlink replaced by its target before the next
// component (a link whose target does not exist yet included, since a write
// through it creates the target), and .. taken from the real directory
// reached so far, never folded first. Missing components are kept as written.
const kMaxLinkHops = 40;
const landingOf = (file, fsModule) => {
  const queue = file.split("/");
  let current = "/";
  for (let hops = 0; queue.length; ) {
    const part = queue.shift();
    if (!part || part === ".") continue;
    if (part === "..") {
      current = path.posix.dirname(current);
      continue;
    }
    const next = path.posix.join(current, part);
    let link = null;
    try {
      if (fsModule.lstatSync(next).isSymbolicLink()) link = String(fsModule.readlinkSync(next)).replace(/\\/g, "/");
    } catch {}
    if (link === null || hops >= kMaxLinkHops) {
      current = next;
      continue;
    }
    hops += 1;
    if (link.startsWith("/")) current = "/";
    queue.unshift(...link.split("/"));
  }
  return current;
};

const existsAt = (file, fsModule) => {
  try {
    fsModule.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

// Where a write tool's path can land: an absolute or ~ path as it is, a
// relative one against each directory the tool may resolve it from (the
// agent's workspace, the gateway's cwd). Nothing is folded here.
const candidatesOf = (file, bases) => {
  if (file === "~" || file.startsWith("~/")) return [os.homedir().replace(/\\/g, "/") + file.slice(1)];
  if (path.posix.isAbsolute(file)) return [file];
  return bases.map((base) => path.resolve(base).replace(/\\/g, "/") + "/" + file);
};

// The protected files a write would touch, or none. Each spelling is judged
// as written, with . and .. folded, and from every base it lands two ways:
// folded first and then walked, which is what OpenClaw's write, edit and
// apply_patch do (path.resolve or path.normalize, so L/../x is x even when L
// is a link), and walked as written, the kernel's reading a shell gets. The
// hold is bound to the files the write lands on: a protected file reached
// through a link, that exists, or that only one reading reaches wins over a
// bare name match, every such file is named, and a link with a protected name
// that points elsewhere names its real target.
const protectedTargetsOf = (value, rootDir = "", { bases = [], fsModule = fs } = {}) => {
  const relayDir = rootDir ? path.resolve(rootDir, "relay").replace(/\\/g, "/") : "";
  const relayDirs = relayDir ? [...new Set([relayDir, landingOf(relayDir, fsModule)])].map((dir) => dir + "/") : [];
  const bound = new Set();
  let named = null;
  let landed = null;
  let followed = null;
  for (const spelling of spellingsOf(value)) {
    const folded = path.posix.normalize(spelling);
    if (!named && (matchesProtected(spelling, relayDirs) || matchesProtected(folded, relayDirs))) named = folded;
    for (const candidate of candidatesOf(spelling, bases)) {
      const textual = path.posix.normalize(candidate);
      const landings = [...new Set([landingOf(textual, fsModule), landingOf(candidate, fsModule)])];
      const exists = existsAt(candidate, fsModule);
      for (const real of landings) {
        const viaLink = real !== textual;
        if (matchesProtected(real, relayDirs)) {
          if (viaLink || exists || landings.length > 1) bound.add(real);
          else landed = landed || real;
        }
        if (!followed && viaLink && exists) followed = real;
      }
    }
  }
  if (bound.size) return [...bound];
  return named || landed ? [followed || named || landed] : [];
};

const isProtectedPath = (value, rootDir = "", options) => protectedTargetsOf(value, rootDir, options).length > 0;

// The directories a relative write path can be resolved from: OpenClaw
// resolves it against the agent's workspace (rootDir/.openclaw/workspace,
// which the default agent uses whatever its id; workspace-<agent>; or the
// workspace and cwd openclaw.json sets for the agent in agents.list or
// agents.entries, or for every agent), and the gateway's own cwd is checked
// too. Every candidate is kept, so a path that lands on a protected file
// from any of them is held.
const kAgentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const userPathOf = (value) => {
  const dir = String(value || "").trim();
  if (!dir) return "";
  if (dir === "~" || dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(1));
  return path.resolve(dir);
};
const configuredBasesOf = (openclawDir, id, fsModule) => {
  let config;
  try {
    config = JSON.parse(fsModule.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));
  } catch {
    return [];
  }
  const agents = config?.agents || {};
  const roster = agents.entries && typeof agents.entries === "object" && !Array.isArray(agents.entries)
    ? Object.entries(agents.entries).map(([key, value]) => ({ ...(value && typeof value === "object" ? value : {}), id: key }))
    : Array.isArray(agents.list) ? agents.list : [];
  const entry = roster.find((agent) => String(agent?.id || "").trim().toLowerCase() === (id || "main").toLowerCase());
  const defaults = agents.defaults || {};
  const shared = userPathOf(typeof defaults.workspace === "string" ? defaults.workspace : "");
  return [
    typeof entry?.workspace === "string" ? userPathOf(entry.workspace) : "",
    typeof entry?.cwd === "string" ? userPathOf(entry.cwd) : "",
    typeof defaults.cwd === "string" ? userPathOf(defaults.cwd) : "",
    shared,
    shared && id ? path.join(shared, id) : "",
  ].filter(Boolean);
};
const writeBasesOf = ({ rootDir = "", agentId = "", fsModule = fs } = {}) => {
  const bases = [];
  const id = String(agentId || "").trim();
  const knownId = kAgentIdPattern.test(id) ? id : "";
  if (rootDir) {
    const openclawDir = path.join(rootDir, ".openclaw");
    bases.push(path.join(openclawDir, "workspace"));
    if (knownId && knownId.toLowerCase() !== "main") bases.push(path.join(openclawDir, "workspace-" + knownId));
    bases.push(...configuredBasesOf(openclawDir, knownId, fsModule));
  }
  try {
    bases.push(process.cwd());
  } catch {}
  return [...new Set(bases)];
};

const pathsOf = (toolName, params = {}) => {
  const found = [params.path, params.file_path, params.filePath].filter((entry) => typeof entry === "string" && entry.trim());
  if (toolName === "apply_patch") {
    const patch = [params.input, params.patch].find((entry) => typeof entry === "string") || "";
    for (const match of patch.matchAll(kPatchFilePattern)) found.push((match[1] || match[2]).trim());
  }
  return found;
};

const segmentsOf = (command) =>
  command
    .split(/&&|\|\||[;|&\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

const commandNameOf = (word) => (kBareCommand.test(word) ? word : kSystemCommand.exec(word)?.[1] || null);

const isReadOnly = (command) => {
  const cleaned = command.replace(/\d?>\s*\/dev\/null|2>&1/g, " ");
  if (/[<>`]|\$\(/.test(cleaned)) return false;
  return segmentsOf(cleaned).every((segment) => kReadOnlyCommands.has(commandNameOf(segment.split(/\s+/)[0])));
};

// "openclaw [global flags] config set <key>" and the like, in any segment.
const openclawChangeOf = (command) => {
  for (const segment of segmentsOf(command.replace(/["'\\]/g, "").replace(/[`(){}]|\$\(/g, " "))) {
    const tokens = segment.split(/\s+/);
    const at = tokens.findIndex((token) => /(^|\/)openclaw$/i.test(token));
    if (at < 0) continue;
    let i = at + 1;
    while (i < tokens.length && !Object.hasOwn(kOpenclawChanges, tokens[i].toLowerCase())) i += 1;
    if (i >= tokens.length) continue;
    const group = tokens[i].toLowerCase();
    const verb = (tokens[i + 1] || "").toLowerCase();
    const verbs = kOpenclawChanges[group];
    if (!/^[a-z][a-z-]*$/.test(verb) || (verbs && !verbs.includes(verb))) continue;
    const subject = tokens[i + 2] && !tokens[i + 2].startsWith("-") ? tokens[i + 2] : "";
    return "openclaw " + group + " " + verb + (subject ? " " + safe(subject, 120) : "");
  }
  const loose = kOpenclawChangeLoose.exec(command);
  if (!loose) return null;
  const subject = loose[2] && !loose[2].startsWith("-") ? " " + safe(loose[2], 120) : "";
  return "openclaw " + loose[1].trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase() + subject;
};

const protectedNameIn = (text) => {
  const match = kShellProtected.exec(text) || kSqliteRelayDb.exec(text);
  return match ? match.slice(1).find(Boolean) : null;
};

// The old rule: any protected name, unless every segment is a plain read
// with no redirect or substitution.
const namedChangeOf = (command) => {
  const touched = protectedNameIn(command);
  return touched && !isReadOnly(command) ? touched : null;
};

// A shell command whose every word is literal, split into segments of words
// and output redirects; null when anything could expand, run or redirect in
// a way a plain split cannot see: any $ or backtick (quoted too), an unquoted
// backslash, comment, ( ) { } or <, &>, >|, a dup other than 2>&1, an open
// quote or a redirect with no target. Single-quoted text is literal, and
// double-quoted text is too once $ and backticks are gone (only \" and \\
// escape there, and a backslash-newline is dropped, as bash drops it).
const literalSegmentsOf = (command) => {
  if (/[$`]/.test(command)) return null;
  const segments = [];
  let segment = { words: [], redirects: [] };
  let word = null;
  let redirect = null;
  const take = () => (word = word || { value: "", quoted: false });
  const endWord = () => {
    if (!word) return;
    if (redirect) segment.redirects.push({ ...redirect, target: word.value, quoted: word.quoted });
    else segment.words.push(word);
    word = null;
    redirect = null;
  };
  const endSegment = () => {
    endWord();
    if (redirect) return false;
    if (segment.words.length || segment.redirects.length) segments.push(segment);
    segment = { words: [], redirects: [] };
    return true;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    const next = command[i + 1];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      const w = take();
      w.quoted = true;
      w.value += command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      const w = take();
      w.quoted = true;
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && command[i + 1] === "\n") {
          i += 2;
          continue;
        }
        const escaped = command[i] === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\");
        w.value += escaped ? command[i + 1] : command[i];
        i += escaped ? 2 : 1;
      }
      if (i >= command.length) return null;
      i += 1;
    } else if ("\\#(){}<".includes(c)) {
      return null;
    } else if (c === " " || c === "\t") {
      endWord();
      i += 1;
    } else if (c === "\n" || c === ";") {
      if (!endSegment()) return null;
      i += 1;
    } else if (c === "&") {
      if (next === ">" || !endSegment()) return null;
      i += next === "&" ? 2 : 1;
    } else if (c === "|") {
      if (!endSegment()) return null;
      i += next === "|" || next === "&" ? 2 : 1;
    } else if (c === ">") {
      if (redirect) return null;
      let fd = "1";
      if (word && !word.quoted && /^\d$/.test(word.value)) {
        fd = word.value;
        word = null;
      } else endWord();
      const op = next === ">" ? ">>" : ">";
      i += op.length;
      if (command[i] === "|") return null;
      if (command[i] === "&") {
        if (op !== ">" || fd !== "2" || command[i + 1] !== "1" || /[^\s;&|]/.test(command[i + 2] || " ")) return null;
        segment.redirects.push({ fd, op: ">&", target: "1" });
        i += 2;
      } else redirect = { fd, op };
    } else {
      take().value += c;
      i += 1;
    }
  }
  return endSegment() ? segments : null;
};

// Commands allowed in a literal read or note beyond kReadOnlyCommands, each
// with the arguments that keep it from writing or running anything.
const kLiteralCommands = Object.freeze({
  cut: () => true,
  tr: () => true,
  echo: () => true,
  sort: (args) => args.every((arg) => /^-[A-Za-z]+$/.test(arg) && !/[oT]/.test(arg)),
  uniq: (args) => args.every((arg) => /^-[A-Za-z]+$/.test(arg)),
  mkdir: (args) => args.every((arg) => !protectedNameIn(arg) && !kGlobChars.test(arg)),
});

// A note a literal command may write: a .md, .txt or .log file whose name
// does not start with a dot, so no script, binary, config or login file
// (~/.profile, ~/.bashrc) a later command or shell would run or read.
const kNoteFile = /^[^.].*\.(md|txt|log)$/i;

const isExecutableAt = (file, fsModule) => {
  try {
    return (fsModule.statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

// True when a shell command only reads, prints, makes directories and
// writes notes: every segment is literal, its command is on the lists above,
// and every redirect goes to /dev/null, is 2>&1, or writes a plain file that
// is not protected by name or by where it lands (symlinks followed), is a
// .md, .txt or .log note and is not an executable. A relative target is resolved from the agent's
// workspaces, from an absolute exec workdir instead, and from every absolute
// cd before it; after any other cd it is not allowed.
const literalReadOrNoteOf = (command, { rootDir = "", agentId = "", fsModule = fs, workdir } = {}) => {
  const segments = literalSegmentsOf(command);
  if (!segments) return false;
  const dir = typeof workdir === "string" ? workdir.trim() : "";
  let bases = dir && path.isAbsolute(dir) ? [dir] : writeBasesOf({ rootDir, agentId, fsModule });
  let unknownCwd = Boolean(dir) && !path.isAbsolute(dir);
  const writable = (target, quoted) => {
    if (!target || target === "-" || kGlobChars.test(target)) return false;
    if (target.startsWith("~") && (quoted || !target.startsWith("~/"))) return false;
    if (!kNoteFile.test(path.posix.basename(target))) return false;
    if (unknownCwd && !target.startsWith("/") && !target.startsWith("~/")) return false;
    if (protectedNameIn(target) || protectedTargetsOf(target, rootDir, { bases, fsModule }).length) return false;
    return !candidatesOf(target, bases).some((file) => isExecutableAt(file, fsModule));
  };
  for (const { words, redirects } of segments) {
    const first = words[0]?.value || "";
    const name = kGlobChars.test(first) ? null : commandNameOf(first);
    const args = words.slice(1).map((entry) => entry.value);
    if (!name) return false;
    if (!kReadOnlyCommands.has(name) && !(Object.hasOwn(kLiteralCommands, name) && kLiteralCommands[name](args))) return false;
    if (!redirects.every(({ op, target, quoted }) => op === ">&" || target === "/dev/null" || (name === "echo" && writable(target, quoted)))) return false;
    if (name !== "cd") continue;
    const to = args.length === 1 && !kGlobChars.test(args[0]) ? args[0] : "";
    if (to.startsWith("/") || (to.startsWith("~/") && !words[1].quoted)) bases = [...new Set([...bases, ...candidatesOf(to, [])])];
    else unknownCwd = true;
  }
  return true;
};

// What a shell command, or input written to a running process, would
// change. An approved command is that exact command: the target carries a
// hash of all of it (body, flags and value included, none of them shown).
// A shell command that names a protected file (also once quotes and
// backslashes are dropped) is held unless it is a literal read or note.
// With exec env overrides (PATH, LD_PRELOAD) nothing that names one is let
// through. Input typed into a running process keeps the old rule, since what
// reads it (a shell, an editor, a REPL) is unknown.
const shellChangeOf = (command, { env, ...options }) => {
  const touched = protectedNameIn(command) || protectedNameIn(command.replace(/\\\n/g, "").replace(/["'\\]/g, ""));
  if (!touched) return null;
  const customEnv = Boolean(env) && typeof env === "object" && Object.keys(env).length > 0;
  return customEnv || !literalReadOrNoteOf(command, options) ? touched : null;
};

const classifyCommand = (command, { shell = true, ...options } = {}) => {
  const admin = kMutatingAdmin.exec(command.replace(/["']/g, " "));
  const openclaw = admin ? null : openclawChangeOf(command) || openclawAnchorOf(command);
  const touched = admin || openclaw ? null : shell ? shellChangeOf(command, options) : namedChangeOf(command);
  const action = admin
    ? "alphaclaw admin " + admin[1].toUpperCase() + " " + safe(admin[2].split("?")[0], 160)
    : openclaw || (touched ? "run a command on " + safe(touched, 80) : null);
  if (!action) return { kind: "low", action: null, target: null };
  return { kind: "high", action, target: action + " #" + commandHash(command) };
};

// { kind, action, target }. action and target are short, canonical and never
// carry a value: a path, an admin route or a CLI subcommand.
const classifyRisk = ({ toolName, params = {}, rootDir = "", agentId = "", fsModule = fs } = {}) => {
  const name = String(toolName || "").trim().toLowerCase();
  if (name === "message") return { kind: "medium", action: null, target: null };
  if (name === "write" || name === "edit" || name === "apply_patch") {
    const bases = writeBasesOf({ rootDir, agentId, fsModule });
    const files = [...new Set(pathsOf(name, params || {}).flatMap((entry) => protectedTargetsOf(entry, rootDir, { bases, fsModule })))].sort();
    if (!files.length) return { kind: "low", action: null, target: null };
    const names = files.map((file) => safe(path.posix.basename(file), 80)).join(",");
    const list = files.join(",");
    return {
      kind: "high",
      action: name + " " + (names.length > 160 ? names.slice(0, 140) + " +" + files.length + " files" : names),
      target: list.length > 300 ? safe(list, 280) + " #" + commandHash(files.join("\0")) : safe(list, 300),
    };
  }
  if (name === "exec") {
    return classifyCommand(typeof params?.command === "string" ? params.command : Array.isArray(params?.command) ? params.command.join(" ") : "", { rootDir, agentId, fsModule, workdir: params?.workdir, env: params?.env });
  }
  if (name === "automations") {
    const action = String(params?.action || "").trim().toLowerCase();
    if (!kAutomationWriteActions.includes(action)) return { kind: "low", action: null, target: null };
    const job = params?.jobId ?? params?.id ?? params?.job?.name ?? params?.name ?? "";
    const label = "automations " + action + (job ? " " + safe(job, 80) : "");
    return { kind: "high", action: label, target: label + " #" + commandHash(JSON.stringify(params || {})) };
  }
  if (name === "process") {
    const input = [params?.data, params?.text, params?.literal, ...(Array.isArray(params?.keys) ? params.keys : [])].filter((entry) => typeof entry === "string").join(" ");
    return input ? classifyCommand(input, { shell: false }) : { kind: "low", action: null, target: null };
  }
  return { kind: "low", action: null, target: null };
};

// The relay's trust anchor (GST-2323): what decides who is trusted, which an
// attested delegate, trusted like the owner otherwise, still never changes
// from a relay turn. Its writes are refused outright, with no confirmation
// row and nothing sent to the owner; the way through is the repository and a
// deploy, or the box's operator from outside the agent. The anchor is:
//   - anything under the relay's directory (<root>/relay: grants, bindings,
//     secrets, the bridge's rows);
//   - AlphaClaw's own installed code (this package, /app/node_modules/
//     alphaclaw, and any relay-guard directory);
//   - an openclaw.json change that disables, removes or reloads the relay
//     guard (its plugins entry, allow, deny, load paths, plugins.enabled or
//     any $include), judged across every file it includes, and any change to
//     openclaw.json or an included file the guard cannot read the result of
//     (a shell edit, a patch, openclaw config apply or patch, a config set
//     or plugins command the shell fills in, a gateway call of a config
//     write);
//   - an exec whose workdir is inside the relay's directory or AlphaClaw's
//     installed code, unless it only reads;
//   - the trust env names, anywhere a change names them.
// Reads are not changes, and a literal read or note is let through as for
// confirmations, except a read of the relay's keys and databases
// (classifyKeyRead, refused for every tier). The guard checks the anchor on
// every delegate call (GST-2336).
const kAnchorPackageRoots = Object.freeze([...new Set([path.resolve(__dirname, "..", "..", ".."), "/app/node_modules/alphaclaw"])]);
const kAnchorEnvNames = /\b(WM_GUARDS_RELAY_TRUST_PATH|ALPHACLAW_ROOT_DIR|ALPHACLAW_RELAY_DELEGATE_AGENTS|ALPHACLAW_RELAY_CAPY_[A-Z_]+)\b/;
const kAnchorShell = /(?:^|[^\w.-])((?:bridge|remote|relaycast|archive)\.db|internal\.secret|provenance-key\.json)(?![\w.-])|(?:^|[\/\s])(relay\/secrets\.json|\.alphaclaw\/relay(?:\/|\b)|node_modules\/alphaclaw(?:\/|\b)|relay-guard(?:\/|\b))/;
const kGuardPluginId = "relay-guard";
const kOpenclawConfigName = /^openclaw\.json$/i;
const kGuardConfigKey = /^plugins(?:$|\.(?:enabled|allow|deny|load|slots)(?:$|[.[])|\.entries(?:$|\.relay-guard(?:$|[.[])|\[["']?relay-guard))/i;
const kNoteText = /\.(md|txt|log)$/i;

const anchorDirsOf = (rootDir, fsModule) => {
  const dirs = rootDir ? [path.resolve(rootDir, "relay")] : [];
  dirs.push(...kAnchorPackageRoots);
  return [...new Set(dirs.flatMap((dir) => [dir, landingOf(dir.replace(/\\/g, "/"), fsModule)]))].map((dir) => dir.replace(/\\/g, "/").replace(/\/+$/, ""));
};

// Every file a write tool's path can land on, as protectedTargetsOf reads it.
const landingsOf = (value, bases, fsModule) => {
  const out = new Set();
  for (const spelling of spellingsOf(value)) {
    out.add(path.posix.normalize(spelling));
    for (const candidate of candidatesOf(spelling, bases)) {
      out.add(path.posix.normalize(candidate));
      out.add(landingOf(path.posix.normalize(candidate), fsModule));
      out.add(landingOf(candidate, fsModule));
    }
  }
  return [...out];
};

const underAnchor = (file, dirs) => {
  const segments = file.split("/").filter(Boolean);
  if (segments.some((segment) => segment.toLowerCase() === kGuardPluginId)) return true;
  if (segments.length > 1 && segments[segments.length - 2].toLowerCase() === "relay" && kRelayFiles.test(segments[segments.length - 1])) return true;
  return path.posix.isAbsolute(file) && dirs.some((dir) => file === dir || file.startsWith(dir + "/"));
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// What a resolved config holds that keeps the relay guard loaded as it is,
// with the raw $include values of every file it was read from.
const guardStateOf = (config, includes) => {
  const plugins = isPlainObject(config) ? config.plugins : undefined;
  const list = (value) => (Array.isArray(value) ? value.map(String).includes(kGuardPluginId) : value === undefined ? "unset" : "other");
  return JSON.stringify({
    enabled: plugins?.enabled ?? null,
    allow: list(plugins?.allow),
    deny: list(plugins?.deny),
    entry: plugins?.entries?.[kGuardPluginId] ?? null,
    load: plugins?.load ?? null,
    slots: plugins?.slots ?? null,
    includes,
  });
};

const readText = (file, fsModule) => {
  try {
    return fsModule.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const realOf = (file, fsModule) => {
  try {
    return path.normalize(fsModule.realpathSync(file));
  } catch {
    return path.normalize(file);
  }
};

// OpenClaw's include merge (config/includes.ts deepMerge): arrays
// concatenate, objects merge recursively, anything else the source wins.
// Built on null-prototype objects, so a "__proto__" key stays a key.
const kMaxIncludeDepth = 10;
const nullObject = (entries) => Object.assign(Object.create(null), Object.fromEntries(entries));
const deepMerge = (target, source) => {
  if (Array.isArray(target) && Array.isArray(source)) return [...target, ...source];
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const out = nullObject(Object.entries(target));
  for (const [key, value] of Object.entries(source)) out[key] = Object.hasOwn(out, key) ? deepMerge(out[key], value) : value;
  return out;
};

// A config and every file it reads through $include, resolved the way
// OpenClaw 2026.11.2 resolves them (config/includes.ts IncludeProcessor): a
// string or a list of strings, each relative to the file that names it,
// merged in order with sibling keys winning, at most 10 deep and never in a
// cycle. files lists every file the resolution reads (as named and as its
// real path), missing ones too; state is null when anything cannot be read
// or parsed, and a change is then never let past. overrides maps a real
// path to the text a write would leave there.
const resolveConfigGraph = (configFile, fsModule, overrides = new Map()) => {
  const files = [];
  const includes = [];
  const fail = () => {
    throw new Error("unresolved");
  };
  const textOf = (file) => {
    const real = realOf(file, fsModule);
    return overrides.has(real) ? overrides.get(real) : readText(file, fsModule);
  };
  const walk = (value, base, visited, depth) => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, base, visited, depth));
    if (!isPlainObject(value)) return value;
    const own = Object.entries(value);
    if (!Object.hasOwn(value, "$include")) return nullObject(own.map(([key, entry]) => [key, walk(entry, base, visited, depth)]));
    const raw = value.$include;
    includes.push(raw);
    const list = Array.isArray(raw) ? raw : [raw];
    if (!list.every((item) => typeof item === "string" && item && !item.includes("\0"))) fail();
    const loaded = list.map((item) => {
      const target = path.normalize(path.isAbsolute(item) ? item : path.resolve(path.dirname(base), item));
      if (visited.has(target) || depth >= kMaxIncludeDepth) fail();
      return load(target, new Set([...visited, target]), depth + 1);
    });
    const included = Array.isArray(raw) ? loaded.reduce((merged, entry) => deepMerge(merged, entry), Object.create(null)) : loaded[0];
    const siblings = own.filter(([key]) => key !== "$include");
    if (!siblings.length) return included;
    if (!isPlainObject(included)) fail();
    return deepMerge(included, nullObject(siblings.map(([key, entry]) => [key, walk(entry, base, visited, depth)])));
  };
  const load = (file, visited, depth) => {
    files.push(path.normalize(file), realOf(file, fsModule));
    const text = textOf(file);
    if (text === null) fail();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail();
    }
    return walk(parsed, file, visited, depth);
  };
  const root = path.normalize(configFile);
  try {
    const config = load(root, new Set([root]), 0);
    return { state: guardStateOf(config, includes), files: [...new Set(files)] };
  } catch {
    return { state: null, files: [...new Set(files)] };
  }
};

// The live config files: the box's openclaw.json and the gateway's
// OPENCLAW_CONFIG_PATH.
const liveConfigsOf = (rootDir) =>
  [...new Set([rootDir ? path.join(rootDir, ".openclaw", "openclaw.json") : "", process.env.OPENCLAW_CONFIG_PATH || ""].filter((file) => file && path.isAbsolute(file)).map((file) => path.normalize(file)))];

// The replacements of an edit call, in each shape the edit tools take:
// old_string and new_string, OpenClaw's oldText and newText, and its edits
// list of them.
const editEntriesOf = (params) => [params, ...(Array.isArray(params.edits) ? params.edits : [])].filter((entry) => entry && typeof entry === "object");
const editTextsOf = (params) => editEntriesOf(params).flatMap((entry) => [entry.old_string, entry.new_string, entry.oldText, entry.newText]).filter((entry) => typeof entry === "string");

// The file an edit leaves, each replacement matched against the original as
// OpenClaw applies them, or null when that cannot be told. A replacement
// given twice (the native CLI harness sends old_string and new_string and
// the same pair again as edits[0]) is one replacement.
const editedText = (before, params) => {
  const pairs = editEntriesOf(params)
    .map((entry) => [entry.old_string ?? entry.oldText, entry.new_string ?? entry.newText])
    .filter(([from, to]) => typeof from === "string" && typeof to === "string")
    .filter(([from, to], index, all) => all.findIndex(([otherFrom, otherTo]) => otherFrom === from && otherTo === to) === index);
  if (!pairs.length) return null;
  if (pairs.length === 1 && params.replace_all === true) return before.includes(pairs[0][0]) ? before.split(pairs[0][0]).join(pairs[0][1]) : null;
  const spans = pairs.map(([from, to]) => ({ at: before.indexOf(from), from, to })).sort((a, b) => a.at - b.at);
  if (spans.some((span, i) => !span.from || span.at < 0 || (i > 0 && span.at < spans[i - 1].at + spans[i - 1].from.length))) return null;
  return spans.reduceRight((text, span) => text.slice(0, span.at) + span.to + text.slice(span.at + span.from.length), before);
};

// A write, edit or patch of openclaw.json, or of any file it reads through
// $include, keeps the guard's state across the whole resolved config, or it
// is an anchor change. Only a whole write or an edit of exact replacements
// can be checked.
const configChangeTouchesGuard = (name, params, landings, rootDir, fsModule) => {
  const named = landings.filter((file) => path.posix.isAbsolute(file) && kOpenclawConfigName.test(path.posix.basename(file))).map((file) => path.normalize(file));
  for (const root of [...new Set([...named, ...liveConfigsOf(rootDir)])]) {
    const before = resolveConfigGraph(root, fsModule);
    const hit = [...new Set(landings.filter((file) => path.posix.isAbsolute(file) && before.files.includes(path.normalize(file))).map((file) => realOf(file, fsModule)))];
    if (!hit.length) continue;
    if (name === "apply_patch" || before.state === null) return true;
    const overrides = new Map();
    for (const file of hit) {
      let after = null;
      if (name === "write" && typeof params.content === "string") after = params.content;
      if (name === "edit") {
        const text = readText(file, fsModule);
        after = text === null ? null : editedText(text, params);
      }
      if (after === null) return true;
      overrides.set(file, after);
    }
    if (resolveConfigGraph(root, fsModule, overrides).state !== before.state) return true;
  }
  return false;
};

// The segments of a command, split on ; & | and newlines only outside
// quotes, backslash escapes and $( ), ( ) or backtick substitutions, so a
// quoted or substituted separator never cuts an openclaw invocation apart.
const shellSegmentsOf = (command) => {
  const text = String(command).replace(/\\\n/g, "");
  const segments = [];
  let current = "";
  let quote = null;
  let depth = 0;
  let backtick = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && quote !== "'") {
      current += char + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "$" && text[i + 1] === "(") depth += 1;
      else if (quote === '"' && char === ")" && depth > 0) depth -= 1;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "\x60") backtick = !backtick;
    else if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (!backtick && depth === 0 && /[;&|\n]/.test(char)) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
};

// The words of one segment as the guard reads them: every place the shell
// fills in ($(, <(, >(, a backtick, a subshell or function body) becomes a
// word of its own that could be anything, ) { } separate words, and quotes
// and backslashes are dropped, so nothing glues two words together. A word
// with a $ in it is filled in by the shell too.
const kFilledIn = "\u0001";
const shellWordsOf = (segment) =>
  segment
    .replace(/\$\(|[<>]\(|[\x60(]/g, " " + kFilledIn + " ")
    .replace(/[){}]/g, " ")
    .replace(/["'\\]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => (value === kFilledIn ? { value: "", dynamic: true } : { value, dynamic: value.includes("$") }));

const kRedirectWord = /^\d*(?:&?>>?|<<?<?|>&|<&)/;
const kRedirectOperator = /^\d*(?:&?>>?|<<?<?|>&|<&)$/;
// The words after an openclaw word, without redirects and their targets.
const withoutRedirects = (words) => {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    if (kRedirectOperator.test(words[i].value)) {
      i += 1;
      continue;
    }
    if (!kRedirectWord.test(words[i].value)) out.push(words[i]);
  }
  return out;
};

const kOpenclawWord = /(^|\/)openclaw$/i;
// A single simple command of a program that only reads or prints and never
// runs another one: no operator, redirect, substitution, subshell, brace or
// escape anywhere, and $ only as a plain $NAME expansion (which the shell
// never parses as a command). There an openclaw word is an argument
// (grep -rn openclaw $DIR) and changes nothing. Every other command is read
// openclaw-anywhere, so a launcher or shell form this does not know fails
// closed.
const kArgumentOnlyCommands = new Set([...kReadOnlyCommands, "echo", "printf", "journalctl"]);
const argumentOnlyCommand = (command) => {
  const text = String(command);
  if (/[\x60(){}<>|;&\\\n]/.test(text) || /\$(?![A-Za-z_])/.test(text)) return false;
  const first = text.trim().split(/\s+/)[0].replace(/["']/g, "");
  return kArgumentOnlyCommands.has(commandNameOf(first) || "");
};
const kAnchorGroups = /^(config|plugins|gateway)$/i;

// An openclaw CLI change that can drop or reload the guard, in any openclaw
// word of any segment. Every word after openclaw is scanned for the group
// (config, plugins, gateway), as the guard did before; a word up to the key
// that the shell fills in at run time could be anything, so it counts as a
// change, and so does a config set or unset with no key on its line (xargs)
// or from a batch file, config patch, and a gateway call of a config or
// plugins write. A bracket key is read as its dotted form.
const openclawAnchorOf = (command) => {
  if (argumentOnlyCommand(command)) return null;
  for (const segment of shellSegmentsOf(command)) {
    const words = shellWordsOf(segment);
    const starts = words.map((word, index) => (kOpenclawWord.test(word.value) ? index : -1)).filter((index) => index >= 0);
    if (!starts.length && words[0]?.dynamic && words.some((word) => kAnchorGroups.test(word.value))) return "openclaw command the shell fills in";
    for (const at of starts) {
      const change = openclawInvocationAnchorOf(withoutRedirects(words.slice(at + 1)));
      if (change) return change;
    }
  }
  return null;
};

const openclawInvocationAnchorOf = (words) => {
  let group = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].dynamic) return "openclaw command with a part the shell fills in";
    if (kAnchorGroups.test(words[i].value)) {
      group = i;
      break;
    }
  }
  if (group < 0) return null;
  const name = words[group].value.toLowerCase();
  const after = words.slice(group + 1);
  const rest = after.filter((word) => word.dynamic || !word.value.startsWith("-"));
  if (rest[0]?.dynamic) return "openclaw " + name + " with a part the shell fills in";
  const verb = (rest[0]?.value || "").toLowerCase();
  const subjects = rest.slice(1);
  const dynamic = (word) => Boolean(word?.dynamic) || /[$*?]/.test(word?.value || "");
  if (name === "config") {
    if (verb === "apply" || verb === "patch") return "openclaw config " + verb;
    if (verb !== "set" && verb !== "unset") return null;
    if (after.some((word) => /^--batch/i.test(word.value))) return "openclaw config " + verb + " from a batch";
    const key = String(subjects[0]?.value || "").replace(/\[([^\]]+)\]/g, ".$1");
    return !key || dynamic(subjects[0]) || kGuardConfigKey.test(key) ? "openclaw config " + verb + " " + (safe(key, 80) || "with no key") : null;
  }
  if (name === "gateway") {
    if (verb !== "call") return null;
    const method = String(subjects[0]?.value || "").toLowerCase();
    const write = !method || dynamic(subjects[0]) || /^(config\.(apply|patch|set|unset)|plugins\.(install|uninstall|disable|enable|update|reload))/.test(method);
    return write ? "openclaw gateway call " + (safe(method, 80) || "with no method") : null;
  }
  const named = subjects.some((word) => word.value.toLowerCase().includes(kGuardPluginId) || dynamic(word));
  if (["uninstall", "disable", "update", "install", "reload"].includes(verb) && (named || (verb !== "install" && !subjects.length))) return "openclaw plugins " + verb + " relay-guard";
  return null;
};

// The check main (v0.10.261) made, kept word for word and run on every
// command as well, so nothing it refused is let through.
const mainOpenclawAnchorOf = (command) => {
  for (const segment of segmentsOf(command.replace(/["'\\]/g, "").replace(/[\x60(){}]|\$\(/g, " "))) {
    const tokens = segment.split(/\s+/);
    const at = tokens.findIndex((token) => /(^|\/)openclaw$/i.test(token));
    if (at < 0) continue;
    const group = tokens.slice(at + 1).findIndex((token) => /^(config|plugins)$/i.test(token));
    if (group < 0) continue;
    const rest = tokens.slice(at + 2 + group).filter((token) => !token.startsWith("-"));
    const verb = (rest[0] || "").toLowerCase();
    const subjects = rest.slice(1);
    const dynamic = (token) => /[$*?]/.test(token || "");
    if (tokens[at + 1 + group].toLowerCase() === "config") {
      if (verb === "apply") return "openclaw config apply";
      const key = String(rest[1] || "").replace(/\[([^\]]+)\]/g, ".$1");
      if ((verb === "set" || verb === "unset") && (dynamic(key) || kGuardConfigKey.test(key))) return "openclaw config " + verb + " " + safe(key, 80);
      continue;
    }
    if (["uninstall", "disable", "update", "install"].includes(verb) && (subjects.some((token) => token.toLowerCase().includes(kGuardPluginId) || dynamic(token)) || verb !== "install" && !subjects.length)) {
      return "openclaw plugins " + verb + " relay-guard";
    }
  }
  return null;
};

// The free-text options of openclaw's messaging commands: what they carry
// is a message, never a command or a key.
const kFreeTextOptions = new Set(["-m", "--message", "--text", "--caption"]);
const kFreeTextOptionPrefix = /^(--message|--text|--caption)=/;

// A command made only of literal openclaw agent and openclaw message send
// invocations, with their free text dropped, or null. Only literal words
// qualify (literalSegmentsOf: no expansion, substitution or redirect beyond
// /dev/null and 2>&1), so the dropped text can never run.
const messagingCommandOf = (command) => {
  const segments = literalSegmentsOf(command);
  if (!segments || !segments.length) return null;
  const kept = [];
  for (const { words, redirects } of segments) {
    if (!redirects.every(({ op, target }) => op === ">&" || target === "/dev/null")) return null;
    const values = words.map((word) => word.value);
    if (!kOpenclawWord.test(values[0] || "")) return null;
    const group = values.findIndex((value, index) => index > 0 && !value.startsWith("-"));
    const name = (values[group] || "").toLowerCase();
    if (name !== "agent" && !(name === "message" && (values[group + 1] || "").toLowerCase() === "send")) return null;
    const out = [];
    for (let i = 0; i < values.length; i += 1) {
      if (kFreeTextOptions.has(values[i])) {
        i += 1;
        continue;
      }
      if (!kFreeTextOptionPrefix.test(values[i])) out.push(values[i]);
    }
    kept.push(out.join(" "));
  }
  return kept.join("\n");
};

// True when a literal command only reads: every segment is on the read-only
// list and nothing is written anywhere but /dev/null.
const literalReadOnlyOf = (command) => {
  const segments = literalSegmentsOf(command);
  return Boolean(segments) && segments.every(({ words, redirects }) => {
    const first = words[0]?.value || "";
    const name = kGlobChars.test(first) ? null : commandNameOf(first);
    return Boolean(name) && kReadOnlyCommands.has(name) && redirects.every(({ op, target }) => op === ">&" || target === "/dev/null");
  });
};

// Whether an exec workdir lands inside the anchor (the relay's directory or
// AlphaClaw's installed code), from every base a relative workdir can be
// resolved from.
const workdirUnderAnchor = (workdir, { rootDir, agentId, fsModule, dirs }) => {
  const dir = typeof workdir === "string" ? workdir.trim() : "";
  if (!dir) return false;
  const bases = writeBasesOf({ rootDir, agentId, fsModule });
  return landingsOf(dir.replace(/\/+$/, "") || "/", bases, fsModule).some((file) => underAnchor(file, dirs));
};

// A file the live openclaw.json reads through $include (not the root file
// itself), named by path or by base name in a shell command.
const includedFileNamedIn = (plain, rootDir, fsModule) => {
  for (const root of liveConfigsOf(rootDir)) {
    const { files } = resolveConfigGraph(root, fsModule);
    for (const file of files) {
      if (file === root || realOf(root, fsModule) === file) continue;
      const name = path.posix.basename(file);
      if (plain.includes(file) || new RegExp("(?:^|[^\\w.-])" + name.replace(/[^\w-]/g, "\\$&") + "(?![\\w.-])").test(plain)) return file;
    }
  }
  return null;
};

// What an exec command, input typed into a process or an automations change
// does to the anchor, or null. A literal openclaw agent or message send is
// judged without its free text, so a message that mentions config or
// plugins is not a change. An exec whose workdir lies inside the anchor is
// a change unless it only reads.
const commandAnchorOf = (command, { rootDir, dirs, literalOptions, env, workdir }) => {
  const customEnv = env && typeof env === "object" ? Object.keys(env) : [];
  const envName = customEnv.find((key) => kAnchorEnvNames.test(key));
  if (envName) return "set " + envName + " for a command";
  if (literalOptions && workdirUnderAnchor(workdir, { ...literalOptions, dirs }) && !(customEnv.length === 0 && literalReadOnlyOf(command))) {
    return "run a command inside AlphaClaw's relay or install files";
  }
  const text = messagingCommandOf(command) ?? command;
  const plain = text.replace(/\\\n/g, "").replace(/["'\\]/g, "");
  const openclaw = openclawAnchorOf(text) || mainOpenclawAnchorOf(command);
  if (openclaw) return openclaw;
  const literal = literalOptions && !customEnv.length && literalReadOrNoteOf(command, literalOptions);
  if (literal) return null;
  const named = kAnchorEnvNames.exec(plain);
  if (named) return "change " + named[1];
  if (dirs.some((dir) => plain.includes(dir + "/") || plain.endsWith(dir) || plain.includes(dir + " "))) return "change AlphaClaw's relay or install files";
  const shell = kAnchorShell.exec(plain) || kSqliteRelayDb.exec(plain);
  if (shell) return "change " + safe(shell.slice(1).find(Boolean), 80);
  if (/(?:^|[^\w.-])openclaw\.json(?![\w.-])/i.test(plain)) return "change openclaw.json from a shell command";
  const included = includedFileNamedIn(plain, rootDir, literalOptions?.fsModule || fs);
  if (included) return "change " + safe(path.posix.basename(included), 80) + " (openclaw.json includes it) from a shell command";
  return null;
};

// The plugins tool's changes (OpenClaw 2026.11.2 PluginsToolSchema) that can
// drop or reload the guard: any change naming it, and a disable, uninstall
// or reload that names no plugin.
const kPluginToolChanges = Object.freeze(["install", "enable", "disable", "uninstall", "reload", "reloadandresume"]);
const pluginToolAnchorOf = (input) => {
  const action = String(input.action || "").trim().toLowerCase();
  if (!kPluginToolChanges.includes(action)) return null;
  const named = [input.pluginId, input.packageName, input.query].filter((entry) => typeof entry === "string" && entry.trim());
  if (named.some((entry) => entry.toLowerCase().includes(kGuardPluginId))) return "plugins " + action + " relay-guard";
  if (action !== "install" && action !== "enable" && !named.length) return "plugins " + action + " with no plugin named";
  return null;
};

// The relay's keys and databases (GST-2336): the engine's agent keys
// (secrets.json), the owner-provenance signing key, the loopback route's
// secret, and the relay's SQLite files (every thread's messages, grants and
// bindings). No relay session reads them, whatever its tier: a delegate that
// held a key could act as the box's own relay agent or sign owner
// provenance, a database holds other threads' conversations (a delegate
// reads only its own sessions), and what a relay turn reads ends up in a
// remote thread's transcript. A read tool on one, or a literal read-only
// command naming one (a bare secrets.json counts when the command or its
// workdir is inside the relay's directory), is refused outright with nothing
// asked of the owner: those are the reads the confirmation rules let
// through. Any other command naming one is already held or refused as a
// change.
const kRelayKeyFiles = Object.freeze(["secrets.json", "provenance-key.json", "internal.secret", "bridge.db", "remote.db", "relaycast.db", "archive.db"]);
const kRelayKeyName = /(?:^|[^\w.-])(provenance-key\.json|internal\.secret|(?:bridge|remote|relaycast|archive)\.db)(?:-wal|-shm|-journal)?(?![\w.-])|(?:^|[\/\s])relay\/(secrets\.json)(?![\w.-])/;
const kBareSecretsJson = /(?:^|[^\w.-])(secrets\.json)(?![\w.-])/;
const relayKeyNamedIn = (command, { relayDir, inRelay }) => {
  const plain = command.replace(/\\\n/g, "").replace(/["'\\]/g, "");
  const named = kRelayKeyName.exec(plain);
  if (named) return named[1] || named[2];
  return (inRelay || (relayDir && plain.includes(relayDir))) && kBareSecretsJson.test(plain) ? "secrets.json" : null;
};
const classifyKeyRead = ({ toolName, params = {}, rootDir = "", agentId = "", fsModule = fs } = {}) => {
  const name = String(toolName || "").trim().toLowerCase();
  const input = params && typeof params === "object" ? params : {};
  const relayDir = rootDir ? path.resolve(rootDir, "relay").replace(/\\/g, "/") : "";
  const relayDirs = anchorDirsOf(rootDir, fsModule).filter((dir) => relayDir && (dir === relayDir || path.posix.basename(dir) === "relay"));
  const isKey = (file) => kRelayKeyFiles.includes(path.posix.basename(file).replace(/-(wal|shm|journal)$/, "")) && (path.posix.basename(path.posix.dirname(file)) === "relay" || relayDirs.some((dir) => path.posix.dirname(file) === dir));
  if (name === "read") {
    const bases = writeBasesOf({ rootDir, agentId, fsModule });
    const hit = pathsOf(name, input).flatMap((value) => landingsOf(value, bases, fsModule)).find(isKey);
    return hit ? { action: name + " " + path.posix.basename(hit) } : null;
  }
  if (name !== "exec") return null;
  const command = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : "";
  if (!command || !literalReadOnlyOf(command)) return null;
  const inRelay = Boolean(relayDirs.length) && workdirUnderAnchor(input.workdir, { rootDir, agentId, fsModule, dirs: relayDirs });
  const key = relayKeyNamedIn(command, { relayDir, inRelay });
  return key ? { action: "read the relay's " + key } : null;
};

// An anchor change that classifyRisk rated below high, as the high-risk call
// it is for a delegate the owner confirms (GST-2336): the same action, and a
// target bound to this exact call.
const anchorRisk = ({ anchor, params }) => ({ kind: "high", action: anchor.action, target: safe(anchor.action, 200) + " #" + commandHash(JSON.stringify(params || {})) });

// { action } when the call changes the relay's trust anchor, else null.
const classifyAnchor = ({ toolName, params = {}, rootDir = "", agentId = "", fsModule = fs } = {}) => {
  const name = String(toolName || "").trim().toLowerCase();
  const input = params && typeof params === "object" ? params : {};
  const dirs = anchorDirsOf(rootDir, fsModule);
  if (name === "write" || name === "edit" || name === "apply_patch") {
    const bases = writeBasesOf({ rootDir, agentId, fsModule });
    const values = pathsOf(name, input);
    const landings = [...new Set(values.flatMap((value) => landingsOf(value, bases, fsModule)))];
    const hit = landings.find((file) => underAnchor(file, dirs));
    if (hit) return { action: name + " " + safe(path.posix.basename(hit), 80) };
    if (configChangeTouchesGuard(name, input, landings, rootDir, fsModule)) return { action: name + " openclaw.json or a file it includes (the relay guard's plugin entry)" };
    const text = [input.content, input.input, input.patch, ...editTextsOf(input)].filter((entry) => typeof entry === "string").join("\n");
    const envName = kAnchorEnvNames.exec(text);
    if (envName && !values.every((value) => kNoteText.test(value.trim()))) return { action: name + " " + envName[1] };
    return null;
  }
  if (name === "exec") {
    const command = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : "";
    const action = command ? commandAnchorOf(command, { rootDir, dirs, literalOptions: { rootDir, agentId, fsModule, workdir: input.workdir }, env: input.env, workdir: input.workdir }) : null;
    return action ? { action } : null;
  }
  if (name === "process") {
    const text = [input.data, input.text, input.literal, ...(Array.isArray(input.keys) ? input.keys : [])].filter((entry) => typeof entry === "string").join(" ");
    const action = text ? commandAnchorOf(text, { rootDir, dirs, literalOptions: null }) : null;
    return action ? { action } : null;
  }
  if ((name === "automations" || name === "cron") && kAutomationWriteActions.includes(String(input.action || "").trim().toLowerCase())) {
    const action = commandAnchorOf(JSON.stringify(input), { rootDir, dirs, literalOptions: null });
    return action ? { action: name + " " + String(input.action).toLowerCase() + " that would " + action } : null;
  }
  if (name === "plugins") {
    const action = pluginToolAnchorOf(input);
    return action ? { action } : null;
  }
  return null;
};

// A gateway restart a relay call asks for: "request" when the call is
// exactly one (the gateway tool's restart action, or an exec of nothing but
// alphaclaw admin POST /api/gateway/restart or openclaw gateway restart and
// its options), "embedded" when a command asks for one inside something
// else (a longer command line, a gateway call of a restart method), else
// null. The relay guard runs a "request" from the owner's own thread
// through AlphaClaw's restart ladder (restart.js) and refuses an "embedded"
// one, so no relay turn restarts the gateway around the ladder.
const kAdminRestartPath = /^\/api\/gateway\/restart(?:\?async=1)?$/i;
const isRestartWords = (values) => {
  if (/(^|\/)alphaclaw$/i.test(values[0] || "")) {
    return values[1] === "admin" && (values[2] || "").toUpperCase() === "POST" && kAdminRestartPath.test(values[3] || "") && values.slice(4).every((value) => value.startsWith("-"));
  }
  if (!kOpenclawWord.test(values[0] || "")) return false;
  const at = values.findIndex((value, index) => index > 0 && value.toLowerCase() === "gateway");
  if (at < 0 || (values[at + 1] || "").toLowerCase() !== "restart") return false;
  return values.slice(1, at).every((value, index, before) => value.startsWith("-") || (index > 0 && before[index - 1].startsWith("-") && !before[index - 1].includes("=")));
};
const gatewayRestartOf = ({ toolName, params = {} } = {}) => {
  const name = String(toolName || "").trim().toLowerCase();
  const input = params && typeof params === "object" ? params : {};
  if (name === "gateway") return String(input.action || "").trim().toLowerCase() === "restart" ? "request" : null;
  if (name !== "exec") return null;
  const command = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : "";
  if (!command.trim()) return null;
  const segments = literalSegmentsOf(command.trim());
  if (segments?.length === 1 && segments[0].redirects.every(({ op, target }) => op === ">&" || target === "/dev/null") && isRestartWords(segments[0].words.map((word) => word.value))) {
    return "request";
  }
  const plain = (messagingCommandOf(command) ?? command).replace(/["'\\]/g, "");
  if (/\balphaclaw\s+admin\s+POST\s+\/api\/gateway\/restart(?![\w\/-])/i.test(plain)) return "embedded";
  if (/\bopenclaw\b[^;&|\n]*\bgateway\s+(?:restart\b|call\s+\S*restart)/i.test(plain)) return "embedded";
  return null;
};

const openBridge = ({ rootDir, fsModule = fs }) => {
  const dbPath = path.join(rootDir, "relay", "bridge.db");
  if (!fsModule.existsSync(dbPath)) return null;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 2000;");
  return db;
};

const newRef = () => "rc_" + crypto.randomBytes(8).toString("hex");

// An attested delegate's message (GST-2323), proven from the bridge's row
// and remote.db by trust.js, never from what the caller passes. A check that
// cannot run is not proof, so the call takes the confirmation path.
const attestedDelegate = ({ rootDir, sender, messageId, now, fsModule }) => {
  try {
    return require("./trust").isAttestedDelegateMessage({ rootDir, sender, messageId, now, fsModule });
  } catch {
    return false;
  }
};

// { admitted, state, ref }. state: "admitted" | "attested" (an attested
// delegate's call: no row, nothing sent to the owner) | "requested" |
// "pending" | "denied" | "too_many" (5 already open) | "unavailable". Never
// throws for a refusal; a database error throws and the guard turns it into
// a deny.
const checkConfirmation = ({ rootDir, sender, messageId, lane = null, generation = null, confirmationRef = null, kind, action, target, now = Date.now(), fsModule = fs }) => {
  if (kind !== "high") return { admitted: true, state: "not_needed", ref: null };
  if (!sender || !messageId || !action || !target) return { admitted: false, state: "unavailable", ref: null };
  if (attestedDelegate({ rootDir, sender, messageId, now, fsModule })) return { admitted: true, state: "attested", ref: null };
  const db = openBridge({ rootDir, fsModule });
  if (!db) return { admitted: false, state: "unavailable", ref: null };
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'relay_confirmations'").get();
    if (!hasTable) return { admitted: false, state: "unavailable", ref: null };
    const generationValue = Number.isInteger(generation) ? generation : null;
    const ref = typeof confirmationRef === "string" && kConfirmationRefPattern.test(confirmationRef) ? confirmationRef : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const same = "sender = ? AND action = ? AND target = ? AND generation IS ?";
      const confirmed = db
        .prepare("SELECT id FROM relay_confirmations WHERE " + same + " AND state = 'confirmed' AND expires_at > ? AND (message_id = ? OR id = ?) ORDER BY created_at LIMIT 1")
        .get(String(sender), action, target, generationValue, now, String(messageId), ref);
      if (confirmed) {
        db.prepare("UPDATE relay_confirmations SET state = 'spent', spent_at = ?, spent_message_id = ? WHERE id = ? AND state = 'confirmed'").run(now, String(messageId), confirmed.id);
        db.exec("COMMIT");
        return { admitted: true, state: "admitted", ref: confirmed.id };
      }
      const open = db
        .prepare("SELECT id, state FROM relay_confirmations WHERE " + same + " AND state IN ('requested', 'pending') AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
        .get(String(sender), action, target, generationValue, now);
      if (open) {
        db.exec("COMMIT");
        return { admitted: false, state: "pending", ref: open.id };
      }
      const denied = db
        .prepare("SELECT id FROM relay_confirmations WHERE " + same + " AND state = 'denied' AND (message_id = ? OR id = ?) LIMIT 1")
        .get(String(sender), action, target, generationValue, String(messageId), ref);
      if (denied) {
        db.exec("COMMIT");
        return { admitted: false, state: "denied", ref: denied.id };
      }
      const opened = db.prepare("SELECT COUNT(*) AS n FROM relay_confirmations WHERE sender = ? AND state IN ('requested', 'pending') AND expires_at > ?").get(String(sender), now).n;
      if (opened >= kMaxOpenPerSender) {
        db.exec("COMMIT");
        return { admitted: false, state: "too_many", ref: null };
      }
      const id = newRef();
      db.prepare(
        "INSERT INTO relay_confirmations (id, message_id, sender, lane, generation, kind, action, target, state, created_at, expires_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)",
      ).run(id, String(messageId), String(sender), lane || null, generationValue, kind, action, target, now, now + kConfirmTtlMs);
      db.exec("COMMIT");
      return { admitted: false, state: "requested", ref: id };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } finally {
    db.close();
  }
};

module.exports = { mainOpenclawAnchorOf, classifyRisk, classifyAnchor, classifyKeyRead, anchorRisk, gatewayRestartOf, checkConfirmation, isProtectedPath, protectedTargetsOf, kConfirmTtlMs, kConfirmationRefPattern, kOpenStates, kMaxOpenPerSender, kAutomationReadActions, kAutomationWriteActions };
