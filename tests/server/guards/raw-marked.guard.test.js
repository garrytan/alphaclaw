// Guard (ALPH-71, Captain ruling on #329 adversarial-native#2): no raw
// `marked` in the Setup UI. marked does not sanitize; the file-viewer preview
// rendered workspace Markdown with raw marked.parse into innerHTML and an
// agent-written <img onerror> ran as the admin (H-2). Every Markdown render
// goes through renderMarkdownSafe (lib/public/js/lib/safe-markdown.js), the
// only file allowed to load marked. Counted per file so a moved line does not
// churn the list. The list is empty; keep it empty.
const { auditTree, formatHits } = require("./guard-utils");
const { scanRawMarked } = require("./scanners");

// file::count → why it is still allowed. #329 moved the last two offenders
// (file-viewer, markdown split view) to renderMarkdownSafe.
const kKnownOffenders = {};

describe("guard: the UI renders Markdown through renderMarkdownSafe, never raw marked", () => {
  it("finds static, dynamic and subpath imports, requires and direct calls, ignoring comments (self-test)", () => {
    const fixture = [
      'import { marked } from "marked";',
      'import { Marked as M } from "marked/lib/marked.esm.js";',
      'const lazy = await import("marked");',
      'const req = require("marked");',
      "const html = marked.parse(body);",
      "const inline = marked(body);",
      "const custom = new Marked({});",
      '// import { marked } from "marked";',
      "/* marked.parse(commented) */",
    ].join("\n");
    const hits = scanRawMarked(fixture, "lib/public/js/components/planted.js");
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("lib/public/js/components/planted.js::7");
    expect(hits[0].line).toBe(1);
  });

  it("does not flag renderMarkdownSafe callers or look-alike names (self-test)", () => {
    const fixture = [
      'import { renderMarkdownSafe } from "../lib/safe-markdown.js";',
      "const html = renderMarkdownSafe(body);",
      "const remarked = unmarked(body);",
      "item.marked(true);",
      'const label = "marked as read";',
    ].join("\n");
    expect(scanRawMarked(fixture, "lib/public/js/components/ok.js")).toEqual([]);
  });

  it("exempts the safe renderer itself (self-test)", () => {
    expect(
      scanRawMarked('import { Marked } from "marked";\nnew Marked({});', "lib/public/js/lib/safe-markdown.js"),
    ).toEqual([]);
  });

  it("has no raw marked outside the allowlist, and no stale entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib/public/js"],
      scan: scanRawMarked,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `Raw marked in UI code — render through renderMarkdownSafe (lib/public/js/lib/safe-markdown.js):\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(stale, `Stale allowlist entries:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
