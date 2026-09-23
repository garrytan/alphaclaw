const path = require("path");
const kSqliteDbPattern = /\.sqlite$/i;
const kResolvedPolicy = Symbol("resolved backup policy");
const kOfflineCopyPolicyExcludes = Object.freeze([
  "node_modules",
  "*.heapsnapshot",
  "*.tmp",
  "logs/**/*.gz",
]);
const kOfflineCopyRootExcludes = Object.freeze([
  "worktrees/**",
  "workspace/.openclaw/**",
  "wiki/**",
  "logs/**",
  "**/*.sqlite.corrupt-*",
  "**/*.sqlite.migrated*",
]);
const kOfflineCopyExcludeMaxPatterns = 64;
const kOfflineCopyExcludeMaxLength = 256;
const kRefusalMaxDetails = 64;
const kRefusalMaxReasonLength = 512;
const kRefusalOverflowPattern = "[additional exclusions]";

// Invalid configuration may contain enormous arrays, strings, or objects.
// Never stringify an object/array to describe it or retain unbounded text.
const refusalText = (value, maxLength) => typeof value === "string"
  ? value.slice(0, maxLength).replace(/[\x00-\x1f\x7f]/g, "?")
  : value === null ? "null" : `[${Array.isArray(value) ? "array" : typeof value}]`;
const createRefusalCollector = () => {
  const details = [];
  const seen = new Set();
  let omittedCount = 0;
  let omittedScope = "workspace";
  const omit = (count, scope = "workspace") => {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    if (omittedCount === 0) omittedScope = scope === "root" ? "root" : "workspace";
    omittedCount = Math.min(Number.MAX_SAFE_INTEGER, omittedCount + count);
  };
  const add = (entry) => {
    const scope = entry?.scope === "root" ? "root" : "workspace";
    if (entry?.pattern === kRefusalOverflowPattern && Number.isSafeInteger(entry.omittedCount) && entry.omittedCount > 0) {
      omit(entry.omittedCount, scope);
      return;
    }
    const detail = { scope, pattern: refusalText(entry?.pattern, kOfflineCopyExcludeMaxLength), reason: refusalText(entry?.reason, kRefusalMaxReasonLength) };
    const key = JSON.stringify(detail);
    if (seen.has(key)) return;
    if (details.length >= kRefusalMaxDetails) { omit(1, scope); return; }
    seen.add(key);
    details.push(Object.freeze(detail));
  };
  const addAll = (entries) => {
    if (!Array.isArray(entries)) return;
    // Our own groups contain at most 64 details and one overflow row. Keep
    // this boundary bounded even if a future caller supplies a larger list.
    const limit = Math.min(entries.length, kRefusalMaxDetails + 1);
    for (let index = 0; index < limit; index++) add(entries[index]);
    omit(entries.length - limit);
  };
  const finish = () => Object.freeze([
    ...details,
    ...(omittedCount ? [Object.freeze({ scope: omittedScope, pattern: kRefusalOverflowPattern, omittedCount,
      reason: `${omittedCount} additional exclusions omitted from this report; at most 64 patterns are evaluated per scope and 64 refusal details are shown.` })] : []),
  ]);
  return { add, addAll, omit, finish };
};
const boundBackupRefusals = (...groups) => {
  const collector = createRefusalCollector();
  for (const group of groups) collector.addAll(group);
  return collector.finish();
};
// Core assets are the data a migration could lose or a restore cannot do
// without: the config file, the credential/identity stores, the state dir,
// every state database and each agent's data-plane dir. A symlink at one of
// these places would leave the archive silently lacking it, so the copy is
// recorded partial with the reason — except the config FILE itself, which
// is followed when it resolves to a regular file: a config-map-mounted or
// operator-symlinked openclaw.json is exactly the config the gateway reads
// and a small JSON document, so copying the target is safe and is what a
// restore needs. Directory symlinks are never followed (a credentials dir
// pointing elsewhere could be huge or cyclic) — the honest answer there is
// partial:true.
const kCoreAssetPathPattern =
  /^(openclaw\.json|credentials(\/.*)?|identity(\/.*)?|state(\/.*)?|agents\/[^/]+\/agent(\/.*)?)$/;
const kConfigFileName = "openclaw.json";
const isCoreAssetPath = (relPath) =>
  kCoreAssetPathPattern.test(relPath) || kSqliteDbPattern.test(relPath);

// ── Policy excludes ───────────────────────────────────────────────────────
// Excludes apply only inside workspaces, so a core asset (config, credential
// and identity stores, state/, agents/*/agent/, any *.sqlite) is structurally
// out of their reach. The refusal below is defence in depth for the operator
// list: a pattern that WOULD match one of these probe paths if it were ever
// applied at the state-dir root (`*`, `**`, `*.sqlite`, `*.json`,
// `credentials`, `state/`, …) is refused, reported and never applied — no
// config can widen the excludes onto the data a restore cannot do without.
// Every probe satisfies isCoreAssetPath or is an ancestor directory of one
// that does (`agents`, `agents/<id>` — excluding either drops the agent's
// data plane); pinned by the unit test.
const kCoreAssetProbePaths = Object.freeze([
  "openclaw.json",
  "credentials",
  "credentials/telegram.json",
  "identity",
  "identity/device.json",
  "state",
  "state/openclaw.sqlite",
  "agents",
  "agents/main",
  "agents/main/agent",
  "agents/main/agent/openclaw-agent.sqlite",
  "agents/main/agent/auth-profiles.json",
  "openclaw.sqlite",
]);
// Basename patterns never see a path, so they are probed against the core
// NAMES (the agent-id segment is a wildcard in kCoreAssetPathPattern and is
// deliberately not a probe: `main` is an id, not a core name).
const kCoreAssetProbeNames = Object.freeze([
  "openclaw.json",
  "credentials",
  "identity",
  "state",
  "agents",
  "agent",
  "openclaw.sqlite",
  "openclaw-agent.sqlite",
  "auth-profiles.json",
  "telegram.json",
  "device.json",
]);

// Preserve RegExp's case-insensitive, non-Unicode code-unit comparison,
// including characters whose uppercase spelling expands or becomes ASCII.
const foldCase = (ch) => {
  const upper = ch.toUpperCase();
  return upper.length !== 1 || (ch.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? ch : upper;
};
const isLineTerminator = (ch) => ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";

// `**/` consumes zero or more complete, nonempty segments; a final `**`
// consumes the remainder. Other stars and question marks never cross `/`.
// Keep all reachable states instead of regex backtracking: matching takes
// O(pattern length * path length) time and O(pattern length) memory, even
// for an operator rule such as `a*a*a*a*a*a*a*a*a*a*a*a*a*a*b`.
const compileGlob = (body) => {
  const tokens = [];
  const segments = body.split("/");
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      tokens.push(...(last ? [{ kind: "remainder" }] : [{ kind: "segmentStart" }, { kind: "segmentBody" }]));
      return;
    }
    for (let offset = 0; offset < segment.length; offset++) {
      const ch = segment[offset];
      tokens.push(ch === "*" ? { kind: "star" } : ch === "?" ? { kind: "one" } : { kind: "literal", value: foldCase(ch) });
    }
    if (!last) tokens.push({ kind: "literal", value: "/" });
  });
  const addState = (states, seen, index) => {
    while (!seen[index]) {
      seen[index] = 1;
      states.push(index);
      const kind = tokens[index]?.kind;
      if (kind === "star" || kind === "remainder") index++;
      else if (kind === "segmentStart") index += 2;
      else break;
    }
  };
  return (subject) => {
    let current = [], next = [];
    let currentSeen = new Uint8Array(tokens.length + 1), nextSeen = new Uint8Array(tokens.length + 1);
    addState(current, currentSeen, 0);
    for (let offset = 0; offset < subject.length; offset++) {
      const ch = subject[offset];
      const folded = foldCase(ch);
      next.length = 0;
      nextSeen.fill(0);
      for (const index of current) {
        const token = tokens[index];
        if (!token) continue;
        if (token.kind === "literal") {
          if (token.value === folded) addState(next, nextSeen, index + 1);
        } else if (token.kind === "remainder") {
          if (!isLineTerminator(ch)) addState(next, nextSeen, index);
        } else if (ch !== "/") {
          addState(next, nextSeen, token.kind === "star" || token.kind === "segmentBody" ? index : index + 1);
        } else if (token.kind === "segmentBody") {
          addState(next, nextSeen, index - 1);
        }
      }
      if (next.length === 0) return false;
      [current, next] = [next, current];
      [currentSeen, nextSeen] = [nextSeen, currentSeen];
    }
    return Boolean(currentSeen[tokens.length]);
  };
};

// One pattern → { pattern, test(relPath, { isDirectory }) } or a refusal
// { pattern, reason }. `pattern` is the operator's spelling (trimmed) so the
// manifest and the refusal report name what was configured.
const compileExcludePattern = (raw, { scope = "workspace", inventory = null } = {}) => {
  if (typeof raw !== "string") {
    return { refused: { pattern: refusalText(raw, kOfflineCopyExcludeMaxLength), reason: "not a string" } };
  }
  const pattern = raw.trim();
  const refuse = (reason) => ({ refused: { pattern: refusalText(pattern, kOfflineCopyExcludeMaxLength), reason: refusalText(reason, kRefusalMaxReasonLength) } });
  if (!pattern) return refuse("empty pattern");
  if (pattern.length > kOfflineCopyExcludeMaxLength) {
    return refuse(`longer than ${kOfflineCopyExcludeMaxLength} characters`);
  }
  if (pattern.includes("\0")) return refuse("contains a NUL byte");
  if (pattern.includes("\\")) return refuse("backslashes are not supported — use / as the separator");
  if (pattern.startsWith("/")) {
    return refuse("absolute paths are not allowed — patterns are relative to the workspace root");
  }
  let body = pattern;
  let dirOnly = false;
  if (body.endsWith("/")) {
    dirOnly = true;
    body = body.replace(/\/+$/, "");
    if (!body) return refuse("empty pattern");
  }
  const segments = body.split("/");
  if (segments.some((segment) => segment === "")) return refuse("empty path segment (//)");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return refuse("'.' and '..' segments are not allowed");
  }
  const byBasename = scope === "workspace" && segments.length === 1;
  const match = compileGlob(body);
  const test = (relPath, { isDirectory = false } = {}) => {
    if (dirOnly && !isDirectory) return false;
    const subject = byBasename ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath;
    return match(subject) || (scope === "root" && isDirectory && body.endsWith("/**") && match(`${subject}/`));
  };
  const probes = byBasename ? kCoreAssetProbeNames : kCoreAssetProbePaths;
  const hit = probes.find((probe) => test(probe, { isDirectory: true }));
  if (hit !== undefined) {
    return refuse(`could match the core asset "${hit}" — core assets are never excludable`);
  }
  if (scope === "root") {
    // State-root exclusions must identify a subtree rather than an arbitrary
    // top-level glob. Exact workspace roots are also safe operator choices.
    const knownScratch = ["worktrees", "wiki", "logs"].includes(segments[0]);
    const staleDatabase = ["**/*.sqlite.corrupt-*", "**/*.sqlite.migrated*"].includes(body);
    if (!knownScratch && !staleDatabase && (/[?*]/.test(segments[0]) ||
      (segments[0] === "state" ? segments.length < 2 || /[?*]/.test(segments[1]) : !/^workspace(-[^/?*]+)?$/.test(segments[0])))) {
      return refuse("root exclusions must name a state subdirectory or workspace root");
    }
    for (const protectedPath of inventory?.protectedPaths || []) {
      const relative = path.relative(inventory.stateDir, protectedPath).split(path.sep).join("/");
      if (relative && test(relative, { isDirectory: true })) {
        return refuse(`covers the protected asset or ancestor "${relative}"`);
      }
    }
  }
  if (scope === "workspace" && inventory) {
    for (const protectedPath of inventory.protectedPaths || []) {
      const segments = path.relative(inventory.stateDir, protectedPath).split(path.sep);
      const workspace = segments.findIndex((segment) => /^workspace(-.*)?$/.test(segment));
      const relative = workspace >= 0 ? segments.slice(workspace + 1).join("/") : "";
      if (relative && test(relative, { isDirectory: true })) {
        return refuse(`covers the protected asset or ancestor "${relative}"`);
      }
    }
  }
  return { compiled: { pattern, byBasename, dirOnly, test } };
};

// The effective exclude set for one walk: `undefined` → the defaults; an
// array → the operator's list, which REPLACES the defaults (so `[]` turns
// the policy off). Anything else is refused whole. Refusals are reported,
// never applied — and never fatal: the copy still runs with what is valid.
const resolveExcludes = (excludes, options = {}) => {
  if (excludes === undefined || excludes === null) {
    return resolveExcludes([...kOfflineCopyPolicyExcludes], options);
  }
  if (!Array.isArray(excludes)) {
    return {
      applied: [],
      refused: [{ pattern: refusalText(excludes, kOfflineCopyExcludeMaxLength), reason: "excludes must be an array of patterns" }],
    };
  }
  const applied = [];
  const refused = createRefusalCollector();
  const seen = new Set();
  const limit = Math.min(excludes.length, kOfflineCopyExcludeMaxPatterns);
  for (let index = 0; index < limit; index++) {
    const outcome = compileExcludePattern(excludes[index], options);
    if (outcome.refused) {
      refused.add(outcome.refused);
      continue;
    }
    if (seen.has(outcome.compiled.pattern)) continue;
    seen.add(outcome.compiled.pattern);
    applied.push(outcome.compiled);
  }
  refused.omit(excludes.length - limit);
  return { applied, refused: refused.finish().map(({ scope, ...entry }) => entry) };
};

const resolveBackupPolicy = (value = {}, { inventory = null } = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const defaults = resolveBackupPolicy({}, { inventory });
    return Object.freeze({ ...defaults, refused: boundBackupRefusals(defaults.refused, [{ scope: "workspace", pattern: value, reason: "backup policy must be an object" }]) });
  }
  const { excludes, rootExcludes } = value;
  const workspace = resolveExcludes(excludes, { inventory });
  const roots = rootExcludes === undefined ? kOfflineCopyRootExcludes : rootExcludes;
  const rootApplied = [];
  const refused = createRefusalCollector();
  if (value[kResolvedPolicy]) refused.addAll(value.refused);
  refused.addAll(workspace.refused);
  if (!Array.isArray(roots)) {
    refused.add({ scope: "root", pattern: roots, reason: "rootExcludes must be an array of patterns" });
  } else {
    const seen = new Set();
    const limit = Math.min(roots.length, kOfflineCopyExcludeMaxPatterns);
    for (let index = 0; index < limit; index++) {
      const result = compileExcludePattern(roots[index], { scope: "root", inventory });
      if (result.refused) refused.add({ scope: "root", ...result.refused });
      else if (!seen.has(result.compiled.pattern)) {
        seen.add(result.compiled.pattern);
        rootApplied.push(Object.freeze(result.compiled));
      }
    }
    refused.omit(roots.length - limit, "root");
  }
  return Object.freeze({
    [kResolvedPolicy]: true,
    excludes: Object.freeze(workspace.applied.map((rule) => rule.pattern)),
    rootExcludes: Object.freeze(rootApplied.map((rule) => rule.pattern)),
    applied: Object.freeze(workspace.applied.map(Object.freeze)),
    rootApplied: Object.freeze(rootApplied),
    refused: refused.finish(),
  });
};

module.exports = {
  kOfflineCopyPolicyExcludes,
  kOfflineCopyRootExcludes,
  kOfflineCopyExcludeMaxPatterns,
  kCoreAssetProbePaths,
  isCoreAssetPath,
  compileExcludePattern,
  resolveExcludes,
  resolveBackupPolicy,
  boundBackupRefusals,
  validateBackupPolicy: resolveBackupPolicy,
};
