import { formatRelativeTime } from "../../lib/format.js";

// Doctor's headline (ALPH-69 PR 3b): one sentence from the status and runs
// polls the page already makes. runs are newest first, as the API sends them.

const kCountWords = ["", "one", "two"];

const thingsToFix = (count) =>
  (kCountWords[count] || String(count)) + (count === 1 ? " thing" : " things") + " to fix";

// Consecutive failed runs, newest first, ignoring a run still in progress.
export const countRecentFailedRuns = (runs = []) => {
  let count = 0;
  for (const run of Array.isArray(runs) ? runs : []) {
    const status = String(run?.status || "");
    if (status === "running") continue;
    if (status !== "failed") break;
    count += 1;
  }
  return count;
};

export const buildDoctorHeadline = ({ doctorStatus = null, runs = null, nowMs = Date.now() } = {}) => {
  if (!Array.isArray(runs)) return "Loading…";
  if (doctorStatus?.runInProgress) return "Doctor is running.";
  const failed = countRecentFailedRuns(runs);
  if (failed === 1) return "Doctor's last run failed.";
  if (failed > 1) return "Doctor's last " + (kCountWords[failed] || failed) + " runs failed.";
  const latest = runs.find((run) => String(run?.status || "") === "completed") || null;
  if (!latest && !doctorStatus?.lastRunAt) return "Doctor has not run yet.";
  const relative = formatRelativeTime(doctorStatus?.lastRunAt || latest?.completedAt || latest?.createdAt, {
    nowMs,
    fallback: "recently",
  });
  const open = Number(latest?.statusCounts?.open || 0);
  if (open === 0) return "No findings. Last run " + relative + ".";
  return "Last run " + relative + " found " + thingsToFix(open) + ".";
};
