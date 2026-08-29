const { getSystemResources, startLoopLagMonitor } = require("../system-resources");
const { kTailAbsoluteMaxBytes } = require("../utils/tail-bytes");

const registerWatchdogRoutes = ({
  app,
  requireAuth,
  watchdog,
  watchdogNotifier,
  getRecentEvents,
  readLogTail,
  watchdogTerminal,
  getRejectionStats = () => ({ total: 0, inWindow: 0 }),
  // Persisted incident queries (lib/server/db/watchdog). Optional so legacy
  // callers/tests that don't care about incidents keep working unchanged.
  incidentsDb = null,
}) => {
  // Start sampling event-loop lag when the server wires its routes (not at
  // require time — an import-time side effect would leave every test that
  // touches this module with an untearable histogram interval), so the
  // sustained-lag warning works even before anyone opens the Watchdog tab.
  startLoopLagMonitor();

  app.get("/api/watchdog/status", requireAuth, (req, res) => {
    try {
      const status = watchdog.getStatus();
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/watchdog/events", requireAuth, (req, res) => {
    try {
      const limit = Number.parseInt(String(req.query.limit || "20"), 10) || 20;
      const includeRoutine =
        String(req.query.includeRoutine || "").trim() === "1" ||
        String(req.query.includeRoutine || "").trim().toLowerCase() === "true";
      const events = getRecentEvents({ limit, includeRoutine });
      res.json({ ok: true, events });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Persisted incident history (grouped view; the flat /events feed above
  // stays byte-compatible for the "All events" tab).
  app.get("/api/watchdog/incidents", requireAuth, (req, res) => {
    try {
      if (!incidentsDb?.listIncidents) {
        res.status(503).json({ ok: false, error: "incidents_unavailable" });
        return;
      }
      const rawBefore = String(req.query.before ?? "").trim();
      let before = null;
      if (rawBefore) {
        before = Number.parseInt(rawBefore, 10);
        if (!Number.isInteger(before) || before <= 0 || String(before) !== rawBefore) {
          res.status(400).json({ ok: false, error: "invalid_before" });
          return;
        }
      }
      // limit is clamped to [1, 50] (default 10) inside listIncidents.
      const incidents = incidentsDb.listIncidents({
        limit: req.query.limit,
        before,
      });
      res.json({ ok: true, incidents });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/watchdog/incidents/:id", requireAuth, (req, res) => {
    try {
      if (!incidentsDb?.getIncidentById) {
        res.status(503).json({ ok: false, error: "incidents_unavailable" });
        return;
      }
      const rawId = String(req.params.id || "").trim();
      const incidentId = Number.parseInt(rawId, 10);
      if (!Number.isInteger(incidentId) || incidentId <= 0 || String(incidentId) !== rawId) {
        res.status(400).json({ ok: false, error: "invalid_id" });
        return;
      }
      const incident = incidentsDb.getIncidentById(incidentId);
      if (!incident) {
        res.status(404).json({ ok: false, error: "incident_not_found" });
        return;
      }
      // First 200 chronologically (the trigger story) + an honest marker for
      // anything omitted; the rollup carries the outcome.
      const { events, totalCount } = incidentsDb.getIncidentEvents(incidentId);
      res.json({
        ok: true,
        incident,
        events,
        totalCount,
        truncated: totalCount > events.length,
        omittedCount: Math.max(0, totalCount - events.length),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/watchdog/logs", requireAuth, (req, res) => {
    try {
      // Clamp: an arbitrary ?tail can no longer force an unbounded read.
      // Same ceiling tailBytes enforces internally — shared constant so the
      // two clamps can't drift.
      const parsedTail = Number.parseInt(String(req.query.tail || "65536"), 10) || 65536;
      const tail = Math.min(kTailAbsoluteMaxBytes, Math.max(1024, parsedTail));
      const logs = readLogTail(tail);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.status(200).send(logs);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/watchdog/repair", requireAuth, async (req, res) => {
    try {
      const result = await watchdog.triggerRepair();
      res.json({ ok: !!result?.ok, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/watchdog/resume-channels", requireAuth, async (req, res) => {
    try {
      const result = await watchdog.resumeChannels();
      if (result?.skipped) {
        res.status(409).json({ ok: false, error: result.reason, result });
        return;
      }
      res.json({ ok: !!result?.ok, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/watchdog/settings", requireAuth, (req, res) => {
    try {
      res.json({ ok: true, settings: watchdog.getSettings() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/watchdog/resources", requireAuth, (req, res) => {
    try {
      const status = watchdog.getStatus();
      res.json({
        ok: true,
        resources: {
          ...getSystemResources({ gatewayPid: status.gatewayPid }),
          // Crash-guard telemetry: unhandled-rejection pressure toward the
          // storm brake (>=50 in 5min triggers a bounded graceful restart).
          unhandledRejections: getRejectionStats(),
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put("/api/watchdog/settings", requireAuth, (req, res) => {
    try {
      const settings = watchdog.updateSettings(req.body || {});
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/watchdog/test-notification", requireAuth, async (req, res) => {
    try {
      if (!watchdogNotifier?.notify) {
        return res.status(503).json({ ok: false, error: "Notifier not available" });
      }
      const result = await watchdogNotifier.notify(
        "*AlphaClaw test notification* — your watchdog alerts are working.",
      );
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/watchdog/terminal/session", requireAuth, (req, res) => {
    try {
      const terminalSession = watchdogTerminal.createOrReuseSession();
      res.json({ ok: true, session: terminalSession });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/watchdog/terminal/output", requireAuth, (req, res) => {
    try {
      const sessionId = String(req.query.sessionId || "");
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId" });
        return;
      }
      const cursor = Number.parseInt(String(req.query.cursor || "0"), 10) || 0;
      const output = watchdogTerminal.readOutput({ sessionId, cursor });
      if (!output.found) {
        res.status(404).json({ ok: false, error: "Terminal session not found" });
        return;
      }
      res.json({ ok: true, ...output });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/watchdog/terminal/input", requireAuth, (req, res) => {
    try {
      const sessionId = String(req.body?.sessionId || "");
      const input = String(req.body?.input || "");
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId" });
        return;
      }
      const result = watchdogTerminal.writeInput({ sessionId, input });
      if (!result.ok) {
        res.status(400).json({ ok: false, error: result.error || "Write failed" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/watchdog/terminal/close", requireAuth, (req, res) => {
    try {
      const sessionId = String(req.body?.sessionId || "");
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId" });
        return;
      }
      watchdogTerminal.closeSession({ sessionId });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerWatchdogRoutes };
