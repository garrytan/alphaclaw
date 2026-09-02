const { isTruthyFlag } = require("./utils/boolean");

// Notification delivery policy — the single authority for the operator's two
// notification toggles and the audit exemption.
//
// Naming triad (ONE concept, three layers — do not add a fourth name):
//
//   call-site opts flag  `verbose: true`            informational notice; suppressed in "Important only" mode
//   API field            `notificationsVerbose`     GET/PUT /api/watchdog/settings (boolean, default true)
//   env var              `WATCHDOG_NOTIFICATIONS_QUIET`  inverted persistence ("true" = verbose OFF)
//
// Sibling master toggle: API `notificationsEnabled` ↔ env
// `WATCHDOG_NOTIFICATIONS_DISABLED` (same inversion convention). Both are read
// live from process.env — updateSettings runs reloadEnv() after every write,
// so there is no state mirror to drift (and this module works before the
// watchdog object exists).
//
// Delivery classes are EXPLICIT opts flags, never inferred from eventType
// (eventType is a descriptive field driving Slack threading/reactions; e.g.
// "recovery" covers both informational and action-taken notices):
//   verbose: true  — informational; suppressed when the operator picks
//                    "Important only". Absent = important (fail-loud default:
//                    an unclassified site over-notifies, never goes silent).
//   audit: true    — agent-admin audit notices; exempt from BOTH toggles so a
//                    semi-trusted actor can never silence the audit trail of
//                    its own change (set only at the two agent-admin call
//                    sites in init/register-server-routes.js).
//
// Convention: non-emitter code (gates, wrappers, the outbox) must never
// construct a `verbose:` property literal — pass opts/event objects through
// whole. The conventions test scans emitter files for /verbose\s*:/ and pins
// the match set to kVerboseNotificationSites below (a drift-guard; the
// behavioral per-site tests are the correctness invariant). The three
// infrastructure files (this module, upgrade-notifier.js, notify-outbox.js)
// are excluded from that scan — plumbing literals live there by design.

const isNotificationsDisabled = (env = process.env) =>
  isTruthyFlag(env.WATCHDOG_NOTIFICATIONS_DISABLED);

const isVerboseEnabled = (env = process.env) =>
  !isTruthyFlag(env.WATCHDOG_NOTIFICATIONS_QUIET);

// Central delivery decision, consulted at the outbox enqueue gate AND again
// at flush time (an event queued under one setting must not deliver days
// later under another — the outbox retries failures for up to 48h).
// Returns { ok } or { ok: false, reason } with DISTINCT reasons per toggle so
// the event log never conflates them. Callers own fail-open: a policy error
// must never silence alerts (they wrap this call in try/catch and send).
const shouldSendNotification = (opts = {}, env = process.env) => {
  if (opts?.audit === true) return { ok: true };
  // Master toggle: "Notifications: Disabled" silences EVERYTHING that flows
  // through the central pipeline — previously honored at only 5 of ~40 emit
  // paths. Exemptions: audit notices (above), the explicit test-notification
  // route (raw notifier by construction), and the bin-phase boot webhook
  // (last-resort channel for a box that cannot boot).
  if (isNotificationsDisabled(env)) {
    return { ok: false, reason: "notifications_disabled" };
  }
  if (opts?.verbose === true && !isVerboseEnabled(env)) {
    return { ok: false, reason: "verbose_notifications_disabled" };
  }
  return { ok: true };
};

// Canonical pin list for the verbose classification (Phase-3 table of the
// plan). The conventions test asserts the /verbose\s*:/ matches in exactly
// these files equal these counts — adding or removing a tag fails the build
// until this registry is updated alongside it.
//   kind "literal"   — a `verbose: true` tag
//   kind "predicate" — a computed `verbose: <expr>` (overseer verdict splits)
const kVerboseNotificationSites = Object.freeze([
  Object.freeze({
    file: "lib/server/watchdog.js",
    symbol: "channels resumed — pause cleared",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/watchdog.js",
    symbol: "gateway running again (recovery notice)",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/watchdog.js",
    symbol: "config change detected — retrying gateway start",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/openclaw-channel-sync.js",
    symbol: "auto-acceptance: activation verified healthy",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/openclaw-channel-sync.js",
    symbol: "update started",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/openclaw-channel-sync.js",
    symbol: "restarting to activate update",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/openclaw-channel-sync.js",
    symbol: "pin auto-acceptance: new pinned version verified healthy",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server.js",
    symbol: "AlphaClaw update available",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/doctor/service.js",
    symbol: "scheduled Drift Doctor scan finished",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/topic-discovery.js",
    symbol: "topic discovery sweep",
    kind: "literal",
  }),
  Object.freeze({
    file: "lib/server/watchdog-overseer.js",
    symbol: "overseer verdict (verbose when resolved)",
    kind: "predicate",
  }),
  Object.freeze({
    file: "lib/server/upgrade-overseer.js",
    symbol: "overseer verdict (verbose when healthy)",
    kind: "predicate",
  }),
]);

// Notification-sanitize for exception snippets embedded in alert copy: strip
// newlines/backticks/link syntax (chat-format injection) and cap the length.
// Whole-log surfaces (medic, overseers) additionally run the secret redactor;
// these 160-char internal-error snippets follow the overseer verdict-text
// convention instead.
const kNotifyReasonMaxChars = 160;
const sanitizeNotificationText = (value, maxChars = kNotifyReasonMaxChars) =>
  String(value ?? "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[`[\]]/g, "'")
    .slice(0, maxChars);

// UTC day bucket for recurrence-plausible outbox ids: boot loops within a day
// dedupe into one alert; a genuinely new episode later re-fires. One
// implementation — channel-sync and autotune both build ids from it.
const utcDayBucket = (nowMs = Date.now()) =>
  new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, "");

// Fire-and-forget notify guard for auto-fix announcements: a notifier failure
// must never turn a successful repair/restore/cleanup into a failed operation.
const fireAndForgetNotify = (notify, message, opts) => {
  try {
    const completion =
      typeof notify === "function" ? notify(message, opts) : null;
    if (completion && typeof completion.catch === "function") {
      completion.catch(() => {});
    }
  } catch {}
};

// Wraps a RAW fan-out notify (the few paths that bypass the outbox pipeline,
// e.g. topic discovery) with the same policy the central gate applies, so raw
// paths can never drift from it. Fail-open like the central gate: a policy
// error must never silence alerts.
const wrapRawNotifierWithPolicy = (rawNotify) => async (message, opts = {}) => {
  let verdict = { ok: true };
  try {
    verdict = shouldSendNotification(opts) || { ok: true };
  } catch {
    verdict = { ok: true };
  }
  if (!verdict.ok) {
    return { ok: false, skipped: true, reason: verdict.reason };
  }
  return rawNotify(message, opts);
};

module.exports = {
  isNotificationsDisabled,
  isVerboseEnabled,
  shouldSendNotification,
  sanitizeNotificationText,
  utcDayBucket,
  fireAndForgetNotify,
  wrapRawNotifierWithPolicy,
  kVerboseNotificationSites,
};
