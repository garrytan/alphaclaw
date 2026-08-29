import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Conventions guard: date/time formatting lives in lib/public/js/lib/format.js
// and nowhere else (AGENTS.md "Shared formatting utilities"). Direct toLocale*
// or Intl.DateTimeFormat usage in components is the drift vector that produced
// six competing time dialects before the normalization — this test keeps it
// from growing back. Known limit: it cannot catch raw ISO string interpolation
// or manual date assembly; it guards the dominant vector only.
const kUiRoot = fileURLToPath(new URL("../../lib/public/js/", import.meta.url));

const kBannedPatterns = [
  { name: "toLocaleString(", regex: /\btoLocaleString\(/ },
  { name: "toLocaleTimeString(", regex: /\btoLocaleTimeString\(/ },
  { name: "toLocaleDateString(", regex: /\btoLocaleDateString\(/ },
  { name: "Intl.DateTimeFormat", regex: /\bIntl\.DateTimeFormat\b/ },
];

// Allowlist entries are (relative path, pattern name) pairs.
const kAllowed = new Set([
  // The canonical formatter module — the ONE home for these calls.
  "lib/format.js|toLocaleString(",
  "lib/format.js|toLocaleTimeString(",
  "lib/format.js|toLocaleDateString(",
  "lib/format.js|Intl.DateTimeFormat",
  // Number#toLocaleString char counts (not dates) — locale un-pinning for
  // number formatting is deferred (TODOS.md E5).
  "components/doctor/helpers.js|toLocaleString(",
]);

const collectJsFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      collectJsFiles(fullPath, out);
    } else if (entry.endsWith(".js")) {
      out.push(fullPath);
    }
  }
  return out;
};

describe("frontend/format conventions guard", () => {
  it("keeps date/time formatting inside lib/format.js", () => {
    const violations = [];
    for (const filePath of collectJsFiles(kUiRoot)) {
      const relPath = filePath.slice(kUiRoot.length).replaceAll("\\", "/");
      const lines = readFileSync(filePath, "utf8").split("\n");
      for (const { name, regex } of kBannedPatterns) {
        if (kAllowed.has(`${relPath}|${name}`)) continue;
        lines.forEach((line, index) => {
          if (regex.test(line)) {
            violations.push(`${relPath}:${index + 1} uses ${name}`);
          }
        });
      }
    }
    expect(
      violations,
      "Use the shared formatters in lib/public/js/lib/format.js instead " +
        "(AGENTS.md → Shared formatting utilities); extend format.js if a " +
        "new format is genuinely needed.",
    ).toEqual([]);
  });
});
