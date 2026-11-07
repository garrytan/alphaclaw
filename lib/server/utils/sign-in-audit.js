const { sanitizeLabel } = require("./sanitize-label");

// One line per sign-in outcome on the pre-auth routes (login, accept-invite),
// in the [input]/[origin] audit style. It names the outcome, the route, the
// limiter's client address, what kind of sign-in it was (owner, member or
// invitee) and the lane that counted it (shared, device or recovery). It
// never carries the password, the recovery code, the known-browser pass or
// the email.
const logSignInAttempt = ({ req, ip, actor, outcome, lane }) => {
  const route = `${String(req?.method || "").toUpperCase()} ${String(req?.path || req?.url || "")}`;
  const line = `[auth] sign-in ${outcome} route=${sanitizeLabel(route, { maxLength: 96 })} ip=${JSON.stringify(
    sanitizeLabel(ip, { maxLength: 64 }),
  )} actor=${actor} lane=${lane}`;
  if (outcome === "ok") console.log(line);
  else console.warn(line);
};

module.exports = { logSignInAttempt };
