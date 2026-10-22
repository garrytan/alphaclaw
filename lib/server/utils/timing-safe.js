const crypto = require("crypto");

// The one constant-time comparator for secrets: tokens, passwords, session
// signatures, capability links, cookie markers, scrypt/sha256 digests. Both
// sides are hashed to fixed-length sha256 digests before timingSafeEqual, so
// neither the comparison time nor the length of the expected value leaks (a
// length short-circuit tells a prober how long the secret is), and unequal
// lengths never throw. Only non-empty strings can match: an unset expected
// secret ("" or undefined) never authorizes, and a coerced non-string (an
// array query param, a number) is refused instead of stringified.
// tests/server/guards/secret-compare.guard.test.js keeps raw ===/!== on
// secret-named values and direct crypto.timingSafeEqual calls out of lib/.
const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest();

const timingSafeStringEqual = (presented, expected) => {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (!presented || !expected) return false;
  return crypto.timingSafeEqual(sha256(presented), sha256(expected));
};

module.exports = { timingSafeStringEqual };
