// Terminal JSON error middleware: wrapAsync'd handlers forward rejections to
// next(err); without this, Express's default handler answers API clients
// with an HTML 500 page.
const { isDiskFullError, kPublicDiskFullMessage } = require("./disk-full");

// body-parser puts the raw body on these errors (err.body), and Node's
// JSON.parse message quotes the start of it, so a malformed or oversized
// PATCH /api/env body would print the value it carried. Only the type, method
// and path are logged, and the client gets a fixed sentence.
const kBodyErrorMessages = {
  "entity.parse.failed": "The request body is not valid JSON.",
  "entity.too.large": "The request body is too large.",
};

const createTerminalErrorHandler = ({ diskFullNotice = null, logger = console } = {}) =>
  // eslint-disable-next-line no-unused-vars
  (err, req, res, next) => {
    const bodyErrorMessage = kBodyErrorMessages[err?.type];
    if (bodyErrorMessage) {
      logger.error(`[alphaclaw] Request body rejected on ${req.method} ${req.path}: ${err.type}`);
      if (res.headersSent) return;
      return res.status(Number(err.status || err.statusCode) || 400).json({ ok: false, error: bodyErrorMessage });
    }
    logger.error(`[alphaclaw] Request error on ${req.method} ${req.path}: ${err?.stack || err}`);
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {}
      return;
    }
    // A write refused for space: the login page says so (and only that), and
    // a page navigation lands there instead of on a bare 500.
    if (isDiskFullError(err)) {
      diskFullNotice?.noteError();
      if (req.method === "GET" && !req.path.startsWith("/api") && req.accepts(["html", "json"]) === "html") {
        return res.redirect(303, "/login.html");
      }
      return res.status(503).json({ ok: false, code: "disk_full", error: kPublicDiskFullMessage });
    }
    const status = Number(err?.status || err?.statusCode) || 500;
    // 5xx messages can embed internals (fs errors carry absolute paths) and
    // this middleware fronts unauthenticated routes — clients get a generic
    // body; the logger above keeps the detail in the server log.
    const message =
      status >= 500 ? "Internal server error" : err?.message || "Request failed";
    res.status(status).json({ ok: false, error: message });
  };

module.exports = { createTerminalErrorHandler };
