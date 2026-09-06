const { wrapAsync } = require("../utils/wrap-async");
// Buzz channel wizard routes (5.2). Admin-only: the flow installs an external
// plugin and mutates gateway config. The 4.6 member matrix already denies
// members every POST here; requireAdmin makes it explicit.
const registerBuzzRoutes = ({ app, requireAdmin, buzzSetup }) => {
  app.get("/api/channels/buzz/setup", requireAdmin, (req, res) => {
    res.json({ ok: true, state: buzzSetup.getState() });
  });

  app.post("/api/channels/buzz/setup/install", requireAdmin, wrapAsync(async (req, res) => {
    const result = await buzzSetup.install();
    res.status(result.ok ? 200 : 502).json({
      ...result,
      state: buzzSetup.getState(),
    });
  }));

  app.post("/api/channels/buzz/setup/configure", requireAdmin, (req, res) => {
    const result = buzzSetup.configure(req.body || {});
    res.status(result.ok ? 200 : 400).json({
      ...result,
      state: buzzSetup.getState(),
    });
  });

  app.post("/api/channels/buzz/setup/probe", requireAdmin, wrapAsync(async (req, res) => {
    const result = await buzzSetup.probe();
    res.json({ ...result, state: buzzSetup.getState() });
  }));

  app.post("/api/channels/buzz/setup/rooms", requireAdmin, (req, res) => {
    const result = buzzSetup.rooms(req.body || {});
    res.status(result.ok ? 200 : 400).json({
      ...result,
      state: buzzSetup.getState(),
    });
  });

  app.post("/api/channels/buzz/setup/cancel", requireAdmin, (req, res) => {
    const result = buzzSetup.cancel();
    res.json({ ...result, state: buzzSetup.getState() });
  });
};

module.exports = { registerBuzzRoutes };
