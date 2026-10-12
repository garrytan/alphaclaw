const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { getGitSyncCode, isGitSyncSuccess } = require("../cli/git-sync-codes");
const {
  readGitSyncStatus,
  resolveGitSyncStatusPath,
} = require("../cli/git-sync-status");

// Turns the git-sync status file (written by every `alphaclaw git-sync` run,
// lib/cli/git-sync-status.js) into ONE notification per failure episode and
// one recovery line (issue #140: a refused sync used to write a log line and
// nothing else, so backups stopped silently).
//
//   status file ── failing, consecutiveFailures >= code threshold,
//   │              episode not yet announced ──▶ notify + git_sync_refused event
//   ├─ success after an announced episode ─────▶ one recovery line
//   └─ live tree behind for >= threshold runs ─▶ notify once per `since`
//
// What was announced is kept in its own small file so a server restart never
// re-sends an episode. The CLI is the only writer of the status file.
const kHealthStateFileName = "git-sync-health.json";
const kDefaultIntervalMs = 60_000;
const kInProgressWithOwnerThreshold = 2;

const formatSince = (iso) => {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000Z", "Z") : "unknown time";
};

const formatDuration = (fromIso, nowMs) => {
  const ms = nowMs - Date.parse(fromIso || "");
  if (!Number.isFinite(ms) || ms < 0) return "a while";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
};

const notifyThreshold = (status) => {
  const threshold = getGitSyncCode(status.code).notifyAfter || 1;
  if (status.code === "in_progress_operation" && status.staleState?.owners?.length) {
    return Math.max(threshold, kInProgressWithOwnerThreshold);
  }
  return threshold;
};

const buildBlockedMessage = (status) => {
  const codeInfo = getGitSyncCode(status.code);
  const stale = status.staleState;
  const staleLine = stale?.marker
    ? `\nLeft by: .git/${stale.marker}${Number.isFinite(stale.ageSeconds) ? `, ${Math.round(stale.ageSeconds / 60)} min old` : ""}${stale.owners?.length ? `; pid ${stale.owners[0].pid} (${stale.owners[0].cmd}) still running` : "; no git process running"}.`
    : "";
  const detail = String(status.detail || "").slice(0, 280);
  return `⚠️ ${codeInfo.headline} (since ${formatSince(status.firstFailureAt)}, ${status.consecutiveFailures} run(s)). Workspace changes are not being backed up to GitHub.${staleLine}${detail ? `\n${detail}` : ""}\n${codeInfo.action || ""}`.trim();
};

const buildBehindMessage = (status) => {
  const paths = status.liveTreeBehind?.paths || [];
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `⚠️ Git sync is pushing, but this box has been behind GitHub since ${formatSince(status.liveTreeBehind?.since)}.${shown ? ` Local edits block the update: ${shown}${more}.` : ""}\n${getGitSyncCode("live_tree_behind").action}`;
};

const createGitSyncHealth = ({
  openclawDir,
  notify,
  recordEvent,
  fsModule = fs,
  nowFn = Date.now,
  intervalMs = kDefaultIntervalMs,
  logger = console,
}) => {
  const statusPath = resolveGitSyncStatusPath(openclawDir);
  const statePath = path.join(path.dirname(statusPath), kHealthStateFileName);
  let timer = null;

  const readState = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(statePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };
  const writeState = (state) => {
    try {
      writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { fsModule, mode: 0o600 });
    } catch (error) {
      logger.warn?.(`[alphaclaw] git-sync health state write failed: ${error.message}`);
    }
  };
  const send = async (message, id, event) => {
    try {
      recordEvent?.(event);
    } catch {}
    try {
      await notify?.(message, { eventType: "health", id });
    } catch {}
  };

  const check = async () => {
    const status = readGitSyncStatus({ statusPath, fsModule });
    if (!status) return { action: "none" };
    const state = readState();
    const success = isGitSyncSuccess(status.outcome);

    if (!success && status.firstFailureAt) {
      if (state.episode === status.firstFailureAt) return { action: "none" };
      if ((Number(status.consecutiveFailures) || 0) < notifyThreshold(status)) return { action: "none" };
      writeState({ ...state, episode: status.firstFailureAt, episodeCode: status.code });
      await send(buildBlockedMessage(status), `git-sync-blocked-${status.firstFailureAt}`, {
        eventType: "git_sync_refused",
        source: "git-sync",
        status: status.outcome,
        details: {
          code: status.code,
          firstFailureAt: status.firstFailureAt,
          consecutiveFailures: status.consecutiveFailures,
          trigger: status.trigger,
          marker: status.staleState?.marker || null,
          ownerPids: (status.staleState?.owners || []).map((owner) => owner.pid),
        },
      });
      return { action: "notified_blocked" };
    }

    if (success && state.episode) {
      const since = state.episode;
      writeState({ ...state, episode: null, episodeCode: null });
      const sha = status.shortHash ? `; pushed ${status.shortHash}` : "";
      await send(`✅ Git sync recovered after ${formatDuration(since, nowFn())}${sha}.`, `git-sync-recovered-${since}`, {
        eventType: "git_sync_recovered",
        source: "git-sync",
        status: "ok",
        details: { firstFailureAt: since, shortHash: status.shortHash || null },
      });
      return { action: "notified_recovered" };
    }

    const behind = status.liveTreeBehind;
    if (
      success &&
      behind?.since &&
      state.behindSince !== behind.since &&
      (Number(behind.runs) || 0) >= (getGitSyncCode("live_tree_behind").notifyAfter || 1)
    ) {
      writeState({ ...state, behindSince: behind.since });
      await send(buildBehindMessage(status), `git-sync-behind-${behind.since}`, {
        eventType: "git_sync_refused",
        source: "git-sync",
        status: "warning",
        details: { code: "live_tree_behind", since: behind.since, paths: (behind.paths || []).slice(0, 5) },
      });
      return { action: "notified_behind" };
    }
    return { action: "none" };
  };

  const start = () => {
    if (timer) return;
    const tick = () => {
      check().catch((error) => logger.warn?.(`[alphaclaw] git-sync health check failed: ${error.message}`));
    };
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { check, start, stop };
};

module.exports = { createGitSyncHealth, buildBlockedMessage, buildBehindMessage };
