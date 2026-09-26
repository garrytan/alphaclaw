const fs = require("fs");
const { readOpenclawBackupSettings } = require("../alphaclaw-config");
const { resolveBackupPolicy } = require("../openclaw-backup-policy");
const { sendIfConfigUnreadable } = require("../utils/config-unreadable");
const { wrapAsync } = require("../utils/wrap-async");

const policyFields = (policy) => ({ excludes: [...policy.excludes], rootExcludes: [...policy.rootExcludes] });
const retiredPolicy = (_req, res) => res.status(410).json({
  ok: false,
  code: "backup_policy_retired",
  message: "Full-tree backups and exclusion policies are retired. Configuration checkpoints use a bounded file list.",
  hint: "Save a configuration checkpoint or explicitly request a database-only snapshot from the Upgrade page. Existing archives are unchanged.",
});

const registerOpenclawBackupPolicyRoutes = ({
  app, requireAdmin, OPENCLAW_DIR, fsModule = fs, getBackupPreflight,
}) => {
  app.get("/api/openclaw/backup-preflight", wrapAsync(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (typeof getBackupPreflight !== "function") throw new Error("Recovery preflight unavailable");
      const result = await getBackupPreflight();
      if (typeof result?.blocked !== "boolean") throw new Error("Invalid recovery preflight result");
      if (result.profile === "config_only") {
        const checkpoint = result.checkpoint;
        if (!checkpoint || !Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes < 0 ||
            !Number.isSafeInteger(checkpoint.fileCount) || checkpoint.fileCount < 0) {
          throw new Error("Invalid checkpoint measurement");
        }
        return res.json({
          ok: true, profile: "config_only", blocked: result.blocked, reason: result.reason || null,
          checkpoint: { bytes: checkpoint.bytes, fileCount: checkpoint.fileCount, maxBytes: 16 * 1024 * 1024 },
          databaseCount: Number.isSafeInteger(result.databaseCount) ? result.databaseCount : null,
          databaseBytes: Number.isSafeInteger(result.databaseBytes) ? result.databaseBytes : null,
          coverage: { config: result.blocked ? "unknown" : "complete", databases: "omitted", workspace: "omitted" },
        });
      }
      if (!result.diagnosis) throw new Error("Invalid recovery preflight result");
      const diagnosis = { ...result.diagnosis };
      if (Array.isArray(diagnosis.otherProcesses)) diagnosis.otherProcesses = diagnosis.otherProcesses.map(({ pid }) => ({ pid }));
      return res.json({ ok: true, diagnosis, blocked: result.blocked, reason: result.reason || null });
    } catch (error) {
      if (sendIfConfigUnreadable(res, error)) return;
      console.error("[recovery-preflight]", error);
      return res.status(503).json({
        ok: false, code: "backup_preflight_unavailable",
        message: "Could not finish checking the recovery sources. The gateway has not been paused.",
        hint: "Check the server log and supported configuration paths, then retry.",
      });
    }
  }));

  app.post("/api/openclaw/backup-policy/scratch-excludes", requireAdmin, retiredPolicy);
  app.put("/api/openclaw/backup-policy", requireAdmin, retiredPolicy);
  app.get("/api/openclaw/backup-policy", (_req, res) => {
    try {
      const settings = readOpenclawBackupSettings({ fsModule, openclawDir: OPENCLAW_DIR });
      const policy = resolveBackupPolicy(settings);
      return res.json({
        ok: true, retired: true, policy: policyFields(policy), defaults: policyFields(resolveBackupPolicy()),
        refusedExcludes: policy.refused,
        message: "Saved exclusions are historical only. New recovery checkpoints do not walk the state tree.",
      });
    } catch (error) {
      if (sendIfConfigUnreadable(res, error)) return;
      return res.status(503).json({ ok: false, code: "backup_policy_unavailable", message: "Could not read the historical backup policy." });
    }
  });
};

module.exports = { registerOpenclawBackupPolicyRoutes };
