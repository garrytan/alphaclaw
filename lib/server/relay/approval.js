// The owner's approval a delegate's relay message can carry (GST-1982): the
// owner's words in Capy, the one-line action, the recipients it covers and
// the Capy thread it came from. A remote caller sets it on relay_send or
// relay_reply; it rides as relay_approval message metadata; the bridge keeps
// it only on a delegate's message, and the relay guard lets that run send to
// the named targets once each. It records what the thread says the owner
// approved; it is not proof of it (docs/designs/agent-relay.md, "Delegates").
const kMaxTargets = 10;
const kLimits = Object.freeze({ words: 1000, action: 300, target: 200, thread: 128 });

// One line each: the bridge renders these into the agent's prompt, so a line
// break or control character could start a line that imitates its header.
const kLineBreaks = /[\u0000-\u001f\u007f\u2028\u2029]/;
const text = (value, max) => (typeof value === "string" && value.trim() && value.length <= max && !kLineBreaks.test(value) ? value.trim() : null);

// The normalized approval, or null when the value is not a usable approval.
// why(code) explains a rejection to the remote caller.
const normalizeApproval = (raw, { why = null } = {}) => {
  const reject = (reason) => {
    if (why) why(reason);
    return null;
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject("approval must be an object");
  const words = text(raw.words, kLimits.words);
  if (!words) return reject("approval.words must be the owner's exact words, 1-" + kLimits.words + " characters");
  const action = text(raw.action, kLimits.action);
  if (!action) return reject("approval.action must say what was approved, 1-" + kLimits.action + " characters");
  if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > kMaxTargets) {
    return reject("approval.targets must list 1-" + kMaxTargets + " recipients");
  }
  const targets = [];
  for (const entry of raw.targets) {
    const target = text(entry, kLimits.target);
    if (!target) return reject("each approval target must be a recipient string of at most " + kLimits.target + " characters");
    if (!targets.includes(target)) targets.push(target);
  }
  const thread = raw.thread === undefined || raw.thread === null || raw.thread === "" ? null : text(raw.thread, kLimits.thread);
  if (raw.thread !== undefined && raw.thread !== null && raw.thread !== "" && !thread) return reject("approval.thread must be at most " + kLimits.thread + " characters");
  return { words, action, targets, ...(thread ? { thread } : {}) };
};

module.exports = { normalizeApproval, kMaxApprovalTargets: kMaxTargets };
