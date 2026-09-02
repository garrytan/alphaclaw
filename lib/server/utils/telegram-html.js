// Telegram HTML transport renderer for the house notification format.
//
// Notices are AUTHORED in the house format (AGENTS.md "Telegram Notice
// Format"): `*bold*`, `` `code` ``, `[label](url)`. They used to ship with
// parse_mode=Markdown, where any stray `_`, `*` or `[` in a VALUE (an error
// message, a version string, a path) is a fatal "can't parse entities" — the
// #54 operator never received a single alert. The transport now renders the
// house format to Telegram HTML right before the send, escaping every value
// so no runtime string can break the markup, and the caller falls back to
// plain text when the render is rejected (locally by the validator, or by
// Telegram with a 400).
//
//   text ─▶ split on `code` spans (contents protected: no bold/link inside)
//        ─▶ text segments: [label](url) ─▶ <a href> (https?:// only, else
//                                          "label (url)" as text)
//                          *…*          ─▶ <b>…</b> (single line, non-greedy;
//                                          an unpaired * stays literal)
//        ─▶ every literal escaped (& < >) ─▶ html
//        ─▶ stack validator over the emitted tags (b/code/a only, properly
//           nested, no stray angle brackets) ─▶ { html, plain }
//                                              invalid ─▶ { html: null, plain }
//
// No compose site escapes anything: Discord, Slack and the webhook keep
// consuming the house-format text unchanged.
const kTelegramHtmlEscapes = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
});
const kTelegramHtmlAttrEscapes = Object.freeze({
  ...kTelegramHtmlEscapes,
  '"': "&quot;",
});
const kAllowedTelegramTags = Object.freeze(new Set(["b", "code", "a"]));
const kCodeSpanPattern = /`([^`\n]+)`/g;
const kLinkPattern = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const kBoldPattern = /\*([^*\n]+)\*/g;
const kHttpUrlPattern = /^https?:\/\//i;
const kTagPattern = /<(\/?)([a-z]+)((?:\s[^<>]*)?)>/g;
const kAnchorHrefPattern = /^\shref="[^"<>]*"$/;

const escapeTelegramHtml = (value) =>
  String(value ?? "").replace(/[&<>]/g, (ch) => kTelegramHtmlEscapes[ch]);

const escapeTelegramHtmlAttr = (value) =>
  String(value ?? "").replace(/[&<>"]/g, (ch) => kTelegramHtmlAttrEscapes[ch]);

// Splits the raw text into alternating literal/code segments. Code spans win
// over every other construct: a `*` or `[` inside backticks is protected, and
// a bold/link marker can never pair across a code span.
const tokenizeCodeSpans = (text) => {
  const segments = [];
  let cursor = 0;
  for (const match of text.matchAll(kCodeSpanPattern)) {
    if (match.index > cursor) {
      segments.push({ kind: "text", value: text.slice(cursor, match.index) });
    }
    segments.push({ kind: "code", value: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", value: text.slice(cursor) });
  }
  return segments;
};

const renderLink = (label, url) =>
  kHttpUrlPattern.test(url)
    ? `<a href="${escapeTelegramHtmlAttr(url)}">${escapeTelegramHtml(label)}</a>`
    : escapeTelegramHtml(`${label} (${url})`);

// Links + escaped literals. Used for plain runs AND for the inside of a bold
// span, so `*see [logs](url)*` nests as <b><a>…</a></b>.
const renderLinksAndText = (text) => {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(kLinkPattern)) {
    out += escapeTelegramHtml(text.slice(cursor, match.index));
    out += renderLink(match[1], match[2]);
    cursor = match.index + match[0].length;
  }
  return out + escapeTelegramHtml(text.slice(cursor));
};

const renderTextSegment = (text) => {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(kBoldPattern)) {
    out += renderLinksAndText(text.slice(cursor, match.index));
    out += `<b>${renderLinksAndText(match[1])}</b>`;
    cursor = match.index + match[0].length;
  }
  return out + renderLinksAndText(text.slice(cursor));
};

// Stack-based well-formedness check over the EMITTED markup: only b/code/a
// tags, every open tag closed in order, <a> carries exactly one href, and no
// angle bracket survives outside a tag (all literals were escaped). Returns
// false rather than throwing — the caller sends plain text instead.
const validateTelegramHtml = (html) => {
  if (typeof html !== "string") return false;
  const stack = [];
  let cursor = 0;
  for (const match of html.matchAll(kTagPattern)) {
    if (/[<>]/.test(html.slice(cursor, match.index))) return false;
    cursor = match.index + match[0].length;
    const [, slash, name, attrs] = match;
    if (!kAllowedTelegramTags.has(name)) return false;
    if (slash) {
      if (attrs) return false;
      if (stack.pop() !== name) return false;
      continue;
    }
    if (name === "a" ? !kAnchorHrefPattern.test(attrs) : attrs !== "") return false;
    stack.push(name);
  }
  if (/[<>]/.test(html.slice(cursor))) return false;
  return stack.length === 0;
};

// `validate` is a test seam only — production callers never pass it.
const renderTelegramHtml = (text, { validate = validateTelegramHtml } = {}) => {
  const plain = String(text ?? "");
  const html = tokenizeCodeSpans(plain)
    .map((segment) =>
      segment.kind === "code"
        ? `<code>${escapeTelegramHtml(segment.value)}</code>`
        : renderTextSegment(segment.value),
    )
    .join("");
  return validate(html) ? { html, plain } : { html: null, plain };
};

module.exports = {
  renderTelegramHtml,
  escapeTelegramHtml,
  validateTelegramHtml,
};
