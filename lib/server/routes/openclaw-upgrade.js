const { wrapAsync } = require("../utils/wrap-async");
const {
  buildFailureKey,
  readMigrationRecord,
} = require("../openclaw-boot-migration");
const { evaluateCapturePreflight } = require("../openclaw-capture-preflight");
const {
  applySnapshotEnable,
  buildSnapshotEnableProposal,
} = require("../openclaw-snapshot-enable");
const {
  addDismissal,
  buildUpgradeStatus,
  describeBackupEvidence,
  readDismissals,
} = require("../openclaw-upgrade-status");
const { readDoctorTranscript } = require("../doctor-transcript");
const { describeManualFix, describePreflightRule } = require("../doctor-plain-language");

const kKey = /^[0-9a-f]{16}$/;
const kProposalId = /^[0-9a-f]{32}$/;

const formatBytes = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "unknown";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return index === 0 ? `${value} bytes` : `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[index]}`;
};

// The upgrade alert, the snapshot preflight and Enable snapshots, and the
// last Doctor run's transcript (View Doctor output). Retry upgrade itself is
// a gateway operation and lives with the restart route (routes/system.js).
const registerOpenclawUpgradeRoutes = ({
  app,
  fs,
  requireAdmin,
  openclawDir,
  managedDir,
  backupsDir,
  stateDir,
  openclawRuntime,
  alphaclawVersion = null,
  getBusyOperation = () => null,
  logger = console,
}) => {
  const isAdmin = (req) => req.alphaclawIdentity?.role === "admin";
  const installedVersion = () => openclawRuntime?.getInfo?.()?.installedVersion ?? null;
  const readPreflight = () => {
    try {
      return evaluateCapturePreflight({
        stateDir: stateDir(),
        databaseFiles: openclawRuntime?.listStateDbFiles?.() || [],
        fsModule: fs,
      });
    } catch (error) {
      logger.warn?.(`[alphaclaw] snapshot preflight failed: ${error.message}`);
      return null;
    }
  };

  app.get("/api/openclaw/upgrade-status", wrapAsync(async (req, res) => {
    const admin = isAdmin(req);
    const version = installedVersion();
    const record = readMigrationRecord({ managedDir, fsModule: fs });
    const preflight = admin ? readPreflight() : null;
    const status = buildUpgradeStatus({
      record,
      installedVersion: version,
      currentKey: admin && version ? buildFailureKey({ openclawDir, installedVersion: version, alphaclawVersion, fsModule: fs }) : null,
      preflight,
      backup: admin
        ? describeBackupEvidence({ backupsDir, receipt: openclawRuntime?.readBackupReceipt?.() || null, installedVersion: version, fsModule: fs })
        : null,
      dismissed: admin ? readDismissals({ managedDir, fsModule: fs }) : [],
      busy: getBusyOperation(),
      isAdmin: admin,
      formatBytes,
    });
    res.json({ ok: true, ...status });
  }));

  app.post("/api/openclaw/upgrade-status/dismiss", requireAdmin, wrapAsync(async (req, res) => {
    const key = String(req.body?.key || "");
    if (!kKey.test(key)) {
      return res.status(400).json({ ok: false, code: "invalid_key", error: "That notice can't be dismissed." });
    }
    addDismissal({ managedDir, key, fsModule: fs });
    res.json({ ok: true });
  }));

  // What Enable snapshots would change — read-only; the confirm renders it.
  app.get("/api/openclaw/snapshots/proposal", requireAdmin, wrapAsync(async (req, res) => {
    const preflight = readPreflight();
    const proposal = buildSnapshotEnableProposal(preflight);
    res.json({
      ...proposal,
      ...(proposal.ok
        ? {}
        : {
            sentence: preflight ? describePreflightRule({ ...preflight, formatBytes }) : null,
            manualFix: preflight ? describeManualFix(preflight) : null,
          }),
    });
  }));

  app.post("/api/openclaw/snapshots/enable", requireAdmin, wrapAsync(async (req, res) => {
    const proposalId = String(req.body?.proposalId || "");
    if (!kProposalId.test(proposalId)) {
      return res.status(400).json({ ok: false, code: "invalid_proposal", error: "Review the proposed change first." });
    }
    const busy = getBusyOperation();
    if (busy) {
      return res.status(409).json({ ok: false, code: "operation_in_progress", error: `Wait for ${busy.label.toLowerCase()} to finish.` });
    }
    const result = applySnapshotEnable({
      proposalId,
      stateDir: stateDir(),
      databaseFiles: openclawRuntime?.listStateDbFiles?.() || [],
      fsModule: fs,
      logger,
    });
    const { preflight, ...rest } = result;
    if (!result.ok) {
      const status = result.code === "chmod_failed" ? 500 : 409;
      return res.status(status).json(rest);
    }
    res.json({
      ...rest,
      sentence: result.captureAvailable
        ? "Snapshots are on. Future Doctor runs will keep a safety snapshot. This doesn't change upgrades that already ran."
        : "The permissions changed, but OpenClaw still can't take a snapshot here.",
    });
  }));

  // Raw output of the newest Doctor run (redacted, bounded at write time).
  app.get("/api/openclaw/doctor-output", requireAdmin, wrapAsync(async (req, res) => {
    const transcript = readDoctorTranscript({ managedDir, fsModule: fs });
    res.json({ ok: true, ...(transcript || { text: null }) });
  }));
};

module.exports = { registerOpenclawUpgradeRoutes, formatBytes };
