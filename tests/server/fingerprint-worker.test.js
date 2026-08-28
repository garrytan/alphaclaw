const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFingerprintClient } = require("../../lib/server/doctor/fingerprint-client");
const {
  computeWorkspaceSnapshot,
} = require("../../lib/server/doctor/workspace-fingerprint");

const createFixtureWorkspace = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-worker-"));
  fs.writeFileSync(path.join(rootDir, "AGENTS.md"), "# Guidance\nKeep it tight.\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "README.md"), "# Readme\n", "utf8");
  fs.mkdirSync(path.join(rootDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "skills", "note.md"), "extra guidance\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "data.bin"), Buffer.from([1, 2, 3, 4]));
  return rootDir;
};

describe("server/doctor/fingerprint-worker", () => {
  let client = null;

  afterEach(() => {
    if (client) {
      client.dispose();
      client = null;
    }
  });

  it("computes the same fingerprint in the worker as the sync scanner", async () => {
    const rootDir = createFixtureWorkspace();
    client = createFingerprintClient();

    const workerSnapshot = await client.computeSnapshot(rootDir);
    const syncSnapshot = computeWorkspaceSnapshot(rootDir);

    expect(workerSnapshot.fingerprint).toBe(syncSnapshot.fingerprint);
    expect(Object.keys(workerSnapshot.manifest).sort()).toEqual(
      Object.keys(syncSnapshot.manifest).sort(),
    );
    for (const [relativePath, entry] of Object.entries(syncSnapshot.manifest)) {
      expect(workerSnapshot.manifest[relativePath].hash).toBe(entry.hash);
      expect(workerSnapshot.manifest[relativePath].size).toBe(entry.size);
    }
    expect(workerSnapshot.limited).toBe(false);
    expect(workerSnapshot.stats).toEqual(
      expect.objectContaining({
        totalFiles: 4,
        hashedCount: 4,
        reusedCount: 0,
        skippedLargeCount: 0,
      }),
    );
  });

  it("passes previousManifest and options through to the worker", async () => {
    const rootDir = createFixtureWorkspace();
    client = createFingerprintClient();

    const first = await client.computeSnapshot(rootDir);
    const second = await client.computeSnapshot(rootDir, {
      previousManifest: first.manifest,
    });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.stats.reusedCount).toBe(4);
    expect(second.stats.hashedCount).toBe(0);
  });

  it("works with a fresh client after a previous client was disposed", async () => {
    const rootDir = createFixtureWorkspace();

    client = createFingerprintClient();
    const first = await client.computeSnapshot(rootDir);
    client.dispose();
    client = null;

    // Crash resilience at the client level: a brand-new client spawns a
    // fresh worker and keeps serving snapshots.
    client = createFingerprintClient();
    const second = await client.computeSnapshot(rootDir);

    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
