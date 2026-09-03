// Tracks whether the `openclaw doctor` CLI itself is usable — the state that
// was invisible during the 2026-09-01 incident (a doctor crashing ~530x/day
// looked identical to "zero findings" on every AlphaClaw surface).
//
// Transition-only surfacing: state CHANGES emit one `doctor_probe` watchdog
// event (via the late-bound onEvent — the watchdog is constructed after the
// early doctor consumers) AND one console line, which lands in
// logs/process.log — the surface operators actually grep mid-incident.
// A version change (channel apply) resets state: a new build may fix the CLI.
//
// Deliberately NO circuit breaker (removed in review): every consumer is
// transition- or incident-gated after the doctorJsonShape probe deletion, and
// a breaker starves medic/overseer evidence in exactly the post-repair window
// where it matters most. Accepted nuance: state is process-local, so each
// supervisor restart may re-emit one fresh transition — one line per process
// lifetime, not a storm.
const createDoctorAvailability = ({
  nowFn = Date.now,
  getInstalledVersion = () => null,
  onEvent = null,
  log = (msg) => console.log(msg),
} = {}) => {
  let last = null; // { status, reason, detail, at, version, consecutiveUnavailable }

  const get = () =>
    last
      ? {
          status: last.status,
          reason: last.reason || null,
          detail: last.detail || null,
          at: last.at,
          version: last.version || null,
          consecutiveUnavailable: last.consecutiveUnavailable || 0,
        }
      : null;

  const record = (classification, { source = "unknown" } = {}) => {
    if (!classification || typeof classification.status !== "string") return get();
    let version = null;
    try {
      version = getInstalledVersion() || null;
    } catch {
      version = null;
    }
    if (last && last.version !== version) {
      // Channel apply/rollback: prior state describes a different build.
      last = null;
    }
    const prevStatus = last?.status || null;
    const nextStatus = classification.status;
    const consecutiveUnavailable =
      nextStatus === "unavailable" ? (last?.consecutiveUnavailable || 0) + 1 : 0;
    last = {
      status: nextStatus,
      reason: classification.reason || null,
      detail: classification.detail || null,
      at: nowFn(),
      version,
      consecutiveUnavailable,
    };
    // Transition-only: unavailable<->(usable|unusable) flips, not repeats.
    const wasUnavailable = prevStatus === "unavailable";
    const isUnavailable = nextStatus === "unavailable";
    if (wasUnavailable !== isUnavailable) {
      const line = isUnavailable
        ? `[alphaclaw] openclaw doctor CLI is UNAVAILABLE (${last.reason}${last.detail ? `: ${last.detail}` : ""}) — upstream findings and doctor evidence are suspended; gateway health is unaffected (probe-driven)`
        : `[alphaclaw] openclaw doctor CLI recovered (${last.reason || nextStatus})`;
      log(line);
      try {
        onEvent?.({
          kind: "doctor_probe",
          status: isUnavailable ? "failed" : "ok",
          details: {
            source,
            reason: last.reason,
            detail: last.detail,
            version,
          },
        });
      } catch {
        // Event sink unavailable (pre-watchdog-wire) — the console line above
        // already carries the signal; dropping the event is harmless.
      }
    }
    return get();
  };

  return { record, get };
};

module.exports = { createDoctorAvailability };
