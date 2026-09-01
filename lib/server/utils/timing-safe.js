const crypto = require("crypto");

// Hash both sides before timingSafeEqual: it throws on length mismatch, and
// digest comparison also avoids leaking the stored value's length. Canonical
// semantic copied from routes/auth.js — the repo's other comparison sites
// (routes/auth.js:93, routes/proxy.js, db/auth/members.js, gmail-push.js)
// migrate onto this util in a follow-up (TODOS.md), not here.
const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value)).digest();

const timingSafeStringEqual = (a, b) =>
  crypto.timingSafeEqual(sha256(a), sha256(b));

module.exports = { timingSafeStringEqual };
