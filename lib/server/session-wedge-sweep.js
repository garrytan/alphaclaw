// Post-relaunch lost-turn check (ALPH-17 PR 6, rewritten for OpenClaw
// 2026.11.5+ in ALPH-131): a safety net after every gateway launch (an
// AlphaClaw restart, a crash or OOM relaunch, a boot).
//
// OpenClaw 2026.11.5 (openclaw/openclaw#185730) resumes running sessions by
// itself after a graceful stop: shutdown marks every root session with live
// work, and the next gateway gives each one an ordinary "The Gateway
// restarted while you were working" input. It retired sessions.recover, the
// restart tombstones and the recovery log lines this check used to wait on,
// so after a graceful restart there is nothing for AlphaClaw to clear.
//
// A crash, a SIGKILL (the watchdog's or the kernel's out-of-memory kill) or a
// container that dies writes no marker, and OpenClaw accepts that as lossy:
// the turn that was running is gone and nothing resumes it. Its session row
// still shows it: a run that started before this launch, never ended (no
// endedAt) and has no status, with no active run now. One owner notice per
// launch names those turns, so someone can send a message there to pick the
// work up again. It only reads sessions.list; it never resets a session,
// never reads SQLite and never retries anything.
const { probeGatewayReadiness } = require("./gateway-readiness");
const { kGatewayRestartReadyTimeoutMs } = require("./constants");
const { sanitizeLabel } = require("./utils/sanitize-label");
const { callGateway } = require("./gateway-call");

const kSettleAfterReadyMs = 90_000;
const kSweepReadyTimeoutMs = Math.max(kGatewayRestartReadyTimeoutMs, 30 * 60 * 1000);
const kReadyPollMs = 5_000;
// A boot has no earlier check in this process to bound the look-back, so it
// reaches back this far; a relaunch reaches back to the launch of the last
// check that read the sessions (a superseded or failed check moves nothing).
const kBootLookbackMs = 6 * 60 * 60 * 1000;
const kListLimit = 200;

const kWedgeReasons = Object.freeze({
  LOST: "lost",
});

// The turns the last gateway was running when it stopped without marking
// them: started before this launch and after sinceMs, never ended, no
// status, no active run. A session skip() names (a Doctor session whose
// restarted turn AlphaClaw stopped itself, doctor/resumed-turns.js) is left
// alone.
const classifySessions = ({ rows = [], launchAtMs, sinceMs, skip = () => false }) => {
  const lost = [];
  for (const row of rows) {
    if (!row || typeof row.key !== "string" || row.hasActiveRun === true) continue;
    const startedAt = Number(row.startedAt);
    if (!Number.isFinite(startedAt) || startedAt >= launchAtMs || startedAt < sinceMs) continue;
    if (row.endedAt != null || row.status != null) continue;
    if (skip(row.key, Number(row.updatedAt))) continue;
    lost.push({ row, reason: kWedgeReasons.LOST });
  }
  return { lost };
};

const createSessionWedgeSweep = ({
  clawCmd,
  notify = null,
  insertEvent = null,
  resolveReadyzUrl = () => "",
  probeReadiness = probeGatewayReadiness,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  now = () => Date.now(),
  settleAfterReadyMs = kSettleAfterReadyMs,
  readyTimeoutMs = kSweepReadyTimeoutMs,
  skipSession = () => false,
} = {}) => {
  let jobSeq = 0;
  let pendingJob = null;
  let checkedThroughMs = null;
  const alerted = new Set();

  const log = (line) => console.log(`[alphaclaw] wedge-sweep ${line}`);
  const record = (status, details) => {
    try {
      insertEvent?.({ eventType: "session_wedge", source: "wedge_sweep", status, details });
    } catch {}
  };

  const sweep = async ({ generation = null, launchAtMs, sinceMs, isCurrent = () => true }) => {
    const { ok, body } = await callGateway(clawCmd, "sessions.list", {
      activeMinutes: Math.ceil(Math.max(0, now() - sinceMs) / 60_000) + 1,
      limit: kListLimit,
      rowMode: "compact",
    });
    if (!isCurrent()) return { skipped: "superseded" };
    if (!ok || !Array.isArray(body?.sessions)) {
      log(`skipped generation=${generation ?? "-"} reason=read_failed`);
      return { skipped: "read_failed" };
    }
    checkedThroughMs = Math.max(checkedThroughMs ?? 0, launchAtMs);
    const { lost } = classifySessions({ rows: body.sessions, launchAtMs, sinceMs, skip: skipSession });
    const fresh = lost.filter(({ row }) => !alerted.has(`${row.key}|${row.sessionId || ""}|${row.startedAt}`));
    for (const { row, reason } of fresh) {
      alerted.add(`${row.key}|${row.sessionId || ""}|${row.startedAt}`);
      log(`alerted session=${sanitizeLabel(row.key, { maxLength: 120 })} reason=${reason} generation=${generation ?? "-"}`);
      record("alerted", { sessionKey: row.key, agentId: row.agentId || null, reason, generation });
    }
    if (fresh.length && typeof notify === "function") {
      const lines = fresh.map(({ row }) => `• ${sanitizeLabel(row.displayName || row.label || row.key, { maxLength: 80 })}`);
      try {
        await notify(
          [
            "🐺 *AlphaClaw Watchdog*",
            `⚠️ The gateway stopped without a clean shutdown, so ${fresh.length === 1 ? "a turn it was running was" : `${fresh.length} turns it was running were`} lost:`,
            ...lines,
            "OpenClaw resumes running turns only after a clean restart. Send a message in that session to pick the work up again.",
          ].join("\n"),
          { eventType: "session_wedge", id: `session-lost-${generation ?? launchAtMs}` },
        );
      } catch {}
    }
    log(`done generation=${generation ?? "-"} checked=${body.sessions.length} lost=${fresh.length}`);
    return { alerted: fresh.map(({ row }) => row.key) };
  };

  // Every launch (restart, crash relaunch, boot) schedules one check once the
  // new gateway is ready and has had time to resume marked work. A newer
  // launch supersedes a pending one. A managed cold restart notifies its
  // launch twice (the "listening" line, then /readyz ready): the second
  // notice for a generation already pending joins that check.
  const onGatewayLaunch = ({ generation = null, startedAt = null } = {}) => {
    if (generation != null && pendingJob?.seq === jobSeq && pendingJob.generation === generation) {
      return pendingJob.promise;
    }
    const seq = ++jobSeq;
    const isCurrent = () => seq === jobSeq;
    const launchAtMs = Number.isFinite(Number(startedAt)) ? Number(startedAt) : now();
    const sinceMs = checkedThroughMs ?? launchAtMs - kBootLookbackMs;
    const promise = (async () => {
      const deadline = now() + readyTimeoutMs;
      for (;;) {
        if (!isCurrent()) return { skipped: "superseded" };
        const observation = await probeReadiness({ url: resolveReadyzUrl() }).catch(() => null);
        if (observation?.ok && observation.kind === "ready") break;
        if (now() >= deadline) {
          log(`skipped generation=${generation ?? "-"} reason=not_ready`);
          return { skipped: "not_ready" };
        }
        await sleep(kReadyPollMs);
      }
      await sleep(settleAfterReadyMs);
      if (!isCurrent()) return { skipped: "superseded" };
      return sweep({ generation, launchAtMs, sinceMs, isCurrent });
    })().catch((error) => {
      log(`failed generation=${generation ?? "-"} error=${sanitizeLabel(error?.message || error, { maxLength: 160 })}`);
      return { skipped: "error" };
    });
    pendingJob = { seq, generation, promise };
    return promise;
  };

  return { onGatewayLaunch, sweep };
};

module.exports = { createSessionWedgeSweep, classifySessions, kWedgeReasons };
