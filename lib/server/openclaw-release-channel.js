const fs = require("fs");
const path = require("path");
const os = require("os");
const constants = require("./constants");
// /proc identity primitives live in ONE module (issue #76 / CEO 5.1): the
// pidfile guard below reasons about start ticks, thread-group ids and the
// container's own birth without a store-local parser.
const {
  readProcStartTicks,
  readProcTgid,
  readContainerStartTicks,
  readContainerStartMs: readProcContainerStartMs,
} = require("./openclaw-lock-contention");

const kManagedDirName = ".alphaclaw";
const kChannelStateFileName = "openclaw-channel-state.json";
const kRollbackMarkerFileName = "openclaw-rollback-pending.json";
const kServerPidFileName = "alphaclaw-server.pid";
const kBinShimDirName = "bin";
const kBinShimName = "openclaw";
const kOverlayStoreDirName = "openclaw-overlay";
const kOverlayCompleteFileName = ".overlay-complete.json";
const kOpenclawPackageName = "openclaw";
const kOpenclawActivationSentinelName = constants.kOpenclawActivationSentinelName;
const kBinShimTargetPattern = /^exec node "(.+)" "\$@"\s*$/m;

const normalizeApplied = (applied) => {
  if (!applied || typeof applied !== "object" || Array.isArray(applied)) {
    return null;
  }
  return {
    channel: typeof applied.channel === "string" ? applied.channel : null,
    version: typeof applied.version === "string" ? applied.version : null,
    sha: typeof applied.sha === "string" ? applied.sha : null,
    at: applied.at ?? null,
    acceptedAt: applied.acceptedAt ?? null,
    // "manual" (Mark as good now) disarms the stabilization window entirely;
    // "acceptance" (auto, 120s of health) keeps the 24h window armed.
    acceptedSource:
      typeof applied.acceptedSource === "string" ? applied.acceptedSource : null,
    reason: typeof applied.reason === "string" ? applied.reason : null,
    // The apply operation that produced this build (stamped by applyUpdate).
    // The auto-acceptance notification is keyed `apply-accepted-<operationId>`
    // so a boot loop dedupes; state files written before this field existed
    // load as null and fall back to the `<appliedId>-<acceptedAt>` id.
    operationId:
      typeof applied.operationId === "string" ? applied.operationId : null,
  };
};

const normalizeLastKnownGood = (lastKnownGood) => {
  const base =
    lastKnownGood && typeof lastKnownGood === "object" && !Array.isArray(lastKnownGood)
      ? lastKnownGood
      : {};
  return {
    package: typeof base.package === "string" ? base.package : null,
    dev: typeof base.dev === "string" ? base.dev : null,
  };
};

const normalizeBlocklistEntry = (entry) => {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    typeof entry.id !== "string" ||
    entry.id === ""
  ) {
    return null;
  }
  return {
    id: entry.id,
    reason: typeof entry.reason === "string" ? entry.reason : null,
    exitCode: Number.isFinite(entry.exitCode) ? entry.exitCode : null,
    at: entry.at ?? null,
  };
};

const normalizeBlocklist = (blocklist) => {
  if (!Array.isArray(blocklist)) return [];
  const seen = new Set();
  const entries = [];
  for (const raw of blocklist) {
    const entry = normalizeBlocklistEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
};

const normalizePlainObjectOrNull = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

// The last whole-file settings replacement the boot config gate performed
// (issue #76 A5): which backup was copied over openclaw.json, where the
// pre-restore copy and the key-path diff live, and the boot that did it
// (`bootId` = getProcessBootId(), so a later undo can prove it was THIS boot).
// `source` names the path: round_trip / rollback / migration_gate.
const normalizeLastRestore = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const str = (field) => (typeof value[field] === "string" ? value[field] : null);
  return {
    at: Number.isFinite(value.at) ? value.at : null,
    from: str("from"),
    previousCompletedForVersion: str("previousCompletedForVersion"),
    diffPath: str("diffPath"),
    preRestorePath: str("preRestorePath"),
    bootId: str("bootId"),
    source: str("source"),
  };
};

// Boot config-migration progress. `completedForVersion` advances ONLY on a
// successful `doctor --fix`, so a failed attempt leaves the trigger armed to retry
// next boot (a failed migration must not become permanent).
const normalizeConfigMigration = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lastAttempt =
    value.lastAttempt && typeof value.lastAttempt === "object" && !Array.isArray(value.lastAttempt)
      ? {
          version:
            typeof value.lastAttempt.version === "string"
              ? value.lastAttempt.version
              : null,
          at: value.lastAttempt.at ?? null,
          ok: value.lastAttempt.ok === true,
          error:
            typeof value.lastAttempt.error === "string"
              ? value.lastAttempt.error
              : null,
          // Cross-boot re-attempt gate (issue #20): hash of
          // (config + installedVersion + reconciler policy version). A failed
          // reconcile re-runs only when this changes or the operator clears
          // the hold — never a 30-minute doctor per crash-loop restart.
          gateHash:
            typeof value.lastAttempt.gateHash === "string"
              ? value.lastAttempt.gateHash
              : null,
          tail:
            typeof value.lastAttempt.tail === "string"
              ? value.lastAttempt.tail
              : null,
        }
      : null;
  return {
    completedForVersion:
      typeof value.completedForVersion === "string"
        ? value.completedForVersion
        : null,
    lastAttempt,
    lastRestore: normalizeLastRestore(value.lastRestore),
  };
};

// Intent stamp for the boot config gate (issue #76 RC3): the last time the
// EXPECTED build changed, who changed it and whether it succeeded. Written by
// applyUpdate (source operator_apply), by rollback-marker consumption
// (rollback) and by a declared-pin bump (pin_bump); read by
// describeVersionRegressionIntent, which honours it only when `ok` is true,
// it is unconsumed (`consumedAt` null) and at most 7 days old. `kind` orders
// `from`→`to` (a dev apply has no order: "dev"). Unknown kinds/sources
// normalize to null so a record written by a newer AlphaClaw can never
// authorize anything here.
const kTransitionKinds = new Set(["upgrade", "downgrade", "same", "dev"]);
const kTransitionSources = new Set(["operator_apply", "rollback", "pin_bump"]);
const normalizeLastTransition = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.to !== "string" || !value.to) return null;
  return {
    at: Number.isFinite(value.at) ? value.at : null,
    from: typeof value.from === "string" ? value.from : null,
    to: value.to,
    kind: kTransitionKinds.has(value.kind) ? value.kind : null,
    source: kTransitionSources.has(value.source) ? value.source : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    operationId:
      typeof value.operationId === "string" ? value.operationId : null,
    // Tri-state: true = the transition landed, false = it failed, null = still
    // in flight (or written by a process that died before finishing).
    ok: value.ok === true ? true : value.ok === false ? false : null,
    consumedAt: Number.isFinite(value.consumedAt) ? value.consumedAt : null,
  };
};

// Pin-lag excuse (issue #76 RC4 / Codex D12): the pin_reconciled boot that
// found the installed tree still on the OLD pin after an AlphaClaw
// self-update — npm lag, not drift. Read by getChannelInfo's
// installedDiverged through channel-sync's pinLagExcuses/advancePinLag, which
// bound it to kPinLagMaxBoots boots / kPinLagMaxAgeMs. Whitelist only: a
// record that cannot name both the pin and the lagging tree excuses nothing
// and normalizes to null; a pre-bootId record without `bootsSeen` keeps null
// there (advancePinLag counts it as one boot).
const normalizePinLag = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.pin !== "string" || !value.pin) return null;
  if (typeof value.installed !== "string" || !value.installed) return null;
  return {
    pin: value.pin,
    installed: value.installed,
    at: Number.isFinite(value.at) ? value.at : null,
    bootId: typeof value.bootId === "string" ? value.bootId : null,
    bootsSeen: Number.isFinite(value.bootsSeen) ? value.bootsSeen : null,
  };
};

// First-class gateway hold (issue #20): the boot reconciler refuses to start
// the gateway on a build whose config could not be migrated. Explicit state —
// startup, watchdog, UI, and the retry actions all consume this instead of
// inferring "held" from the absence of a failure record.
//
// ONE hold model (issue #76, Codex 6): `reason` is either a migration-class
// free-text reason (the doctor/snapshot/gateway-running holds above) or a
// structural class token — `version_mismatch` (installed tree ≠ recorded
// build), `state_db_unreadable`, `activation_failed`. Structural holds carry
// `detail` (operator prose), `installed`/`expected` (the two versions) and
// `bootId` (the boot that set it); the reconciler's migration branches act
// only on migration-class reasons (isMigrationClassHold in channel-sync).
const normalizeGatewayHold = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.reason !== "string" || !value.reason) return null;
  const str = (field) => (typeof value[field] === "string" ? value[field] : null);
  return {
    reason: value.reason,
    at: typeof value.at === "number" ? value.at : null,
    operationId: str("operationId"),
    blamedKeys: Array.isArray(value.blamedKeys)
      ? value.blamedKeys.filter((key) => typeof key === "string").slice(0, 50)
      : [],
    detail: str("detail"),
    installed: str("installed"),
    expected: str("expected"),
    bootId: str("bootId"),
  };
};

const normalizePreviousPin = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.version !== "string" || !value.version) return null;
  return {
    version: value.version,
    at: value.at ?? null,
  };
};

const kPinWindowAcceptedSources = new Set(["manual", "acceptance"]);

// 24h stabilization window for a freshly bumped pin. `openedAt === null` means
// pending: the installed tree is not yet on the new pin.
const normalizePinWindow = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.version !== "string" || !value.version) return null;
  return {
    version: value.version,
    openedAt: Number.isFinite(value.openedAt) ? value.openedAt : null,
    acceptedAt: Number.isFinite(value.acceptedAt) ? value.acceptedAt : null,
    acceptedSource: kPinWindowAcceptedSources.has(value.acceptedSource)
      ? value.acceptedSource
      : null,
  };
};

const normalizeState = (raw) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  // `corrupted` is a read-time-only flag; it must never round-trip to disk.
  const { corrupted, ...rest } = base;
  return {
    ...rest,
    applied: normalizeApplied(base.applied),
    pinVersion: typeof base.pinVersion === "string" ? base.pinVersion : null,
    lastKnownGood: normalizeLastKnownGood(base.lastKnownGood),
    blocklist: normalizeBlocklist(base.blocklist),
    lastUpdateRun: normalizePlainObjectOrNull(base.lastUpdateRun),
    lastBoot: normalizePlainObjectOrNull(base.lastBoot),
    configMigration: normalizeConfigMigration(base.configMigration),
    lastTransition: normalizeLastTransition(base.lastTransition),
    pinLag: normalizePinLag(base.pinLag),
    gatewayHold: normalizeGatewayHold(base.gatewayHold),
    backups: Array.isArray(base.backups) ? base.backups : [],
    // Issue #21 recovery latches: a refused crash-rollback (no compatible
    // target), the one-shot forward-recovery attempt, and the terminal
    // "nothing bootable" flag. Cleared by mark-good / successful applies /
    // blocklist Clear.
    rollbackRefused: normalizePlainObjectOrNull(base.rollbackRefused),
    forwardRecovery: normalizePlainObjectOrNull(base.forwardRecovery),
    noBootableVersion: normalizePlainObjectOrNull(base.noBootableVersion),
    previousPin: normalizePreviousPin(base.previousPin),
    pinWindow: normalizePinWindow(base.pinWindow),
  };
};

const createOpenclawReleaseChannelStore = ({
  fsModule = fs,
  rootDir = constants.kRootDir,
  openclawDir = constants.OPENCLAW_DIR,
  nowFn = Date.now,
  logger = console,
  // Identity seams for the server pidfile guard (tests simulate a claim from
  // another container by giving it a different hostname, a planted /proc via
  // fsModule, a liveness oracle via killFn, and a container birth time).
  hostnameFn = os.hostname,
  killFn = process.kill.bind(process),
  // Wall-clock ms this container started (/proc/uptime + pid 1's start
  // ticks); null when /proc cannot say. Real clock on purpose — the value is
  // compared against pidfile `at` stamps, which production writes with
  // Date.now().
  readContainerStartMs = () => readProcContainerStartMs({ fsModule }),
} = {}) => {
  const managedDir = path.join(openclawDir, kManagedDirName);
  const statePath = path.join(managedDir, kChannelStateFileName);
  const serverPidPath = path.join(managedDir, kServerPidFileName);
  const markerPath = path.join(managedDir, kRollbackMarkerFileName);
  const shimDir = path.join(managedDir, kBinShimDirName);
  const shimPath = path.join(shimDir, kBinShimName);
  const overlayStoreDir = path.join(rootDir, kOverlayStoreDirName);

  // Atomic write: state/marker files are rewritten constantly (step progress,
  // health acceptance) and a torn write must never surface — a corrupted state
  // file silently discards the blocklist/LKG/pin, and a torn rollback marker
  // parses as null, re-running the broken build. Temp file lives in the SAME
  // directory (cross-device rename is EXDEV on Docker volumes).
  const writeJsonFile = (filePath, value) => {
    const dir = path.dirname(filePath);
    fsModule.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.tmp`,
    );
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

  // --- server pid (single-instance guard for the destructive boot sync) ------
  //
  // A pid alone is NOT an identity. The pidfile lives on the persistent
  // volume, so it outlives the process that wrote it — and a fresh container
  // on the same volume (or the same container after `docker restart` / an
  // intentional exit-75 restart) starts a new pid namespace where the SAME
  // small pid is alive again as a different process (the boot placeholder
  // child, the gateway launcher, ...). `process.kill(pid, 0)` then says
  // "live", the destructive boot sync is skipped, the just-applied overlay
  // never activates, and the old pin runs against a state DB the new build
  // already migrated (container e2e "durability leg A", 2026-09-04). The
  // claim therefore records WHO holds it — hostname (a container's hostname
  // is its id), the process start time from /proc and, since format 2, the
  // container's own birth (pid 1's start ticks) — and liveness requires the
  // identity to match, not just the pid to exist.
  //
  // Two more lessons from issue #76 (RC1/RC2, 2026-09-06):
  //   - A pid number can name a THREAD. For a thread `tid` of process `pid`,
  //     `kill(tid, 0)` succeeds and `/proc/<tid>/cmdline` is the leader's
  //     argv, so a stale legacy `{pid, at}` claim whose number collides with
  //     one of OUR OWN V8/libuv threads passed both checks and skipped the
  //     sync. `/proc/<tid>/status` `Tgid` settles it: `Tgid !== pid` is a
  //     thread, never a server; `Tgid === process.pid` is us.
  //   - A legacy claim that survives every check is still only a GUESS, so it
  //     must never wedge a box: it is permanently `corroborated: false` (the
  //     launcher can refuse to start only on evidence a real server wrote),
  //     and the boot sync CONVERGES it — rewriting it as a format-2 record
  //     that remembers the live process's start ticks (`observedTicks`) and
  //     this container's pid-1 ticks, but never `startTicks`. The next boot
  //     then proves a recycled pid (ticks differ) or a replaced container and
  //     proceeds, instead of skipping forever on a file nobody can clear.
  // `describeServerPidDecision()` is the ONE read-only judge of the file;
  // `readLiveServerPidEvidence()` is its `evidence` projection and
  // `convergeLegacyServerPidClaim()` its only writer, called ONCE per boot by
  // syncAtBoot after the grace loop (never from the reader, the loop or
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
  // Returns the whole reasoning so syncAtBoot can log ONE audit line and the
  // boot report can persist it:
  //   evidence   the tri-state contract callers act on —
  //              null                        proceed (no live owner)
  //              { pid, corroborated: true } a live server provably owns the
  //                                          dir (launcher refuses to start)
  //              { pid, corroborated: false } alive but unverifiable (skip the
  //                                          destructive sync, keep booting)
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
  // null. A dead/absent/self/foreign-host/recycled pid means the boot sync
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
        `[release-channel] failed to converge legacy pidfile claim: ${error.message}`,
      );
      return { converged: false, reason: "write_failed", error: error.message };
    }
  };

  // --- state -----------------------------------------------------------------

  // getChannelInfo() sits on hot paths (status SSE every 2s per client,
  // watchdog probes), so identical re-reads are served from a parsed copy
  // keyed by the file's mtime — a stat per call instead of read+parse.
  let stateCache = null;

  const cloneState = (state) => JSON.parse(JSON.stringify(state));

  const readState = () => {
    let stat = null;
    try {
      stat = fsModule.statSync(statePath);
    } catch {
      stateCache = null;
      return normalizeState({});
    }
    if (
      stateCache &&
      stateCache.mtimeMs === stat.mtimeMs &&
      stateCache.size === stat.size
    ) {
      return cloneState(stateCache.state);
    }
    let raw = null;
    try {
      raw = fsModule.readFileSync(statePath, "utf8");
    } catch {
      stateCache = null;
      return normalizeState({});
    }
    try {
      const state = normalizeState(JSON.parse(raw));
      stateCache = { mtimeMs: stat.mtimeMs, size: stat.size, state };
      return cloneState(state);
    } catch (error) {
      stateCache = null;
      logger.warn?.(
        `[release-channel] corrupted channel state at ${statePath}: ${error.message}`,
      );
      return { ...normalizeState({}), corrupted: true };
    }
  };

  const writeState = (state) => {
    const normalized = normalizeState(state);
    writeJsonFile(statePath, normalized);
    try {
      const stat = fsModule.statSync(statePath);
      stateCache = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        state: cloneState(normalized),
      };
    } catch {
      stateCache = null;
    }
    return normalized;
  };

  const updateState = (mutatorFn) => {
    const state = readState();
    const returned = typeof mutatorFn === "function" ? mutatorFn(state) : undefined;
    const next =
      returned && typeof returned === "object" && !Array.isArray(returned)
        ? returned
        : state;
    return writeState(next);
  };

  const isBlocklisted = (id) =>
    readState().blocklist.some((entry) => entry.id === id);

  const addBlocklist = ({ id, reason, exitCode = null } = {}) =>
    updateState((state) => {
      if (state.blocklist.some((entry) => entry.id === id)) return state;
      state.blocklist.push({
        id,
        reason: typeof reason === "string" ? reason : null,
        exitCode,
        at: nowFn(),
      });
      return state;
    });

  const clearBlocklist = (id) =>
    updateState((state) => {
      state.blocklist =
        id === undefined
          ? []
          : state.blocklist.filter((entry) => entry.id !== id);
      // Blocklist "Clear → Try again" is the operator's retry path: a refusal
      // latched for that build must not survive the retry.
      if (
        state.rollbackRefused &&
        (id === undefined || state.rollbackRefused.blockedId === id)
      ) {
        state.rollbackRefused = null;
      }
      return state;
    });

  // --- rollback marker ---------------------------------------------------------

  const readMarker = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(markerPath, "utf8"));
      return normalizePlainObjectOrNull(parsed);
    } catch {
      return null;
    }
  };

  const writeMarker = (marker) => {
    try {
      writeJsonFile(markerPath, marker);
      return { ok: true };
    } catch (error) {
      logger.error?.(
        `[release-channel] failed to write rollback marker: ${error.message}`,
      );
      return { ok: false, error: error.message };
    }
  };

  const clearMarker = () => {
    try {
      fsModule.unlinkSync(markerPath);
    } catch {
      // Best effort: a missing marker is the desired end state anyway.
    }
  };

  // --- overlay store -----------------------------------------------------------

  // Versions reach this from API input; the route allowlist is the first line,
  // but a traversal-shaped name ("..", "a/b") aimed at rmSync/cpSync must be
  // structurally impossible here too.
  const assertSafeOverlayName = (version) => {
    const name = String(version || "");
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0")
    ) {
      throw new Error(`unsafe overlay name: ${JSON.stringify(version)}`);
    }
    const resolved = path.resolve(overlayStoreDir, name);
    if (!resolved.startsWith(overlayStoreDir + path.sep)) {
      throw new Error(`overlay path escapes the store: ${JSON.stringify(version)}`);
    }
    return name;
  };

  const overlayDir = (version) =>
    path.join(overlayStoreDir, assertSafeOverlayName(version));

  const overlayPackageDir = (version) =>
    path.join(overlayDir(version), kOpenclawPackageName);

  const overlayCompletePath = (version) =>
    path.join(overlayDir(version), kOverlayCompleteFileName);

  // Weaker than hasOverlay: the entry's directory exists (complete or not).
  // The boot audit uses it to name a half-saved overlay honestly instead of
  // reporting "no overlay" for a tree that is on disk.
  const overlayPresent = (version) => {
    if (typeof version !== "string" || version === "") return false;
    try {
      return fsModule.existsSync(overlayDir(version));
    } catch {
      return false;
    }
  };

  const hasOverlay = (version) => {
    if (typeof version !== "string" || version === "") return false;
    try {
      if (!fsModule.existsSync(overlayPackageDir(version))) return false;
      const complete = JSON.parse(
        fsModule.readFileSync(overlayCompletePath(version), "utf8"),
      );
      return complete?.version === version;
    } catch {
      return false;
    }
  };

  const saveOverlayFromTempInstall = ({ openclawPackageDir, version } = {}) => {
    try {
      const entryDir = overlayDir(version);
      // Tombstone first: rm's traversal order is unspecified, so the
      // completion file must be gone before the tree starts disappearing —
      // hasOverlay trusts it as proof of a complete copy.
      fsModule.rmSync(overlayCompletePath(version), { force: true });
      // A partial entry (mid-copy crash) must never be mistaken for a good one.
      fsModule.rmSync(entryDir, { recursive: true, force: true });
      fsModule.mkdirSync(entryDir, { recursive: true });
      fsModule.cpSync(openclawPackageDir, overlayPackageDir(version), {
        recursive: true,
      });
      // Completion file is written LAST so its presence proves a full copy.
      writeJsonFile(overlayCompletePath(version), {
        version,
        savedAt: nowFn(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  // Async variants for the LIVE apply path: cpSync of a multi-hundred-MB tree
  // blocks the event loop (SSE progress, /api/status, proxied gateway traffic)
  // for tens of seconds. Boot activation stays sync — it runs pre-server.
  const fsp = fsModule.promises || fs.promises;

  const saveOverlayFromTempInstallAsync = async ({
    openclawPackageDir,
    version,
  } = {}) => {
    try {
      const entryDir = overlayDir(version);
      // Tombstone first — see saveOverlayFromTempInstall.
      await fsp.rm(overlayCompletePath(version), { force: true });
      await fsp.rm(entryDir, { recursive: true, force: true });
      await fsp.mkdir(entryDir, { recursive: true });
      await fsp.cp(openclawPackageDir, overlayPackageDir(version), {
        recursive: true,
      });
      writeJsonFile(overlayCompletePath(version), {
        version,
        savedAt: nowFn(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const snapshotPinFromInstallAsync = async ({ installDir, pinVersion } = {}) => {
    if (hasOverlay(pinVersion)) {
      return { ok: true, alreadyPresent: true };
    }
    const result = await saveOverlayFromTempInstallAsync({
      openclawPackageDir: path.join(
        installDir,
        "node_modules",
        kOpenclawPackageName,
      ),
      version: pinVersion,
    });
    return result.ok ? { ok: true, alreadyPresent: false } : result;
  };

  const snapshotPinFromInstall = ({ installDir, pinVersion } = {}) => {
    if (hasOverlay(pinVersion)) {
      return { ok: true, alreadyPresent: true };
    }
    const result = saveOverlayFromTempInstall({
      openclawPackageDir: path.join(
        installDir,
        "node_modules",
        kOpenclawPackageName,
      ),
      version: pinVersion,
    });
    return result.ok ? { ok: true, alreadyPresent: false } : result;
  };

  // Async prune for the LIVE apply path — an overlay entry is a
  // multi-hundred-MB tree and rmSync would block SSE/status/proxy traffic.
  const pruneOverlaysAsync = async ({ keep = [] } = {}) => {
    const keepSet = new Set(keep);
    const removed = [];
    let entries = [];
    try {
      entries = fsModule.readdirSync(overlayStoreDir);
    } catch {
      return { removed };
    }
    for (const name of entries) {
      if (keepSet.has(name)) continue;
      try {
        // Tombstone first — a crash mid-delete must not leave a completion
        // file over a gutted tree that boot would then activate.
        await fsp.rm(path.join(overlayStoreDir, name, kOverlayCompleteFileName), {
          force: true,
        });
        await fsp.rm(path.join(overlayStoreDir, name), {
          recursive: true,
          force: true,
        });
        removed.push(name);
      } catch (error) {
        logger.warn?.(
          `[release-channel] failed to prune overlay ${name}: ${error.message}`,
        );
      }
    }
    return { removed };
  };

  const pruneOverlays = ({ keep = [] } = {}) => {
    const keepSet = new Set(keep);
    const removed = [];
    let entries = [];
    try {
      entries = fsModule.readdirSync(overlayStoreDir);
    } catch {
      return { removed };
    }
    for (const name of entries) {
      if (keepSet.has(name)) continue;
      try {
        // Tombstone first — see pruneOverlaysAsync.
        fsModule.rmSync(path.join(overlayStoreDir, name, kOverlayCompleteFileName), {
          force: true,
        });
        fsModule.rmSync(path.join(overlayStoreDir, name), {
          recursive: true,
          force: true,
        });
        removed.push(name);
      } catch (error) {
        logger.warn?.(
          `[release-channel] failed to prune overlay ${name}: ${error.message}`,
        );
      }
    }
    return { removed };
  };

  // --- live tree ------------------------------------------------------------

  const liveOpenclawDir = (installDir) =>
    path.join(installDir, "node_modules", kOpenclawPackageName);

  const sentinelPath = ({ installDir } = {}) =>
    path.join(installDir, "node_modules", kOpenclawActivationSentinelName);

  // Hot path: getChannelInfo() runs on the 2s status SSE tick per client.
  // The live package.json only changes on apply/boot — serve repeats from an
  // mtime-keyed cache like readState does.
  const installedVersionCache = new Map();

  const readInstalledVersion = ({ installDir } = {}) => {
    const pkgPath = path.join(liveOpenclawDir(installDir), "package.json");
    let stat = null;
    try {
      stat = fsModule.statSync(pkgPath);
    } catch {
      installedVersionCache.delete(pkgPath);
      return null;
    }
    const cached = installedVersionCache.get(pkgPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.version;
    }
    try {
      const pkg = JSON.parse(
        fsModule.readFileSync(pkgPath, "utf8"),
      );
      const version = typeof pkg?.version === "string" ? pkg.version : null;
      installedVersionCache.set(pkgPath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        version,
      });
      return version;
    } catch {
      installedVersionCache.delete(pkgPath);
      return null;
    }
  };

  const readSentinel = ({ installDir } = {}) => {
    try {
      const parsed = JSON.parse(
        fsModule.readFileSync(sentinelPath({ installDir }), "utf8"),
      );
      return normalizePlainObjectOrNull(parsed);
    } catch {
      return null;
    }
  };

  // A mid-copy crash leaves a plausible package.json behind, so the live tree's
  // version alone is never trusted: only the sentinel proves a completed copy.
  const needsActivation = ({ installDir, expectedVersion } = {}) => {
    const sentinel = readSentinel({ installDir });
    return !sentinel || sentinel.version !== expectedVersion;
  };

  const writeSentinel = ({ installDir, version } = {}) => {
    try {
      writeJsonFile(sentinelPath({ installDir }), {
        version,
        completedAt: nowFn(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const activateOverlay = ({ installDir, version } = {}) => {
    if (!hasOverlay(version)) {
      return {
        ok: false,
        error: `no complete overlay for openclaw@${version} in ${overlayStoreDir}`,
      };
    }
    // Belt-and-braces: staging only saves guard-free (lifecycle-complete) trees to
    // the overlay, but never activate one that still carries the install guard —
    // that would put an incomplete OpenClaw (missing bundled plugins) live.
    const overlayGuardPath = path.join(
      overlayPackageDir(version),
      "dist",
      "openclaw-install-guard",
    );
    if (fsModule.existsSync(overlayGuardPath)) {
      return {
        ok: false,
        error: `overlay for openclaw@${version} is incomplete (install guard present)`,
      };
    }
    try {
      // Re-activations start with a MATCHING sentinel on disk (drift repair);
      // it must be gone before the destructive copy or a mid-copy crash
      // leaves sentinel + plausible package.json validating a gutted tree.
      try {
        fsModule.unlinkSync(sentinelPath({ installDir }));
      } catch {}
      const liveDir = liveOpenclawDir(installDir);
      fsModule.rmSync(liveDir, { recursive: true, force: true });
      fsModule.cpSync(overlayPackageDir(version), liveDir, { recursive: true });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    // Sentinel is written LAST so a crash mid-copy leaves no sentinel behind.
    return writeSentinel({ installDir, version });
  };

  // --- bin shim ---------------------------------------------------------------

  const writeBinShim = ({ targetBin, label = "" } = {}) => {
    // The target path is embedded in a double-quoted sh string where $(), ``
    // and ${} still evaluate — a bin path shaped by a package's own
    // package.json must not be able to smuggle shell into the shim.
    const target = String(targetBin || "");
    if (!target || /["`$\\\n\r]/.test(target)) {
      return {
        ok: false,
        error: `refusing to write shim: unsafe target path ${JSON.stringify(target)}`,
      };
    }
    // Temp file lives in shimDir itself: renaming across the /data volume
    // boundary would fail with EXDEV on Docker.
    const tempPath = path.join(
      shimDir,
      `.${kBinShimName}-shim-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      fsModule.mkdirSync(shimDir, { recursive: true });
      const safeLabel = String(label || "").replace(/[^0-9A-Za-z.\-_@ ]/g, "");
      const content = `#!/bin/sh\n# alphaclaw release-channel shim (${safeLabel})\nexec node "${target}" "$@"\n`;
      fsModule.writeFileSync(tempPath, content);
      fsModule.chmodSync(tempPath, 0o755);
      fsModule.renameSync(tempPath, shimPath);
      return { ok: true };
    } catch (error) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch {
        // Best effort cleanup of the temp file.
      }
      return { ok: false, error: error.message };
    }
  };

  const removeBinShim = () => {
    try {
      fsModule.unlinkSync(shimPath);
      return { removed: true };
    } catch {
      return { removed: false };
    }
  };

  const readBinShimTarget = () => {
    try {
      const content = fsModule.readFileSync(shimPath, "utf8");
      const match = content.match(kBinShimTargetPattern);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  };

  // Standalone impostor sweep so the apply path can re-run it cheaply — the
  // shim dir sits first on PATH for the whole uptime, and a boot-only sweep
  // leaves the full uptime as a planting window.
  const sweepShimDir = () => {
    try {
      for (const name of fsModule.readdirSync(shimDir)) {
        if (name === kBinShimName) continue;
        try {
          fsModule.rmSync(path.join(shimDir, name), {
            recursive: true,
            force: true,
          });
          logger.warn?.(
            `[release-channel] removed unexpected file from shim dir: ${name}`,
          );
        } catch {}
      }
    } catch {}
  };

  const validateBinShim = () => {
    sweepShimDir();
    if (!fsModule.existsSync(shimPath)) {
      return { present: false, valid: false, removed: false };
    }
    const target = readBinShimTarget();
    // Shape alone is not enough: a planted shim pointing at any existing
    // file would pass an existence check. The target must live inside the
    // managed roots (overlay store or the dev checkout).
    const targetAllowed = (candidate) => {
      const resolved = path.resolve(String(candidate || ""));
      const checkoutRoot = path.resolve(rootDir, "openclaw");
      return (
        resolved.startsWith(path.resolve(overlayStoreDir) + path.sep) ||
        resolved.startsWith(checkoutRoot + path.sep)
      );
    };
    if (!target || !fsModule.existsSync(target) || !targetAllowed(target)) {
      const { removed } = removeBinShim();
      return { present: true, valid: false, removed };
    }
    return { present: true, valid: true, removed: false };
  };

  const resolvePackageBin = (packageDir) => {
    try {
      const pkg = JSON.parse(
        fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8"),
      );
      const bin = pkg?.bin;
      let relative = null;
      if (typeof bin === "string") {
        relative = bin;
      } else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
        relative =
          typeof bin[kOpenclawPackageName] === "string"
            ? bin[kOpenclawPackageName]
            : Object.values(bin).find((value) => typeof value === "string") ??
              null;
      }
      if (!relative) return null;
      const resolved = path.resolve(packageDir, relative);
      // A bin entry must stay inside its own package — "../" escapes get no shim.
      if (!resolved.startsWith(path.resolve(packageDir) + path.sep)) {
        return null;
      }
      return resolved;
    } catch {
      return null;
    }
  };

  return {
    // Every managed-dir path comes from the store — no module recomputes
    // `<openclawDir>/.alphaclaw` (constants.ALPHACLAW_DIR is the ROOT).
    managedDir,
    kManagedDirName,
    statePath,
    markerPath,
    shimDir,
    shimPath,
    overlayStoreDir,
    normalizeState,
    readState,
    writeState,
    updateState,
    isBlocklisted,
    addBlocklist,
    clearBlocklist,
    readMarker,
    writeMarker,
    clearMarker,
    overlayDir,
    overlayPackageDir,
    overlayCompletePath,
    overlayPresent,
    hasOverlay,
    saveOverlayFromTempInstall,
    saveOverlayFromTempInstallAsync,
    snapshotPinFromInstall,
    snapshotPinFromInstallAsync,
    pruneOverlays,
    pruneOverlaysAsync,
    readInstalledVersion,
    sentinelPath,
    readSentinel,
    needsActivation,
    activateOverlay,
    writeSentinel,
    writeBinShim,
    removeBinShim,
    readBinShimTarget,
    validateBinShim,
    sweepShimDir,
    serverPidPath,
    writeServerPid,
    clearServerPid,
    describeServerPidDecision,
    readLiveServerPidEvidence,
    readLiveServerPid,
    convergeLegacyServerPidClaim,
    // Exposed for tests that build a claim for a live child process.
    readProcessStartTicks,
    resolvePackageBin,
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

module.exports = {
  kOpenclawActivationSentinelName,
  kManagedDirName,
  createOpenclawReleaseChannelStore,
  formatServerPidDecision,
  normalizeState,
};
