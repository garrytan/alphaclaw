const fs = require("fs");
const constants = require("../constants");
const { isTruthyFlag } = require("../utils/boolean");
const {
  kAutotuneOverrideBounds,
  readAutotuneSettings,
  updateAutotuneSettings,
} = require("../alphaclaw-config");
const {
  applyResourceAutotune,
  getAutotuneLedger,
  acknowledgeResize,
} = require("../autotune");

// Resource autotune API: the ledger (detected → derived → applied), the
// settings (enabled + per-knob overrides, per-key merge, null clears), and
// the reapply action. Mutations re-run the apply under the gateway lifecycle
// lock (queued, like route restarts) so they can't interleave with boot,
// crash restarts, or the watchdog's resize tick.

// Route-level validation REJECTS bad input with field-level messages (the
// config normalizer silently drops — right for corrupt files, wrong for API
// callers who deserve to know why their override vanished).
const validateOverrides = (overrides) => {
  if (overrides === undefined) return { ok: true, value: undefined };
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return { ok: false, error: "overrides must be an object" };
  }
  const value = {};
  for (const [key, raw] of Object.entries(overrides)) {
    // Own-property lookup: a plain-object index would resolve prototype-chain
    // names (__proto__, toString, constructor…) to truthy junk and skip the
    // unknown-key rejection with undefined bounds.
    const bounds = Object.prototype.hasOwnProperty.call(
      kAutotuneOverrideBounds,
      key,
    )
      ? kAutotuneOverrideBounds[key]
      : null;
    if (!bounds) {
      return { ok: false, error: `unknown override key: ${key}` };
    }
    if (raw === null) {
      value[key] = null;
      continue;
    }
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < bounds.min ||
      raw > bounds.max
    ) {
      return {
        ok: false,
        error: `${key} must be an integer between ${bounds.min} and ${bounds.max}, or null to clear`,
      };
    }
    value[key] = raw;
  }
  return { ok: true, value };
};

// Shared apply-deps factory: the boot apply (register-server-routes.js) and
// the route mutations wire the same event/notify/restart plumbing — one
// builder so they cannot drift.
const buildAutotuneApplyDeps = ({
  restartRequiredState = null,
  // The durable outbox pipeline (upgradeNotifier): autotune notices get
  // dedupe ids and survive restarts like every other auto-fix notification.
  // Falls back to the raw fan-out (watchdogNotifier) when unwired (tests).
  notifier = null,
  watchdogNotifier = null,
  insertWatchdogEvent = null,
  doSyncPromptFiles = null,
} = {}) => ({
  openclawDir: constants.OPENCLAW_DIR,
  emitWatchdogEvent: ({ eventType = "autotune", message } = {}) => {
    try {
      insertWatchdogEvent?.({
        eventType,
        source: "autotune",
        status: "info",
        details: { message },
      });
    } catch {}
  },
  notify: (message, opts) => {
    try {
      // Same operator gate the watchdog's own notify honors — a disabled
      // alerts setting must silence autotune notifications too (the event
      // row still records the fact). isTruthyFlag matches the watchdog's
      // parsing exactly: "1"/"true"/"yes"/"on" all count.
      if (isTruthyFlag(process.env.WATCHDOG_NOTIFICATIONS_DISABLED)) {
        return;
      }
      // Widened seam: opts (outbox dedupe ids, delivery-class flags) flow
      // through whole so all four applyResourceAutotune callers behave alike.
      const sink = notifier || watchdogNotifier;
      void sink?.notify?.(message, {
        eventType: "autotune",
        ...(opts || {}),
      });
    } catch {}
  },
  markRestartRequired: (reason) => {
    try {
      restartRequiredState?.markRequired?.(reason);
    } catch {}
  },
  syncPromptFiles: doSyncPromptFiles,
});

const registerAutotuneRoutes = ({
  app,
  requireAuth,
  gatewayLifecycleLock = null,
  restartRequiredState = null,
  notifier = null,
  watchdogNotifier = null,
  insertWatchdogEvent = null,
  doSyncPromptFiles = null,
}) => {
  const buildApplyDeps = () =>
    buildAutotuneApplyDeps({
      restartRequiredState,
      notifier,
      watchdogNotifier,
      insertWatchdogEvent,
      doSyncPromptFiles,
    });

  const runLocked = async (label, fn) => {
    const release = gatewayLifecycleLock
      ? await gatewayLifecycleLock.acquire(label)
      : null;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };

  const markPendingGatewayRestart = (ledger) => {
    const pending = (ledger?.rows || []).some(
      (row) => row.status === "pending_restart" && row.restartTarget === "gateway",
    );
    if (pending) {
      try {
        restartRequiredState?.markRequired?.("autotune_changed");
      } catch {}
    }
    return pending;
  };

  app.get("/api/autotune", requireAuth, (req, res) => {
    try {
      res.json({ ok: true, ledger: getAutotuneLedger() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put("/api/autotune/settings", requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      // Strictness parity with override-key validation: a typo'd top-level
      // key ("override") must not 200 as a silent no-op.
      const unknownKey = Object.keys(body).find(
        (key) => key !== "enabled" && key !== "overrides",
      );
      if (unknownKey) {
        return res
          .status(400)
          .json({ ok: false, error: `unknown field: ${unknownKey}` });
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return res
          .status(400)
          .json({ ok: false, error: "enabled must be a boolean" });
      }
      const overrides = validateOverrides(body.overrides);
      if (!overrides.ok) {
        return res.status(400).json({ ok: false, error: overrides.error });
      }
      // Persist AND apply under one lock hold: a restart/update queued behind
      // us can't consume a half-finished settings change.
      const { changed, ledger, applyError } = await runLocked(
        "autotune_settings",
        async () => {
          const { changed } = updateAutotuneSettings({
            fsModule: fs,
            openclawDir: constants.OPENCLAW_DIR,
            enabled: body.enabled,
            overrides: overrides.value,
          });
          try {
            const ledger = await applyResourceAutotune({
              trigger: "settings",
              deps: buildApplyDeps(),
            });
            return { changed, ledger, applyError: null };
          } catch (err) {
            // The save SUCCEEDED — a failed re-apply must not read as a
            // failed save (the setting re-derives at the next boot/reapply).
            return { changed, ledger: null, applyError: err.message };
          }
        },
      );
      // Disabling doesn't undo the running gateway's tuned env or this
      // process's installed body limits/caches — only restarts do. Rows are
      // empty when disabled, so the pending-row check can't see this.
      const disabledWithTunedGateway =
        body.enabled === false && getAutotuneLedger().activeGatewayEnv != null;
      if (disabledWithTunedGateway) {
        try {
          restartRequiredState?.markRequired?.("autotune_disabled");
        } catch {}
      }
      const restartRequired =
        markPendingGatewayRestart(ledger) || disabledWithTunedGateway;
      res.json({
        ok: true,
        changed,
        settings: readAutotuneSettings({
          fsModule: fs,
          openclawDir: constants.OPENCLAW_DIR,
        }),
        ledger: ledger ?? getAutotuneLedger(),
        ...(applyError ? { applyError } : {}),
        restartRequired,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Coalesce concurrent reapplies onto one in-flight run: the endpoint is
  // idempotent, and N queued double-clicks (or agent calls) re-probing the
  // container N times behind the lifecycle lock is pure waste.
  let inFlightReapply = null;
  app.post("/api/autotune/reapply", requireAuth, async (req, res) => {
    try {
      // Idempotent by design (safe to double-click): re-probes the container,
      // re-derives, reapplies. Skipped knobs (JSON5 config, busy lock) still
      // return 200 — the ledger rows carry the why.
      if (!inFlightReapply) {
        inFlightReapply = runLocked("autotune_reapply", () =>
          applyResourceAutotune({
            trigger: "reapply",
            refreshProfile: true,
            deps: buildApplyDeps(),
          }),
        ).finally(() => {
          inFlightReapply = null;
        });
      }
      const ledger = await inFlightReapply;
      const restartRequired = markPendingGatewayRestart(ledger);
      res.json({ ok: true, ledger, restartRequired });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put("/api/autotune/resize-ack", requireAuth, (req, res) => {
    try {
      res.json({ ok: true, acknowledged: acknowledgeResize() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};

module.exports = {
  registerAutotuneRoutes,
  buildAutotuneApplyDeps,
  validateOverrides,
};
