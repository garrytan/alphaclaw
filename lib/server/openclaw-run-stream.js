const path = require("path");
const { processGroupHasWriters } = require("./process-group");

// clawCmd (commands.js) uses child_process.exec with a short timeout and
// Node's default 1MB maxBuffer, which kills long-running operations like
// `openclaw update --channel dev` mid-build. This module is a spawn-based
// streaming runner for those long operations (updater, backups): no shell,
// no output buffering limit, output streamed to a callback and appended to a
// log file, with SIGTERM -> SIGKILL timeout escalation.
const kDefaultTimeoutMs = 30 * 60 * 1000;
const kDefaultKillGraceMs = 10 * 1000;
const kTailMaxBytes = 64 * 1024;
// How often the inactivity policy re-reads `progressProbe` (see runStreamed).
const kInactivityPollMs = 5 * 1000;

const createRunStream = ({
  spawnImpl = require("child_process").spawn,
  fsModule = require("fs"),
  processGroupAlive = processGroupHasWriters,
} = {}) => {
  const runStreamed = ({
    command,
    args = [],
    env = process.env,
    cwd = undefined,
    timeoutMs = kDefaultTimeoutMs,
    killGraceMs = kDefaultKillGraceMs,
    logFile = null,
    onOutput = null,
    // Written to the child's stdin then closed. Used to hand a large prompt
    // to `claude -p` without blowing the ~128KB argv limit (E2BIG) or leaking
    // it through `ps`.
    input = null,
    // Callers that parse a machine contract from the tail (the dev updater's
    // final JSON report exceeds 64KB) can raise this per run.
    tailBytes = kTailMaxBytes,
    // Inactivity policy (v0.9.81, cross-model D15): a child that neither
    // prints anything nor moves `progressProbe`'s value for this long is
    // stopped exactly like a timeout (SIGTERM → SIGKILL after killGraceMs)
    // and the result says `stalled: true` instead of `timedOut`. 0 = off.
    // The hard `timeoutMs` ceiling still applies on top. A slow child that
    // keeps writing bytes (probe grows) or lines (chunks arrive) is never cut.
    inactivityTimeoutMs = 0,
    // `() => number | null` — anything comparable with `!==`; a changed value
    // counts as activity. Errors thrown by the probe are treated as "no
    // change" (a broken probe must never fail or prolong the run).
    progressProbe = null,
    signal = null,
    deadlineAt = null,
    onProcess = null,
  }) =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      let tailBuffer = Buffer.alloc(0);
      let tailTruncated = false;
      let timedOut = false;
      let stalled = false;
      let killed = false;
      let settled = false;
      let termTimer = null;
      let killTimer = null;
      let inactivityTimer = null;
      let groupTimer = null;
      let leaderResult = null;
      let escalating = false;
      let cancelled = false;
      let lastActivityAt = startedAt;
      let lastProbeValue = null;
      let logStream = null;
      let logStreamFailed = false;
      const noteProcess = (phase) => {
        try { onProcess?.({ pid: child?.pid ?? null, phase }); } catch {}
      };

      const appendTail = (chunk) => {
        tailBuffer = Buffer.concat([tailBuffer, chunk]);
        if (tailBuffer.length > tailBytes) {
          // The window slide can bisect a line (or a secret) at the front;
          // `truncated` lets redacting callers drop the partial first line.
          tailTruncated = true;
          tailBuffer = tailBuffer.subarray(tailBuffer.length - tailBytes);
        }
      };

      const finish = (partial) => {
        if (settled) return;
        settled = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (groupTimer) clearTimeout(groupTimer);
        signal?.removeEventListener("abort", onAbort);
        noteProcess("cleaned");
        const complete = () =>
          resolve({
            ok: false,
            code: null,
            signal: null,
            timedOut,
            stalled,
            killed,
            cancelled,
            durationMs: Date.now() - startedAt,
            logFile: logFile || null,
            tail: tailBuffer.toString("utf8"),
            truncated: tailTruncated,
            ...partial,
          });
        if (logStream && !logStreamFailed) {
          // Flush and close the log file before resolving so callers can
          // read a complete log immediately after the promise settles.
          logStream.once("close", complete);
          logStream.end();
        } else {
          complete();
        }
      };

      let child;
      const onAbort = () => {
        cancelled = true;
        if (child) escalate();
      };
      if (signal?.aborted || (deadlineAt != null && Date.now() >= deadlineAt)) {
        cancelled = !!signal?.aborted;
        timedOut = !cancelled;
        finish({ error: cancelled ? "operation cancelled before spawn" : "operation deadline exhausted before spawn" });
        return;
      }
      if (logFile) {
        try {
          fsModule.mkdirSync(path.dirname(logFile), { recursive: true });
          logStream = fsModule.createWriteStream(logFile, { flags: "a" });
          logStream.on("error", () => {
            logStreamFailed = true;
          });
        } catch (error) {
          finish({ error: `Failed to open log file: ${error.message}` });
          return;
        }
      }

      try {
        child = spawnImpl(command, args, {
          env,
          cwd,
          stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
          // Own process group so a timeout kill reaps grandchildren too — a
          // timed-out `openclaw update`/pnpm build would otherwise keep
          // mutating the shared checkout for tens of minutes.
          detached: true,
        });
      } catch (error) {
        finish({ error: error.message });
        return;
      }
      noteProcess("running");

      const handleChunk = (streamName) => (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        lastActivityAt = Date.now();
        appendTail(chunk);
        if (logStream && !logStreamFailed) logStream.write(chunk);
        if (typeof onOutput === "function") {
          try {
            onOutput(chunk.toString("utf8"), streamName);
          } catch {
            // Output observers must never break the run itself.
          }
        }
      };
      if (child.stdout) child.stdout.on("data", handleChunk("stdout"));
      if (child.stderr) child.stderr.on("data", handleChunk("stderr"));
      if (input != null && child.stdin) {
        // A closed-early reader (child exits before draining) surfaces as
        // EPIPE on stdin — swallow it; the exit code is the real signal.
        child.stdin.on("error", () => {});
        try {
          child.stdin.end(String(input));
        } catch {}
      }

      const killChild = (signal) => {
        killed = true;
        try {
          // Negative pid = the whole process group (grandchildren included).
          if (!Number.isInteger(child.pid) || child.pid <= 1) throw new Error("no owned process group");
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // Process already gone; the close handler settles the result.
          }
        }
      };

      const escalate = () => {
        if (escalating || settled) return;
        escalating = true;
        noteProcess("terminating");
        killChild("SIGTERM");
        if (killTimer) clearTimeout(killTimer);
        killTimer = setTimeout(() => {
          killChild("SIGKILL");
          checkGroup();
        }, signal?.reason === "shutdown" ? Math.min(killGraceMs, 1000) : killGraceMs);
        killTimer.unref();
      };
      // Close means the leader's pipes drained, not that its writers exited.
      // Keep escalation alive until the entire owned group can no longer write.
      const checkGroup = () => {
        if (settled || !leaderResult) return;
        if (processGroupAlive(child.pid)) {
          if (!groupTimer) groupTimer = setTimeout(() => {
            groupTimer = null;
            checkGroup();
          }, 100);
          return;
        }
        finish({ ...leaderResult, ok: leaderResult.code === 0 && !timedOut && !stalled && !cancelled && !leaderResult.error });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const effectiveTimeoutMs = deadlineAt == null ? timeoutMs : Math.min(
        timeoutMs > 0 ? timeoutMs : Infinity, Math.max(0, deadlineAt - Date.now()),
      );
      if (Number.isFinite(effectiveTimeoutMs) && (effectiveTimeoutMs > 0 || deadlineAt != null)) {
        termTimer = setTimeout(() => {
          timedOut = true;
          escalate();
        }, effectiveTimeoutMs);
        termTimer.unref();
      }
      if (Number.isFinite(inactivityTimeoutMs) && inactivityTimeoutMs > 0) {
        // Re-armed setTimeout chain (never a bare interval): each check reads
        // the probe — a changed value is activity — then either declares the
        // stall or sleeps until the window would elapse from the last
        // activity. The probe is polled at most every kInactivityPollMs so a
        // silent-but-writing child is noticed within seconds, not a window.
        const pollMs = Math.max(1, Math.min(inactivityTimeoutMs, kInactivityPollMs));
        const readProbe = () => {
          if (typeof progressProbe !== "function") return;
          let value;
          try {
            value = progressProbe();
          } catch {
            return;
          }
          if (value !== lastProbeValue) {
            lastProbeValue = value;
            lastActivityAt = Date.now();
          }
        };
        const check = () => {
          if (settled || timedOut || stalled) return;
          readProbe();
          const idleMs = Date.now() - lastActivityAt;
          if (idleMs >= inactivityTimeoutMs) {
            stalled = true;
            escalate();
            return;
          }
          inactivityTimer = setTimeout(check, Math.min(pollMs, inactivityTimeoutMs - idleMs));
          inactivityTimer.unref();
        };
        readProbe(); // the baseline value; "changed" is judged against it.
        inactivityTimer = setTimeout(check, pollMs);
        inactivityTimer.unref();
      }

      child.on("error", (error) => {
        if (!child.pid) finish({ error: error.message });
        else {
          leaderResult = { error: error.message, code: null, signal: null };
          escalate();
          checkGroup();
        }
      });

      // "close" (not "exit") so stdout/stderr are fully drained before the
      // tail and log file are finalized.
      child.on("close", (code, signal) => {
        leaderResult = { ...leaderResult, code, signal };
        checkGroup();
      });
    });

  return { runStreamed };
};

module.exports = { createRunStream };
