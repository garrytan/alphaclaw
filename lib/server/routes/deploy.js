const { wrapAsync } = require("../utils/wrap-async");

// Deploy announcements. POST /api/deploy/announce tells the owner channel and
// every sidecar's announce command that AlphaClaw restarts in N seconds, with
// an ETA (the caller's, or the median measured downtime). GET
// /api/deploy/status returns the pending announcement, the last shutdown and
// the measured downtimes.
const kMaxInSeconds = 3600;
const kMaxEtaSeconds = 7200;
const kMaxReasonChars = 200;

const isIntegerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

const registerDeployRoutes = ({ app, requireAuth, deployAnnouncer }) => {
  app.get("/api/deploy/status", requireAuth, (req, res) => {
    res.json({ ok: true, ...deployAnnouncer.getStatus() });
  });

  app.post(
    "/api/deploy/announce",
    requireAuth,
    wrapAsync(async (req, res) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (!isIntegerIn(body.inSeconds, 0, kMaxInSeconds)) {
        return res.status(400).json({ ok: false, error: "invalid_in_seconds", message: `inSeconds must be an integer from 0 to ${kMaxInSeconds}.` });
      }
      if (body.etaSeconds !== undefined && body.etaSeconds !== null && !isIntegerIn(body.etaSeconds, 1, kMaxEtaSeconds)) {
        return res.status(400).json({ ok: false, error: "invalid_eta_seconds", message: `etaSeconds must be an integer from 1 to ${kMaxEtaSeconds}.` });
      }
      if (body.reason !== undefined && typeof body.reason !== "string") {
        return res.status(400).json({ ok: false, error: "invalid_reason", message: "reason must be a string." });
      }
      const reason = String(body.reason || "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, kMaxReasonChars);
      const result = await deployAnnouncer.announce({
        inSeconds: body.inSeconds,
        etaSeconds: body.etaSeconds ?? null,
        reason,
        source: req.alphaclawActor?.type === "agent" ? "agent" : "api",
      });
      if (!result.ok) {
        res.set("Retry-After", String(result.retryAfterSeconds));
        return res.status(429).json(result);
      }
      return res.json(result);
    }),
  );
};

module.exports = { registerDeployRoutes };
