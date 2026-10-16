const path = require("path");
const { wrapAsync } = require("../utils/wrap-async");
const {
  projectBootProgressPublic,
  projectHealthBoot,
} = require("../boot-progress/projections");

const registerPageRoutes = ({
  app,
  requireAuth,
  isGatewayRunning,
  isOnboarded = () => true,
  getWatchdogStatus = () => null,
  getBootSnapshot = () => require("../boot-progress").getBootSnapshot(),
  getBootPhase = () => require("../boot-phase").getBootPhase(),
}) => {
  const readBootSnapshot = () => {
    try {
      return getBootSnapshot() || null;
    } catch {
      return null;
    }
  };
  // While the boot sequence still runs, /health names the stage (ids and a
  // timestamp only) without changing any status code.
  const withBootField = (body) => {
    let phase = "ready";
    try {
      phase = getBootPhase()?.phase || "ready";
    } catch {}
    if (phase === "ready") return body;
    const boot = projectHealthBoot(readBootSnapshot());
    return boot ? { ...body, boot } : body;
  };
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
      res.json(withBootField(await buildHealthBody()));
    }),
  );

  // Public boot progress (honest boot status, PR 3): mounted here beside
  // /health, ahead of requireAuth, because the reconnecting dashboard may
  // have no session and the boot placeholder answers the same path. A
  // non-/api route, so the agent-admin manifest (which governs /api only)
  // does not list it. The frame is built from a whitelist: identity, stage
  // ids/statuses/timestamps, the activity sequence, stalled/stuck verdicts
  // and the estimate — no versions, paths, Doctor or trace text, errors.
  app.get("/boot-progress.json", (req, res) => {
    res.set("Cache-Control", "no-store");
    const snapshot = readBootSnapshot();
    res.json(
      snapshot
        ? { ...projectBootProgressPublic(snapshot), source: "server" }
        : { v: 1, source: "server", bootId: null, kind: null, stage: null, stages: [], outcome: null, stuck: false, stalled: false },
    );
  });

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
