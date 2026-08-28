const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFingerprintClient } = require("../../lib/server/doctor/fingerprint-client");

// Fake worker scripts speak the real worker protocol (see
// lib/server/doctor/fingerprint-worker.js):
//   in:  {id, rootDir, previousManifest, options}
//   out: {id, ok, snapshot | error}

describe("server/doctor/fingerprint-client", () => {
  const tmpDirs = [];
  let client = null;

  const makeTmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-client-"));
    tmpDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    if (client) {
      client.dispose();
      client = null;
    }
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    }
  });

  // Worker that crashes unless a sentinel file exists — lets one client (the
  // workerPath is fixed per client) alternate between failing and healthy
  // round-trips.
  const writeSentinelWorker = (dir, sentinelPath) => {
    const workerPath = path.join(dir, "sentinel-worker.js");
    fs.writeFileSync(
      workerPath,
      `
      const fs = require("fs");
      const { parentPort } = require("worker_threads");
      parentPort.on("message", (message) => {
        if (fs.existsSync(${JSON.stringify(sentinelPath)})) {
          parentPort.postMessage({
            id: message.id,
            ok: true,
            snapshot: { fingerprint: "fp-healthy", manifest: {} },
          });
        } else {
          process.exit(1);
        }
      });
      `,
    );
    return workerPath;
  };

  // Worker that records each spawn, then crashes on the first request.
  const writeCrashWorker = (dir, spawnLogPath) => {
    const workerPath = path.join(dir, "crash-worker.js");
    fs.writeFileSync(
      workerPath,
      `
      const fs = require("fs");
      const { parentPort } = require("worker_threads");
      fs.appendFileSync(${JSON.stringify(spawnLogPath)}, "spawn\\n");
      parentPort.on("message", () => {
        process.exit(1);
      });
      `,
    );
    return workerPath;
  };

  it("resets the respawn budget after a healthy round-trip", async () => {
    const dir = makeTmpDir();
    const sentinelPath = path.join(dir, "healthy.sentinel");
    const workerPath = writeSentinelWorker(dir, sentinelPath);
    client = createFingerprintClient({ workerPath });

    // Two crashes burn respawns 1 and 2 of the cap of 3.
    await expect(client.computeSnapshot("/ws")).rejects.toThrow(
      "Fingerprint worker exited (code 1)",
    );
    await expect(client.computeSnapshot("/ws")).rejects.toThrow(
      "Fingerprint worker exited (code 1)",
    );

    // A healthy round-trip resets the counter to 0.
    fs.writeFileSync(sentinelPath, "ok", "utf8");
    const snapshot = await client.computeSnapshot("/ws");
    expect(snapshot.fingerprint).toBe("fp-healthy");

    // Two MORE crashes still respawn and reject with the exit error. Without
    // the reset these would be lifetime failures 3 and 4 — the 4th call would
    // hit the cap and reject with "respawn cap reached" without respawning.
    fs.rmSync(sentinelPath);
    await expect(client.computeSnapshot("/ws")).rejects.toThrow(
      "Fingerprint worker exited (code 1)",
    );
    await expect(client.computeSnapshot("/ws")).rejects.toThrow(
      "Fingerprint worker exited (code 1)",
    );
  });

  it("stops respawning after three consecutive failures", async () => {
    const dir = makeTmpDir();
    const spawnLogPath = path.join(dir, "spawn.log");
    const workerPath = writeCrashWorker(dir, spawnLogPath);
    client = createFingerprintClient({ workerPath });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.computeSnapshot("/ws")).rejects.toThrow(
        "Fingerprint worker exited (code 1)",
      );
    }

    // The cap is exhausted: the 4th call rejects up front, without spawning
    // a 4th worker (the spawn log stays at 3 entries).
    await expect(client.computeSnapshot("/ws")).rejects.toThrow(
      "Fingerprint worker unavailable (respawn cap reached)",
    );
    const spawns = fs
      .readFileSync(spawnLogPath, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(spawns).toHaveLength(3);
  });

  it("rejects computeSnapshot after dispose()", async () => {
    const dir = makeTmpDir();
    const spawnLogPath = path.join(dir, "spawn.log");
    const workerPath = writeCrashWorker(dir, spawnLogPath);
    client = createFingerprintClient({ workerPath });

    client.dispose();

    await expect(client.computeSnapshot("/ws")).rejects.toThrow(
      "Fingerprint client disposed",
    );
    // The disposed guard fires before any worker could spawn.
    expect(fs.existsSync(spawnLogPath)).toBe(false);
  });
});
