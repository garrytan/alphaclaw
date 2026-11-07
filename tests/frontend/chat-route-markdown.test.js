const fs = require("fs");
const path = require("path");

// H8: the chat renders agent- and remote-channel-sourced markdown (untrusted).
// It must go through the safe renderer (kSafeUrl allowlist + HTML escaping), not
// raw `marked`, or `[x](javascript:...)` becomes a live anchor in
// dangerouslySetInnerHTML. This is a source-level guard: it fails if the render
// path regresses to raw marked. The safe renderer's behavior (dropping
// javascript: links, keeping https) is covered by frontend/safe-markdown.test.js.
const markdownSource = fs.readFileSync(
  path.join(__dirname, "../../lib/public/js/components/chat/markdown.js"),
  "utf8",
);
const bubbleSource = fs.readFileSync(
  path.join(__dirname, "../../lib/public/js/components/chat/message-bubble.js"),
  "utf8",
);

describe("frontend/chat markdown safety (H8)", () => {
  it("renders chat markdown through renderMarkdownSafe", () => {
    expect(markdownSource).toContain(
      'import { renderMarkdownSafe } from "../../lib/safe-markdown.js"',
    );
    expect(markdownSource).toContain(
      "decorateCodeBlocks(renderMarkdownSafe(normalizeMarkdownInput(value)))",
    );
    expect(bubbleSource).toContain("renderMarkdownHtml(message.content)");
  });

  it("does not render chat markdown with raw marked", () => {
    for (const source of [markdownSource, bubbleSource]) {
      expect(source).not.toContain('from "marked"');
      expect(source).not.toContain("marked.parse(");
    }
  });
});

// Behavior half of the H8 guard: the string asserts above pin the WIRING;
// these pin the OUTPUT — a regression in the normalize helpers that reopened
// an injection path would pass a pure string grep.
describe("frontend/chat markdown safety (H8 behavior)", () => {
  it("neutralizes javascript: links and inline HTML", async () => {
    const { renderMarkdownHtml } = await import(
      "../../lib/public/js/components/chat/markdown.js"
    );
    const hostile = renderMarkdownHtml("[x](javascript:alert(1))");
    expect(hostile).not.toContain("javascript:");
    // Raw HTML must be ESCAPED to text — a live <img> tag would carry the
    // handler; the escaped "&lt;img" form is inert.
    const injected = renderMarkdownHtml('<img src=x onerror="alert(1)">');
    expect(injected).not.toContain("<img");
    expect(injected).toContain("&lt;img");
    const safe = renderMarkdownHtml("[ok](https://example.com)");
    expect(safe).toContain("https://example.com");
  });

  it("keeps tables, ordered lists and quotes, and adds a copy button to code blocks (ALPH-68)", async () => {
    const { renderMarkdownHtml } = await import(
      "../../lib/public/js/components/chat/markdown.js"
    );
    const out = renderMarkdownHtml(
      "| col a | col b |\n|---|---|\n| 1 | 2 |\n\n1. one\n2. two\n\n> quote\n\n```\nconst x = 1;\n```",
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<th>col a</th>");
    expect(out).toContain("<ol>");
    expect(out).not.toContain("<ul>");
    expect(out).toContain("<blockquote>");
    expect(out).toContain('<div class="chat-code-block"><button type="button" class="chat-code-copy"');
    expect(out).toContain("</pre></div>");
    const escapedPre = renderMarkdownHtml("<pre>x</pre>");
    expect(escapedPre).not.toContain("chat-code-copy");
    expect(escapedPre).toContain("&lt;pre&gt;");
  });
});
