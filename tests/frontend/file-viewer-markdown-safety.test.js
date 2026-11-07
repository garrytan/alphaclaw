const fs = require("fs");
const path = require("path");

// GST-1743: the Browse file viewer previews workspace markdown that the box
// agent (exec, browse.write) or a relay peer can write. Raw `marked` keeps
// raw HTML, and the preview injects its output with dangerouslySetInnerHTML,
// so a .md with `<img src=x onerror=...>` ran script in an admin's session.
// The preview must go through the safe renderer.
const kFileViewerDir = path.join(__dirname, "../../lib/public/js/components/file-viewer");
const hookSource = fs.readFileSync(path.join(kFileViewerDir, "use-file-viewer.js"), "utf8");
const utilsSource = fs.readFileSync(path.join(kFileViewerDir, "utils.js"), "utf8");
const browserAttachSource = fs.readFileSync(
  path.join(__dirname, "../../lib/public/js/components/nodes-tab/browser-attach/index.js"),
  "utf8",
);

const loadPreviewPath = async () => {
  const [{ renderMarkdownPreviewHtml }, { parseFrontmatter }] = await Promise.all([
    import("../../lib/public/js/components/file-viewer/utils.js"),
    import("../../lib/public/js/lib/syntax-highlighters/index.js"),
  ]);
  return (content) => renderMarkdownPreviewHtml(parseFrontmatter(content).body);
};

const kHostileMarkdown = [
  "---",
  "title: notes",
  "---",
  "# Notes",
  "",
  "<img src=x onerror=alert(1)>",
  "",
  "<script>alert(1)</script>",
  "",
  '<iframe src="https://example.com"></iframe>',
  "",
  "inline <img src=x onerror=alert(2)> and [x](javascript:alert(1))",
  "",
].join("\n");

describe("frontend/file-viewer markdown preview safety (GST-1743)", () => {
  it("renders the preview through renderMarkdownSafe, never raw marked", () => {
    expect(hookSource).toContain("renderMarkdownPreviewHtml(parsedFrontmatter.body)");
    expect(utilsSource).toContain('import { renderMarkdownSafe } from "../../lib/safe-markdown.js"');
    for (const source of [hookSource, utilsSource, browserAttachSource]) {
      expect(source).not.toContain('from "marked"');
      expect(source).not.toContain("marked.parse(");
    }
  });

  it("leaves no live tag, attribute or handler from hostile markdown", async () => {
    const renderPreview = await loadPreviewPath();
    const html = renderPreview(kHostileMarkdown);

    expect(html).not.toMatch(/<(img|script|iframe)\b/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/<a\b/i);

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;iframe");
    expect(html).toContain("<h1");
    expect(html).not.toContain("title: notes");
  });

  it("keeps legitimate markdown: links, images, tables, code and line breaks", async () => {
    const renderPreview = await loadPreviewPath();
    const html = renderPreview(
      [
        "[docs](https://example.com/docs) [sibling](./notes.md) [up](../README.md) [anchor](#setup)",
        "![diagram](./images/flow.png)",
        "first line",
        "second line",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "```json",
        '{ "ok": true }',
        "```",
      ].join("\n"),
    );

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="./notes.md"');
    expect(html).toContain('href="../README.md"');
    expect(html).toContain('href="#setup"');
    expect(html).toContain('<img src="./images/flow.png" alt="diagram"');
    expect(html).toMatch(/first line<br\s*\/?>\s*second line/);
    expect(html).toContain("<table>");
    expect(html).toContain('<code class="language-json">');
  });
});
