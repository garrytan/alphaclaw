const { getSystemResources, startLoopLagMonitor } = require("../system-resources");
const { kTailAbsoluteMaxBytes } = require("../utils/tail-bytes");
const logWriter = require("../log-writer");
const { isStateDbQuiet, StateDbQuietError } = require("../state-db-quiet");
const { sendIfStateDbQuietError } = require("../utils/state-db-quiet-http");

const kTestNotificationMessage =
  "*AlphaClaw test notification* — your watchdog alerts are working.";
const kTestNotificationNoChannels =
  "No notification channel delivered the test message — nothing is configured or paired.";

// Human-readable failure line for the 502 body (the UI toasts `error`);
// per-target evidence stays in `result.failures`.
const describeTestNotificationFailure = (result) => {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  if (failures.length === 0) return kTestNotificationNoChannels;
  const parts = failures.map(
    (failure) =>
      `${failure.channel}: ${failure.reason}${
        failure.errorCode != null ? ` (${failure.errorCode})` : ""
      }`,
  );
  return `Test notification failed on every channel — ${parts.join("; ")}`;
};

const {
  kWatchdogMemoryBounds,
  kDefaultAlphaclawConfig,
  normalizeMemoryBudgetMb,
  normalizeMemoryMaxRestartsPerDay,
} = require("../alphaclaw-config");

// PUT /api/watchdog/memory numeric fields (fast-leak profile, issue #56).
// Loud rejection here, on the SAME rule the storage layer normalizes with
// (whole numbers inside kWatchdogMemoryBounds); JSON bodies only carry
// numbers or null, so strings are rejected outright rather than coerced.
// budgetMb accepts null to clear (derived cap).
const parseMemoryBudgetMb = (value) => {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number") return { ok: false };
  const normalized = normalizeMemoryBudgetMb(value);
  return normalized === null ? { ok: false } : { ok: true, value: normalized };
};
const parseMemoryMaxRestartsPerDay = (value) => {
  if (typeof value !== "number") return { ok: false };
  const normalized = normalizeMemoryMaxRestartsPerDay(value);
  return normalized !== value ? { ok: false } : { ok: true, value };
};

const registerWatchdogRoutes = ({
  app,
  requireAuth,
  watchdog,
  watchdogNotifier,
  getRecentEvents,
  readLogTail,
  readLogDelta = logWriter.readLogDelta,
  watchdogTerminal,
  getRejectionStats = () => ({ total: 0, inWindow: 0 }),
  // Persisted incident queries (lib/server/db/watchdog). Optional so legacy
  // callers/tests that don't care about incidents keep working unchanged.
  incidentsDb = null,
  // Watchdog incident overseer (advisory LLM reviewer) + its config toggle.
  watchdogOverseer = null,
  readWatchdogOverseerEnabled = null,
  updateWatchdogOverseerEnabled = null,
  // Gateway memory monitor settings (alphaclaw.json watchdog.memory).
  readWatchdogMemorySettings = null,
  updateWatchdogMemorySettings = null,
}) => {
  // Start sampling event-loop lag when the server wires its routes (not at
  // require time — an import-time side effect would leave every test that
  // touches this module with an untearable histogram interval), so the
  // sustained-lag warning works even before anyone opens the Watchdog tab.
  startLoopLagMonitor();

  app.get("/api/watchdog/status", requireAuth, (req, res) => {
    try {
      const status = watchdog.getStatus();
      // Supervision detail: alerts are the operator's Discover surface, so
      // their liveness (last successful delivery) rides along with status.
      status.lastNotificationDeliveredAt =
        typeof watchdogNotifier?.getLastDeliveredAt === "function"
          ? watchdogNotifier.getLastDeliveredAt()
          : null;
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
        if (!Number.isSafeInteger(before) || before <= 0 || String(before) !== rawBefore) {
          res.status(400).json({ ok: false, error: "invalid_before" });
          return;
        }
      }
      // limit is clamped to [1, 50] (default 10) inside listIncidents.
      const incidents = incidentsDb.listIncidents({
        limit: req.query.limit,
        before,
      });
      // Honest next-page indicator: probe for one row older than this page so
      // clients don't have to mirror the server's clamp heuristically.
      let hasMore = false;
      if (incidents.length > 0) {
        hasMore =
          incidentsDb.listIncidents({
            limit: 1,
            before: incidents[incidents.length - 1].id,
          }).length > 0;
      }
      res.json({ ok: true, incidents, hasMore });
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
      if (!Number.isSafeInteger(incidentId) || incidentId <= 0 || String(incidentId) !== rawId) {
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

  // Human-readable companions to the machine codes: the UI toasts message
  // (codes alone read as jargon to operators).
  const kReviewRefusalMessages = {
    busy: "A review is already running — try again when it finishes.",
    rate_limited: "Manual reviews are limited to one every 2 minutes.",
    disabled: "Enable the incident overseer first.",
    incident_open:
      "That incident is still ongoing — use Review current situation for the live picture.",
    no_incident: "No incident with that id.",
    query_failed: "Could not read the incident records.",
    review_failed: "The review failed to run.",
    spawn_failed: "The claude call failed to run.",
    timed_out: "The review timed out waiting for claude.",
    persist_failed: "Report displayed but not saved (database write failed).",
    probe_failed: "Could not probe the claude CLI on this host.",
    redaction_sources_unreadable:
      "Could not read the secret-redaction sources; reviews are refused until they are readable.",
    cli_flags_unverifiable:
      "The installed claude CLI cannot verify tool restrictions; reviews are disabled.",
    no_anthropic_credential: "ANTHROPIC_API_KEY is not set.",
    claude_not_found: "The claude CLI is not installed on this host.",
    home_isolation_failed: "Could not create the isolated spawn environment.",
    incident_missing: "That incident no longer exists.",
    unchanged: "Nothing changed since the last review.",
  };
  // Partial-failure envelope for a review that ran but could not be saved.
  const kPersistFailedWarning = {
    code: "persist_failed",
    message: kReviewRefusalMessages.persist_failed,
  };

  // Advisory incident overseer: settings + availability, shaped like
  // GET/PUT /api/openclaw/overseer.
  app.get("/api/watchdog/overseer", requireAuth, async (req, res) => {
    try {
      if (!watchdogOverseer || typeof readWatchdogOverseerEnabled !== "function") {
        res.json({
          ok: true,
          enabled: false,
          availability: { available: false, reason: "not_wired" },
        });
        return;
      }
      // Non-blocking: a cold cache answers "probing" instead of holding the
      // response for the 10s claude --version spawn.
      const availability = await watchdogOverseer.getAvailability({
        nonBlocking: true,
      });
      res.json({ ok: true, enabled: readWatchdogOverseerEnabled(), availability });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put("/api/watchdog/overseer", requireAuth, (req, res) => {
    try {
      if (typeof updateWatchdogOverseerEnabled !== "function") {
        res.status(503).json({ ok: false, error: "not_wired" });
        return;
      }
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        res.status(400).json({ ok: false, error: "invalid_setting" });
        return;
      }
      updateWatchdogOverseerEnabled({ enabled });
      res.json({ ok: true, enabled });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Rate-limit refusals carry the moment the next manual review is allowed;
  // the message names the remaining wait instead of the abstract rule, and the
  // limit itself comes from the refusal (one source of truth in the overseer).
  const describeRateLimitRule = (rateLimitMs) =>
    `Manual reviews are limited to one every ${Math.round((Number(rateLimitMs) || 120_000) / 60_000)} minutes`;
  const describeRateLimit = ({ nextManualAt, rateLimitMs } = {}, nowMs = Date.now()) => {
    const remainingMs = Number.isFinite(nextManualAt) ? nextManualAt - nowMs : NaN;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return `${describeRateLimitRule(rateLimitMs)}.`;
    }
    const seconds = Math.ceil(remainingMs / 1000);
    const remaining =
      seconds >= 60 ? `${Math.max(1, Math.round(seconds / 60))}m` : `${seconds}s`;
    return `${describeRateLimitRule(rateLimitMs)} — try again in about ${remaining}.`;
  };

  // Latest situation report for the card's 15s poll. Reads through the
  // overseer's self-healing slot (a stale pending is rewritten on the way
  // out) and its ALLOWLISTED projection — never the raw db row.
  app.get("/api/watchdog/overseer/situation", requireAuth, (req, res) => {
    try {
      if (!watchdogOverseer || typeof watchdogOverseer.getSituation !== "function") {
        res.status(503).json({ ok: false, error: "not_wired" });
        return;
      }
      res.json({ ok: true, ...watchdogOverseer.getSituation() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Operator-initiated review in ANY watchdog state. No incidentId → a
  // situation report; an incidentId → the post-incident re-review of that
  // settled incident. Never bypasses availability, the enabled flag, or the
  // in-flight mutex; rate-limited server-side (1 per 2 minutes).
  app.post("/api/watchdog/overseer/review", requireAuth, async (req, res) => {
    try {
      if (!watchdogOverseer?.requestReview) {
        res.status(503).json({ ok: false, error: "not_wired" });
        return;
      }
      const rawId = req.body?.incidentId;
      let incidentId = null;
      if (rawId != null) {
        const rawText = String(rawId).trim();
        incidentId = Number.parseInt(rawText, 10);
        // Same strict round-trip as GET /incidents/:id — "12abc"/"3.7" must
        // not silently review a different incident than the client named.
        if (
          !Number.isSafeInteger(incidentId) ||
          incidentId <= 0 ||
          String(incidentId) !== rawText
        ) {
          res.status(400).json({ ok: false, error: "invalid_id" });
          return;
        }
      }
      const result = await watchdogOverseer.requestReview({ incidentId });
      if (!result.ok) {
        // Status codes match the error class: retry-later vs missing vs
        // missing-infrastructure vs bug.
        const kUnavailableCodes = new Set([
          "no_anthropic_credential",
          "claude_not_found",
          "home_isolation_failed",
          "probe_failed",
          "cli_flags_unverifiable",
          "redaction_sources_unreadable",
        ]);
        const status =
          result.code === "no_incident" || result.code === "incident_missing"
            ? 404
            : result.code === "rate_limited"
              ? 429
              : result.code === "query_failed" || result.code === "review_failed"
                ? 500
                // Upstream (claude) failures are not server bugs: 5xx alerting
                // and the admin CLI should tell them apart.
                : result.code === "timed_out"
                  ? 504
                  : result.code === "spawn_failed"
                    ? 502
                    : kUnavailableCodes.has(result.code)
                      ? 503
                      : 409;
        if (result.code === "rate_limited") {
          const retryAfterSec = Math.max(
            1,
            Math.ceil(((Number(result.nextManualAt) || Date.now()) - Date.now()) / 1000),
          );
          res.set("Retry-After", String(retryAfterSec));
        }
        res.status(status).json({
          ok: false,
          error: result.code,
          message:
            result.code === "rate_limited"
              ? describeRateLimit(result)
              : kReviewRefusalMessages[result.code] || "Review refused.",
          result,
          // A run that failed AND could not record its failure is worth saying.
          ...(result.persisted === false ? { warning: kPersistFailedWarning } : {}),
        });
        return;
      }
      // A report that ran but could not be saved is still a report: 200 with
      // the record plus a `warning` envelope (never `error` — the admin CLI
      // treats `error` as failure) that the card renders as a warning line.
      res.json({
        ok: true,
        result,
        ...(result.persisted === false ? { warning: kPersistFailedWarning } : {}),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/watchdog/logs", requireAuth, (req, res) => {
    try {
      const since = String(req.query.since || "").trim();
      if (since) {
        // Delta cursor "<gen>:<offset>"; anything malformed lands on the
        // invalid-cursor path inside readLogDelta and gets reset + fresh tail.
        const match = /^(\d+):(\d+)$/.exec(since);
        const delta = readLogDelta({
          gen: match ? Number.parseInt(match[1], 10) : -1,
          offset: match ? Number.parseInt(match[2], 10) : 0,
        });
        res.json({ ok: true, ...delta });
        return;
      }
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

  // Memory monitor settings (alphaclaw.json watchdog.memory) — shaped like
  // the overseer toggle pair. Strict booleans, per-field narrow: a stale
  // local copy of one toggle must never write the other back.
  app.get("/api/watchdog/memory", requireAuth, (req, res) => {
    try {
      if (typeof readWatchdogMemorySettings !== "function") {
        res.json({
          ok: true,
          settings: {
            enabled: false,
            autoRestart: false,
            effectiveAutoRestart: false,
            budgetMb: kDefaultAlphaclawConfig.watchdog.memory.budgetMb,
            maxRestartsPerDay:
              kDefaultAlphaclawConfig.watchdog.memory.maxRestartsPerDay,
          },
          bounds: kWatchdogMemoryBounds,
          wired: false,
        });
        return;
      }
      res.json({
        ok: true,
        settings: readWatchdogMemorySettings(),
        bounds: kWatchdogMemoryBounds,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put("/api/watchdog/memory", requireAuth, (req, res) => {
    try {
      if (typeof updateWatchdogMemorySettings !== "function") {
        res.status(503).json({ ok: false, error: "not_wired" });
        return;
      }
      const body = req.body || {};
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
        if (typeof body.enabled !== "boolean") {
          res.status(400).json({ ok: false, error: "invalid_setting" });
          return;
        }
        patch.enabled = body.enabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, "autoRestart")) {
        if (typeof body.autoRestart !== "boolean") {
          res.status(400).json({ ok: false, error: "invalid_setting" });
          return;
        }
        patch.autoRestart = body.autoRestart;
      }
      if (Object.prototype.hasOwnProperty.call(body, "budgetMb")) {
        const parsed = parseMemoryBudgetMb(body.budgetMb);
        if (!parsed.ok) {
          res.status(400).json({
            ok: false,
            error: "invalid_setting",
            field: "budgetMb",
            bounds: kWatchdogMemoryBounds.budgetMb,
          });
          return;
        }
        // A budget at or below the gateway's CURRENT footprint is a restart
        // loop, not a leak guard: pressure reads 1.0 on the first eval of
        // every fresh process and the brake only paces the restarts. Reject
        // with the live number so the operator can pick a real ceiling.
        const currentRssMb = (() => {
          try {
            const trend = watchdog?.getMemoryTrend?.();
            return Number.isFinite(trend?.rssMb) ? trend.rssMb : null;
          } catch {
            return null;
          }
        })();
        if (
          parsed.value !== null &&
          currentRssMb !== null &&
          parsed.value <= currentRssMb
        ) {
          res.status(400).json({
            ok: false,
            error: "budget_below_current_rss",
            field: "budgetMb",
            currentRssMb,
          });
          return;
        }
        patch.budgetMb = parsed.value;
      }
      if (Object.prototype.hasOwnProperty.call(body, "maxRestartsPerDay")) {
        const parsed = parseMemoryMaxRestartsPerDay(body.maxRestartsPerDay);
        if (!parsed.ok) {
          res.status(400).json({
            ok: false,
            error: "invalid_setting",
            field: "maxRestartsPerDay",
            bounds: kWatchdogMemoryBounds.maxRestartsPerDay,
          });
          return;
        }
        patch.maxRestartsPerDay = parsed.value;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ ok: false, error: "invalid_setting" });
        return;
      }
      const { settings } = updateWatchdogMemorySettings(patch);
      res.json({ ok: true, settings });
    } catch (err) {
      // Corrupt-but-existing config: the updater refuses rather than
      // rebuilding the whole file from defaults. Surface it as a conflict
      // the operator must resolve (fix or delete alphaclaw.json), not a 500.
      if (err?.code === "config_unreadable") {
        res.status(409).json({ ok: false, error: "config_unreadable" });
        return;
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/watchdog/resources", requireAuth, (req, res) => {
    try {
      const status = watchdog.getStatus();
      const profile = (() => {
        try {
          return require("../machine-profile").getMachineProfile();
        } catch {
          return null;
        }
      })();
      res.json({
        ok: true,
        // Boot-memoized capacity profile (tier, limits, GPU, environment) —
        // the UI's capacity header and the autotune card's freshness signal.
        profile,
        resources: {
          ...getSystemResources({ gatewayPid: status.gatewayPid }),
          // Crash-guard telemetry: unhandled-rejection pressure toward the
          // storm brake (>=50 in 5min triggers a bounded graceful restart).
          unhandledRejections: getRejectionStats(),
          // Memory-leak trend (cached last-evaluation snapshot — this poll
          // path never recomputes). Full numerics live HERE, not on the 2s
          // status SSE, so the frame-dedupe projection stays quiet.
          gatewayMemoryTrend:
            typeof watchdog.getMemoryTrend === "function"
              ? watchdog.getMemoryTrend()
              : null,
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

  // Deliberately the RAW fan-out notifier (no outbox, no policy gate): the
  // operator is asking "do my channels work right now?", so the answer is the
  // notifier's own verdict — never an unconditional ok:true over a result
  // that delivered nowhere (#54: every Telegram send failed for weeks).
  app.post("/api/watchdog/test-notification", requireAuth, async (req, res) => {
    try {
      if (!watchdogNotifier?.notify) {
        return res.status(503).json({ ok: false, error: "Notifier not available" });
      }
      // While the state-DB quiet period holds, the raw notifier's pairing
      // lookup serves the empty readonly fallback, so a migrated box would
      // answer "nothing is configured or paired" — a false diagnosis. The
      // honest answer is the repo-wide 409 backup_in_progress + Retry-After.
      if (isStateDbQuiet()) {
        sendIfStateDbQuietError(res, new StateDbQuietError());
        return;
      }
      const result = await watchdogNotifier.notify(kTestNotificationMessage);
      if (result?.ok !== true) {
        return res.status(502).json({
          ok: false,
          error: describeTestNotificationFailure(result),
          result,
        });
      }
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
