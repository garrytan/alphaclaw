const path = require("node:path");

const kTelemetryVersion = 1;
const kMaxTelemetryRecords = 128;
const kMaxTelemetryBytes = 64 * 1024;
const kTelemetryIntervalMs = 30 * 1000;
const kTelemetryStaleMs = 90 * 1000;
const kBootIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const kStartTicksPattern = /^(0|[1-9][0-9]*)$/;
const kMemoryFields = Object.freeze([
  "rssBytes", "heapUsedBytes", "heapTotalBytes", "heapLimitBytes",
  "externalBytes", "arrayBuffersBytes",
]);
const isFiniteBytes = (value) => Number.isSafeInteger(value) && value >= 0;
const isIdentity = (identity) =>
  Number.isSafeInteger(identity?.pid) && identity.pid > 0 &&
  typeof identity.startTicks === "string" &&
  kStartTicksPattern.test(identity.startTicks) && identity.startTicks.length <= 24;
const telemetryDirectory = (stateDir) =>
  typeof stateDir === "string" && path.isAbsolute(stateDir)
    ? path.join(stateDir, ".alphaclaw", "gateway-memory") : null;
const telemetryFilename = (identity) =>
  isIdentity(identity) ? `${identity.pid}-${identity.startTicks}.json` : null;

// Return an explicit numeric projection. The producer shares the gateway's UID;
// this validates diagnostic data, not an authenticated enforcement signal.
const validateTelemetryEnvelope = (input, { identity, bootId, nowMs }) => {
  if (!input || input.version !== kTelemetryVersion) return null;
  if (!isIdentity(input) || input.pid !== identity.pid ||
      input.startTicks !== identity.startTicks || input.bootId !== bootId ||
      !kBootIdPattern.test(input.bootId)) return null;
  if (!Array.isArray(input.records) || input.records.length < 1 ||
      input.records.length > kMaxTelemetryRecords) return null;
  const records = [];
  let previousSeq = 0;
  let previousAtMs = -1;
  for (const raw of input.records) {
    if (!raw || !Number.isSafeInteger(raw.seq) || raw.seq <= previousSeq ||
        !Number.isSafeInteger(raw.atMs) || raw.atMs <= previousAtMs ||
        raw.atMs > nowMs || raw.atMs < 0 ||
        !kMemoryFields.every((field) => isFiniteBytes(raw[field])) ||
        raw.heapLimitBytes <= 0 || raw.heapUsedBytes > raw.heapTotalBytes ||
        raw.arrayBuffersBytes > raw.externalBytes) return null;
    const record = { seq: raw.seq, atMs: raw.atMs };
    for (const field of kMemoryFields) record[field] = raw[field];
    record.gc = null;
    if (raw.gc !== null) {
      const gc = raw.gc;
      if (!gc || !Number.isSafeInteger(gc.atMs) || gc.atMs < 0 ||
          gc.atMs > raw.atMs || gc.atMs < previousAtMs - 1000 ||
          !isFiniteBytes(gc.heapUsedBytes) || !Number.isSafeInteger(gc.count) ||
          gc.count < 1) return null;
      record.gc = { atMs: gc.atMs, heapUsedBytes: gc.heapUsedBytes, count: gc.count };
    }
    records.push(record);
    previousSeq = raw.seq;
    previousAtMs = raw.atMs;
  }
  return records;
};

module.exports = {
  kTelemetryVersion, kMaxTelemetryRecords, kMaxTelemetryBytes,
  kTelemetryIntervalMs, kTelemetryStaleMs, kMemoryFields,
  isIdentity, telemetryDirectory, telemetryFilename, validateTelemetryEnvelope,
};
