const failure = (code) => Object.assign(new Error(code), { code });
const { spawnSync } = require("child_process");
const { waitForBackupReadiness } = require("./openclaw-backup-readiness");

const inspectRecoveryAtBootSync = ({ stateDir, spawnEnv, supported }) => {
  const paths = {};
  for (const key of ["HOME", "USERPROFILE", "PREFIX", "ANDROID_DATA", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    if (spawnEnv?.[key] !== undefined) paths[key] = spawnEnv[key];
  }
  const input = JSON.stringify({ stateDir, spawnEnv: paths, supported });
  if (Buffer.byteLength(input) > 64 * 1024) return { ok: false, compatible: null };
  const result = spawnSync(process.execPath, [__filename, "inspect"], {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH },
    detached: process.platform !== "win32", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  if (process.platform !== "win32" && result.pid) {
    try { process.kill(-result.pid, "SIGKILL"); } catch {}
  }
  try {
    if (result.error || result.status !== 0) return { ok: false, compatible: null };
    return JSON.parse(result.stdout);
  } catch { return { ok: false, compatible: null }; }
};

const beginRecoveryOperation = async ({ acquire, gateway, quiet, resume, isQuietOwned, assertPolicy, leaseMs = 15 * 60_000,
  acquireTimeoutMs = 90_000, readinessTimeoutMs = 60_000, readinessPollMs = 500 }) => {
  if (!gateway || !quiet) throw failure("recovery_ownership_unavailable");
  if (!Number.isFinite(acquireTimeoutMs) || acquireTimeoutMs <= 0) throw failure("recovery_lock_timeout");
  let expired = false;
  let timer;
  const pending = Promise.resolve().then(() => acquire({ leaseMs })).then((lease) => {
    if (!expired) return lease;
    lease?.();
    return null;
  });
  let hold;
  try {
    hold = await Promise.race([pending, new Promise((resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(failure("recovery_lock_timeout")); }, acquireTimeoutMs);
    })]);
  } finally { clearTimeout(timer); }
  let quietToken = null;
  let stopped = false;
  let suppression = null;
  let suppressed = false;
  let handedOff = false;
  let closed = false;
  let quietLost = false;
  const isLeaseValid = () => Boolean(hold) && (typeof hold.isValid !== "function" || hold.isValid()) && !gateway.isCancelled?.();
  const assert = () => {
    if (!isLeaseValid()) throw failure("lease_expired");
    assertPolicy(hold);
    if (quietLost || (quietToken && (quietToken.token?.disabled || (isQuietOwned ? !isQuietOwned(quietToken) : quietToken.isValid?.() === false)))) throw failure("state_db_quiet_lost");
  };
  const close = async () => {
    if (closed || handedOff) return;
    closed = true;
    try {
      if (quietToken) resume(quietToken);
      quietToken = null;
      quietLost = false;
      if (stopped && isLeaseValid()) {
        assert();
        await gateway.start({ shouldAbort: () => !isLeaseValid() });
        assert();
        const ready = await waitForBackupReadiness({
          gateway: { isRunning: () => gateway.isRunning(),
            probeReadiness: () => gateway.probeReadiness?.() ?? { kind: "unsupported" } },
          timeoutMs: readinessTimeoutMs, pollMs: readinessPollMs, settleMs: 0,
          shouldAbort: () => !isLeaseValid(),
        });
        assert();
        if (!ready) throw failure("gateway_relaunch_failed");
      }
    } finally {
      try {
        if (suppressed && (suppression || isLeaseValid())) gateway.unsuppress?.(suppression);
      } finally { hold?.(); }
    }
  };
  try {
    assert();
    const running = await gateway.isRunning();
    assert();
    suppression = gateway.suppress?.(leaseMs + 30_000);
    suppressed = true;
    if (running) {
      stopped = true;
      if (!await gateway.stop({ shouldAbort: () => !isLeaseValid() })) throw failure("gateway_stop_unconfirmed");
      assert();
    }
    quietToken = await quiet({ owner: "recovery-checkpoint", maxMs: leaseMs,
      onEvent: (event) => { if (["expired", "released", "disabled"].includes(event?.status)) quietLost = true; } });
    if (!quietToken) throw failure("state_db_quiet_unavailable");
    assert();
    const defer = () => {
      if (!handedOff || closed) return;
      closed = true;
      try {
        if (quietToken) resume(quietToken);
        quietToken = null;
      } finally {
        try {
          if (suppressed && (suppression || isLeaseValid())) gateway.unsuppress?.(suppression);
        } finally { hold?.(); }
      }
    };
    return { hold, assert, isLeaseValid, wasRunning: running, isQuiet: () => {
      try { assert(); return Boolean(quietToken); } catch { return false; }
    },
      close, defer, park: () => { handedOff = true; defer(); }, handoff: () => { assert(); handedOff = true; } };
  } catch (error) {
    await close();
    throw error;
  }
};

module.exports = { beginRecoveryOperation, inspectRecoveryAtBootSync };

if (require.main === module && process.argv[2] === "inspect") {
  const fs = require("fs");
  const { buildRecoveryInventory, inspectRecoveryDatabases } = require("./openclaw-recovery-plan");
  (async () => {
    const raw = fs.readFileSync(0, "utf8");
    if (Buffer.byteLength(raw) > 64 * 1024) throw failure("RECOVERY_PROBE_INPUT_LIMIT");
    const { stateDir, spawnEnv, supported } = JSON.parse(raw);
    const inventory = await buildRecoveryInventory({ stateDir, spawnEnv });
    const verdict = await inspectRecoveryDatabases({ inventory, supported });
    process.stdout.write(JSON.stringify({ ok: verdict.ok, compatible: verdict.compatible, migrationRequired: verdict.migrationRequired }));
  })().catch(() => {
    process.stdout.write(JSON.stringify({ ok: false, compatible: null }));
  });
}
