import { h } from "preact";
import htm from "htm";
import { formatRelativeTime } from "../../lib/format.js";

const html = htm.bind(h);

// Auto-sync schedule choices: the server's offset presets (issue #140: never
// :00, where every other cron job on the box runs), plus the stored schedule
// when it is none of them (a legacy :00 preset or a custom expression), so
// the select always shows what cron actually runs.
export const buildSyncScheduleOptions = (syncCron) => {
  const presets = Array.isArray(syncCron?.presets) ? syncCron.presets : [];
  const options = presets.map((preset) => ({
    value: preset.schedule,
    label: preset.label,
    title: preset.schedule,
  }));
  const current = String(syncCron?.schedule || "").trim();
  if (current && !options.some((option) => option.value === current)) {
    options.push({
      value: current,
      label: syncCron?.scheduleLabel || `Custom · ${current}`,
      title: current,
    });
  }
  return options;
};

export const defaultSyncSchedule = (syncCron) =>
  syncCron?.presets?.find?.((preset) => preset.id === "hourly")?.schedule ||
  String(syncCron?.schedule || "");

// One status line for the last git-sync run (the server's redacted summary
// of .alphaclaw/git-sync-status.json). Returns null before the first run.
export const describeGitSyncLastRun = (lastRun, { nowMs = Date.now() } = {}) => {
  if (!lastRun?.at) return null;
  const ago = (value) => formatRelativeTime(value, { nowMs, style: "long" });
  if (lastRun.outcome === "disabled") {
    return { tone: "ok", text: lastRun.headline || "Git sync is off (ALPHACLAW_GIT_SYNC=off)" };
  }
  if (lastRun.outcome === "ok") {
    const hash = lastRun.shortHash ? ` · ${lastRun.shortHash}` : "";
    return { tone: "ok", text: `Last synced ${ago(lastRun.at)}${hash}` };
  }
  if (lastRun.outcome === "warning" && lastRun.code === "held_back") {
    const count = Number(lastRun.heldBackCount) || 0;
    return {
      tone: "warning",
      text: `Pushed ${ago(lastRun.at)}, but ${count === 1 ? "1 large new path is" : `${count} large new paths are`} held back and not backed up`,
    };
  }
  if (lastRun.outcome === "warning" && lastRun.code === "nested_repo") {
    const count = Number(lastRun.nestedRepoCount) || 0;
    return {
      tone: "warning",
      text: `Pushed ${ago(lastRun.at)}, but ${count === 1 ? "1 nested git repository is" : `${count} nested git repositories are`} not backed up`,
    };
  }
  if (lastRun.outcome === "warning") {
    const count = Number(lastRun.liveTreeBehindCount) || 0;
    const files = count === 1 ? "1 file" : `${count} files`;
    return {
      tone: "warning",
      text: `Pushed ${ago(lastRun.at)}, but ${files} on this box ${count === 1 ? "is" : "are"} behind GitHub (unsaved local edits)`,
    };
  }
  const since = lastRun.firstFailureAt ? ` since ${ago(lastRun.firstFailureAt)}` : "";
  const runs = Number(lastRun.consecutiveFailures) || 0;
  return {
    tone: lastRun.code === "lock_timeout" && runs < 3 ? "warning" : "error",
    text: `${lastRun.headline || "Git sync failed"}${since}${runs > 1 ? ` (${runs} runs)` : ""}. Workspace changes are not being backed up.${lastRun.reason ? ` ${lastRun.reason}` : ""}`,
  };
};

const kToneClasses = {
  ok: "text-fg-muted",
  warning: "text-status-warning-muted",
  error: "text-status-error",
};

export const SyncLastRunLine = ({ lastRun }) => {
  const described = describeGitSyncLastRun(lastRun);
  if (!described) return null;
  return html`
    <p
      class="mt-2 text-xs ${kToneClasses[described.tone] || "text-fg-muted"}"
      role="status"
    >
      ${described.text}
    </p>
  `;
};
