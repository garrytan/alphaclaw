const crypto = require("crypto");

// Hash both sides before timingSafeEqual: it throws on length mismatch, and
// digest comparison also avoids leaking the stored value's length. Canonical
// semantic taken from routes/auth.js `timingSafeTokenEqual` (~:424-429) —
// NOT from the two existing local functions that share this one's NAME
// (`timingSafeStringEqual` in routes/auth.js:~90 and routes/proxy.js:~47),
// which use the length-short-circuit variant and therefore leak length.
// All of those sites (plus the non-timing-safe `!==` in gmail-push.js)
// migrate onto this util in a follow-up (TODOS.md), not here.
const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value)).digest();

const timingSafeStringEqual = (a, b) =>
  crypto.timingSafeEqual(sha256(a), sha256(b));

module.exports = { timingSafeStringEqual };
