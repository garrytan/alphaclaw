// Model runs that fail with model_not_found (ALPH-47). OpenClaw's /model
// accepts any allowlisted ref and the run then fails with "This model was not
// found. Choose another model in the Control UI", which names neither the
// model, the provider nor what the provider said. A /model choice also turns
// off the configured fallbacks, so the chat stays broken until someone resets
// it. This reads OpenClaw's model-fallback decision lines from the gateway
// output, runs the model check for that one ref, and tells the owner which
// model failed, what the provider answered, why, and the one fix. One notice
// per model per six hours; it never changes config or sessions.
const { redactLine } = require("./utils/redact");
const { sanitizeLabel } = require("./utils/sanitize-label");

const kMaxOutputCarry = 4096;
const kMaxFailures = 20;
const kMaxDetailChars = 300;
const kAlertIntervalMs = 6 * 60 * 60 * 1000;
const kOverrideWindowMs = 2 * 60 * 1000;
const kCheckTimeoutMs = 60 * 1000;

const kAnsi = /\u001b\[[0-9;]*m/g;
const kFailureLine =
  /model fallback decision: decision=candidate_failed requested=(\S+) candidate=(\S+) reason=model_not_found next=(\S+)(?: detail=(.*))?$/;
const kOverrideLine = /configured fallbacks disabled by user model override(?: run=(\S+))?/;

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);

const buildMessage = ({ ref, next, detail, override, defaultModel, check }) => {
  const lines = ["🐺 *AlphaClaw Watchdog*"];
  lines.push(
    next === "none"
      ? `⚠️ A reply failed: model ${ref} was not found`
      : `⚠️ Model ${ref} was not found, so OpenClaw answered with ${next} instead`,
  );
  if (detail) lines.push(`OpenClaw reported: ${detail}`);
  if (override && next === "none") {
    lines.push(
      `The chat picked this model with /model, and a /model choice turns off the configured fallbacks, so no other model was tried. Send /model default in that chat to go back to ${defaultModel || "the default model"}.`,
    );
  }
  if (check?.reason) lines.push(`Why: ${check.reason}`);
  if (check?.fix) lines.push(`Fix: ${check.fix}`);
  lines.push("Models tab → Check models re-tests every configured model (admin op models.check.run).");
  return lines.join("\n");
};

const createModelFailureWatch = ({
  notify = null,
  insertEvent = null,
  checkRef = async () => null,
  readDefaultModel = () => null,
  getSecrets = () => [],
  now = () => Date.now(),
  alertIntervalMs = kAlertIntervalMs,
  checkTimeoutMs = kCheckTimeoutMs,
  logger = console,
} = {}) => {
  const failures = [];
  const lastAlertAt = new Map();
  let lastOverrideAtMs = null;
  let outputCarry = "";
  let pending = Promise.resolve();

  const secrets = () => {
    try {
      return getSecrets() || [];
    } catch {
      return [];
    }
  };

  const alert = async (failure) => {
    const check = await withTimeout(Promise.resolve().then(() => checkRef(failure.ref)), checkTimeoutMs).catch(() => null);
    if (check) {
      failure.check = { status: check.status, severity: check.severity, reason: check.reason, fix: check.fix };
    }
    let defaultModel = null;
    try {
      defaultModel = readDefaultModel();
    } catch {}
    try {
      insertEvent?.({
        eventType: "model_not_found",
        source: "model_watch",
        status: failure.next === "none" ? "failed" : "fell_back",
        details: {
          model: failure.ref,
          next: failure.next,
          override: failure.override,
          detail: failure.detail,
          ...(failure.check ? { checkStatus: failure.check.status, fix: failure.check.fix } : {}),
        },
      });
    } catch {}
    if (typeof notify !== "function") return;
    const message = buildMessage({ ...failure, defaultModel, check: failure.check });
    await Promise.resolve(notify(message, { eventType: "model_not_found", id: `model-not-found-${failure.ref}-${failure.atMs}` })).catch(() => {});
  };

  const observeLine = (rawLine) => {
    if (!rawLine.includes("model")) return;
    const line = rawLine.replace(kAnsi, "");
    if (kOverrideLine.test(line)) {
      lastOverrideAtMs = now();
      return;
    }
    const match = kFailureLine.exec(line);
    if (!match) return;
    const atMs = now();
    const ref = sanitizeLabel(match[2], { maxLength: 200 });
    const failure = {
      ref,
      requested: sanitizeLabel(match[1], { maxLength: 200 }),
      next: sanitizeLabel(match[3], { maxLength: 200 }),
      detail: redactLine(match[4] || "", { secrets: secrets(), maxLength: kMaxDetailChars }),
      override: lastOverrideAtMs !== null && atMs - lastOverrideAtMs <= kOverrideWindowMs,
      atMs,
    };
    failures.push(failure);
    if (failures.length > kMaxFailures) failures.shift();
    console.warn(`[alphaclaw] model-watch: ${ref} failed with model_not_found (next=${failure.next}${failure.override ? ", session override" : ""}): ${failure.detail}`);
    const last = lastAlertAt.get(ref);
    if (last !== undefined && atMs - last < alertIntervalMs) return;
    lastAlertAt.set(ref, atMs);
    pending = pending.then(() => alert(failure)).catch((error) => {
      logger.warn?.(`[alphaclaw] model-watch: alert failed: ${String(error?.message || error).slice(0, 200)}`);
    });
  };

  const observeGatewayOutput = (text) => {
    const lines = (outputCarry + String(text ?? "")).split("\n");
    outputCarry = lines.pop().slice(-kMaxOutputCarry);
    for (const line of lines) observeLine(line);
  };

  const getState = () => ({
    failures: failures.map((failure) => ({
      model: failure.ref,
      at: new Date(failure.atMs).toISOString(),
      next: failure.next,
      override: failure.override,
      detail: failure.detail,
      ...(failure.check ? { check: failure.check } : {}),
    })).reverse(),
  });

  return { observeGatewayOutput, getState, settled: () => pending };
};

module.exports = { createModelFailureWatch, buildMessage };
