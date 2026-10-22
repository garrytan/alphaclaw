const { wrapAsync } = require("../utils/wrap-async");

// Capability probes for the installed OpenClaw (feature-detect, never version-gate).
// Lazy: the probes run on first demand here — never on the 2s status-SSE tick — and
// serve cached results afterward. Consumers: Envars secrets banner, channel gating,
// the Team upsell.
const registerOpenclawCapabilitiesRoutes = ({ app, openclawCapabilities }) => {
  app.get("/api/openclaw/capabilities", wrapAsync(async (req, res) => {
    try {
      res.json({ ok: true, capabilities: await openclawCapabilities.getAll() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || "capability probe failed" });
    }
  }));
};

module.exports = { registerOpenclawCapabilitiesRoutes };
