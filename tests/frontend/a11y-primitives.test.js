import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const kComponents = path.resolve(__dirname, "../../lib/public/js/components");
const read = (file) => fs.readFileSync(path.join(kComponents, file), "utf8");

// Returns the text of every opening tag of the given name, skipping the
// arrow functions and nested templates inside \${...} attribute values.
const openingTags = (source, tagName) => {
  const tags = [];
  const start = "<" + tagName;
  let index = source.indexOf(start);
  while (index >= 0) {
    const next = source[index + start.length];
    if (/[\s>]/.test(next || "")) {
      let depth = 0;
      let quote = null;
      let end = index + start.length;
      for (; end < source.length; end += 1) {
        const char = source[end];
        if (depth === 0 && quote) {
          if (char === quote) quote = null;
          continue;
        }
        if (char === "$" && source[end + 1] === "{") {
          depth += 1;
          end += 1;
          continue;
        }
        if (depth > 0) {
          if (char === "{") depth += 1;
          else if (char === "}") depth -= 1;
          continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === ">") break;
      }
      tags.push(source.slice(index, end + 1));
    }
    index = source.indexOf(start, index + 1);
  }
  return tags;
};

const kAllComponentFiles = fs
  .readdirSync(kComponents, { recursive: true })
  .filter((file) => file.endsWith(".js"));

const kSharedComponents = fs
  .readdirSync(kComponents)
  .filter((file) => file.endsWith(".js"));
const kTouchedFeatureFiles = [
  "agents-tab/agent-detail-panel.js",
  "doctor/index.js",
  "google/gmail-watch-toggle.js",
  "upgrade-alert/doctor-output-dialog.js",
  "watchdog-tab/console/index.js",
  "watchdog-tab/incidents/index.js",
];

describe("frontend/a11y primitives (ALPH-69 phase 1c)", () => {
  it("gives every button in a shared component and in the files this phase touched a type", () => {
    const missing = [];
    for (const file of [...kSharedComponents, ...kTouchedFeatureFiles]) {
      for (const tag of openingTags(read(file), "button")) {
        if (!/\btype=/.test(tag)) missing.push(file + ": " + tag.replace(/\s+/g, " ").slice(0, 80));
      }
    }
    expect(missing).toEqual([]);
  });

  it("puts aria-label on a span only together with a role (aria-prohibited-attr)", () => {
    for (const file of ["envars.js", "watchdog-tab/incidents/index.js", "info-tooltip.js"]) {
      for (const tag of openingTags(read(file), "span")) {
        if (/\baria-label=/.test(tag)) expect(tag, file).toMatch(/\brole=/);
      }
    }
  });

  it("names every Doctor select (select-name)", () => {
    const selects = openingTags(read("doctor/index.js"), "select");
    expect(selects.length).toBeGreaterThan(0);
    for (const tag of selects) expect(tag).toMatch(/\baria-label="[^"]+"/);
  });

  it("leaves dialog semantics to ModalShell, so no dialog nests inside another", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && entry.name !== "modal-shell.js") {
          if (/role="dialog"/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(kComponents, full));
        }
      }
    };
    walk(kComponents);
    expect(offenders).toEqual([]);
  });

  it("gives form controls the field border, never the panel border-border", () => {
    const offenders = [];
    for (const file of kAllComponentFiles) {
      if (/^(chat|relay-tab)\//.test(file)) continue;
      const source = read(file);
      const controls = ["input", "select", "textarea"].flatMap((tag) => openingTags(source, tag));
      const fieldProps = source.match(/(?:inputClass|selectClassName)\s*=\s*"[^"]*"/g) || [];
      for (const text of [...controls, ...fieldProps]) {
        if (/\bborder-border\b/.test(text)) offenders.push(file + ": " + text.replace(/\s+/g, " ").slice(0, 80));
      }
    }
    expect(offenders).toEqual([]);
  });
});
