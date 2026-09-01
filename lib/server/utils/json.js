const parseJsonSafe = (rawValue, fallbackValue = null, options = {}) => {
  const shouldTrim = options?.trim === true;
  const text = shouldTrim
    ? String(rawValue ?? "").trim()
    : String(rawValue ?? "");
  if (!text) return fallbackValue;
  try {
    return JSON.parse(text);
  } catch {
    return fallbackValue;
  }
};

// Every opening brace/bracket starts a fresh candidate scan, so adversarial
// input full of unmatched openers (e.g. hundreds of KB of "{") is O(n²) — and
// this runs synchronously on the event loop, fed by up to 512KB-1MB CLI tails.
// A cumulative work budget across ALL candidate scans bounds the total cost:
// at least 2× the input length so one well-formed payload (plus a stretch of
// noise) always fits in a single pass, with a floor that keeps legitimate
// small-but-noisy captures (several unmatched openers before the payload)
// scanning while pathological input still stops after a few million steps.
const kNoisyJsonScanMinWorkBudget = 4_000_000;

// Optional `validate(parsed) => boolean` keeps scanning past valid-but-wrong
// JSON values embedded in noise (e.g. a small `{}` in a log line before the
// real machine payload) — callers parsing a specific contract pass a shape
// predicate instead of hand-rolling their own scanner.
const parseJsonValueFromNoisyOutput = (rawValue, { validate = null } = {}) => {
  const text = String(rawValue ?? "");
  const openingChars = new Set(["{", "["]);
  const closingCharByOpeningChar = {
    "{": "}",
    "[": "]",
  };
  const workBudget = Math.max(kNoisyJsonScanMinWorkBudget, 2 * text.length);
  let workSteps = 0;
  for (let startIndex = 0; startIndex < text.length; startIndex += 1) {
    const openingChar = text[startIndex];
    if (!openingChars.has(openingChar)) continue;
    const expectedClosingChar = closingCharByOpeningChar[openingChar];
    const stack = [expectedClosingChar];
    let inString = false;
    let escapeNextChar = false;
    for (let currentIndex = startIndex + 1; currentIndex < text.length; currentIndex += 1) {
      workSteps += 1;
      if (workSteps > workBudget) return null;
      const currentChar = text[currentIndex];
      if (inString) {
        if (escapeNextChar) {
          escapeNextChar = false;
          continue;
        }
        if (currentChar === "\\") {
          escapeNextChar = true;
          continue;
        }
        if (currentChar === "\"") {
          inString = false;
        }
        continue;
      }
      if (currentChar === "\"") {
        inString = true;
        continue;
      }
      if (openingChars.has(currentChar)) {
        stack.push(closingCharByOpeningChar[currentChar]);
        continue;
      }
      if (currentChar !== stack[stack.length - 1]) continue;
      stack.pop();
      if (stack.length > 0) continue;
      const candidate = text.slice(startIndex, currentIndex + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (!validate || validate(parsed)) return parsed;
      } catch {
        // fall through: keep scanning from the next opening char
      }
      break;
    }
  }
  return null;
};

const parseJsonObjectFromNoisyOutput = (rawValue) => {
  const parsedValue = parseJsonValueFromNoisyOutput(rawValue);
  return parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
    ? parsedValue
    : null;
};

// The OpenClaw CLI's failure envelope, fished out of interleaved chatter:
//   {"ok": false, "error": {"type": "...", "message": "..."}}
// Matches the GENERIC envelope; type-specific checks (=== "cli_error") stay
// with each consumer — the backup route accepts any type and inspects it
// downstream, the doctor classifier pins cli_error exactly. One matcher for
// both so the upstream-owned shape cannot drift between copies.
const parseCliErrorReport = (rawValue) =>
  parseJsonValueFromNoisyOutput(rawValue, {
    validate: (candidate) =>
      Boolean(candidate) &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      candidate.ok === false &&
      Boolean(candidate.error) &&
      typeof candidate.error === "object" &&
      !Array.isArray(candidate.error) &&
      typeof candidate.error.type === "string" &&
      typeof candidate.error.message === "string",
  });

module.exports = {
  parseJsonSafe,
  parseJsonValueFromNoisyOutput,
  parseJsonObjectFromNoisyOutput,
  parseCliErrorReport,
};
