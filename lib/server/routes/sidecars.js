const { wrapAsync } = require("../utils/wrap-async");

// Operator sidecars API. GET is readable by the agent (admin manifest tier
// safe; env values are never returned, only their names). Start, stop and
// restart are humans only (tier denied for the agent actor). The registry
// itself is edited only in the deployment environment (ALPHACLAW_SIDECARS).
const kNamePattern = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const kActions = Object.freeze(["start", "stop", "restart"]);

const registerSidecarRoutes = ({ app, requireAuth, sidecarService }) => {
  app.get("/api/sidecars", requireAuth, (req, res) => {
    res.json({ ok: true, ...sidecarService.getStatus() });
  });

  app.post(
    "/api/sidecars/:name/:action",
    requireAuth,
    wrapAsync(async (req, res) => {
      const { name, action } = req.params;
      if (!kActions.includes(action)) {
        return res.status(404).json({ ok: false, error: "route_not_found" });
      }
      if (!kNamePattern.test(String(name || ""))) {
        return res.status(400).json({ ok: false, error: "invalid_sidecar_name" });
      }
      const supervisor = sidecarService.find(name);
      if (!supervisor) {
        return res.status(404).json({ ok: false, error: "sidecar_not_found", message: `No sidecar named ${name} is registered.` });
      }
      if (!supervisor.entry.enabled) {
        return res.status(409).json({ ok: false, error: "sidecar_disabled", message: `Sidecar ${name} is disabled in the registry.` });
      }
      if (action === "start") supervisor.start();
      else if (action === "stop") await supervisor.stop({ reason: "stopped from the API" });
      else await supervisor.restart();
      console.log(`[sidecar] ${name}: ${action} requested from the API`);
      return res.json({ ok: true, sidecar: { name, ...supervisor.getStatus() } });
    }),
  );
};

module.exports = { registerSidecarRoutes };
