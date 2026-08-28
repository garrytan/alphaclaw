const compression = require("compression");

// Compression buffers response writes, which would hold SSE frames hostage
// until the buffer fills — event streams must bypass it entirely. Everything
// else defers to compression's own content-type heuristics.
const shouldCompress = (req, res) => {
  if (String(req.headers?.accept || "").includes("text/event-stream")) {
    return false;
  }
  const contentType = String(res.getHeader("Content-Type") || "");
  if (contentType.includes("text/event-stream")) return false;
  return compression.filter(req, res);
};

module.exports = { shouldCompress };
