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

const createHarness = () => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
    probeGatewayTcp: async () => ({ running: true }),
    gatewayLifecycleLock: null,
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

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
      .find((m) => m.includes("killed by the container"));
    expect(message).toContain("raising the gateway heap will not help");
  });

  it("notifies once per incident across a crash loop, and stays silent on plain crashes", async () => {
    const { watchdog, insertWatchdogEvent, notifier } = createHarness();
    watchdog.onGatewayExit({ code: 137, expectedExit: false });
    await flush();
    watchdog.onGatewayExit({ code: 137, expectedExit: false });
    await flush();
    const containerOomNotifications = notifier.notify.mock.calls
      .map(([m]) => m)
      .filter((m) => m.includes("killed by the container"));
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
