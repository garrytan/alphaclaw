const {
  readOpenclawMedicEnabled,
  updateOpenclawMedicEnabled,
} = require("../alphaclaw-config");

// Error envelope shared by every /api/openclaw/* route.
const openclawError = (code, message, hint = null) => ({ ok: false, code, message, hint, docsUrl: null });

// OpenClaw-facing settings and the one maintenance action AlphaClaw keeps
// for the pinned OpenClaw: version-gated features, notification routing, the
// startup medic toggle and "Back up now" (OpenClaw's own `backup create`).
const registerOpenclawSettingsRoutes = ({
  app,
  fs,
  OPENCLAW_DIR,
  openclawRuntime,
  openclawFeatureGates = null,
  operatorsStore = null,
  gatewayMedic = null,
}) => {
  const badRequest = (res, code, message, hint = null) =>
    res.status(400).json(openclawError(code, message, hint));

  // Version-gated feature map (fail-closed): the frontend hides beta-only
  // affordances against an older gateway instead of breaking.
  app.get("/api/openclaw/features", (req, res) => {
    try {
      if (!openclawFeatureGates) {
        return res.json({ ok: true, version: null, features: {} });
      }
      res.json({ ok: true, ...openclawFeatureGates.features() });
    } catch (err) {
      res.status(500).json(openclawError("features_unavailable", err.message || "Could not read features"));
    }
  });

  // Notification routing preferences (admin targets are PII — they live in
  // the non-synced state dir store, not alphaclaw.json).
  app.get("/api/openclaw/notifications", (req, res) => {
    try {
      if (!operatorsStore) {
        return res.json({ ok: true, notifications: { preferredChannel: null, adminTargets: [] } });
      }
      res.json({
        ok: true,
        notifications: operatorsStore.read().notifications,
        // The UI renders its channel select from this so the client list can
        // never drift from what the store accepts.
        supportedChannels: operatorsStore.kSupportedChannels || [],
      });
    } catch (err) {
      res.status(500).json(openclawError("notifications_unavailable", err.message || "Could not read notification settings"));
    }
  });

  app.put("/api/openclaw/notifications", (req, res) => {
    try {
      if (!operatorsStore) {
        return res.status(503).json(openclawError("notifications_unavailable", "Store not available"));
      }
      const { preferredChannel = null, adminTargets = [] } = req.body || {};
      // Reject rather than silently normalize away: an API consumer must not
      // get 200 ok for settings the store discarded.
      const supported = operatorsStore.kSupportedChannels || [];
      if (preferredChannel != null && !supported.includes(String(preferredChannel).toLowerCase())) {
        return badRequest(res, "invalid_setting", `preferredChannel must be one of: ${supported.join(", ")} (or null)`);
      }
      if (!Array.isArray(adminTargets)) {
        return badRequest(res, "invalid_setting", "adminTargets must be an array");
      }
      for (const entry of adminTargets) {
        const channel = String(entry?.channel || "").toLowerCase();
        if (!supported.includes(channel) || !String(entry?.target || "").trim()) {
          return badRequest(res, "invalid_setting", "Each adminTarget needs a supported channel and a non-empty target");
        }
      }
      const store = operatorsStore.setNotificationPrefs({ preferredChannel, adminTargets });
      res.json({ ok: true, notifications: store.notifications });
    } catch (err) {
      res.status(500).json(openclawError("notifications_write_failed", err.message || "Could not save notification settings", "Check disk space on the data volume."));
    }
  });

  // Gateway startup medic (automatic EX_CONFIG repair) settings + which
  // frontier model the AI tier would use, or why none is reachable. The
  // deterministic tiers stay available even when no AI is reachable.
  app.get("/api/openclaw/medic", (req, res) => {
    try {
      const availability = gatewayMedic
        ? gatewayMedic.getAvailability()
        : {
            enabled: readOpenclawMedicEnabled({ fsModule: fs, openclawDir: OPENCLAW_DIR }),
            ai: { available: false, reason: "not_wired", message: "Medic service unavailable." },
          };
      res.json({ ok: true, enabled: availability.enabled, ai: availability.ai });
    } catch (err) {
      res.status(500).json(openclawError("medic_unavailable", err.message || "Could not read medic settings"));
    }
  });

  app.put("/api/openclaw/medic", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return badRequest(res, "invalid_setting", "enabled must be a boolean");
    }
    try {
      updateOpenclawMedicEnabled({ fsModule: fs, openclawDir: OPENCLAW_DIR, enabled });
      res.json({ ok: true, enabled });
    } catch (err) {
      res.status(500).json(openclawError("medic_write_failed", err.message || "Could not save medic settings", "Check disk space on the data volume."));
    }
  });

  // "Back up now": OpenClaw's own `openclaw backup create --verify` into the
  // backups dir. Runs in the background; GET reports progress and the last
  // result.
  app.get("/api/openclaw/backup", (req, res) => {
    res.json({ ok: true, ...openclawRuntime.getBackupStatus() });
  });

  app.post("/api/openclaw/backup", (req, res) => {
    const result = openclawRuntime.startBackup();
    if (!result.ok) {
      const status = result.code === "backup_in_progress" ? 409 : 503;
      return res.status(status).json({ ...openclawError(result.code, result.error), error: result.error });
    }
    res.status(202).json({ ok: true, started: true });
  });
};

module.exports = { registerOpenclawSettingsRoutes };
