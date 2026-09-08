// One ordering/freshness policy for SSE and REST. Delivery proves transport
// reachability; only the server's observation stamp proves data freshness.
export const kStatusObservationStaleAfterMs = 15_000;

export const normalizeStatusSnapshot = (payload, receivedAt = Date.now()) => {
  if (!payload || typeof payload !== "object") return null;
  const { timestamp, snapshotEpoch, snapshotRevision, snapshotStale, snapshotErrorCount,
    watchdogStatus, doctorStatus, ...flatStatus } = payload;
  const status = payload.status && typeof payload.status === "object" ? payload.status : flatStatus;
  if (!status || typeof status !== "object" || (!status.gateway && !status.state && !payload.status)) return null;
  const parsedAt = typeof timestamp === "number" ? timestamp : Date.parse(timestamp || "");
  return {
    status, watchdogStatus, doctorStatus,
    epoch: typeof snapshotEpoch === "string" ? snapshotEpoch : "",
    revision: Number.isSafeInteger(snapshotRevision) && snapshotRevision >= 0 ? snapshotRevision : null,
    observedAt: Number.isFinite(parsedAt) ? parsedAt : receivedAt,
    stale: snapshotStale === true,
    receivedAt,
  };
};

export const createStatusIngestion = ({ now = () => Date.now(), staleAfterMs = kStatusObservationStaleAfterMs } = {}) => {
  let current = null;
  let serial = 0;
  let streamGeneration = 0;
  let lastReceivedAt = 0;
  let epochClockOffsetMs = 0;
  const retiredEpochs = new Set();
  const beginRequest = () => ({ serial, streamGeneration });
  const beginStream = () => ++streamGeneration;
  const endStream = (generation) => { if (generation === streamGeneration) streamGeneration++; };
  const accept = (payload, { request = null, stream = null } = {}) => {
    // Cache hydration can seed an empty view. Only a current transport may
    // replace it: an old cached epoch has no request/connection to fence.
    if (current && !request && stream === null) return false;
    if (stream !== null && stream !== streamGeneration) return false;
    if (request && request.streamGeneration !== streamGeneration) return false;
    const next = normalizeStatusSnapshot(payload, now());
    if (!next) return false;
    if (request || stream !== null) lastReceivedAt = next.receivedAt;
    if (current) {
      if (next.epoch && retiredEpochs.has(next.epoch)) return false;
      if (next.epoch === current.epoch && next.revision !== null && current.revision !== null) {
        if (next.revision <= current.revision) return false;
      } else {
        if (next.epoch === current.epoch && current.revision !== null && next.revision === null) return false;
        // A response started before an accepted observation cannot introduce
        // an unfamiliar epoch (or legacy unversioned data) after that point.
        if (request && request.serial !== serial) return false;
        if (next.epoch === current.epoch && next.observedAt < current.observedAt) return false;
        if (!next.epoch && current.epoch) return false;
      }
      if (current.epoch && next.epoch && next.epoch !== current.epoch) {
        retiredEpochs.add(current.epoch);
        if (retiredEpochs.size > 32) retiredEpochs.delete(retiredEpochs.values().next().value);
        // A new process may start after its wall clock moves backwards.
        // Establish that epoch's offset once; subsequent delivery delays
        // must age observations, never recalibrate the clock on every frame.
        epochClockOffsetMs = next.observedAt < current.observedAt
          ? next.receivedAt - next.observedAt
          : 0;
      }
    }
    // The timestamp belongs to the successful observation, not delivery.
    // In particular a delayed REST response, buffered SSE frame, or cached
    // fresh flag cannot make a previously old observation current again.
    next.ageFrom = Math.min(next.receivedAt, next.observedAt + epochClockOffsetMs);
    current = next;
    serial++;
    return true;
  };
  const getFreshness = () => {
    if (!current) return { mode: "unknown", observedAtMs: 0, receivedAtMs: 0 };
    return {
      mode: current.stale || now() - current.ageFrom > staleAfterMs ? "stale" : "fresh",
      observedAtMs: current.observedAt,
      receivedAtMs: lastReceivedAt,
    };
  };
  return { beginRequest, beginStream, endStream, accept, get: () => current, getFreshness };
};
