const { kStatusSnapshotIntervalMs, kStatusSnapshotFreshnessMs, kStatusSnapshotHeartbeatMs } = require("./constants");

// One shared snapshot for every status consumer. Previously each SSE
// connection ran its own 2s interval recomputing the full payload (including
// blocking spawns and workspace hashing), so N open tabs meant N× the work on
// a single-threaded server. Here: one interval (alive only while clients are
// connected), one compute at a time, and identical frames are skipped —
// bounded by a heartbeat so clients can distinguish "no change" from "hung".
//
// Fields that change on every sample (ages, probe timestamps) are excluded
// from the change-detection projection; the heartbeat frame refreshes them
// at least every kStatusSnapshotHeartbeatMs.
const kVolatileProjectionKeys = new Set([
  "timestamp",
  "lastRunAgeMs",
  "lastHealthCheckAt",
  "uptimeMs",
]);

const projectionOf = (payload) =>
  JSON.stringify(payload, (key, value) =>
    kVolatileProjectionKeys.has(key) ? undefined : value,
  );

const createStatusSnapshotService = ({
  compute,
  intervalMs = kStatusSnapshotIntervalMs,
  freshnessMs = kStatusSnapshotFreshnessMs,
  heartbeatMs = kStatusSnapshotHeartbeatMs,
  now = () => Date.now(),
  logger = console,
} = {}) => {
  const clients = new Set();
  let intervalId = null;
  let computePromise = null;
  let lastSnapshot = null; // { payload, computedAt }
  let lastProjection = null;
  let lastFrameAt = 0;
  let computeErrorCount = 0;

  const computeCoalesced = () => {
    if (computePromise) return computePromise;
    computePromise = Promise.resolve()
      .then(() => compute())
      .then((payload) => {
        lastSnapshot = { payload, computedAt: now() };
        computeErrorCount = 0;
        return lastSnapshot;
      })
      .catch((err) => {
        computeErrorCount += 1;
        if (computeErrorCount === 1) {
          logger.warn?.(
            `[alphaclaw] status snapshot compute failed: ${err?.message || err}`,
          );
        }
        // Serve the last good snapshot; callers with no snapshot yet see the
        // rejection (same contract the per-request path had).
        if (lastSnapshot) return lastSnapshot;
        throw err;
      })
      .finally(() => {
        computePromise = null;
      });
    return computePromise;
  };

  const frameDataFor = (snapshot) =>
    `data: ${JSON.stringify({
      ...snapshot.payload,
      timestamp: new Date(now()).toISOString(),
    })}\n\n`;

  const sendTo = (res, data) => {
    try {
      res.write("event: status\n");
      res.write(data);
    } catch {}
  };

  const writeFrame = (snapshot) => {
    const data = frameDataFor(snapshot);
    for (const res of clients) sendTo(res, data);
    lastFrameAt = now();
  };

  const tick = async () => {
    if (computePromise) return; // in-flight guard: never stack computes
    let snapshot;
    try {
      snapshot = await computeCoalesced();
    } catch {
      return; // no snapshot at all yet — nothing to send
    }
    if (clients.size === 0) return;
    const projection = projectionOf(snapshot.payload);
    const changed = projection !== lastProjection;
    const heartbeatDue = now() - lastFrameAt >= heartbeatMs;
    if (!changed && !heartbeatDue) return;
    lastProjection = projection;
    writeFrame(snapshot);
  };

  const startInterval = () => {
    if (intervalId) return;
    intervalId = setInterval(tick, intervalMs);
    if (typeof intervalId.unref === "function") intervalId.unref();
  };

  const stopInterval = () => {
    if (!intervalId) return;
    clearInterval(intervalId);
    intervalId = null;
  };

  // SSE contract: every new client gets a frame immediately on connect —
  // from the fresh cache when available, else one coalesced compute.
  const addClient = async (res) => {
    clients.add(res);
    startInterval();
    try {
      const snapshot =
        lastSnapshot && now() - lastSnapshot.computedAt < freshnessMs
          ? lastSnapshot
          : await computeCoalesced();
      lastProjection = projectionOf(snapshot.payload);
      sendTo(res, frameDataFor(snapshot));
      lastFrameAt = now();
    } catch {
      // No payload yet (first compute failed): the client stays connected and
      // receives the next successful tick.
    }
  };

  const removeClient = (res) => {
    clients.delete(res);
    if (clients.size === 0) stopInterval();
  };

  // /api/status read path: fresh cache, else one coalesced compute — works
  // with zero SSE clients connected (the interval is not required).
  const getSnapshotPayload = async () => {
    if (lastSnapshot && now() - lastSnapshot.computedAt < freshnessMs) {
      return lastSnapshot.payload;
    }
    const snapshot = await computeCoalesced();
    return snapshot.payload;
  };

  return {
    addClient,
    removeClient,
    getSnapshotPayload,
    getClientCount: () => clients.size,
  };
};

module.exports = { createStatusSnapshotService };
