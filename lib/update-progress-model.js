// Shared update-progress view model: step labels, step-stream collapsing, and
// elapsed-time formatting for OpenClaw update runs. CommonJS with no
// dependencies so BOTH sides can use it — the frontend upgrade tab re-exports
// these from components/upgrade-tab/helpers.js (esbuild bundles CJS fine),
// and server/boot workstreams can require it directly. Everything here is
// display logic and must stay free of Preact/DOM imports so it can be tested
// directly in node.

const toEpochMs = (value) => {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const kStepLabels = {
  preflight: "Preflight checks",
  backup: "Backup",
  toolchain: "Toolchain",
  download: "Download",
  fetch: "Fetch source",
  checkout: "Checkout commit",
  install: "Install dependencies",
  build: "Build",
  doctor: "Doctor",
  verify: "Verify",
  "db-preflight": "Database compatibility",
  record: "Record",
  restarting: "Restarting",
  // Boot-time steps appended to the run ledger after the activation restart.
  activate: "Activating new version",
  "config-migrate": "Migrating settings",
  "db-migrate": "Migrating databases",
};

// Collapses the raw step event stream (one entry per status change) into one
// row per step, in first-seen order, carrying the latest status/detail/error.
const buildStepListModel = (steps = []) => {
  const byName = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    const name = String(step?.name || "").trim();
    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        label: kStepLabels[name] || name,
        status: null,
        detail: null,
        error: null,
        at: null,
      });
    }
    const entry = byName.get(name);
    if (step.status) entry.status = step.status;
    if (step.at != null) entry.at = step.at;
    if (step.detail) entry.detail = step.detail;
    if (step.error) entry.error = step.error;
  }
  return [...byName.values()];
};

const formatElapsed = (startedAt, nowMs = Date.now()) => {
  const start = toEpochMs(startedAt);
  if (start == null) return "0s";
  const totalSeconds = Math.max(0, Math.floor((nowMs - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

module.exports = {
  kStepLabels,
  buildStepListModel,
  formatElapsed,
};
