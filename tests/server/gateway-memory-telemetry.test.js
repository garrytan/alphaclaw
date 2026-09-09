const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { getProcessIdentity, getLinuxBootId } = require("../../lib/server/gateway-memory/process-identity");
const { readGatewayTelemetry } = require("../../lib/server/gateway-memory/telemetry");
const { createTelemetryWriter, sweepGatewayTelemetry, processConfirmedGone } = require("../../lib/server/gateway-memory/telemetry-writer");
const { kMaxTelemetryBytes, telemetryDirectory, telemetryFilename } = require("../../lib/server/gateway-memory/telemetry-protocol");

const makeRecord = (atMs = Date.now(), seq = 1) => ({
  seq, atMs, rssBytes: 1000, heapUsedBytes: 100, heapTotalBytes: 200,
  heapLimitBytes: 10000, externalBytes: 300, arrayBuffersBytes: 100, gc: null,
});

describe("gateway memory telemetry transport", () => {
  let stateDir, identity, bootId, directory, file, envelope, nowMs;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-telemetry-"));
    identity = getProcessIdentity(process.pid);
    bootId = getLinuxBootId();
    nowMs = Date.now();
    directory = telemetryDirectory(stateDir);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    file = path.join(directory, telemetryFilename(identity));
    envelope = { version: 1, ...identity, bootId, records: [makeRecord(nowMs)] };
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data));

  it("publishes atomically with private permissions and projects numeric records", async () => {
    fs.chmodSync(directory, 0o755);
    const writer = createTelemetryWriter({ stateDir, identity });
    envelope.secret = "must not escape";
    envelope.records[0].unknown = "private field";
    expect(await writer.write(envelope)).toBe(true);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);
    const result = readGatewayTelemetry({ identity, stateDir, nowMs });
    expect(result.status).toBe("fresh");
    expect(result.records).toEqual([makeRecord(nowMs)]);
    expect(result).not.toHaveProperty("bootId");
    writer.stop();
    expect(await writer.write(envelope)).toBe(false);
  });

  it("marks the original sample stale even when the file was just rewritten", () => {
    envelope.records[0].atMs -= 90001;
    save(file, envelope);
    expect(readGatewayTelemetry({ identity, stateDir, nowMs })).toMatchObject({
      status: "stale", reason: "sample_stale", atMs: nowMs - 90001,
    });
  });

  it("honors the kill switch even while an older producer keeps publishing", () => {
    save(file, envelope);
    expect(readGatewayTelemetry({ identity, stateDir, nowMs,
      env: { ALPHACLAW_GATEWAY_MEMORY_TELEMETRY: "off" } })).toEqual({
      status: "unavailable", reason: "disabled", atMs: null, records: [],
    });
  });

  it.each([
    ["version", (e) => { e.version = 2; }],
    ["pid", (e) => { e.pid += 1; }],
    ["start ticks", (e) => { e.startTicks += "1"; }],
    ["boot", (e) => { e.bootId = "00000000-0000-0000-0000-000000000000"; }],
    ["empty", (e) => { e.records = []; }],
    ["too many records", (e) => { e.records = Array(129).fill(e.records[0]); }],
    ["negative value", (e) => { e.records[0].rssBytes = -1; }],
    ["null value", (e) => { e.records[0].heapUsedBytes = null; }],
    ["wrong type", (e) => { e.records[0].heapLimitBytes = "10000"; }],
    ["duplicate sequence", (e) => { e.records.push({ ...e.records[0], atMs: e.records[0].atMs + 1 }); }],
    ["future", (e) => { e.records[0].atMs += 1; }],
    ["bad GC", (e) => { e.records[0].gc = { atMs: e.records[0].atMs, count: 0, heapUsedBytes: 1 }; }],
  ])("rejects invalid %s", (_label, mutate) => {
    mutate(envelope);
    save(file, envelope);
    expect(readGatewayTelemetry({ identity, stateDir, nowMs }).status).toBe("unavailable");
  });

  it("does not accept a PID reused before or during the read", () => {
    save(file, envelope);
    const reused = () => ({ ...identity, startTicks: `${identity.startTicks}1` });
    expect(readGatewayTelemetry({ identity, stateDir, nowMs, readIdentity: reused }).reason)
      .toBe("identity_mismatch");
    const readIdentity = vi.fn().mockReturnValueOnce(identity).mockImplementation(reused);
    expect(readGatewayTelemetry({ identity, stateDir, nowMs, readIdentity }).reason)
      .toBe("identity_mismatch");
  });

  it("keeps missing, unreadable and malformed files unavailable", () => {
    expect(readGatewayTelemetry({ identity, stateDir }).reason).toBe("not_published");
    fs.writeFileSync(file, "torn-json{");
    expect(readGatewayTelemetry({ identity, stateDir }).status).toBe("unavailable");
    const fsModule = { ...fs, openSync: () => { throw Object.assign(new Error("private-path"), { code: "EACCES" }); } };
    expect(readGatewayTelemetry({ identity, stateDir, fsModule })).toEqual({
      status: "unavailable", reason: "read_failed", atMs: null, records: [],
    });
  });

  it("rejects oversized files, final symlinks, directories and FIFO without blocking", () => {
    fs.writeFileSync(file, "x".repeat(kMaxTelemetryBytes + 1));
    expect(readGatewayTelemetry({ identity, stateDir }).reason).toBe("invalid_file");
    fs.unlinkSync(file);
    fs.symlinkSync("/dev/zero", file);
    expect(readGatewayTelemetry({ identity, stateDir }).status).toBe("unavailable");
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(readGatewayTelemetry({ identity, stateDir }).reason).toBe("invalid_file");
    fs.rmdirSync(file);
    execFileSync("mkfifo", [file]);
    expect(readGatewayTelemetry({ identity, stateDir }).reason).toBe("invalid_file");
  });

  it("caps growth after fstat and closes its original descriptor", () => {
    save(file, envelope);
    const closeSync = vi.fn(fs.closeSync);
    const fsModule = { ...fs, closeSync, fstatSync: () => ({ isFile: () => true, size: 1 }),
      readSync: (_fd, buffer, offset, length) => { buffer.fill(32, offset, offset + length); return length; } };
    expect(readGatewayTelemetry({ identity, stateDir, fsModule }).reason).toBe("invalid_file");
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it.each(["EACCES", "EROFS", "ENOSPC"])("fails open on publisher %s", async (code) => {
    const writer = createTelemetryWriter({ stateDir, identity,
      fsPromises: { mkdir: async () => { throw Object.assign(new Error("private"), { code }); } } });
    expect(await writer.write(envelope)).toBe(false);
  });

  it.each([["partial write", "ENOSPC"], ["rename", "EACCES"]])(
    "preserves the previous publication and cleans up after a %s failure",
    async (phase, code) => {
      save(file, envelope);
      const previous = fs.readFileSync(file, "utf8");
      const replacement = { ...envelope, records: [makeRecord(nowMs + 1, 2)] };
      const opened = [];
      let failNext = true;
      const writer = createTelemetryWriter({ stateDir, identity, fsPromises: {
        ...fs.promises,
        open: async (...args) => {
          const handle = await fs.promises.open(...args);
          const close = vi.fn(() => handle.close());
          opened.push({ handle, close });
          return {
            close,
            writeFile: async (content, encoding) => {
              if (phase === "partial write" && failNext) {
                failNext = false;
                await handle.writeFile(content.slice(0, 8), encoding);
                throw Object.assign(new Error("publication failed"), { code });
              }
              await handle.writeFile(content, encoding);
            },
          };
        },
        rename: async (...args) => {
          if (phase === "rename" && failNext) {
            failNext = false;
            throw Object.assign(new Error("publication failed"), { code });
          }
          await fs.promises.rename(...args);
        },
      } });
      try {
        expect(await writer.write(replacement)).toBe(false);
        expect(opened).toHaveLength(1);
        expect(opened[0].close).toHaveBeenCalledOnce();
        expect(opened[0].handle.fd).toBe(-1);
        expect(fs.readFileSync(file, "utf8")).toBe(previous);
        expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);

        expect(await writer.write(replacement)).toBe(true);
        expect(opened).toHaveLength(2);
        expect(opened[1].handle.fd).toBe(-1);
        expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(replacement));
        expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);
      } finally {
        writer.stop();
        await Promise.all(opened.map(({ handle }) => handle.close().catch(() => {})));
      }
    },
  );

  it("removes an open temporary publication when stopped during its write", async () => {
    save(file, envelope);
    const previous = fs.readFileSync(file, "utf8");
    let release, noteStarted, handle, temporary, close;
    const blocked = new Promise((resolve) => { release = resolve; });
    const writeStarted = new Promise((resolve) => { noteStarted = resolve; });
    const writer = createTelemetryWriter({ stateDir, identity, fsPromises: {
      ...fs.promises,
      open: async (...args) => {
        temporary = args[0];
        handle = await fs.promises.open(...args);
        close = vi.fn(() => handle.close());
        return {
          close,
          writeFile: async (content, encoding) => {
            await handle.writeFile(content.slice(0, 8), encoding);
            noteStarted();
            await blocked;
            await handle.writeFile(content.slice(8), encoding);
          },
        };
      },
    } });
    const publication = writer.write({ ...envelope, records: [makeRecord(nowMs + 1, 2)] });
    try {
      expect(await Promise.race([writeStarted.then(() => true), publication.then(() => false)])).toBe(true);
      expect(fs.statSync(temporary).size).toBe(8);
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      writer.stop();
      expect(await writer.write(envelope)).toBe(false);
      release();
      expect(await publication).toBe(false);
      expect(close).toHaveBeenCalledOnce();
      expect(handle.fd).toBe(-1);
      expect(fs.readFileSync(file, "utf8")).toBe(previous);
      expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);
    } finally {
      writer.stop();
      release();
      await publication;
      await handle?.close().catch(() => {});
    }
  });

  it("serializes publication and discards temporary output when stopped", async () => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const writer = createTelemetryWriter({ stateDir, identity,
      fsPromises: { ...fs.promises, mkdir: async (...args) => { await blocked; return fs.promises.mkdir(...args); } } });
    const first = writer.write(envelope);
    expect(await writer.write(envelope)).toBe(false);
    writer.stop();
    release();
    expect(await first).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("sweeps only confirmed dead owned files, bounded to 32 deletions", async () => {
    save(file, envelope);
    for (let i = 1; i <= 40; i += 1) fs.writeFileSync(path.join(directory, `${1000000 + i}-1.json`), "{}");
    fs.writeFileSync(path.join(directory, "operator.txt"), "preserve");
    const readIdentity = (pid) => pid === identity.pid ? identity : null;
    const kill = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    const result = await sweepGatewayTelemetry({ directory, readIdentity, kill });
    expect(result.deleted).toBe(32);
    expect(result.inspected).toBeLessThanOrEqual(128);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(directory, "operator.txt"))).toBe(true);
    expect(processConfirmedGone(identity, { readIdentity: () => null,
      kill: () => { throw Object.assign(new Error("private"), { code: "EPERM" }); } })).toBe(false);
  });

  it("stops inspecting after 128 preserved entries even without reaching the deletion cap", async () => {
    const filenames = Array.from({ length: 160 }, (_, i) => `${1000000 + i}-1.json`);
    for (const filename of filenames) fs.writeFileSync(path.join(directory, filename), "{}");
    const readIdentity = vi.fn((pid) => ({ pid, startTicks: "1" }));
    const kill = vi.fn();
    const result = await sweepGatewayTelemetry({ directory, readIdentity, kill });
    expect(result).toEqual({ inspected: 128, deleted: 0 });
    expect(readIdentity).toHaveBeenCalledTimes(128);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory).sort()).toEqual(filenames.sort());
  });
});
