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
