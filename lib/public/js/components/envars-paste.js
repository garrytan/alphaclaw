const kEnvVarKeyPattern = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)$/;
const kUppercaseEnvVarKeyPattern = /^[A-Z_][A-Z0-9_]*$/;

const stripSurroundingQuotes = (raw) => {
  const value = String(raw || "").trim();
  if (value.length < 2) return value;
  const startsWithDouble = value.startsWith('"');
  const endsWithDouble = value.endsWith('"');
  if (startsWithDouble && endsWithDouble) return value.slice(1, -1);
  const startsWithSingle = value.startsWith("'");
  const endsWithSingle = value.endsWith("'");
  if (startsWithSingle && endsWithSingle) return value.slice(1, -1);
  return value;
};

export const parseEnvVarPaste = (input) => {
  const lines = String(input || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"));
  const pairs = [];
  for (const line of lines) {
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const keyMatch = line.slice(0, eqIdx).trim().match(kEnvVarKeyPattern);
    if (!keyMatch) continue;
    pairs.push({
      key: keyMatch[1],
      value: stripSurroundingQuotes(line.slice(eqIdx + 1)),
    });
  }
  return pairs;
};

export const classifyEnvVarPaste = (input, field) => {
  const pairs = parseEnvVarPaste(input);
  if (pairs.length > 1) return { mode: "bulk", pairs };
  if (pairs.length !== 1) return { mode: "native", pairs: [] };
  if (field === "key") return { mode: "pair", pairs };
  if (field === "val" && kUppercaseEnvVarKeyPattern.test(pairs[0].key)) {
    return { mode: "value", pairs };
  }
  return { mode: "native", pairs: [] };
};
