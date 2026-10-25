const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { getGitSyncCode, isGitSyncSuccess, describeGitSyncFailure } = require("../cli/git-sync-codes");
const {
  isGitSyncFailureAlertable,
  readGitSyncStatus,
  resolveGitSyncStatusPath,
} = require("../cli/git-sync-status");

// Turns the git-sync status file (written by every `alphaclaw git-sync` run,
// lib/cli/git-sync-status.js) into owner notifications and watchdog events
// (issue #140: a refused sync used to write a log line and nothing else, so
// backups stopped silently).
//
//   status file ── failing, consecutiveFailures >= code threshold or
//   │              failing for a day ──▶ notify + git_sync_refused event,
//   │                                   then a reminder every 24 h while it lasts
//   ├─ success after an announced episode ─────▶ one recovery line + git_sync_recovered
//   ├─ disabled (ALPHACLAW_GIT_SYNC=off) ──────▶ every open episode closes with one
//   │                                            "turned off" line + git_sync_disabled
//   ├─ new paths held back (over the size limit) ─▶ same lifecycle, own episode
//   ├─ nested repositories not backed up ─────▶ same lifecycle, own episode
//   └─ live tree behind for >= threshold runs ─▶ notify once per `since`
//
// What was announced is kept in its own small file so a server restart never
// re-sends an episode, and it is written only after the notification was
// handed over, so a failed send is retried on the next tick instead of being
// marked done. The CLI is the only writer of the status file.
const kHealthStateFileName = "git-sync-health.json";
const kDefaultIntervalMs = 60_000;
const kReminderIntervalMs = 24 * 60 * 60 * 1000;

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

const formatMb = (bytes) => `${Math.max(0.1, (Number(bytes) || 0) / (1024 * 1024)).toFixed(1)} MB`;

const buildBlockedMessage = (status, { reminder = false } = {}) => {
  const codeInfo = getGitSyncCode(status.code);
  const reason = describeGitSyncFailure(status);
  const stale = status.staleState;
  const staleLine = stale?.marker
    ? `\nLeft by: .git/${stale.marker}${Number.isFinite(stale.ageSeconds) ? `, ${Math.round(stale.ageSeconds / 60)} min old` : ""}${stale.owners?.length ? `; pid ${stale.owners[0].pid} (${stale.owners[0].cmd}) still running` : "; no git process running"}.`
    : "";
  return `⚠️ ${reminder ? "Still failing: " : ""}${codeInfo.headline} (since ${formatSince(status.firstFailureAt)}, ${status.consecutiveFailures} run(s)). Workspace changes are not being backed up to GitHub.${reason ? `\n${reason}` : ""}${staleLine}\n${codeInfo.action || ""}`.trim();
};

const buildHeldBackMessage = (status, { reminder = false } = {}) => {
  const paths = status.heldBack?.paths || [];
  const shown = paths.slice(0, 3).map((entry) => `${entry.path} (${formatMb(entry.bytes)})`).join(", ");
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `⚠️ ${reminder ? "Still holding back: " : ""}Git sync has not backed up ${paths.length} large new path(s) since ${formatSince(status.heldBack?.since)}: ${shown}${more}.\n${getGitSyncCode("held_back").action}`;
};

const describeNestedRepo = (entry) =>
  entry.kind === "pointer"
    ? `${entry.path} (a pointer only: the repository it points to is not backed up)`
    : `${entry.path} (a separate repository: its content and history are not backed up)`;

const buildNestedRepoMessage = (status, { reminder = false } = {}) => {
  const paths = status.nestedRepos?.paths || [];
  const shown = paths.slice(0, 3).map(describeNestedRepo).join(", ");
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `⚠️ ${reminder ? "Still not backing up: " : ""}Git sync has not backed up ${paths.length} nested git repositor${paths.length === 1 ? "y" : "ies"} since ${formatSince(status.nestedRepos?.since)}: ${shown}${more}.\n${getGitSyncCode("nested_repo").action}`;
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
  const startedAtMs = nowFn();
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
  // true once the notifier took the notification (queued durably, or skipped
  // because the owner turned notifications off); the event is best-effort on
  // top and never blocks it. Any other refusal is retried on the next check.
  const send = async (message, id, event) => {
    try {
      const result = await notify?.(message, { eventType: "health", id });
      if (result?.ok === false && result.skipped !== true) {
        throw new Error(String(result.reason || "the notifier did not accept it"));
      }
    } catch (error) {
      logger.warn?.(`[alphaclaw] git-sync health notification ${id} failed, retrying next check: ${error.message}`);
      return false;
    }
    try {
      recordEvent?.(event);
    } catch (error) {
      logger.warn?.(`[alphaclaw] git-sync health event ${event.eventType} not recorded: ${error.message}`);
    }
    return true;
  };
  // First notice, then one reminder per 24 h, for an episode keyed by `since`.
  const announce = async ({ announced, since, buildMessage, idPrefix, event, nowMs }) => {
    const known = announced?.since === since;
    if (known && nowMs - (Number(announced.lastNotifiedAt) || 0) < kReminderIntervalMs) return null;
    const reminders = known ? (Number(announced.reminders) || 0) + 1 : 0;
    const sent = await send(
      buildMessage({ reminder: reminders > 0 }),
      reminders > 0 ? `${idPrefix}-${since}-reminder-${reminders}` : `${idPrefix}-${since}`,
      { ...event, details: { ...event.details, reminder: reminders } },
    );
    return sent ? { since, lastNotifiedAt: nowMs, reminders } : false;
  };

  const check = async () => {
    const status = readGitSyncStatus({ statusPath, fsModule });
    if (!status) return { action: "none" };
    const nowMs = nowFn();
    const state = readState();
    const success = isGitSyncSuccess(status.outcome);
    // State files from before reminders carry only `episode`: treat that as
    // announced long ago, so a long-running episode reminds at once.
    const failure = state.failure || (state.episode ? { since: state.episode, lastNotifiedAt: 0, reminders: 0 } : null);
    // An episode announced before this process started (by an older version
    // too) waits for the first run that finishes after it: a reminder or a
    // recovery line about a status the running version never produced would
    // stand until the next scheduled run.
    if (
      failure?.since &&
      (Number(failure.lastNotifiedAt) || 0) < startedAtMs &&
      !(Date.parse(status.at || "") > startedAtMs) &&
      (success || status.firstFailureAt === failure.since)
    ) {
      return { action: "none" };
    }

    if (status.outcome === "disabled") {
      const open = [failure?.since, state.heldBack?.since, state.nestedRepos?.since].filter(Boolean);
      if (open.length === 0 && !state.behindSince) return { action: "none" };
      if (open.length > 0) {
        const sent = await send(
          "⏸️ Git sync was turned off (ALPHACLAW_GIT_SYNC=off), so AlphaClaw no longer backs up this repository and its open sync alert is closed.",
          `git-sync-disabled-${open[0]}`,
          { eventType: "git_sync_disabled", source: "git-sync", status: "ok", details: { closed: open } },
        );
        if (!sent) return { action: "notify_failed" };
      }
      const { episode: _legacy, failure: _failure, heldBack: _held, nestedRepos: _nested, behindSince: _behind, ...rest } = state;
      writeState(rest);
      return { action: open.length > 0 ? "notified_disabled" : "none" };
    }

    if (!success && status.firstFailureAt) {
      if (!isGitSyncFailureAlertable(status, nowMs)) return { action: "none" };
      const next = await announce({
        announced: failure,
        since: status.firstFailureAt,
        buildMessage: (options) => buildBlockedMessage(status, options),
        idPrefix: "git-sync-blocked",
        nowMs,
        event: {
          eventType: "git_sync_refused",
          source: "git-sync",
          status: status.outcome,
          details: {
            code: status.code,
            reason: describeGitSyncFailure(status) || getGitSyncCode(status.code).headline,
            firstFailureAt: status.firstFailureAt,
            consecutiveFailures: status.consecutiveFailures,
            trigger: status.trigger,
            marker: status.staleState?.marker || null,
            ownerPids: (status.staleState?.owners || []).map((owner) => owner.pid),
          },
        },
      });
      if (next === null) return { action: "none" };
      if (next === false) return { action: "notify_failed" };
      const { episode: _legacy, ...rest } = state;
      writeState({ ...rest, failure: next });
      return { action: next.reminders > 0 ? "reminded_blocked" : "notified_blocked" };
    }

    if (success && failure?.since) {
      const since = failure.since;
      const sha = status.shortHash ? `; pushed ${status.shortHash}` : "";
      const sent = await send(`✅ Git sync recovered after ${formatDuration(since, nowMs)}${sha}.`, `git-sync-recovered-${since}`, {
        eventType: "git_sync_recovered",
        source: "git-sync",
        status: "ok",
        details: { firstFailureAt: since, shortHash: status.shortHash || null },
      });
      if (!sent) return { action: "notify_failed" };
      const { episode: _legacy, failure: _done, ...rest } = state;
      writeState(rest);
      return { action: "notified_recovered" };
    }

    const held = status.heldBack;
    if (success && held?.since) {
      const next = await announce({
        announced: state.heldBack,
        since: held.since,
        buildMessage: (options) => buildHeldBackMessage(status, options),
        idPrefix: "git-sync-held-back",
        nowMs,
        event: {
          eventType: "git_sync_refused",
          source: "git-sync",
          status: "warning",
          details: { code: "held_back", since: held.since, paths: (held.paths || []).slice(0, 5) },
        },
      });
      if (next === false) return { action: "notify_failed" };
      if (next) {
        writeState({ ...state, heldBack: next });
        return { action: next.reminders > 0 ? "reminded_held_back" : "notified_held_back" };
      }
    } else if (success && !held && state.heldBack?.since) {
      const since = state.heldBack.since;
      const sent = await send("✅ Git sync is no longer holding back large new files.", `git-sync-held-back-cleared-${since}`, {
        eventType: "git_sync_recovered",
        source: "git-sync",
        status: "ok",
        details: { code: "held_back", since },
      });
      if (!sent) return { action: "notify_failed" };
      const { heldBack: _done, ...rest } = state;
      writeState(rest);
      return { action: "notified_held_back_cleared" };
    }

    const nested = status.nestedRepos;
    if (success && nested?.since) {
      const next = await announce({
        announced: state.nestedRepos,
        since: nested.since,
        buildMessage: (options) => buildNestedRepoMessage(status, options),
        idPrefix: "git-sync-nested-repo",
        nowMs,
        event: {
          eventType: "git_sync_refused",
          source: "git-sync",
          status: "warning",
          details: { code: "nested_repo", since: nested.since, paths: (nested.paths || []).slice(0, 5) },
        },
      });
      if (next === false) return { action: "notify_failed" };
      if (next) {
        writeState({ ...state, nestedRepos: next });
        return { action: next.reminders > 0 ? "reminded_nested_repo" : "notified_nested_repo" };
      }
    } else if (success && !nested && state.nestedRepos?.since) {
      const since = state.nestedRepos.since;
      const sent = await send("✅ Git sync no longer skips nested git repositories.", `git-sync-nested-repo-cleared-${since}`, {
        eventType: "git_sync_recovered",
        source: "git-sync",
        status: "ok",
        details: { code: "nested_repo", since },
      });
      if (!sent) return { action: "notify_failed" };
      const { nestedRepos: _done, ...rest } = state;
      writeState(rest);
      return { action: "notified_nested_repo_cleared" };
    }

    const behind = status.liveTreeBehind;
    if (
      success &&
      behind?.since &&
      state.behindSince !== behind.since &&
      (Number(behind.runs) || 0) >= (getGitSyncCode("live_tree_behind").notifyAfter || 1)
    ) {
      const sent = await send(buildBehindMessage(status), `git-sync-behind-${behind.since}`, {
        eventType: "git_sync_refused",
        source: "git-sync",
        status: "warning",
        details: { code: "live_tree_behind", since: behind.since, paths: (behind.paths || []).slice(0, 5) },
      });
      if (!sent) return { action: "notify_failed" };
      writeState({ ...state, behindSince: behind.since });
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

module.exports = { createGitSyncHealth, buildBlockedMessage, buildBehindMessage, buildHeldBackMessage, buildNestedRepoMessage };
