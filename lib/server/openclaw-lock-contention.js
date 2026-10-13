// Read-only diagnostics for OpenClaw state-lifecycle lock CONTENTION.
//
// Incident 2026-09-01: a restart failed with "another OpenClaw process owns
// state-lifecycle" after a killed boot, and the responder read the leftover
// `/tmp/openclaw-state-locks-<uid>/` entry as a "stale lock". Verified against
// the openclaw 2026.9.1-beta.1 tarball (dist/state-database-coordinator-*.js,
// dist/node-sqlite-*.js): the coordinator is an exclusive SQLite transaction
// (`BEGIN EXCLUSIVE` on `<dir>/<family>.<hash>.lock.sqlite`) held by the
// owner's OPEN connection — a POSIX advisory lock the kernel releases the
// instant the holder dies. There is no lease row, no pid metadata, no expiry:
//   - a leftover lock FILE can never block anyone;
//   - "owns state-lifecycle" ALWAYS names a LIVE holder (or a busy-timeout
//     while one held it) — in the incident, the pre-restart process still
//     shutting down, which exited before the next attempt succeeded;
//   - deleting a held lock file would let a second acquirer take EXCLUSIVE on
//     a fresh inode — two owners of the state DB, the exact corruption the
//     coordinator prevents. So this module NEVER deletes anything.
// What helps a responder is knowing WHICH live process holds it. This mirrors
// upstream's own owner-status approach (dist/gateway-lock-*.js: /proc cmdline
// + isOpenClawArgv) to list live openclaw-ish processes, and appends that to
// restart-failure evidence and the boot log.
//
// This module also owns AlphaClaw's /proc PROCESS-IDENTITY primitives (start
// ticks, parent pid, Tgid, container start) so the pidfile guard, the gateway
// identity snapshot and the watchdog share one parser and one set of stamped
// kernel assumptions instead of store-local copies.
const fs = require("fs");
const os = require("os");

const kLockDirPattern = /^openclaw-state-locks(-\d+)?$/;
// Lifecycle-lock refusals + raw SQLite busy signatures (incident 2026-09-01),
// plus the state-owner contention refusal ("OpenClaw state database is busy
// at <path>. …", GatewayStateOwnerContentionError in 2026.10.2's
// dist/gateway-state-owner-*.mjs; also printed by 2026.9.8).
// "state-lifecycle" / "owns state-lifecycle" / "state-locks" are absent from
// the 2026.9.8 and 2026.10.2 dists (re-verified 2026-10-12) — legacy belts,
// harmless; "gateway-lifecycle" and the SQLite busy texts are still printed.
const kLifecycleContentionPattern =
  /owns (state|gateway)-lifecycle|state-lifecycle|gateway-lifecycle|state-locks|SQLITE_BUSY|database is locked|OpenClaw state database is busy at/i;
// State-lease failures (issue #54, verified against the 2026.9.1-beta.1 dist):
// the lease holder logs "SQLite transaction lock wait failed" when its UPDATE
// hits busy_timeout 0, then renew() throws OPENCLAW_STATE_LEASE_LOST
// ("<label> <scope>/<key> was lost"); acquire() fails with
// OPENCLAW_STATE_LEASE_TIMEOUT ("timed out waiting for <label> <scope>/<key>")
// after its 5 s wait or OPENCLAW_STATE_LEASE_STORAGE_FAILED ("failed to
// acquire <label> <scope>/<key>"). The word "lease" immediately before the
// <scope>/<key> token (one slash, no spaces) is what keeps "failed to
// acquire" / "timed out waiting for" from over-matching an ordinary URL or
// file path ("timed out waiting for https://host/path", "failed to acquire
// artifact /tmp/file") — a false lock_contention verdict would retry inside
// the quiesce and make the failure reuse-eligible. The label is several words
// on the real CLIs ("legacy audit migration lease", verified live on 2026.8.2
// and 2026.9.1-beta.1) and always ends in "lease", so the label slot is a
// bounded same-line span terminated by that word, never a single token.
// 2026.9.8 (the v0.9.98 pin, verified against its dist
// openclaw-state-lease-error-*.mjs) retired OPENCLAW_STATE_LEASE_TIMEOUT: an
// acquire that runs out its wait now throws OPENCLAW_STATE_LEASE_HELD
// ("<label> <scope>/<key> is held by <owner> (lease epoch N)"). The
// "(lease epoch N)" suffix is what anchors that wording. Unchanged on
// 2026.10.2 (re-verified 2026-10-12): LOST/HELD/STORAGE_FAILED, the lock-wait
// text and the "(lease epoch N)" wording are present; TIMEOUT is still absent
// and stays as a legacy belt.
const kStateLeasePattern =
  /SQLite transaction lock wait failed|OPENCLAW_STATE_LEASE_(?:LOST|TIMEOUT|HELD|STORAGE_FAILED)|\blease \S+\/\S+ was lost\b|timed out waiting for [^\n]{0,120}?\blease \S+\/\S+|failed to acquire [^\n]{0,120}?\blease \S+\/\S+|\S+\/\S+ is held by [^\n]{0,200}?\(lease epoch \d+\)/i;
// ONE source for both consumers: the restart/boot evidence path
// (looksLikeLockContention) and the backup classifier's lock_contention kind.
const kStateContentionPattern = new RegExp(
  `${kLifecycleContentionPattern.source}|${kStateLeasePattern.source}`,
  "i",
);
const kMaxCmdlineChars = 200;
const kMaxListed = 12;

// ── Gateway process patterns (two, deliberately different) ──────────────────
// EVIDENCE pattern: any gateway-ish openclaw process — a `gateway run` child,
// its launcher, the `openclaw-gateway` binary, but ALSO the one-shot CLI
// verbs (`gateway status|stop|restart|call`). Right for human evidence lines
// and lock-contention diagnostics, where an over-inclusive pid list is the
// safe direction.
const kGatewayProcessPattern = /(^|\s)gateway(\s|$)|openclaw-gateway/;
// SERVING pattern: only processes that can OWN the gateway port — the long-
// running `gateway run` worker (its compile-cache launcher included), or the
// `openclaw-gateway` binary. `gateway --force` is a legacy belt: AlphaClaw
// has launched only `gateway run` since v0.10.0; the alternative stays so a
// `--force` root started by an older AlphaClaw is still recognised. CLI verbs
// are excluded on purpose: a `gateway status` invoked by the operator (or by our
// own doctor) must never be adopted as the serving identity, sampled for
// memory, or counted as a second root that makes the identity ambiguous.
const kGatewayServingCmdlinePattern =
  /(^|\s)gateway\s+(run|--force)(\s|$)|openclaw-gateway/;

// Ownership-conflict wording a LOSING gateway contender prints on exit 1
// (verified against the published 2026.7.1-2 and 2026.9.1-beta.1 tarballs;
// re-verified 2026-10-12 against the 2026.9.8 and 2026.10.2 dists, see the
// legacy note below; registered in the TODOS belt-deletion list — upstream
// openclaw#121069 asks for a structured owner report). Three families:
//   gateway_conflict      another GATEWAY holds the port/lock: "another
//                         gateway instance is already listening", "gateway
//                         already running (pid N)", "existing gateway did not
//                         become healthy after …"
//   state_writer_conflict another OpenClaw STATE WRITER (an agent process, a
//                         migration, a live gateway) holds the state database:
//                         "failed to acquire gateway state ownership" — on
//                         2026.10.2 followed by "OpenClaw state database is
//                         busy at <path>. holder N at <host>[/pid-ns X], …"
//                         (dist/gateway-lock-*.mjs, gateway-state-owner-*.mjs)
//   owner_lease_held      the previous gateway's ownership record is still
//                         fresh and the starting gateway cannot prove its
//                         holder dead. Two upstream wordings, both names of
//                         the same wait:
//                         2026.9.4+: the gateway-owner LEASE row in the state
//                         database (state_leases, scope "gateway-owner") is
//                         inside its 300 s TTL — "Another Gateway owner lease
//                         is still active for this state directory" (2026.10.2
//                         appends ": holder N at <host>[/pid-ns X], last
//                         renewed S s ago. …").
//                         2026.10.2: the holder's record carries a different
//                         PID namespace (the previous container, or a sibling
//                         container on the same volume) and its heartbeat is
//                         younger than 90 s — GatewayLockNamespaceError in
//                         dist/gateway-state-owner-*.mjs: "cannot verify
//                         Gateway ownership from this process (different PID
//                         namespace); the owner heartbeat is fresh — … wait up
//                         to 90 seconds after its last heartbeat. holder N at
//                         <host>/pid-ns X, last renewed S s ago. …". Raised
//                         while acquiring state ownership (historical lock
//                         files, the lease pre-check) it is retried for up to
//                         95 s (GATEWAY_OWNER_HEARTBEAT_STALE_MS + 5 s,
//                         dist/gateway-lock-*.mjs) and exits 1 with the bare
//                         message; raised later (the state-lock projection,
//                         the owner-lease publish) it is wrapped ("failed to
//                         acquire gateway state ownership | cannot verify …"
//                         via formatErrorMessage's cause join), which must
//                         NOT read as a state writer. The
//                         holder is usually a corpse; the record lapses on its
//                         own — or it is a second live container, which the
//                         watchdog's lease re-read tells apart.
// Legacy belts: "failed to acquire gateway lock at", "state directory is
// locked by <role>", "another embedded OpenClaw state writer is active" and
// "owns state-lifecycle" are absent from both the 2026.9.8 and 2026.10.2
// dists. They are kept (harmless — nothing current prints them) for builds
// that did.
// This is classification of stderr, not a query of the upstream lock owner.
// The namespace refusal names a holder pid from ANOTHER pid namespace: never
// reported as holderPid, which the watchdog treats as a local pid (grace
// liveness, the Doctor liveness set).
const kOwnerNamespaceRefusalPattern =
  /cannot verify gateway ownership from this process \(different PID namespace\)/i;
const kOwnerLeaseHeldPattern = new RegExp(
  `another gateway owner lease is still active|${kOwnerNamespaceRefusalPattern.source}`,
  "i",
);
// 2026.10.2's file-lock path logs the namespace refusal ONCE as a warning
// before it starts waiting ("Waiting for the previous Gateway's owner
// heartbeat to expire before reclaiming state (up to N seconds). cannot
// verify …", dist/gateway-lock-*.mjs). That line is progress, not an exit
// reason: a gateway that then acquired ownership and later died for another
// cause must not be read as an ownership conflict, so such a line is skipped.
const kOwnerHeartbeatWaitPattern =
  /waiting for the previous gateway's owner heartbeat to expire before reclaiming state/i;
const kGatewayOwnershipConflictPattern =
  /another gateway instance is already listening|gateway already running|failed to acquire gateway lock at|owns state-lifecycle|state directory is locked by|another embedded openclaw state writer is active|failed to acquire gateway state ownership|existing gateway did not become healthy|another gateway owner lease is still active|cannot verify gateway ownership from this process \(different PID namespace\)/i;
// Kinds neither Doctor nor `gateway stop` can resolve — the holder is a
// transient writer or an unverifiable corpse — so the watchdog gives them
// backoff relaunches only (and, for the lease, waits for its recorded expiry).
const kTransientConflictKinds = Object.freeze(new Set(["state_writer_conflict", "owner_lease_held"]));
const kStateWriterConflictPattern =
  /state directory is locked by|another embedded openclaw state writer|failed to acquire gateway state ownership/i;
// "(pid N)" (the 2026.9.x wordings) or 2026.10.2's describeGatewayLockHolder
// "holder N at <host>[/pid-ns X]" ("holder unknown at …" names none). Not read
// from a namespace-refusal line (kOwnerNamespaceRefusalPattern).
const kConflictHolderPidPattern = /\(pid (\d+)\)|\bholder (\d+) at\b/i;
// The role is untrusted stderr text that reaches operator notices: a closed
// token shape (letter first, then letters/digits/`_`/`-`, at most 32 chars),
// never a URL or markup. Anything else reads as "no role named".
const kConflictHolderRolePattern =
  /state directory is locked by ([A-Za-z][\w-]{0,31})(?=[\s(]|$)/i;

// null when the text carries no ownership-conflict wording; otherwise the
// family plus whatever the message names about the holder (pid, role). The
// holder is read from the LINE that carries the conflict wording — a 50-line
// stderr tail names other pids too (the gateway's own startup line first).
const classifyOwnershipConflict = (text) => {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !kOwnerHeartbeatWaitPattern.test(line));
  const conflictLines = lines.filter((line) => kGatewayOwnershipConflictPattern.test(line));
  if (conflictLines.length === 0) return null;
  // 2026.9.8 wraps the lease refusal — and 2026.10.2 the namespace refusal —
  // in the generic ownership failure on ONE line ("failed to acquire gateway
  // state ownership | Another Gateway owner lease is still active …" / "… |
  // cannot verify Gateway ownership …"). Such a line is the lease, not a
  // state writer; a separate state-writer line still outranks a lease line in
  // the same tail.
  const stateWriterLine = conflictLines.find(
    (line) => kStateWriterConflictPattern.test(line) && !kOwnerLeaseHeldPattern.test(line),
  );
  const ownerLeaseLine =
    stateWriterLine == null ? conflictLines.find((line) => kOwnerLeaseHeldPattern.test(line)) : undefined;
  const conflictLine = stateWriterLine ?? ownerLeaseLine ?? conflictLines[0];
  const pidMatch = kOwnerNamespaceRefusalPattern.test(conflictLine)
    ? null
    : conflictLine.match(kConflictHolderPidPattern);
  const roleMatch = conflictLine.match(kConflictHolderRolePattern);
  return {
    kind:
      stateWriterLine != null
        ? "state_writer_conflict"
        : ownerLeaseLine != null
          ? "owner_lease_held"
          : "gateway_conflict",
    holderPid: pidMatch ? Number.parseInt(pidMatch[1] ?? pidMatch[2], 10) : null,
    holderRole: roleMatch ? roleMatch[1] : null,
  };
};

// /proc/<pid>/stat: `<pid> (<comm>) <state> <ppid> … <starttime>` — the comm
// may contain spaces and parentheses, so fields are split AFTER the last ")".
// From there: index 0 = state (field 3), index 1 = ppid (field 4), index 19 =
// starttime in clock ticks since boot (field 22). Start ticks are the
// identity a pid number lacks: a reused pid has different start ticks, which
// is exactly how upstream's own owner check tells a live holder from a corpse.
const kProcStatStartTicksIndex = 19;
const kProcStatParentPidIndex = 1;
const kProcStatStateIndex = 0;
const kProcStatPgrpIndex = 2;
// Linux scheduler states that mean "this process can never run again": Z is
// a zombie waiting for its parent's wait(), X is dead (mid-teardown). A
// zombie still answers kill(pid, 0) and keeps its /proc entry until it is
// reaped — on a container whose init is slow to reap, for seconds or minutes.
const kProcDeadStates = Object.freeze(new Set(["Z", "X"]));
const parseProcStat = (raw) => {
  const text = String(raw ?? "");
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const startTicks = Number.parseInt(fields[kProcStatStartTicksIndex] ?? "", 10);
  const parentPid = Number.parseInt(fields[kProcStatParentPidIndex] ?? "", 10);
  const pgrp = Number.parseInt(fields[kProcStatPgrpIndex] ?? "", 10);
  const state = /^[A-Za-z]$/.test(fields[kProcStatStateIndex] ?? "") ? fields[kProcStatStateIndex] : null;
  return {
    state,
    dead: state != null && kProcDeadStates.has(state),
    parentPid: Number.isInteger(parentPid) && parentPid >= 0 ? parentPid : null,
    pgrp: Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null,
    startTicks: Number.isInteger(startTicks) && startTicks >= 0 ? startTicks : null,
  };
};

// { stat, errorCode }: the parsed stat, or null plus WHY it could not be read
// (ENOENT/ESRCH = the process is gone; EACCES/EPERM = hidepid or another
// user's process; "EMALFORMED" = /proc answered something parseProcStat
// cannot read; "EINVAL" = not a pid). The verdict logic in
// gateway-identity.js needs the reason: an unreadable stat is not proof of
// death. Never throws.
const readProcStatResult = (pid, { fsModule = fs } = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) return { stat: null, errorCode: "EINVAL" };
  let raw;
  try {
    raw = fsModule.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return { stat: null, errorCode: String(error?.code || "EUNKNOWN") };
  }
  const stat = parseProcStat(raw);
  return stat ? { stat, errorCode: null } : { stat: null, errorCode: "EMALFORMED" };
};

const readProcStat = (pid, fsModule) => readProcStatResult(pid, { fsModule }).stat;

// number | null — never throws.
const readProcStartTicks = (pid, { fsModule = fs } = {}) =>
  readProcStat(pid, fsModule)?.startTicks ?? null;

// number | null — never throws.
const readProcParentPid = (pid, { fsModule = fs } = {}) =>
  readProcStat(pid, fsModule)?.parentPid ?? null;

// ── Process identity beyond the pid number ──────────────────────────────────
// Kernel facts (verified against Linux 6.x in this sandbox, 2026-09-06; the
// pidfile guard in server-pidfile.js is the consumer):
//   - Thread ids share the pid number space. For a thread `tid` of process
//     `pid`, `kill(tid, 0)` succeeds and `/proc/<tid>/cmdline` is the
//     LEADER's argv, so neither liveness nor argv can tell a thread from a
//     process — a stale pidfile whose number collides with one of our own V8 /
//     libuv threads passes both (issue #76 RC1). `/proc/<tid>/status` carries
//     `Tgid: <pid>`: `Tgid === pid` is the sufficient "real process" test and
//     `Tgid === process.pid` identifies our own thread.
//   - `/proc/1/stat` field 22 (pid 1's start, clock ticks since boot) and
//     `/proc/uptime` (seconds since boot) share one boot time base — inside a
//     container too, where pid 1 is the container's init — so
//       containerStartMs ≈ now − uptime×1000 + pid1Ticks×(1000/USER_HZ)
//     dates the container's birth in wall-clock ms. That is what tells a
//     pidfile claim written by a PREVIOUS container from one written by this
//     one when the hostname is a stable Render instance name.
//   - USER_HZ, the tick unit of every /proc time field, is the Linux userspace
//     ABI constant 100 on x86_64 and arm64 (`getconf CLK_TCK`), independent of
//     the kernel's CONFIG_HZ; Node exposes no sysconf, so it is hard-coded here
//     and this is the one assumption a new architecture would have to revisit.
// The estimate is centisecond-grained and the two reads are not atomic, so
// consumers compare it with a margin of minutes, never milliseconds.
const kProcUserHz = 100;
const kMsPerProcTick = 1000 / kProcUserHz;
const kProcStatusTgidPattern = /^Tgid:\s+(\d+)/m;

// integer | null — the thread-group id from /proc/<pid>/status. Never throws.
const readProcTgid = (pid, { fsModule = fs } = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const match = kProcStatusTgidPattern.exec(
      String(fsModule.readFileSync(`/proc/${pid}/status`, "utf8")),
    );
    const tgid = match ? Number.parseInt(match[1], 10) : Number.NaN;
    return Number.isInteger(tgid) && tgid > 0 ? tgid : null;
  } catch {
    return null; // exited / unreadable / non-Linux
  }
};

// true = a real process (its own thread-group leader), false = a thread of
// some other leader, null = unknown (exited / unreadable / non-Linux). Never
// throws.
const isProcessThreadGroupLeader = (pid, { fsModule = fs } = {}) => {
  const tgid = readProcTgid(pid, { fsModule });
  return tgid == null ? null : tgid === pid;
};

// pid 1's start ticks — the identity of THIS container (a fresh container has
// a fresh pid 1 with fresh ticks; a stable hostname does not). null off Linux.
const readContainerStartTicks = ({ fsModule = fs } = {}) =>
  readProcStartTicks(1, { fsModule });

// Seconds since boot from /proc/uptime (first field) — number | null.
const readProcUptimeSeconds = (fsModule) => {
  try {
    const first = String(fsModule.readFileSync("/proc/uptime", "utf8")).trim().split(/\s+/)[0];
    const seconds = Number.parseFloat(first);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  } catch {
    return null;
  }
};

// Wall-clock ms estimate of the container's start per the formula above,
// rounded to whole ms; null when /proc/uptime or /proc/1/stat is unreadable.
// Never throws.
const readContainerStartMs = ({ fsModule = fs, nowFn = Date.now } = {}) => {
  const uptimeSeconds = readProcUptimeSeconds(fsModule);
  const pid1Ticks = readContainerStartTicks({ fsModule });
  if (uptimeSeconds == null || pid1Ticks == null) return null;
  const now = Number(nowFn());
  if (!Number.isFinite(now)) return null;
  return Math.round(now - uptimeSeconds * 1000 + pid1Ticks * kMsPerProcTick);
};

const defaultReadCmdline = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
};

const defaultIsZombie = (pid) => {
  try {
    return (
      fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^State:\s+(\S)/m)?.[1] ===
      "Z"
    );
  } catch {
    return false;
  }
};

// Program-position classification (v0.9.81, D16). A process is an OpenClaw
// process when the PROGRAM is OpenClaw — never because some argument happens
// to contain an `openclaw/` path segment. The previous "any token matching
// /(^|\/)openclaw(\/|$|\.m?js$)/" rule counted `tail -F
// /tmp/openclaw/openclaw-2026-09-08.log` (a log follower) as a live OpenClaw
// process and refused every offline copy in production. Three rules:
//   (1) argv[0] IS the CLI: basename `openclaw` / `openclaw-gateway` or a
//       path ending in `/openclaw` (PATH shims, /usr/local/bin, the launcher
//       binary). Windows `.bat/.cmd/.exe` suffixes are stripped first.
//   (2) argv[0] is a JS runtime (node, nodejs, bun, deno, tsx, `node22`) and
//       its SCRIPT OPERAND — the first token that is not a runtime flag,
//       skipping the value of value-taking flags — is an OpenClaw entry
//       script: `<pkg>/openclaw/dist/*.js|.mjs|.cjs`, `<pkg>/openclaw/
//       openclaw.mjs`, `<pkg>/openclaw/bin/openclaw.js`, a bare
//       `openclaw.mjs` (launched from the package dir) — OR a script whose
//       basename is `openclaw`/`openclaw-gateway`: the npm bin shim
//       `<root>/node_modules/.bin/openclaw` is what AlphaClaw's own PATH shim
//       execs (`exec node "<root>/node_modules/.bin/openclaw" "$@"`), so the
//       gateway this repo launches runs as `node …/.bin/openclaw gateway run`
//       and every AlphaClaw CLI shell-out as `node …/.bin/openclaw <verb>`.
//   (2b) argv[0] is a SHELL (sh, bash, dash, ash, zsh, ksh) and its script
//       operand's basename is `openclaw` / `openclaw-gateway`: a shebang
//       wrapper named openclaw runs as `/bin/sh /path/bin/openclaw gateway
//       run` and stays the process-tree root of a `gateway run` (the e2e
//       reap fixture mirrors this; a user's own wrapper does too). `sh -c
//       "… openclaw …"` is NOT one: -c's value is a command string.
//   (3) upstream parity (isOpenClawArgv in gateway-process-argv.ts): any token
//       that ENDS with one of the package's own entry scripts — kept so a
//       launcher shape we have not seen (a wrapper that passes the entry as a
//       later argument) is still recognised. Qualified with the `openclaw/`
//       package dir (or bare `openclaw.mjs`) so another app's `dist/entry.js`
//       is not ours.
// Used by every consumer through listLiveOpenclawProcesses: the offline
// copy's exclusivity gate, runBackupDiagnosis.otherProcesses, detectIncumbent
// and gateway.js listGatewayPids. tests/server/fixtures/openclaw-argv-
// fixtures.js is the shared truth table (openclaw × gateway expectations).
const kJsRuntimePattern = /^(node|nodejs|bun|deno|tsx)(\d+(?:\.\d+)*)?$/i;
const kShellPattern = /^(sh|bash|dash|ash|zsh|ksh|mksh)$/i;
// Shell flags whose VALUE is the next token: `-c <command>` above all — the
// command string may mention openclaw without the process being one.
const kValueTakingShellFlags = new Set(["-c", "-o", "+o", "--rcfile", "--init-file"]);
// Runtime flags whose VALUE is the next token (written with a space); a
// `--flag=value` spelling is a single token and needs no skip.
const kValueTakingRuntimeFlags = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--inspect-port",
  "--max-old-space-size",
  "--stack-size",
  "--conditions",
  "-C",
  "--title",
  "--openssl-config",
  "--input-type",
  "--report-directory",
  "--report-filename",
  "--disable-warning",
  "--unhandled-rejections",
  "--eval",
  "-e",
  "--print",
  "-p",
]);
const kOpenclawEntryScriptPattern =
  /(^|\/)openclaw\/(dist\/[^/]+\.[mc]?js|openclaw\.mjs|bin\/openclaw\.js|scripts\/run-node\.mjs|src\/(entry|index)\.ts)$|(^|\/)openclaw\.mjs$/i;

const normalizeArgvToken = (arg) => String(arg ?? "").replaceAll("\\", "/");

const isOpenclawExecutable = (exe) => {
  const program = normalizeArgvToken(exe).replace(/\.(bat|cmd|exe)$/i, "");
  const base = program.slice(program.lastIndexOf("/") + 1);
  return base === "openclaw" || base === "openclaw-gateway";
};

// The script operand of an interpreter argv, or null when the interpreter was
// given none we can see (`node -e code`, `sh -c cmd`, `node --version`).
const findScriptOperand = (argv, valueTakingFlags) => {
  for (let i = 1; i < argv.length; i += 1) {
    const token = normalizeArgvToken(argv[i]);
    if (token === "--") return i + 1 < argv.length ? normalizeArgvToken(argv[i + 1]) : null;
    if (token.startsWith("-") || token.startsWith("+")) {
      if (valueTakingFlags.has(token)) i += 1;
      continue;
    }
    return token;
  }
  return null;
};

// Rules (1), (2) and (2b) only — the PROGRAM is OpenClaw. The stop ladder's
// kill-set classification uses this and never rule (3): a bystander that
// merely names an OpenClaw entry script in an argument (`tail -F …/openclaw/
// dist/x.js.log`, a wrapper that passes the entry later) must not be judged
// as "the gateway" when deciding whether the gateway is gone.
const isOpenclawProgramArgv = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  const exe = normalizeArgvToken(argv[0]);
  if (isOpenclawExecutable(exe)) return true; // (1)
  const program = exe.slice(exe.lastIndexOf("/") + 1);
  if (kJsRuntimePattern.test(program)) {
    const script = findScriptOperand(argv, kValueTakingRuntimeFlags);
    if (script && (kOpenclawEntryScriptPattern.test(script) || isOpenclawExecutable(script))) {
      return true; // (2)
    }
  } else if (kShellPattern.test(program)) {
    const script = findScriptOperand(argv, kValueTakingShellFlags);
    if (script && isOpenclawExecutable(script)) return true; // (2b)
  }
  return false;
};

const isOpenclawArgv = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  if (isOpenclawProgramArgv(argv)) return true;
  return argv.some((arg) => kOpenclawEntryScriptPattern.test(normalizeArgvToken(arg))); // (3)
};

// Short, argument-free description of what a process runs, for evidence
// lines: the program's basename plus — for a JS runtime only — the basename
// of its script operand (`node trip-reminder-stream.mjs`). Never a URL, a
// `sh -c` command string or any other argument: those are where tokens and
// paths leak (issue #129). Empty argv (a kernel thread, an unreadable
// cmdline) → "".
const kMaxProgramDescriptionChars = 80;
const describeArgvProgram = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) return "";
  const exe = normalizeArgvToken(argv[0]);
  const program = exe.slice(exe.lastIndexOf("/") + 1);
  let text = program;
  if (kJsRuntimePattern.test(program)) {
    const script = findScriptOperand(argv, kValueTakingRuntimeFlags);
    if (script) text = `${program} ${script.slice(script.lastIndexOf("/") + 1)}`;
  }
  return text.slice(0, kMaxProgramDescriptionChars);
};

const parseProcCmdline = (raw) =>
  String(raw ?? "")
    .split("\0")
    .filter((entry) => entry.length > 0);

// Bounded /proc scan: live, non-zombie, non-self processes whose argv is
// openclaw-ish. Returns [] on non-Linux / unreadable /proc (never throws).
//
// `match(argv)` narrows the scan BEFORE the cap and `limit` sets the cap
// (default kMaxListed — right for the human evidence lines, wrong for a pid
// VERDICT): /proc lists pids ascending, so a cap applied to every
// openclaw-ish process on a busy host drops exactly the newest pids — the
// freshly spawned supervisor/gateway the restart-incumbent predicate must
// see. The gateway pid snapshot passes its own pattern and no cap.
const listLiveOpenclawProcesses = ({
  fsModule = fs,
  readCmdline = defaultReadCmdline,
  isZombie = defaultIsZombie,
  selfPid = process.pid,
  match = null,
  limit = kMaxListed,
} = {}) => {
  let entries;
  try {
    entries = fsModule.readdirSync("/proc");
  } catch {
    return [];
  }
  const cap =
    limit === Infinity ? Infinity : Number.isFinite(limit) && limit > 0 ? limit : kMaxListed;
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    const raw = readCmdline(pid);
    if (!raw) continue; // kernel threads / exited / unreadable
    const argv = parseProcCmdline(raw);
    if (!isOpenclawArgv(argv)) continue;
    if (typeof match === "function" && !match(argv)) continue;
    if (isZombie(pid)) continue;
    found.push({ pid, cmdline: argv.join(" ").slice(0, kMaxCmdlineChars) });
    if (found.length >= cap) break;
  }
  return found;
};

const listLockDirs = ({ tmpDir = os.tmpdir(), fsModule = fs } = {}) => {
  try {
    return fsModule.readdirSync(tmpDir).filter((name) => kLockDirPattern.test(name));
  } catch {
    return [];
  }
};

const looksLikeLockContention = (text) =>
  kStateContentionPattern.test(String(text ?? ""));

// Human lines for evidence tails / process.log. Never throws.
const describeLockContention = ({
  site = "restart",
  tmpDir = os.tmpdir(),
  fsModule = fs,
  readCmdline = defaultReadCmdline,
  isZombie = defaultIsZombie,
  selfPid = process.pid,
} = {}) => {
  const live = listLiveOpenclawProcesses({ fsModule, readCmdline, isZombie, selfPid });
  const lockDirs = listLockDirs({ tmpDir, fsModule });
  const lines = [];
  if (live.length > 0) {
    lines.push(
      `[alphaclaw] ${site}: ${live.length} live openclaw process(es) — a lifecycle lock holder is one of these: ${live
        .map((p) => `pid ${p.pid} (${p.cmdline})`)
        .join("; ")}`,
    );
  } else {
    lines.push(
      `[alphaclaw] ${site}: no live openclaw processes found — a lifecycle-lock refusal here would mean the holder already exited (retry should succeed)`,
    );
  }
  if (lockDirs.length > 0) {
    lines.push(
      `[alphaclaw] ${site}: lock dir(s) present in ${tmpDir}: ${lockDirs.join(", ")} — informational only; the coordinator is an exclusive SQLite transaction released on holder exit, so these files never block by themselves and must never be deleted while a holder may be live`,
    );
  }
  return { live, lockDirs, lines };
};

// Liveness of a pid by signal 0: ESRCH = gone; EPERM = alive but not ours
// (still alive); any other error is treated as alive (fail-safe toward "do
// not relaunch"). The watchdog's probe-death fast path consumes this.
const pidAlive = (pid, { kill = process.kill.bind(process) } = {}) => {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    kill(n, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

module.exports = {
  pidAlive,
  kStateContentionPattern,
  kGatewayProcessPattern,
  kGatewayServingCmdlinePattern,
  kGatewayOwnershipConflictPattern,
  kOwnerLeaseHeldPattern,
  kTransientConflictKinds,
  classifyOwnershipConflict,
  parseProcStat,
  readProcStatResult,
  kProcDeadStates,
  readProcStartTicks,
  readProcParentPid,
  readProcTgid,
  isProcessThreadGroupLeader,
  readContainerStartTicks,
  readContainerStartMs,
  describeLockContention,
  listLiveOpenclawProcesses,
  listLockDirs,
  looksLikeLockContention,
  isOpenclawArgv,
  isOpenclawProgramArgv,
  describeArgvProgram,
  parseProcCmdline,
};
