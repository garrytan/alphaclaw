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
//   text ─▶ split on `code` spans (contents protected: no bold/link inside,
//           a `*` or `[` inside backticks is literal)
//        ─▶ bold pass over the WHOLE segment list: `*…*` ─▶ <b>…</b>
//           (single line, non-greedy; an unpaired * stays literal; the pair
//           MAY span code spans — Telegram allows <b> to contain <code>)
//        ─▶ text runs: [label](url) ─▶ <a href> (https?:// only, else
//                                      "label (url)" as text; balanced
//                                      parentheses allowed inside the url)
//        ─▶ every literal escaped (& < >) ─▶ html
//        ─▶ stack validator over the emitted tags (b/code/a only, properly
//           nested, no stray angle brackets) ─▶ { html, plain }
//                                              invalid ─▶ { html: null, plain }
//
// No compose site escapes anything: Discord, Slack and the webhook keep
// consuming the house-format text unchanged. The link grammar is shared with
// the Slack renderer through renderHouseLinks() so the two transports can
// never disagree on what a house link is.
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
// `[label](url)` — the url may contain ONE level of balanced parentheses
// (Wikipedia-style `/Foo_(bar)`, tracker links `/issue?x=(y)`), so the link
// ends at the first `)` that does not close a `(` opened inside the url. A
// `)` after the link (`(see [x](url))`) therefore stays text.
const kHouseLinkPattern = /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
const kHttpUrlPattern = /^https?:\/\//i;
const kBoldMarker = "*";
const kTagPattern = /<(\/?)([a-z]+)((?:\s[^<>]*)?)>/g;
const kAnchorHrefPattern = /^\shref="[^"<>]*"$/;

const escapeTelegramHtml = (value) =>
  String(value ?? "").replace(/[&<>]/g, (ch) => kTelegramHtmlEscapes[ch]);

const escapeTelegramHtmlAttr = (value) =>
  String(value ?? "").replace(/[&<>"]/g, (ch) => kTelegramHtmlAttrEscapes[ch]);

// Walks the house links in `text`, handing every literal run to `text(run)`
// and every link to `link({ label, url, http, raw })` (`raw` = the authored
// `[label](url)` for renderers that leave non-http targets as written), and
// concatenates what they return. matchAll() clones the shared global regex,
// so concurrent callers never share lastIndex state.
const renderHouseLinks = (input, { text, link }) => {
  const source = String(input ?? "");
  let out = "";
  let cursor = 0;
  for (const match of source.matchAll(kHouseLinkPattern)) {
    out += text(source.slice(cursor, match.index));
    const [raw, label, url] = match;
    out += link({ label, url, http: kHttpUrlPattern.test(url), raw });
    cursor = match.index + raw.length;
  }
  return out + text(source.slice(cursor));
};

// Splits the raw text into alternating literal/code segments. Code spans win
// over every other construct: a `*` or `[` inside backticks is protected, and
// a link marker can never pair across a code span (a bold pair can — see
// renderBoldOverUnits).
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

const renderTelegramLink = ({ label, url, http }) =>
  http
    ? `<a href="${escapeTelegramHtmlAttr(url)}">${escapeTelegramHtml(label)}</a>`
    : escapeTelegramHtml(`${label} (${url})`);

// Links + escaped literals. Used for plain runs AND for the inside of a bold
// span, so `*see [logs](url)*` nests as <b><a>…</a></b>.
const renderLinksAndText = (text) =>
  renderHouseLinks(text, { text: escapeTelegramHtml, link: renderTelegramLink });

// The bold pass works on "units": one string per code point of literal text
// (so an emoji is never split) and the code segment object itself for a code
// span. A code unit is opaque — never a `*`, never a newline — which is
// exactly what lets `*Backup failed - `SQLite lock` (attempt 1)*` pair its
// markers around the protected span.
const flattenToUnits = (segments) => {
  const units = [];
  for (const segment of segments) {
    if (segment.kind === "code") {
      units.push(segment);
      continue;
    }
    for (const ch of segment.value) units.push(ch);
  }
  return units;
};

const renderCodeSpan = (segment) => `<code>${escapeTelegramHtml(segment.value)}</code>`;

// Literal runs (with their links) and code spans, no bold handling.
const renderUnits = (units) => {
  let out = "";
  let run = "";
  for (const unit of units) {
    if (typeof unit === "string") {
      run += unit;
      continue;
    }
    out += renderLinksAndText(run) + renderCodeSpan(unit);
    run = "";
  }
  return out + renderLinksAndText(run);
};

// Same grammar as the former /\*([^*\n]+)\*/ regex, applied across code
// units: the closing `*` must be on the same line as the opener and the
// span must be non-empty. Returns the closing index or -1 (opener stays
// literal, scanning resumes at the next unit — so `**b*` renders `*<b>b</b>`
// and `*a*b*` renders `<b>a</b>b*`, as before).
const findBoldClose = (units, open) => {
  for (let i = open + 1; i < units.length; i += 1) {
    const unit = units[i];
    if (unit === "\n") return -1;
    if (unit === kBoldMarker) return i > open + 1 ? i : -1;
  }
  return -1;
};

const renderBoldOverUnits = (units) => {
  let out = "";
  let cursor = 0;
  for (let i = 0; i < units.length; i += 1) {
    if (units[i] !== kBoldMarker) continue;
    const close = findBoldClose(units, i);
    if (close < 0) continue;
    out += renderUnits(units.slice(cursor, i));
    out += `<b>${renderUnits(units.slice(i + 1, close))}</b>`;
    cursor = close + 1;
    i = close;
  }
  return out + renderUnits(units.slice(cursor));
};

// Stack-based well-formedness check over the EMITTED markup: only b/code/a
// tags, every open tag closed in order (so <b>…<code>…</code>…</b> passes
// and <b><code>…</b></code> fails), <a> carries exactly one href, and no
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
  const html = renderBoldOverUnits(flattenToUnits(tokenizeCodeSpans(plain)));
  return validate(html) ? { html, plain } : { html: null, plain };
};

module.exports = {
  kHouseLinkPattern,
  renderHouseLinks,
  renderTelegramHtml,
  escapeTelegramHtml,
  validateTelegramHtml,
};
