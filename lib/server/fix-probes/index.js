const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../utils/safe-file");
const kinds = require("./kinds");

// Fix probes (GST-3436): a named list of read-only checks in alphaclaw.json
// fixProbes, each tied to the issue whose fix it proves, run 10 minutes
// after the gateway first answers ready (20 minutes after start if it never
// does), daily at fixProbes.dailyAtUtc and on demand. A probe reads one
// source (OpenClaw's file log, the webhook log, git-push-checks' summary, a
// file under an allowed root, the relay's long-reply counters) and never
// runs a process, opens a socket or writes anywhere but its own state file.
// A probe that turns red tells the owner once per cause, and once more when
// it passes again. When the set of watched issues changes, one summary lists
// each issue code and its state and nothing else. Results carry codes,
// counts and booleans only, never a line, content, payload, configured
// substring, marker or path.
const kStateFileName = "fix-probes.json";
const kMaxProbes = 32;
const kFirstRunAfterReadyMs = 10 * 60_000;
const kFirstRunFallbackMs = 20 * 60_000;
const kRunBudgetMs = 60_000;
const kManualRunGapMs = 60_000;
const kDefaultDailyAtUtc = "15:00";
const kKinds = Object.freeze(["log_count", "webhook_deliveries", "push_checks", "file_check", "relay_long_replies"]);
const kNamePattern = /^[a-z0-9][a-z0-9._-]{0,59}$/i;
const kIssuePattern = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const kHookPattern = /^[A-Za-z0-9._-]{1,64}$/;
const kDailyPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const kMinRowsNeverTrimmed = 25;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const plainText = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, max) : "");

class InvalidProbe extends Error {
  constructor(field, fix) {
    super(fix);
    this.field = field;
  }
}
const need = (condition, field, fix) => {
  if (!condition) throw new InvalidProbe(field, fix);
};
const literals = (value, field, { min, max, count }) => {
  need(Array.isArray(value) && value.length >= 1 && value.length <= count, field, field + " must list 1 to " + count + " strings");
  for (const entry of value) need(typeof entry === "string" && entry.length >= min && entry.length <= max, field, "each entry of " + field + " must be " + min + " to " + max + " characters");
  return value.slice();
};
const optionalCount = (expect, key) => {
  if (expect[key] === undefined) return undefined;
  need(isCount(expect[key]), "expect." + key, "expect." + key + " must be an integer of 0 or more");
  return expect[key];
};
const hours = (value, max, field) => {
  need(Number.isInteger(value) && value >= 1 && value <= max, field, field + " must be a whole number of hours from 1 to " + max);
  return value;
};

const normalizeProbe = (raw, { fileRoots }) => {
  need(isObject(raw), "probe", "each probe must be an object");
  need(kNamePattern.test(String(raw.name || "")), "name", "name must be 1 to 60 letters, digits, dots, dashes or underscores");
  need(kIssuePattern.test(String(raw.issue || "")), "issue", "issue must be an issue code such as GST-1234");
  need(kKinds.includes(raw.kind), "kind", "kind must be one of " + kKinds.join(", "));
  need(raw.allowWrite === undefined || raw.allowWrite === false, "allowWrite", "allowWrite is reserved: no probe kind may write yet");
  const expect = isObject(raw.expect) ? raw.expect : {};
  const base = { name: raw.name, issue: raw.issue, kind: raw.kind, enabled: raw.enabled !== false, fix: plainText(raw.fix, 200) };
  if (raw.kind === "log_count") {
    const normalized = {
      ...base,
      match: literals(raw.match, "match", { min: 3, max: 200, count: 4 }),
      windowHours: hours(raw.windowHours ?? 24, 24, "windowHours"),
      expect: { min: optionalCount(expect, "min"), max: optionalCount(expect, "max"), sourceMin: expect.sourceMin === undefined ? 1 : optionalCount(expect, "sourceMin") },
    };
    need(typeof expect.liveness === "string" && expect.liveness.length >= 3 && expect.liveness.length <= 200, "expect.liveness", "expect.liveness must be a 3 to 200 character line fragment that appears in the log every day, so a silent log is not read as a pass");
    normalized.expect.liveness = expect.liveness;
    need(normalized.expect.sourceMin >= 1, "expect.sourceMin", "expect.sourceMin must be 1 or more");
    need(normalized.expect.min !== undefined || normalized.expect.max !== undefined, "expect", "set expect.min or expect.max");
    return normalized;
  }
  if (raw.kind === "webhook_deliveries") {
    need(kHookPattern.test(String(raw.hook || "")), "hook", "hook must be the hook name as it appears in /hooks/<name>");
    const normalized = {
      ...base,
      hook: raw.hook,
      windowHours: hours(raw.windowHours ?? 72, 168, "windowHours"),
      expect: { minSigned2xx: optionalCount(expect, "minSigned2xx"), maxAdmittedUnsigned: optionalCount(expect, "maxAdmittedUnsigned"), maxFailed: optionalCount(expect, "maxFailed") },
    };
    need(Object.values(normalized.expect).some((value) => value !== undefined), "expect", "set at least one of expect.minSigned2xx, expect.maxAdmittedUnsigned, expect.maxFailed");
    return normalized;
  }
  if (raw.kind === "push_checks") {
    need(Number.isInteger(expect.maxAgeMinutes) && expect.maxAgeMinutes >= 5 && expect.maxAgeMinutes <= 1440, "expect.maxAgeMinutes", "expect.maxAgeMinutes must be 5 to 1440");
    return { ...base, expect: { maxAgeMinutes: expect.maxAgeMinutes, minListedProbed: optionalCount(expect, "minListedProbed"), maxUntold: expect.maxUntold === undefined ? 0 : optionalCount(expect, "maxUntold") } };
  }
  if (raw.kind === "file_check") {
    need(typeof raw.file === "string" && path.isAbsolute(raw.file), "file", "file must be an absolute path");
    need(fileRoots.some((root) => path.resolve(raw.file).startsWith(root + path.sep)), "file", "file must sit under the agent workspace or a folder listed in fixProbes.fileRoots");
    const normalized = {
      ...base,
      file: path.resolve(raw.file),
      expect: {
        ...(expect.exists !== undefined ? { exists: expect.exists === true } : {}),
        ...(expect.containsAll !== undefined ? { containsAll: literals(expect.containsAll, "expect.containsAll", { min: 12, max: 200, count: 4 }) } : {}),
        ...(expect.maxChars !== undefined ? { maxChars: optionalCount(expect, "maxChars") } : {}),
      },
    };
    need(typeof expect.exists === "boolean" || expect.exists === undefined, "expect.exists", "expect.exists must be true or false");
    need(Object.keys(normalized.expect).length > 0, "expect", "set expect.exists, expect.containsAll or expect.maxChars");
    return normalized;
  }
  const windowDays = raw.windowDays ?? 7;
  need(Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 8, "windowDays", "windowDays must be 1 to 8");
  need(isCount(expect.maxCut), "expect.maxCut", "expect.maxCut must be an integer of 0 or more");
  return { ...base, windowDays, expect: { maxCut: expect.maxCut, minSeen: optionalCount(expect, "minSeen") } };
};

// alphaclaw.json fixProbes → { probes, invalid, dailyAtUtc, fileRoots }. A
// probe that fails a check is never run; it is listed with the field and a
// fix line so the operator sees it in the status API, not only in a log.
const normalizeFixProbesConfig = (raw, { workspaceDir }) => {
  const base = isObject(raw) ? raw : {};
  const fileRoots = [...new Set([workspaceDir, ...(Array.isArray(base.fileRoots) ? base.fileRoots : [])].filter((entry) => typeof entry === "string" && path.isAbsolute(entry)).map((entry) => path.resolve(entry)))].slice(0, 9);
  const dailyAtUtc = typeof base.dailyAtUtc === "string" && kDailyPattern.test(base.dailyAtUtc) ? base.dailyAtUtc : kDefaultDailyAtUtc;
  const probes = [];
  const invalid = [];
  const names = new Set();
  (Array.isArray(base.probes) ? base.probes : []).forEach((entry, index) => {
    const label = { index, ...(kNamePattern.test(String(entry?.name || "")) ? { name: entry.name } : {}), ...(kIssuePattern.test(String(entry?.issue || "")) ? { issue: entry.issue } : {}) };
    try {
      need(index < kMaxProbes, "probes", "at most " + kMaxProbes + " probes run; this one is past the limit");
      const probe = normalizeProbe(entry, { fileRoots });
      need(!names.has(probe.name), "name", "another probe already has this name");
      names.add(probe.name);
      probes.push(probe);
    } catch (error) {
      if (!(error instanceof InvalidProbe)) throw error;
      invalid.push({ ...label, code: "fix_probe_invalid", field: error.field, fix: error.message });
    }
  });
  return { probes, invalid, dailyAtUtc, fileRoots };
};

const stateOf = (result) => {
  if (result.code === "ok") return "passing";
  if (result.code === "not_checked") return "not checked";
  if (["no_coverage", "probe_error", "file_refused"].includes(result.code)) return "no data";
  return "failing";
};
const isRed = (state) => state === "failing" || state === "no data";

const nextDailyAt = (dailyAtUtc, nowMs) => {
  const [, hh, mm] = kDailyPattern.exec(dailyAtUtc);
  const now = new Date(nowMs);
  let at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(hh), Number(mm));
  if (at <= nowMs) at += 24 * 3_600_000;
  return at;
};

const describeProblem = (probe, result, state) => {
  const fix = probe.fix || "Check " + probe.issue + "; after a fix, run alphaclaw admin POST /api/fix-probes/run.";
  if (state === "no data") {
    const why = result.code === "no_coverage"
      ? "Its source showed no sign of life in its window, so it can't prove the fix is still in."
      : result.code === "file_refused"
        ? "Its file is outside the allowed folders or is a protected file, so it was not read."
        : "It could not read its source.";
    return "⚠️ Fix check has no data: " + probe.name + " (" + probe.issue + "). " + why + " " + fix;
  }
  const expected = result.expected;
  const detail = expected
    ? "Expected " + expected.label + " to be " + (expected.kind === "min" ? "at least " : "at most ") + expected.limit + ", found " + expected.found + "."
    : "A file it needs is missing or unexpectedly present.";
  return "⚠️ Fix check failing: " + probe.name + " (" + probe.issue + "). " + detail + " " + fix;
};

const issueStates = (probes, results) => {
  const order = ["failing", "no data", "passing", "not checked"];
  const byIssue = new Map();
  probes.forEach((probe, index) => {
    const state = stateOf(results[index]);
    const current = byIssue.get(probe.issue);
    if (!current || order.indexOf(state) < order.indexOf(current)) byIssue.set(probe.issue, state);
  });
  return [...byIssue.entries()];
};

const createFixProbes = ({
  openclawDir,
  workspaceDir,
  readConfig,
  readLogFile,
  summarizeHookDeliveries,
  readRelayLongReplies,
  notify,
  insertEvent,
  fsModule = fs,
  nowFn = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}) => {
  const statePath = path.join(openclawDir, ".alphaclaw", kStateFileName);
  const pushStatePath = path.join(openclawDir, ".alphaclaw", "git-push-checks.json");
  const lastLogged = new Map();
  let running = null;
  let runningId = null;
  let lastManualAt = 0;
  let firstTimer = null;
  let dailyTimer = null;
  let nextRunAt = null;
  let firstRunDone = false;
  let stopped = false;

  const readState = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(statePath, "utf8"));
      return isObject(parsed) && isObject(parsed.probes) ? parsed : { probes: {} };
    } catch {
      return { probes: {} };
    }
  };
  const writeState = (state) => {
    try {
      fsModule.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n", { fsModule, mode: 0o600 });
    } catch (error) {
      logger.warn?.("[alphaclaw] fix-probe state write failed: " + error.message);
    }
  };
  const readConfigNow = () => normalizeFixProbesConfig(readConfig?.(), { workspaceDir });
  const send = async (message, id) => {
    try {
      const result = await notify?.(message, { eventType: "health", id });
      if (result?.ok === false && result.skipped !== true) throw new Error(String(result.reason || "the notifier did not accept it"));
      return true;
    } catch (error) {
      logger.warn?.("[alphaclaw] fix-probe notification " + id + " failed, retrying next run: " + error.message);
      return false;
    }
  };
  const recordEvent = (event) => {
    try {
      insertEvent?.({ eventType: "fix_probe", source: "fix-probes", ...event });
    } catch {}
  };

  const readPushSummary = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(pushStatePath, "utf8"));
      return isObject(parsed?.summary) ? parsed.summary : null;
    } catch {
      return null;
    }
  };

  const probeAll = async (probes, startedAt, fileRoots) => {
    const results = new Array(probes.length);
    const logIndexes = probes.map((probe, index) => (probe.kind === "log_count" ? index : -1)).filter((index) => index >= 0);
    if (logIndexes.length > 0) {
      try {
        const logFile = readLogFile?.();
        if (!logFile) throw new Error("no OpenClaw file log is configured");
        const { counts } = kinds.scanLogs({ probes: logIndexes.map((index) => probes[index]), logFile, nowMs: startedAt, fsModule });
        logIndexes.forEach((index, position) => {
          results[index] = kinds.judgeLogCount(probes[index], counts[position]);
        });
      } catch (error) {
        logIndexes.forEach((index) => {
          results[index] = { ok: false, code: "probe_error", observed: {}, coverage: { ok: false }, reason: "log unreadable" };
        });
        logger.warn?.("[alphaclaw] fix-probe log read failed: " + error.message);
      }
    }
    for (const [index, probe] of probes.entries()) {
      if (results[index]) continue;
      if (nowFn() - startedAt > kRunBudgetMs) {
        results[index] = { ok: false, code: "probe_error", observed: {}, coverage: { ok: false }, reason: "run out of time" };
        continue;
      }
      try {
        if (probe.kind === "webhook_deliveries") {
          const windowStart = new Date(startedAt - probe.windowHours * 3_600_000).toISOString();
          results[index] = kinds.judgeWebhookDeliveries(probe, { ...summarizeHookDeliveries({ hookName: probe.hook, sinceIso: windowStart }), windowStart }, { minRowsNeverTrimmed: kMinRowsNeverTrimmed });
        } else if (probe.kind === "push_checks") {
          results[index] = kinds.judgePushChecks(probe, readPushSummary(), startedAt);
        } else if (probe.kind === "file_check") {
          results[index] = kinds.runFileCheck(probe, { roots: fileRoots, fsModule });
        } else {
          results[index] = kinds.judgeRelayLongReplies(probe, await readRelayLongReplies?.({ days: probe.windowDays, nowMs: startedAt }));
        }
      } catch (error) {
        results[index] = { ok: false, code: "probe_error", observed: {}, coverage: { ok: false }, reason: "source unreadable" };
        logger.warn?.("[alphaclaw] fix-probe " + probe.name + " could not read its source: " + String(error?.message || error).slice(0, 160));
      }
    }
    return results;
  };

  const settle = async ({ probe, result, previous, at, summaryCovers }) => {
    const state = stateOf(result);
    if (state === "not checked" && previous && isRed(previous.state)) return previous;
    if (!isRed(state)) {
      if (previous?.notifiedAt && isRed(previous.state)) {
        const sent = await send("✅ Fix check passing again: " + probe.name + " (" + probe.issue + ").", "fix-probe-cleared-" + probe.name + "-" + previous.since);
        if (!sent) return previous;
      }
      return { state, code: result.code, since: previous?.state === state ? previous.since : at };
    }
    const same = previous?.state === state && previous?.code === result.code;
    const next = { state, code: result.code, since: same ? previous.since : at, notifiedAt: same ? previous.notifiedAt || null : null };
    if (next.notifiedAt) return next;
    if (summaryCovers) return { ...next, notifiedAt: at };
    if (await send(describeProblem(probe, result, state), "fix-probe-" + probe.name + "-" + result.code + "-" + next.since)) next.notifiedAt = at;
    return next;
  };

  const runOnce = async (trigger, runId) => {
    const startedAt = nowFn();
    const at = new Date(startedAt).toISOString();
    const config = readConfigNow();
    const probes = config.probes.filter((probe) => probe.enabled);
    const state = readState();
    const results = await probeAll(probes, startedAt, config.fileRoots);
    const summaryKey = probes.map((probe) => probe.name + ":" + probe.issue).sort().join(",");
    const sendSummary = summaryKey !== "" && summaryKey !== state.summaryKey;
    const nextProbes = {};
    for (const [index, probe] of probes.entries()) {
      const previous = state.probes[probe.name];
      const settled = await settle({ probe, result: results[index], previous, at, summaryCovers: sendSummary });
      nextProbes[probe.name] = { ...settled, issue: probe.issue };
      if (previous?.state !== settled.state) {
        recordEvent({ status: isRed(settled.state) ? "warning" : "ok", details: { probe: probe.name, issue: probe.issue, state: settled.state, code: results[index].code } });
      }
      const line = settled.state + " code=" + results[index].code;
      if (lastLogged.get(probe.name) !== line) {
        lastLogged.set(probe.name, line);
        logger.log?.("[alphaclaw] fix-probe " + probe.name + " (" + probe.issue + "): " + line);
      }
    }
    let nextSummaryKey = summaryKey === "" ? null : state.summaryKey || null;
    if (sendSummary) {
      const text = "🔎 Fix checks now watching: " + issueStates(probes, results).map(([issue, value]) => issue + " " + value).join(", ") + ".";
      if (await send(text, "fix-probe-summary-" + crypto.createHash("sha256").update(summaryKey).digest("hex").slice(0, 12))) nextSummaryKey = summaryKey;
      else for (const name of Object.keys(nextProbes)) if (nextProbes[name].notifiedAt === at) nextProbes[name].notifiedAt = null;
    }
    const reported = probes.map((probe, index) => ({
      name: probe.name,
      issue: probe.issue,
      kind: probe.kind,
      state: stateOf(results[index]),
      code: results[index].code,
      observed: results[index].observed,
      coverage: results[index].coverage,
      ...(results[index].expected ? { expected: results[index].expected } : {}),
    }));
    const finishedAt = new Date(nowFn()).toISOString();
    recordEvent({
      status: reported.some((entry) => isRed(entry.state)) ? "warning" : "ok",
      details: { run: runId, trigger, states: Object.fromEntries(reported.map((entry) => [entry.name, entry.state])), invalid: config.invalid.length },
    });
    writeState({ probes: nextProbes, ...(nextSummaryKey ? { summaryKey: nextSummaryKey } : {}), lastRun: { runId, trigger, startedAt: at, finishedAt, results: reported, invalid: config.invalid } });
    return { runId, trigger, startedAt: at, finishedAt, results: reported, invalid: config.invalid };
  };

  const run = (trigger) => {
    if (running) return { busy: true, runId: runningId, promise: running };
    runningId = "fp_" + nowFn().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
    running = runOnce(trigger, runningId).finally(() => {
      running = null;
      runningId = null;
    });
    return { busy: false, promise: running };
  };

  const scheduleDaily = () => {
    if (stopped) return;
    if (dailyTimer) clearTimer(dailyTimer);
    const at = nextDailyAt(readConfigNow().dailyAtUtc, nowFn());
    nextRunAt = new Date(at).toISOString();
    dailyTimer = setTimer(async () => {
      dailyTimer = null;
      await runScheduled("daily");
    }, at - nowFn());
    dailyTimer?.unref?.();
  };
  const runScheduled = async (trigger) => {
    const started = run(trigger);
    if (!started.busy) {
      try {
        await started.promise;
      } catch (error) {
        logger.warn?.("[alphaclaw] fix-probe run failed: " + error.message);
      }
    }
    firstRunDone = true;
    scheduleDaily();
  };
  const scheduleFirst = (delayMs) => {
    if (stopped || firstRunDone) return;
    if (firstTimer) clearTimer(firstTimer);
    nextRunAt = new Date(nowFn() + delayMs).toISOString();
    firstTimer = setTimer(async () => {
      firstTimer = null;
      await runScheduled("boot");
    }, delayMs);
    firstTimer?.unref?.();
  };

  let readySeen = false;
  return {
    start: () => scheduleFirst(kFirstRunFallbackMs),
    onGatewayReady: () => {
      if (readySeen) return;
      readySeen = true;
      scheduleFirst(kFirstRunAfterReadyMs);
    },
    stop: () => {
      stopped = true;
      if (firstTimer) clearTimer(firstTimer);
      if (dailyTimer) clearTimer(dailyTimer);
    },
    // POST /api/fix-probes/run: one at a time, at most one manual start a
    // minute across the server, answered within the run budget.
    runNow: async () => {
      if (running) return { status: 409, body: { ok: false, error: "fix_probe_run_in_progress", runId: runningId, message: "A fix probe run is already in progress; read GET /api/fix-probes when it finishes." } };
      const waitMs = lastManualAt + kManualRunGapMs - nowFn();
      if (waitMs > 0) {
        return { status: 429, retryAfterSeconds: Math.ceil(waitMs / 1000), body: { ok: false, error: "fix_probe_rate_limited", message: "Fix probes run on demand at most once a minute; retry after " + Math.ceil(waitMs / 1000) + " s." } };
      }
      lastManualAt = nowFn();
      const started = run("manual");
      const outcome = await started.promise;
      return { status: 200, body: { ok: true, ...outcome } };
    },
    getStatus: () => {
      const config = readConfigNow();
      const state = readState();
      const last = state.lastRun || null;
      const byName = new Map((last?.results || []).map((entry) => [entry.name, entry]));
      return {
        ok: true,
        running: Boolean(running),
        dailyAtUtc: config.dailyAtUtc,
        nextRunAt,
        lastRun: last ? { runId: last.runId, trigger: last.trigger, startedAt: last.startedAt, finishedAt: last.finishedAt } : null,
        probes: config.probes.map((probe) => {
          const result = byName.get(probe.name);
          return {
            name: probe.name,
            issue: probe.issue,
            kind: probe.kind,
            enabled: probe.enabled,
            state: !probe.enabled ? "disabled" : result?.state || "not run yet",
            ...(result ? { code: result.code, observed: result.observed, coverage: result.coverage, ...(result.expected ? { expected: result.expected } : {}), checkedAt: last.finishedAt } : {}),
          };
        }),
        invalid: config.invalid,
      };
    },
  };
};

module.exports = { createFixProbes, normalizeFixProbesConfig, nextDailyAt, stateOf, kKinds };
