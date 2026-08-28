// Regression tests for the post-implementation diff-review fix batch
// (cross-model review rounds 3-4). Each test pins a bug that shipped in the
// first implementation pass and was caught by the outside voice.
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe("diff-review fix-batch regressions", () => {
  describe("gateway: concurrent channel syncs with different vars", () => {
    const originalExecFile = childProcess.execFile;
    const originalExistsSync = fs.existsSync;
    const originalReadFileSync = fs.readFileSync;
    const modulePath = require.resolve("../../lib/server/gateway");

    afterEach(() => {
      childProcess.execFile = originalExecFile;
      fs.existsSync = originalExistsSync;
      fs.readFileSync = originalReadFileSync;
      delete require.cache[modulePath];
    });

    it("both syncs execute — the later save's tokens are never dropped (join-drop regression)", async () => {
      const addedTokens = [];
      childProcess.execFile = vi.fn((file, args, opts, cb) => {
        const tokenIdx = args.indexOf("--token");
        if (tokenIdx !== -1) addedTokens.push(args[tokenIdx + 1]);
        cb(null, "", "");
        return {};
      });
      // Require BEFORE mocking fs: module load reads real files (package.json
      // etc.); the config read happens later, at call time.
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.existsSync = vi.fn(() => true);
      fs.readFileSync = vi.fn(() =>
        JSON.stringify({ channels: { telegram: { enabled: false } } }),
      );
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

      // Two concurrent env saves with DIFFERENT bot tokens: with the old
      // shared "channel-sync:add" lock key the second joined the first and
      // token-B was silently never applied.
      const syncA = gateway.syncChannelConfig(
        [{ key: "TELEGRAM_BOT_TOKEN", value: "token-A" }],
        "add",
      );
      const syncB = gateway.syncChannelConfig(
        [{ key: "TELEGRAM_BOT_TOKEN", value: "token-B" }],
        "add",
      );
      await Promise.all([syncA, syncB]);

      expect(addedTokens).toEqual(["token-A", "token-B"]);
      writeSpy.mockRestore();
    });
  });

  describe("gateway: stripNodeMemoryFlags", () => {
    it("strips both =value and space-separated value forms without stranding the value", () => {
      const { stripNodeMemoryFlags } = require("../../lib/server/gateway");
      expect(stripNodeMemoryFlags("--max-old-space-size=4096")).toBe("");
      // Space-separated form: a stranded bare "4096" would abort the child's
      // Node startup.
      expect(stripNodeMemoryFlags("--max-old-space-size 4096")).toBe("");
      expect(
        stripNodeMemoryFlags("--enable-source-maps --max-old-space-size 4096 --trace-warnings"),
      ).toBe("--enable-source-maps --trace-warnings");
      expect(stripNodeMemoryFlags("--max-semi-space-size=64 --inspect")).toBe("--inspect");
      expect(stripNodeMemoryFlags("--inspect")).toBe("--inspect");
    });
  });

  describe("doctor service: runStarting busy-guard release", () => {
    it("releases the busy guard when run creation throws after the snapshot (leak regression)", async () => {
      const { createDoctorService } = require("../../lib/server/doctor/service");
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-guard-"));
      fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# hi\n");
      let failCreate = true;
      const doctorService = createDoctorService({
        clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
        listDoctorRuns: vi.fn(() => []),
        listDoctorCards: vi.fn(() => []),
        getInitialWorkspaceBaseline: vi.fn(() => null),
        setInitialWorkspaceBaseline: vi.fn((baseline) => baseline),
        createDoctorRun: vi.fn(() => {
          if (failCreate) throw new Error("db write failed");
          return 42;
        }),
        completeDoctorRun: vi.fn(),
        insertDoctorCards: vi.fn(),
        getDoctorRun: vi.fn(),
        getDoctorCardsByRunId: vi.fn(() => []),
        getDoctorCard: vi.fn(),
        updateDoctorCardStatus: vi.fn(),
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: async () => ({
          fingerprint: "fp-1",
          manifest: {},
          limited: false,
        }),
      });

      await expect(doctorService.runDoctor()).rejects.toThrow("db write failed");

      // The guard must be released: the next run proceeds instead of
      // reporting "already running" forever.
      failCreate = false;
      const second = await doctorService.runDoctor();
      expect(second.ok).toBe(true);
      expect(second.alreadyRunning).toBeUndefined();
    });
  });

  describe("fingerprint client: timeout terminates the worker", () => {
    it("times out a hung request and a later request works on a fresh worker", async () => {
      const { createFingerprintClient } = require("../../lib/server/doctor/fingerprint-client");
      // A worker script that never replies to the first message, then behaves.
      const hangingWorkerPath = path.join(
        os.tmpdir(),
        `hang-worker-${process.pid}.js`,
      );
      fs.writeFileSync(
        hangingWorkerPath,
        `
        const { parentPort } = require("worker_threads");
        parentPort.on("message", (message) => {
          if (message.rootDir === "/hang") return; // never reply
          parentPort.postMessage({ id: message.id, ok: true, snapshot: { fingerprint: "fp", manifest: {} } });
        });
        `,
      );
      const client = createFingerprintClient({
        workerPath: hangingWorkerPath,
        requestTimeoutMs: 150,
      });
      try {
        await expect(client.computeSnapshot("/hang", {})).rejects.toThrow(
          "Fingerprint worker timed out",
        );
        // The hung worker was terminated; a new request lazily respawns.
        const result = await client.computeSnapshot("/ok", {});
        expect(result.fingerprint).toBe("fp");
      } finally {
        client.dispose();
        fs.rmSync(hangingWorkerPath, { force: true });
      }
    });
  });
});
