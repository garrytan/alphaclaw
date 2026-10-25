// Terminal JSON error middleware: wrapAsync'd handlers forward rejections to
// next(err); without this, Express's default handler answers API clients
// with an HTML 500 page.
const { isDiskFullError, kPublicDiskFullMessage } = require("./disk-full");

const createTerminalErrorHandler = ({ diskFullNotice = null, logger = console } = {}) =>
  // eslint-disable-next-line no-unused-vars
  (err, req, res, next) => {
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
