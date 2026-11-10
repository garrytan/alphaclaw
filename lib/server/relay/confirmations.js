const crypto = require("crypto");
const { kConfirmTtlMs } = require("../../plugin/relay-guard/confirm");

// The AlphaClaw side of owner confirmations (relay trust v2 PR2, GST-2090;
// the guards' side is lib/plugin/relay-guard/confirm.js). On its own timer it
// sends the owner one message per requested confirmation, with a one-time
// link to /relay/confirm/<token> (stored as its sha256, 15 minutes, single
// use; routes/relay-confirm.js), expires stale rows, takes the owner's answer
// and tells the sender, and once a day sends the owner a digest of delegate
// activity. Messages to the owner name the sender, lane, action and target,
// never the relay message's text.
const kConfirmTokenPattern = /^rcl_[a-f0-9]{48}$/;
const kTickMs = 5000;
const kDigestHourUtc = 15;
const kDayMs = 24 * 60 * 60 * 1000;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

// The owner's notice is house format, which the transports turn into links
// and bold. Action and target come from the delegate's call, so each rides a
// code span, where no markup applies.
const codeSpan = (value) => "`" + (String(value ?? "").replace(/[`\r\n]/g, "'") || "-") + "`";

const describeAsk = (row) => "@" + row.sender + (row.lane ? " (lane " + row.lane + ")" : "") + " wants to " + codeSpan(row.action);

const createRelayConfirmations = ({
  getStore,
  notify = () => {},
  resolveSetupUrl = () => "",
  sendToAgent = async () => {},
  readRevokes = () => 0,
  resolveGrantCreator = () => null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}) => {
  const state = { timer: null, running: false, ticking: false };
  const log = (line) => logger.log("[relay] confirm " + line);
  const baseUrl = () => String(resolveSetupUrl() || "").replace(/\/+$/, "");
  const tell = (text, opts) => void Promise.resolve(notify(text, opts)).catch(() => {});

  const sendLinks = (store) => {
    for (const row of store.confirmations.listRequested()) {
      const token = "rcl_" + crypto.randomBytes(24).toString("hex");
      const expiresAt = now() + kConfirmTtlMs;
      if (!store.confirmations.markPending(row.id, { tokenHash: sha256(token), csrf: crypto.randomBytes(16).toString("hex"), expiresAt })) continue;
      const link = (baseUrl() || "") + "/relay/confirm/" + token;
      tell(
        "🔐 *Relay confirmation needed*\n" +
          describeAsk(row) + ".\n" +
          "Target: " + codeSpan(row.target) + "\n" +
          "Approve or deny within 15 minutes (the link works once, signed in to AlphaClaw): " + link +
          (baseUrl() ? "" : "\nALPHACLAW_SETUP_URL is not set, so open this path on your AlphaClaw address."),
        { eventType: "relay_confirm", id: "relay-confirm-" + row.id },
      );
      log("asked id=" + row.id + " sender=" + row.sender + " kind=" + row.kind + (row.lane ? " lane=" + row.lane : ""));
    }
  };

  const digestText = (store, since) => {
    const activity = store.delegateActivitySince(since);
    const counts = store.confirmations.countsSince(since);
    let revokes = 0;
    try {
      revokes = Number(readRevokes(since)) || 0;
    } catch {}
    const asked = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (!activity.length && !asked && !revokes) return null;
    const bySender = new Map();
    for (const row of activity) {
      const entry = bySender.get(row.sender) || { messages: 0, lanes: new Set(), grants: new Set() };
      entry.messages += row.messages;
      entry.lanes.add(row.lane || "default");
      if (row.grantId) entry.grants.add(row.grantId);
      bySender.set(row.sender, entry);
    }
    const lines = ["📋 *Agent Relay, the last 24 hours*"];
    for (const [sender, entry] of bySender) {
      lines.push(
        "- @" + sender + ": " + entry.messages + " delegate message" + (entry.messages === 1 ? "" : "s") +
          ", lanes " + [...entry.lanes].sort().join(", ") +
          (entry.grants.size ? ", grant " + [...entry.grants].join(", ") : ", env list"),
      );
    }
    if (!bySender.size) lines.push("- No delegate messages.");
    lines.push(
      "- Confirmations: " + asked + " asked, " + ((counts.confirmed || 0) + (counts.spent || 0)) + " approved (" + (counts.spent || 0) + " used), " +
        (counts.denied || 0) + " denied, " + (counts.expired || 0) + " expired" + (counts.cancelled ? ", " + counts.cancelled + " cancelled by a revoke" : "") + ".",
    );
    lines.push("- Delegate grants revoked: " + revokes + ".");
    return lines.join("\n");
  };

  const maybeDigest = (store) => {
    const at = new Date(now());
    if (at.getUTCHours() < kDigestHourUtc) return;
    const day = at.toISOString().slice(0, 10);
    if (store.getMeta("digest_day") === day) return;
    store.setMeta("digest_day", day);
    const text = digestText(store, now() - kDayMs);
    if (!text) return;
    tell(text, { eventType: "relay_digest", id: "relay-digest-" + day });
    log("digest sent day=" + day);
  };

  const tick = () => {
    const store = getStore();
    if (!store) return;
    store.confirmations.expire();
    sendLinks(store);
    maybeDigest(store);
  };

  const schedule = () => {
    if (!state.running) return;
    state.timer = setTimer(() => {
      state.timer = null;
      try {
        tick();
      } catch (error) {
        logger.warn("[relay] confirm tick failed: " + String(error?.message || error));
      }
      schedule();
    }, kTickMs);
    state.timer?.unref?.();
  };

  // The live, unanswered confirmation behind a link, or null.
  const resolveToken = (token) => {
    if (!kConfirmTokenPattern.test(String(token || ""))) return null;
    const store = getStore();
    const row = store ? store.confirmations.byTokenHash(sha256(token)) : null;
    if (!row || row.state !== "pending" || row.expiresAt <= now()) return null;
    return row;
  };

  // Who may answer: the box owner's shared-password session always, and in
  // team mode the admin who created the sender's grant. Any other admin is
  // refused, so nobody approves a delegate they did not connect.
  const mayAnswer = (row, identity) => {
    if (identity?.kind === "legacy") return true;
    if (identity?.kind !== "member" || identity.role !== "admin" || !identity.memberId) return false;
    const grantId = getStore()?.get(row.messageId)?.grantId;
    return Boolean(grantId) && resolveGrantCreator(grantId) === "member:" + identity.memberId;
  };

  // The owner's answer. Approve keeps the confirmation for 15 minutes from
  // now, for the sender's retry. Either way the sender is told, in a relay
  // message from the box agent that wakes its thread.
  const decide = async ({ token, approve, by }) => {
    const row = resolveToken(token);
    if (!row) return { ok: false };
    const store = getStore();
    const nextState = approve ? "confirmed" : "denied";
    if (!store.confirmations.decide(row.id, { state: nextState, by, expiresAt: approve ? now() + kConfirmTtlMs : now() })) return { ok: false };
    log(nextState + " id=" + row.id + " sender=" + row.sender + " by=" + by);
    const text = approve
      ? "[Relay: your owner approved: " + row.action + " (confirmation " + row.id + "). Send the request again with confirmation_ref " + row.id + " within 15 minutes; it is admitted once.]"
      : "[Relay: your owner denied: " + row.action + " (confirmation " + row.id + "). Do not try it again without asking them.]";
    try {
      await sendToAgent(row, text, { relay_status: "confirmation", relay_confirmation_ref: row.id, relay_confirmation_state: nextState });
    } catch (error) {
      logger.warn("[relay] confirm could not tell " + row.sender + " about " + row.id + ": " + String(error?.message || error));
    }
    return { ok: true, state: nextState, row: store.confirmations.get(row.id) };
  };

  return {
    start: () => {
      if (state.running) return;
      state.running = true;
      schedule();
    },
    stop: () => {
      state.running = false;
      if (state.timer) clearTimer(state.timer);
      state.timer = null;
    },
    tick,
    resolveToken,
    mayAnswer,
    decide,
    digestText,
  };
};

module.exports = { createRelayConfirmations, kConfirmTokenPattern, describeAsk };
