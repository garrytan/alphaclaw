const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getProcessIdentity } = require("./process-identity");
const { kMaxTelemetryBytes, telemetryDirectory, telemetryFilename } = require("./telemetry-protocol");

const kSweepIntervalMs = 60 * 60 * 1000;
const kOwnedFilePattern = /^([1-9][0-9]*)-(0|[1-9][0-9]*)(?:\.json|\.[0-9a-f-]{36}\.tmp)$/;

const processConfirmedGone = (identity, {
  readIdentity = getProcessIdentity, kill = process.kill.bind(process),
} = {}) => {
  const current = readIdentity(identity.pid);
  if (current) return current.startTicks !== identity.startTicks;
  // Unreadable /proc does not prove exit. ESRCH is the only liveness refusal
  // that permits cleanup; EPERM and all other failures leave files alone.
  try { kill(identity.pid, 0); } catch (error) { return error?.code === "ESRCH"; }
  return false;
};

const sweepGatewayTelemetry = async ({ directory, fsPromises = fs.promises, ...identityOptions }) => {
  let handle;
  let inspected = 0;
  let deleted = 0;
  try {
    handle = await fsPromises.opendir(directory);
    while (inspected < 128 && deleted < 32) {
      const entry = await handle.read();
      if (!entry) break;
      inspected += 1;
      const match = kOwnedFilePattern.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const identity = { pid: Number(match[1]), startTicks: match[2] };
      if (!Number.isSafeInteger(identity.pid) || !processConfirmedGone(identity, identityOptions)) continue;
      try {
        await fsPromises.unlink(path.join(directory, entry.name));
        deleted += 1;
      } catch {}
    }
  } catch {} finally {
    try { await handle?.close(); } catch {}
  }
  return { inspected, deleted };
};

const createTelemetryWriter = ({
  stateDir, identity, fsPromises = fs.promises, now = Date.now,
  sweep = sweepGatewayTelemetry,
} = {}) => {
  const directory = telemetryDirectory(stateDir);
  const filename = telemetryFilename(identity);
  const target = directory && filename ? path.join(directory, filename) : null;
  let inFlight = null;
  let closed = false;
  let initialized = false;
  let lastSweepAt = null;

  const write = (envelope) => {
    if (closed || !target || inFlight) return Promise.resolve(false);
    let content;
    try { content = JSON.stringify(envelope); } catch { return Promise.resolve(false); }
    if (Buffer.byteLength(content) > kMaxTelemetryBytes) return Promise.resolve(false);
    const run = async () => {
      let temporary;
      let handle;
      try {
        if (!initialized) {
          await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
          const stat = await fsPromises.lstat(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
          await fsPromises.chmod(directory, 0o700);
          initialized = true;
        }
        if (closed) return false;
        if (lastSweepAt === null || now() - lastSweepAt >= kSweepIntervalMs) {
          lastSweepAt = now();
          // This bounded cleanup finishes before publishing; concurrent file
          // writes never fan out across a slow/unavailable filesystem.
          await sweep({ directory, fsPromises });
        }
        if (closed) return false;
        temporary = path.join(directory, `${identity.pid}-${identity.startTicks}.${crypto.randomUUID()}.tmp`);
        handle = await fsPromises.open(temporary, "wx", 0o600);
        await handle.writeFile(content, "utf8");
        await handle.close();
        handle = null;
        if (closed) return false;
        await fsPromises.rename(temporary, target);
        temporary = null;
        return true;
      } catch {
        return false;
      } finally {
        try { await handle?.close(); } catch {}
        if (temporary) {
          try { await fsPromises.unlink(temporary); } catch {}
        }
      }
    };
    inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    write,
    stop() { closed = true; },
    get target() { return target; },
    // Useful for integration verification; consumers do not wait on telemetry.
    flush: () => inFlight || Promise.resolve(),
  };
};

module.exports = { createTelemetryWriter, sweepGatewayTelemetry, processConfirmedGone };
