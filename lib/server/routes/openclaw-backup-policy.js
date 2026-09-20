const fs = require("fs");
const {
  readOpenclawBackupSettings,
  updateOpenclawBackupSettings,
} = require("../alphaclaw-config");
const { resolveBackupPolicy, validateBackupPolicy } = require("../openclaw-backup-policy");
const { buildMigrationInventory } = require("../openclaw-backup-inventory");
const { sendIfConfigUnreadable } = require("../utils/config-unreadable");
const { wrapAsync } = require("../utils/wrap-async");

const policyFields = (policy) => ({ excludes: [...policy.excludes], rootExcludes: [...policy.rootExcludes] });
const describePolicy = (policy) => ({
  ok: true,
  policy: policyFields(policy),
  defaults: policyFields(resolveBackupPolicy()),
  refusedExcludes: policy.refused,
});

const registerOpenclawBackupPolicyRoutes = ({
  app, requireAdmin, OPENCLAW_DIR, fsModule = fs,
  getSourceContext,
  buildInventory = buildMigrationInventory,
}) => {
  const readSettings = () => readOpenclawBackupSettings({ fsModule, openclawDir: OPENCLAW_DIR });
  const readInventory = async () => {
    const context = getSourceContext?.();
    if (!context?.stateDir) throw new Error("Backup source context unavailable");
    const deadline = Date.now() + 10_000;
    return buildInventory({ ...context, fsModule, checkpoint: () => {
      if (Date.now() >= deadline) throw new Error("Backup source protection discovery timed out");
    } });
  };
  const respondError = (res, error) => {
    if (sendIfConfigUnreadable(res, error)) return;
    console.error("[backup-policy]", error);
    res.status(503).json({
      ok: false, code: "backup_policy_unavailable",
      message: "Could not verify or save the backup exclusions.",
      hint: "Check the server log and the protected backup source paths, then retry. Nothing was changed.",
    });
  };
  // Global requireAuth/member scope applies; only mutation adds requireAdmin.
  app.get("/api/openclaw/backup-policy", wrapAsync(async (req, res) => {
    try {
      const settings = readSettings();
      const inventory = await readInventory();
      res.json(describePolicy(resolveBackupPolicy(settings, { inventory })));
    } catch (error) {
      respondError(res, error);
    }
  }));
  app.put("/api/openclaw/backup-policy", requireAdmin, wrapAsync(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !Array.isArray(body.excludes) || !Array.isArray(body.rootExcludes)) {
      return res.status(400).json({
        ok: false, code: "invalid_backup_policy",
        message: "excludes and rootExcludes must both be arrays of patterns.",
        refusedExcludes: [],
      });
    }
    const reject = (policy) => res.status(400).json({
      ok: false, code: "invalid_backup_policy",
      message: "Some exclusions could omit protected data or are not valid patterns. Nothing was changed.",
      refusedExcludes: policy.refused,
    });
    const staticPolicy = validateBackupPolicy(body);
    if (staticPolicy.refused.length) return reject(staticPolicy);
    try {
      // Check damage before discovery, then check again under the write lock.
      readSettings();
      const inventory = await readInventory();
      const policy = validateBackupPolicy(body, { inventory });
      if (policy.refused.length) return reject(policy);
      updateOpenclawBackupSettings({ fsModule, openclawDir: OPENCLAW_DIR, policy });
      return res.json(describePolicy(policy));
    } catch (error) {
      respondError(res, error);
    }
  }));
};

module.exports = { registerOpenclawBackupPolicyRoutes };
