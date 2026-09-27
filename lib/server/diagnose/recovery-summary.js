const path = require("path");
const { getGatewayRecoveryAction } = require("../gateway-state");
const { kGatewayStateStaleMs } = require("../constants");
const { sanitizeLabel } = require("../utils/sanitize-label");

const timestamp = (value) => {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
};
const text = (value) => sanitizeLabel(value, { maxLength: 1024 });
const relativePath = (file, stateDir) => {
  if (typeof file !== "string" || !file) return null;
  const relative = path.isAbsolute(file) ? path.relative(stateDir, file) : file;
  return text(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? path.basename(file) : relative).split(path.sep).join("/");
};

const projectDatabaseEvidence = ({ assessment = {}, stateDir }) => {
  const inventory = assessment.inventory;
  const observed = Array.isArray(assessment.perDb) ? assessment.perDb : [];
  const seen = new Set(observed.map((row) => row.path || row.sourcePath));
  const rows = [...observed, ...(inventory?.dbs || []).filter((row) => !seen.has(row.sourcePath)).map((row) => ({
    ...row, compatible: null, migrationRequired: null, status: "not_assessed", reasons: ["recovery_inventory_unavailable"],
  }))];
  const evidenceRoot = inventory?.stateDir || stateDir;
  const discoveryComplete = inventory?.databaseSetComplete === true ||
    (assessment.complete === true && assessment.installationEvidence === "absent");
  const entries = rows.slice(0, 512).map((row) => ({
    path: row.path || row.sourcePath,
    kind: row.dbKind || row.kind,
    agentId: row.agentId || null,
    sizeBytes: row.bytes ?? null,
    userVersion: row.userVersion ?? null,
    status: row.status || (row.compatible === true ? "ok" : "unverified"),
    error: row.error || null,
    compatible: row.compatible ?? null,
    migrationRequired: row.migrationRequired ?? null,
    reasons: Array.isArray(row.reasons) ? row.reasons.map(text).slice(0, 32) : [],
  }));
  const findings = rows.flatMap((row) => {
    const reasons = Array.isArray(row.reasons) && row.reasons.length
      ? row.reasons : row.compatible !== true ? [row.error?.code || "state_db_unverified"] : [];
    return reasons.map((reason) => {
      const action = getGatewayRecoveryAction(reason);
      return { path: relativePath(row.path || row.sourcePath, evidenceRoot), code: text(reason),
        problem: text(row.error?.message || (row.empty ? "The database has no application tables and schema version zero." : `Database verification returned ${reason}.`)),
        cause: row.status === "not_assessed" ? "The inventory did not complete; this database was not verified."
          : "The observation does not establish why the file reached this state. No repair has been performed.",
        nextAction: action, helpRef: action.helpRef };
    });
  });
  for (const reason of Array.isArray(assessment.reasons) ? assessment.reasons : []) {
    if (findings.some((finding) => finding.code === reason)) continue;
    const action = getGatewayRecoveryAction(reason);
    findings.push({ path: relativePath(assessment.sourcePath, evidenceRoot), code: text(reason),
      problem: text(reason), cause: "The assessment could not establish complete compatible database evidence.",
      nextAction: action, helpRef: action.helpRef });
  }
  const excluded = Array.isArray(inventory?.skipped) ? inventory.skipped : [];
  return {
    entries, discoveryComplete,
    excludedArtifacts: excluded.slice(0, 4096).map((row) => ({
      path: relativePath(row.sourcePath || row.path, evidenceRoot),
      kind: text(row.kind), reason: text(row.reason || row.kind),
    })),
    findings: findings.slice(0, 4096),
    truncated: rows.length > 512 || excluded.length > 4096 || findings.length > 4096,
  };
};

const buildRecoverySummary = ({ assessment, sections, generatedAtMs }) => {
  const inventory = assessment?.inventory;
  const evidence = sections.stateDb?.data;
  const entries = evidence?.entries || [];
  const reasonCodes = [...new Set((Array.isArray(assessment?.reasons) ? assessment.reasons : []).map(text))].slice(0, 512);
  const pendingRecovery = sections.channelState?.data?.databaseRecoveryPending || sections.channelState?.data?.info?.databaseRecoveryPending;
  const localEvidence = inventory?.configPresent === true || inventory?.files?.length > 0 || inventory?.dbs?.length > 0 ||
    sections.selfVersion?.data?.present === true || !!sections.bootReports?.data?.current ||
    !!sections.channelState?.data?.lastBoot || !!sections.channelState?.data?.gatewayHold || !!pendingRecovery ||
    sections.channelState?.data?.stateCorrupted === true || sections.channelState?.data?.info?.stateCorrupted === true;
  const confirmedAbsent = !localEvidence && assessment?.installationEvidence === "absent" && assessment?.notAssessed === true &&
    reasonCodes.includes("RECOVERY_STATE_ROOT_MISSING");
  const complete = confirmedAbsent || evidence?.discoveryComplete === true && evidence.truncated !== true && assessment?.complete !== false;
  const installationEvidence = localEvidence || assessment?.installationEvidence === "present" ? "present"
    : assessment?.installationEvidence === "absent" || complete ? "absent" : "unknown";
  const definitiveFailure = assessment?.compatible === false || entries.some((row) =>
    row.compatible === false || ["corrupt", "busy", "unverified"].includes(row.status));
  const databaseVerdict = definitiveFailure ? "blocked"
    : complete && entries.length > 0 && assessment?.compatible === true && typeof assessment?.migrationRequired === "boolean"
      ? "compatible" : "not_assessed";
  if (installationEvidence === "absent") reasonCodes.push("no_installation_evidence");
  if (installationEvidence === "unknown" && !reasonCodes.length) reasonCodes.push("recovery_inventory_unavailable");
  if (assessment?.migrationRequired === true) reasonCodes.push("recovery_choice_required");
  if (pendingRecovery) reasonCodes.push("database_recovery_pending");
  const channel = sections.channelState?.data;
  if (channel?.stateCorrupted || channel?.info?.stateCorrupted) reasonCodes.push("gateway_hold_unreadable");
  const watchdog = sections.watchdog?.source === "live" ? sections.watchdog.data : null;
  const readinessObservedAt = timestamp(watchdog?.lastHealthCheckAt);
  const age = readinessObservedAt ? generatedAtMs - Date.parse(readinessObservedAt) : Infinity;
  const fresh = age >= 0 && age <= kGatewayStateStaleMs;
  const gatewayReadiness = fresh && watchdog?.readiness === "ready" && watchdog?.health === "healthy" &&
    !watchdog?.replacementPending && !watchdog?.operationInProgress && !pendingRecovery ? "ready"
    : watchdog && (watchdog.readiness === "not_ready" || watchdog.health === "unhealthy") ? "not_ready" : "unknown";
  const hold = channel?.gatewayHold || watchdog?.autoRepairPaused;
  const originalHold = hold ? {
    reason: text(hold.reason || hold.cause), observedAt: timestamp(hold.at || hold.observedAt),
    identity: hold.holdId || hold.bootId || hold.fingerprint || null,
  } : null;
  const actionReasons = [...reasonCodes];
  if (hold?.reason) actionReasons.push(hold.reason);
  if (watchdog?.operationInProgress) actionReasons.push("operation_in_progress");
  if (watchdog?.autoRepairPaused) actionReasons.push("auto_repair_paused");
  if (!actionReasons.length && databaseVerdict === "not_assessed") actionReasons.push(localEvidence ? "not_onboarded" : "status_unavailable");
  if (!actionReasons.length && gatewayReadiness !== "ready") actionReasons.push("status_unavailable");
  const nextActions = [...new Map(actionReasons.map((reason) => {
    const action = getGatewayRecoveryAction(reason);
    return [action.id, action];
  })).values()];
  return {
    observedAt: timestamp(assessment?.observedAt) || timestamp(generatedAtMs),
    installationEvidence,
    assessment: complete ? "complete" : entries.length || inventory ? "partial" : "unavailable",
    databaseVerdict, reasonCodes: [...new Set(reasonCodes)], gatewayReadiness, readinessObservedAt,
    originalHold, nextActions,
  };
};

module.exports = { projectDatabaseEvidence, buildRecoverySummary };
