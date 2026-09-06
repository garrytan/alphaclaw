// The four fix-wave guard scanners, kept importable (no vitest globals) so the
// self-tests and ad-hoc `node -e` audits can call them directly.
const { lineOf, stripComments } = require("./guard-utils");

// First argument of a call starting right after its "(": balanced over
// (), [], {} and string literals, ending at the top-level comma or ")".
const firstArgumentAt = (text, from) => {
  let depth = 0;
  let quote = null;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return text.slice(from, i);
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return text.slice(from, i);
    }
  }
  return text.slice(from);
};

const kManagedBasenames = /(openclaw|alphaclaw|exec-approvals)\.json/;
const kManagedResolvers =
  /resolve(Openclaw|Alphaclaw|ExecApprovals)ConfigPath|k(Openclaw|Alphaclaw)ConfigPath|OPENCLAW_CONFIG_PATH/;
const kExemptFiles = new Set([
  "lib/server/openclaw-config.js",
  "lib/server/alphaclaw-config.js",
  "lib/server/utils/safe-file.js",
]);

// Identifiers bound (anywhere in the file) to an expression that names a
// managed config path, plus the conventional `configPath` parameter name in
// files that mention openclaw.json at all.
const managedIdentifiers = (text) => {
  const ids = new Set();
  const bindingRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
  for (const m of text.matchAll(bindingRe)) {
    if (kManagedBasenames.test(m[2]) || kManagedResolvers.test(m[2])) ids.add(m[1]);
  }
  if (kManagedBasenames.test(text)) ids.add("configPath");
  return ids;
};

const scanConfigWriters = (rawText, relPath) => {
  if (kExemptFiles.has(relPath)) return [];
  const text = stripComments(rawText);
  const ids = managedIdentifiers(text);
  const hits = [];
  const callRe = /\b(writeFileSync|writeFile|createWriteStream)\(/g;
  for (const m of text.matchAll(callRe)) {
    const firstArg = firstArgumentAt(text, m.index + m[0].length).trim();
    const ident = firstArg.match(/^([A-Za-z_$][\w$]*)/)?.[1];
    const managed =
      kManagedBasenames.test(firstArg) ||
      kManagedResolvers.test(firstArg) ||
      (ident && ids.has(ident) && !/^(tmp|temp)/i.test(ident));
    if (!managed) continue;
    hits.push({
      key: `${relPath}::${firstArg.replace(/\s+/g, " ").slice(0, 60)}`,
      file: relPath,
      line: lineOf(text, m.index),
    });
  }
  return hits;
};


const kShellCallRe =
  /(^|[^.\w$])(exec|execSync|execAsync|shellCmd|runShell)\(\s*(`|[^,)`]*\+)/g;
const kChildProcessMethodRe = /\b(childProcess|child_process|cp)\.(exec|execSync)\(\s*`/g;
const kShellTrueRe = /\bshell\s*:\s*true\b/g;
// `sh -c <x>` where x is not a string literal: the char after the comma (and
// spaces) must be a non-quote token start — a greedy \s* with a negative
// lookahead backtracks onto the space and matches literals too.
const kShDashCRe = /\[\s*(["'])-l?c\1\s*,\s*(?=[^\s"'`)])/g;

const templateHasInterpolation = (text, backtickIndex) => {
  let i = backtickIndex + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return false;
    if (ch === "$" && text[i + 1] === "{") return true;
    i += 1;
  }
  return false;
};

const templatePrefix = (text, backtickIndex) => {
  const end = text.indexOf("${", backtickIndex);
  const stop = end === -1 ? backtickIndex + 41 : Math.min(end, backtickIndex + 41);
  return text.slice(backtickIndex + 1, stop).replace(/\s+/g, " ").trim();
};

const scanShellStrings = (rawText, relPath) => {
  const text = stripComments(rawText);
  const hits = [];
  const ordinals = new Map();
  const push = (index, label) => {
    // Keys are content-based (callee + command prefix) so a site that merely
    // moves lines does not churn the allowlist; a NEW site has a new prefix.
    const n = (ordinals.get(label) || 0) + 1;
    ordinals.set(label, n);
    hits.push({
      key: `${relPath}::${label}${n > 1 ? `#${n}` : ""}`,
      file: relPath,
      line: lineOf(text, index),
    });
  };
  for (const m of text.matchAll(kShellCallRe)) {
    const openIndex = m.index + m[0].length - 1;
    if (m[3] === "`") {
      if (templateHasInterpolation(text, openIndex)) {
        push(m.index, `${m[2]}(\`${templatePrefix(text, openIndex)}…\`)`);
      }
    } else {
      push(m.index, `${m[2]}(…+…)`);
    }
  }
  for (const m of text.matchAll(kChildProcessMethodRe)) {
    const openIndex = m.index + m[0].length - 1;
    if (templateHasInterpolation(text, openIndex)) {
      push(m.index, `${m[1]}.${m[2]}(\`${templatePrefix(text, openIndex)}…\`)`);
    }
  }
  for (const m of text.matchAll(kShellTrueRe)) push(m.index, "shell:true");
  for (const m of text.matchAll(kShDashCRe)) push(m.index, "sh -c <non-literal>");
  return hits;
};

const kRouteCallRe = /\b(app|router)\.(get|post|put|delete|patch|all)\(\s*(["'`])([^"'`]+)\3/g;

// The handler is the last argument. Look at the argument prefix — from the
// call up to the first `{` (a handler body or a destructured param) — and
// flag an `async` there that is not preceded by `wrapAsync(`.
const scanUnwrappedAsyncRoutes = (rawText, relPath) => {
  const text = stripComments(rawText);
  const hits = [];
  for (const m of text.matchAll(kRouteCallRe)) {
    const start = m.index;
    const braceIndex = text.indexOf("{", start);
    const prefix = text.slice(start, braceIndex === -1 ? start + 400 : braceIndex);
    const asyncIndex = prefix.search(/\basync\b/);
    if (asyncIndex === -1) continue;
    if (prefix.slice(0, asyncIndex).includes("wrapAsync(")) continue;
    hits.push({
      key: `${relPath}::${m[2].toUpperCase()} ${m[4]}`,
      file: relPath,
      line: lineOf(text, start),
    });
  }
  return hits;
};


const kIntervalRe = /\b(?:window\.|globalThis\.|self\.)?setInterval\(/g;
const kPrimitiveFiles = new Set([
  "lib/public/js/hooks/usePolling.js",
  "lib/public/js/hooks/use-now-ms.js",
  "lib/public/js/hooks/use-visible-interval.js",
  // Imperative popup-closed watcher: click-lifecycle interval, no network,
  // must run while hidden (the user is in the popup). See its header comment.
  "lib/public/js/lib/popup-watch.js",
]);

// One hit per file, keyed with the count, so the allowlist reads
// "file → N allowed intervals" and any ADDED interval changes the key.
const scanUiIntervals = (rawText, relPath) => {
  if (kPrimitiveFiles.has(relPath)) return [];
  const text = stripComments(rawText);
  const matches = [...text.matchAll(kIntervalRe)];
  if (matches.length === 0) return [];
  return [
    {
      key: `${relPath}::${matches.length}`,
      file: relPath,
      line: lineOf(text, matches[0].index),
    },
  ];
};

module.exports = {
  scanConfigWriters,
  scanShellStrings,
  scanUnwrappedAsyncRoutes,
  scanUiIntervals,
};
