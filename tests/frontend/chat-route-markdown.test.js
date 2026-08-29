const fs = require("fs");
const path = require("path");

// H8: the chat renders agent- and remote-channel-sourced markdown (untrusted).
// It must go through the safe renderer (kSafeUrl allowlist + HTML escaping), not
// raw `marked`, or `[x](javascript:...)` becomes a live anchor in
// dangerouslySetInnerHTML. This is a source-level guard: it fails if the render
// path regresses to raw marked. The safe renderer's behavior (dropping
// javascript: links, keeping https) is covered by frontend/safe-markdown.test.js.
const chatRouteSource = fs.readFileSync(
  path.join(
    __dirname,
    "../../lib/public/js/components/routes/chat-route.js",
  ),
  "utf8",
);

describe("frontend/chat-route markdown safety (H8)", () => {
  it("renders chat markdown through renderMarkdownSafe", () => {
    expect(chatRouteSource).toContain(
      'import { renderMarkdownSafe } from "../../lib/safe-markdown.js"',
    );
    expect(chatRouteSource).toContain(
      "renderMarkdownSafe(normalizeListMarkers(normalizeMarkdownInput(value)))",
    );
  });

  it("does not render chat markdown with raw marked", () => {
    expect(chatRouteSource).not.toContain('from "marked"');
    expect(chatRouteSource).not.toContain("marked.parse(");
  });
});
