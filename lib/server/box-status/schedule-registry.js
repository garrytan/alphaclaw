// AlphaClaw's own recurring work, as the box status lists it (ALPH-40): each
// timer defines itself once and reports every run, so GET /api/box/schedules
// can say when it last ran, how that ended and when it runs next. Recording a
// run never changes the work: track() returns or throws exactly what the work
// does, and a describe() callback that throws is ignored.
const kMaxDetailChars = 200;

const createScheduleRegistry = ({ nowFn = Date.now } = {}) => {
  const entries = new Map();

  // schedule: plain words for the operator ("every 30 min"); intervalMs makes
  // nextRunAt computable, null for event-driven work.
  const define = (id, { title, schedule, intervalMs = null }) => {
    const entry = entries.get(id) || { id, active: false, activeSince: null, lastStartedAt: null, lastFinishedAt: null, lastOutcome: null, lastDetail: null, running: false, runs: 0 };
    Object.assign(entry, { title, schedule, intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : null });
    entries.set(id, entry);
    return entry;
  };

  const setActive = (id, active) => {
    const entry = entries.get(id);
    if (!entry) return;
    entry.active = !!active;
    entry.activeSince = active ? nowFn() : null;
  };

  const started = (id) => {
    const entry = entries.get(id);
    if (!entry) return;
    entry.running = true;
    entry.lastStartedAt = nowFn();
    entry.runs += 1;
  };

  const finished = (id, { outcome = "ok", detail = null } = {}) => {
    const entry = entries.get(id);
    if (!entry) return;
    entry.running = false;
    entry.lastFinishedAt = nowFn();
    entry.lastOutcome = String(outcome).slice(0, 32);
    entry.lastDetail = detail == null ? null : String(detail).slice(0, kMaxDetailChars);
  };

  // Runs work() and records it. describe(result) names the outcome and an
  // optional detail; a throw records "failed" and rethrows.
  const track = (id, work, describe = null) => {
    started(id);
    const settle = (result) => {
      let described = null;
      try { described = describe ? describe(result) : null; } catch {}
      finished(id, described || {});
      return result;
    };
    const fail = (error) => {
      finished(id, { outcome: "failed", detail: error?.message || String(error) });
      throw error;
    };
    let result;
    try {
      result = work();
    } catch (error) {
      return fail(error);
    }
    return result && typeof result.then === "function" ? result.then(settle, fail) : settle(result);
  };

  const list = () => [...entries.values()].map((entry) => {
    const base = entry.lastStartedAt ?? entry.activeSince;
    return {
      id: entry.id,
      title: entry.title,
      schedule: entry.schedule,
      active: entry.active,
      running: entry.running,
      runs: entry.runs,
      lastRunAt: entry.lastStartedAt === null ? null : new Date(entry.lastStartedAt).toISOString(),
      lastFinishedAt: entry.lastFinishedAt === null ? null : new Date(entry.lastFinishedAt).toISOString(),
      lastOutcome: entry.lastOutcome,
      lastDetail: entry.lastDetail,
      nextRunAt: entry.active && entry.intervalMs && base !== null ? new Date(base + entry.intervalMs).toISOString() : null,
    };
  });

  return { define, setActive, started, finished, track, list, reset: () => entries.clear() };
};

const scheduleRegistry = createScheduleRegistry();

module.exports = { createScheduleRegistry, scheduleRegistry };
