// OAuth popup callbacks send an HTML page that postMessages back to the opener.
// Reflected values (error strings, account id, email) must be encoded for the
// exact sink they land in, or a `</script>` / `<img onerror>` payload runs in
// the AlphaClaw origin (H7).

// JS string literal for use inside an inline <script>. JSON.stringify handles
// quotes/backslashes/newlines; escaping < > (and the U+2028/2029 line
// separators) prevents a `</script>` breakout and JS-parser line breaks. The
// return value INCLUDES its surrounding quotes — drop the manual '...'.
const jsStringLiteral = (value) =>
  JSON.stringify(String(value ?? ""))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

// HTML text-node escaping for values interpolated into page body markup.
const htmlText = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

module.exports = { jsStringLiteral, htmlText };
