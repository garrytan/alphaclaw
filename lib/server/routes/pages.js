const path = require("path");
const { wrapAsync } = require("../utils/wrap-async");

const registerPageRoutes = ({
  app,
  requireAuth,
  isGatewayRunning,
  isOnboarded = () => true,
  getWatchdogStatus = () => null,
}) => {
  // /health ALWAYS returns 200 while this process can serve requests: the
  // platform healthcheck restarting the whole container cannot heal a wedged
  // gateway (that's the watchdog's job) and would re-pay minutes of boot cost.
  // Gateway state is reported in the body (three-state), kept deliberately
  // coarse — no version strings on an unauthenticated endpoint.
  const buildHealthBody = async () => {
    const running = await isGatewayRunning();
    if (running) {
      return { status: "healthy", gateway: "running" };
    }
    if (!isOnboarded()) {
      return { status: "starting", gateway: "starting" };
    }
    const watchdogStatus = (() => {
      try {
        return getWatchdogStatus() || null;
      } catch {
        return null;
      }
    })();
    return {
      status: "degraded",
      gateway: "down",
      gatewayDownSince: watchdogStatus?.degradedSince || null,
    };
  };

  app.get(
    "/health",
    wrapAsync(async (req, res) => {
      res.json(await buildHealthBody());
    }),
  );

  // Opt-in strict readiness for operators who WANT the platform to restart on
  // gateway degradation: point the platform healthcheck here instead. Not the
  // default — see /health above for the trade-off.
  app.get(
    "/health/ready",
    wrapAsync(async (req, res) => {
      const body = await buildHealthBody();
      res.status(body.status === "healthy" ? 200 : 503).json(body);
    }),
  );

  app.get("/", requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, "..", "..", "public", "setup.html"));
  });

  app.get("/setup", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "..", "public", "setup.html"));
  });
};

module.exports = { registerPageRoutes };
