import { Marked } from "marked";

// Safe markdown rendering for UNTRUSTED content (GitHub release bodies, chat
// messages, workspace files in the Browse preview). marked does
// not sanitize (its `sanitize` option was removed), so raw HTML in the source is a
// straight XSS vector when the output lands in dangerouslySetInnerHTML. Policy:
// - Raw HTML blocks/inlines are ESCAPED and shown as text (release notes are
//   overwhelmingly plain markdown; embedded HTML rendering is not worth the risk).
//   marked marks the text after an inline <kbd>/<code>/<pre>/<script> tag as
//   already escaped and would emit it raw, so walkTokens clears that flag.
// - Link/image URLs must use a safe protocol (http(s), mailto, #, relative);
//   anything else (javascript:, data:, vbscript:) renders as plain text.
//   A root-relative path stays on this box: `//host` and `/\host` are
//   scheme-relative URLs to another host and are refused. Tabs and newlines
//   are removed first, as browsers do when they parse a URL, so `/\t/host`
//   cannot pass as a path.
const kSafeUrl = /^(https?:|mailto:|#|\/(?![/\\])|\.\/|\.\.\/)/i;
const kUrlStrippedChars = /[\t\n\r]/g;

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeHref = (href) => {
  const cleaned = String(href ?? "").trim().replace(kUrlStrippedChars, "");
  return kSafeUrl.test(cleaned) ? cleaned : null;
};

const kSafeMarked = new Marked({
  gfm: true,
  breaks: true,
  walkTokens(token) {
    if (token.type === "text") token.escaped = false;
  },
  renderer: {
    // marked v16 renderer methods receive token objects.
    html(token) {
      const text = typeof token === "string" ? token : (token?.text ?? "");
      return escapeHtml(text);
    },
    link(token) {
      const href = safeHref(token?.href);
      const inner = this.parser.parseInline(token?.tokens ?? []);
      if (!href) return inner;
      const title = token?.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noreferrer">${inner}</a>`;
    },
    image(token) {
      const href = safeHref(token?.href);
      const alt = escapeHtml(token?.text ?? "");
      if (!href) return alt;
      const title = token?.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<img src="${escapeHtml(href)}" alt="${alt}"${title} loading="lazy" />`;
    },
  },
});

export const renderMarkdownSafe = (source) =>
  kSafeMarked.parse(String(source ?? ""), { async: false });
