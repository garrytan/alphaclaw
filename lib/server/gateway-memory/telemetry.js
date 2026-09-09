const fs = require("node:fs");
const path = require("node:path");
const { getProcessIdentity, getLinuxBootId } = require("./process-identity");
const {
  kMaxTelemetryBytes, kTelemetryStaleMs, isIdentity,
  telemetryDirectory, telemetryFilename, validateTelemetryEnvelope,
} = require("./telemetry-protocol");

const unavailable = (reason) => ({ status: "unavailable", reason, atMs: null, records: [] });

const readGatewayTelemetry = ({
  identity,
  nowMs = Date.now(),
  stateDir = require("../constants").OPENCLAW_DIR,
  fsModule = fs,
  readIdentity = getProcessIdentity,
  readBootId = getLinuxBootId,
  env = process.env,
} = {}) => {
  if (String(env.ALPHACLAW_GATEWAY_MEMORY_TELEMETRY || "").trim().toLowerCase() === "off") {
    return unavailable("disabled");
  }
  const directory = telemetryDirectory(stateDir);
  if (!directory || !isIdentity(identity) || !Number.isFinite(nowMs)) {
    return unavailable("identity_unavailable");
  }
  let fd;
  try {
    const current = readIdentity(identity.pid);
    const bootId = readBootId();
    if (!bootId || !current || current.startTicks !== identity.startTicks) {
      return unavailable("identity_mismatch");
    }
    const directoryStat = fsModule.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return unavailable("invalid_file");
    }
    // Opening a FIFO read-only can block before fstat; NONBLOCK matters here.
    // NOFOLLOW and the same-FD capped read close the path-stat/read race.
    if (fs.constants.O_NOFOLLOW === undefined || fs.constants.O_NONBLOCK === undefined) {
      return unavailable("unsupported");
    }
    fd = fsModule.openSync(path.join(directory, telemetryFilename(identity)),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fsModule.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > kMaxTelemetryBytes) {
      return unavailable("invalid_file");
    }
    const buffer = Buffer.alloc(kMaxTelemetryBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fsModule.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (!length || length > kMaxTelemetryBytes) return unavailable("invalid_file");
    const input = JSON.parse(buffer.toString("utf8", 0, length));
    const records = validateTelemetryEnvelope(input, { identity, bootId, nowMs });
    if (!records) return unavailable("invalid_sample");
    // The process may have exited/reused its pid while the read was in flight.
    if (readIdentity(identity.pid)?.startTicks !== identity.startTicks || readBootId() !== bootId) {
      return unavailable("identity_mismatch");
    }
    const atMs = records.at(-1).atMs;
    return { status: nowMs - atMs > kTelemetryStaleMs ? "stale" : "fresh",
      reason: nowMs - atMs > kTelemetryStaleMs ? "sample_stale" : null,
      atMs, records };
  } catch (error) {
    return unavailable(error?.code === "ENOENT" ? "not_published" : "read_failed");
  } finally {
    if (fd !== undefined) {
      try { fsModule.closeSync(fd); } catch {}
    }
  }
};

module.exports = { readGatewayTelemetry };
