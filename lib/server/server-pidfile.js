const fs = require("fs");
const os = require("os");
const path = require("path");
// /proc identity primitives live in ONE module (issue #76 / CEO 5.1): the
// pidfile guard below reasons about start ticks, thread-group ids and the
// container's own birth without a local parser.
const {
  readProcStartTicks,
  readProcTgid,
  readContainerStartTicks,
  readContainerStartMs: readProcContainerStartMs,
} = require("./openclaw-lock-contention");

const kServerPidFileName = "alphaclaw-server.pid";

// The single-instance claim one `alphaclaw start` holds on the managed dir.
// bin/alphaclaw.js judges it before lib/server.js loads (a second start next
// to a live server must not run module-init side effects against the live
// databases — fix wave F004) and claims it; lib/server.js clears it on exit.
const createServerPidfile = ({
  managedDir,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
  // Identity seams (tests simulate a claim from another container by giving
  // it a different hostname, a planted /proc via fsModule, a liveness oracle
  // via killFn, and a container birth time).
  hostnameFn = os.hostname,
  killFn = process.kill.bind(process),
  // Wall-clock ms this container started (/proc/uptime + pid 1's start
  // ticks); null when /proc cannot say. Real clock on purpose — the value is
  // compared against pidfile `at` stamps, which production writes with
  // Date.now().
  readContainerStartMs = () => readProcContainerStartMs({ fsModule }),
} = {}) => {
  const serverPidPath = path.join(managedDir, kServerPidFileName);
  const writeJsonFile = (filePath, value) => {
    const dir = path.dirname(filePath);
    fsModule.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    fsModule.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    try {
      fsModule.renameSync(tempPath, filePath);
    } catch (error) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
  };

  // A pid alone is NOT an identity. The pidfile lives on the persistent
  // volume, so it outlives the process that wrote it — and a fresh container
  // on the same volume (or the same container after `docker restart` / an
  // intentional exit-75 restart) starts a new pid namespace where the SAME
  // small pid is alive again as a different process (the boot placeholder
  // child, the gateway launcher, ...). `process.kill(pid, 0)` then says
  // "live" for a claim nobody holds (container e2e "durability leg A",
  // 2026-09-04). The claim therefore records WHO holds it — hostname (a container's hostname
  // is its id), the process start time from /proc and, since format 2, the
  // container's own birth (pid 1's start ticks) — and liveness requires the
  // identity to match, not just the pid to exist.
  //
  // Two more lessons from issue #76 (RC1/RC2, 2026-09-06):
  //   - A pid number can name a THREAD. For a thread `tid` of process `pid`,
  //     `kill(tid, 0)` succeeds and `/proc/<tid>/cmdline` is the leader's
  //     argv, so a stale legacy `{pid, at}` claim whose number collides with
  //     one of OUR OWN V8/libuv threads passed both checks. `/proc/<tid>/status` `Tgid` settles it: `Tgid !== pid` is a
  //     thread, never a server; `Tgid === process.pid` is us.
  //   - A legacy claim that survives every check is still only a GUESS, so it
  //     must never wedge a box: it is permanently `corroborated: false` (the
  //     launcher can refuse to start only on evidence a real server wrote),
  //     and the boot guard CONVERGES it — rewriting it as a format-2 record
  //     that remembers the live process's start ticks (`observedTicks`) and
  //     this container's pid-1 ticks, but never `startTicks`. The next boot
  //     then proves a recycled pid (ticks differ) or a replaced container and
  //     proceeds, instead of skipping forever on a file nobody can clear.
  // `describeServerPidDecision()` is the ONE read-only judge of the file;
  // `readLiveServerPidEvidence()` is its `evidence` projection and
  // `convergeLegacyServerPidClaim()` its only writer, called ONCE per boot by
  // the bin-phase guard (boot-instance-guard.js) after the grace loop (never from the reader, the loop or
  // writeServerPid).

  // Start ticks (field 22 of /proc/<pid>/stat) — stable for the life of a
  // process, different for any later process that reuses the pid. null when
  // /proc is unavailable (macOS, restricted containers) or unreadable.
  // Shares the parser with the lock-contention diagnostics.
  const readProcessStartTicks = (pid) => {
    const ticks = readProcStartTicks(pid, { fsModule });
    return Number.isFinite(ticks) && ticks > 0 ? ticks : null;
  };

  // Legacy claims (pre-v0.9.73: {pid, at} only) and converged legacy claims
  // carry no start-tick identity. On Linux the process behind the pid must at
  // least LOOK like an alphaclaw SERVER: argv names the bin entry followed by
  // the `start` verb (`alphaclaw diagnose`, the `/usr/local/bin/alphaclaw`
  // shim invoked for any other verb, the boot placeholder child and the
  // gateway launcher are all live alphaclaw-ish processes that are NOT a
  // server). Without /proc, fall back to trusting liveness (the legacy
  // behaviour). Returns { cmdline, matched }: cmdline null = unreadable,
  // "" = kernel thread; matched null = no argv to judge (weak evidence — the
  // decision trusts liveness but convergence refuses to write anything).
  const kAlphaclawServerArgvPattern = /alphaclaw(\.js)?\s+start\b/;
  const kBootPlaceholderArgvPattern = /boot-placeholder-child/;
  const readArgvVerdict = (pid) => {
    let cmdline = null;
    try {
      cmdline = String(fsModule.readFileSync(`/proc/${pid}/cmdline`, "utf8"))
        .split("\0")
        .join(" ")
        .trim();
    } catch {
      return { cmdline: null, matched: null };
    }
    if (!cmdline) return { cmdline: "", matched: null };
    return {
      cmdline,
      matched:
        kAlphaclawServerArgvPattern.test(cmdline) &&
        !kBootPlaceholderArgvPattern.test(cmdline),
    };
  };

  const kServerPidFormat = 2;
  // A legacy claim older than the container by more than this margin was
  // written by a previous container: the estimate is centisecond-grained and
  // the two /proc reads are not atomic, so minutes, never milliseconds.
  const kPredatesContainerMarginMs = 5 * 60 * 1000;
  // Test harnesses run the store on small logical clocks; only a plausible
  // wall-clock ms stamp is compared against the container's birth.
  const kPlausibleWallClockMs = 1e12;

  const describeSelf = () => ({
    pid: process.pid,
    at: nowFn(),
    host: hostnameFn(),
    startTicks: readProcessStartTicks(process.pid),
    containerStartTicks: readContainerStartTicks({ fsModule }),
    format: kServerPidFormat,
  });

  const writeServerPid = () => {
    try {
      // Never clobber a LIVE foreign owner: a second start that loses the
      // port race would otherwise replace the real server's claim and then
      // clear it on exit, leaving the live server unguarded for a third start.
      const owner = readLiveServerPid();
      if (owner) return;
      writeJsonFile(serverPidPath, describeSelf());
    } catch {}
  };

  const clearServerPid = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(serverPidPath, "utf8"));
      if (parsed?.pid === process.pid) fsModule.unlinkSync(serverPidPath);
    } catch {}
  };

  const finitePositive = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // The PURE judge of the pidfile (reads only; never writes, never throws).
  // Returns the whole reasoning so the boot guard can log ONE audit line and the
  // boot report can persist it:
  //   evidence   the tri-state contract callers act on —
  //              null                        proceed (no live owner)
  //              { pid, corroborated: true } a live server provably owns the
  //                                          dir (launcher refuses to start)
  //              { pid, corroborated: false } alive but unverifiable (keep
  //                                          booting; the port bind settles it)
  //   decision   "proceed" | "skip"
  //   reason     absent | garbage | self | dead | kill_failed | own_thread |
  //              thread | other_host | recycled | corroborated |
  //              unverified_no_proc | other_container | predates_container |
  //              not_alphaclaw | legacy_argv_match | legacy_no_argv
  //   record     { raw, format: "legacy" | 1 | 2, legacyClaim } — legacyClaim
  //              is true for every record judged on the legacy path (a bare
  //              {pid, at} claim or a converged one), i.e. one that can never
  //              corroborate.
  // Decision order: parse → pid integer / self → killFn(pid, 0) → Tgid
  // (own_thread / thread) → host → start-tick identity (non-legacy records)
  // → container identity → legacy: predates_container → recycled
  // (observedTicks) → argv. EPERM from killFn keeps the historical meaning
  // (throw → null: a pid we may not signal is not a server we could race).
  const describeServerPidDecision = () => {
    const selfPid = process.pid;
    const liveContainerTicks = readContainerStartTicks({ fsModule });
    const base = {
      evidence: null,
      decision: "proceed",
      reason: "absent",
      record: { raw: null, format: null, legacyClaim: false },
      pid: null,
      killOk: null,
      tgid: null,
      selfPid,
      recordedTicks: null,
      liveTicks: null,
      recordedContainerTicks: null,
      liveContainerTicks,
      containerStartMs: null,
      claimAt: null,
      cmdline: null,
      argvMatched: null,
    };
    const proceed = (reason, extra = {}) => ({
      ...base,
      ...extra,
      evidence: null,
      decision: "proceed",
      reason,
    });
    const skip = (reason, pid, corroborated, extra = {}) => ({
      ...base,
      ...extra,
      evidence: { pid, corroborated },
      decision: "skip",
      reason,
    });
    let raw = null;
    try {
      raw = JSON.parse(fsModule.readFileSync(serverPidPath, "utf8"));
    } catch {
      return proceed("absent");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return proceed("garbage");
    }
    const startTicks = finitePositive(raw.startTicks);
    const legacyClaim = raw.legacyClaim === true || startTicks == null;
    const record = {
      raw,
      format:
        raw.format === kServerPidFormat ? kServerPidFormat : startTicks != null ? 1 : "legacy",
      legacyClaim,
    };
    const claimAt = Number.isFinite(Number(raw.at)) ? Number(raw.at) : null;
    const recordedContainerTicks = finitePositive(raw.containerStartTicks);
    const observedTicks = finitePositive(raw.observedTicks);
    const ctx = {
      record,
      claimAt,
      recordedContainerTicks,
      recordedTicks: startTicks ?? observedTicks,
    };
    const pid = Number(raw.pid);
    if (!Number.isInteger(pid) || pid <= 0) return proceed("garbage", ctx);
    ctx.pid = pid;
    if (pid === selfPid) return proceed("self", ctx);
    try {
      killFn(pid, 0);
      ctx.killOk = true;
    } catch (error) {
      ctx.killOk = false;
      return proceed(error?.code === "ESRCH" ? "dead" : "kill_failed", ctx);
    }
    // Tgid before anything argv- or host-shaped: a thread id passes kill()
    // and shows its leader's argv (RC1). Our own thread first — the more
    // specific verdict — then any other leader's thread.
    const tgid = readProcTgid(pid, { fsModule });
    ctx.tgid = tgid;
    if (tgid != null && tgid === selfPid) return proceed("own_thread", ctx);
    if (tgid != null && tgid !== pid) return proceed("thread", ctx);
    // Another container/host wrote this claim: its pid namespace is not
    // ours, so the pid cannot name a process we could be racing. A MATCHING
    // host proves nothing (a Render instance name survives a redeploy) — the
    // container identity below is what tells a fresh container apart.
    if (typeof raw.host === "string" && raw.host && raw.host !== hostnameFn()) {
      return proceed("other_host", ctx);
    }
    const liveTicks = readProcessStartTicks(pid);
    ctx.liveTicks = liveTicks;
    if (!legacyClaim) {
      // Identity claim (v0.9.73+): a different start time = a different
      // process reusing the pid.
      if (liveTicks != null && liveTicks !== startTicks) {
        return proceed("recycled", ctx);
      }
      return skip(
        liveTicks != null ? "corroborated" : "unverified_no_proc",
        pid,
        liveTicks != null,
        ctx,
      );
    }
    // Converged legacy claim from a previous container (pid 1 differs).
    if (
      recordedContainerTicks != null &&
      liveContainerTicks != null &&
      recordedContainerTicks !== liveContainerTicks
    ) {
      return proceed("other_container", ctx);
    }
    // Legacy / converged claim: no start-tick identity to compare.
    let containerStartMs = null;
    try {
      const estimate = Number(readContainerStartMs());
      containerStartMs = Number.isFinite(estimate) ? estimate : null;
    } catch {
      containerStartMs = null;
    }
    ctx.containerStartMs = containerStartMs;
    if (
      containerStartMs != null &&
      claimAt != null &&
      claimAt > kPlausibleWallClockMs &&
      claimAt < containerStartMs - kPredatesContainerMarginMs
    ) {
      return proceed("predates_container", ctx);
    }
    if (observedTicks != null && liveTicks != null && liveTicks !== observedTicks) {
      return proceed("recycled", ctx);
    }
    const argv = readArgvVerdict(pid);
    ctx.cmdline = argv.cmdline;
    ctx.argvMatched = argv.matched;
    if (argv.matched === false) return proceed("not_alphaclaw", ctx);
    // A legacy claim is permanently uncorroborated: the launcher must never
    // refuse to start on evidence AlphaClaw itself manufactured.
    return skip(
      argv.matched === true ? "legacy_argv_match" : "legacy_no_argv",
      pid,
      false,
      ctx,
    );
  };

  // Evidence about the recorded owner — the identity check from v0.9.73 (#64)
  // plus the `corroborated` flag the launcher acts on (fix wave F004). See
  // describeServerPidDecision for the tri-state contract.
  const readLiveServerPidEvidence = () => {
    try {
      return describeServerPidDecision().evidence;
    } catch {
      return null;
    }
  };

  // Returns the pid of a LIVE alphaclaw server other than this process, or
  // null. A dead/absent/self/foreign-host/recycled pid means the boot
  // may proceed.
  const readLiveServerPid = () => readLiveServerPidEvidence()?.pid ?? null;

  // Convergence (issue #76 RC2): rewrite a POSITIVELY identified raw legacy
  // claim as a format-2 record that can be disproved next boot. Positive
  // identification = the decision skipped on a legacy record whose live
  // process has a readable, MATCHING argv, is its own thread-group leader and
  // has readable start ticks. Weak evidence (no /proc, empty or unreadable
  // cmdline, no ticks) leaves the file untouched; an already converged record
  // is never rewritten (identity stays — Codex D9), so the pidfile changes at
  // most once per boot. Never writes `startTicks`: that field means "a real
  // server wrote this" and would let the next boot corroborate a guess.
  const convergeLegacyServerPidClaim = (decision) => {
    const raw = decision?.record?.raw;
    if (
      !decision ||
      decision.decision !== "skip" ||
      !decision.evidence ||
      decision.evidence.corroborated !== false ||
      !decision.record?.legacyClaim ||
      !raw ||
      typeof raw !== "object"
    ) {
      return { converged: false, reason: "not_legacy_skip" };
    }
    if (raw.legacyClaim === true || raw.format === kServerPidFormat) {
      return { converged: false, reason: "already_converged" };
    }
    if (decision.argvMatched !== true || !decision.cmdline) {
      return { converged: false, reason: "weak_argv" };
    }
    if (decision.tgid !== decision.pid) {
      return { converged: false, reason: "no_tgid" };
    }
    if (decision.liveTicks == null) {
      return { converged: false, reason: "no_ticks" };
    }
    const record = {
      pid: decision.pid,
      at: raw.at ?? null,
      upgradedAt: nowFn(),
      host: hostnameFn(),
      observedTicks: decision.liveTicks,
      containerStartTicks: decision.liveContainerTicks,
      format: kServerPidFormat,
      legacyClaim: true,
    };
    try {
      writeJsonFile(serverPidPath, record);
      return { converged: true, record };
    } catch (error) {
      logger.warn?.(
        `[alphaclaw] failed to converge legacy pidfile claim: ${error.message}`,
      );
      return { converged: false, reason: "write_failed", error: error.message };
    }
  };

  return {
    serverPidPath,
    writeServerPid,
    clearServerPid,
    describeServerPidDecision,
    readLiveServerPidEvidence,
    readLiveServerPid,
    convergeLegacyServerPidClaim,
    readProcessStartTicks,
  };
};

// ONE audit line per boot from a describeServerPidDecision() record, e.g.
//   format=legacy pid=21 kill=ok tgid=18 self=18 ticks=–/– container=3431/3431 → own_thread (proceed)
// Pure; tolerates a partial or null record (never throws into the boot).
const formatServerPidDecision = (decision) => {
  const d = decision && typeof decision === "object" ? decision : {};
  const show = (value) => (value == null ? "–" : String(value));
  const kill = d.killOk == null ? "–" : d.killOk ? "ok" : "fail";
  return (
    `format=${show(d.record?.format)} pid=${show(d.pid)} kill=${kill} ` +
    `tgid=${show(d.tgid)} self=${show(d.selfPid)} ` +
    `ticks=${show(d.recordedTicks)}/${show(d.liveTicks)} ` +
    `container=${show(d.recordedContainerTicks)}/${show(d.liveContainerTicks)} ` +
    `→ ${show(d.reason)} (${show(d.decision)})`
  );
};

module.exports = { kServerPidFileName, createServerPidfile, formatServerPidDecision };
