const fs = require("fs");
const path = require("path");
const { readOpenclawConfig } = require("./openclaw-config");
const { writeFileAtomic } = require("./utils/safe-file");
const { describeAccount, isBlockedGroupRecord, isValidTelegramGroupId, resolveStatePaths } = require("./telegram-groups");

// Group join watcher (GST-1975 PR 1). OpenClaw logs one "channel room join
// introduction" line each time the bot is added to a Telegram group, with
// the group's conversationId and, for a group it does not admit, reason
// "room-not-allowed". This reads OpenClaw's own file log (logging.file) and
// its size-rotated siblings (<name>.1.log .. <name>.5.log), follows each
// file by inode so a rotation is read once, records every group the bot
// joined, tells the owner once per group that has no rule yet, and leaves a
// blocked group again whenever the bot is added back. It never posts into a
// group and makes no Bot API call except leaveChat for a blocked group.
// Every join it reads goes into a small pending queue
// (telegram/join-watch-pending.json) before the log cursor moves, and leaves
// the queue only once it is handled, so a join is never lost: not to a failed
// record, and not to a long outage of the rules file, during which the
// cursor keeps up with the log (its 16 MB read window bounds only one check)
// and the queue holds the joins (at most 500 groups) until the file reads
// again. A failed leave or notice, and a join whose handling throws, stays
// queued for up to kMaxJoinAttempts checks, so one bad join never holds up
// the ones behind it. A pending file that cannot be read as a JSON list
// stops the watcher (it is neither read as empty nor overwritten) until it
// is fixed or moved aside. Each distinct failure (of a join, of a check, of
// the owner sync) is logged once, and a check or owner-sync failure once more
// when it clears. Each check also syncs the
// owners the guard plugin trusts from openclaw.json, so an ownerAllowFrom
// change reaches the plugin within one check. The log path comes from
// openclaw.json read as plain JSON; a JSON5 openclaw.json hides it.
const kJoinLine = /channel room join introduction (?:settled|failed)/;
const kRollingBase = /^openclaw-(?:YYYY-MM-DD|\d{4}-\d{2}-\d{2})\.log$/;
const kRollingFile = /^openclaw-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;
const kMaxRotated = 5;
const kMaxReadBytes = 16 * 1024 * 1024;
const kRecentMs = 48 * 60 * 60 * 1000;
const kMaxCursors = 64;
const kMaxPending = 500;
const kMaxJoinAttempts = 3;

const resolveLogFiles = ({ logFile, fsModule = fs, nowMs = Date.now() }) => {
  if (!logFile) return [];
  const dir = path.dirname(logFile);
  const base = path.basename(logFile);
  let names = [];
  try {
    names = fsModule.readdirSync(dir);
  } catch {
    return [];
  }
  const pick = kRollingBase.test(base)
    ? names.filter((name) => kRollingFile.test(name))
    : (() => {
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length);
        const wanted = new Set([base, ...Array.from({ length: kMaxRotated }, (_, index) => stem + "." + (index + 1) + ext)]);
        return names.filter((name) => wanted.has(name));
      })();
  const files = [];
  for (const name of pick) {
    const file = path.join(dir, name);
    try {
      const stat = fsModule.statSync(file);
      if (stat.isFile() && nowMs - stat.mtimeMs <= kRecentMs) files.push({ file, stat });
    } catch {}
  }
  // Oldest first, so a rotated file's lines come before the current file's.
  return files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
};

// One join line → { groupId, reason, at } or null. Lines are JSON objects
// from OpenClaw's file logger; the fields are matched as text so a change in
// the logger's envelope does not hide a join.
const parseJoinLine = (line) => {
  if (!kJoinLine.test(line) || !/"channel"\s*:\s*"telegram"/.test(line)) return null;
  const groupId = /"conversationId"\s*:\s*"(-\d{5,20})"/.exec(line)?.[1];
  if (!groupId) return null;
  const reason = /"reason"\s*:\s*"([a-z0-9_-]{1,40})"/i.exec(line)?.[1] || null;
  const at = /"time"\s*:\s*"([^"]{10,40})"/.exec(line)?.[1] || /"date"\s*:\s*"([^"]{10,40})"/.exec(line)?.[1] || null;
  return { groupId, reason, at };
};

const createTelegramJoinWatch = ({
  fsModule = fs,
  openclawDir,
  rootDir,
  groups,
  notify = null,
  intervalMs = 60_000,
  maxReadBytes = kMaxReadBytes,
  now = () => Date.now(),
  log = (line) => console.log(line),
} = {}) => {
  const cursorPath = path.join(resolveStatePaths(rootDir).dir, "join-watch-cursors.json");
  const pendingPath = path.join(resolveStatePaths(rootDir).dir, "join-watch-pending.json");
  let timer = null;
  let running = false;
  const failing = { joins: "", owners: "" };
  const loggedJoinErrors = new Set();

  const readCursors = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(cursorPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const writeCursors = (cursors) => {
    const keys = Object.keys(cursors).sort((a, b) => (cursors[b].seenAt || 0) - (cursors[a].seenAt || 0)).slice(0, kMaxCursors);
    fsModule.mkdirSync(path.dirname(cursorPath), { recursive: true, mode: 0o700 });
    writeFileAtomic(cursorPath, JSON.stringify(Object.fromEntries(keys.map((key) => [key, cursors[key]]))) + "\n", { fsModule });
  };
  const readPending = () => {
    let parsed;
    try {
      parsed = JSON.parse(fsModule.readFileSync(pendingPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw new Error("cannot read " + pendingPath + " (" + String(error?.message || error).slice(0, 120) + "); fix it or move it aside, which drops the joins it holds");
    }
    if (!Array.isArray(parsed)) throw new Error(pendingPath + " is not a JSON list; fix it or move it aside, which drops the joins it holds");
    return parsed.filter((join) => isValidTelegramGroupId(join?.groupId));
  };
  // One entry per group, oldest first, newest reason kept.
  const writePending = (joins) => {
    const byGroup = new Map();
    for (const join of joins) {
      byGroup.delete(join.groupId);
      byGroup.set(join.groupId, join);
    }
    const queue = [...byGroup.values()];
    if (queue.length > kMaxPending) log("[alphaclaw] telegram join watch: dropped " + (queue.length - kMaxPending) + " old pending joins");
    const kept = queue.slice(-kMaxPending);
    fsModule.mkdirSync(path.dirname(pendingPath), { recursive: true, mode: 0o700 });
    writeFileAtomic(pendingPath, JSON.stringify(kept) + "\n", { fsModule });
    return kept;
  };

  const readNewLines = (cursors) => {
    const cfg = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
    const lines = [];
    for (const { file, stat } of resolveLogFiles({ logFile: cfg?.logging?.file, fsModule, nowMs: now() })) {
      const key = stat.dev + ":" + stat.ino;
      const known = cursors[key];
      let offset = known && known.size <= stat.size ? known.offset : 0;
      if (stat.size - offset > maxReadBytes) offset = stat.size - maxReadBytes;
      if (stat.size > offset) {
        const fd = fsModule.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(stat.size - offset);
          fsModule.readSync(fd, buffer, 0, buffer.length, offset);
          const text = buffer.toString("utf8");
          const end = text.lastIndexOf("\n");
          if (end >= 0) {
            lines.push(...text.slice(0, end).split("\n"));
            offset += Buffer.byteLength(text.slice(0, end + 1));
          }
        } finally {
          fsModule.closeSync(fd);
        }
      }
      cursors[key] = { offset, size: stat.size, seenAt: now() };
    }
    return lines;
  };

  const check = async () => {
    if (running) return { joins: 0, skipped: "running" };
    running = true;
    try {
      const cursors = readCursors();
      const fresh = readNewLines(cursors).map(parseJoinLine).filter((join) => join && isValidTelegramGroupId(join.groupId));
      // The joins are queued before the cursors move, and leave the queue
      // only once handled, so an unreadable rules file or a failed record
      // below loses nothing.
      let queue = fresh.length ? writePending([...readPending(), ...fresh]) : readPending();
      writeCursors(cursors);
      if (!queue.length) return { joins: 0 };
      const state = groups.readState();
      const cfg = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
      const { groupsMap } = describeAccount({ cfg, state });
      const outcomes = [];
      const total = queue.length;
      // A failed leave or notice stays queued for the next check, at most
      // kMaxJoinAttempts checks in all.
      const handled = (outcome, { retry = false } = {}) => {
        outcomes.push(outcome);
        const [join, ...rest] = queue;
        const attempts = (join.attempts || 0) + 1;
        if (retry && attempts >= kMaxJoinAttempts) log("[alphaclaw] telegram join watch: group=" + join.groupId + " " + outcome.action + " after " + attempts + " checks; giving up until the bot is added again");
        queue = writePending(retry && attempts < kMaxJoinAttempts ? [...rest, { ...join, attempts }] : rest);
      };
      let joinFailed = false;
      for (let index = 0; index < total; index += 1) {
        const join = queue[0];
        try {
          const atIso = new Date(now()).toISOString();
          const seen = groups.noteSeen(join.groupId, { lastJoinAt: atIso, firstSeenAt: state.seen[join.groupId]?.firstSeenAt || atIso, lastJoinReason: join.reason });
          state.seen[join.groupId] = seen;
          const blocked = isBlockedGroupRecord(state.groups[join.groupId]);
          if (blocked) {
            const leave = await groups.leaveGroup(join.groupId);
            groups.noteSeen(join.groupId, leave.ok ? { lastLeftAt: new Date(now()).toISOString(), leaveError: undefined } : { leaveError: leave.error });
            log("[alphaclaw] telegram join watch: group=" + join.groupId + " is blocked; leave " + (leave.ok ? "ok" : "failed"));
            handled({ groupId: join.groupId, action: leave.ok ? "left" : "leave_failed" }, { retry: !leave.ok });
            continue;
          }
          const known = Boolean(groupsMap[join.groupId]) || Boolean(state.groups[join.groupId]);
          if (known || seen.notifiedAt) {
            handled({ groupId: join.groupId, action: "recorded" });
            continue;
          }
          let sent = false;
          if (typeof notify === "function") {
            try {
              const result = await notify(
                [
                  "Your agent was added to a Telegram group it has no rule for: " + join.groupId + ".",
                  "It stays silent there. Change its rule on the Groups page in AlphaClaw to approve, silence or block it.",
                ].join("\n"),
                { eventType: "telegram_group_join", id: "telegram-group-join-" + join.groupId },
              );
              sent = result?.ok !== false || result?.skipped === true;
            } catch {}
          }
          if (sent) groups.noteSeen(join.groupId, { notifiedAt: new Date(now()).toISOString() });
          state.seen[join.groupId] = { ...seen, ...(sent ? { notifiedAt: true } : {}) };
          log("[alphaclaw] telegram join watch: new group=" + join.groupId + " notified=" + sent);
          handled({ groupId: join.groupId, action: sent ? "notified" : "notify_failed" }, { retry: !sent });
        } catch (error) {
          joinFailed = true;
          const detail = String(error?.message || error).slice(0, 200);
          if (!loggedJoinErrors.has(detail)) {
            loggedJoinErrors.add(detail);
            log("[alphaclaw] telegram join watch: group=" + join.groupId + " failed: " + detail);
          }
          handled({ groupId: join.groupId, action: "failed" }, { retry: true });
        }
      }
      if (!joinFailed) loggedJoinErrors.clear();
      return { joins: total, outcomes };
    } finally {
      running = false;
    }
  };

  // One check plus an owner sync. Each distinct failure is logged once, and
  // once more when it clears, never every interval. A check skipped because
  // the last one is still running says nothing about the joins.
  const tick = async () => {
    const problems = {};
    let result = null;
    try {
      result = await check();
    } catch (error) {
      problems.joins = String(error?.message || error).slice(0, 200);
    }
    try {
      groups.syncOwners?.();
    } catch (error) {
      problems.owners = String(error?.message || error).slice(0, 200);
    }
    for (const kind of Object.keys(failing)) {
      if (kind === "joins" && result?.skipped) continue;
      const problem = problems[kind] || "";
      if (problem && problem !== failing[kind]) log("[alphaclaw] telegram join watch failed: " + kind + ": " + problem);
      if (!problem && failing[kind]) log("[alphaclaw] telegram join watch recovered: " + kind);
      failing[kind] = problem;
    }
    return result || { joins: 0, failed: true };
  };

  const start = () => {
    if (timer) return;
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return { check, tick, start, stop };
};

module.exports = { createTelegramJoinWatch, parseJoinLine, resolveLogFiles };

