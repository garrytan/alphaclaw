// Pure view-model for the Relay page (exported for tests): what the operator
// must look at first. Order: waiting on the owner, failed or unanswered,
// health, roster, log.
export const kRelayPhaseCopy = {
  off: { label: "Off", tone: "neutral", text: "The relay is turned off (ALPHACLAW_RELAY=off in the deployment environment)." },
  idle: { label: "Starting", tone: "info", text: "The relay starts once the gateway is up." },
  downloading: { label: "Downloading", tone: "info", text: "Fetching and verifying the pinned relay engine." },
  engine_starting: { label: "Starting", tone: "info", text: "Starting the relay engine." },
  provisioning: { label: "Provisioning", tone: "info", text: "Creating the relay workspace and this box's agent." },
  ready: { label: "Ready", tone: "success", text: "Other agents can message this box's agent over the relay." },
  failed: { label: "Not running", tone: "danger", text: "" },
};

const kBridgeFailingCopy = { label: "Not answering", tone: "danger" };

export const kRunStateCopy = {
  queued: { label: "Queued", tone: "info" },
  dispatched: { label: "Running", tone: "info" },
  completing: { label: "Answering", tone: "info" },
  reconciling: { label: "Checking", tone: "warning" },
  replying: { label: "Replying", tone: "warning" },
  answered: { label: "Answered", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  interrupted: { label: "Interrupted", tone: "danger" },
  unknown: { label: "Outcome unknown", tone: "warning" },
  rate_limited: { label: "Rate limited", tone: "warning" },
  hop_limit: { label: "Loop stopped", tone: "warning" },
};

const kProblemStates = new Set(["failed", "interrupted", "unknown", "rate_limited", "hop_limit"]);
const kOpenStates = new Set(["queued", "dispatched", "completing", "reconciling", "replying"]);
const kApprovalPattern = /approval (relay-[0-9a-f]{8})/i;

// The brain archive (relay conversations saved as gbrain pages).
export const kArchivePhaseCopy = {
  off: { label: "Off", tone: "neutral", text: "Relay conversations are not saved to a brain (ALPHACLAW_RELAY_BRAIN=off, or the relay is off)." },
  waiting: { label: "Starting", tone: "info", text: "Starts once the relay is ready." },
  checking: { label: "Checking", tone: "info", text: "Looking for gbrain and its relay source." },
  ready: { label: "Saving", tone: "success", text: "Each relay conversation is saved as a page in the brain's relay source, which is not federated and stays out of default recall." },
};

export const kArchiveCodeCopy = {
  gbrain_missing: { tone: "neutral", text: "No gbrain wrapper on this box (/usr/local/bin/gbrain or ALPHACLAW_RELAY_BRAIN_BIN), so relay conversations are not saved to a brain." },
  source_missing: { tone: "neutral", text: "gbrain is here, but the brain has no relay source yet. The brain's owner creates it (not federated); AlphaClaw never creates it, and checks again every 10 minutes." },
  source_federated: { tone: "danger", text: "The brain's relay source is federated, so its pages would reach default recall. Nothing is saved until it is set back to not federated." },
  gbrain_failed: { tone: "warning", text: "gbrain did not answer; trying again with backoff." },
  gbrain_busy: { tone: "info", text: "gbrain was busy (a lock or a full queue); trying again with backoff." },
  gbrain_stopped: { tone: "danger", text: "gbrain asked for a person before writing." },
  write_pending: { tone: "info", text: "gbrain accepted a write that is still pending; it is checked again, never sent twice." },
  revision_conflict: { tone: "warning", text: "The page changed in the brain since this box wrote it. Retry replaces it; gbrain keeps the old version in its history." },
  masked_refused: { tone: "danger", text: "A page still looked like it carried a secret after masking, so it was not written." },
  relay_read_failed: { tone: "warning", text: "The conversation could not be read from the relay; trying again with backoff." },
  commit_failed: { tone: "warning", text: "gbrain could not commit the saved pages; trying again with backoff." },
  peer_budget_daily: { tone: "info", text: "A peer reached today's archive budget; its conversations are saved after 00:00 UTC." },
  peer_budget_total: { tone: "warning", text: "A peer reached its total archive budget; its conversations are saved again once ALPHACLAW_RELAY_BRAIN_PEER_TOTAL_MB is raised and Retry is pressed." },
};

const formatMb = (bytes) => {
  const mb = Number(bytes) / (1024 * 1024);
  return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + " MB";
};

export const buildArchiveModel = (archive = null) => {
  const phase = archive?.enabled ? archive.phase || "checking" : "off";
  const codeCopy = phase === "unavailable" ? kArchiveCodeCopy[archive?.code] || kArchiveCodeCopy.gbrain_failed : null;
  const phaseCopy = codeCopy
    ? { label: archive?.code === "gbrain_missing" || archive?.code === "source_missing" ? "Not set up" : "Not saving", tone: codeCopy.tone, text: codeCopy.text }
    : kArchivePhaseCopy[phase] || kArchivePhaseCopy.checking;
  const counts = archive?.counts || {};
  const parked = (Array.isArray(archive?.parked) ? archive.parked : []).map((row) => ({
    ...row,
    text: kArchiveCodeCopy[row.code]?.text || row.code,
    tone: kArchiveCodeCopy[row.code]?.tone || "warning",
  }));
  const lastError = archive?.lastError?.code ? { ...archive.lastError, text: kArchiveCodeCopy[archive.lastError.code]?.text || archive.lastError.code } : null;
  const commitError = archive?.commitError?.code
    ? { ...archive.commitError, text: archive.commitError.code === "gbrain_stopped" ? "gbrain asked for a person before committing; commits wait for Retry." : kArchiveCodeCopy.commit_failed.text }
    : null;
  return {
    enabled: Boolean(archive?.enabled),
    phase,
    label: phaseCopy.label,
    tone: phaseCopy.tone,
    text: phaseCopy.text,
    pages: counts.pages || 0,
    waiting: (counts.due || 0) + (counts.backoff || 0),
    pendingWrites: counts.pendingWrites || 0,
    commitsQueued: counts.commitsQueued || 0,
    parked,
    lastError,
    commitError,
    lastSavedAt: archive?.lastSavedAt || null,
    overBudget: (Array.isArray(archive?.overBudget) ? archive.overBudget : []).map((row) => ({
      ...row,
      text:
        row.code === "peer_budget_total"
          ? "@" + row.peer + " is past its total budget (" + formatMb(archive?.budget?.peerTotalBytes) + "); " + row.conversations + " conversation" + (row.conversations === 1 ? " is" : "s are") + " not saved until the budget is raised and Retry is pressed."
          : "@" + row.peer + " reached today's budget (" + formatMb(archive?.budget?.peerDailyBytes) + "); " + row.conversations + " conversation" + (row.conversations === 1 ? "" : "s") + " resume after 00:00 UTC.",
    })),
    canRetry: Boolean(archive?.enabled) && phase !== "off",
  };
};

export const buildRelayPageModel = ({ status = null, runs = [], messages = [] } = {}) => {
  const phase = status?.phase || (status?.enabled === false ? "off" : "idle");
  const phaseCopy = kRelayPhaseCopy[phase] || kRelayPhaseCopy.idle;
  const agentName = status?.agentName || null;
  const answeredWith = new Set();
  const waitingOnOwner = [];
  for (const message of messages) {
    if (!agentName || message.from !== agentName) continue;
    const match = String(message.text || "").match(kApprovalPattern);
    if (!match || answeredWith.has(match[1])) continue;
    answeredWith.add(match[1]);
    waitingOnOwner.push({ approvalId: match[1], to: message.to, at: message.createdAt, messageId: message.messageId });
  }
  const exposedOn = status?.engine?.exposure?.exposedOn || [];
  const bridgeFailure = phase === "ready" ? status?.bridge?.failure || null : null;
  return {
    phase,
    phaseLabel: bridgeFailure ? kBridgeFailingCopy.label : phaseCopy.label,
    phaseTone: bridgeFailure ? kBridgeFailingCopy.tone : phaseCopy.tone,
    phaseText: bridgeFailure || (phase === "failed" ? status?.error?.title || "The relay is not running." : phaseCopy.text),
    bridgeFailure,
    error: status?.error || null,
    retryAt: status?.retryAt || null,
    exposureWarning: exposedOn.length
      ? "The relay engine also answers on " + exposedOn.join(", ") + " port " + status.engine.port +
        ". Every route but its health check needs a key and anonymous workspace creation is off, but keep that port closed to the internet."
      : null,
    waitingOnOwner,
    problems: runs.filter((run) => kProblemStates.has(run.state)),
    open: runs.filter((run) => kOpenStates.has(run.state)),
    agents: Array.isArray(status?.agents) ? status.agents : [],
    agentName,
  };
};
