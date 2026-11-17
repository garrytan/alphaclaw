const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { readGatewayOwnerLease } = require("./openclaw-owner-lease");

// OpenClaw 2026.11.5 no longer retires a gateway owner recorded in another
// PID namespace once its heartbeat is stale ("cannot verify Gateway
// ownership from this process; heartbeat age does not prove that the holder
// stopped"). 2026.10.2 through 2026.11.4 treated a foreign holder as dead 90 s
// after its last beat (GATEWAY_OWNER_HEARTBEAT_STALE_MS), so a container
// that died without releasing its locks (SIGKILL, OOM, a node reboot) kept
// the next container out for at most 90 s. On 2026.11.5 it keeps it out for
// good: the gateway waits 95 s and exits 1, and Doctor cannot enter
// maintenance, until an operator runs `openclaw gateway recover-lock`.
//
// AlphaClaw owns one container per data volume, so it applies the rule
// 2026.11.4 applied: a holder in another host or PID namespace whose
// heartbeat (the lock file's mtime, renewed every 15 s) is at least 90 s old
// has stopped. It then runs upstream's own two-step recovery: inspect
// (recover-lock --json) and confirm the exact fingerprint it printed
// (recover-lock --confirm <fp> --json). Upstream binds the fingerprint to
// every lock file's bytes and identity and to the SQLite owner lease, so a
// holder that beats between the inspection and the confirmation is refused
// by OpenClaw itself.
//
// A holder in this process's own namespace is left to OpenClaw, which
// checks the pid. Lock files only exist while a gateway, Doctor or another
// state writer holds them (a clean stop removes them), so the common launch
// reads one directory and spawns nothing.
const kForeignLockStaleAfterMs = 90_000;
const kRecoverLockTimeoutMs = 60_000;
const kHolderLinePattern =
  /holder (\d+|unknown) at (unknown host|[^\s/,]+)(?:\/pid-ns (\d+))?, last renewed (\d+) s ago/;

const readCurrentNamespace = ({ fsModule = fs, hostname = os.hostname() } = {}) => {
  let pidNsInode = null;
  try {
    pidNsInode = fsModule.readlinkSync("/proc/self/ns/pid").match(/^pid:\[(\d+)\]$/)?.[1] ?? null;
  } catch {}
  return { host: hostname, pidNsInode };
};

const resolveGatewayLockDir = ({ openclawDir, uid = typeof process.getuid === "function" ? process.getuid() : undefined }) =>
  path.join(openclawDir, "tmp", uid != null ? `openclaw-${uid}` : "openclaw");

// A holder that recorded no host was written by an OpenClaw older than the
// namespace record (2026.10.2), so it is not this process's gateway.
const isForeign = (holder, current) =>
  !holder.host ||
  holder.host !== current.host ||
  (holder.pidNsInode != null && holder.pidNsInode !== current.pidNsInode);

// The lock files' own view, read without OpenClaw: null when none exists,
// otherwise the first reason to leave them to OpenClaw, or "stale_foreign".
// "fresh_heartbeat" carries how long until the newest foreign beat is stale.
const readLockFilesVerdict = ({ lockDir, current, nowMs, staleAfterMs, fsModule }) => {
  let names;
  try {
    names = fsModule.readdirSync(lockDir).filter((name) => name.endsWith(".lock"));
  } catch {
    return null;
  }
  if (!names.length) return null;
  let waitMs = 0;
  for (const name of names) {
    const file = path.join(lockDir, name);
    let holder;
    let mtimeMs;
    try {
      mtimeMs = fsModule.statSync(file).mtimeMs;
      const namespace = JSON.parse(fsModule.readFileSync(file, "utf8"))?.processNamespace;
      holder = { host: typeof namespace?.host === "string" ? namespace.host : null, pidNsInode: typeof namespace?.pidNsInode === "string" ? namespace.pidNsInode : null };
    } catch {
      return { verdict: "unreadable" };
    }
    if (!isForeign(holder, current)) return { verdict: "same_namespace" };
    waitMs = Math.max(waitMs, staleAfterMs - (nowMs - mtimeMs));
  }
  return waitMs > 0 ? { verdict: "fresh_heartbeat", waitMs } : { verdict: "stale_foreign" };
};

const parseJson = (text) => {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
};

const runOpenclawCli = ({ env, timeoutMs = kRecoverLockTimeoutMs } = {}) => (args) =>
  new Promise((resolve) => {
    execFile("openclaw", args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (error.code ?? null) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });

// Never throws. Returns { status: "skipped" | "recovered" | "failed", reason, holders? }.
const recoverStaleForeignGatewayLock = async ({
  openclawDir,
  runCli,
  readLease = () => readGatewayOwnerLease({ stateDbPath: path.join(openclawDir, "state", "openclaw.sqlite") }),
  lockDir = resolveGatewayLockDir({ openclawDir }),
  current = readCurrentNamespace(),
  nowMs = Date.now,
  staleAfterMs = kForeignLockStaleAfterMs,
  fsModule = fs,
  logger = console,
  site = "launch",
  // Wait out a foreign holder's last heartbeat (at most staleAfterMs) instead
  // of letting the gateway or Doctor wait 95 s and fail.
  waitForHeartbeat = true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) => {
  const skip = (reason) => ({ status: "skipped", reason });
  try {
    let files = readLockFilesVerdict({ lockDir, current, nowMs: nowMs(), staleAfterMs, fsModule });
    if (files?.verdict === "fresh_heartbeat" && waitForHeartbeat) {
      const waitMs = Math.min(files.waitMs, staleAfterMs) + 1_000;
      logger.log?.(`[alphaclaw] gateway lock recovery (${site}): a gateway from another container holds the state locks; waiting ${Math.ceil(waitMs / 1000)} s for its heartbeat to lapse`);
      await sleep(waitMs);
      files = readLockFilesVerdict({ lockDir, current, nowMs: nowMs(), staleAfterMs, fsModule });
    }
    if (files === null) {
      const lease = readLease();
      if (lease?.status !== "held" && lease?.status !== "expired") return skip("absent");
    } else if (files.verdict !== "stale_foreign") return skip(files.verdict);
    const inspected = await runCli(["gateway", "recover-lock", "--json"]);
    const inspection = inspected.ok ? parseJson(inspected.stdout) : null;
    if (!inspection || typeof inspection.confirmation !== "string" || !Array.isArray(inspection.holders)) {
      logger.warn?.(`[alphaclaw] gateway lock recovery (${site}): inspection failed: ${(inspected.stderr || inspected.stdout).trim().slice(0, 300)}`);
      return { status: "failed", reason: "inspect_failed" };
    }
    if (!inspection.present) return skip("absent");
    for (const line of inspection.holders) {
      const match = kHolderLinePattern.exec(String(line));
      if (!match) return skip("holder_unparsed");
      if (!isForeign({ host: match[2] === "unknown host" ? null : match[2], pidNsInode: match[3] ?? null }, current)) return skip("same_namespace");
      if (Number(match[4]) * 1000 < staleAfterMs) return skip("fresh_heartbeat");
    }
    const holders = inspection.holders.map((line) => kHolderLinePattern.exec(String(line))[0]);
    const recovered = await runCli(["gateway", "recover-lock", "--confirm", inspection.confirmation, "--json"]);
    const result = recovered.ok ? parseJson(recovered.stdout) : null;
    if (!result?.recovered) {
      logger.warn?.(`[alphaclaw] gateway lock recovery (${site}): OpenClaw refused: ${(recovered.stderr || recovered.stdout).trim().slice(0, 300)}`);
      return { status: "failed", reason: "recover_refused", holders };
    }
    logger.log?.(`[alphaclaw] gateway lock recovery (${site}): removed ${result.removed} record(s) of a stopped gateway from another container (${holders.join("; ")})`);
    return { status: "recovered", reason: "stale_foreign", holders, removed: result.removed };
  } catch (error) {
    logger.warn?.(`[alphaclaw] gateway lock recovery (${site}) failed: ${String(error?.message ?? error).slice(0, 200)}`);
    return { status: "failed", reason: "error" };
  }
};

module.exports = {
  kForeignLockStaleAfterMs,
  readCurrentNamespace,
  resolveGatewayLockDir,
  recoverStaleForeignGatewayLock,
  runOpenclawCli,
};
