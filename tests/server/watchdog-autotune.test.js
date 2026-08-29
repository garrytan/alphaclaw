const fs = require("fs");
const os = require("os");
const path = require("path");

// OOM classification glue in the watchdog exit handler: a V8 heap abort and a
// kernel/container OOM kill (exit 137/SIGKILL) are DIFFERENT failures with
// opposite remediations. The resize-tick glue's pieces (hasCapacityChanged,
// applyResourceAutotune) have their own suites; the live tier covers the
// end-to-end tick.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-autotune-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const { createWatchdog } = require("../../lib/server/watchdog");
const {
  resetAutotuneForTests,
  stampGatewayEnvApplied,
} = require("../../lib/server/autotune");
const {
  resetMachineProfileForTests,
} = require("../../lib/server/machine-profile");

const kMb = 1024 * 1024;

const createHarness = ({ gatewayLifecycleLock = null } = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
    probeGatewayTcp: async () => ({ running: true }),
    gatewayLifecycleLock,
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost:3000",
    sleepImpl: () => Promise.resolve(),
  });
  return { watchdog, insertWatchdogEvent, notifier };
};

const kMbLocal = 1024 * 1024;

const spyCgroupFiles = (files) => {
  const realReadFileSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
    const key = String(filePath);
    if (key.startsWith("/sys/fs/cgroup")) {
      if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return realReadFileSync(filePath, ...args);
  });
  return files;
};

// classifyOomExit is setImmediate-scheduled (so its event lands inside the
// incident the exit handler opens) and awaits notify internally — two rounds
// drain both.
const flushOnce = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => {
  await flushOnce();
  await flushOnce();
  await flushOnce();
};

const autotuneEvents = (insertWatchdogEvent) =>
  insertWatchdogEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.eventType === "autotune");

describe("server/watchdog autotune OOM classification", () => {
  afterEach(() => {
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    vi.restoreAllMocks();
    resetAutotuneForTests();
    resetMachineProfileForTests();
  });

  it("classifies a V8 heap abort and names the autotune escape hatch", async () => {
    const { watchdog, insertWatchdogEvent, notifier } = createHarness();
    watchdog.onGatewayExit({
      code: 134,
      expectedExit: false,
      stderrTail: [
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      ],
    });
    await flush();

    const events = autotuneEvents(insertWatchdogEvent);
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ kind: "heap_oom" });
    const oomNotification = notifier.notify.mock.calls
      .map(([message]) => message)
      .find((message) => message.includes("JavaScript heap"));
    expect(oomNotification).toBeTruthy();
    // Autotune is off in tests (kill-switch): the remedy points at enabling it.
    expect(oomNotification).toContain("resource autotune");
  });

  it("derives a machine-specific override command when headroom exists", async () => {
    // Active heap 1024MB on an 8GB box → suggested min(1280, 6963) = 1280.
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
      const key = String(filePath);
      if (key === "/sys/fs/cgroup/memory.max") return `${8192 * kMb}\n`;
      if (key === "/sys/fs/cgroup/cpu.max") return "400000 100000";
      if (key.startsWith("/sys/fs/cgroup")) {
        throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
      }
      return realReadFileSync(filePath, ...args);
    });
    resetMachineProfileForTests({
      fsModule: {
        existsSync: (p) => String(p) === "/.dockerenv",
        readFileSync: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      },
    });
    stampGatewayEnvApplied({ gatewayHeapMb: 1024, uvThreadpoolSize: 8 });

    const { watchdog, notifier } = createHarness();
    watchdog.onGatewayExit({
      code: 134,
      expectedExit: false,
      stderrTail: ["JavaScript heap out of memory"],
    });
    await flush();

    const message = notifier.notify.mock.calls
      .map(([m]) => m)
      .find((m) => m.includes("JavaScript heap"));
    expect(message).toContain('"gatewayHeapMb":1280');
    expect(message).toContain("alphaclaw admin PUT /api/autotune/settings");
  });

  it("classifies exit 137 as a container OOM and never suggests raising the heap", async () => {
    const { watchdog, insertWatchdogEvent, notifier } = createHarness();
    watchdog.onGatewayExit({ code: 137, expectedExit: false, stderrTail: [] });
    await flush();

    const events = autotuneEvents(insertWatchdogEvent);
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ kind: "container_oom" });
    const message = notifier.notify.mock.calls
      .map(([m]) => m)
      .find((m) => m.includes("force-killed"));
    // Honest evidence: 137/SIGKILL is commonly-but-not-conclusively OOM.
    expect(message).toContain("commonly the kernel OOM killer");
    expect(message).toContain("raising the gateway heap will not help");
  });

  it("live-resize tick: skips when the lifecycle lock is busy, retunes when it acquires", async () => {
    // REGRESSION RULE: the health tick (existing behavior) now runs this
    // check — the tryAcquire skip must never queue behind or deadlock a
    // running lifecycle operation.
    delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
    try {
      const files = spyCgroupFiles({
        "/sys/fs/cgroup/memory.max": `${2048 * kMbLocal}\n`,
        "/sys/fs/cgroup/cpu.max": "100000 100000",
      });
      resetMachineProfileForTests({
        fsModule: {
          existsSync: (p) => String(p) === "/.dockerenv",
          readFileSync: () => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          },
        },
      });
      const { getMachineProfile } = require("../../lib/server/machine-profile");
      expect(getMachineProfile().memory.limitBytes).toBe(2048 * kMbLocal);

      // Seed the observed capacity at 2GB (resize detection compares against
      // the last apply's observation — a first observation is not a resize).
      const { applyResourceAutotune } = require("../../lib/server/autotune");
      await applyResourceAutotune({
        trigger: "boot",
        deps: {
          env: {},
          updateOpenclawConfigFn: ({ mutate }) => ({ ...(mutate({}) || {}) }),
        },
      });

      // Capacity change: tick #1 only ARMS the two-tick debounce (a transient
      // read failure must not trigger a retune) — no lock attempt yet.
      files["/sys/fs/cgroup/memory.max"] = `${8192 * kMbLocal}\n`;
      const busyLock = { tryAcquire: vi.fn(() => null) };
      const busy = createHarness({ gatewayLifecycleLock: busyLock });
      await busy.watchdog.checkContainerResize(); // arms
      expect(busyLock.tryAcquire).not.toHaveBeenCalled();
      // Tick #2 confirms the change but the lock is BUSY: skip silently.
      await busy.watchdog.checkContainerResize();
      expect(busyLock.tryAcquire).toHaveBeenCalledWith("autotune_resize");
      expect(getMachineProfile().memory.limitBytes).toBe(2048 * kMbLocal); // no refresh

      // Lock free: arm + confirm → the tick refreshes and emits the event.
      const release = vi.fn();
      const freeLock = { tryAcquire: vi.fn(() => release) };
      const free = createHarness({ gatewayLifecycleLock: freeLock });
      await free.watchdog.checkContainerResize(); // arms (fresh watchdog)
      await free.watchdog.checkContainerResize(); // confirms + retunes
      expect(freeLock.tryAcquire).toHaveBeenCalledWith("autotune_resize");
      expect(release).toHaveBeenCalled();
      expect(getMachineProfile().memory.limitBytes).toBe(8192 * kMbLocal);
      const resizeEvents = free.insertWatchdogEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) =>
            event.eventType === "autotune" &&
            String(event.details?.message || "").includes("resized"),
        );
      expect(resizeEvents.length).toBeGreaterThan(0);

      // Unchanged capacity: the tick is a no-op (no lock acquisition).
      freeLock.tryAcquire.mockClear();
      await free.watchdog.checkContainerResize();
      expect(freeLock.tryAcquire).not.toHaveBeenCalled();
    } finally {
      process.env.ALPHACLAW_AUTOTUNE_DISABLED = "1";
    }
  });

  it("live-resize tick: two DIFFERENT transient readings never confirm a resize", async () => {
    delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
    try {
      const files = spyCgroupFiles({
        "/sys/fs/cgroup/memory.max": `${2048 * kMbLocal}\n`,
        "/sys/fs/cgroup/cpu.max": "100000 100000",
      });
      resetMachineProfileForTests({
        fsModule: {
          existsSync: (p) => String(p) === "/.dockerenv",
          readFileSync: () => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          },
        },
      });
      const { getMachineProfile } = require("../../lib/server/machine-profile");
      const { applyResourceAutotune } = require("../../lib/server/autotune");
      await applyResourceAutotune({
        trigger: "boot",
        deps: {
          env: {},
          updateOpenclawConfigFn: ({ mutate }) => ({ ...(mutate({}) || {}) }),
        },
      });

      const lock = { tryAcquire: vi.fn(() => () => {}) };
      const { watchdog } = createHarness({ gatewayLifecycleLock: lock });
      // Tick 1 observes 8GB (arms on that VALUE); tick 2 observes 4GB — a
      // DIFFERENT reading. The debounce must re-arm, never confirm.
      files["/sys/fs/cgroup/memory.max"] = `${8192 * kMbLocal}\n`;
      await watchdog.checkContainerResize();
      files["/sys/fs/cgroup/memory.max"] = `${4096 * kMbLocal}\n`;
      await watchdog.checkContainerResize();
      expect(lock.tryAcquire).not.toHaveBeenCalled();
      expect(getMachineProfile().memory.limitBytes).toBe(2048 * kMbLocal);

      // The 4GB reading repeats: NOW it confirms.
      await watchdog.checkContainerResize();
      expect(lock.tryAcquire).toHaveBeenCalledWith("autotune_resize");
      expect(getMachineProfile().memory.limitBytes).toBe(4096 * kMbLocal);
    } finally {
      process.env.ALPHACLAW_AUTOTUNE_DISABLED = "1";
    }
  });

  it("live-resize tick: a degraded read (cgroup limit vanished) never arms", async () => {
    delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
    try {
      const files = spyCgroupFiles({
        "/sys/fs/cgroup/memory.max": `${2048 * kMbLocal}\n`,
        "/sys/fs/cgroup/cpu.max": "100000 100000",
      });
      resetMachineProfileForTests({
        fsModule: {
          existsSync: (p) => String(p) === "/.dockerenv",
          readFileSync: () => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          },
        },
      });
      const { getMachineProfile } = require("../../lib/server/machine-profile");
      const { applyResourceAutotune } = require("../../lib/server/autotune");
      await applyResourceAutotune({
        trigger: "boot",
        deps: {
          env: {},
          updateOpenclawConfigFn: ({ mutate }) => ({ ...(mutate({}) || {}) }),
        },
      });

      // The cgroup limit becomes unreadable (EMFILE-class failure): the read
      // substitutes host totals — a phantom "resize" that must never arm,
      // no matter how many ticks it persists across.
      delete files["/sys/fs/cgroup/memory.max"];
      const lock = { tryAcquire: vi.fn(() => () => {}) };
      const { watchdog } = createHarness({ gatewayLifecycleLock: lock });
      await watchdog.checkContainerResize();
      await watchdog.checkContainerResize();
      await watchdog.checkContainerResize();
      expect(lock.tryAcquire).not.toHaveBeenCalled();
      expect(getMachineProfile().memory.limitBytes).toBe(2048 * kMbLocal);
      expect(getMachineProfile().memory.source).toBe("cgroup-v2");
    } finally {
      process.env.ALPHACLAW_AUTOTUNE_DISABLED = "1";
    }
  });

  it("notifies once per incident across a crash loop, and stays silent on plain crashes", async () => {
    const { watchdog, insertWatchdogEvent, notifier } = createHarness();
    watchdog.onGatewayExit({ code: 137, expectedExit: false });
    await flush();
    watchdog.onGatewayExit({ code: 137, expectedExit: false });
    await flush();
    const containerOomNotifications = notifier.notify.mock.calls
      .map(([m]) => m)
      .filter((m) => m.includes("force-killed"));
    expect(containerOomNotifications).toHaveLength(1);

    insertWatchdogEvent.mockClear();
    watchdog.onGatewayExit({
      code: 1,
      expectedExit: false,
      stderrTail: ["some ordinary crash"],
    });
    await flush();
    expect(autotuneEvents(insertWatchdogEvent)).toHaveLength(0);
  });
});
