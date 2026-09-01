// Evidence shown in the UI (stderr tails, error summaries) may echo secrets
// the gateway printed. Mask every known secret value before storage/display.
const kMinSecretLength = 6;

// Config keys whose string values are treated as secrets when written inline
// in openclaw.json instead of as ${ENV} references.
const kSecretConfigKeyPattern =
  /token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|auth/i;

const collectConfigSecretValues = (config, values, depth = 0) => {
  if (!config || typeof config !== "object" || depth > 8) return;
  const considerSecretString = (value) => {
    const text = String(value ?? "").trim();
    // ${ENV} references resolve through env collection already; the raw
    // reference text itself is not a secret.
    if (!text || text.startsWith("${")) return;
    if (text.length >= kMinSecretLength) values.add(text);
  };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      if (!kSecretConfigKeyPattern.test(key)) continue;
      considerSecretString(value);
    } else if (Array.isArray(value) && kSecretConfigKeyPattern.test(key)) {
      // e.g. { tokens: ["...", "..."] } — every string member is a secret.
      for (const member of value) {
        if (typeof member === "string") considerSecretString(member);
        else if (member && typeof member === "object") {
          collectConfigSecretValues(member, values, depth + 1);
        }
      }
    } else if (value && typeof value === "object") {
      collectConfigSecretValues(value, values, depth + 1);
    }
  }
};

const collectSecretValues = ({
  env = process.env,
  envFileVars = [],
  configObjects = [],
} = {}) => {
  const values = new Set();
  const consider = (value) => {
    const text = String(value ?? "").trim();
    if (text.length >= kMinSecretLength) values.add(text);
  };
  // process.env is full of benign values that appear in stderr constantly
  // (HOME, PATH, PWD, LANG...). Masking those would riddle the evidence with
  // *** and destroy its diagnostic value, so only secret-NAMED env keys are
  // collected. Env-FILE vars are user-declared secrets — collected as-is.
  for (const [key, value] of Object.entries(env || {})) {
    if (kSecretConfigKeyPattern.test(key)) consider(value);
  }
  for (const entry of envFileVars || []) consider(entry?.value);
  for (const config of configObjects || []) {
    collectConfigSecretValues(config, values);
  }
  return values;
};

const redactSecrets = (text, { secrets } = {}) => {
  let result = String(text ?? "");
  if (!result || !secrets) return result;
  // Longest first: when one collected value is a prefix/substring of another,
  // masking the shorter one first would split the longer secret and leak its
  // remainder around the "***".
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (result.includes(secret)) {
      result = result.split(secret).join("***");
    }
  }
  return result;
};

// Shape-based fallback for token-bearing URL params: values sourced outside
// the collected secret set (a URL another process printed, an upstream
// bootstrap handoff) are still masked by their param shape. Covers the
// shared-token (#token=) and one-time handoff (#bootstrapToken=) forms.
const scrubTokenParams = (text) =>
  String(text ?? "").replace(
    // Boundary includes start-of-line and whitespace so a bare `token=...`
    // outside a URL is still masked.
    /((?:^|[#?&\s])(?:bootstrapToken|token)=)[^\s&#]+/gim,
    "$1***",
  );

// Shape-based redaction for secrets that live in NO collected store — e.g. a
// bearer token, JWT, provider key, or DSN credential the gateway echoed from
// an upstream response into its crash stderr, or a value stored under a
// non-secret-named config key. Applied on top of value-match redaction to
// every evidence stream bound for a provider API or persisted to disk.
// (Moved here from gateway-medic.js so the restart-evidence path and the
// overseers share one implementation.)
const kSecretShapePatterns = [
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g, replacement: "***" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "***" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replacement: "***",
  },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: "***" }, // Google API keys
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replacement: "***" }, // GitHub tokens
  { pattern: /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/g, replacement: "***" }, // Slack tokens
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "***" }, // AWS access key ids
  {
    pattern: /https:\/\/hooks\.slack\.com\/services\/\S+/g,
    replacement: "https://hooks.slack.com/services/***",
  },
  {
    // scheme://user:password@host — the userinfo IS the secret (DSNs,
    // webhook URLs with embedded basic auth).
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi,
    replacement: "$1***@",
  },
  {
    // Cookie/Set-Cookie header lines echoed into stderr.
    pattern: /\b(set-cookie|cookie):\s*[^\n]+/gi,
    replacement: "$1: ***",
  },
  {
    // Signed/credential query parameters in URLs (presigned S3/GCS links,
    // ?token=/?sig= capability URLs).
    pattern:
      /([?&](?:sig|signature|token|key|apikey|api_key|access_token|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature)=)[^&\s"']+/gi,
    replacement: "$1***",
  },
];
const redactSecretShapes = (text) => {
  let result = String(text ?? "");
  for (const { pattern, replacement } of kSecretShapePatterns) {
    result = result.replace(pattern, replacement);
  }
  return result;
};

// CSI (colors/cursor), OSC (titles), charset designation, and the short
// ESC-letter forms. (Hoisted from claude-code-local/tui.js — one complete
// implementation for TUI parsing AND evidence normalization.) IMPORTANT for
// redaction: run this BEFORE any secret matching — an ANSI escape inserted
// inside a Bearer/JWT/secret defeats the pattern, and stripping it afterwards
// would reveal the secret intact.
const kCsiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const kOscPattern = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const kCharsetPattern = /\x1b[()][0-9A-Za-z]/g;
const kBareEscPattern = /\x1b[=>78]/g;

const stripAnsi = (text) =>
  String(text || "")
    .replace(kOscPattern, "")
    .replace(kCsiPattern, "")
    .replace(kCharsetPattern, "")
    .replace(kBareEscPattern, "")
    // Cursor-visibility fragments survive when the ESC byte was consumed by a
    // partial capture: "[?25l" / "[?25h" interleave into spinner lines.
    .replace(/\[\?25[lh]/g, "")
    .replace(/\r/g, "");

// Remaining C0/C1 control bytes (NUL, backspace, vertical tab...) that could
// split a secret across a match boundary or corrupt persisted JSON evidence.
// Keeps \n and \t — evidence stays line-structured.
const stripControlChars = (text) =>
  String(text ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

module.exports = {
  collectSecretValues,
  redactSecrets,
  scrubTokenParams,
  redactSecretShapes,
  stripAnsi,
  stripControlChars,
};
