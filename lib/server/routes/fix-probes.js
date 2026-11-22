const { wrapAsync } = require("../utils/wrap-async");

// Fix probes API (GST-3436). Both are readable and runnable by the agent
// (admin manifest): a run only reads, and its one side effect is an owner
// alert when a probe changes state. Probes are configured by editing
// alphaclaw.json fixProbes, never through the API. Results carry names,
// issue codes, states, codes and counts, never a configured substring,
// marker or path.
const registerFixProbeRoutes = ({ app, requireAuth, fixProbes }) => {
  app.get("/api/fix-probes", requireAuth, (req, res) => {
    res.json(fixProbes.getStatus());
  });

  app.post(
    "/api/fix-probes/run",
    requireAuth,
    wrapAsync(async (req, res) => {
      const outcome = await fixProbes.runNow();
      if (outcome.retryAfterSeconds) res.set("Retry-After", String(outcome.retryAfterSeconds));
      res.status(outcome.status).json(outcome.body);
    }),
  );
};

module.exports = { registerFixProbeRoutes };
