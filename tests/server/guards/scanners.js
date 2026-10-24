// The structural guard scanners, kept importable (no vitest globals) so the
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


// clawCmd/clawCmdWithRetry/gogCmd hand their string to /bin/sh, and
// execSyncImpl/execImpl are injected execSync/exec: the same defect class.
const kShellCallRe =
  /(^|[^.\w$])(exec|execSync|execAsync|shellCmd|runShell|clawCmd|clawCmdWithRetry|gogCmd|execSyncImpl|execImpl)\(\s*(`|[^,)`]*\+)/g;
// An interpolation is safe when it is a numeric literal or exactly one call to
// a quoting helper (the whole expression, so `${quoteShellArg(a) + b}` still
// counts as data). Anything else is flagged, or allowlisted with a why-comment.
const kQuoteHelpers = ["quoteShellArg", "quoteCliArg", "shellEscapeArg"];
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

// The `${…}` expressions of the template opening at backtickIndex. Brace
// depth is tracked outside nested template literals only (good enough for
// the call sites this guard sees).
const templateInterpolations = (text, backtickIndex) => {
  const out = [];
  let i = backtickIndex + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return out;
    if (ch === "$" && text[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      let inTemplate = false;
      while (j < text.length && depth) {
        const c = text[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "`") inTemplate = !inTemplate;
        else if (!inTemplate && c === "{") depth += 1;
        else if (!inTemplate && c === "}") depth -= 1;
        j += 1;
      }
      out.push(text.slice(i + 2, j - 1).trim());
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
};

const isSingleCall = (expr, name) => {
  if (!expr.startsWith(`${name}(`) || !expr.endsWith(")")) return false;
  let depth = 0;
  for (let k = name.length; k < expr.length; k += 1) {
    if (expr[k] === "(") depth += 1;
    else if (expr[k] === ")") {
      depth -= 1;
      if (depth === 0) return k === expr.length - 1;
    }
  }
  return false;
};

const isSafeInterpolation = (expr) =>
  /^\d+(?:\.\d+)?$/.test(expr) ||
  kQuoteHelpers.some((name) => isSingleCall(expr, name));

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
      if (templateInterpolations(text, openIndex).some((expr) => !isSafeInterpolation(expr))) {
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

// Secret comparisons (secret-compare guard). A raw ===/!==/==/!= with a
// secret-named operand compares in time proportional to the matching prefix
// and ends early on a length mismatch; every such check goes through
// lib/server/utils/timing-safe.js instead, and so does every direct
// crypto.timingSafeEqual call (the helper is the one place that hashes both
// sides first). An operand is secret-named when the last word of its final
// identifier (camelCase or SNAKE_CASE) is a secret word, or a hash/digest
// word qualified by one ("sessionTokenHash"). A literal on either side
// (`token === ""`, `typeof x === "string"`) is a shape check, not a match.
const kSecretWords = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "signature",
  "hmac",
  "bearer",
  "credential",
  "cookie",
  "apikey",
]);
const kDigestWords = new Set(["hash", "digest"]);
const kTimingSafeHelperFile = "lib/server/utils/timing-safe.js";
const kCompareOperatorRe = /(!==|===|!=|==)/g;
const kLeftOperandRe = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\(\s*\))*)\s*$/;
const kRightOperandRe = /^\s*(["'`]|-?\d|[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\(\s*\))*)/;
const kLiteralWords = new Set(["null", "undefined", "true", "false", "NaN"]);
const kDirectTimingSafeEqualRe = /\btimingSafeEqual\s*\(/g;

const identifierWords = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

const isSecretName = (operand) => {
  const name = operand.replace(/\(\s*\)$/, "").match(/[\w$]+$/)?.[0] || "";
  const words = identifierWords(name);
  const last = words.at(-1);
  if (!last) return false;
  if (kSecretWords.has(last)) return true;
  if (last === "key" && words.at(-2) === "api") return true;
  return (
    kDigestWords.has(last) &&
    words.slice(0, -1).some((word) => kSecretWords.has(word) || word === "session")
  );
};

const isLiteralOperand = (operand) =>
  /^["'`]|^-?\d/.test(operand) || kLiteralWords.has(operand);

const scanSecretCompares = (rawText, relPath) => {
  if (relPath === kTimingSafeHelperFile) return [];
  const text = stripComments(rawText);
  const hits = [];
  const ordinals = new Map();
  const push = (index, label) => {
    const n = (ordinals.get(label) || 0) + 1;
    ordinals.set(label, n);
    hits.push({
      key: `${relPath}::${label}${n > 1 ? `#${n}` : ""}`,
      file: relPath,
      line: lineOf(text, index),
    });
  };
  for (const m of text.matchAll(kCompareOperatorRe)) {
    const left = text.slice(Math.max(0, m.index - 200), m.index).match(kLeftOperandRe)?.[1];
    const right = text.slice(m.index + m[0].length, m.index + m[0].length + 200).match(kRightOperandRe)?.[1];
    if (!left || !right) continue;
    if (isLiteralOperand(left) || isLiteralOperand(right)) continue;
    if (!isSecretName(left) && !isSecretName(right)) continue;
    push(m.index, `${left.replace(/\s+/g, "")} ${m[0]} ${right.replace(/\s+/g, "")}`);
  }
  for (const m of text.matchAll(kDirectTimingSafeEqualRe)) {
    push(m.index, "crypto.timingSafeEqual");
  }
  return hits;
};

// Guard (f): every gateway restart names who asked for it (ALPH-17). A call to
// a restart primitive, or to a wrapper that forwards to one, must pass a
// `source` in its arguments or forward its own caller's options/attribution
// object unchanged. Without it the ladder logs `source=unattributed` and
// nobody can tell which caller restarted the gateway (the Oct 22 `op=-`).
const kRestartCallRe = /(^|[^\w.$])(restartGateway|coldRestartGateway|scopedRestart|restartSavedChannel|runGatewayColdStart|restartGatewayWithReload|restartGatewayColdStart|restartGatewayForMitigation)\s*\(/g;
const kForwardedArgRe = /^(?:\w+\s*,\s*)?(?:\.\.\.)?(?:options|attribution)$/;
const scanUnattributedRestarts = (rawText, relPath) => {
  const text = stripComments(rawText);
  const hits = [];
  for (const m of text.matchAll(kRestartCallRe)) {
    const nameStart = m.index + m[1].length;
    if (/\bfunction\s*$/.test(text.slice(Math.max(0, nameStart - 20), nameStart))) continue;
    let depth = 0;
    let end = nameStart + m[0].length - m[1].length - 1;
    const open = end;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")" && --depth === 0) break;
    }
    const args = text.slice(open + 1, end).replace(/\s+/g, " ").trim();
    if (/\bsource\b/.test(args) || kForwardedArgRe.test(args) || /\.\.\.(?:options|attribution)\b/.test(args)) continue;
    hits.push({ key: `${relPath}::${m[2]}(${args.slice(0, 60)})`, file: relPath, line: lineOf(text, nameStart) });
  }
  return hits;
};

// Guard (g): no log line carries an env value. The env-change line printed
// KEY=value for every key not named like a token, so database URLs with
// embedded passwords went to the log in the clear. A console/logger call
// whose evaluated arguments read an env value (process.env.X, env[...],
// envMap.get(...), a KEY=${value} pair, a whole-env dump) is flagged unless
// the value goes through a redactor first.
const kLogCallRe = /\b(console\.(?:log|warn|error|info|debug)|logger\.(?:log|warn|error|info|debug))\s*(?:\?\.\s*)?\(/g;
const kRedactorCallRe = /\b(?:redactEnvValue|redactSecretText|redactSecretShapes|redactCommandLine|redactLine|redactSecrets|scrubTokenParams)\s*\(/g;
const kEnvValueSources = [
  /process\.env\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])/,
  /\b(?:env|childEnv|spawnEnv|gatewayEnv\(\))\s*(?:\.\s*[A-Z_][A-Z0-9_]*\b|\[[^\]]*\])/,
  /\benvMap\.get\([^)]*\)/,
  /\b(?:envVars|envFileVars|fileVars)\b(?!\.length)/,
  /\breadEnvFile(?:Strict)?\(\)/,
  /\b(?:Object\.(?:entries|values)|JSON\.stringify)\(\s*(?:process\.)?env\b/,
];

// The code a call evaluates, from just after its "(" to the matching ")":
// string literal contents dropped, template ${...} interpolations kept.
const readCode = (text, start, closer) => {
  let code = "";
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
      code += '""';
      i += 1;
      continue;
    }
    if (ch === "\x60") {
      i += 1;
      while (i < text.length && text[i] !== "\x60") {
        if (text[i] === "\\") {
          i += 2;
        } else if (text[i] === "$" && text[i + 1] === "{") {
          const inner = readCode(text, i + 2, "}");
          code += ` (${inner.code}) `;
          i = inner.end + 1;
        } else {
          i += 1;
        }
      }
      code += "\x60\x60";
      i += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0 && ch === closer) return { code, end: i };
      depth -= 1;
    }
    code += ch;
    i += 1;
  }
  return { code, end: i };
};

const stripRedactorCalls = (code) => {
  let out = code;
  for (let guard = 0; guard < 50; guard += 1) {
    kRedactorCallRe.lastIndex = 0;
    const m = kRedactorCallRe.exec(out);
    if (!m) break;
    const inner = readCode(out, m.index + m[0].length, ")");
    out = `${out.slice(0, m.index)}REDACTED${out.slice(inner.end + 1)}`;
  }
  return out;
};

const scanEnvValueLogs = (rawText, relPath) => {
  const text = stripComments(rawText);
  const hits = [];
  const ordinals = new Map();
  for (const m of text.matchAll(kLogCallRe)) {
    const argsStart = m.index + m[0].length;
    const { code, end } = readCode(text, argsStart, ")");
    const rawArgs = text.slice(argsStart, end);
    const evaluated = stripRedactorCalls(code);
    let source = kEnvValueSources.map((re) => evaluated.match(re)?.[0]).find(Boolean);
    if (!source && /\$\{\s*\w*(?:key|name)\s*\}=\$\{(?!\s*(?:redact|kMask))/i.test(rawArgs)) source = "${key}=${value}";
    if (!source) continue;
    const label = `${m[1]}(${source.replace(/\s+/g, "")})`;
    const n = (ordinals.get(label) || 0) + 1;
    ordinals.set(label, n);
    hits.push({
      key: `${relPath}::${label}${n > 1 ? `#${n}` : ""}`,
      file: relPath,
      line: lineOf(text, m.index),
    });
  }
  return hits;
};

module.exports = {
  scanEnvValueLogs,
  scanUnattributedRestarts,
  scanConfigWriters,
  scanShellStrings,
  scanUnwrappedAsyncRoutes,
  scanUiIntervals,
  scanSecretCompares,
};
