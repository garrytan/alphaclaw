const {
  startServerLifecycle,
} = require("../../lib/server/init/server-lifecycle");

const flushMicrotasks = async () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe("server/init/server-lifecycle", () => {
  const createServer = () => ({
    listen: vi.fn((port, host, cb) => {
      cb();
    }),
  });

  it("catches a rejecting boot sequence instead of crashing the process", async () => {
    // runOnboardedBootSequence became async on this branch; without the
    // .catch guard an early rejection is an unhandled rejection that kills
    // Node — the exact failure the guard exists for.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);

    startServerLifecycle({
      server: createServer(),
      PORT: 0,
      isOnboarded: () => true,
      runOnboardedBootSequence: async () => {
        throw new Error("boot exploded");
      },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(unhandled).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Boot sequence error: boot exploded"),
    );
    process.removeListener("unhandledRejection", unhandled);
    errorSpy.mockRestore();
  });

  it("does not run the boot sequence before onboarding", async () => {
    const runBoot = vi.fn(async () => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    startServerLifecycle({
      server: createServer(),
      PORT: 0,
      isOnboarded: () => false,
      runOnboardedBootSequence: runBoot,
    });
    await flushMicrotasks();

    expect(runBoot).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Awaiting onboarding"),
    );
    logSpy.mockRestore();
  });
});
