// The .env line format every AlphaClaw reader and writer shares.
//
// Write: a value made only of kPlainEnvValuePattern characters stays bare, so
// most lines read the same in every AlphaClaw version (a rollback keeps them),
// diffs stay small, and scripts that read the file raw (`IFS='=' read`, then
// export) get the value without quotes. Those characters are the ones a bash
// assignment takes literally (an assignment is never globbed, brace-expanded
// or word-split) and dotenv reads as is: ASCII letters and digits,
// _ . / : @ % + = , - ? * ! [ ] ^ { } and printable non-ASCII. Whitespace,
// control and format characters, ~ # ; & | < > ( ) $ ` \ " and ' are never
// bare, and neither is a leading =. Anything else is quoted so that
// `set -a; . .env`, OpenClaw's dotenv, the two shell shims and AlphaClaw's own parsers all read
// the same bytes: single quotes, or double quotes for a value holding a single
// quote and no double quote, dollar, backtick or backslash. A value that needs
// a single quote alongside one of those has no form dotenv and bash agree on;
// it is written in bash's '\'' form (exact for bash, the shims and AlphaClaw)
// and reported as not exact, and the env routes refuse a new one.
//
// Read: a single-quoted token decodes as bash decodes it, a double-quoted one
// loses its outer pair (as dotenv and the shims do; AlphaClaw only writes that
// form when nothing inside needs escaping), and anything else is the legacy
// bare value, byte for byte as before.
const kPlainEnvValuePattern = /^(?!=)(?:[A-Za-z0-9_./:@%+=,?*!\[\]^{}-]|(?![\p{White_Space}\p{C}])[^\x00-\x7F])*$/u;
const kDoubleQuoteUnsafePattern = /["$`\\]/;
const kRefusedEnvValueCharsPattern = /[\r\n\u2028\u2029\0]/;

const formatEnvValue = (value) => {
  const text = String(value ?? "");
  if (kPlainEnvValuePattern.test(text)) return { text, exact: true };
  if (!text.includes("'")) return { text: `'${text}'`, exact: true };
  if (!kDoubleQuoteUnsafePattern.test(text)) return { text: `"${text}"`, exact: true };
  return { text: `'${text.replaceAll("'", "'\\''")}'`, exact: false };
};

const decodeSingleQuoted = (raw) => {
  let out = "";
  let pos = 0;
  while (pos < raw.length) {
    if (raw[pos] === "'") {
      const close = raw.indexOf("'", pos + 1);
      if (close === -1) return null;
      out += raw.slice(pos + 1, close);
      pos = close + 1;
    } else if (raw.startsWith("\\'", pos)) {
      out += "'";
      pos += 2;
    } else if (/\s/.test(raw[pos])) {
      const rest = raw.slice(pos).trimStart();
      return rest === "" || rest.startsWith("#") ? out : null;
    } else {
      return null;
    }
  }
  return out;
};

const decodeDoubleQuoted = (raw) => {
  if (raw.length >= 2 && raw.endsWith('"')) return raw.slice(1, -1);
  return raw.match(/^"([^"]*)"\s+#/)?.[1] ?? null;
};

const decodeEnvValue = (raw) => {
  const text = String(raw ?? "");
  if (text.startsWith("'")) return decodeSingleQuoted(text) ?? text;
  if (text.startsWith('"')) return decodeDoubleQuoted(text) ?? text;
  return text;
};

// One .env line to { key, value }, or null for a blank, comment or
// keyless line. The key is returned trimmed and otherwise as written;
// callers normalize it.
const parseEnvLine = (line) => {
  const trimmed = String(line ?? "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) return null;
  return {
    key: trimmed.slice(0, eqIdx).trim().replace(/^export\s+/, ""),
    value: decodeEnvValue(trimmed.slice(eqIdx + 1)),
  };
};

const parseEnvFileContent = (content) =>
  String(content ?? "")
    .split("\n")
    .map(parseEnvLine)
    .filter(Boolean);

// The first submitted value a save must refuse: one that differs from the
// file's current value and either holds a line break or NUL (no reader takes
// one) or has no exact form. A legacy value resubmitted unchanged passes, so
// saving one key never fails on another. The error names the key, never the
// value.
const findUnwritableEnvValue = (nextVars, currentVars) => {
  const current = new Map((currentVars || []).map(({ key, value }) => [key, String(value ?? "")]));
  for (const entry of nextVars || []) {
    const key = String(entry?.key ?? "").trim();
    const value = String(entry?.value ?? "");
    if (!key || current.get(key) === value) continue;
    if (kRefusedEnvValueCharsPattern.test(value)) {
      return {
        key,
        code: "env_value_line_break",
        error: `${key} contains a line break or NUL character, which .env cannot store. Remove it and save again.`,
      };
    }
    if (!formatEnvValue(value.trimEnd()).exact) {
      return {
        key,
        code: "env_value_unrepresentable",
        error: `${key} mixes a single quote with a double quote, $, backtick or backslash, which .env cannot store so that bash and OpenClaw read it the same. Remove the single quote, or the double quote, $, backtick or backslash, then save; to keep this exact value, set ${key} in the deployment environment.`,
      };
    }
  }
  return null;
};

module.exports = {
  kPlainEnvValuePattern,
  formatEnvValue,
  decodeEnvValue,
  parseEnvLine,
  parseEnvFileContent,
  findUnwritableEnvValue,
};
