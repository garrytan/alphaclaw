const { waitForSignal } = require("./repair-operation");
const kManagedUpdatePostTimeoutMs = 30_000;

// The bridge cannot prove a transport failure means "not submitted". Persist
// submitting before the POST, and only a recognized acknowledgement resolves
// transport ambiguity. A late response may never reverse operator resolution.
const submitManagedUpdate = async ({ attempts, strategy, target, fetchImpl, timeoutMs = kManagedUpdatePostTimeoutMs,
  onDispatch = () => {} }) => {
  const attempt = attempts.begin({ repo: target.publicRepo, ref: target.ref,
    alphaclawVersion: target.alphaclawVersion, openclawVersion: target.openclawVersion });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("deadline"), timeoutMs);
  timer.unref?.();
  onDispatch(attempt.id);
  let state = "unknown";
  try {
    const response = await waitForSignal(() => fetchImpl(strategy.managedUpdateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${strategy.managedUpdateToken}`, "User-Agent": "alphaclaw" },
      body: JSON.stringify({ repo: strategy.templateRepoUrl, ref: target.ref,
        alphaclawVersion: target.alphaclawVersion, openclawVersion: target.openclawVersion }),
      signal: controller.signal,
    }), controller.signal);
    const data = JSON.parse(await waitForSignal(() => response.text(), controller.signal));
    if (response.ok && data?.ok === true && data.noop === true) state = "noop";
    else if (response.ok && data?.ok === true && data.noop === false && data.phase === "queued") state = "accepted";
    else if (response.status >= 400 && response.status < 500 && response.status !== 408 && data?.ok === false) state = "rejected";
  } catch {
    // Fixed public copy below; bridge bodies and token-bearing URLs stay out
    // of status/error responses and the durable attempt record.
  } finally {
    clearTimeout(timer);
    onDispatch(null);
  }
  const current = attempts.transition(attempt.id, ["submitting"], state);
  if (!current) return { status: 409, body: { ok: false, code: "attempt_stale", managedUpdateAttempt: attempts.read() } };
  if (state === "unknown") return { status: 502, body: { ok: false, managedUpdate: true, restarting: false,
    code: "managed_update_unknown", managedUpdateAttempt: current,
    error: "The deployment outcome is unknown. Check the provider and resolve this attempt before submitting another update." } };
  if (state === "rejected") return { status: 502, body: { ok: false, managedUpdate: true, restarting: false,
    code: "managed_update_rejected", managedUpdateAttempt: current,
    error: "The deployment provider rejected this update. Check the provider before retrying." } };
  return { status: 200, body: { ok: true, managedUpdate: true, restarting: false,
    noop: state === "noop", phase: state === "noop" ? "noop" : "queued", managedUpdateAttempt: current } };
};

module.exports = { submitManagedUpdate, kManagedUpdatePostTimeoutMs };
