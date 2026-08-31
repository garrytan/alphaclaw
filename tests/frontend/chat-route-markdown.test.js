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
      "renderMarkdownSafe(normalizeListMarkers(normalizeMarkdownInput(value)))",
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
