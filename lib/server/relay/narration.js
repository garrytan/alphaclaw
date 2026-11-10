const { kOpenStates, kTerminalStates } = require("./bridge-store");
const { isRelayNarrationOn } = require("./config");

// Narration of relay asks (GST-2304): the owner hears, on their admin
// notification targets, one short line for each ask a remote agent (a capy-*
// Capy thread) sends this box's agent: who asked (relay name, thread code
// from its attested binding), the box-observed facts (lane, tier, route,
// length), the sender's own one-line summary in quotes and a code span, and
// the message's state when the line went out.
//
//   bridge intake stores summary, is_ack, body_chars, intake_trust
//   -> a pass on its own timer (never the confirmations tick, so a failure
//      here never delays a 🔐 link): the unnarrated rows at least minAgeMs
//      old are picked and stamped in one transaction (bridge-store.js
//      takeNarrationBatch), so a restart never repeats a line
//   -> one notice through notifyOwner (the durable outbox), at most one
//      every spacingMs, at most `lines` lines then one "…and N more" line,
//      at most hourlyMessages an hour; past that the asks are stamped
//      "capped" and counted, and the next notice says how many went
//      unnarrated. Spacing, the hour's count and the overflow count live in
//      relay_meta, so a restart keeps them.
//
// Never narrated: acknowledgments (is_ack, decided from the body), senders
// that are not capy-* agents, and the box's own callbacks (relay_status,
// never stored). Narration never calls the relay engine or the gateway, and a
// notice is never a tap: it carries no link or button, and every notice ends
// with a footer saying a reply goes to the box's agent and only 🔐 links
// approve relay actions (a reply to the bot quotes the notice into the
// agent's prompt; its injected rules say a 🛰 line is never the user's
// approval: lib/setup/core-prompts/AGENTS.md, and with Telegram on the relay
// line rule in onboarding/workspace.js). ALPHACLAW_RELAY_NARRATION=off (deployment env
// only, read at every pass) stops the notices; rows are still stamped, so
// turning it on again sends no backlog. Delivery is at most once: a row is
// stamped before its notice is queued.
const kTickMs = 5000;
const kHourMs = 60 * 60 * 1000;
const kBatchCeiling = 500;
const kRemotePrefix = "capy-";
const kFoldSendersShown = 5;
const kThreadCodePattern = /^[A-Z][A-Z0-9]{1,15}-[0-9]{1,9}$/;
const kNarrationWindows = Object.freeze({ minAgeMs: 30 * 1000, spacingMs: 60 * 1000, lines: 10, hourlyMessages: 20 });

// Every bridge state, in plain words (bridge-store.js kOpenStates and
// kTerminalStates; a test fails when a state has no word).
const kStateWords = Object.freeze({
  queued: "queued",
  dispatched: "running",
  completing: "running",
  reconciling: "running",
  replying: "running",
  answered: "answered",
  failed: "failed",
  interrupted: "interrupted",
  unknown: "outcome unknown",
  rate_limited: "refused (rate limit)",
  hop_limit: "refused (hop limit)",
  lane_limit: "refused (lane limit)",
});

const codeSpan = (value) => "`" + String(value ?? "").replace(/[`\r\n]/g, "'") + "`";
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
const isRemoteSender = (sender) => String(sender || "").startsWith(kRemotePrefix);

// Decides one pass from the rows and the narration_* meta values (pure, run
// inside the store's transaction): the outcome each covered row is stamped
// with, the meta to keep, and the notice to send, if any.
const planNarrationPass = (rows, meta, { at, on, windows = kNarrationWindows }) => {
  const stamps = [];
  const asks = [];
  for (const row of rows) {
    if (!isRemoteSender(row.sender)) stamps.push({ messageId: row.messageId, outcome: "not_remote" });
    else if (row.isAck) stamps.push({ messageId: row.messageId, outcome: "ack" });
    else asks.push(row);
  }
  if (!on) {
    for (const row of asks) stamps.push({ messageId: row.messageId, outcome: "off" });
    return { stamps };
  }
  if (at - (Number(meta.narration_last_sent_at) || 0) < windows.spacingMs) return { stamps };
  let hourStart = Number(meta.narration_hour_start) || 0;
  let hourSent = Number(meta.narration_hour_sent) || 0;
  const overflow = Number(meta.narration_overflow) || 0;
  if (at - hourStart >= kHourMs) {
    hourStart = at;
    hourSent = 0;
  }
  if (hourSent >= windows.hourlyMessages) {
    for (const row of asks) stamps.push({ messageId: row.messageId, outcome: "capped" });
    return asks.length ? { stamps, meta: { narration_overflow: overflow + asks.length } } : { stamps };
  }
  if (!asks.length && !overflow) return { stamps };
  const listed = asks.slice(0, windows.lines);
  const folded = asks.slice(windows.lines);
  for (const row of listed) stamps.push({ messageId: row.messageId, outcome: "sent" });
  for (const row of folded) stamps.push({ messageId: row.messageId, outcome: "folded" });
  return {
    stamps,
    meta: { narration_last_sent_at: at, narration_hour_start: hourStart, narration_hour_sent: hourSent + 1, narration_overflow: 0 },
    // The outbox id: the first listed message's id, or, for a notice that
    // only counts capped asks, the hour window it opens (one per window).
    result: { id: "relay-narration-" + (listed.length ? listed[0].messageId : "overflow-" + hourStart), listed, folded, overflow },
  };
};

const describeThread = (threadCode) => {
  const value = String(threadCode || "").trim();
  if (!value) return null;
  return kThreadCodePattern.test(value) ? "thread " + codeSpan(value) : "thread id " + codeSpan(value.slice(0, 64));
};

const describeAsk = (row, threadCode) => {
  const tier = row.intakeTrust || row.trust || "peer";
  const length = plural(row.bodyChars ?? 0, "character");
  const facts = [
    describeThread(threadCode),
    row.lane ? "lane " + row.lane : null,
    tier,
    row.route === "tailnet" ? "tailnet" : row.route === "public" ? "public URL" : null,
    row.summary ? length : null,
  ].filter(Boolean);
  const words = row.summary ? "\"" + codeSpan(row.summary) + "\"" : "(no summary given, " + length + ")";
  return "🛰 @" + row.sender + " (" + facts.join(", ") + ") asks: " + words + " · " + (kStateWords[row.state] || row.state);
};

const describeFold = (folded) => {
  const bySender = new Map();
  for (const row of folded) bySender.set(row.sender, (bySender.get(row.sender) || 0) + 1);
  const senders = [...bySender.entries()];
  if (senders.length === 1) return "🛰 …and " + plural(folded.length, "more ask") + " from @" + senders[0][0];
  const shown = senders.slice(0, kFoldSendersShown).map(([sender, n]) => "@" + sender + " (" + n + ")");
  const others = senders.slice(kFoldSendersShown).reduce((sum, [, n]) => sum + n, 0);
  return "🛰 …and " + plural(folded.length, "more ask") + " from " + shown.join(", ") + (others ? " and " + others + " from other agents" : "");
};

const narrationFooter = (agentLabel) =>
  "Replying here talks to " + agentLabel + ", not the asking thread; only 🔐 links approve relay actions.";

const createRelayNarration = ({
  getStore,
  notify = () => {},
  // The thread code of a capy-* agent's binding, from its verified Capy
  // attestation only (remote-store.js thread_code), or null.
  resolveThread = () => null,
  // The box agent's name for the footer (its OpenClaw identity name).
  agentLabel = () => "",
  env = process.env,
  windows = {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}) => {
  const limits = { ...kNarrationWindows, ...windows };
  const state = { timer: null, running: false, lastSentAt: null, failures: 0, lastError: null };
  const log = (line) => logger.log("[relay] narration " + line);

  const footer = () => {
    let label = "";
    try {
      label = String(agentLabel() || "").replace(/[`*_[\]()\r\n]/g, "").trim().slice(0, 40);
    } catch {}
    return narrationFooter(label || "your agent");
  };

  const threadOf = (cache, sender) => {
    if (!cache.has(sender)) {
      let code = null;
      try {
        code = resolveThread(sender) || null;
      } catch {}
      cache.set(sender, code);
    }
    return cache.get(sender);
  };

  const send = (notice) => {
    const threads = new Map();
    const lines = [
      ...(notice.overflow ? ["🛰 " + plural(notice.overflow, "ask") + " not narrated in the last hour (at most " + limits.hourlyMessages + " notices an hour)."] : []),
      ...notice.listed.map((row) => describeAsk(row, threadOf(threads, row.sender))),
      ...(notice.folded.length ? [describeFold(notice.folded)] : []),
    ];
    const text = lines.join("\n") + "\n\n" + footer();
    state.lastSentAt = now();
    log("id=" + notice.id + " lines=" + notice.listed.length + " folded=" + notice.folded.length + " overflow=" + notice.overflow);
    const failed = (reason) => logger.warn("[relay] narration notice " + notice.id + " was not delivered: " + reason);
    let pending;
    try {
      pending = notify(text, { eventType: "relay_narration", id: notice.id, verbose: true });
    } catch (error) {
      failed(String(error?.message || error));
      return;
    }
    Promise.resolve(pending)
      .then((outcome) => {
        if (outcome && outcome.ok === false && !outcome.skipped) failed(String(outcome.reason || "unknown"));
      })
      .catch((error) => failed(String(error?.message || error)));
  };

  const tick = () => {
    const store = getStore();
    if (!store) return;
    const at = now();
    const on = isRelayNarrationOn(env);
    const notice = store.takeNarrationBatch({
      at,
      receivedBefore: on ? at - limits.minAgeMs : at,
      limit: kBatchCeiling,
      decide: (rows, meta) => planNarrationPass(rows, meta, { at, on, windows: limits }),
    });
    if (notice) send(notice);
  };

  const schedule = () => {
    if (!state.running) return;
    state.timer = setTimer(() => {
      state.timer = null;
      try {
        tick();
        state.failures = 0;
        state.lastError = null;
      } catch (error) {
        state.failures += 1;
        state.lastError = String(error?.message || error).slice(0, 200);
        logger.warn("[relay] narration tick failed: " + state.lastError);
      }
      schedule();
    }, kTickMs);
    state.timer?.unref?.();
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
    getStatus: () => ({
      enabled: isRelayNarrationOn(env),
      lastSentAt: state.lastSentAt ? new Date(state.lastSentAt).toISOString() : null,
      failures: state.failures,
      lastError: state.lastError,
    }),
  };
};

module.exports = {
  createRelayNarration,
  planNarrationPass,
  describeAsk,
  narrationFooter,
  kNarrationWindows,
  kStateWords,
  kNarrationStates: Object.freeze([...kOpenStates, ...kTerminalStates]),
};
