import { renderMarkdownSafe } from "../../lib/safe-markdown.js";

// Chat/tool content is agent- and remote-channel-sourced (untrusted), so it
// must go through the safe renderer: it escapes raw HTML and allowlists link/
// image URLs (kSafeUrl), neutralizing `[x](javascript:...)` that marked v16
// would otherwise render as a live anchor (H8). The safe renderer escapes HTML
// itself. Guarded by tests/frontend/chat-route-markdown.test.js.
export const normalizeMarkdownInput = (value = "") => {
  const source = String(value || "").replace(/\r\n/g, "\n");
  if (source.includes("\n")) return source;
  // Some runtimes persist escaped sequences in history payloads.
  return source.includes("\\n") ? source.replace(/\\n/g, "\n") : source;
};

export const normalizeListMarkers = (value = "") =>
  String(value || "").replace(/^(\s*)\d+\.\s+/gm, "$1- ");

export const renderMarkdownHtml = (value = "") =>
  renderMarkdownSafe(normalizeListMarkers(normalizeMarkdownInput(value)));

export const parseJsonMessage = (value = "") => {
  const source = String(value || "").trim();
  if (!source) return null;
  if (!(source.startsWith("{") || source.startsWith("["))) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
};
