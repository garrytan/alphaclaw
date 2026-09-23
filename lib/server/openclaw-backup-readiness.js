const waitForBackupReadiness = async ({ gateway, timeoutMs, pollMs, settleMs, shouldAbort, now = Date.now }) => {
  const deadline = now() + Math.max(0, timeoutMs);
  let settled = false;
  let timer = null;
  const bounded = async (read) => {
    try {
      return await Promise.race([
        Promise.resolve().then(read),
        new Promise((resolve) => {
          const check = () => {
            if (shouldAbort() || now() >= deadline) { resolve(null); return; }
            timer = setTimeout(check, Math.max(1, Math.min(pollMs, deadline - now())));
          };
          check();
        }),
      ]);
    } catch { return null; }
    finally { clearTimeout(timer); }
  };
  const pause = async (ms) => {
    let delay;
    try { await bounded(() => new Promise((resolve) => { delay = setTimeout(resolve, ms); })); }
    finally { clearTimeout(delay); }
  };
  while (now() < deadline && !shouldAbort()) {
    const observation = await bounded(() => gateway.probeReadiness?.() ?? { kind: "unconfigured" });
    if (shouldAbort() || now() >= deadline) return false;
    let ready = observation?.ok === true && observation.kind === "ready" && observation.ready === true;
    if (observation?.kind === "unsupported") {
      ready = await bounded(() => gateway.isRunning()) === true;
      if (shouldAbort() || now() >= deadline) return false;
    }
    if (ready) {
      if (settled || settleMs <= 0) return !shouldAbort();
      await pause(settleMs);
      if (shouldAbort() || now() >= deadline) return false;
      settled = true;
    } else {
      settled = false;
      await pause(Math.max(1, pollMs));
    }
  }
  return false;
};

module.exports = { waitForBackupReadiness };
