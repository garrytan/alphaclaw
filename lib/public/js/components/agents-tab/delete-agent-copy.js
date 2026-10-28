// Pure copy and state helpers for the Delete Agent dialog and the Agents
// tab's deletion notices (kept out of the components so they can be tested).

// Outcomes after which the agent is no longer configured.
export const kRemovedOutcomes = new Set(["deleted", "cleanup_incomplete", "config_only"]);

export const formatBytes = (bytes, { approximate = false } = {}) => {
  const value = Number(bytes) || 0;
  const text =
    value < 1e6
      ? `${Math.max(1, Math.round(value / 1e3))} KB`
      : value < 1e9
        ? `${(value / 1e6).toFixed(value < 1e7 ? 1 : 0)} MB`
        : `${(value / 1e9).toFixed(1)} GB`;
  return approximate ? `at least ${text}` : text;
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const joinList = (items) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

// "Removes the agent, its 2 channel bindings and 1 cron job." Zero counts are
// left out; an unknown count (null) is left out too.
export const buildRemovalLine = (counts = {}) => {
  const parts = [];
  if (Number(counts.bindings) > 0) parts.push(plural(Number(counts.bindings), "channel binding", "channel bindings"));
  if (Number(counts.cronJobs) > 0) parts.push(plural(Number(counts.cronJobs), "cron job", "cron jobs"));
  const head = parts.length ? `Removes the agent, its ${joinList(parts)}.` : "Removes the agent.";
  return `${head} Other agents keep running and the gateway doesn't restart.`;
};

// The line under the snapshot toggle.
export const buildSnapshotLine = ({ preview, snapshotOn }) => {
  const snapshot = preview?.snapshot || {};
  if (!snapshot.available) return snapshot.reason ? `A snapshot isn't possible: ${snapshot.reason}` : "A snapshot isn't possible for this agent.";
  if (!snapshotOn) return preview?.history?.hasDatabase ? "No snapshot. AlphaClaw keeps no copy of its chat history." : "No snapshot.";
  if (snapshot.fits === false) {
    return `Needs ${formatBytes(snapshot.neededBytes)} free, ${formatBytes(snapshot.availableBytes)} available. Turn off the snapshot to delete without one.`;
  }
  const hasHistory = !!preview?.history?.hasDatabase;
  const workspace = preview?.workspace || {};
  const keepsWorkspace = workspace.exists && !workspace.retainedBy;
  const approximate = !!(preview?.history?.approximate || workspace.approximate);
  const bytes = (Number(preview?.history?.bytes) || 0) + (keepsWorkspace ? Number(workspace.bytes) || 0 : 0);
  const size = formatBytes(bytes, { approximate });
  let saves;
  if (hasHistory && keepsWorkspace) saves = `Saves its chat history and workspace (${size}) in a folder on this box first.`;
  else if (hasHistory) saves = `Saves its chat history (${size}) in a folder on this box first.`;
  else if (keepsWorkspace) saves = `Saves its workspace (${size}) in a folder on this box first. It has no chat history yet.`;
  else return "Nothing to save yet: it has no chat history and no workspace files.";
  const retained = workspace.retainedBy ? ` Its workspace stays where it is because ${workspace.retainedBy} uses it.` : "";
  return `${saves}${retained} Restoring is a manual step for now (README: Deleted agents' data). If the snapshot fails, nothing is deleted.`;
};

// Why the confirm button is disabled, as visible text; null when it isn't.
export const resolveBlockedReason = ({ previewState, snapshotOn }) => {
  if (previewState.loading) return "Checking the agent…";
  const preview = previewState.data;
  if (previewState.error) return snapshotOn ? "Couldn't check the agent. Retry, or turn off the snapshot to delete without one." : null;
  if (!preview) return "Checking the agent…";
  if (preview.refusal) return preview.refusal;
  if (preview.busy) return "Another agent delete is running. Try again when it finishes.";
  if (!preview.gatewayServing) return "The gateway isn't running. Delete the agent once it's back.";
  if (snapshotOn && !preview.snapshot?.available) return "Turn off the snapshot to delete this agent.";
  if (snapshotOn && preview.snapshot?.fits === false) return "Not enough disk for the snapshot.";
  return null;
};

export const buildBusyLabel = ({ snapshotOn }) => (snapshotOn ? "Saving snapshot and deleting…" : "Deleting…");

export const buildExpectationLine = ({ preview, snapshotOn }) => {
  if (!snapshotOn || !preview) return null;
  const bytes = (Number(preview.history?.bytes) || 0) + (Number(preview.workspace?.bytes) || 0);
  return bytes >= 1e9 ? `This can take a few minutes for ${formatBytes(bytes)}.` : null;
};

// The receipt left on the Agents tab after a delete.
export const buildReceiptLine = (result = {}) => {
  const name = result.agentName || result.agentId || "the agent";
  if (result.outcome === "config_only") return `${name} is gone from the settings, but OpenClaw didn't record a deletion, so its data may still be on disk.`;
  const archive = result.archive;
  const kept = archive
    ? ` Snapshot saved (${formatBytes(archive.bytes)}) as ${archive.name}.`
    : " No snapshot was kept.";
  return `Deleted ${name}.${kept}`;
};

// A deletion that still needs the owner: Finish deleting, or Check again.
export const buildDeletionNotice = (entry = {}) => {
  if (entry.outcome === "cleanup_incomplete") {
    return { tone: "warning", text: `${entry.agentId} was deleted, but OpenClaw couldn't finish cleaning up its data (some session data or files are still on disk).`, action: "finish" };
  }
  if (entry.outcome === "unknown") return { tone: "warning", text: `Couldn't confirm whether ${entry.agentId} was deleted.`, action: "check" };
  if (entry.outcome === "running") return { tone: "info", text: `Deleting ${entry.agentId}…`, action: null };
  return null;
};
