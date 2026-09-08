const { getProcessBootId } = require("./boot-id");
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
  "snapshotRevision",
  "snapshotErrorCount",
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
  onClientCountChange = null,
  snapshotEpoch = getProcessBootId(),
} = {}) => {
  const clients = new Set();

  const notifyClientCount = () => {
    try {
      onClientCountChange?.(clients.size);
    } catch {}
  };
  let intervalId = null;
  let computePromise = null;
  let lastSnapshot = null; // { payload, computedAt }
  let lastProjection = null;
  let lastFrameAt = 0;
  let computeErrorCount = 0;
  let snapshotRevision = 0;

  const computeCoalesced = () => {
    if (computePromise) return computePromise;
    computePromise = Promise.resolve()
      .then(() => compute())
      .then((payload) => {
        lastSnapshot = { payload, computedAt: now(), revision: ++snapshotRevision, stale: false, errorCount: 0 };
        computeErrorCount = 0;
        return lastSnapshot;
      })
      .catch((err) => {
        computeErrorCount += 1;
        // Log the first failure and then every ~30th (a persistent failure at
        // the 2s tick would otherwise be one line ever).
        if (computeErrorCount === 1 || computeErrorCount % 30 === 0) {
          logger.warn?.(
            `[alphaclaw] status snapshot compute failed: ${err?.message || err}`,
          );
        }
        // Serve the last good snapshot; callers with no snapshot yet see the
        // rejection (same contract the per-request path had).
        if (lastSnapshot) {
          lastSnapshot = { ...lastSnapshot,
            revision: lastSnapshot.stale ? lastSnapshot.revision : ++snapshotRevision,
            stale: true, errorCount: computeErrorCount,
          };
          return lastSnapshot;
        }
        throw err;
      })
      .finally(() => {
        computePromise = null;
      });
    return computePromise;
  };

  // The frame timestamp is the COMPUTE time, not the send time: when compute
  // fails persistently and the last good snapshot is being re-served, a
  // send-time stamp would present hours-old state as fresh.
  const envelopeFor = (snapshot) => ({
    ...snapshot.payload,
    timestamp: new Date(snapshot.computedAt).toISOString(),
    snapshotEpoch,
    snapshotRevision: snapshot.revision,
    snapshotStale: snapshot.stale,
    ...(snapshot.errorCount > 0 ? { snapshotErrorCount: snapshot.errorCount } : {}),
  });
  const frameDataFor = (snapshot) => `data: ${JSON.stringify(envelopeFor(snapshot))}\n\n`;
  const freshCache = () => lastSnapshot && !lastSnapshot.stale &&
    now() >= lastSnapshot.computedAt && now() - lastSnapshot.computedAt < freshnessMs;

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
    const projection = projectionOf(envelopeFor(snapshot));
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
    notifyClientCount();
    startInterval();
    try {
      const snapshot =
        freshCache()
          ? lastSnapshot
          : await computeCoalesced();
      sendTo(res, frameDataFor(snapshot));
      // Seed shared change-detection state only for the FIRST client. For a
      // later joiner this catch-up frame is theirs alone — updating
      // lastProjection here would swallow a pending change notification for
      // the clients already connected (they'd never hear about it; a dupe
      // frame on the next tick is the harmless alternative).
      if (clients.size === 1) {
        lastProjection = projectionOf(envelopeFor(snapshot));
        lastFrameAt = now();
      }
    } catch {
      // No payload yet (first compute failed): the client stays connected and
      // receives the next successful tick.
    }
  };

  const removeClient = (res) => {
    clients.delete(res);
    notifyClientCount();
    if (clients.size === 0) stopInterval();
  };

  // /api/status read path: fresh cache, else one coalesced compute — works
  // with zero SSE clients connected (the interval is not required).
  const getSnapshotPayload = async () => envelopeFor(
    freshCache() ? lastSnapshot : await computeCoalesced(),
  );

  return {
    addClient,
    removeClient,
    getSnapshotPayload,
    getClientCount: () => clients.size,
  };
};

module.exports = { createStatusSnapshotService };
