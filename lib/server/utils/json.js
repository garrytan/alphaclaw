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
  for (let startIndex = 0; startIndex < text.length; startIndex += 1) {
    const openingChar = text[startIndex];
    if (!openingChars.has(openingChar)) continue;
    const expectedClosingChar = closingCharByOpeningChar[openingChar];
    const stack = [expectedClosingChar];
    let inString = false;
    let escapeNextChar = false;
    for (let currentIndex = startIndex + 1; currentIndex < text.length; currentIndex += 1) {
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

module.exports = {
  parseJsonSafe,
  parseJsonValueFromNoisyOutput,
  parseJsonObjectFromNoisyOutput,
};
