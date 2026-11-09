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
const kJoinLine = /channel room join introduction (?:settled|failed)/;
const kRollingBase = /^openclaw-(?:YYYY-MM-DD|\d{4}-\d{2}-\d{2})\.log$/;
const kRollingFile = /^openclaw-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;
const kMaxRotated = 5;
const kMaxReadBytes = 16 * 1024 * 1024;
const kRecentMs = 48 * 60 * 60 * 1000;
const kMaxCursors = 64;

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
  now = () => Date.now(),
  log = (line) => console.log(line),
} = {}) => {
  const cursorPath = path.join(resolveStatePaths(rootDir).dir, "join-watch-cursors.json");
  let timer = null;
  let running = false;

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

  const readNewLines = (cursors) => {
    const cfg = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
    const lines = [];
    for (const { file, stat } of resolveLogFiles({ logFile: cfg?.logging?.file, fsModule, nowMs: now() })) {
      const key = stat.dev + ":" + stat.ino;
      const known = cursors[key];
      let offset = known && known.size <= stat.size ? known.offset : 0;
      if (stat.size - offset > kMaxReadBytes) offset = stat.size - kMaxReadBytes;
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
      const joins = readNewLines(cursors).map(parseJoinLine).filter(Boolean);
      // An unreadable rules file throws here, before the cursors move, so
      // these joins are handled once the file is fixed.
      const state = joins.length ? groups.readState() : null;
      writeCursors(cursors);
      if (!joins.length) return { joins: 0 };
      const cfg = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
      const { groupsMap } = describeAccount({ cfg, state });
      const outcomes = [];
      for (const join of joins) {
        if (!isValidTelegramGroupId(join.groupId)) continue;
        const atIso = new Date(now()).toISOString();
        const seen = groups.noteSeen(join.groupId, { lastJoinAt: atIso, firstSeenAt: state.seen[join.groupId]?.firstSeenAt || atIso, lastJoinReason: join.reason });
        state.seen[join.groupId] = seen;
        const blocked = isBlockedGroupRecord(state.groups[join.groupId]);
        if (blocked) {
          const leave = await groups.leaveGroup(join.groupId);
          groups.noteSeen(join.groupId, leave.ok ? { lastLeftAt: new Date(now()).toISOString(), leaveError: undefined } : { leaveError: leave.error });
          log("[alphaclaw] telegram join watch: group=" + join.groupId + " is blocked; leave " + (leave.ok ? "ok" : "failed"));
          outcomes.push({ groupId: join.groupId, action: leave.ok ? "left" : "leave_failed" });
          continue;
        }
        const known = Boolean(groupsMap[join.groupId]) || Boolean(state.groups[join.groupId]);
        if (known || seen.notifiedAt) {
          outcomes.push({ groupId: join.groupId, action: "recorded" });
          continue;
        }
        let sent = false;
        if (typeof notify === "function") {
          try {
            const result = await notify(
              [
                "Your agent was added to a Telegram group it has no rule for: " + join.groupId + ".",
                "It stays silent there. Change its rule in AlphaClaw (the Telegram group rules API) to approve, silence or block it.",
              ].join("\n"),
              { eventType: "telegram_group_join", id: "telegram-group-join-" + join.groupId },
            );
            sent = result?.ok !== false || result?.skipped === true;
          } catch {}
        }
        if (sent) groups.noteSeen(join.groupId, { notifiedAt: new Date(now()).toISOString() });
        state.seen[join.groupId] = { ...seen, ...(sent ? { notifiedAt: true } : {}) };
        log("[alphaclaw] telegram join watch: new group=" + join.groupId + " notified=" + sent);
        outcomes.push({ groupId: join.groupId, action: sent ? "notified" : "notify_failed" });
      }
      return { joins: joins.length, outcomes };
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (timer) return;
    const tick = () => {
      check().catch((error) => log("[alphaclaw] telegram join watch failed: " + String(error?.message || error).slice(0, 200)));
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

module.exports = { createTelegramJoinWatch, parseJoinLine, resolveLogFiles };
