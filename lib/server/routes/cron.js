const { parsePositiveInt } = require("../utils/number");
const { readClientTimeZone, resolveTimeZone } = require("../utils/time-zone");
const { sendIfStateDbQuietError } = require("../utils/state-db-quiet-http");

// Dedupe the invalid-timezone debug line per distinct value: persistent
// browser/server tzdb skew (a newer IANA id the server's ICU can't resolve)
// would otherwise write a line per trends poll for the install's lifetime.
// At the cap we STOP logging entirely (not clear-and-restart — an
// authenticated client cycling unique junk could otherwise re-log forever)
// and say so once; ~600 canonical zones exist, so a legitimate install can
// never reach the cap.
const kLoggedInvalidTimeZones = new Set();
const kLoggedInvalidTimeZonesMax = 1000;
let loggedInvalidTimeZoneSuppression = false;

const registerCronRoutes = ({
  app,
  requireAuth,
  cronService,
}) => {
  app.get("/api/cron/jobs", requireAuth, (req, res) => {
    try {
      const sortBy = String(req.query.sortBy || "nextRunAtMs").trim();
      const sortDir = String(req.query.sortDir || "asc").trim();
      const result = cronService.listJobs({ sortBy, sortDir });
      res.json({
        ok: true,
        storePath: result.storePath,
        jobs: result.jobs,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/status", requireAuth, (req, res) => {
    try {
      const status = cronService.getStatus();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/jobs/:id/runs", requireAuth, (req, res) => {
    try {
      const runs = cronService.getJobRuns({
        jobId: req.params.id,
        limit: parsePositiveInt(req.query.limit, 20),
        offset: Math.max(0, Number.parseInt(String(req.query.offset || "0"), 10) || 0),
        status: String(req.query.status || "all"),
        deliveryStatus: String(req.query.deliveryStatus || "all"),
        sortDir: String(req.query.sortDir || "desc"),
        query: String(req.query.query || ""),
      });
      res.json({
        ok: true,
        runs: {
          entries: runs.entries,
          total: runs.total,
          offset: runs.offset,
          limit: runs.limit,
          hasMore: runs.hasMore,
          nextOffset: runs.nextOffset,
        },
      });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/cron/jobs/:id/run", requireAuth, async (req, res) => {
    try {
      const result = await cronService.runJobNow(req.params.id);
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/cron/jobs/:id/enable", requireAuth, async (req, res) => {
    try {
      const result = await cronService.setJobEnabled({
        jobId: req.params.id,
        enabled: true,
      });
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/cron/jobs/:id/disable", requireAuth, async (req, res) => {
    try {
      const result = await cronService.setJobEnabled({
        jobId: req.params.id,
        enabled: false,
      });
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.put("/api/cron/jobs/:id/prompt", requireAuth, async (req, res) => {
    try {
      const message = String(req.body?.message || "");
      const result = await cronService.updateJobPrompt({
        jobId: req.params.id,
        message,
      });
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.put("/api/cron/jobs/:id/routing", requireAuth, async (req, res) => {
    try {
      const sessionTarget = String(req.body?.sessionTarget || "").trim();
      const wakeMode = String(req.body?.wakeMode || "").trim();
      const deliveryMode = String(req.body?.deliveryMode || "").trim();
      const deliveryChannel = String(req.body?.deliveryChannel || "").trim();
      const deliveryTo = String(req.body?.deliveryTo || "").trim();
      const result = await cronService.updateJobRouting({
        jobId: req.params.id,
        sessionTarget,
        wakeMode,
        deliveryMode,
        deliveryChannel,
        deliveryTo,
      });
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/jobs/:id/usage", requireAuth, (req, res) => {
    try {
      const days = parsePositiveInt(req.query.days, 0);
      const sinceMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
      const usage = cronService.getJobUsage({
        jobId: req.params.id,
        sinceMs,
      });
      res.json({ ok: true, usage });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });
  app.get("/api/cron/jobs/:id/trends", requireAuth, (req, res) => {
    try {
      const rawTimeZone = readClientTimeZone(req);
      const timeZone = rawTimeZone ? resolveTimeZone(rawTimeZone) : null;
      if (rawTimeZone && !timeZone) {
        // A missing header stays silent (normal for curl/older clients); an
        // unresolvable one gets a single debug line PER DISTINCT VALUE before
        // the legacy path. The ?timeZone= query fallback can carry URL-decoded
        // control chars (%0A/%1b) — strip non-printables so a client can't
        // forge log lines.
        const sanitized = rawTimeZone.slice(0, 64).replace(/[^\x20-\x7E]/g, "?");
        if (!kLoggedInvalidTimeZones.has(sanitized)) {
          if (kLoggedInvalidTimeZones.size >= kLoggedInvalidTimeZonesMax) {
            if (!loggedInvalidTimeZoneSuppression) {
              loggedInvalidTimeZoneSuppression = true;
              console.log(
                "[alphaclaw] further invalid x-client-timezone reports suppressed",
              );
            }
          } else {
            kLoggedInvalidTimeZones.add(sanitized);
            console.log(
              "[alphaclaw] invalid x-client-timezone %s — using server-local buckets",
              sanitized,
            );
          }
        }
      }
      const trends = cronService.getJobRunTrends({
        jobId: req.params.id,
        range: String(req.query.range || "7d"),
        timeZone,
      });
      // Echo the EFFECTIVE zone (null = legacy server-local buckets), mirroring
      // the usage summary payload. The body varies by the client's timezone
      // header, so say so to any HTTP cache in the path.
      res.set("Vary", "x-client-timezone");
      res.json({ ok: true, trends, timeZone });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/usage/bulk", requireAuth, (req, res) => {
    try {
      const days = parsePositiveInt(req.query.days, 0);
      const sinceMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
      const usage = cronService.getBulkJobUsage({ sinceMs });
      res.json({ ok: true, usage });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/runs/bulk", requireAuth, (req, res) => {
    try {
      const sinceMs = Math.max(0, Number.parseInt(String(req.query.sinceMs || "0"), 10) || 0);
      const limitPerJob = parsePositiveInt(req.query.limitPerJob, 20);
      const runs = cronService.getBulkJobRuns({
        sinceMs,
        limitPerJob,
        status: String(req.query.status || "all"),
        deliveryStatus: String(req.query.deliveryStatus || "all"),
        sortDir: String(req.query.sortDir || "desc"),
      });
      res.json({ ok: true, runs });
    } catch (error) {
      if (sendIfStateDbQuietError(res, error)) return;
      res.status(400).json({ ok: false, error: error.message });
    }
  });
};

module.exports = { registerCronRoutes };
