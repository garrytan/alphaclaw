const {
  kOpenclawReleaseChannels,
  readOpenclawOverseerEnabled,
  updateOpenclawOverseerEnabled,
  updateOpenclawReleaseChannel,
} = require("../alphaclaw-config");
const { channelError } = require("../openclaw-channel-sync");
const { resolveWhatsNew } = require("../openclaw-whats-new");

// Semver-shaped only: catalog membership is the real gate, but the format
// check alone must already exclude traversal-shaped input ("..", ".") that
// would otherwise reach overlay filesystem paths.
const kVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const kVersionMaxLength = 64;
const kShaPattern = /^[0-9a-f]{7,40}$/;
// How long to wait for a synchronous outcome (noop, validation/gate failure)
// before handing the client an operation id to stream instead.
const kQuickResultWindowMs = 400;

const registerOpenclawChannelRoutes = ({
  app,
  fs,
  OPENCLAW_DIR,
  isOnboarded,
  openclawChannelService,
  openclawReleasesService,
  operationEvents,
  restartRequiredState,
  openclawFeatureGates = null,
  operatorsStore = null,
  upgradeOverseer = null,
  runBackupSqlite = null,
}) => {
  // Parsed openclaw.json for D5 flip filtering; null (= keep all flips) when
  // missing or unreadable.
  const readInstalledOpenclawConfig = () => {
    try {
      return JSON.parse(
        fs.readFileSync(`${OPENCLAW_DIR}/openclaw.json`, "utf8"),
      );
    } catch {
      return null;
    }
  };
  const badRequest = (res, code, message, hint = null) =>
    res.status(400).json(channelError(code, message, hint));

  const stateWriteError = (res, err) =>
    res
      .status(500)
      .json(
        channelError(
          "channel_state_write_failed",
          err?.message || "Could not update the channel state",
          "Check disk space on the data volume.",
        ),
      );

  // Every response that advertised an operationId must eventually publish a
  // terminal event, or a subscriber to the stream hangs forever. applyUpdate
  // normally terminates it in finish(); this covers the early gates
  // (operation_in_progress, not_onboarded) and unexpected throws.
  const ensureOperationTerminated = (operationId, body) => {
    try {
      const op = operationEvents.getOperation(operationId);
      if (op && op.status === "pending") {
        operationEvents.fail(
          operationId,
          Object.assign(new Error(body?.message || "Update failed"), {
            code: body?.code,
            hint: body?.hint,
            docsUrl: body?.docsUrl,
          }),
        );
      }
    } catch {}
  };

  app.put(
    "/api/alphaclaw/config/updates/openclaw-release-channel",
    async (req, res) => {
      const { releaseChannel } = req.body || {};
      if (!kOpenclawReleaseChannels.includes(releaseChannel)) {
        return badRequest(
          res,
          "invalid_channel",
          `releaseChannel must be one of: ${kOpenclawReleaseChannels.join(", ")}`,
        );
      }
      try {
        const { config, changed } = updateOpenclawReleaseChannel({
          fsModule: fs,
          openclawDir: OPENCLAW_DIR,
          releaseChannel,
        });
        // Channel selection is a catalog preference — it installs and
        // activates NOTHING until an explicit Apply, so it must not flag the
        // app restart-required. (It used to: the global "restart required"
        // banner then contradicted the Upgrade page's "still running stable,
        // press Apply" state.) The boot-time openclaw.json mirror converges
        // the preference at the next natural restart.
        res.json({
          ok: true,
          changed,
          config,
          restartRequired: false,
        });
      } catch (err) {
        res
          .status(500)
          .json(
            channelError(
              "config_write_failed",
              err.message || "Could not update the release channel",
              "Check disk space on the data volume.",
            ),
          );
      }
    },
  );

  // Version-gated feature map (fail-closed): the frontend hides beta-only
  // affordances against an older gateway instead of breaking.
  app.get("/api/openclaw/features", (req, res) => {
    try {
      if (!openclawFeatureGates) {
        return res.json({ ok: true, version: null, features: {} });
      }
      res.json({ ok: true, ...openclawFeatureGates.features() });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError("features_unavailable", err.message || "Could not read features"),
        );
    }
  });

  // Notification routing preferences (admin targets are PII — they live in
  // the non-synced state dir store, not alphaclaw.json).
  app.get("/api/openclaw/notifications", (req, res) => {
    try {
      if (!operatorsStore) {
        return res.json({
          ok: true,
          notifications: { preferredChannel: null, adminTargets: [] },
        });
      }
      res.json({
        ok: true,
        notifications: operatorsStore.read().notifications,
        // The UI renders its channel select from this so the client list can
        // never drift from what the store accepts.
        supportedChannels: operatorsStore.kSupportedChannels || [],
      });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "notifications_unavailable",
            err.message || "Could not read notification settings",
          ),
        );
    }
  });

  app.put("/api/openclaw/notifications", (req, res) => {
    try {
      if (!operatorsStore) {
        return res
          .status(503)
          .json(channelError("notifications_unavailable", "Store not available"));
      }
      const { preferredChannel = null, adminTargets = [] } = req.body || {};
      // Reject rather than silently normalize away: an API consumer must not
      // get 200 ok for settings the store discarded (matches the overseer
      // route's invalid_setting behavior).
      const supported = operatorsStore.kSupportedChannels || [];
      if (preferredChannel != null && !supported.includes(String(preferredChannel).toLowerCase())) {
        return badRequest(
          res,
          "invalid_setting",
          `preferredChannel must be one of: ${supported.join(", ")} (or null)`,
        );
      }
      if (!Array.isArray(adminTargets)) {
        return badRequest(res, "invalid_setting", "adminTargets must be an array");
      }
      for (const entry of adminTargets) {
        const channel = String(entry?.channel || "").toLowerCase();
        if (!supported.includes(channel) || !String(entry?.target || "").trim()) {
          return badRequest(
            res,
            "invalid_setting",
            "Each adminTarget needs a supported channel and a non-empty target",
          );
        }
      }
      const store = operatorsStore.setNotificationPrefs({
        preferredChannel,
        adminTargets,
      });
      res.json({ ok: true, notifications: store.notifications });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "notifications_write_failed",
            err.message || "Could not save notification settings",
            "Check disk space on the data volume.",
          ),
        );
    }
  });

  // Upgrade overseer (Claude Code advisory review) settings + availability.
  // Availability is surfaced, never silently degraded: the UI shows exactly
  // why the overseer cannot run (no `claude` binary, no Anthropic credential).
  app.get("/api/openclaw/overseer", async (req, res) => {
    try {
      const enabled = readOpenclawOverseerEnabled({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
      });
      const availability = upgradeOverseer
        ? await upgradeOverseer.getAvailability()
        : { available: false, reason: "not_wired", message: "Overseer service unavailable." };
      res.json({ ok: true, enabled, availability });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "overseer_unavailable",
            err.message || "Could not read overseer settings",
          ),
        );
    }
  });

  app.put("/api/openclaw/overseer", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return badRequest(res, "invalid_setting", "enabled must be a boolean");
    }
    try {
      updateOpenclawOverseerEnabled({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        enabled,
      });
      res.json({ ok: true, enabled });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "overseer_write_failed",
            err.message || "Could not save overseer settings",
            "Check disk space on the data volume.",
          ),
        );
    }
  });

  // Verified SQLite backup (`openclaw backup sqlite create --verify`) —
  // version-gated: the subcommand ships in the 2026.8.1 beta line, so the
  // route fails closed with a clear message on older installs.
  app.post("/api/openclaw/backup-sqlite", async (req, res) => {
    try {
      if (!openclawFeatureGates?.supportsFeature?.("sqliteBackup")) {
        return res
          .status(503)
          .json(
            channelError(
              "feature_unsupported",
              "The installed OpenClaw version has no `backup sqlite` command.",
              "SQLite backups require OpenClaw 2026.8.1-beta.1 or newer — switch channels on the Upgrade page first.",
            ),
          );
      }
      if (typeof runBackupSqlite !== "function") {
        return res
          .status(503)
          .json(
            channelError("backup_unavailable", "SQLite backup runner is not wired."),
          );
      }
      const result = await runBackupSqlite();
      if (!result?.ok) {
        return res.status(500).json({
          ...channelError(
            "backup_failed",
            "The verified SQLite backup did not complete.",
            "Check disk space on the data volume, then retry.",
          ),
          tail: String(result?.tail || "").slice(-4000),
        });
      }
      res.json({ ok: true, tail: String(result.tail || "").slice(-4000) });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError("backup_failed", err.message || "SQLite backup failed"),
        );
    }
  });

  // Update run ledger: per-operation records + durable logs that survive the
  // activation restart. Log reads resolve ONLY through a validated
  // operationId (never a stored path) and stream rather than buffer.
  app.get("/api/openclaw/runs", (req, res) => {
    try {
      const ledger = openclawChannelService.runLedger;
      if (!ledger) return res.json({ ok: true, runs: [] });
      const runs = ledger.listRuns().map((run) => ({
        ...run,
        // Steps can be large; the list view only needs the summary. The full
        // record (steps included) is available per-run.
        steps: undefined,
        stepCount: run.steps.length,
      }));
      res.json({ ok: true, runs });
    } catch (err) {
      res
        .status(500)
        .json(channelError("runs_unavailable", err.message || "Could not list runs"));
    }
  });

  app.get("/api/openclaw/runs/:operationId", (req, res) => {
    try {
      const ledger = openclawChannelService.runLedger;
      const { operationId } = req.params;
      if (!ledger?.isValidOperationId(operationId)) {
        return badRequest(res, "invalid_operation_id", "Malformed operation id.");
      }
      const run = ledger.readRun(operationId);
      if (!run) {
        return res
          .status(404)
          .json(channelError("run_not_found", "No such update run."));
      }
      res.json({ ok: true, run });
    } catch (err) {
      res
        .status(500)
        .json(channelError("run_unavailable", err.message || "Could not read run"));
    }
  });

  app.get("/api/openclaw/runs/:operationId/log", (req, res) => {
    try {
      const ledger = openclawChannelService.runLedger;
      const { operationId } = req.params;
      if (!ledger?.isValidOperationId(operationId)) {
        return badRequest(res, "invalid_operation_id", "Malformed operation id.");
      }
      // ?tail=<bytes> serves only the end of the log (capped at 1MB); the UI
      // uses it by default so multi-MB dev logs never freeze the browser.
      const tailRaw = Number.parseInt(String(req.query.tail || ""), 10);
      const tailBytes =
        Number.isFinite(tailRaw) && tailRaw > 0
          ? Math.min(tailRaw, 1024 * 1024)
          : null;
      const opened = ledger.openLogStream(operationId, { tailBytes });
      if (!opened) {
        return res
          .status(404)
          .json(channelError("log_not_found", "No log recorded for this run."));
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Length", String(opened.size));
      res.setHeader("X-Log-Total-Bytes", String(opened.totalSize));
      if (opened.truncatedHead) res.setHeader("X-Log-Truncated-Head", "1");
      opened.stream.on("error", () => {
        try {
          res.destroy();
        } catch {}
      });
      opened.stream.pipe(res);
    } catch (err) {
      res
        .status(500)
        .json(channelError("log_unavailable", err.message || "Could not read log"));
    }
  });

  app.get("/api/openclaw/channel", (req, res) => {
    try {
      res.json({ ok: true, ...openclawChannelService.getChannelInfo() });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "channel_state_unavailable",
            err.message || "Could not read channel state",
          ),
        );
    }
  });

  app.get("/api/openclaw/catalog", async (req, res) => {
    try {
      const forceRefresh = String(req.query.refresh || "") === "1";
      const catalog = await openclawReleasesService.getCatalog({ forceRefresh });
      if (!catalog.ok) {
        return res.status(503).json(catalog);
      }
      const info = openclawChannelService.getChannelInfo();
      const currentId =
        info.applied?.channel === "dev"
          ? info.applied.sha
          : info.installedVersion || info.pinVersion;
      const annotated = openclawReleasesService.annotateCatalog(catalog, {
        currentId,
        lastKnownGood: info.lastKnownGood,
        blocklist: info.blocklist,
      });
      res.json({
        ok: true,
        catalog: annotated,
        // Curated highlights + security-default flips for the selected channel's
        // latest minor; null when no curated entry exists (UI shows a fallback).
        // Flips are filtered to the ones that affect THIS installation (D5):
        // an explicitly-set key keeps its value across the upgrade.
        whatsNew: resolveWhatsNew({
          catalog: annotated,
          releaseChannel: info.releaseChannel,
          installedConfig: readInstalledOpenclawConfig(),
        }),
        channel: {
          releaseChannel: info.releaseChannel,
          installedVersion: info.installedVersion,
          pinVersion: info.pinVersion,
          appliedId: info.appliedId,
        },
      });
    } catch (err) {
      res
        .status(500)
        .json(
          channelError(
            "catalog_failed",
            err.message || "Could not load the version catalog",
            "Check network access to npmjs.org and github.com.",
          ),
        );
    }
  });

  app.post("/api/openclaw/apply", async (req, res) => {
    const { channel, version = null, sha = null } = req.body || {};
    // Strict boolean: a JSON string "false" must not start a 30-minute build.
    const devHead = (req.body || {}).devHead === true;
    if (!kOpenclawReleaseChannels.includes(channel)) {
      return badRequest(
        res,
        "invalid_channel",
        `channel must be one of: ${kOpenclawReleaseChannels.join(", ")}`,
      );
    }
    // Strict allowlists: these values feed process invocations. Format first,
    // then server-side catalog membership — a well-formed but unknown target
    // is rejected too.
    if (channel === "dev") {
      if (!devHead) {
        if (typeof sha !== "string" || !kShaPattern.test(sha)) {
          return badRequest(
            res,
            "invalid_target",
            "sha must be a 7-40 character lowercase hex commit id",
          );
        }
        if (!openclawReleasesService.isKnownCommit(sha)) {
          return badRequest(
            res,
            "unknown_commit",
            `${sha.slice(0, 12)} is not in the current dev commit list.`,
            'Refresh the catalog ("Check now") and pick a listed commit.',
          );
        }
      }
    } else {
      if (
        typeof version !== "string" ||
        version.length > kVersionMaxLength ||
        !kVersionPattern.test(version)
      ) {
        return badRequest(
          res,
          "invalid_target",
          "version must be a plain version string",
        );
      }
      // Channel-scoped membership: a beta version is not applyable AS stable
      // (and vice versa) — the recorded channel must match the artifact.
      if (!openclawReleasesService.isKnownVersion(version, channel)) {
        return badRequest(
          res,
          "unknown_version",
          `${version} is not a published OpenClaw version in the catalog.`,
          'Refresh the catalog ("Check now") and pick a listed version.',
        );
      }
    }

    const { operationId } = operationEvents.createOperation({
      type: "openclaw-apply",
    });
    const applyPromise = openclawChannelService
      .applyUpdate({ channel, version, sha, devHead, operationId })
      .catch((err) => ({
        status: 500,
        body: {
          ok: false,
          code: "apply_failed",
          message: err.message || "The update failed unexpectedly",
          hint: null,
          docsUrl: null,
        },
      }));
    const quick = await Promise.race([
      applyPromise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), kQuickResultWindowMs);
        timer.unref?.();
      }),
    ]);
    // Whenever the apply settles as an error, make sure the stream reaches a
    // terminal event even if applyUpdate never got as far as its own finish().
    applyPromise.then((result) => {
      if (result && result.body && !result.body.ok) {
        ensureOperationTerminated(operationId, result.body);
      }
    });
    if (quick) {
      return res
        .status(quick.status)
        .json({ ...quick.body, operationId });
    }
    // Long-running (build/download in progress): stream the rest.
    const eventsPath = `/api/operations/${encodeURIComponent(operationId)}/events`;
    res.status(202).json({
      ok: true,
      operationId,
      events: eventsPath,
      // Same field name the pre-existing 202 endpoints use for this handle.
      streamUrl: eventsPath,
    });
  });

  // "Run repair" (2.3): dev-checkout recovery only — package channels re-stage
  // through /api/openclaw/apply instead (overlay ownership, E-C7). Same quick-result
  // + SSE shape as apply.
  app.post("/api/openclaw/repair", async (req, res) => {
    const { operationId } = operationEvents.createOperation({
      type: "openclaw-repair",
    });
    const repairPromise = openclawChannelService
      .runUpdateRepair({ operationId })
      .catch((err) => ({
        status: 500,
        body: {
          ok: false,
          code: "repair_failed",
          message: err.message || "Repair failed unexpectedly",
          hint: null,
          docsUrl: null,
        },
      }));
    const quick = await Promise.race([
      repairPromise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), kQuickResultWindowMs);
        timer.unref?.();
      }),
    ]);
    repairPromise.then((result) => {
      if (result && result.body && !result.body.ok) {
        ensureOperationTerminated(operationId, result.body);
      }
    });
    if (quick) {
      return res.status(quick.status).json({ ...quick.body, operationId });
    }
    const eventsPath = `/api/operations/${encodeURIComponent(operationId)}/events`;
    res.status(202).json({
      ok: true,
      operationId,
      events: eventsPath,
      streamUrl: eventsPath,
    });
  });

  // These three write the channel state file — a full data volume throws
  // synchronously, and Express's default handler would answer with an HTML
  // stack trace instead of the envelope every client here parses.
  app.post("/api/openclaw/rollback", (req, res) => {
    try {
      const result = openclawChannelService.requestChannelRollback({
        reason: "manual",
      });
      if (!result.ok) {
        // A failed marker WRITE is a server/disk failure (ENOSPC class), not
        // a conflict — match the sibling routes' 500 semantics for it.
        return res
          .status(result.code === "rollback_marker_write_failed" ? 500 : 409)
          .json(result);
      }
      res.json(result);
    } catch (err) {
      stateWriteError(res, err);
    }
  });

  app.post("/api/openclaw/mark-good", (req, res) => {
    try {
      const result = openclawChannelService.markGoodNow({ source: "manual" });
      if (!result.ok) {
        return res.status(409).json(result);
      }
      res.json(result);
    } catch (err) {
      stateWriteError(res, err);
    }
  });

  app.post("/api/openclaw/blocklist/clear", (req, res) => {
    const { id = null } = req.body || {};
    if (id !== null && (typeof id !== "string" || id.length > 64)) {
      return badRequest(res, "invalid_target", "id must be a short string");
    }
    try {
      openclawChannelService.store.clearBlocklist(id || undefined);
      res.json({
        ok: true,
        blocklist: openclawChannelService.store.readState().blocklist,
      });
    } catch (err) {
      stateWriteError(res, err);
    }
  });
};

module.exports = { registerOpenclawChannelRoutes };
