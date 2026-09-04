const { kDoctorCardStatus, kDoctorDefaultRunsLimit } = require("../doctor/constants");
const { kDoctorScanCapBounds } = require("../alphaclaw-config");
const { resolveEffectiveScanCaps } = require("../doctor/workspace-fingerprint");
const { wrapAsync } = require("../utils/wrap-async");

// Bounds the shell-escaped --params argument well under Linux MAX_ARG_STRLEN
// (~128KiB per exec arg) — an oversized prompt must be a loud 400, not an
// opaque E2BIG after the card already flipped to working.
const kDoctorFixPromptMaxChars = 100000;

// Validates one scan-cap PUT value: undefined = untouched, null = reset to
// the built-in default, integer within bounds = set. Anything else is a
// loud 400 (never a silent clamp — the settings UI must revert).
const validateScanCapValue = (value, bounds, fieldName) => {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return {
      ok: false,
      error: `${fieldName} must be null or an integer between ${bounds.min} and ${bounds.max}`,
    };
  }
  return { ok: true, value };
};

const buildScanSettings = (readDoctorScanConfig) => {
  const configured = readDoctorScanConfig
    ? readDoctorScanConfig()
    : { maxFiles: null, maxFileMb: null };
  const effective = resolveEffectiveScanCaps(configured);
  return {
    maxFiles: {
      configured: configured.maxFiles ?? null,
      effective: effective.maxFiles,
    },
    maxFileMb: {
      configured: configured.maxFileMb ?? null,
      effective: effective.maxFileMb,
    },
  };
};

const registerDoctorRoutes = ({
  app,
  requireAuth,
  doctorService,
  readDoctorAutoRunEnabled = null,
  updateDoctorAutoRunEnabled = null,
  readDoctorScanConfig = null,
  updateDoctorScanConfig = null,
  // Preferred writer: ONE locked read-modify-write for mixed bodies so a
  // failure can never half-apply (production wiring provides it; the split
  // updaters remain the fallback for older wiring/tests).
  updateDoctorSettingsCombined = null,
}) => {
  app.get("/api/doctor/status", requireAuth, (req, res) => {
    try {
      res.json({ ok: true, status: doctorService.buildStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/doctor/run", requireAuth, wrapAsync(async (req, res) => {
    try {
      const result = await doctorService.runDoctor();
      if (!result.ok && result.alreadyRunning) {
        return res.status(409).json(result);
      }
      if (!result.ok && result.gatewayUnavailable) {
        return res.status(503).json(result);
      }
      return res.status(result.reusedPreviousRun ? 200 : 202).json(result);
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  }));

  app.get("/api/doctor/settings", requireAuth, (req, res) => {
    try {
      res.json({
        ok: true,
        settings: {
          autoRunEnabled: readDoctorAutoRunEnabled?.() === true,
          scan: buildScanSettings(readDoctorScanConfig),
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.put("/api/doctor/settings", requireAuth, (req, res) => {
    try {
      if (!updateDoctorAutoRunEnabled) {
        return res.status(500).json({ ok: false, error: "Doctor settings unavailable" });
      }
      const body = req.body || {};
      const hasAutoRun = body.autoRunEnabled !== undefined;
      const hasScan = body.scan !== undefined;
      // Partial bodies: at least one recognized field — an empty `{}` is a
      // client bug, not a no-op success.
      if (!hasAutoRun && !hasScan) {
        return res.status(400).json({
          ok: false,
          error: "autoRunEnabled (boolean) and/or scan ({maxFiles, maxFileMb}) required",
        });
      }
      if (hasAutoRun && typeof body.autoRunEnabled !== "boolean") {
        return res
          .status(400)
          .json({ ok: false, error: "autoRunEnabled must be a boolean" });
      }
      let scanUpdate = null;
      if (hasScan) {
        if (!updateDoctorScanConfig) {
          return res
            .status(500)
            .json({ ok: false, error: "Doctor scan settings unavailable" });
        }
        if (!body.scan || typeof body.scan !== "object" || Array.isArray(body.scan)) {
          return res
            .status(400)
            .json({ ok: false, error: "scan must be an object ({maxFiles, maxFileMb})" });
        }
        const maxFiles = validateScanCapValue(
          body.scan.maxFiles,
          kDoctorScanCapBounds.maxFiles,
          "scan.maxFiles",
        );
        if (!maxFiles.ok) return res.status(400).json({ ok: false, error: maxFiles.error });
        const maxFileMb = validateScanCapValue(
          body.scan.maxFileMb,
          kDoctorScanCapBounds.maxFileMb,
          "scan.maxFileMb",
        );
        if (!maxFileMb.ok) return res.status(400).json({ ok: false, error: maxFileMb.error });
        if (maxFiles.value === undefined && maxFileMb.value === undefined) {
          return res
            .status(400)
            .json({ ok: false, error: "scan must set maxFiles and/or maxFileMb" });
        }
        scanUpdate = { maxFiles: maxFiles.value, maxFileMb: maxFileMb.value };
      }
      let enabled;
      if (updateDoctorSettingsCombined) {
        const applied = updateDoctorSettingsCombined({
          autoRunEnabled: hasAutoRun ? body.autoRunEnabled === true : undefined,
          maxFiles: scanUpdate ? scanUpdate.maxFiles : undefined,
          maxFileMb: scanUpdate ? scanUpdate.maxFileMb : undefined,
        });
        enabled = applied.autoRunEnabled;
      } else {
        enabled = hasAutoRun
          ? updateDoctorAutoRunEnabled(body.autoRunEnabled === true)
          : readDoctorAutoRunEnabled?.() === true;
        if (scanUpdate) updateDoctorScanConfig(scanUpdate);
      }
      if (scanUpdate) {
        // Discard in-flight old-cap worker results and re-scan under the new
        // caps — no restart needed.
        try {
          void doctorService?.invalidateSnapshotCache?.();
        } catch {}
      }
      return res.json({
        ok: true,
        settings: {
          autoRunEnabled: enabled,
          scan: buildScanSettings(readDoctorScanConfig),
        },
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/doctor/import", requireAuth, wrapAsync(async (req, res) => {
    try {
      const result = await doctorService.importDoctorResult({
        rawOutput: req.body?.rawOutput,
      });
      return res.status(201).json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  }));

  app.get("/api/doctor/runs", requireAuth, (req, res) => {
    try {
      const limit = Number.parseInt(String(req.query.limit || kDoctorDefaultRunsLimit), 10);
      // Lean summaries (fix wave F110): this endpoint is polled every 15s (2s
      // during a run) and no consumer reads workspaceManifest/rawResult —
      // /api/doctor/runs/:id keeps the full model.
      const listRuns = doctorService.listDoctorRunSummaries || doctorService.listDoctorRuns;
      const runs = listRuns({ limit });
      res.json({ ok: true, runs });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/doctor/cards", requireAuth, (req, res) => {
    try {
      const runId = String(req.query.runId || "").trim();
      const cards = doctorService.listDoctorCards({
        runId: runId || "all",
      });
      return res.json({ ok: true, cards });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/doctor/runs/:id", requireAuth, (req, res) => {
    try {
      const run = doctorService.getDoctorRun(req.params.id);
      if (!run) {
        return res.status(404).json({ ok: false, error: "Doctor run not found" });
      }
      return res.json({ ok: true, run });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/doctor/runs/:id/cards", requireAuth, (req, res) => {
    try {
      const run = doctorService.getDoctorRun(req.params.id);
      if (!run) {
        return res.status(404).json({ ok: false, error: "Doctor run not found" });
      }
      const cards = doctorService.getDoctorCardsByRunId(req.params.id);
      return res.json({ ok: true, cards });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/doctor/cards/:id/status", requireAuth, (req, res) => {
    try {
      const requestedStatus = String(req.body?.status || "").trim().toLowerCase();
      if (
        requestedStatus !== kDoctorCardStatus.open &&
        requestedStatus !== kDoctorCardStatus.dismissed &&
        requestedStatus !== kDoctorCardStatus.fixed
      ) {
        return res.status(400).json({ ok: false, error: "Invalid Doctor card status" });
      }
      const card = doctorService.setCardStatus({
        cardId: req.params.id,
        status: requestedStatus,
      });
      return res.json({ ok: true, card });
    } catch (error) {
      if (/not found/i.test(error.message || "")) {
        return res.status(404).json({ ok: false, error: error.message });
      }
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/doctor/findings/:id/fix", requireAuth, wrapAsync(async (req, res) => {
    try {
      // Half-specified reply target = malformed client request. The server
      // derives the authoritative target from the sessionKey either way, but
      // a client that sends exactly one half is buggy and must hear it.
      if (String(req.body?.prompt || "").length > kDoctorFixPromptMaxChars) {
        return res.status(400).json({
          ok: false,
          error: `prompt must be ${kDoctorFixPromptMaxChars} characters or fewer`,
        });
      }
      const replyChannel = String(req.body?.replyChannel || "").trim();
      const replyTo = String(req.body?.replyTo || "").trim();
      if (!!replyChannel !== !!replyTo) {
        return res.status(400).json({
          ok: false,
          error: "replyChannel and replyTo must be provided together (or both omitted)",
        });
      }
      const result = await doctorService.requestCardFix({
        cardId: req.params.id,
        sessionKey: req.body?.sessionKey,
        replyChannel: req.body?.replyChannel,
        replyTo: req.body?.replyTo,
        prompt: req.body?.prompt,
      });
      return res.status(result?.queued ? 202 : 200).json(result);
    } catch (error) {
      if (error?.gatewayUnavailable) {
        // Same envelope as POST /api/doctor/run so the client can render the
        // gateway-not-ready reason for fixes too.
        return res.status(503).json({
          ok: false,
          error: error.message,
          gatewayUnavailable: true,
          reason: String(error.reason || ""),
        });
      }
      // Session validation failures are client errors (bad target), NOT the
      // card-not-found 404 the generic matcher below would produce.
      if (error?.sessionNotFound) {
        return res.status(400).json({ ok: false, error: error.message });
      }
      // A failing sessions CLI is infrastructure, not a client bug — same
      // 502 mapping as POST /api/agent/message's lookup failure.
      if (error?.sessionLookupFailed) {
        return res.status(502).json({ ok: false, error: error.message });
      }
      // Final-payload byte budget (covers the fixPrompt fallback the route's
      // char pre-filter never sees) — a client error, not a 500.
      if (error?.promptTooLarge) {
        return res.status(400).json({ ok: false, error: error.message });
      }
      if (/already in progress|must be open/i.test(error.message || "")) {
        return res.status(409).json({ ok: false, error: error.message });
      }
      if (/not found/i.test(error.message || "")) {
        return res.status(404).json({ ok: false, error: error.message });
      }
      return res.status(400).json({ ok: false, error: error.message });
    }
  }));
};

module.exports = { registerDoctorRoutes };
