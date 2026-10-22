const { overseerNotificationTiming } = require("./notification-expiry");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRunStream } = require("./openclaw-run-stream");
// Evidence scrubbing matches the gateway-medic bar (the other AI evidence
// path): value-match against env vars, .env entries, AND inline config
// secrets, then a shape pass for tokens that live in no store. The
// run-ledger's env-only redactor misses gateway-echoed openclaw.json
// credentials and non-secret-named .env values.
const {
  collectSecretValues,
  redactSecrets,
  redactSecretShapes,
} = require("./utils/redact");
const {
  createSituationSlot,
  projectRecordForApi,
  kStalePendingMs,
} = require("./overseer-situation-slot");
const { kOverseerReviewEventType } = require("./db/watchdog/schema");
const {
  kAutoReviewMaxAgeMs,
  kCriticalClassIncidentKeys,
  isCriticalClassIncident,
  isActionableVerdict,
  kSkipMarkedMaxEntries,
  kAutoReviewSkipReasons,
  classifyAutoReviewEligibility,
} = require("./watchdog-overseer-eligibility");
const {
  kSituationLogWindowMs,
  kLogEvidenceMaxChars,
  filterLogWindow,
  capLogWindow,
  summarizeLogCoverage,
  describeLogCoverage,
} = require("./watchdog-overseer-log-window");
const {
  rollupRecurrenceEntry,
  pickTrustedStatus,
  pickTrustedResources,
} = require("./watchdog-overseer-trusted-projection");
const {
  kVerdicts,
  kActions,
  kSituationVerdicts,
  kSituationActions,
  sanitizeVerdictText,
  buildIncidentPrompt,
  buildSituationPrompt,
  parseVerdict,
} = require("./watchdog-overseer-prompts");

// Watchdog incident overseer — ADVISORY-ONLY, DEFAULT OFF.
//
// Two review kinds share one fail-closed spawn pipeline:
//
//   maybeReviewNext (timer)      requestReview({incidentId})   requestReview({})
//     settled + healthy + quiet    settled incident by id        ANY watchdog state
//     + eligible (else `skipped`)
//            │                            │                            │
//            └────────── runReviewFor ────┘                   runSituationReport
//                              │                                       │
//                              └──── checkSpawnPreconditions ──────────┘
//                                     buildScrubber (fail closed)
//                                     spawnAndParse (claude -p, isolated)
//                              │                                       │
//                      overseer_json on the incident            watchdog_meta slot
//                      (persistOverseer)                        (overseer-situation-slot)
//
// The incident review asks: what happened, is it truly resolved, what next —
//   { verdict: "resolved"|"monitoring"|"action_needed",
//     action: "none"|"repair"|"restart"|"resume_channels"|"fix_config",
//     headline, summary, recommendation }
// The situation report asks: what is happening right now — same shape with
//   verdict: "all_clear"|"watch"|"action_needed" and an `evidence` fingerprint
//   (collection window, real log coverage, status, live incident) so the card
//   can tell when the world moved on. Manual reviews never notify.
//
// PRECEDENCE (do not regress): the deterministic watchdog escalation ladder is
// the ONLY enforcement layer. This factory's DI receives ONLY read functions,
// incident persistence, and notify — no triggerRepair / requestRollback /
// resumeChannels — so it is structurally incapable of enforcement.
//
// Trust + isolation model (stricter than the upgrade overseer where inputs
// are attacker-influenceable):
// - Gateway logs, event details (stderrTail), and the incident's own
//   degradedReason are gateway-influenced; the prompt labels tiers explicitly
//   and the ENTIRE assembled prompt passes the secret redactor.
// - Model OUTPUT also passes the redactor (a verdict can echo a secret it saw
//   in evidence) and a markdown/notification sanitizer before persist/notify.
// - Tool restriction FAILS CLOSED: if `--disallowedTools` support cannot be
//   verified from `claude --help`, the review does not run — prompt-only
//   restriction is not hardening against hostile evidence.
// - Fail-open toward the watchdog: overseer errors never block anything.
const kDefaultDeadlineMs = 5 * 60 * 1000;
const kAvailabilityProbeTimeoutMs = 10 * 1000;
const kAvailabilityTtlMs = 60 * 1000;
const kDoctorTimeoutMs = 60 * 1000;
const kTranscriptTailChars = 4000;
const kBootDelayMs = 30 * 1000;
const kPeriodicCheckMs = 60 * 1000;
// kStalePendingMs is imported from the situation slot (one source of truth for
// "a pending this old is a crash artifact"); the incident stale-pending retry
// uses the same value.
// Cost gates: one automatic review per incident, drained FIFO with a global
// floor between reviews. Manual reviews run in any watchdog state and bypass
// the floor but never the mutex or the availability/redaction gates; a manual
// incident re-review resets the floor, a situation report never touches it.
const kGlobalFloorMs = 10 * 60 * 1000;
const kEventQuietMs = 60 * 1000;

const kManualRateLimitMs = 2 * 60 * 1000;
const kLogWindowPadMs = 2 * 60 * 1000;
const kLogReadBytes = 65536;
const kLogReadBytesLate = 262144;

const kDoctorMaxChars = 32_000;
const kHistoryKeep = 3;

// Live incidents can accrue thousands of events; the report reads the newest.
const kSituationEventLimit = 200;
// notifyOutcome `suppressed:<reason>` echoes the notifier's reason enum; cap
// it so a future free-text reason can never bloat the persisted record.
const kNotifyOutcomeReasonMaxChars = 64;
const kOverseerEnvKeys = ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"];
const kOverseerHomePrefix = "alphaclaw-watchdog-overseer-home-";
// mcp__* included as defense in depth: the spawn cwd is pinned to the isolated
// HOME, but a project-level .mcp.json must never grant tools even if that pin
// regresses.
const kDisallowedTools =
  "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite,KillShell,Read,Glob,Grep,mcp__*";

// --- factory -----------------------------------------------------------------

const createWatchdogOverseer = ({
  // Incident persistence + queries (lib/server/db/watchdog). READ + verdict
  // persistence only — this factory must never receive watchdog mutators.
  incidentsDb,
  getWatchdogStatus = () => null,
  readLogTail = null,
  // Preferred over readLogTail: also reports whether the byte tail was cut at
  // the front, so the situation report can disclose real log coverage.
  readLogTailInfo = null,
  getDoctorJson = null,
  notify = null,
  // Audit sink (append-only watchdog event): records every manual review
  // attempt that reached the runner — refusals included — and its outcome.
  // Still no repair/rollback/resume — a write to the events table is not a
  // recovery capability.
  recordEvent = null,
  isEnabled = () => false,
  notificationsEnabled = () => true,
  getBaseUrl = () => "",
  // Richer redaction sources (match gateway-medic): .env entries and the
  // inline openclaw.json object. Both optional; env-only scrub is the floor.
  readEnvFile = null,
  getConfigObject = null,
  runStream = null,
  env = process.env,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
  claudeCommand = "claude",
  deadlineMs = kDefaultDeadlineMs,
  bootDelayMs = kBootDelayMs,
  periodicCheckMs = kPeriodicCheckMs,
  globalFloorMs = kGlobalFloorMs,
  eventQuietMs = kEventQuietMs,
  autoReviewMaxAgeMs = kAutoReviewMaxAgeMs,
  skipMarkedMaxEntries = kSkipMarkedMaxEntries,
} = {}) => {
  const runner = runStream || createRunStream({ fsModule });
  let periodicTimer = null;
  let bootTimer = null;
  let inFlight = false;
  // What the mutex is holding, for the UI: an automatic review must not read
  // as "your situation report is running".
  let inFlightInfo = null;
  let overseerHomeDir = null;
  let availabilityCache = null;
  let helpTextCache = null;
  let lastReviewAt = 0;
  let lastManualAt = 0;
  // Change-detection: never re-run for the same (incident, status, lastEvent).
  let lastReviewedTuple = "";
  // In-flight dedupe for background availability probes: N concurrent GETs
  // on a cold/stale cache share ONE `claude --version` spawn.
  let backgroundProbe = null;
  const refreshAvailabilityInBackground = () => {
    if (backgroundProbe) return;
    backgroundProbe = Promise.resolve()
      .then(() => getAvailability({ force: true }))
      .catch(() => {})
      .finally(() => {
        backgroundProbe = null;
      });
  };

  const log = (message) => {
    try {
      logger.log?.(`[watchdog-overseer] ${message}`);
    } catch {}
  };

  // FAIL CLOSED on HOME isolation: if the temp HOME cannot be created (e.g.
  // /tmp full — plausible during the disk-pressure incidents this overseer
  // reviews), the claude CLI would fall back to the operator's real home
  // (settings, MCP servers, credentials). Throw instead of degrading.
  const ensureOverseerHome = () => {
    if (!overseerHomeDir) {
      // Crashes skip stop(): sweep stale homes from prior processes before
      // creating a fresh one, so crash loops can't accumulate /tmp dirs.
      // mkdtemp (not a fixed path) keeps its symlink/squat safety on shared
      // /tmp; the prefix sweep only removes our own leftovers.
      try {
        const tmpDir = os.tmpdir();
        for (const name of fsModule.readdirSync?.(tmpDir) || []) {
          if (name.startsWith(kOverseerHomePrefix)) {
            fsModule.rmSync?.(path.join(tmpDir, name), {
              recursive: true,
              force: true,
            });
          }
        }
      } catch {}
      overseerHomeDir = fsModule.mkdtempSync(
        path.join(os.tmpdir(), kOverseerHomePrefix),
      );
    }
    return overseerHomeDir;
  };

  // The Anthropic credential is scoped to the one spawn that needs it (the
  // review run): --version/--help probes resolve `claude` through the
  // inherited PATH, and least privilege says a hijacked binary on that PATH
  // must not receive the key for free.
  const buildOverseerEnv = ({ withCredential = false } = {}) => {
    const isolated = {};
    for (const key of kOverseerEnvKeys) {
      if (env[key] !== undefined) isolated[key] = env[key];
    }
    isolated.HOME = ensureOverseerHome();
    if (withCredential && env.ANTHROPIC_API_KEY) {
      isolated.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    }
    return isolated;
  };

  // The spawn cwd is ALSO pinned to the isolated HOME: the server's working
  // directory can contain a .mcp.json / .claude/ that the CLI would treat as
  // project config, granting tools outside the deny-list's built-in names.
  const spawnIsolation = ({ withCredential = false } = {}) => {
    const home = ensureOverseerHome();
    return { env: buildOverseerEnv({ withCredential }), cwd: home };
  };

  const getAvailability = async ({ force = false, nonBlocking = false } = {}) => {
    const now = nowFn();
    if (!force && availabilityCache && now - availabilityCache.at < kAvailabilityTtlMs) {
      return availabilityCache.value;
    }
    if (!force && availabilityCache) {
      const stale = availabilityCache.value;
      availabilityCache = { at: now, value: stale };
      refreshAvailabilityInBackground();
      return stale;
    }
    // Cold cache on a request path: don't hold an HTTP response hostage to a
    // 10s `claude --version` spawn — answer "probing" and refresh behind it.
    if (nonBlocking && !force) {
      refreshAvailabilityInBackground();
      return {
        available: null,
        reason: "probing",
        message: "Probing claude availability...",
      };
    }
    const record = (value) => {
      availabilityCache = { at: nowFn(), value };
      return value;
    };
    if (!String(env.ANTHROPIC_API_KEY || "").trim()) {
      return record({
        available: false,
        reason: "no_anthropic_credential",
        message:
          "ANTHROPIC_API_KEY is not set — the overseer needs an Anthropic API credential.",
      });
    }
    try {
      ensureOverseerHome();
    } catch (error) {
      return record({
        available: false,
        reason: "home_isolation_failed",
        message: `Could not create the isolated HOME for the claude spawn: ${error.message}`,
      });
    }
    try {
      const probe = await runner.runStreamed({
        command: claudeCommand,
        args: ["--version"],
        ...spawnIsolation(),
        timeoutMs: kAvailabilityProbeTimeoutMs,
      });
      if (!probe.ok) {
        return record({
          available: false,
          reason: "claude_not_found",
          message: "The `claude` CLI is not installed or not runnable on this host.",
        });
      }
      return record({
        available: true,
        reason: null,
        message: `claude ${String(probe.tail || "").trim().slice(0, 80)}`.trim(),
      });
    } catch (error) {
      return record({
        available: false,
        reason: "probe_failed",
        message: `Availability probe failed: ${error.message}`,
      });
    }
  };

  const getHelpText = async () => {
    const now = nowFn();
    if (helpTextCache && now - helpTextCache.at < kAvailabilityTtlMs * 10) {
      return helpTextCache.text;
    }
    try {
      const help = await runner.runStreamed({
        command: claudeCommand,
        args: ["--help"],
        ...spawnIsolation(),
        timeoutMs: kAvailabilityProbeTimeoutMs,
      });
      helpTextCache = { at: nowFn(), text: String(help.tail || "") };
    } catch {
      helpTextCache = { at: nowFn(), text: "" };
    }
    return helpTextCache.text;
  };

  const pickCliFlags = (helpText) => {
    const text = String(helpText || "");
    const flags = [];
    let toolsDisabledByFlag = false;
    if (text.includes("--output-format")) {
      flags.push("--output-format", "json");
    }
    if (text.includes("--disallowedTools")) {
      flags.push("--disallowedTools", kDisallowedTools);
      toolsDisabledByFlag = true;
    } else if (text.includes("--disallowed-tools")) {
      flags.push("--disallowed-tools", kDisallowedTools);
      toolsDisabledByFlag = true;
    }
    return { flags, toolsDisabledByFlag };
  };

  // Tri-state on purpose: the shared collector returns `null` (never throws)
  // on timeout/unusable output, and an empty string is a real "doctor ran,
  // said nothing" — the evidence line must not call either of those "ok".
  const collectDoctorOutput = async () => {
    try {
      if (typeof getDoctorJson === "function") {
        const out = await getDoctorJson();
        if (out == null) {
          return { text: "(doctor unavailable: no usable output)", status: "unavailable" };
        }
        const text = String(out).slice(0, kDoctorMaxChars);
        return { text, status: text.trim() ? "ok" : "empty" };
      }
      // No isolated fallback spawn: doctor is gateway-INSTALLATION evidence
      // and must run under the real env (the DI'd runner). Under the temp
      // HOME it would diagnose an empty config dir and mislead the review.
      return {
        text: "(doctor unavailable: no getDoctorJson provided)",
        status: "unavailable",
      };
    } catch (error) {
      return { text: `(doctor unavailable: ${error.message})`, status: "unavailable" };
    }
  };

  const readTail = (bytes) => {
    try {
      if (typeof readLogTailInfo === "function") {
        const info = readLogTailInfo(bytes);
        return { text: String(info?.text ?? ""), hitCap: !!info?.hitCap };
      }
      if (typeof readLogTail === "function") {
        return { text: String(readLogTail(bytes) || ""), hitCap: false };
      }
    } catch {}
    return { text: "", hitCap: false };
  };

  // Refused attempts are exempt from the manual rate limit (so an operator can
  // fix the environment and retry at once), which means a looping caller could
  // otherwise append one audit row per call while claude stays unavailable.
  // One audit row per refusal reason per rate-limit window bounds that.
  // Keyed per mode + incident + reason so a refused situation report does not
  // swallow the audit trail of a refused re-review of a different incident.
  const lastRefusalAuditAt = new Map();
  const shouldAuditRefusal = (key) => {
    const now = nowFn();
    const last = lastRefusalAuditAt.get(key) || 0;
    if (now - last < kManualRateLimitMs) return false;
    lastRefusalAuditAt.set(key, now);
    return true;
  };

  const emitAuditEvent = ({ status, incidentId = null, details }) => {
    if (typeof recordEvent !== "function") return;
    if (
      details?.unavailableReason &&
      !shouldAuditRefusal(`${details.mode}:${incidentId ?? "none"}:${details.unavailableReason}`)
    ) {
      return;
    }
    try {
      recordEvent({
        eventType: kOverseerReviewEventType,
        source: "overseer",
        // Explicit: the sink defaults a missing status to "failed".
        status,
        incidentId: Number.isInteger(incidentId) && incidentId > 0 ? incidentId : null,
        details,
      });
    } catch (error) {
      log(`audit event failed (fail-open): ${error.message}`);
    }
  };

  // --- verdict persistence: {v:1, current, history[<=3]} ----------------------

  const readOverseerRecord = (incident) => {
    const record =
      incident?.overseer && typeof incident.overseer === "object"
        ? incident.overseer
        : null;
    if (record?.unreadable) return { v: 1, current: null, history: [] };
    if (record && typeof record.current === "object") {
      return {
        v: 1,
        current: record.current,
        history: Array.isArray(record.history) ? record.history : [],
      };
    }
    return { v: 1, current: null, history: [] };
  };

  const persistOverseer = (incident, current, { supersede = false } = {}) => {
    try {
      // Re-read: the caller's incident snapshot predates any pending stamp
      // written earlier in this review — history must come from the db.
      const fresh = incidentsDb.getIncidentById(incident.id) || incident;
      const existing = readOverseerRecord(fresh);
      // Stable incident notification ids keep their first delivery lifetime
      // through pending stamps and manual/history rotations.
      const priorTimings = [existing.current, ...existing.history].filter(
        (entry) => entry && Object.prototype.hasOwnProperty.call(entry, "notifyExpiresAt"),
      );
      if (priorTimings.length) {
        const previous = priorTimings.map((entry) => overseerNotificationTiming(entry, nowFn()))
          .reduce((earliest, timing) => ({ createdAt: Math.min(earliest.createdAt, timing.createdAt),
            expiresAt: Math.min(earliest.expiresAt, timing.expiresAt) }));
        const next = Object.prototype.hasOwnProperty.call(current, "notifyExpiresAt")
          ? overseerNotificationTiming(current, nowFn()) : previous;
        current.notifyCreatedAt = Math.min(previous.createdAt, next.createdAt);
        current.notifyExpiresAt = Math.min(previous.expiresAt, next.expiresAt);
      }
      const history =
        supersede && existing.current
          ? [existing.current, ...existing.history].slice(0, kHistoryKeep)
          : existing.history;
      incidentsDb.updateIncidentOverseer(incident.id, {
        v: 1,
        current,
        history,
      });
      return true;
    } catch (error) {
      log(`could not persist verdict for incident #${incident.id}: ${error.message}`);
      return false;
    }
  };

  // --- eligibility -------------------------------------------------------------

  const isHealthySteadyState = () => {
    let status = null;
    try {
      status = getWatchdogStatus();
    } catch {
      return false;
    }
    if (!status || status.health !== "healthy") return false;
    let open = [];
    try {
      open = incidentsDb
        .listIncidents({ limit: 1 })
        .filter((incident) => incident.status === "open");
    } catch {
      return false;
    }
    return open.length === 0;
  };

  // Ineligible rows get ONE `skipped` marker write per process. A persisted
  // marker is terminal for automatic review through the `record.current`
  // check below — the durable record, not this set, remembers a SUCCESSFUL
  // skip (#87 G8). Only a FAILED write (read-only db mid-incident) is
  // remembered here, so the 60s tick neither retries the write nor repeats
  // the one log line persistOverseer wrote — the next process gets one more
  // attempt (#87 decision 2.2). Bounded (insertion order, oldest evicted) so
  // a long-lived process under a persistently failing db cannot grow it
  // without limit; an evicted id costs one more write attempt + log line.
  const skipMarkedBound =
    Number.isInteger(skipMarkedMaxEntries) && skipMarkedMaxEntries > 0
      ? skipMarkedMaxEntries
      : kSkipMarkedMaxEntries;
  const skipMarkedThisProcess = new Set();
  const markSkipped = (incident, reason, at) => {
    if (skipMarkedThisProcess.has(incident.id)) return;
    // No supersede: nothing was reviewed, so nothing rotates into history. A
    // later manual review supersedes the marker like any other current.
    // A stale `pending` current (pickEligibleIncident's retryablePending) is
    // replaced in place the same way — intentional: an attempt that never
    // settled is not a verdict worth keeping in the 3-slot history.
    const persisted = persistOverseer(incident, { state: "skipped", reason, manual: false, at });
    if (persisted) return;
    skipMarkedThisProcess.add(incident.id);
    while (skipMarkedThisProcess.size > skipMarkedBound) {
      skipMarkedThisProcess.delete(skipMarkedThisProcess.values().next().value);
    }
  };

  // FIFO: OLDEST unreviewed settled incident first — a backlog drains one per
  // cooldown instead of newer incidents starving older ones forever.
  // Admission is deterministic and precedes the model: a settled row that
  // fails classifyAutoReviewEligibility is marked `skipped` and never spawns.
  const pickEligibleIncident = () => {
    let incidents = [];
    try {
      incidents = incidentsDb.listIncidents({ limit: 50 });
    } catch {
      return null;
    }
    const settled = incidents
      .filter((incident) => incident.status === "resolved" || incident.status === "abandoned")
      .sort((a, b) => a.id - b.id);
    const now = nowFn();
    for (const incident of settled) {
      const record = readOverseerRecord(incident);
      if (record.current) {
        const retryablePending =
          record.current.state === "pending" &&
          now - (record.current.at || 0) > kStalePendingMs;
        if (!retryablePending) continue;
      }
      const settledAt = Date.parse(incident.resolvedAt || "") || 0;
      if (now - settledAt < eventQuietMs) continue;
      const eligibility = classifyAutoReviewEligibility(incident, now, {
        maxAgeMs: autoReviewMaxAgeMs,
      });
      if (!eligibility.eligible) {
        markSkipped(incident, eligibility.reason, now);
        continue;
      }
      return incident;
    }
    return null;
  };

  // --- shared spawn primitives ---------------------------------------------------
  // Both review paths compose exactly these three steps so a fail-closed check
  // can never exist on one path and be missing on the other.

  // Availability + verifiable tool restriction. Returns {flags} or {refusal}.
  const checkSpawnPreconditions = async () => {
    const availability = await getAvailability();
    if (!availability.available) {
      return {
        refusal: {
          state: "unavailable",
          reason: availability.reason,
          summary: availability.message,
        },
      };
    }
    const helpText = await getHelpText();
    const { flags, toolsDisabledByFlag } = pickCliFlags(helpText);
    if (!toolsDisabledByFlag) {
      // FAIL CLOSED (stricter than the upgrade overseer): the evidence is
      // gateway-influenceable, so an unverifiable tool restriction is a
      // no-go, recorded honestly rather than silently degraded.
      return {
        refusal: {
          state: "unavailable",
          reason: "cli_flags_unverifiable",
          summary:
            "The installed claude CLI does not advertise --disallowedTools; reviews are disabled because tool restriction cannot be verified.",
        },
      };
    }
    return { flags };
  };

  // The ENTIRE assembled prompt is scrubbed at the gateway-medic bar:
  // value-match against env vars, .env entries, and inline config secrets,
  // then the shape pass — event details, doctor output, snapshots, and
  // logs can all embed credentials that live in no env var.
  // FAIL CLOSED on redaction-source read failure: if the .env file or the
  // openclaw config cannot be read (permission/IO/parse error — the DI'd
  // readers already treat a legitimately-absent file as empty), the values
  // that would have joined the scrub list are unknown, so evidence could
  // carry them to the API unredacted. Refuse the review honestly instead.
  const buildScrubber = () => {
    let envFileVars = [];
    let configObjects = [];
    try {
      envFileVars = (typeof readEnvFile === "function" && readEnvFile()) || [];
      const configObject =
        typeof getConfigObject === "function" ? getConfigObject() : null;
      if (configObject) configObjects = [configObject];
    } catch (error) {
      // The persisted/API-facing summary stays a FIXED string: the raw error
      // can carry a JSON.parse snippet of openclaw.json (V8 quotes the source
      // around the syntax error), and the scrubber is exactly what failed.
      // The log line gets the shape-redacted message (no value list needed).
      return {
        refusal: {
          state: "unavailable",
          reason: "redaction_sources_unreadable",
          summary:
            "Refusing to review: could not read the secret-redaction sources (.env or openclaw.json). Fix the file and try again.",
        },
        error,
        logMessage: redactSecretShapes(String(error?.message || "unknown error")),
      };
    }
    const secrets = collectSecretValues({ env, envFileVars, configObjects });
    return {
      scrub: (text) => redactSecretShapes(redactSecrets(String(text ?? ""), { secrets })),
    };
  };

  // Spawn `claude -p` with the prompt over stdin, scrub the OUTPUT before any
  // use, and parse the verdict against the caller's closed sets.
  const spawnAndParse = async ({ prompt, flags, scrub, verdicts, actions }) => {
    let result;
    try {
      // Prompt over stdin, not argv (E2BIG + `ps` exposure).
      result = await runner.runStreamed({
        command: claudeCommand,
        args: ["-p", ...flags],
        ...spawnIsolation({ withCredential: true }),
        input: prompt,
        timeoutMs: deadlineMs,
      });
    } catch (error) {
      result = { ok: false, error: error.message, tail: "" };
    }
    // Model OUTPUT through the redactor before ANY use (persisted transcript
    // tail included) — the transcript can echo a secret the model saw, or the
    // CLI can print env-derived diagnostics. A truncated tail can bisect a
    // secret at the front where exact-value matching would miss the fragment
    // — drop the partial first line before scrubbing.
    let rawTail = String(result.tail || "");
    if (result.truncated) rawTail = rawTail.slice(rawTail.indexOf("\n") + 1);
    const scrubbedTail = scrub(rawTail);
    const transcriptTail = scrubbedTail.slice(-kTranscriptTailChars);
    if (result.error || result.timedOut || !result.ok) {
      return {
        failed: true,
        // Distinct from a thrown bug: the route maps these to 504/502, not 500.
        code: result.timedOut ? "timed_out" : "spawn_failed",
        transcriptTail,
        // The spawn error is a runner-level message today, never process
        // output — scrub it anyway so that invariant is not load-bearing.
        summary: result.timedOut
          ? `The overseer review timed out (${Math.round(deadlineMs / 60000)} minute deadline).`
          : `The claude call failed${result.error ? `: ${scrub(String(result.error))}` : ""}.`,
      };
    }
    const parsed = parseVerdict(scrubbedTail, { verdicts, actions });
    const verdictRecord = parsed || {
      verdict: "unparseable",
      action: "none",
      headline: "",
      summary: "overseer produced unparseable output",
      recommendation: "",
    };
    return { failed: false, parsed, verdictRecord, transcriptTail };
  };

  // --- the situation slot -------------------------------------------------------

  const situationSlot = createSituationSlot({
    read: () =>
      typeof incidentsDb?.getOverseerSituation === "function"
        ? incidentsDb.getOverseerSituation()
        : { ok: false, reason: "missing" },
    write: (record) =>
      typeof incidentsDb?.setOverseerSituation === "function"
        ? incidentsDb.setOverseerSituation(record)
        : false,
    nowFn,
    log,
    // Never below the longest a genuine run can take (doctor collection, the two
    // CLI probes, the spawn deadline, the kill grace) plus slack: a poll must
    // not rewrite an in-flight report as interrupted because someone
    // configured a long deadline.
    stalePendingMs: Math.max(
      kStalePendingMs,
      deadlineMs + kDoctorTimeoutMs + 2 * kAvailabilityProbeTimeoutMs + 30_000 + 60_000,
    ),
  });

  const anotherIncidentIsOpen = (excludeId = null) => {
    try {
      const open =
        typeof incidentsDb?.getOpenIncident === "function"
          ? incidentsDb.getOpenIncident()
          : null;
      return !!open && open.id !== excludeId;
    } catch {
      return false;
    }
  };

  // --- the review --------------------------------------------------------------

  const runReviewFor = async (incidentInput, { manual = false } = {}) => {
    const incident = incidentsDb.getIncidentById(incidentInput.id);
    if (!incident) return { skipped: "incident_missing" };
    const startedAt = nowFn();

    // Change-detection tuple: (incident, status, last event id). Checked
    // BEFORE the pending persist — an "unchanged" skip after persisting
    // pending would strand the record in "pending" forever (the UI would
    // show an eternal in-progress review and the stale-pending retry would
    // re-poke it every cycle).
    const { events, totalCount } = incidentsDb.getIncidentEvents(incident.id, {
      limit: 200,
    });
    const lastEventId = events.length ? events[events.length - 1].id : 0;
    const tuple = `${incident.id}:${incident.status}:${lastEventId}`;
    if (!manual && tuple === lastReviewedTuple) return { skipped: "unchanged" };

    const auditIncident = (status, extra = {}) => {
      if (!manual) return;
      emitAuditEvent({
        status,
        incidentId: incident.id,
        details: { mode: "incident", manual: true, durationMs: nowFn() - startedAt, ...extra },
      });
    };
    // A refused attempt replaces a previous refusal in place instead of pushing
    // it into history: repeated refusals (exempt from the rate limit) must not
    // rotate a settled incident's real verdict out of the 3-slot history.
    const persistRefusal = (refusal) => {
      const previous = readOverseerRecord(incidentsDb.getIncidentById(incident.id) || incident).current;
      persistOverseer(
        incident,
        { ...refusal, at: nowFn() },
        { supersede: manual && previous?.state !== "unavailable" },
      );
    };

    // Preconditions BEFORE the pending stamp: a refusal never writes a pending
    // record it would immediately have to replace.
    const preconditions = await checkSpawnPreconditions();
    if (preconditions.refusal) {
      persistRefusal(preconditions.refusal);
      log(
        `${preconditions.refusal.reason === "cli_flags_unverifiable" ? "cli flags unverifiable — failing closed" : `unavailable: ${preconditions.refusal.reason}`} for incident #${incident.id}`,
      );
      auditIncident("failed", { unavailableReason: preconditions.refusal.reason });
      return { skipped: preconditions.refusal.reason };
    }
    const { flags } = preconditions;

    const scrubber = buildScrubber();
    if (scrubber.refusal) {
      persistRefusal(scrubber.refusal);
      log(
        `redaction sources unreadable — failing closed for incident #${incident.id}: ${scrubber.logMessage}`,
      );
      auditIncident("failed", { unavailableReason: "redaction_sources_unreadable" });
      return { skipped: "redaction_sources_unreadable" };
    }
    const { scrub } = scrubber;

    // `manual` rides the pending stamp so a boot scan can tell an interrupted
    // operator review (rewrite as failed) from an interrupted automatic one
    // (left for the stale-pending retry).
    persistOverseer(incident, { state: "pending", manual, at: nowFn() }, { supersede: manual });

    // Evidence assembly. Log window is time-scoped to the incident; a late
    // review (stale-pending retry) reads a wider tail before filtering.
    const settledAt = Date.parse(incident.resolvedAt || "") || nowFn();
    const openedAt = Date.parse(incident.openedAt || "") || settledAt;
    const isLate = nowFn() - settledAt > kStalePendingMs;
    const logTailRaw = readTail(isLate ? kLogReadBytesLate : kLogReadBytes).text;
    const logWindowRaw = filterLogWindow(logTailRaw, {
      fromMs: openedAt - kLogWindowPadMs,
      toMs: settledAt + kLogWindowPadMs,
    });
    const doctorOutputRaw = (await collectDoctorOutput()).text;
    let statusNow = null;
    try {
      statusNow = getWatchdogStatus();
    } catch {}
    let recentRollups = [];
    try {
      recentRollups = incidentsDb
        .listIncidents({ limit: 6 })
        .filter((entry) => entry.id !== incident.id)
        .slice(0, 5)
        .map(rollupRecurrenceEntry);
    } catch {}

    const prompt = scrub(
      buildIncidentPrompt({
        incident,
        events,
        eventsTruncated: totalCount > events.length,
        recentRollups,
        doctorOutput: doctorOutputRaw,
        logWindow: logWindowRaw,
        statusNow,
        anotherIncidentOpen: anotherIncidentIsOpen(incident.id),
      }),
    );

    // Manual rate limit is consumed here — evidence is about to leave the box.
    if (manual) lastManualAt = nowFn();
    const spawn = await spawnAndParse({
      prompt,
      flags,
      scrub,
      verdicts: kVerdicts,
      actions: kActions,
    });
    const { transcriptTail } = spawn;

    if (spawn.failed) {
      const failedRecord = { state: "failed", summary: spawn.summary, at: nowFn(), transcriptTail };
      const persisted = persistOverseer(incident, failedRecord);
      log(`claude call failed for incident #${incident.id}`);
      auditIncident("failed");
      return {
        failed: true,
        code: spawn.code,
        mode: "incident",
        incidentId: incident.id,
        record: projectRecordForApi(failedRecord),
        persisted,
      };
    }

    const { parsed, verdictRecord } = spawn;

    // Staleness: the reviewed incident itself gained events mid-review (the
    // arc reopened or new evidence landed). Verdicts always persist as
    // history; stale only marks drift — CTA applicability is gated
    // separately in the UI (incident must still be the newest, none open).
    let stale = false;
    try {
      const after = incidentsDb.getIncidentEvents(incident.id, { limit: 200 });
      const lastAfter = after.events.length
        ? after.events[after.events.length - 1].id
        : 0;
      stale = lastAfter !== lastEventId || after.totalCount !== totalCount;
    } catch {}

    // Re-check before send (#87 C2): a spawn can run for minutes, and the
    // world the verdict describes may be gone. Re-read the incident; on a
    // read error fall back to the pre-spawn snapshot (decision 2.3 — a
    // transient db error must never drop a critical-class notice). The
    // decision is persisted on the record so the operator can see WHY a
    // verdict did or did not page them.
    let reviewedNow = incident;
    try {
      reviewedNow = incidentsDb.getIncidentById(incident.id);
    } catch (error) {
      reviewedNow = incident;
      log(
        `recheck read failed for incident #${incident.id} — using the pre-spawn snapshot: ${error.message}`,
      );
    }
    // notifyDecision enum: `manual | eligible | incident_changed |
    // ineligible_now | not_steady_state`. A manual review never notifies (the
    // operator is watching the card), so it records `manual` and skips the
    // eligibility recompute (#87 F9) — the other four describe why an
    // AUTOMATIC review did or did not page.
    let notifyDecision = manual ? "manual" : "eligible";
    if (!reviewedNow || reviewedNow.status !== incident.status) {
      if (!manual) notifyDecision = "incident_changed";
      reviewedNow = incident;
    } else if (!manual) {
      if (
        !classifyAutoReviewEligibility(reviewedNow, nowFn(), { maxAgeMs: autoReviewMaxAgeMs })
          .eligible
      ) {
        notifyDecision = "ineligible_now";
      } else if (
        !isHealthySteadyState() &&
        !isCriticalClassIncident(reviewedNow) &&
        !isActionableVerdict(parsed)
      ) {
        // Y3: a new outage began mid-spawn. An informational verdict about
        // the previous incident is noise now; a critical-class incident or
        // an actionable verdict (action_needed, or any concrete action — the
        // same predicate the quiet-mode class uses below) is still handed to
        // the outbox, which owns delivery retries.
        notifyDecision = "not_steady_state";
      }
    }

    // Notify: automatic final reviews only. Manual re-reviews never notify
    // (the operator is watching the card); stale/unparseable never notify.
    const willNotify =
      !stale &&
      !!parsed &&
      !manual &&
      notifyDecision === "eligible" &&
      notificationsEnabled() &&
      typeof notify === "function";

    // Y5: the outcome is written from the notifier's ACTUAL return, after the
    // send — never assumed. Reviews that will not attempt a send say so now.
    const notifyTiming = willNotify
      ? overseerNotificationTiming(readOverseerRecord(incident).current, nowFn()) : null;
    const doneRecord = {
      state: stale ? "stale" : "done",
      ...(notifyTiming ? { notifyCreatedAt: notifyTiming.createdAt, notifyExpiresAt: notifyTiming.expiresAt } : {}),
      ...verdictRecord,
      manual,
      at: nowFn(),
      notifyDecision,
      ...(willNotify ? {} : { notifyOutcome: "not_attempted" }),
      transcriptTail,
    };
    const persisted = persistOverseer(incident, doneRecord);
    lastReviewedTuple = tuple;
    lastReviewAt = nowFn();
    // Audit AFTER the stale recompute + final persist: the review's own event
    // must never count as "the incident gained events mid-review".
    auditIncident("ok", { verdict: verdictRecord.verdict });
    const outcome = {
      ran: true,
      mode: "incident",
      incidentId: incident.id,
      record: projectRecordForApi(doneRecord),
      persisted,
    };
    if (!willNotify) return outcome;

    const baseUrl = String(getBaseUrl() || "").replace(/\/$/, "");
    const message = [
      "🐺 *AlphaClaw Watchdog*",
      `🤖 Overseer: ${parsed.headline || parsed.verdict}`,
      `${parsed.summary} ${parsed.recommendation}`.trim(),
      `Trigger: \`incident_${incident.id}\``,
      `- [View incident](${baseUrl}/#/watchdog?incident=${incident.id})`,
    ].join("\n");
    // notifyOutcome enum (`sent | held | suppressed:<reason> | failed |
    // not_attempted`), mapped from the wired notifier's return shapes:
    //   { ok:false, skipped|suppressed:true, reason }  → suppressed:<reason>
    //     (policy declined it — quiet mode, disabled, dedupe; not a failure)
    //   { ok:true, held:true }                          → held (parked by the
    //     notifier, e.g. a direct send held behind a pending upgrade)
    //   { ok:true, queued:true, id } / any ok:true      → sent — "accepted by
    //     the notifier": queued to the durable outbox, which owns delivery
    //     and its retries; it is NOT a delivery receipt
    //   anything else, or a throw                       → failed
    let notifyOutcome = "failed";
    try {
      const delivery = await notify(message, {
        eventType: "overseer",
        id: `watchdog-overseer-${incident.id}`,
        createdAt: doneRecord.notifyCreatedAt,
        expiresAt: doneRecord.notifyExpiresAt,
        // Quiet-mode class is decided from the verdict's CONTENT and the
        // incident's class, never from the verdict label alone (#87 C3):
        // informational unless the model asks for action or the incident is
        // critical class — the same predicate that admitted it.
        verbose: !(isActionableVerdict(parsed) || isCriticalClassIncident(reviewedNow)),
      });
      if (delivery?.skipped || delivery?.suppressed) {
        notifyOutcome = `suppressed:${String(delivery.reason || "unknown").slice(
          0,
          kNotifyOutcomeReasonMaxChars,
        )}`;
      } else if (delivery?.held) {
        notifyOutcome = "held";
      } else if (delivery?.ok === true) {
        notifyOutcome = "sent";
      }
    } catch (error) {
      // notifyOutcome stays "failed"; the reason must still reach the log
      // (no silent catch — plan Error & Rescue Registry).
      log(`notify failed for incident #${incident.id}: ${error?.message || error}`);
    }
    // Same `at`, no supersede: this completes the record above — it is not a
    // new attempt, so the 3-slot history must not rotate.
    persistOverseer(incident, { ...doneRecord, notifyOutcome });
    return notifyOutcome === "sent" ? { ...outcome, notified: true } : outcome;
  };

  // --- the situation report ---------------------------------------------------
  // Manual-only: "what is happening right now?" over current status, the live
  // incident (if any), recent history, doctor output, and the last 30 minutes
  // of log. Persists to the standalone slot; the verdict is returned even when
  // persistence fails (a report you can see beats a 500 during database
  // trouble). Never notifies, never touches the automatic floor.

  const runSituationReport = async () => {
    const startedAt = nowFn();
    const collectedFrom = startedAt;

    // Same bounded-churn rule as the incident path: a refusal replaces a
    // previous refusal in place; only a real attempt supersedes into history.
    const refuseSituation = (refusal, logLine) => {
      const previous = situationSlot.readRecord().current;
      situationSlot.persist(
        { ...refusal, manual: true, situation: true, at: nowFn() },
        { supersede: previous?.state !== "unavailable" },
      );
      log(logLine);
      emitAuditEvent({
        status: "failed",
        details: {
          mode: "situation",
          manual: true,
          unavailableReason: refusal.reason,
          durationMs: nowFn() - startedAt,
        },
      });
      return { skipped: refusal.reason, mode: "situation" };
    };

    // Preconditions BEFORE the pending stamp: a refusal never writes a pending
    // record it would immediately have to replace.
    const preconditions = await checkSpawnPreconditions();
    if (preconditions.refusal) {
      return refuseSituation(
        preconditions.refusal,
        `situation report unavailable: ${preconditions.refusal.reason}`,
      );
    }
    const { flags } = preconditions;

    const scrubber = buildScrubber();
    if (scrubber.refusal) {
      return refuseSituation(
        scrubber.refusal,
        `situation report refused — redaction sources unreadable: ${scrubber.logMessage}`,
      );
    }
    const { scrub } = scrubber;

    situationSlot.persist(
      { state: "pending", manual: true, situation: true, at: startedAt },
      { supersede: true },
    );

    try {
      return await runSituationBody({ startedAt, collectedFrom, flags, scrub });
    } catch (error) {
      // A bug after the pending stamp must not leave "running" behind: record
      // an honest terminal state under its own reason, distinct from a restart.
      situationSlot.persist({
        state: "failed",
        reason: "error",
        manual: true,
        situation: true,
        summary: "The situation report did not finish — no result was saved.",
        at: nowFn(),
      });
      log(`situation report crashed (fail-open): ${error.message}`);
      emitAuditEvent({
        status: "failed",
        details: { mode: "situation", manual: true, error: true, durationMs: nowFn() - startedAt },
      });
      return { failed: true, code: "review_failed", mode: "situation", error: error.message };
    }
  };

  const safeOpenIncident = () => {
    try {
      return typeof incidentsDb.getOpenIncident === "function"
        ? incidentsDb.getOpenIncident()
        : null;
    } catch {
      return null;
    }
  };

  const runSituationBody = async ({ startedAt, collectedFrom, flags, scrub }) => {
    // The slow step (doctor, up to 60s) runs FIRST so status, incident, events
    // and logs are all read within the same instant just before the prompt is
    // assembled — the trusted status must not predate the untrusted logs.
    const doctor = await collectDoctorOutput();

    // Evidence: every source degrades to a labeled placeholder, never a throw.
    let statusNow = null;
    try {
      statusNow = getWatchdogStatus();
    } catch {}
    const statusAt = nowFn();
    let openIncident = null;
    let openIncidentEvents = [];
    let openIncidentEventsTotal = 0;
    try {
      const open =
        typeof incidentsDb.getOpenIncident === "function"
          ? incidentsDb.getOpenIncident()
          : null;
      if (open) {
        openIncident = incidentsDb.getIncidentById(open.id) || {
          id: open.id,
          incidentKey: open.incidentKey,
          status: "open",
          openedAt: open.openedAt,
        };
        const latest = incidentsDb.getIncidentEvents(open.id, {
          limit: kSituationEventLimit,
          order: "desc",
        });
        // Our own audit rows are the newest rows of a live incident: feeding
        // them back would anchor the model on its previous verdicts.
        openIncidentEvents = latest.events.filter(
          (event) => event.eventType !== kOverseerReviewEventType,
        );
        openIncidentEventsTotal = latest.totalCount;
      }
    } catch (error) {
      log(`situation report: could not read the open incident (${error.message})`);
      openIncident = null;
      openIncidentEvents = [];
    }
    let recentRollups = [];
    try {
      recentRollups = incidentsDb
        .listIncidents({ limit: 6 })
        .filter((entry) => entry.status === "resolved" || entry.status === "abandoned")
        .slice(0, 5)
        .map(rollupRecurrenceEntry);
    } catch {}
    const tail = readTail(kLogReadBytesLate);
    const windowFromMs = nowFn() - kSituationLogWindowMs;
    const logWindow = capLogWindow(
      filterLogWindow(tail.text, { fromMs: windowFromMs, toMs: nowFn() }),
    );
    const coverage = summarizeLogCoverage({
      window: logWindow,
      requestedFromMs: windowFromMs,
      hitCap: tail.hitCap,
    });
    const logCoverage = describeLogCoverage({
      window: logWindow,
      requestedFromMs: windowFromMs,
      hitCap: tail.hitCap,
    });
    const collectedThrough = nowFn();
    const evidence = {
      collectedFrom,
      collectedThrough,
      statusAt,
      windowMs: kSituationLogWindowMs,
      logFrom: logWindow.firstTsMs,
      logThrough: logWindow.lastTsMs,
      logLines: coverage.lineCount,
      logMatched: logWindow.matchedLines,
      logPartial: logWindow.partial,
      logFrontTruncated: coverage.frontTruncated,
      logCapped: coverage.capped,
      doctor: doctor.status,
      // null (not an all-null object) when the status reader threw — the card
      // renders "status: unavailable" and freshness checks skip the fingerprint.
      status: statusNow
        ? {
            health: statusNow.health ?? null,
            lifecycle: statusNow.lifecycle ?? null,
            phase: statusNow.phase ?? null,
            degradedSince: statusNow.degradedSince ?? null,
          }
        : null,
      openIncidentId: openIncident?.id ?? null,
      openIncidentOpenedAt: openIncident?.openedAt ?? null,
    };

    const prompt = scrub(
      buildSituationPrompt({
        statusNow,
        openIncident,
        openIncidentEvents,
        openIncidentEventsTotal,
        recentRollups,
        doctorOutput: doctor.text,
        logWindow,
        logCoverage,
      }),
    );

    // Manual rate limit is consumed here — evidence is about to leave the box.
    // The automatic floor (lastReviewAt) is deliberately NOT touched: a
    // situation report must never postpone a settled incident's review.
    lastManualAt = nowFn();
    const spawn = await spawnAndParse({
      prompt,
      flags,
      scrub,
      verdicts: kSituationVerdicts,
      actions: kSituationActions,
    });
    const base = { manual: true, situation: true, evidence, transcriptTail: spawn.transcriptTail };
    const finalRecord = spawn.failed
      ? { ...base, state: "failed", summary: spawn.summary, at: nowFn() }
      : { ...base, state: "done", ...spawn.verdictRecord, at: nowFn() };
    const write = situationSlot.persist(finalRecord);
    if (!write.ok) {
      log(`situation report could not be saved: ${write.error}`);
      // Best effort: leave an honest terminal state instead of an eternal
      // pending if the store recovers before the next attempt. Same `at` as
      // the report it describes, so a client already holding that report
      // recognizes this as the same attempt rather than a newer failure.
      situationSlot.persist({
        ...base,
        state: "failed",
        reason: "persist_failed",
        summary: "The report ran but its result could not be saved.",
        at: finalRecord.at,
      });
    }
    if (spawn.failed) log("situation report: claude call failed");
    // Stamp the audit row on the incident only if it is STILL the live one —
    // an incident that closed during the spawn must not gain a post-close event.
    const stillOpen = safeOpenIncident();
    emitAuditEvent({
      status: spawn.failed ? "failed" : "ok",
      incidentId:
        stillOpen && stillOpen.id === evidence.openIncidentId ? evidence.openIncidentId : null,
      details: {
        mode: "situation",
        manual: true,
        verdict: spawn.failed ? null : spawn.verdictRecord.verdict,
        durationMs: nowFn() - startedAt,
      },
    });
    return {
      ...(spawn.failed ? { failed: true, code: spawn.code } : { ran: true }),
      mode: "situation",
      record: projectRecordForApi(finalRecord),
      persisted: write.ok,
    };
  };

  // API view of the slot: self-healing read, allowlisted projection, plus the
  // timing the card needs to show a rate-limit countdown.
  const getSituation = () => ({
    ...situationSlot.projectForApi(situationSlot.readRecord()),
    nextManualAt: lastManualAt ? lastManualAt + kManualRateLimitMs : null,
    // null when idle; otherwise what the mutex holds, so the card can say
    // "automatic review of incident #N in progress" instead of "Reviewing…".
    inFlight: inFlight && inFlightInfo ? { ...inFlightInfo } : null,
  });

  // --- triggers ----------------------------------------------------------------

  const maybeReviewNext = async () => {
    if (inFlight) return { skipped: "in_flight" };
    try {
      if (!isEnabled()) return { skipped: "disabled" };
      if (nowFn() - lastReviewAt < globalFloorMs) return { skipped: "cooldown" };
      if (!isHealthySteadyState()) return { skipped: "not_steady_state" };
      const incident = pickEligibleIncident();
      if (!incident) return { skipped: "no_eligible_incident" };
      inFlight = true;
      inFlightInfo = { kind: "automatic", incidentId: incident.id, startedAt: nowFn() };
      try {
        return await runReviewFor(incident, { manual: false });
      } finally {
        inFlight = false;
        inFlightInfo = null;
      }
    } catch (error) {
      inFlight = false;
      inFlightInfo = null;
      log(`overseer trigger failed (fail-open): ${error.message}`);
      return { error: error.message };
    }
  };

  // Operator-initiated review, in ANY watchdog state. No incidentId → a
  // situation report ("what is happening right now?"); an incidentId → the
  // post-incident re-review of that SETTLED incident (bypassing the global
  // floor, the quiet debounce, and the no-existing-review gate). Neither
  // bypasses the enabled flag (consent), availability, or the mutex. The
  // manual rate limit is stamped inside the runners at spawn time, so a
  // precondition refusal never burns the operator's retry budget.
  const requestReview = async ({ incidentId = null } = {}) => {
    if (!isEnabled()) return { ok: false, code: "disabled" };
    if (inFlight) return { ok: false, code: "busy" };
    if (nowFn() - lastManualAt < kManualRateLimitMs) {
      return {
        ok: false,
        code: "rate_limited",
        nextManualAt: lastManualAt + kManualRateLimitMs,
        rateLimitMs: kManualRateLimitMs,
      };
    }
    let incident = null;
    if (incidentId != null) {
      try {
        incident = incidentsDb.getIncidentById(incidentId);
      } catch (error) {
        return { ok: false, code: "query_failed", error: error.message };
      }
      if (!incident) return { ok: false, code: "no_incident" };
      if (incident.status === "open") return { ok: false, code: "incident_open" };
    }
    inFlight = true;
    inFlightInfo = {
      kind: incident ? "incident" : "situation",
      incidentId: incident?.id ?? null,
      startedAt: nowFn(),
    };
    try {
      const result = incident
        ? await runReviewFor(incident, { manual: true })
        : await runSituationReport();
      // The automatic floor is consumed only by incident-bound reviews that
      // actually spawned; a situation report never postpones a settled
      // incident's automatic review.
      if (incident && !result.skipped) lastReviewAt = nowFn();
      const ok = !result.failed && !result.skipped;
      // Refusals from inside the review carry `skipped`/`failed`, not `code`
      // — normalize so the route's 409 body always has a non-empty error.
      return ok
        ? { ok, ...result }
        : {
            ok: false,
            code: result.skipped || result.code || "review_failed",
            ...result,
          };
    } catch (error) {
      log(`manual review failed (fail-open): ${error.message}`);
      return { ok: false, code: "review_failed", error: error.message };
    } finally {
      inFlight = false;
      inFlightInfo = null;
    }
  };

  const start = () => {
    if (periodicTimer) return;
    // Nothing can be in flight when the process boots: a pending situation
    // report is a crash artifact, so it becomes an honest failure now instead
    // of a spinner the card would show until the stale window elapses.
    try {
      situationSlot.markPendingInterrupted();
    } catch {}
    // Same for an operator's incident re-review cut off by the restart. An
    // AUTOMATIC pending is left alone: the stale-pending retry re-runs it (and
    // may notify), which is right for a review the operator never asked for.
    try {
      for (const incident of incidentsDb.listIncidents?.({ limit: 50 }) || []) {
        const current = readOverseerRecord(incident).current;
        if (current?.state === "pending" && current.manual === true) {
          persistOverseer(incident, {
            ...current,
            state: "failed",
            reason: "interrupted",
            summary: "Interrupted by a server restart.",
            at: nowFn(),
          });
        }
      }
    } catch {}
    bootTimer = setTimeout(() => {
      maybeReviewNext().catch(() => {});
    }, bootDelayMs);
    bootTimer.unref?.();
    periodicTimer = setInterval(() => {
      maybeReviewNext().catch(() => {});
    }, periodicCheckMs);
    periodicTimer.unref?.();
  };

  const stop = () => {
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
    if (bootTimer) clearTimeout(bootTimer);
    bootTimer = null;
    // Best-effort removal of the isolated HOME (claude CLI writes session
    // state there); the boot-time prefix sweep covers crash exits.
    if (overseerHomeDir) {
      try {
        fsModule.rmSync?.(overseerHomeDir, { recursive: true, force: true });
      } catch {}
      overseerHomeDir = null;
    }
  };

  return {
    getAvailability,
    getSituation,
    maybeReviewNext,
    requestReview,
    buildOverseerEnv,
    start,
    stop,
  };
};

module.exports = {
  createWatchdogOverseer,
  filterLogWindow,
  describeLogCoverage,
  sanitizeVerdictText,
  buildIncidentPrompt,
  buildSituationPrompt,
  parseVerdict,
  kSituationVerdicts,
  kSituationActions,
  kSituationLogWindowMs,
  kLogEvidenceMaxChars,
  kManualRateLimitMs,
  // #87: deterministic admission + the shared critical-class predicate.
  isCriticalClassIncident,
  isActionableVerdict,
  classifyAutoReviewEligibility,
  kAutoReviewMaxAgeMs,
  kAutoReviewSkipReasons,
  kCriticalClassIncidentKeys,
  kSkipMarkedMaxEntries,
  // Exported for the trusted-projection tests: the status allowlist and the
  // memory-trend validator must provably drop smuggled strings/malformed enums.
  pickTrustedStatus,
  pickTrustedResources,
};
